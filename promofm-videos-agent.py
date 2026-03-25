#!/usr/bin/env python3
"""
PromoFM Video Clips Agent v2 — Music video aggregation pipeline
Sources:
  1. Europa Plus API (novelties, eurotop40) → YouTube search
  2. MUZ-TV Charts (HTML parse) → YouTube search
  3. YouTube trending music (Russia) as fallback

Usage:
  python3 promofm-videos-agent.py          # full update
  python3 promofm-videos-agent.py --dry    # dry run (no DB write)
"""

import json
import re
import sys
import time
import logging
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.parse import quote
from urllib.error import URLError, HTTPError

import psycopg2
from psycopg2.extras import Json

# ─── Config ──────────────────────────────────────────────────

DB_DSN = "postgresql://promofm_app:PromoFM2024dbSecure@127.0.0.1:5432/promofm"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
DRY_RUN = "--dry" in sys.argv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("videos")

# ─── HTTP helper ─────────────────────────────────────────────

def fetch(url: str, timeout: int = 20) -> str:
    req = Request(url, headers={
        "User-Agent": UA,
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
        "Accept": "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
    })
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (URLError, HTTPError) as e:
        log.error(f"Fetch {url}: {e}")
        return ""


def fetch_json(url: str) -> dict | list | None:
    text = fetch(url)
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        log.error(f"JSON decode error for {url}")
        return None


# ─── Spam filter ─────────────────────────────────────────────

SPAM_PATTERNS = [
    r"хиты\s*20[0-9]{2}",
    r"новинки\s*(музыки|20[0-9]{2})",
    r"лучшая\s*музыка\s*20",
    r"популярные\s*песни",
    r"русская\s*(музыка|танцевальная)",
    r"зарубежные\s*песни",
    r"музыка\s*в\s*тренде",
    r"самые\s*популярные",
    r"слушать\s*бесплатно",
    r"шансон\s*20[0-9]{2}",
    r"#\d{2,}",
    r"mix\s*20[0-9]{2}",
    r"playlist",
    r"compilation",
    r"топ\s*\d+\s*(песен|хитов|треков)",
    r"russian\s*(best|top|hit|music)\s*mix",
]
_spam_re = re.compile("|".join(SPAM_PATTERNS), re.IGNORECASE)

def is_spam_video(title: str, artist: str = "") -> bool:
    """Filter out compilations, playlists, and non-official clips."""
    full = f"{artist} {title}"
    return bool(_spam_re.search(full))


# ─── Source 1: Europa Plus API ───────────────────────────────

def parse_europaplus() -> list[dict]:
    """Parse Europa Plus open API for new songs and EuroTop40."""
    log.info("Parsing Europa Plus API...")
    clips = []
    seen = set()

    # Novelties
    raw = fetch_json("https://admin.europaplus.ru/api/novelties")
    novelties = []
    if raw and isinstance(raw, dict):
        novelties = raw.get("data", [])
    elif raw and isinstance(raw, list):
        novelties = raw

    for song in novelties[:15]:
        artists = song.get("artists", [])
        artist_name = ", ".join(a.get("artist", "") for a in artists) if artists else ""
        title = song.get("name", "")
        if not title or not artist_name:
            continue
        key = f"{artist_name}|{title}".lower()
        if key in seen:
            continue
        seen.add(key)
        clips.append({
            "artist": artist_name,
            "title": title,
            "thumbnail": song.get("image", ""),
            "source": "Europa Plus",
            "sourceType": "novelty",
        })
    log.info(f"  Europa Plus novelties: {len(clips)}")

    # Main page — eurotop40
    raw2 = fetch_json("https://admin.europaplus.ru/api/main")
    main_data = raw2.get("data", raw2) if isinstance(raw2, dict) else {}
    eurotop = main_data.get("eurotop40", []) if isinstance(main_data, dict) else []

    count_before = len(clips)
    for song in eurotop[:20]:
        artists = song.get("artists", [])
        artist_name = ", ".join(a.get("artist", "") for a in artists) if artists else ""
        title = song.get("name", "")
        if not title or not artist_name:
            continue
        key = f"{artist_name}|{title}".lower()
        if key in seen:
            continue
        seen.add(key)
        clips.append({
            "artist": artist_name,
            "title": title,
            "thumbnail": song.get("image", ""),
            "source": "Europa Plus",
            "sourceType": "eurotop40",
        })
    log.info(f"  Europa Plus total: {len(clips)} (eurotop40 added {len(clips) - count_before})")
    return clips


# ─── Source 2: MUZ-TV Charts ─────────────────────────────────

