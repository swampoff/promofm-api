"""
Promo.check — Radio Stream Monitor
Captures 30s chunks from radio streams, fingerprints them, matches against DB.
"""
import os
import sys
import time
import tempfile
import subprocess
import logging
import argparse
from datetime import datetime, timezone, timedelta

from db import (
    get_monitoring_stations,
    get_all_fingerprints,
    insert_detection,
    update_station_scanned,
)
from fingerprinter import fingerprint_file, match_fingerprint, get_watermark, get_watermark_matches, audiowmark_available

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [monitor] %(levelname)s %(message)s"
)
log = logging.getLogger(__name__)

SCAN_INTERVAL = int(os.environ.get("SCAN_INTERVAL", "300"))  # 5 min between scans per station
CHUNK_SECONDS = int(os.environ.get("CHUNK_SECONDS", "30"))
FINGERPRINT_THRESHOLD = float(os.environ.get("FINGERPRINT_THRESHOLD", "0.35"))
CONFIDENCE_MIN = float(os.environ.get("CONFIDENCE_MIN", "0.65"))  # min confidence to log


def capture_stream_chunk(stream_url: str, duration: int) -> str | None:
    """
    Capture N seconds from a radio stream using ffmpeg.
    Returns temp file path or None on failure.
    """
    tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
    tmp.close()
    try:
        result = subprocess.run([
            "ffmpeg", "-y",
            "-i", stream_url,
            "-t", str(duration),
            "-acodec", "libmp3lame",
            "-ab", "128k",
            "-loglevel", "error",
            tmp.name
        ], capture_output=True, timeout=duration + 30)
        if result.returncode != 0:
            log.warning(f"ffmpeg failed for {stream_url}: {result.stderr.decode()[:200]}")
            os.unlink(tmp.name)
            return None
        if os.path.getsize(tmp.name) < 1024:
            log.warning(f"Chunk too small from {stream_url}")
            os.unlink(tmp.name)
            return None
        return tmp.name
    except subprocess.TimeoutExpired:
        log.warning(f"ffmpeg timeout for {stream_url}")
        try:
            os.unlink(tmp.name)
        except Exception:
            pass
        return None
    except Exception as e:
        log.error(f"Capture error for {stream_url}: {e}")
        try:
            os.unlink(tmp.name)
        except Exception:
            pass
        return None


def scan_station(station: dict, all_fingerprints: list) -> int:
    """
    Scan one station. Returns number of detections logged.
    """
    station_name = station["station_name"]
    stream_url = station["stream_url"]
    station_id = station["station_id"]
    monitoring_id = station["id"]

    log.info(f"Scanning {station_name} ({stream_url[:50]}...)")
    chunk_path = capture_stream_chunk(stream_url, CHUNK_SECONDS)
    if not chunk_path:
        update_station_scanned(monitoring_id, error="Failed to capture stream chunk")
        return 0

    detections = 0
    try:
        fp_data = fingerprint_file(chunk_path)
        match = match_fingerprint(fp_data["fingerprint"], all_fingerprints, FINGERPRINT_THRESHOLD)

        if match and match["confidence"] >= CONFIDENCE_MIN:
            track_id = match["track_id"]
            confidence = match["confidence"]
            detection_method = "fingerprint"
            watermark_confirmed = False

            # Try to confirm with audiowmark
            if audiowmark_available():
                wm_found = get_watermark(chunk_path)
                if wm_found and wm_found == match["watermark_id"]:
                    watermark_confirmed = True
                    detection_method = "fingerprint+watermark"
                    confidence = min(0.99, confidence + 0.05)
                    log.info(f"Watermark CONFIRMED for track {track_id} on {station_name}")

            insert_detection(
                track_id=track_id,
                station_id=station_id,
                station_name=station_name,
                confidence=confidence,
                detection_method=detection_method,
                watermark_confirmed=watermark_confirmed,
            )
            detections += 1
            log.info(
                f"DETECTED: track={track_id[:8]}... on {station_name} "
                f"conf={confidence:.2f} method={detection_method}"
            )
        else:
            # Chromaprint defeated by the live air chain (loudnorm / stream re-encode);
            # the embedded watermark survives -> independent detection path.
            wm_hits = []
            if audiowmark_available():
                known_wm = {f["watermark_id"]: f["track_id"]
                            for f in all_fingerprints if f.get("watermark_id")}
                if known_wm:
                    wm_hits = get_watermark_matches(chunk_path, known_wm)
            if wm_hits:
                wtrack, wscore = max(wm_hits, key=lambda x: x[1])
                insert_detection(
                    track_id=wtrack,
                    station_id=station_id,
                    station_name=station_name,
                    confidence=min(0.99, 0.80 + wscore * 0.10),
                    detection_method="watermark",
                    watermark_confirmed=True,
                )
                detections += 1
                log.info(
                    f"DETECTED via WATERMARK: track={wtrack[:8]}... on {station_name} "
                    f"score={wscore:.2f}"
                )
            else:
                log.debug(f"No match on {station_name}")

        update_station_scanned(monitoring_id)

    except Exception as e:
        log.error(f"Error scanning {station_name}: {e}")
        update_station_scanned(monitoring_id, error=str(e))
    finally:
        try:
            os.unlink(chunk_path)
        except Exception:
            pass

    return detections


def should_scan(station: dict) -> bool:
    """Check if enough time has passed since last scan."""
    last = station.get("last_scanned_at")
    if last is None:
        return True
    # last_scanned_at may be a datetime object (psycopg2 auto-converts)
    if isinstance(last, datetime):
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - last).total_seconds() >= SCAN_INTERVAL
    return True


def run_once(station_filter: str | None = None):
    """Single pass: scan all (or one) station(s)."""
    stations = get_monitoring_stations()
    if station_filter:
        stations = [s for s in stations
                    if station_filter.lower() in s["station_name"].lower()]
    if not stations:
        log.warning("No active stations to scan")
        return

    all_fingerprints = get_all_fingerprints()
    log.info(f"Loaded {len(all_fingerprints)} fingerprints from DB")

    total_detections = 0
    for station in stations:
        total_detections += scan_station(station, all_fingerprints)

    log.info(f"Scan complete: {len(stations)} stations, {total_detections} detections")


def run_continuous():
    """Main loop: continuously scan stations respecting SCAN_INTERVAL."""
    log.info(f"Starting Promo.check monitor (interval={SCAN_INTERVAL}s, chunk={CHUNK_SECONDS}s)")
    while True:
        try:
            stations = get_monitoring_stations()
            all_fingerprints = get_all_fingerprints()

            for station in stations:
                if should_scan(station):
                    scan_station(station, all_fingerprints)
                    time.sleep(2)  # small gap between stations

        except KeyboardInterrupt:
            log.info("Monitor stopped by user")
            break
        except Exception as e:
            log.error(f"Monitor loop error: {e}")

        time.sleep(30)  # check every 30s if any station needs scanning


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Promo.check radio monitor")
    parser.add_argument("--once", action="store_true", help="Single scan pass then exit")
    parser.add_argument("--station", help="Filter by station name (partial match)")
    args = parser.parse_args()

    if args.once:
        run_once(args.station)
    else:
        run_continuous()
