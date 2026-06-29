#!/usr/bin/env python3
"""
PromoFM Charts Agent — Weekly chart aggregation pipeline
Collects charts from 6 sources, enriches with Deezer covers/previews,
builds unified PromoFM chart, saves to PostgreSQL.
Runs weekly via cron or manually.

Sources:
  1. Shazam Russia Top 200 (HTML parsing)
  2. Яндекс Музыка Chart (JSON API)
  3. Русское Радио Хит-парад (HTML parsing)
  4. Наше Радио Чартова Дюжина (HTML parsing)
  5. DFM TOP 30 (HTML/RSC parsing)
  6. Europa Plus TOP 40 (HTML parsing)

Usage:
  python3 promofm-charts-agent.py          # full update
  python3 promofm-charts-agent.py --dry    # dry run (no DB write)
"""

import json
import re
import sys
import time
import html as html_mod
import logging
import math
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.parse import quote
from urllib.error import URLError, HTTPError

import psycopg2
from psycopg2.extras import Json
from bs4 import BeautifulSoup

# ─── Config ──────────────────────────────────────────────────

DB_DSN = "postgresql://promofm_app:PromoFM2024dbSecure@127.0.0.1:5432/promofm"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
DRY_RUN = "--dry" in sys.argv

# Source weights (higher = more influence on chart)
SOURCE_WEIGHTS = {
    "shazam": 3,
    "yandex": 3.5,
    "russkoe": 2,
    "nashe": 1.5,
    "dfm": 2,
    "europa": 2.5,
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("charts")

# ─── HTTP helper ─────────────────────────────────────────────

def fetch(url: str, timeout: int = 20, accept: str = "*/*") -> str:
    """Fetch URL with browser-like headers."""
    req = Request(url, headers={
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
    })
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (URLError, HTTPError) as e:
        log.error(f"Fetch {url}: {e}")
        return ""


# ─── Deezer enrichment ──────────────────────────────────────

def fetch_deezer(artist: str, title: str) -> dict:
    """Get 30-sec preview + cover art from Deezer."""
    q = quote(f"{artist} {title}")
    url = f"https://api.deezer.com/search?q={q}&limit=1"
    try:
        raw = fetch(url, timeout=10)
        if not raw:
            return {}
        data = json.loads(raw)
        hit = (data.get("data") or [None])[0]
        if not hit:
            return {}
        album = hit.get("album") or {}
        return {
            "previewUrl": hit.get("preview") or "",
            "coverUrl": album.get("cover_big") or album.get("cover_medium") or album.get("cover") or "",
            "coverSmall": album.get("cover_small") or album.get("cover") or "",
        }
    except Exception as e:
        log.debug(f"Deezer error for {artist} - {title}: {e}")
        return {}


def fetch_itunes(artist: str, title: str) -> dict:
    """Fallback cover from iTunes/Apple Music (reachable from RU VPS)."""
    q = quote(f"{artist} {title}")
    url = f"https://itunes.apple.com/search?term={q}&entity=song&limit=1"
    try:
        raw = fetch(url, timeout=10)
        if not raw:
            return {}
        hit = (json.loads(raw).get("results") or [None])[0]
        if not hit:
            return {}
        art = hit.get("artworkUrl100") or ""
        if not art:
            return {}
        return {"coverUrl": art.replace("100x100bb", "600x600bb"), "coverSmall": art, "previewUrl": hit.get("previewUrl") or ""}
    except Exception as e:
        log.debug(f"iTunes error for {artist} - {title}: {e}")
        return {}


def enrich_tracks(tracks: list[dict], batch_size: int = 5) -> int:
    """Enrich tracks with Deezer data. Returns count of enriched."""
    enriched = 0
    for i in range(0, len(tracks), batch_size):
        chunk = tracks[i:i+batch_size]
        for t in chunk:
            if t.get("coverUrl"):
                enriched += 1
                continue
            data = fetch_deezer(t["artist"], t["title"])
            if data:
                t.update(data)
                if data.get("coverUrl") or data.get("previewUrl"):
                    enriched += 1
            if not t.get("coverUrl"):
                it = fetch_itunes(t["artist"], t["title"])
                if it.get("coverUrl"):
                    t["coverUrl"] = it["coverUrl"]
                    t["coverSmall"] = it.get("coverSmall") or t.get("coverSmall", "")
                    if it.get("previewUrl") and not t.get("previewUrl"):
                        t["previewUrl"] = it["previewUrl"]
                    enriched += 1
            time.sleep(0.2)  # Rate limit Deezer API
    return enriched


# ─── Source parsers ──────────────────────────────────────────

def parse_shazam() -> list[dict]:
    """Shazam Russia Top 200 — parse from alt tags."""
    log.info("Parsing Shazam Russia...")
    html = fetch("https://www.shazam.com/charts/top-200/russia")
    if not html:
        return []

    tracks = []
    seen = set()
    alts = re.findall(r'alt="([^"]+)"', html)

    for alt in alts:
        alt = html_mod.unescape(alt)
        # Format: "Listen to TITLE by ARTIST"
        m = re.match(r'Listen to (.+?) by (.+)', alt)
        if m:
            title = m.group(1).strip()
            artist = m.group(2).strip()
            key = f"{artist.lower()}|||{title.lower()}"
            if key not in seen and len(artist) < 100 and len(title) < 100:
                seen.add(key)
                tracks.append({
                    "position": len(tracks) + 1,
                    "artist": artist,
                    "title": title,
                })
            continue
        # Format: "Album artwork for album titled TITLE by ARTIST"
        m = re.match(r'Album artwork for (?:album titled |)(.+?) by (.+)', alt)
        if m:
            title = m.group(1).strip()
            artist = m.group(2).strip()
            key = f"{artist.lower()}|||{title.lower()}"
            if key not in seen and len(artist) < 100 and len(title) < 100:
                seen.add(key)
                tracks.append({
                    "position": len(tracks) + 1,
                    "artist": artist,
                    "title": title,
                })

    log.info(f"Shazam: {len(tracks)} tracks")
    return tracks[:200]


def parse_yandex() -> list[dict]:
    """Яндекс Музыка Chart — JSON API."""
    log.info("Parsing Яндекс Музыка...")
    html = fetch(
        "https://api.music.yandex.net/landing3/chart/russia",
        accept="application/json",
    )
    if not html:
        return []

    try:
        data = json.loads(html)
    except json.JSONDecodeError:
        log.error("Yandex: invalid JSON")
        return []

    # landing3/chart/russia: result.chart.tracks[] = [{track:{title,artists[]}, chart:{position}}]
    chart_tracks = (((data.get("result") or {}).get("chart") or {}).get("tracks")) or []

    tracks = []
    for i, item in enumerate(chart_tracks, 1):
        t = item.get("track") or item
        ch = item.get("chart") or {}
        artists_list = t.get("artists", [])
        artist = ", ".join(a.get("name", "") for a in artists_list) if artists_list else "Unknown"
        title = t.get("title", "")
        if not title:
            continue
        pos = ch.get("position") or i
        tracks.append({
            "position": pos,
            "artist": artist,
            "title": title,
        })
        if len(tracks) >= 50:
            break

    log.info(f"Yandex: {len(tracks)} tracks")
    return tracks


def parse_russkoe_radio() -> list[dict]:
    """Русское Радио Хит-парад — HTML parsing."""
    log.info("Parsing Русское Радио...")
    html = fetch("https://russkoeradiofm.ru/hitparad/")
    if not html:
        return []

    tracks = []
    soup = BeautifulSoup(html, "lxml")

    # Structure: div.rus-hit-track > div.rus-hit-title + div.rus-hit-artist
    for block in soup.select(".rus-hit-track"):
        title_el = block.select_one(".rus-hit-title")
        artist_el = block.select_one(".rus-hit-artist")
        if title_el and artist_el:
            title = title_el.get_text(strip=True)
            artist = artist_el.get_text(strip=True)
            if title and artist and "Название" not in title and "Артист" not in artist:
                tracks.append({
                    "position": len(tracks) + 1,
                    "artist": artist,
                    "title": title,
                })

    log.info(f"Русское Радио: {len(tracks)} tracks")
    return tracks


def parse_nashe_radio() -> list[dict]:
    """Наше Радио Чартова Дюжина — HTML parsing."""
    log.info("Parsing Наше Радио...")
    html = fetch("https://www.nashe.ru/chartova")
    if not html:
        return []

    tracks = []
    # Format: chartova__track">ARTIST / <span class="chartova__track_song">SONG</span>
    pattern = re.compile(
        r'chartova__track">\s*([^<]+?)\s*/\s*<span\s+class="chartova__track_song">([^<]+)</span>',
        re.DOTALL
    )
    for m in pattern.finditer(html):
        artist = html_mod.unescape(m.group(1).strip())
        title = html_mod.unescape(m.group(2).strip())
        if artist and title:
            tracks.append({
                "position": len(tracks) + 1,
                "artist": artist,
                "title": title,
            })

    log.info(f"Наше Радио: {len(tracks)} tracks")
    return tracks


def parse_dfm() -> list[dict]:
    """DFM TOP 30 — HTML parsing (Next.js SSR)."""
    log.info("Parsing DFM...")
    html = fetch("https://dfm.ru/charts/top-30")
    if not html:
        return []

    tracks = []
    # DFM renders track data in nested divs:
    # font-semibold > div > div.truncate > ARTIST
    # font-normal > div > div.truncate > TITLE
    artists = re.findall(r'font-semibold[^>]*>[^<]*<[^>]*>[^<]*<[^>]*truncate[^>]*>([^<]+)', html)
    titles = re.findall(r'font-normal[^>]*>[^<]*<[^>]*>[^<]*<[^>]*truncate[^>]*>([^<]+)', html)

    for i in range(min(len(artists), len(titles))):
        a = html_mod.unescape(artists[i].strip())
        t = html_mod.unescape(titles[i].strip())
        if a and t:
            tracks.append({
                "position": len(tracks) + 1,
                "artist": a,
                "title": t,
            })

    log.info(f"DFM: {len(tracks)} tracks")
    return tracks[:30]


def parse_europa_plus() -> list[dict]:
    """Europa Plus TOP 40 — HTML/Vue parsing."""
    log.info("Parsing Europa Plus...")
    html = fetch("https://europaplus.ru/programs/top40")
    if not html:
        return []

    tracks = []
    # Structure: <h4 class="track-name" data-v-...>Title</h4>
    #            <h4 class="artist" data-v-...>Artist</h4>
    names = re.findall(r'class="track-name"[^>]*>([^<]+)', html)
    artists = re.findall(r'class="artist"[^>]*>([^<]+)', html)

    for i in range(min(len(names), len(artists))):
        title = html_mod.unescape(names[i].strip())
        artist = html_mod.unescape(artists[i].strip())
        if title and artist:
            tracks.append({
                "position": len(tracks) + 1,
                "artist": artist,
                "title": title,
            })

    log.info(f"Europa Plus: {len(tracks)} tracks")
    return tracks[:40]


# ─── Chart builder ───────────────────────────────────────────

def normalize_key(artist: str, title: str) -> str:
    """Normalize track key for deduplication."""
    a = re.sub(r'\s*feat\.?\s*', ' feat ', artist.lower().strip(), flags=re.I)
    a = re.sub(r'[«»"\'()]', '', a)
    a = re.sub(r'\s+', ' ', a)
    t = re.sub(r'\s*\(.*?\)\s*', '', title.lower().strip())
    t = re.sub(r'[«»"\'()]', '', t)
    t = re.sub(r'\s+', ' ', t)
    return f"{a}|||{t}"


def build_chart(sources: dict[str, list[dict]], prev_chart: list[dict] | None = None) -> list[dict]:
    """Build unified PromoFM chart from all sources with weighted scoring."""
    scores: dict[str, dict] = {}

    for source_id, tracks in sources.items():
        weight = SOURCE_WEIGHTS.get(source_id, 1)
        max_pos = len(tracks) if tracks else 1

        for t in tracks:
            if not t.get("artist") or not t.get("title"):
                continue
            key = normalize_key(t["artist"], t["title"])

            if key not in scores:
                scores[key] = {
                    "artist": t["artist"],
                    "title": t["title"],
                    "score": 0,
                    "sources": [],
                    "previewUrl": t.get("previewUrl", ""),
                    "coverUrl": t.get("coverUrl", ""),
                    "coverSmall": t.get("coverSmall", ""),
                }

            pos = t.get("position", 1)
            pos_score = ((max_pos - pos + 1) / max_pos) * 100
            scores[key]["score"] += weight * pos_score
            scores[key]["sources"].append({
                "id": source_id,
                "name": SOURCE_NAMES.get(source_id, source_id),
                "position": pos,
            })
            # Keep best cover/preview
            if t.get("coverUrl") and not scores[key]["coverUrl"]:
                scores[key]["coverUrl"] = t["coverUrl"]
                scores[key]["coverSmall"] = t.get("coverSmall", "")
            if t.get("previewUrl") and not scores[key]["previewUrl"]:
                scores[key]["previewUrl"] = t["previewUrl"]

    # Sort by score
    sorted_entries = sorted(scores.values(), key=lambda x: x["score"], reverse=True)

    # Build prev position map for trends
    prev_map = {}
    if prev_chart:
        for e in prev_chart:
            pk = normalize_key(e.get("artist", ""), e.get("title", ""))
            prev_map[pk] = e.get("position", 0)

    # Build final chart (top 50)
    chart = []
    for i, entry in enumerate(sorted_entries[:50]):
        pos = i + 1
        key = normalize_key(entry["artist"], entry["title"])
        prev_pos = prev_map.get(key, 0)

        if prev_pos == 0:
            trend = "new"
            trend_val = 0
        elif prev_pos > pos:
            trend = "up"
            trend_val = prev_pos - pos
        elif prev_pos < pos:
            trend = "down"
            trend_val = pos - prev_pos
        else:
            trend = "same"
            trend_val = 0

        chart.append({
            "position": pos,
            "previousPosition": prev_pos,
            "artist": entry["artist"],
            "title": entry["title"],
            "score": round(entry["score"], 1),
            "sources": entry["sources"],
            "trend": trend,
            "trendValue": trend_val,
            "onPlatform": False,
            "previewUrl": entry.get("previewUrl", ""),
            "coverUrl": entry.get("coverUrl", ""),
            "coverSmall": entry.get("coverSmall", ""),
        })

    return chart


SOURCE_NAMES = {
    "shazam": "Shazam Россия",
    "yandex": "Яндекс Музыка",
    "russkoe": "Русское Радио",
    "nashe": "Наше Радио",
    "dfm": "DFM",
    "europa": "Europa Plus",
}


# ─── Database ────────────────────────────────────────────────

def db_upsert(conn, table: str, pk: str, pk_val: str, data: dict):
    """Upsert JSON data into KV-like table."""
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.cursor()
    cur.execute(f"""
        INSERT INTO {table} ({pk}, data, updated_at)
        VALUES (%s, %s, %s)
        ON CONFLICT ({pk}) DO UPDATE SET data = %s, updated_at = %s
    """, (pk_val, Json(data), now, Json(data), now))
    conn.commit()
    cur.close()


def db_get(conn, table: str, pk: str, pk_val: str) -> dict | None:
    """Get JSON data from KV-like table."""
    cur = conn.cursor()
    cur.execute(f"SELECT data FROM {table} WHERE {pk} = %s", (pk_val,))
    row = cur.fetchone()
    cur.close()
    return row[0] if row else None


# ─── Main pipeline ───────────────────────────────────────────

def main():
    log.info("=" * 60)
    log.info("PromoFM Charts Agent — Starting weekly update")
    log.info("=" * 60)

    # Step 1: Collect from all sources
    all_sources = {}
    results = []

    parsers = {
        "shazam": parse_shazam,
        "yandex": parse_yandex,
        "russkoe": parse_russkoe_radio,
        "nashe": parse_nashe_radio,
        "dfm": parse_dfm,
        "europa": parse_europa_plus,
    }

    for source_id, parser in parsers.items():
        try:
            tracks = parser()
            all_sources[source_id] = tracks
            results.append({
                "sourceId": source_id,
                "sourceName": SOURCE_NAMES[source_id],
                "tracksFound": len(tracks),
                "error": None if tracks else "No data",
            })
        except Exception as e:
            log.error(f"Error parsing {source_id}: {e}")
            all_sources[source_id] = []
            results.append({
                "sourceId": source_id,
                "sourceName": SOURCE_NAMES[source_id],
                "tracksFound": 0,
                "error": str(e),
            })
        time.sleep(1)  # Be polite between requests

    total_tracks = sum(len(t) for t in all_sources.values())
    log.info(f"Collected {total_tracks} tracks from {len(all_sources)} sources")

    if total_tracks == 0:
        log.error("No tracks collected from any source! Aborting.")
        sys.exit(1)

    # Step 2: Connect to DB and load previous chart
    conn = psycopg2.connect(DB_DSN)
    prev_data = db_get(conn, "platform_stats", "id", "chart:promofm")
    prev_chart = prev_data.get("entries", []) if prev_data else []

    # Step 3: Build unified chart
    log.info("Building unified PromoFM chart...")
    chart = build_chart(all_sources, prev_chart)
    log.info(f"Chart built: {len(chart)} entries")

    # Step 4: Enrich with Deezer covers + previews
    log.info("Enriching with Deezer covers & previews...")
    enriched_count = enrich_tracks(chart)
    log.info(f"Enriched {enriched_count}/{len(chart)} tracks with covers/audio")

    # Step 5: Print top 10
    log.info("─── TOP 10 PromoFM Chart ───")
    for e in chart[:10]:
        src = ", ".join(s["name"] for s in e["sources"])
        cover = "✓" if e.get("coverUrl") else "✗"
        audio = "✓" if e.get("previewUrl") else "✗"
        log.info(f"  {e['position']:2d}. {e['artist']} — {e['title']} ({e['score']}) [{src}] cover:{cover} audio:{audio}")

    if DRY_RUN:
        log.info("DRY RUN — not saving to database")
        conn.close()
        return

    # Step 6: Save to DB
    log.info("Saving to database...")

    # Save per-source data
    for source_id, tracks in all_sources.items():
        if tracks:
            source_data = {
                "sourceId": source_id,
                "sourceName": SOURCE_NAMES[source_id],
                "tracks": tracks,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "tracksCount": len(tracks),
            }
            db_upsert(conn, "chart_sources", "id", source_id, source_data)
            log.info(f"  Saved {source_id}: {len(tracks)} tracks")

    # Save aggregation log
    agg_log = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "sourcesProcessed": len(results),
        "totalTracks": total_tracks,
        "results": results,
    }
    db_upsert(conn, "chart_sources", "id", "last_aggregation", agg_log)

    # Build source stats
    source_stats = {}
    for e in chart:
        for s in e["sources"]:
            source_stats[s["id"]] = source_stats.get(s["id"], 0) + 1

    # Save unified chart
    chart_data = {
        "entries": chart,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "totalTracks": len(chart),
        "sourceStats": source_stats,
        "onPlatformCount": sum(1 for e in chart if e.get("onPlatform")),
    }
    db_upsert(conn, "platform_stats", "id", "chart:promofm", chart_data)
    log.info("  Saved chart:promofm")

    # Save top 20 for landing
    db_upsert(conn, "platform_stats", "id", "chart:weekly:top20", {
        "entries": chart[:20],
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    })
    log.info("  Saved chart:weekly:top20")

    # Save new releases (top 10 new entries + trending)
    new_releases = []
    seen = set()
    # Priority: new entries in chart
    for e in chart:
        if e["trend"] == "new" and len(new_releases) < 10:
            key = normalize_key(e["artist"], e["title"])
            if key not in seen:
                seen.add(key)
                new_releases.append({
                    "position": len(new_releases) + 1,
                    "artist": e["artist"],
                    "title": e["title"],
                    "source": e["sources"][0]["id"] if e["sources"] else "",
                    "sourceLabel": e["sources"][0]["name"] if e["sources"] else "",
                    "isOurArtist": False,
                    "genre": "",
                    "previewUrl": e.get("previewUrl", ""),
                    "coverUrl": e.get("coverUrl", ""),
                    "coverSmall": e.get("coverSmall", ""),
                })
    # Fill remaining with top trending
    for e in chart:
        if len(new_releases) >= 10:
            break
        if e["trend"] == "up":
            key = normalize_key(e["artist"], e["title"])
            if key not in seen:
                seen.add(key)
                new_releases.append({
                    "position": len(new_releases) + 1,
                    "artist": e["artist"],
                    "title": e["title"],
                    "source": e["sources"][0]["id"] if e["sources"] else "",
                    "sourceLabel": e["sources"][0]["name"] if e["sources"] else "",
                    "isOurArtist": False,
                    "genre": "",
                    "previewUrl": e.get("previewUrl", ""),
                    "coverUrl": e.get("coverUrl", ""),
                    "coverSmall": e.get("coverSmall", ""),
                })
    # Fill rest from top chart
    for e in chart:
        if len(new_releases) >= 10:
            break
        key = normalize_key(e["artist"], e["title"])
        if key not in seen:
            seen.add(key)
            new_releases.append({
                "position": len(new_releases) + 1,
                "artist": e["artist"],
                "title": e["title"],
                "source": e["sources"][0]["id"] if e["sources"] else "",
                "sourceLabel": e["sources"][0]["name"] if e["sources"] else "",
                "isOurArtist": False,
                "genre": "",
                "previewUrl": e.get("previewUrl", ""),
                "coverUrl": e.get("coverUrl", ""),
                "coverSmall": e.get("coverSmall", ""),
            })

    db_upsert(conn, "platform_stats", "id", "weekly:new_releases", {
        "tracks": new_releases,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "totalPlatform": 0,
        "totalExternal": len(new_releases),
    })
    log.info(f"  Saved weekly:new_releases ({len(new_releases)} tracks)")

    conn.close()
    log.info("=" * 60)
    log.info("Charts update complete!")
    log.info(f"  Sources: {len(results)}")
    log.info(f"  Total tracks collected: {total_tracks}")
    log.info(f"  Chart entries: {len(chart)}")
    log.info(f"  Enriched with covers: {enriched_count}")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
