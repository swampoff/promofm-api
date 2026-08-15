#!/usr/bin/env python3
"""
АНАЛИЗ АУДИО КАТАЛОГА — темп, тональность, энергия для AI-слоя.

Порт логики /opt/dj-den/den_analyzer.py с радиосервера Soul FM, где она
обсчитала 3557 треков. Считает не «на глазок»: BPM и ноты снимает aubio,
громкость — ffmpeg (ebur128).

Заполняет tracks.bpm / music_key / energy и помечает
audio_features_source='audio' + analyzed_at, чтобы машинные значения не
смешивались с указанными человеком.

Запуск:  python3 track-audio-analyzer.py [--limit N] [--force]
"""
import os
import re
import sys
import json
import subprocess
import logging
from datetime import datetime, timezone

import psycopg2

logging.basicConfig(level=logging.INFO, format="%(asctime)s [Audio] %(message)s")
log = logging.getLogger()

DB_DSN = "postgresql://promofm_app:PromoFM2024dbSecure@127.0.0.1:5432/promofm"
UPLOAD_ROOTS = [
    "/var/www/promofm/uploads/track-audio/uploads",
    "/var/www/promofm/uploads/track-audio",
    "/var/www/promofm/uploads/tracks",
    "/opt/promofm-api/uploads/tracks",
]

# Camelot — та же нотация, что у радийного анализатора: соседние номера
# сочетаются между собой, это нужно для подбора треков в плейлист.
CAMELOT = {
    ("C", "maj"): "8B", ("G", "maj"): "9B", ("D", "maj"): "10B", ("A", "maj"): "11B",
    ("E", "maj"): "12B", ("B", "maj"): "1B", ("F#", "maj"): "2B", ("C#", "maj"): "3B",
    ("G#", "maj"): "4B", ("D#", "maj"): "5B", ("A#", "maj"): "6B", ("F", "maj"): "7B",
    ("A", "min"): "8A", ("E", "min"): "9A", ("B", "min"): "10A", ("F#", "min"): "11A",
    ("C#", "min"): "12A", ("G#", "min"): "1A", ("D#", "min"): "2A", ("A#", "min"): "3A",
    ("F", "min"): "4A", ("C", "min"): "5A", ("G", "min"): "6A", ("D", "min"): "7A",
}
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def resolve_path(audio_url: str) -> str | None:
    if not audio_url:
        return None
    from urllib.parse import unquote
    rel = re.sub(r"^https?://[^/]+", "", audio_url)
    name = unquote(rel.split("/")[-1])
    for root in UPLOAD_ROOTS:
        p = os.path.join(root, name)
        if os.path.exists(p):
            return p
    return None


def analyze_bpm(path: str):
    """BPM через aubio. Утилита печатает строку вида '101.71 bpm' —
    разбираем токены, а не всю строку (на этом падал исходный парсер)."""
    try:
        r = subprocess.run(["aubio", "tempo", path], capture_output=True, text=True, timeout=90)
        for line in reversed(r.stdout.strip().split("\n")):
            for tok in line.split():
                try:
                    v = float(tok)
                    if 40 <= v <= 250:
                        return round(v, 1)
                except ValueError:
                    continue
    except Exception as e:
        log.warning(f"BPM не снят: {e}")
    return None


def analyze_key(path: str):
    """Тональность: гистограмма нот от aubio + сравнение с профилями
    мажора и минора (Krumhansl). Возвращает нотацию Camelot."""
    try:
        r = subprocess.run(["aubio", "notes", "-i", path, "-B", "4096"],
                           capture_output=True, text=True, timeout=90)
        hist = [0.0] * 12
        for line in r.stdout.strip().split("\n"):
            parts = line.split()
            if not parts:
                continue
            try:
                midi = float(parts[0])
            except ValueError:
                continue
            if midi <= 0:
                continue
            hist[int(round(midi)) % 12] += 1
        if sum(hist) < 10:
            return None
        maj = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
        minr = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
        best, best_score = None, -1.0
        for shift in range(12):
            rot = hist[shift:] + hist[:shift]
            for prof, mode in ((maj, "maj"), (minr, "min")):
                score = sum(a * b for a, b in zip(rot, prof))
                if score > best_score:
                    best_score, best = score, (NOTE_NAMES[shift], mode)
        return CAMELOT.get(best) if best else None
    except Exception as e:
        log.warning(f"Тональность не снята: {e}")
    return None


def analyze_energy(path: str):
    """Энергия 0-10 из интегральной громкости (LUFS) по ebur128."""
    try:
        r = subprocess.run(
            ["ffmpeg", "-i", path, "-filter_complex", "ebur128", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120)
        m = re.findall(r"I:\s*(-?\d+\.?\d*)\s*LUFS", r.stderr)
        if not m:
            return None
        lufs = float(m[-1])
        # Калибровка по фактическому разбросу каталога (замер 2026-08-15:
        # от -18.4 до -6.1 LUFS). Прежняя шкала -30..-6 давала 8-10 почти
        # всем и не различала треки. Берём -20..-6 → 0..10.
        # ⚠️ Это производная от громкости, а не воспринимаемая энергия:
        # годится для относительной фильтрации внутри каталога.
        val = (lufs + 20.0) / 14.0 * 10.0
        return round(max(0.0, min(10.0, val)), 1)
    except Exception as e:
        log.warning(f"Энергия не снята: {e}")
    return None


def main() -> int:
    limit = 0
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    force = "--force" in sys.argv

    conn = psycopg2.connect(DB_DSN)
    where = "AND analyzed_at IS NULL" if not force else ""
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT id, title, artist_name, audio_url FROM tracks
             WHERE moderation_status IN ('published','upcoming','approved')
               AND COALESCE(audio_url,'') <> '' {where}
             ORDER BY created_at DESC {'LIMIT %s' if limit else ''}
        """, (limit,) if limit else None)
        rows = cur.fetchall()

    log.info(f"К обсчёту: {len(rows)} треков")
    ok = missing = failed = 0
    for tid, title, artist, url in rows:
        path = resolve_path(url)
        if not path:
            missing += 1
            continue
        bpm = analyze_bpm(path)
        key = analyze_key(path)
        energy = analyze_energy(path)
        if bpm is None and key is None and energy is None:
            failed += 1
            continue
        with conn, conn.cursor() as cur:
            cur.execute("""
                UPDATE tracks
                   SET bpm = COALESCE(%s, bpm),
                       music_key = COALESCE(%s, music_key),
                       energy = COALESCE(%s, energy),
                       audio_features_source = 'audio',
                       analyzed_at = now()
                 WHERE id = %s
            """, (bpm, key, energy, tid))
        ok += 1
        if ok % 25 == 0:
            log.info(f"  обсчитано {ok}…")
    conn.close()
    log.info(f"Готово. Успешно: {ok}, файл не найден: {missing}, не разобрано: {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
