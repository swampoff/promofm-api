#!/usr/bin/env python3
"""
promo.fm AutoDJ
Автоматический DJ для радио promo.fm (promo-music.ru/air/)
Адаптировано из Soul FM AutoDJ для платформы промо-артистов.

Поток: MP3 файлы → FFmpeg декодер → FIFO → FFmpeg энкодер → Go stream-server
"""

import os
import time
import struct
import wave
import subprocess
import random
import signal
import sys
import json
import threading
import logging
import datetime
import requests
import hashlib
import urllib.parse
from flask import Flask, jsonify, request
from werkzeug.utils import secure_filename

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [PromoAir] %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

# DJ Oracle
sys.path.insert(0, '/opt/promofm-autodj')
try:
    from promofm_oracle import DJOracle
    oracle = DJOracle()
    logger.info("DJ Oracle connected — smart rotation active")
except ImportError as e:
    logger.warning(f"DJ Oracle not found ({e}), fallback to random shuffle")
    oracle = None

# ─── Config ───
MUSIC_DIR = "/mnt/data/promofm-music/tracks"
JINGLES_DIR = "/mnt/data/promofm-music/jingles"
NEWS_DIR = "/mnt/data/promofm-music/news"
PODCASTS_DIR = "/mnt/data/promofm-music/podcasts"

STREAM_URL = "http://127.0.0.1:8086/source/promo.fm"
PASSWORD = os.getenv("STREAM_PASSWORD", "promo_secret_2026")
API_PORT = 8087
FIFO_PATH = "/tmp/promofm.fifo"

# Report plays to promofm-api
PROMOFM_API_URL = os.getenv("PROMOFM_API_URL", "http://127.0.0.1:3000")
INTERNAL_KEY = os.getenv("INTERNAL_KEY", "")

NEWS_INTERVAL = 30 * 60  # 30 min
ANNOUNCE_INTERVAL = 2 * 60 * 60  # 2 hours
ANNOUNCEMENTS_DIR = "/mnt/data/promofm-music/announcements"
JINGLE_EVERY_N_TRACKS = 3
# Подкасты ВРЕМЕННО ОТКЛЮЧЕНЫ: движок engine.mjs генерит диалоги, где ведущий
# ломает образ ("ну что, звучит убедительно? как вам такой вариант?") — палит,
# что это ИИ-ассистент. Играют standalone (без музыки). Включить обратно ТОЛЬКО
# после правки промпта engine.mjs (запрет мета-вопросов / самокомментариев).
# Включено обратно 2026-08-07 (владелец): условие отключения выполнено —
# в промпте engine.mjs стоит запрет мета-вопросов и AI-маркеров (+ пост-фильтр
# регулярками), готовые выпуски проверены: ноль фраз, выдающих ИИ.
# Режим щадящий: один выпуск в час в дневные часы, ночью только музыка.
# Флаг podcast_played_this_hour не даёт повторить выпуск в том же часе.
PODCAST_EVERY_N_TRACKS = 10**9  # триггер по счётчику треков не используем — работаем по часам
PODCAST_HOURS_MSK = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]

app = Flask(__name__)

# ─── State ───
master_process = None
decoder_process = None
current_track = None
current_track_info = {}
playlist_queue = []
is_radio_running = True
dummy_fd = None
last_news_played = 0
last_announcement_played = 0
podcast_track_counter = 0
pending_overlay = None
live_voice_buffer = None   # Set by /api/inject for immediate overlay on current track
live_post_inject_bytes = 0  # Bytes of post-inject ducking remaining (3s gap + 1s fade)
live_voice_offset = 0      # Current position in live_voice_buffer
podcast_played_this_hour = False
last_podcast_hour = -1
play_history = []


def cleanup():
    global master_process, decoder_process
    logger.info("Shutting down AutoDJ...")
    if decoder_process:
        decoder_process.terminate()
    if master_process:
        master_process.terminate()
    if os.path.exists(FIFO_PATH):
        os.remove(FIFO_PATH)


def signal_handler(sig, frame):
    global is_radio_running
    is_radio_running = False
    cleanup()
    sys.exit(0)


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def get_all_tracks():
    """Scan music directory recursively, skip jingles/news/podcasts"""
    os.makedirs(MUSIC_DIR, exist_ok=True)
    tracks = []
    for root, dirs, files in os.walk(MUSIC_DIR):
        for f in files:
            if f.lower().endswith('.mp3'):
                if any(skip in f.lower() for skip in ['jingle', 'dj_voice', 'news']):
                    continue
                tracks.append(os.path.relpath(os.path.join(root, f), MUSIC_DIR))
    return tracks


def start_master_ffmpeg():
    """Start master FFmpeg encoder: FIFO → MP3 128k → PUT to Go stream-server"""
    global master_process, dummy_fd

    if os.path.exists(FIFO_PATH):
        import stat
        if not stat.S_ISFIFO(os.stat(FIFO_PATH).st_mode):
            os.remove(FIFO_PATH)
            os.mkfifo(FIFO_PATH)
    else:
        os.mkfifo(FIFO_PATH)

    logger.info("Starting Master FFmpeg (Encoder)...")
    cmd = [
        "ffmpeg", "-y",
        "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", FIFO_PATH,
        "-vn", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3",
        "-method", "PUT",
        f"http://:{PASSWORD}@127.0.0.1:8086/source/promo.fm"
    ]
    master_process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)

    try:
        dummy_fd = os.open(FIFO_PATH, os.O_WRONLY | os.O_NONBLOCK)
    except Exception as e:
        logger.error(f"Error opening dummy_fd: {e}")