def parse_muztv() -> list[dict]:
    """Parse MUZ-TV main chart from HTML."""
    log.info("Parsing MUZ-TV charts...")

    html = fetch("https://muz-tv.ru/charts/")
    if not html:
        return []

    # Extract chart items from chart-block-item divs
    # Structure: position number, then title, then artist(s)
    blocks = re.findall(
        r'<div class="chart-block-item">(.*?)</div>\s*</div>\s*</div>',
        html, re.DOTALL
    )

    clips = []
    # Also grab thumbnails from chart-track images
    thumbs = re.findall(r'<img[^>]+src="(https://img\.muz-tv\.ru/m/storage/images/chart-tracks/[^"]+)"', html)

    for i, block in enumerate(blocks[:10]):
        # Clean HTML tags, extract text segments
        text = re.sub(r'<[^>]+>', '\n', block)
        lines = [l.strip() for l in text.split('\n') if l.strip()]
        # lines[0] = position number, then title, then artist(s)
        if len(lines) < 3:
            continue
        pos = lines[0]
        title = lines[1].replace('&quot;', '"').replace('&amp;', '&')
        artist = lines[2].replace('&quot;', '"').replace('&amp;', '&')

        thumb = thumbs[i] if i < len(thumbs) else ""

        clips.append({
            "artist": artist,
            "title": title,
            "thumbnail": thumb,
            "source": "МУЗ-ТВ",
            "sourceType": "chart",
            "position": pos,
        })

    log.info(f"  MUZ-TV clips: {len(clips)}")
    return clips


# ─── Source 3: YouTube trending (fallback) ───────────────────

def parse_youtube_trending() -> list[dict]:
    """Parse YouTube trending music for Russia."""
    log.info("Parsing YouTube trending music (Russia)...")
    url = "https://www.youtube.com/feed/trending?bp=4gINGgt5dG1hX2NoYXJ0cw%3D%3D&gl=RU"
    html = fetch(url)
    if not html:
        return []

    m = re.search(r'ytInitialData\s*=\s*(\{.*?\});\s*</script>', html, re.DOTALL)
    if not m:
        m = re.search(r'var ytInitialData = (\{.*?\});</script>', html, re.DOTALL)
    if not m:
        log.warning("Could not find ytInitialData — trying search instead")
        return parse_youtube_search_trending()

    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        log.error("Failed to parse ytInitialData")
        return parse_youtube_search_trending()

    clips = []
    results = []

    def walk(obj):
        if isinstance(obj, dict):
            if "videoId" in obj and "title" in obj:
                vid = {
                    "videoId": obj["videoId"],
                    "title": obj["title"].get("runs", [{}])[0].get("text", "") if isinstance(obj["title"], dict) else str(obj.get("title", "")),
                }
                if "longBylineText" in obj:
                    runs = obj["longBylineText"].get("runs", [])
                    vid["artist"] = runs[0].get("text", "") if runs else ""
                elif "shortBylineText" in obj:
                    runs = obj["shortBylineText"].get("runs", [])
                    vid["artist"] = runs[0].get("text", "") if runs else ""
                if "lengthText" in obj:
                    vid["duration"] = obj["lengthText"].get("simpleText", "")
                if "viewCountText" in obj:
                    vid["views"] = obj["viewCountText"].get("simpleText", "")
                if "publishedTimeText" in obj:
                    vid["publishedAt"] = obj["publishedTimeText"].get("simpleText", "")
                results.append(vid)
            else:
                for v in obj.values():
                    walk(v)
        elif isinstance(obj, list):
            for item in obj:
                walk(item)

    walk(data)

    for r in results[:25]:
        vid = r.get("videoId", "")
        if not vid:
            continue
        t = r.get("title", "")
        a = r.get("artist", "")
        if is_spam_video(t, a):
            log.info(f"  SKIP spam: {a} — {t[:60]}")
            continue
        clips.append({
            "videoId": vid,
            "artist": r.get("artist", ""),
            "title": r.get("title", ""),
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            "youtubeUrl": f"https://www.youtube.com/watch?v={vid}",
            "duration": r.get("duration", ""),
            "views": r.get("views", ""),
            "publishedAt": r.get("publishedAt", ""),
            "source": "YouTube",
            "sourceType": "trending",
        })

    log.info(f"  YouTube trending: {len(clips)}")
    return clips


def parse_youtube_search_trending() -> list[dict]:
    """Fallback: search YouTube for popular Russian music clips."""
    queries = [
        "премьера клипа 2026 official music video",
        "новый клип 2026 премьера",
        "official video 2026 Russia music",
    ]
    all_clips = []
    seen = set()

    for q in queries:
        results = youtube_search(q, max_results=5)
        for r in results:
            vid = r.get("videoId", "")
            if vid and vid not in seen:
                if is_spam_video(r.get("title", ""), r.get("artist", "")):
                    continue
                seen.add(vid)
                r["source"] = "YouTube"
                r["sourceType"] = "search"
                all_clips.append(r)
        time.sleep(2)

    log.info(f"  YouTube search fallback: {len(all_clips)}")
    return all_clips


# ─── YouTube Search ──────────────────────────────────────────

