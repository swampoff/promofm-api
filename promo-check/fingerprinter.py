"""
Promo.check — Fingerprinting + Watermarking
Uses: fpcalc (Chromaprint) + audiowmark
"""
import subprocess
import json
import secrets
import os
import sys
import tempfile
import logging
import urllib.request
from urllib.parse import unquote
import argparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [fingerprinter] %(message)s")
log = logging.getLogger(__name__)

AUDIOWMARK_BIN = os.environ.get("AUDIOWMARK_BIN", "audiowmark")
FPCALC_BIN = os.environ.get("FPCALC_BIN", "fpcalc")
UPLOADS_DIR = "/var/www/promofm/uploads"


def fingerprint_file(filepath: str) -> dict:
    """Run fpcalc, return {duration: float, fingerprint: [int...]}"""
    result = subprocess.run(
        [FPCALC_BIN, "-raw", "-json", filepath],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        raise RuntimeError(f"fpcalc failed: {result.stderr}")
    data = json.loads(result.stdout)
    return {"duration": data["duration"], "fingerprint": data["fingerprint"]}


def generate_watermark_id() -> str:
    """Generate 128-bit hex ID for audiowmark."""
    return secrets.token_hex(16)  # 32 hex chars = 128 bits


def audiowmark_available() -> bool:
    """Check if audiowmark binary is accessible."""
    try:
        result = subprocess.run([AUDIOWMARK_BIN, "--help"],
                                capture_output=True, timeout=5)
        return result.returncode in (0, 1)  # --help may return 1
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def add_watermark(src: str, dst: str, wm_id: str) -> bool:
    """Embed watermark into audio file via audiowmark."""
    result = subprocess.run(
        [AUDIOWMARK_BIN, "add", src, dst, wm_id],
        capture_output=True, timeout=180
    )
    if result.returncode != 0:
        log.warning(f"audiowmark add failed: {result.stderr.decode()[:200]}")
    return result.returncode == 0


def get_watermark(filepath: str) -> str | None:
    """Extract watermark ID from audio chunk. Returns hex ID or None."""
    try:
        result = subprocess.run(
            [AUDIOWMARK_BIN, "get", filepath],
            capture_output=True, text=True, timeout=90
        )
        # Output format: "pattern 0000 <hex_id> <confidence>\n..."
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("pattern"):
                parts = line.split()
                if len(parts) >= 3:
                    return parts[2]
    except Exception as e:
        log.debug(f"audiowmark get error: {e}")
    return None


def hamming_distance_aligned(chunk: list, full: list) -> float:
    """
    Sliding-window Hamming distance: find the best alignment of chunk
    within the full track fingerprint. Returns minimum BER found.
    """
    if not chunk or not full:
        return 1.0
    chunk_len = len(chunk)
    full_len = len(full)
    if chunk_len >= full_len:
        # Chunk is longer or equal — compare directly
        n = min(chunk_len, full_len)
        errors = sum(bin(x ^ y).count("1") for x, y in zip(chunk[:n], full[:n]))
        return errors / (n * 32)
    # Slide chunk over full track, step by step
    best_ber = 1.0
    step = max(1, chunk_len // 4)  # slide in quarter-chunk steps for speed
    for offset in range(0, full_len - chunk_len + 1, step):
        window = full[offset:offset + chunk_len]
        errors = sum(bin(x ^ y).count("1") for x, y in zip(chunk, window))
        ber = errors / (chunk_len * 32)
        if ber < best_ber:
            best_ber = ber
    return best_ber


def match_fingerprint(fp: list, db_rows: list, threshold: float = 0.35) -> dict | None:
    """Find best Chromaprint match using sliding window. Returns {track_id, watermark_id, confidence} or None."""
    best = None
    best_dist = threshold
    for row in db_rows:
        stored = row["fingerprint"]
        if not stored:
            continue
        dist = hamming_distance_aligned(fp, stored)
        if dist < best_dist:
            best_dist = dist
            best = {
                "track_id": str(row["track_id"]),
                "watermark_id": row["watermark_id"],
                "confidence": round(1.0 - dist, 3),
            }
    return best


def resolve_audio_path(audio_url: str) -> tuple[str | None, str | None]:
    """
    Convert audio_url to (local_path, upload_path).
    local_path: file to process (may be temp download)
    upload_path: permanent upload file to replace with watermarked version (or None)
    """
    if not audio_url:
        return None, None
    # Local path via uploads dir. Two roots on prod:
    #   /uploads/...         -> /var/www/promofm/uploads/...
    #   /server/uploads/...  -> /opt/promofm-api/uploads/... (nginx alias)
    UPLOAD_ROOTS = [
        ("/server/uploads/", "/opt/promofm-api/uploads"),
        ("/uploads/",         "/var/www/promofm/uploads"),
    ]
    for prefix, root in UPLOAD_ROOTS:
        if audio_url.startswith(prefix):
            rel = unquote(audio_url[len(prefix):])  # URL-decode %20 -> space
            local = os.path.join(root, rel)
            if os.path.exists(local):
                return local, local
    # HTTP URL — check if it maps to local uploads
    if audio_url.startswith("http"):
        # Try to extract path and map to local uploads
        for marker in ["/uploads/", "/server/uploads/"]:
            idx = audio_url.find(marker)
            if idx >= 0:
                rel = unquote(audio_url[idx + len(marker):])  # URL-decode %20 -> space
                local = os.path.join(UPLOADS_DIR, rel)
                if os.path.exists(local):
                    log.info(f"Resolved URL to local file: {local}")
                    return local, local
        # Download to temp
        tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        try:
            urllib.request.urlretrieve(audio_url, tmp.name)
            return tmp.name, None  # no permanent path to update
        except Exception as e:
            log.error(f"Failed to download {audio_url}: {e}")
            try:
                os.unlink(tmp.name)
            except Exception:
                pass
    return None, None


def _process(content_id, audio_url, save_fn, id_key, label):
    """Общий конвейер watermark+fingerprint. save_fn(id, fingerprint, wm_id, duration, watermarked=).
    Тело идентично прежнему process_track — обобщены только id, целевая таблица (через save_fn)
    и подписи логов. Побочный эффект прежний: при доступном audiowmark аудиофайл заменяется
    на watermarked-версию (os.replace)."""
    wm_id = generate_watermark_id()
    src_path, upload_path = resolve_audio_path(audio_url)
    if not src_path:
        raise RuntimeError(f"Cannot resolve audio file for {label} {content_id} url={audio_url}")

    fp_source = src_path
    method = "fingerprint_only"
    wm_dst = src_path + ".wm" + (os.path.splitext(src_path)[1] or ".mp3")

    if audiowmark_available():
        try:
            if add_watermark(src_path, wm_dst, wm_id):
                fp_source = wm_dst
                method = "fingerprint+watermark"
                log.info(f"Watermark added for {label} {content_id}")
                replace_target = upload_path or src_path
                try:
                    os.replace(wm_dst, replace_target)
                    fp_source = replace_target
                    log.info(f"Upload replaced with watermarked version: {replace_target}")
                except Exception as e:
                    log.warning(f"Could not replace upload with watermarked: {e}")
                    fp_source = wm_dst
            else:
                log.warning(f"Watermark failed for {content_id}, using plain fingerprint")
        except Exception as e:
            log.warning(f"Watermark error for {content_id}: {e}")
    else:
        log.info("audiowmark not available, using fingerprint only")

    fp_data = fingerprint_file(fp_source)

    if fp_source != src_path and os.path.exists(fp_source):
        os.unlink(fp_source)
    if src_path and src_path != upload_path and os.path.exists(src_path) and src_path.startswith("/tmp/"):
        os.unlink(src_path)

    save_fn(content_id, fp_data["fingerprint"], wm_id, fp_data["duration"],
            watermarked=(method == "fingerprint+watermark"))
    log.info(f"{label} {content_id} processed: duration={fp_data['duration']:.1f}s "
             f"fp_len={len(fp_data['fingerprint'])} method={method}")
    return {
        id_key: content_id,
        "watermark_id": wm_id,
        "duration": fp_data["duration"],
        "fingerprint_len": len(fp_data["fingerprint"]),
        "method": method,
    }


def process_track(track_id, audio_url):
    """Back-compat обёртка — прежний контракт (ключ track_id)."""
    from db import save_fingerprint
    return _process(track_id, audio_url, save_fingerprint, "track_id", "track")


def process_mix(mix_id, audio_url):
    """DJ-микс -> dj_mix_fingerprints (миграция 132 + db.save_mix_fingerprint)."""
    from db import save_mix_fingerprint
    return _process(mix_id, audio_url, save_mix_fingerprint, "mix_id", "mix")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Promo.check fingerprinter")
    g = parser.add_mutually_exclusive_group(required=True)   # ровно один из --track-id / --mix-id
    g.add_argument("--track-id")
    g.add_argument("--mix-id")
    parser.add_argument("--audio-url", required=False)
    parser.add_argument("--mode", choices=["process"], default="process")
    args = parser.parse_args()

    if args.mode == "process":
        if args.mix_id:
            from db import get_mix_audio_url
            url = args.audio_url or get_mix_audio_url(args.mix_id)
            if not url:
                log.error(f"No audio_url found for mix {args.mix_id}")
                sys.exit(1)
            print(json.dumps(process_mix(args.mix_id, url)))
        else:
            from db import get_track_audio_url
            url = args.audio_url or get_track_audio_url(args.track_id)
            if not url:
                log.error(f"No audio_url found for track {args.track_id}")
                sys.exit(1)
            print(json.dumps(process_track(args.track_id, url)))


def get_watermark_matches(filepath: str, known_wm_map: dict, score_min: float = 0.5) -> list:
    """Independent watermark detection. Runs `audiowmark get`; returns [(track_id, score)]
    for patterns whose hex id is a KNOWN embedded watermark (present in known_wm_map) and
    whose sync score >= score_min. Noise patterns carry random ids absent from the DB and
    are filtered out. Survives the radio air chain (loudnorm/re-encode) that breaks Chromaprint."""
    out = []
    try:
        result = subprocess.run([AUDIOWMARK_BIN, "get", filepath],
                                capture_output=True, text=True, timeout=90)
        for line in result.stdout.splitlines():
            p = line.strip().split()
            if len(p) >= 4 and p[0] == "pattern":
                wid = p[2]
                try:
                    score = float(p[3])
                except Exception:
                    score = 0.0
                if score >= score_min and wid in known_wm_map:
                    out.append((known_wm_map[wid], score))
    except Exception as e:
        log.debug(f"get_watermark_matches error: {e}")
    return out
