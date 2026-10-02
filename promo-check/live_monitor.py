"""
PROMO.CHECK Live — непрерывное прослушивание станций и подсчёт НАСТОЯЩИХ эфиров
по водяному знаку (02.10.2026).

Зачем. Старый monitor.py берёт 30 с с каждой станции раз в ~6 мин (≈8 % эфира),
пишет «моменты», а не проигрывания, и в основном по отпечатку (Chromaprint), где
много ложных срабатываний. Владелец: «считать через watermark каждый раз ротации…
не фейк, а настоящие ротации».

Что делает этот сервис (старый monitor.py не трогает):
  - слушает каждую активную станцию из promo_check_monitoring НЕПРЕРЫВНО: ffmpeg режет
    поток на SEGMENT_SECONDS-секундные WAV-куски в оперативной памяти (/dev/shm),
    каждая секунда эфира проверяется;
  - в каждом куске ищет НАШ водяной знак (`audiowmark get`). Засчитываются только
    watermark_id, которые мы сами встроили в треки и миксы (promo_check_all_fingerprints).
    Отпечатки не используются вовсе — ложных эфиров быть не может;
  - склеивает находки в проигрывания: тот же трек на той же станции с паузой между
    находками ≤ PLAY_GAP_SECONDS — одно проигрывание (одна ротация);
  - пишет проигрывания в promo_check_plays, состояние станций — в promo_check_live_status;
  - на каждое проигрывание сохраняет кусок эфира (MP3 64k моно) как внутреннее
    доказательство, хранит EVIDENCE_DAYS дней.

Проверка 02.10.2026: водяной знак трека после эфирной цепочки (loudnorm + компрессор +
MP3 128k) находится в 7 из 7 случайных 30-с кусков (и в 7 из 7 15-с). Трек 3–4 мин даёт
6–8 находок за проигрывание. Порог SCORE_MIN тот же, что у monitor.py
(get_watermark_matches): так найдены все 36 подтверждений на Soul FM.

Нагрузка: `audiowmark get` ≈ 1,7 с на 30 с эфира (≈11 % ядра на станцию). Декодер один,
юнит работает с Nice=19 и CPUQuota: если не успевает, старые куски отбрасываются
(segments_skipped в статусе), сайт не страдает.
"""
import os
import re
import sys
import time
import shutil
import signal
import logging
import threading
import subprocess
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from db import get_conn  # noqa: E402  — тот же DSN (env DB_DSN или promo-check/.env)

SEG_DIR = os.environ.get("LIVE_SEG_DIR", "/dev/shm/promo-check-live")
EVIDENCE_DIR = os.environ.get("LIVE_EVIDENCE_DIR", "/var/lib/promo-check-live/evidence")
SEGMENT_SECONDS = int(os.environ.get("LIVE_SEGMENT_SECONDS", "30"))
PLAY_GAP_SECONDS = int(os.environ.get("LIVE_PLAY_GAP_SECONDS", "240"))
SCORE_MIN = float(os.environ.get("LIVE_SCORE_MIN", "0.5"))
MAX_BACKLOG = int(os.environ.get("LIVE_MAX_BACKLOG", "4"))
EVIDENCE_DAYS = int(os.environ.get("LIVE_EVIDENCE_DAYS", "90"))
STALL_SECONDS = int(os.environ.get("LIVE_STALL_SECONDS", "150"))
STATIONS_RELOAD = 300
WATERMARKS_RELOAD = 600
CLEANUP_EVERY = 3600

AUDIOWMARK = shutil.which("audiowmark") or "/usr/local/bin/audiowmark"
FFMPEG = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
SEG_RE = re.compile(r"^(\d{8}T\d{6})\.wav$")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [live] %(levelname)s %(message)s")
log = logging.getLogger("promo-check-live")
STOP = threading.Event()


# ── База ────────────────────────────────────────────────────────────────────

def db_query(sql, params=(), fetch=True):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall() if fetch else None
        conn.commit()
    return rows


