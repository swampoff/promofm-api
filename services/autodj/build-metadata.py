#!/usr/bin/env python3
"""Build metadata.json — match files with DB tracks by filename for proper artist names."""
import os, json, re, subprocess, urllib.parse

MUSIC_DIR = "/mnt/data/promofm-music/tracks"
OUT = "/opt/promofm-autodj/metadata.json"

# Load DB mapping: enc_filename → (artist_name, title, genre, created_at)
db_rows = subprocess.check_output([
    'sudo', '-u', 'postgres', 'psql', '-d', 'promofm', '-t', '-A', '-F', '|', '-c',
    """SELECT regexp_replace(audio_url, '^.*?/uploads/tracks/', ''),
              artist_name, title, COALESCE(genre,''), created_at::date,
              COALESCE(data->>'shoutout_url', '')
       FROM tracks
       WHERE audio_url LIKE '/server/uploads/tracks/%'
         AND moderation_status IN ('approved','published')"""
]).decode().strip().split('\n')

db_map = {}
for line in db_rows:
    if not line: continue
    parts = line.split('|')
    if len(parts) < 6: continue
    enc_fn = parts[0].strip()
    fn = urllib.parse.unquote(enc_fn)
    if fn:
        db_map[fn] = {
            'artist': parts[1].strip() or 'Unknown',
            'title': parts[2].strip(),
            'genre': parts[3].strip() or None,
            'date': parts[4].strip(),
            # Шаутаут — короткое голосовое представление артиста.
            # Если задан в data.shoutout_url, AutoDJ играет его перед
            # каждым треком этого артиста. Пустая строка → нет шаутаута.
            'shoutout_url': parts[5].strip() or None,
        }

tracks = []
unmatched = 0
for fn in sorted(os.listdir(MUSIC_DIR)):
    if not fn.lower().endswith(('.mp3', '.flac', '.m4a', '.wav')): continue

    # First try DB lookup
    info = db_map.get(fn)
    artist, title, genre, date = None, None, None, None

    shoutout_url = None
    if info:
        artist, title, genre, date = info['artist'], info['title'], info['genre'], info['date']
        shoutout_url = info.get('shoutout_url')
    else:
        unmatched += 1
        # Fallback: parse filename "Artist - Title.mp3" or strip leading "NN "
        base = re.sub(r'\.(mp3|flac|m4a|wav)$', '', fn, flags=re.I)
        base = re.sub(r'^\d+\s+', '', base)
        if ' - ' in base:
            artist, title = base.split(' - ', 1)
            artist, title = artist.strip(), title.strip()
        else:
            artist, title = 'Unknown', base

    tracks.append({
        'file': fn,
        'artist': artist,
        'title': title,
        'energy': None, 'bpm': None, 'key': None,
        'genre': genre,
        'region': 'Global',
        'date': date,
        'shoutout_url': shoutout_url,
    })

with open(OUT, 'w') as f:
    json.dump({'tracks': tracks}, f, ensure_ascii=False, indent=2)

print(f'Wrote {len(tracks)} tracks. Matched DB: {len(tracks)-unmatched}, unmatched: {unmatched}')
print('Sample with proper artists:')
for t in tracks[:8]:
    print(f"  {t['artist']:25s} - {t['title']:35s} [{t.get('date','?')}]")