def report_play_to_api(track_info):
    """Report played track to promofm-api for history/stats"""
    if not INTERNAL_KEY:
        return
    try:
        requests.post(
            f"{PROMOFM_API_URL}/api/air/internal/report-play",
            json=track_info,
            headers={"X-Internal-Key": INTERNAL_KEY},
            timeout=5
        )
    except Exception as e:
        logger.warning(f"Failed to report play: {e}")


def _mix_overlay(music_chunk: bytes, overlay: bytes, offset: int,
                 overlay_len: int, duck_vol: float, fade_bytes: int, tail_fade: bool = True) -> bytes:
    """Mix voice overlay on top of ducked music. Returns mixed PCM chunk."""
    chunk_len = len(music_chunk)
    # Ensure even number of bytes (s16le = 2 bytes per sample)
    if chunk_len % 2 != 0:
        chunk_len -= 1
        music_chunk = music_chunk[:chunk_len]

    n_samples = chunk_len // 2
    music_samples = struct.unpack(f'<{n_samples}h', music_chunk)

    # Get overlay slice
    ov_end = min(offset + chunk_len, overlay_len)
    ov_slice = overlay[offset:ov_end]
    # Pad if overlay is shorter than chunk
    if len(ov_slice) < chunk_len:
        ov_slice += b'\x00' * (chunk_len - len(ov_slice))
    ov_samples = struct.unpack(f'<{n_samples}h', ov_slice[:chunk_len])

    mixed = []
    for i in range(n_samples):
        # Calculate duck factor with fade in/out
        pos = offset + i * 2
        if pos < fade_bytes:
            # Fade in: gradually duck music
            t = pos / fade_bytes
            vol = 1.0 - t * (1.0 - duck_vol)
        elif tail_fade and pos > overlay_len - fade_bytes:
            # Fade out: gradually restore music
            t = (overlay_len - pos) / fade_bytes
            vol = 1.0 - t * (1.0 - duck_vol)
        else:
            vol = duck_vol

        # Voice fades
        voice_vol = 1.5
        if pos < fade_bytes // 2:
            voice_vol = pos / (fade_bytes // 2)
        elif tail_fade and pos > overlay_len - fade_bytes // 2:
            voice_vol = max(0, (overlay_len - pos) / (fade_bytes // 2))

        val = int(music_samples[i] * vol + ov_samples[i] * voice_vol)
        val = max(-32768, min(32767, val))
        mixed.append(val)

    return struct.pack(f'<{n_samples}h', *mixed)



def play_music_chain(track_paths, xfade_sec=2.5):
    """Play a chain of music tracks with acrossfade between consecutive pairs.
    Single FFmpeg process — no FIFO underrun between tracks → no buzz, no gap."""
    global current_track, current_track_info, decoder_process
    global live_voice_buffer, live_voice_offset, live_post_inject_bytes

    if not track_paths:
        return
    if len(track_paths) == 1:
        play_track(track_paths[0])
        return

    # Build filter_complex with chained acrossfade
    inputs = []
    for p in track_paths:
        inputs.extend(['-i', p])

    parts = []
    last = '[0:a]'
    for i in range(1, len(track_paths)):
        outlabel = f'[a{i}]' if i < len(track_paths) - 1 else '[out]'
        parts.append(f'{last}[{i}:a]acrossfade=d={xfade_sec}:c1=tri:c2=tri{outlabel}')
        last = outlabel
    filter_complex = ';'.join(parts)

    cmd = ['ffmpeg', '-re'] + inputs + [
        '-filter_complex', filter_complex,
        '-map', '[out]',
        '-f', 's16le', '-ar', '44100', '-ac', '2',
        'pipe:1'
    ]

    current_track = os.path.basename(track_paths[0])
    current_track_info = {
        'filename': current_track,
        'file_path': track_paths[0],
        'played_at': datetime.datetime.now().isoformat(),
        'chain_size': len(track_paths),
    }
    logger.info(f'[xfade-chain] {len(track_paths)} tracks: {[os.path.basename(p) for p in track_paths]}')

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    decoder_process = proc

    try:
        with open(FIFO_PATH, 'wb') as fifo:
            while True:
                if master_process is None or master_process.poll() is not None:
                    logger.warning('Master process died during chain. Breaking.')
                    break
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                # Handle live voice overlay (DJ injection during music)
                try:
                    if live_voice_buffer and live_voice_offset < len(live_voice_buffer):
                        # tail_fade=True → плавное затухание голоса в конце (no click)
                        chunk = _mix_overlay(chunk, live_voice_buffer, live_voice_offset,
                                             len(live_voice_buffer), 0.10, 44100*2*2, tail_fade=True)
                        live_voice_offset += len(chunk)
                        if live_voice_offset >= len(live_voice_buffer):
                            logger.info(f'[inject] Live overlay finished ({live_voice_offset} bytes mixed)')
                            live_voice_buffer = None
                            live_voice_offset = 0
                            # 3s ducked gap + 1s fade-in = 4s total
                            live_post_inject_bytes = int(44100 * 2 * 2 * 4.0)
                            logger.info('[inject] Post-inject: 3s gap + 1s fade-in')
                    elif live_post_inject_bytes > 0:
                        # Music stays ducked 3s, then fades up over 1s (no click)
                        _GAP = int(44100 * 2 * 2 * 3.0)
                        _FADE = int(44100 * 2 * 2 * 1.0)
                        _TOTAL = _GAP + _FADE
                        _pos = _TOTAL - live_post_inject_bytes
                        _clen = len(chunk)
                        if _clen % 2 != 0:
                            _clen -= 1
                            chunk = chunk[:_clen]
                        _ns = _clen // 2
                        _samp = struct.unpack(f'<{_ns}h', chunk)
                        _mixed = []
                        for _i in range(_ns):
                            _bp = _pos + _i * 2
                            if _bp < _GAP:
                                _v = 0.10
                            else:
                                _t = min(1.0, (_bp - _GAP) / _FADE)
                                _v = 0.10 + _t * 0.90
                            _val = int(_samp[_i] * _v)
                            _mixed.append(max(-32768, min(32767, _val)))
                        chunk = struct.pack(f'<{_ns}h', *_mixed)
                        live_post_inject_bytes -= _clen
                        if live_post_inject_bytes <= 0:
                            live_post_inject_bytes = 0
                            logger.info('[inject] Post-inject fade complete, music restored')
                    fifo.write(chunk)
                except BrokenPipeError:
                    logger.error('FATAL: Broken pipe in fifo.write — exiting for systemd restart')
                    import os as _os
                    _os._exit(1)
    except Exception as e:
        logger.error(f'Error in chain: {e}')
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=1)
        except Exception:
            pass


SHOUTOUT_CACHE_DIR = "/tmp/promofm-shoutouts"
os.makedirs(SHOUTOUT_CACHE_DIR, exist_ok=True)


def load_shoutout_pcm(track_filepath):
    """Если у трека в metadata.json есть shoutout_url — скачиваем (кешируем
    в /tmp/promofm-shoutouts/<md5>.<ext>) и декодируем в s16le 44.1kHz
    stereo PCM bytes для последующей передачи в play_track(... overlay_pcm).

    Голос идёт ПОВЕРХ начала музыки, музыка дакается до DUCK_VOL пока
    шаутаут говорит, после — fade-in обратно (логика в _mix_overlay).
    Шаутаут НЕ играет отдельным треком — это и есть «голос под трек».

    Returns: bytes (PCM) или None если шаутаута нет / download failed.
    """
    global oracle
    if not oracle: return None
    track_filename = os.path.basename(track_filepath)
    meta = None
    for t in oracle.metadata.get('tracks', []):
        if t.get('file') == track_filename or t.get('filename') == track_filename:
            meta = t
            break
    if not meta:
        return None
    url = meta.get('shoutout_url')
    if not url:
        return None
    # Расширение из URL или fallback m4a.
    path_part = urllib.parse.urlparse(url).path
    ext = path_part.rsplit('.', 1)[-1].lower() if '.' in path_part[-6:] else 'm4a'
    if ext not in ('mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'):
        ext = 'm4a'
    cache_key = hashlib.md5(url.encode('utf-8')).hexdigest()[:16]
    cache_path = os.path.join(SHOUTOUT_CACHE_DIR, f"{cache_key}.{ext}")
    if not os.path.exists(cache_path):
        try:
            r = requests.get(url, timeout=10, stream=True)
            r.raise_for_status()
            with open(cache_path, 'wb') as f:
                for chunk in r.iter_content(8192):
                    if chunk: f.write(chunk)
            logger.info(f"[shoutout] cached {meta.get('artist')}: {url} → {cache_path}")
        except Exception as e:
            logger.warning(f"[shoutout] download failed for {meta.get('artist')}: {e}")
            try: os.remove(cache_path)
            except Exception: pass
            return None
    # Декодируем кешированный файл в raw PCM s16le 44.1kHz stereo —
    # тот же формат что overlay_pcm ожидает в play_track loop.
    try:
        proc = subprocess.run(
            ["ffmpeg", "-i", cache_path, "-f", "s16le", "-ar", "44100", "-ac", "2", "-"],
            capture_output=True, timeout=30
        )
        pcm = proc.stdout
        if len(pcm) < 4410:  # < 0.025s decoded → broken file
            logger.warning(f"[shoutout] decoded PCM too short for {meta.get('artist')}: {len(pcm)} bytes")
            return None
        logger.info(f"[shoutout] PCM ready for {meta.get('artist')} → {meta.get('title')}: {len(pcm)//4//44100:.1f}s")
        return pcm
    except Exception as e:
        logger.warning(f"[shoutout] decode failed for {meta.get('artist')}: {e}")
        return None


def play_track(filepath, overlay_pcm=None, duck_vol=0.30):
    """Decode track and pipe raw PCM data into FIFO.
    overlay_pcm: optional bytes (s16le 44.1kHz stereo) to mix on top with ducking.
    duck_vol: music level while the overlay speaks — 0.30 for DJ-ведущих (тише
    на 70%), 0.15 for artist shoutouts (тише на 85%)."""
    global current_track, current_track_info, decoder_process
    global live_voice_buffer, live_voice_offset, live_post_inject_bytes

    current_track = os.path.basename(filepath)
    if overlay_pcm:
        logger.info(f"Now playing: {current_track} [+DJ overlay {len(overlay_pcm)} bytes]")
    else:
        logger.info(f"Now playing: {current_track}")

    # Build track info for reporting
    track_info = {
        "filename": current_track,
        "file_path": filepath,
        "played_at": datetime.datetime.now().isoformat(),
    }

    # Get metadata from oracle if available
    if oracle:
        for t in oracle.metadata.get('tracks', []):
            if t.get('filename') == current_track or filepath.endswith(t.get('file', '')):
                track_info.update({
                    "artist": t.get("artist", "Unknown"),
                    "title": t.get("title", current_track),
                    "genre": t.get("genre"),
                    "energy": t.get("energy"),
                    "bpm": t.get("bpm"),
                    "key": t.get("key"),
                })
                break

    current_track_info = track_info

    # Audio filter chain (streaming-safe, no areverse):
    # 1. Strip ONLY leading silence (>0.0s under -45dB)
    # 2. Tiny fade-in to avoid clicks
    # ВАЖНО: areverse + tail-silenceremove буферизует весь трек — НЕ СОВМЕСТИМО с -re.
    # Хвост обрезать ffmpeg не будет, но это ок — тишина в конце треков редко
    # превышает 1-2с и не мешает.
    af_chain = (
        "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,"
        "afade=t=in:st=0:d=0.05"
    )
    # Get duration for fade-out (silent on failure)
    track_duration = None
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", filepath],
            capture_output=True, text=True, timeout=3
        )
        track_duration = float(probe.stdout.strip())
    except Exception:
        pass

    # Append fade-out 100ms to chain (only if duration known and > 0.5s)
    chain = af_chain
    if track_duration and track_duration > 0.5:
        fade_start = max(0.1, track_duration - 0.1)
        chain = chain + f",afade=t=out:st={fade_start:.2f}:d=0.1"

    audio_filter = ["-af", chain]
    # Jingles: 200ms head buffer + same chain
    if 'jingle' in filepath.lower():
        audio_filter = ["-af", "adelay=200|200," + chain]

    cmd = [
        "ffmpeg", "-re", "-i", filepath
    ] + audio_filter + [
        "-f", "s16le", "-ar", "44100", "-ac", "2",
        "pipe:1"
    ]

    decoder_process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    overlay_offset = 0
    overlay_len = len(overlay_pcm) if overlay_pcm else 0
    # duck_vol приходит из вызова: 0.30 = DJ-ведущий (тише на 70%),
    # 0.15 = шаутаут артиста (тише на 85%).
    FADE_BYTES = 44100 * 2 * 2  # 0.5s fade (samples * 2ch * 2bytes)

    try:
        with open(FIFO_PATH, 'wb') as fifo:
            while True:
                if master_process is None or master_process.poll() is not None:
                    logger.warning("Master process died during playback. Breaking.")
                    break
                chunk = decoder_process.stdout.read(4096)
                if not chunk:
                    break
                try:
                    if overlay_pcm and overlay_offset < overlay_len:
                        # Mix: duck music + add voice overlay (pre-scheduled)
                        chunk = _mix_overlay(chunk, overlay_pcm, overlay_offset,
                                             overlay_len, duck_vol, FADE_BYTES)
                        overlay_offset += len(chunk)
                    elif live_voice_buffer and live_voice_offset < len(live_voice_buffer):
                        # Live inject: voice over current track (NO voice fade-out)
                        chunk = _mix_overlay(chunk, live_voice_buffer, live_voice_offset,
                                             len(live_voice_buffer), 0.10, FADE_BYTES, tail_fade=False)
                        live_voice_offset += len(chunk)
                        if live_voice_offset >= len(live_voice_buffer):
                            logger.info(f"[inject] Live overlay finished ({live_voice_offset} bytes mixed)")
                            live_voice_buffer = None
                            live_voice_offset = 0
                            # 3s ducked gap + 1s fade-in = 4s total post-inject
                            live_post_inject_bytes = int(44100 * 2 * 2 * 4.0)
                            logger.info("[inject] Post-inject: 3s gap + 1s fade-in")
                    elif live_post_inject_bytes > 0:
                        # Post-inject: music stays ducked 3s, then fades in over 1s
                        _GAP = int(44100 * 2 * 2 * 3.0)   # 3s
                        _FADE = int(44100 * 2 * 2 * 1.0)   # 1s
                        _TOTAL = _GAP + _FADE
                        _pos = _TOTAL - live_post_inject_bytes
                        _clen = len(chunk)
                        if _clen % 2 != 0:
                            _clen -= 1
                            chunk = chunk[:_clen]
                        _ns = _clen // 2
                        _samp = struct.unpack(f'<{_ns}h', chunk)
                        _mixed = []
                        for _i in range(_ns):
                            _bp = _pos + _i * 2
                            if _bp < _GAP:
                                _v = 0.10  # still ducked
                            else:
                                _t = min(1.0, (_bp - _GAP) / _FADE)
                                _v = 0.10 + _t * 0.90  # 10% -> 100%
                            _val = int(_samp[_i] * _v)
                            _mixed.append(max(-32768, min(32767, _val)))
                        chunk = struct.pack(f'<{_ns}h', *_mixed)
                        live_post_inject_bytes -= _clen
                        if live_post_inject_bytes <= 0:
                            live_post_inject_bytes = 0
                            logger.info("[inject] Post-inject fade complete, music restored")
                    fifo.write(chunk)
                except BrokenPipeError:
                    logger.error("FATAL: Broken pipe in fifo.write — exiting for systemd restart")
                    import os as _os
                    _os._exit(1)
    except Exception as e:
        logger.error(f"Error in play_track: {e}")
        # Если ошибка фатальная — exit чтобы systemd перезапустил
        if isinstance(e, (BrokenPipeError, ConnectionResetError)):
            import os as _os
            _os._exit(1)
    finally:
        if decoder_process:
            try:
                decoder_process.terminate()
                decoder_process.wait(timeout=1)
            except Exception:
                pass

        # Report play to API
        threading.Thread(target=report_play_to_api, args=(track_info,), daemon=True).start()

        # Add to local history
        play_history.append(track_info)
        if len(play_history) > 100:
            play_history.pop(0)

        # Auto-cleanup ephemeral files
        if "news/" in filepath.lower():
            try:
                if os.path.exists(filepath):
                    os.remove(filepath)
                    logger.info(f"Cleaned up: {os.path.basename(filepath)}")
            except Exception as e:
                logger.warning(f"Cleanup error: {e}")


def get_moscow_hour():
    """Get current hour in Moscow timezone (UTC+3)"""
    utc_now = datetime.datetime.utcnow()
    msk = utc_now + datetime.timedelta(hours=3)
    return msk.hour


def radio_thread():
    """Main radio broadcast thread"""
    global is_radio_running, playlist_queue, current_track
    global last_news_played, podcast_played_this_hour, last_podcast_hour
    global last_announcement_played, pending_overlay

    logger.info("Radio thread started")
    start_master_ffmpeg()

    jingle_counter = 0

    while is_radio_running:
        try:
            # Restart master if dead
            if master_process is None or master_process.poll() is not None:
                if master_process and master_process.returncode != 0:
                    logger.warning(f"Master FFmpeg crashed (code {master_process.returncode}). Restarting...")
                start_master_ffmpeg()

            now = time.time()

            # Reset podcast flag on hour change
            msk_hour = get_moscow_hour()
            if msk_hour != last_podcast_hour:
                podcast_played_this_hour = False
                last_podcast_hour = msk_hour

            # Priority -1: Scheduled podcasts
            if msk_hour in PODCAST_HOURS_MSK and not podcast_played_this_hour:
                if os.path.exists(PODCASTS_DIR):
                    podcast_files = sorted(
                        [f for f in os.listdir(PODCASTS_DIR) if f.lower().endswith('.mp3')],
                        key=lambda x: os.path.getmtime(os.path.join(PODCASTS_DIR, x)),
                        reverse=True
                    )
                    if podcast_files:
                        podcast_path = os.path.join(PODCASTS_DIR, podcast_files[0])
                        logger.info(f"Podcast time: {podcast_files[0]}")
                        play_track(podcast_path)
                        podcast_played_this_hour = True
                        jingle_counter = 0
                        continue

            # Jingles every N tracks (skip if DJ announcement overlay is pending)
            # Rhythm: 3 tracks → jingle → DJ comment → jingle → repeat
            if jingle_counter >= JINGLE_EVERY_N_TRACKS and not pending_overlay:
                if os.path.exists(JINGLES_DIR):
                    jingles = [f for f in os.listdir(JINGLES_DIR) if f.lower().endswith('.mp3')]
                    if jingles:
                        jingle = random.choice(jingles)
                        logger.info(f"Jingle 1: {jingle}")
                        play_track(os.path.join(JINGLES_DIR, jingle))

                        # RHYTHM: jingle 1 -> pre-rendered DJ mp3 -> jingle 2
                        DJ_QUEUE_DIR = '/opt/promofm-podcast/dj-queue'
                        try:
                            if os.path.isdir(DJ_QUEUE_DIR):
                                dj_files = sorted([f for f in os.listdir(DJ_QUEUE_DIR) if f.startswith('dj_') and f.endswith('.mp3')])
                                if dj_files:
                                    dj_path = os.path.join(DJ_QUEUE_DIR, dj_files[0])
                                    logger.info(f'🎤 DJ track: {dj_files[0]}')
                                    play_track(dj_path)
                                    try: os.remove(dj_path)
                                    except Exception: pass
                                else:
                                    logger.info('DJ queue empty, skip DJ slot')
                            else:
                                logger.info('DJ queue dir missing')
                        except Exception as e:
                            logger.warning(f'DJ slot error: {e}')

                        # PODCAST_EVERY_N_TRACKS — играем pre-built MP3 из engine queue (тот же jingle-DJ блок)
                        try:
                            ptc = globals().get('podcast_track_counter', 0)
                            if ptc >= PODCAST_EVERY_N_TRACKS:
                                logger.info(f'PODCAST trigger after {ptc} tracks')
                                PODCAST_QUEUE_DIR = '/opt/promofm-podcast/queue'
                                if os.path.isdir(PODCAST_QUEUE_DIR):
                                    pc_files = sorted([f for f in os.listdir(PODCAST_QUEUE_DIR) if f.endswith('.mp3')])
                                    if pc_files:
                                        pc_path = os.path.join(PODCAST_QUEUE_DIR, pc_files[0])
                                        logger.info(f'🎙 PODCAST track: {pc_files[0]}')
                                        play_track(pc_path)
                                        # удаляем подкаст + сайдкар
                                        try:
                                            os.remove(pc_path)
                                            sidecar = pc_path + '.json'
                                            if os.path.exists(sidecar): os.remove(sidecar)
                                        except Exception: pass
                                        globals()['podcast_track_counter'] = 0
                        except Exception as e:
                            logger.warning(f'Podcast trigger failed: {e}')
                jingle_counter = 0


            # Priority: DJ Announcement (every 2 hours) — Gemini Live API overlay
            if now - last_announcement_played > ANNOUNCE_INTERVAL:
                try:
                    sys.path.insert(0, "/opt/promofm-autodj")
                    from radio_announcer import generate_announcement_pcm
                    logger.info("Generating DJ announcement (Gemini Live API)...")
                    announce_pcm = generate_announcement_pcm()
                    if announce_pcm:
                        logger.info(f"DJ announcement ready: {len(announce_pcm)} bytes, overlaying on next track")
                        # Will play next track with voice overlay
                        pending_overlay = announce_pcm
                    else:
                        logger.warning("Announcer returned no audio")
                    last_announcement_played = now
                except Exception as e:
                    logger.warning(f"Announcement error: {e}")
                    last_announcement_played = now

            # Priority 0: News (every 30 min)
            if now - last_news_played > NEWS_INTERVAL:
                if os.path.exists(NEWS_DIR):
                    try:
                        news_files = [f for f in os.listdir(NEWS_DIR) if f.endswith(".mp3")]
                        if news_files:
                            news_files.sort(
                                key=lambda x: os.path.getmtime(os.path.join(NEWS_DIR, x)),
                                reverse=True
                            )
                            latest = os.path.join(NEWS_DIR, news_files[0])
                            logger.info(f"News: {news_files[0]}")
                            play_track(latest)
                            last_news_played = now
                            jingle_counter = 0
                            continue
                    except Exception as e:
                        logger.warning(f"News error: {e}")

            # Priority 1: Manual queue (API) — also handles voice inject WAVs
            if playlist_queue:
                next_name = playlist_queue.pop(0)
                is_voice = next_name.startswith('/tmp/voice_inject_')
                if is_voice:
                    track_path = next_name  # Absolute path for voice inject
                else:
                    track_path = os.path.join(MUSIC_DIR, next_name)
                if os.path.exists(track_path):
                    # Шаутаут идёт ПОВЕРХ начала трека (overlay) — не отдельным
                    # файлом. Музыка ducked до DUCK_VOL=0.50 пока шаутаут
                    # говорит, потом fade-in обратно на 100%.
                    shoutout_pcm = None if is_voice else load_shoutout_pcm(track_path)
                    play_track(track_path, overlay_pcm=shoutout_pcm, duck_vol=0.15)
                    if not is_voice:
                        jingle_counter += 1
                        # Также считаем для подкаст-триггера
                        try:
                            globals()['podcast_track_counter'] = globals().get('podcast_track_counter', 0) + 1
                        except Exception:
                            pass
                        if oracle:
                            oracle.record_play({"file": next_name, "artist": "Unknown"})
                    else:
                        # Clean up temp voice file after playing
                        try:
                            os.remove(track_path)
                            logger.info(f"[inject] Cleaned up temp voice: {os.path.basename(track_path)}")
                        except Exception:
                            pass
                else:
                    logger.warning(f"File not found: {track_path}")
                continue

            # Priority 2: Oracle picks tracks — BATCH chain with crossfade
            if oracle:
                try:
                    oracle.reload_metadata()
                    # Pick up to (JINGLE_EVERY_N_TRACKS - jingle_counter) tracks
                    # ВАЖНО: внутри batch исключаем уже выбранное (oracle не знает что мы только что пикнули)
                    n_to_pick = max(1, JINGLE_EVERY_N_TRACKS - jingle_counter)
                    batch = []
                    picked_tracks = []
                    picked_files_in_batch = set()
                    picked_artists_in_batch = set()
                    for _ in range(n_to_pick):
                        # try several times to avoid duplicates within batch
                        t = None
                        for _attempt in range(6):
                            cand = oracle.pick_next_track()
                            if not cand: break
                            cand_file = cand.get('file', '')
                            cand_artist = (cand.get('artist') or '').lower().strip()
                            if cand_file in picked_files_in_batch:
                                continue  # уже взят в этой партии
                            if cand_artist and cand_artist in picked_artists_in_batch:
                                continue  # тот же артист — пропускаем
                            t = cand
                            break
                        if not t: break
                        fp = t['file']
                        if not fp.startswith('/'):
                            fp = os.path.join(MUSIC_DIR, fp)
                        if os.path.exists(fp):
                            batch.append(fp)
                            picked_tracks.append(t)
                            picked_files_in_batch.add(t.get('file', ''))
                            ca = (t.get('artist') or '').lower().strip()
                            if ca: picked_artists_in_batch.add(ca)
                            # Pre-record selection in oracle history so next pick_next_track sees it
                            # (это "провизорная" запись — финальный record_play всё равно потом)
                            try:
                                oracle.history.history.append({
                                    'file': t.get('file',''),
                                    'artist': t.get('artist','Unknown'),
                                    'timestamp': datetime.datetime.now().isoformat(),
                                    'energy': t.get('energy'),
                                    'bpm': t.get('bpm'),
                                    'key': t.get('key'),
                                    'region': t.get('region', 'Global'),
                                })
                            except Exception:
                                pass
                    if batch:
                        # Шаутаут трека — overlay поверх начала. Если у трека
                        # есть pending_overlay (DJ-новости) И есть шаутаут —
                        # приоритет даём pending_overlay (DJ-новости важнее).
                        # Шаутаут идёт только когда других overlay нет.
                        if pending_overlay:
                            play_track(batch[0], overlay_pcm=pending_overlay)
                            pending_overlay = None
                            oracle.record_play(picked_tracks[0])
                            jingle_counter += 1
                            podcast_track_counter = globals().get('podcast_track_counter', 0) + 1
                            globals()['podcast_track_counter'] = podcast_track_counter
                            remaining = batch[1:]
                            picked_remaining = picked_tracks[1:]
                        else:
                            remaining = batch
                            picked_remaining = picked_tracks
                        # Развёртываем цепочку в индивидуальные play_track чтобы
                        # перед каждым проверить shoutout_url из metadata и
                        # передать его как overlay_pcm. play_music_chain теряет
                        # crossfade — компромисс ради корректного дакинга голоса.
                        for i, fp in enumerate(remaining):
                            t = picked_remaining[i]
                            shoutout_pcm = load_shoutout_pcm(fp)
                            play_track(fp, overlay_pcm=shoutout_pcm, duck_vol=0.15)
                            oracle.record_play(t)
                            jingle_counter += 1
                            podcast_track_counter = globals().get('podcast_track_counter', 0) + 1
                            globals()['podcast_track_counter'] = podcast_track_counter
                        continue
                except Exception as e:
                    logger.warning(f"Oracle error: {e}, fallback to shuffle")

            # Fallback: random shuffle
            tracks = get_all_tracks()
            if not tracks:
                current_track = "Waiting for music..."
                time.sleep(5)
                continue
            random.shuffle(tracks)
            track_path = os.path.join(MUSIC_DIR, tracks[0])
            if os.path.exists(track_path):
                # Если есть pending_overlay (DJ-новости) — он. Иначе — шаутаут.
                overlay = pending_overlay if pending_overlay else load_shoutout_pcm(track_path)
                # DJ-вставка ведущего → музыка на 30% (тише на 70%); шаутаут
                # артиста → на 15% (тише на 85%), чтобы голос звучал чётче.
                play_track(track_path, overlay_pcm=overlay, duck_vol=0.30 if pending_overlay else 0.15)
                pending_overlay = None
                jingle_counter += 1

        except Exception as e:
            logger.error(f"Radio thread error: {e}")
            time.sleep(2)

    logger.info("Radio thread stopped")
    cleanup()


# ─── API Endpoints ───

@app.route('/api/status', methods=['GET'])
def api_status():
    oracle_stats = None
    if oracle:
        try:
            oracle_stats = oracle.get_stats()
        except Exception:
            pass
    return jsonify({
        "status": "online",
        "station": "promo.fm",
        "current_track": current_track or "Silence",
        "current_track_info": current_track_info,
        "queue_length": len(playlist_queue),
        "queue": list(playlist_queue)[:5],
        "oracle": oracle_stats,
    })


@app.route('/api/now-playing', methods=['GET'])
def api_now_playing():
    return jsonify({
        "track": current_track or "Silence",
        "info": current_track_info,
    })


@app.route('/api/history', methods=['GET'])
def api_history():
    limit = request.args.get('limit', 20, type=int)
    return jsonify({
        "history": list(reversed(play_history[-limit:])),
    })


@app.route('/api/upload', methods=['POST'])
def api_upload():
    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
    f = request.files['file']
    if f.filename == '':
        return jsonify({"error": "No selected file"}), 400
    if f and f.filename.lower().endswith('.mp3'):
        filename = secure_filename(f.filename)
        filepath = os.path.join(MUSIC_DIR, filename)
        if not os.path.exists(filepath):
            f.save(filepath)
        if filename not in playlist_queue:
            playlist_queue.insert(0, filename)
        return jsonify({"success": True, "message": "Track uploaded and queued"}), 200
    return jsonify({"error": "Only MP3 files"}), 400


@app.route('/api/queue', methods=['GET'])
def api_get_queue():
    return jsonify({"queue": list(playlist_queue)})


@app.route('/api/queue', methods=['POST'])
def api_add_to_queue():
    data = request.json
    if not data or 'filename' not in data:
        return jsonify({"error": "Missing filename"}), 400
    filename = data['filename']
    filepath = os.path.join(MUSIC_DIR, filename)
    if os.path.exists(filepath):
        if filename not in playlist_queue:
            playlist_queue.insert(0, filename)
        return jsonify({"success": True, "message": f"Queued: {filename}"}), 200
    return jsonify({"error": f"File not found: {filename}"}), 404


@app.route('/api/clear_queue', methods=['POST'])
def api_clear_queue():
    global playlist_queue
    count = len(playlist_queue)
    playlist_queue = []
    return jsonify({"success": True, "message": f"Cleared {count} items"}), 200


@app.route('/api/skip', methods=['POST'])
def api_skip():
    global decoder_process
    if decoder_process:
        decoder_process.terminate()
        return jsonify({"success": True, "message": "Track skipped"}), 200
    return jsonify({"error": "No active track"}), 400


@app.route('/api/library', methods=['GET'])
def api_library():
    tracks = get_all_tracks()
    return jsonify({"tracks": tracks, "count": len(tracks)})


@app.route('/api/metadata/scan', methods=['POST'])
def api_metadata_scan():
    """Trigger metadata rescan from Oracle"""
    if oracle:
        oracle.reload_metadata()
        return jsonify({"success": True, "tracks": len(oracle.metadata.get('tracks', []))}), 200
    return jsonify({"error": "Oracle not available"}), 503



@app.route('/api/inject', methods=['POST'])
def api_inject_voice():
    """Inject voice OVER current music with ducking (music 30%%, voice 70%%).
    
    Accepts raw PCM L16 mono 24000Hz (from Gemini TTS proxy).
    Converts to S16LE stereo 44100Hz and sets as live overlay.
    Voice mixes immediately over currently playing track — like real FM radio.
    
    Accepts raw PCM L16 mono 24000Hz (from Gemini TTS proxy).
    Converts to WAV (stereo 44.1kHz), queues for immediate playback.
    Music pauses, voice plays, music resumes (like real FM radio breaks).
    """
    global live_voice_buffer, live_voice_offset, live_post_inject_bytes

    key = request.headers.get('X-Internal-Key', '')
    expected = os.environ.get('VPS_INTERNAL_KEY', '')
    if expected and key != expected:
        return jsonify({"error": "Unauthorized"}), 401

    pcm_data = request.get_data()
    if not pcm_data or len(pcm_data) < 1000:
        return jsonify({"error": "No PCM data or too short"}), 400

    # ANTI-OVERLAP: если предыдущий voice ещё играет — отказ.
    # Защищает от одновременного вещания podcast-live, radio_announcer и voice-bot.
    if live_voice_buffer is not None:
        remaining_bytes = max(0, len(live_voice_buffer) - live_voice_offset)
        remaining_sec = remaining_bytes / (44100 * 2 * 2)
        # пост-инжект gap тоже должен пройти
        post_gap_sec = max(0, live_post_inject_bytes) / (44100 * 2 * 2)
        retry_after_ms = int((remaining_sec + post_gap_sec + 1.0) * 1000)
        logger.warning(f"[inject] BUSY: previous voice still playing ({remaining_sec:.1f}s left). Reject.")
        return jsonify({
            "error": "voice_busy",
            "remaining_sec": round(remaining_sec, 1),
            "retry_after_ms": retry_after_ms,
        }), 423

    try:
        # Convert: PCM L16 mono 24000Hz -> S16LE stereo 44100Hz
        cmd = [
            "ffmpeg", "-y",
            "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
            "-ar", "44100", "-ac", "2", "-f", "s16le", "pipe:1"
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        converted, _ = proc.communicate(input=pcm_data, timeout=30)
        
        if not converted or len(converted) < 1000:
            return jsonify({"error": "Conversion failed"}), 500

        output_duration = len(converted) / (44100 * 2 * 2)  # stereo 16-bit
        
        # Set as live overlay — play_track's write loop picks it up immediately
        # Music ducks to 30%, voice at 70% — like real FM radio
        live_voice_buffer = converted
        live_voice_offset = 0
        
        logger.info(f"[inject] Live voice overlay: {len(pcm_data)} -> {len(converted)} bytes ({output_duration:.1f}s), mixing over music now")
        
        return jsonify({
            "ok": True,
            "input_bytes": len(pcm_data),
            "output_bytes": len(converted),
            "duration": round(output_duration, 1),
            "mode": "live-overlay",
            "ducking": "music 30% / voice 70%"
        })
        
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Conversion timeout"}), 500
    except Exception as e:
        logger.error(f"[inject] Error: {e}")
        return jsonify({"error": str(e)}), 500



@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Internal-Key')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    return response


if __name__ == "__main__":
    logger.info("Starting promo.fm AutoDJ")
    logger.info(f"Music: {MUSIC_DIR}")
    logger.info(f"Stream: {STREAM_URL}")
    logger.info(f"API port: {API_PORT}")

    radio_t = threading.Thread(target=radio_thread, daemon=True)
    radio_t.start()
    app.run(host='127.0.0.1', port=API_PORT)  # 2026-08-05 аудит: было 0.0.0.0, API управления эфиром (queue/skip/inject) торчал наружу, защищал только ufw