def load_stations():
    return db_query("""
        SELECT station_id::text AS station_id, station_name, stream_url
          FROM promo_check_monitoring
         WHERE active = true AND COALESCE(stream_url, '') <> ''
         ORDER BY station_name
    """)


def load_watermarks():
    """watermark_id → (content_type, content_id). Только то, что мы сами встроили."""
    rows = db_query("""
        SELECT content_type, content_id::text AS content_id, watermark_id
          FROM promo_check_all_fingerprints
         WHERE status = 'done' AND COALESCE(watermark_id, '') <> ''
    """)
    return {r["watermark_id"].lower(): (r["content_type"] or "track", r["content_id"]) for r in rows}


def set_status(station, **fields):
    cols = ["station_name"] + list(fields.keys())
    vals = [station["station_name"]] + list(fields.values())
    sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    try:
        db_query(
            f"""INSERT INTO promo_check_live_status (station_id, {', '.join(cols)}, updated_at)
                VALUES (%s, {', '.join(['%s'] * len(cols))}, NOW())
                ON CONFLICT (station_id) DO UPDATE SET {sets}, updated_at = NOW()""",
            [station["station_id"]] + vals, fetch=False)
    except Exception as e:  # статус — не критичен для подсчёта
        log.warning(f"status update failed for {station['station_name']}: {e}")


def bump_status(station_id, ok=0, skipped=0, hits=0, last_segment_at=None):
    try:
        db_query("""
            UPDATE promo_check_live_status
               SET segments_ok = segments_ok + %s, segments_skipped = segments_skipped + %s,
                   hits_total = hits_total + %s,
                   last_segment_at = COALESCE(%s, last_segment_at), updated_at = NOW()
             WHERE station_id = %s
        """, (ok, skipped, hits, last_segment_at, station_id), fetch=False)
    except Exception as e:
        log.warning(f"status bump failed: {e}")


# ── Захват потока ───────────────────────────────────────────────────────────

class Capture(threading.Thread):
    """Один ffmpeg на станцию: поток → WAV-куски по SEGMENT_SECONDS с отметкой времени в имени."""

    def __init__(self, station):
        super().__init__(daemon=True, name=f"cap-{station['station_name']}")
        self.station = station
        self.dir = os.path.join(SEG_DIR, station["station_id"])
        self.halt = threading.Event()
        self.proc = None

    def stop(self):
        self.halt.set()
        self.kill()

    def kill(self):
        p = self.proc
        if p and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=10)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    def run(self):
        os.makedirs(self.dir, exist_ok=True)
        backoff = 10
        while not self.halt.is_set() and not STOP.is_set():
            url = self.station["stream_url"]
            cmd = [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error"]
            if url.startswith("http"):
                cmd += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1",
                        "-reconnect_delay_max", "30", "-rw_timeout", "30000000"]
            cmd += ["-i", url, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le",
                    "-f", "segment", "-segment_time", str(SEGMENT_SECONDS), "-reset_timestamps", "1",
                    "-strftime", "1", os.path.join(self.dir, "%Y%m%dT%H%M%S.wav")]
            started = time.time()
            set_status(self.station, capture_state="running", last_error=None)
            log.info(f"capture start: {self.station['station_name']}")
            try:
                self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                _, err = self.proc.communicate()
                msg = (err or b"").decode("utf-8", "replace").strip()[-400:]
            except Exception as e:
                msg = str(e)
            if self.halt.is_set() or STOP.is_set():
                break
            ran = time.time() - started
            backoff = 10 if ran > 300 else min(backoff * 2, 300)
            log.warning(f"capture exit: {self.station['station_name']} after {ran:.0f}s, retry in {backoff}s: {msg}")
            set_status(self.station, capture_state="restarting", last_error=(msg or "ffmpeg exited")[:500])
            self.halt.wait(backoff)
        log.info(f"capture stopped: {self.station['station_name']}")


# ── Разбор кусков ───────────────────────────────────────────────────────────

def segment_time(name):
    m = SEG_RE.match(name)
    if not m:
        return None
    # ffmpeg -strftime пишет локальное время сервера → aware-время
    return datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").astimezone()