def youtube_search(query: str, max_results: int = 3) -> list[dict]:
    """Search YouTube and return video results."""
    url = f"https://www.youtube.com/results?search_query={quote(query)}&sp=EgIQAQ%253D%253D"
    html = fetch(url)
    if not html:
        return []

    m = re.search(r'ytInitialData\s*=\s*(\{.*?\});\s*</script>', html, re.DOTALL)
    if not m:
        m = re.search(r'var ytInitialData = (\{.*?\});</script>', html, re.DOTALL)
    if not m:
        return []

    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []

    results = []
    def find_videos(obj):
        if isinstance(obj, dict):
            if "videoRenderer" in obj:
                vr = obj["videoRenderer"]
                vid = vr.get("videoId", "")
                if vid:
                    title_runs = vr.get("title", {}).get("runs", [{}])
                    artist_runs = vr.get("longBylineText", {}).get("runs", [{}])
                    views_text = vr.get("viewCountText", {}).get("simpleText", "")
                    duration = vr.get("lengthText", {}).get("simpleText", "")
                    results.append({
                        "videoId": vid,
                        "title": title_runs[0].get("text", "") if title_runs else "",
                        "artist": artist_runs[0].get("text", "") if artist_runs else "",
                        "youtubeUrl": f"https://www.youtube.com/watch?v={vid}",
                        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                        "views": views_text,
                        "duration": duration,
                    })
            for v in obj.values():
                find_videos(v)
        elif isinstance(obj, list):
            for item in obj:
                find_videos(item)

    find_videos(data)
    return results[:max_results]


def search_youtube_single(query: str) -> dict | None:
    """Search YouTube for a single video."""
    results = youtube_search(query + " official music video", max_results=1)
    return results[0] if results else None


def enrich_with_youtube(clips: list[dict]) -> list[dict]:
    """Find YouTube videos for clips from Europa Plus / MUZ-TV."""
    enriched = []
    for clip in clips:
        if clip.get("videoId"):
            enriched.append(clip)
            continue

        query = f"{clip['artist']} {clip['title']}"
        log.info(f"  YT search: {query}")
        result = search_youtube_single(query)

        if result:
            clip["videoId"] = result["videoId"]
            clip["youtubeUrl"] = result["youtubeUrl"]
            clip["views"] = result.get("views", "")
            clip["duration"] = result.get("duration", "")
            if not clip.get("thumbnail") or "europaplus" in clip.get("thumbnail", ""):
                clip["thumbnail"] = result["thumbnail"]
            enriched.append(clip)
            log.info(f"    → {result['videoId']}")
        else:
            log.info(f"    → not found")

        time.sleep(1.5)

    return enriched


# ─── Database ────────────────────────────────────────────────

def db_upsert(conn, table: str, pk: str, pk_val: str, data: dict):
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.cursor()
    cur.execute(f"""
        INSERT INTO {table} ({pk}, data, updated_at)
        VALUES (%s, %s, %s)
        ON CONFLICT ({pk}) DO UPDATE SET data = %s, updated_at = %s
    """, (pk_val, Json(data), now, Json(data), now))
    conn.commit()
    cur.close()


# ─── Main ────────────────────────────────────────────────────

def main():
    log.info("=" * 60)
    log.info("PromoFM Video Clips Agent v2")
    log.info("=" * 60)

    all_clips = []
    seen_ids = set()

    # 1. Europa Plus API
    ep_clips = parse_europaplus()

    # 2. MUZ-TV Charts
    muz_clips = parse_muztv()

    # 3. YouTube trending
    yt_clips = parse_youtube_trending()

    # Add YouTube clips first (already have videoIds), skip spam
    for c in yt_clips:
        vid = c.get("videoId", "")
        if vid and vid not in seen_ids:
            if is_spam_video(c.get("title", ""), c.get("artist", "")):
                log.info(f"  SKIP final: {c.get('artist','')} — {c.get('title','')[:60]}")
                continue
            seen_ids.add(vid)
            all_clips.append(c)

    # Enrich Europa Plus with YouTube
    log.info("Enriching Europa Plus with YouTube...")
    for c in enrich_with_youtube(ep_clips[:10]):
        vid = c.get("videoId", "")
        if vid and vid not in seen_ids:
            seen_ids.add(vid)
            all_clips.append(c)

    # Enrich MUZ-TV with YouTube
    log.info("Enriching MUZ-TV with YouTube...")
    for c in enrich_with_youtube(muz_clips[:8]):
        vid = c.get("videoId", "")
        if vid and vid not in seen_ids:
            seen_ids.add(vid)
            all_clips.append(c)

    log.info(f"Total unique clips: {len(all_clips)}")

    if not all_clips:
        log.warning("No clips found!")
        return

    log.info("--- Top clips ---")
    for i, c in enumerate(all_clips[:20]):
        log.info(f"  {i+1}. [{c.get('source','')}] {c['artist']} — {c['title']}")

    if DRY_RUN:
        log.info("DRY RUN — not saving")
        return

    conn = psycopg2.connect(DB_DSN)
    clips_data = {
        "clips": all_clips[:20],
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "totalFound": len(all_clips),
        "sources": ["europaplus", "muztv", "youtube"],
    }
    db_upsert(conn, "platform_stats", "id", "videos:new_clips", clips_data)
    conn.close()
    log.info(f"Saved {len(clips_data['clips'])} clips")


if __name__ == "__main__":
    main()
