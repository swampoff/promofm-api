#!/usr/bin/env python3
"""
PROMO.AIR — копия AutoDJ для отдельного потока заведения (26.09.2026).

Берёт боевой AutoDJ из /opt/promofm-autodj (не трогая его) и собирает в
/opt/promo-air-venue версию, где все пути, точка стрим-сервера, порт и FIFO
задаются переменными окружения (по умолчанию — прежние значения). Каждый
экземпляр заведения запускается шаблоном systemd promo-air-venue@<slug>
со своим env-файлом. Перезапуск генератора синхронизирует копию с боевым
AutoDJ; если исходник изменился так, что замена не находится, — стоп.
"""
import os, re, shutil, sys

SRC = '/opt/promofm-autodj'
DST = '/opt/promo-air-venue'

def rewrite(name, pairs):
    s = open(os.path.join(SRC, name), encoding='utf-8').read()
    for old, new in pairs:
        n = s.count(old)
        if n < 1:
            sys.exit(f'{name}: не найдено «{old[:60]}»')
        s = s.replace(old, new)
    open(os.path.join(DST, name), 'w', encoding='utf-8').write(s)
    print('ok', name, len(pairs))

os.makedirs(DST, exist_ok=True)
E = 'os.getenv'
rewrite('promofm_dj.py', [
    ("sys.path.insert(0, '/opt/promofm-autodj')", "sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))"),
    ('MUSIC_DIR = "/mnt/data/promofm-music/tracks"', f'MUSIC_DIR = {E}("VENUE_MUSIC_DIR", "/mnt/data/promofm-music/tracks")'),
    ('JINGLES_DIR = "/mnt/data/promofm-music/jingles"', f'JINGLES_DIR = {E}("VENUE_JINGLES_DIR", "/mnt/data/promofm-music/jingles")'),
    ('NEWS_DIR = "/mnt/data/promofm-music/news"', f'NEWS_DIR = {E}("VENUE_NEWS_DIR", "/mnt/data/promofm-music/news")'),
    ('PODCASTS_DIR = "/mnt/data/promofm-music/podcasts"', f'PODCASTS_DIR = {E}("VENUE_PODCASTS_DIR", "/mnt/data/promofm-music/podcasts")'),
    ('ANNOUNCEMENTS_DIR = "/mnt/data/promofm-music/announcements"', f'ANNOUNCEMENTS_DIR = {E}("VENUE_ANNOUNCEMENTS_DIR", "/mnt/data/promofm-music/announcements")'),
    ('STREAM_URL = "http://127.0.0.1:8086/source/promo.fm"', f'STREAM_MOUNT = {E}("VENUE_STREAM_MOUNT", "promo.fm")\nSTREAM_URL = f"http://127.0.0.1:8086/source/{{STREAM_MOUNT}}"'),
    ('f"http://:{PASSWORD}@127.0.0.1:8086/source/promo.fm"', 'f"http://:{PASSWORD}@127.0.0.1:8086/source/{STREAM_MOUNT}"'),
    ('API_PORT = 8087', f'API_PORT = int({E}("VENUE_API_PORT", "8087"))'),
    ('FIFO_PATH = "/tmp/promofm.fifo"', f'FIFO_PATH = {E}("VENUE_FIFO", "/tmp/promofm.fifo")'),
    ('ANNOUNCE_INTERVAL = 2 * 60 * 60  # 2 hours', f'ANNOUNCE_INTERVAL = 2 * 60 * 60  # 2 hours\n# Ведущий-диктор promo.fm (Gemini) — у заведения свой, пока выключен.\nDJ_VOICE_ENABLED = {E}("VENUE_DJ_VOICE", "0") == "1"'),
    ('JINGLE_EVERY_N_TRACKS = 3', f'JINGLE_EVERY_N_TRACKS = int({E}("VENUE_JINGLE_EVERY", "3"))'),
    ('if now - last_announcement_played > ANNOUNCE_INTERVAL:', 'if DJ_VOICE_ENABLED and now - last_announcement_played > ANNOUNCE_INTERVAL:'),
    ('sys.path.insert(0, "/opt/promofm-autodj")', 'sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))'),
    ('"station": "promo.fm",', f'"station": {E}("VENUE_STATION_NAME", "promo.fm"),'),
    # история эфира заведения не пишется в общую статистику ПРОМО.ЭИР
    ('    if not INTERNAL_KEY:\n        return', f'    if not INTERNAL_KEY or {E}("VENUE_REPORT_PLAY", "0") != "1":\n        return'),
])
rewrite('promofm_oracle.py', [
    ('MUSIC_DIR = "/mnt/data/promofm-music/tracks"', f'MUSIC_DIR = {E}("VENUE_MUSIC_DIR", "/mnt/data/promofm-music/tracks")'),
    ('METADATA_FILE = "/opt/promofm-autodj/metadata.json"', f'METADATA_FILE = {E}("VENUE_METADATA_FILE", "/opt/promofm-autodj/metadata.json")'),
    ('HISTORY_FILE = "/opt/promofm-autodj/play_history.json"', f'HISTORY_FILE = {E}("VENUE_HISTORY_FILE", "/opt/promofm-autodj/play_history.json")'),
    ('ANALYTICS_FILE = "/opt/promofm-autodj/analytics.json"', f'ANALYTICS_FILE = {E}("VENUE_ANALYTICS_FILE", "/opt/promofm-autodj/analytics.json")'),
])
rewrite('radio_announcer.py', [
    ('FIFO_PATH = "/tmp/promofm.fifo"', f'FIFO_PATH = {E}("VENUE_FIFO", "/tmp/promofm.fifo")'),
])
rewrite('build-metadata.py', [
    ('MUSIC_DIR = "/mnt/data/promofm-music/tracks"', f'MUSIC_DIR = os.getenv("VENUE_MUSIC_DIR", "/mnt/data/promofm-music/tracks")'),
    ('OUT = "/opt/promofm-autodj/metadata.json"', f'OUT = os.getenv("VENUE_METADATA_FILE", "/opt/promofm-autodj/metadata.json")'),
])
for f in ('requirements.txt',):
    if os.path.exists(os.path.join(SRC, f)):
        shutil.copy2(os.path.join(SRC, f), os.path.join(DST, f))
print('venue copy ready in', DST)