def ready_segments(dirpath):
    """Готовые куски (самый свежий ffmpeg ещё пишет), по возрастанию времени."""
    try:
        names = sorted(n for n in os.listdir(dirpath) if SEG_RE.match(n))
    except FileNotFoundError:
        return []
    if not names:
        return []
    ready = names[:-1]
    newest = os.path.join(dirpath, names[-1])
    try:  # поток оборвался — последний кусок больше не пишется
        if time.time() - os.path.getmtime(newest) > SEGMENT_SECONDS + 20:
            ready = names
    except FileNotFoundError:
        pass
    return [os.path.join(dirpath, n) for n in ready]


def decode(path, known):
    """→ {(content_type, content_id): best_score} для наших водяных знаков в куске."""
    res = subprocess.run([AUDIOWMARK, "get", path], capture_output=True, text=True, timeout=120)
    found = {}
    for line in res.stdout.splitlines():
        p = line.strip().split()
        if len(p) >= 4 and p[0] == "pattern":
            wid = p[2].lower()
            try:
                score = float(p[3])
            except ValueError:
                continue
            if score >= SCORE_MIN and wid in known:
                key = known[wid]
                found[key] = max(score, found.get(key, 0.0))
    return found


def save_evidence(play_id, seg_path):
    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    out = os.path.join(EVIDENCE_DIR, f"{play_id}.mp3")
    r = subprocess.run([FFMPEG, "-nostdin", "-loglevel", "error", "-y", "-i", seg_path,
                        "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", out],
                       capture_output=True, timeout=60)
    return out if r.returncode == 0 and os.path.exists(out) else None


def record_hit(station, ctype, cid, score, seg_start, seg_path):
    """Находка → новое проигрывание или продолжение текущего. Возвращает True, если проигрывание новое."""
    seg_end = seg_start + timedelta(seconds=SEGMENT_SECONDS)
    is_track = ctype != "mix"
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(f"""
                SELECT id FROM promo_check_plays
                 WHERE station_id = %s AND content_type = %s
                   AND {'track_id = %s::uuid' if is_track else 'mix_id = %s'}
                   AND last_heard_at >= %s
                 ORDER BY last_heard_at DESC LIMIT 1
            """, (station["station_id"], ctype, cid, seg_start - timedelta(seconds=PLAY_GAP_SECONDS)))
            row = cur.fetchone()
            if row:
                cur.execute("""
                    UPDATE promo_check_plays
                       SET last_heard_at = GREATEST(last_heard_at, %s), hits = hits + 1,
                           max_score = GREATEST(COALESCE(max_score, 0), %s)
                     WHERE id = %s
                """, (seg_end, score, row["id"]))
                conn.commit()
                return False
            cur.execute("""
                INSERT INTO promo_check_plays
                  (content_type, track_id, mix_id, station_id, station_name, started_at, last_heard_at, hits, max_score, method)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 1, %s, 'watermark')
                RETURNING id::text AS id
            """, (ctype, cid if is_track else None, None if is_track else cid,
                  station["station_id"], station["station_name"], seg_start, seg_end, score))
            play_id = cur.fetchone()["id"]
        conn.commit()
    ev = save_evidence(play_id, seg_path)
    if ev:
        db_query("UPDATE promo_check_plays SET evidence_path = %s WHERE id = %s", (ev, play_id), fetch=False)
    log.info(f"PLAY: {ctype} {cid[:8]} on {station['station_name']} at {seg_start:%Y-%m-%d %H:%M:%S} score={score:.2f}")
    return True


def cleanup_evidence():
    cutoff = time.time() - EVIDENCE_DAYS * 86400
    removed = 0
    try:
        for n in os.listdir(EVIDENCE_DIR):
            p = os.path.join(EVIDENCE_DIR, n)
            if os.path.getmtime(p) < cutoff:
                os.unlink(p)
                removed += 1
    except FileNotFoundError:
        return
    if removed:
        db_query("""UPDATE promo_check_plays SET evidence_path = NULL
                     WHERE evidence_path IS NOT NULL AND started_at < NOW() - (%s || ' days')::interval""",
                 (str(EVIDENCE_DAYS),), fetch=False)
        log.info(f"evidence cleanup: removed {removed} files")


# ── Главный цикл ────────────────────────────────────────────────────────────

def main():
    os.makedirs(SEG_DIR, exist_ok=True)
    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    captures = {}
    stations = {}
    known = {}
    t_st = t_wm = t_clean = 0.0

    def handle_term(*_):
        STOP.set()
    signal.signal(signal.SIGTERM, handle_term)
    signal.signal(signal.SIGINT, handle_term)

    log.info(f"start: segment={SEGMENT_SECONDS}s gap={PLAY_GAP_SECONDS}s score_min={SCORE_MIN} backlog={MAX_BACKLOG}")
    while not STOP.is_set():
        now = time.time()
        try:
            if now - t_wm > WATERMARKS_RELOAD:
                known = load_watermarks()
                t_wm = now
                log.info(f"watermarks loaded: {len(known)}")
            if now - t_st > STATIONS_RELOAD:
                fresh = {s["station_id"]: s for s in load_stations()}
                for sid in list(captures):
                    if sid not in fresh or fresh[sid]["stream_url"] != stations[sid]["stream_url"]:
                        captures.pop(sid).stop()
                        shutil.rmtree(os.path.join(SEG_DIR, sid), ignore_errors=True)
                        if sid not in fresh:
                            set_status(stations[sid], capture_state="stopped")
                for sid, st in fresh.items():
                    if sid not in captures:
                        cap = Capture(st)
                        captures[sid] = cap
                        cap.start()
                stations = fresh
                t_st = now
            if now - t_clean > CLEANUP_EVERY:
                cleanup_evidence()
                t_clean = now
        except Exception as e:
            log.error(f"reload failed: {e}")
            time.sleep(30)
            continue

        worked = False
        for sid, st in list(stations.items()):
            segs = ready_segments(os.path.join(SEG_DIR, sid))
            # Зависший поток: ffmpeg жив, но кусков давно нет → перезапуск
            cap = captures.get(sid)
            d = os.path.join(SEG_DIR, sid)
            try:
                files = [os.path.join(d, n) for n in os.listdir(d) if SEG_RE.match(n)]
                newest = max((os.path.getmtime(f) for f in files), default=None)
            except FileNotFoundError:
                newest = None
            if cap and cap.proc and cap.proc.poll() is None and newest and now - newest > STALL_SECONDS:
                log.warning(f"stall: {st['station_name']}, restarting ffmpeg")
                cap.kill()
            if len(segs) > MAX_BACKLOG:  # декодер не успевает — старое выкидываем, сайт важнее
                drop = segs[:-MAX_BACKLOG]
                for p in drop:
                    try:
                        os.unlink(p)
                    except FileNotFoundError:
                        pass
                bump_status(sid, skipped=len(drop))
                segs = segs[-MAX_BACKLOG:]
            if not segs:
                continue
            path = segs[0]  # по одному куску со станции за проход — честная очередь
            worked = True
            seg_start = segment_time(os.path.basename(path))
            hits = 0
            try:
                if os.path.getsize(path) > 100_000 and seg_start:
                    for (ctype, cid), score in decode(path, known).items():
                        record_hit(st, ctype, cid, score, seg_start, path)
                        hits += 1
                bump_status(sid, ok=1, hits=hits, last_segment_at=seg_start)
            except subprocess.TimeoutExpired:
                log.warning(f"audiowmark timeout on {st['station_name']}")
                bump_status(sid, skipped=1)
            except Exception as e:
                log.error(f"segment failed on {st['station_name']}: {e}")
                bump_status(sid, skipped=1)
            finally:
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass
        if not worked:
            STOP.wait(2)

    log.info("stopping captures")
    for cap in captures.values():
        cap.stop()


if __name__ == "__main__":
    main()
