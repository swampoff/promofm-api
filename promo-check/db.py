"""
Promo.check — Database layer
"""
import os
import psycopg2
import psycopg2.extras

def _load_db_dsn():
    """DSN из env (systemd EnvironmentFile / shell) или из соседнего .env
    (gitignored) — секрет НЕ в коде и истории git. См. promo-check/README.md."""
    dsn = os.environ.get("DB_DSN")
    if dsn:
        return dsn
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line.startswith("DB_DSN="):
                return line.split("=", 1)[1].strip().strip(chr(34)).strip(chr(39))
    raise RuntimeError("DB_DSN not set — задайте env DB_DSN или создайте promo-check/.env (README.md)")


DB_DSN = _load_db_dsn()


def get_conn():
    return psycopg2.connect(DB_DSN)


def get_monitoring_stations():
    """Return all active stations with stream URLs."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT m.id, m.station_id, m.station_name, m.stream_url,
                       m.last_scanned_at, m.error_count
                FROM promo_check_monitoring m
                WHERE m.active = true AND m.stream_url IS NOT NULL
                ORDER BY m.last_scanned_at ASC NULLS FIRST
            """)
            return cur.fetchall()


def get_all_fingerprints():
    """Load all fingerprints from DB for matching."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT track_id, fingerprint, watermark_id, duration
                FROM promo_check_fingerprints
                WHERE status = 'done'
            """)
            return cur.fetchall()


def insert_detection(track_id, station_id, station_name, confidence,
                     detection_method, watermark_confirmed):
    """Log a radio play detection."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO promo_check_detections
                  (track_id, station_id, station_name, confidence,
                   detection_method, watermark_confirmed)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (track_id, station_id, station_name, confidence,
                  detection_method, watermark_confirmed))
        conn.commit()


def update_station_scanned(monitoring_id, error=None):
    """Update last_scanned_at and error info."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            if error:
                cur.execute("""
                    UPDATE promo_check_monitoring
                    SET last_scanned_at = NOW(),
                        error_count = error_count + 1,
                        last_error = %s
                    WHERE id = %s
                """, (str(error)[:500], monitoring_id))
            else:
                cur.execute("""
                    UPDATE promo_check_monitoring
                    SET last_scanned_at = NOW(),
                        last_error = NULL
                    WHERE id = %s
                """, (monitoring_id,))
        conn.commit()


def save_fingerprint(track_id, fingerprint, watermark_id, duration, watermarked=False):
    """Save fingerprint + watermark_id for a track. watermarked=True records that an
    audiowmark watermark was actually embedded into the audio (sets watermarked_at)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO promo_check_fingerprints
                  (track_id, fingerprint, watermark_id, duration, status, watermarked_at)
                VALUES (%s, %s, %s, %s, 'done', CASE WHEN %s THEN NOW() ELSE NULL END)
                ON CONFLICT (track_id) DO UPDATE
                  SET fingerprint = EXCLUDED.fingerprint,
                      watermark_id = EXCLUDED.watermark_id,
                      duration = EXCLUDED.duration,
                      status = 'done',
                      fingerprinted_at = NOW(),
                      watermarked_at = CASE WHEN %s THEN NOW() ELSE promo_check_fingerprints.watermarked_at END
            """, (track_id, fingerprint, watermark_id, duration, watermarked, watermarked))
        conn.commit()


def get_track_audio_url(track_id):
    """Get audio_url for a track."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT audio_url FROM tracks WHERE id = %s", (track_id,))
            row = cur.fetchone()
            return row[0] if row else None


# ── DJ-mix promo.check helpers — ДОПИСАТЬ в конец /opt/promofm-promo-check/db.py ──
# Чисто аддитивно: зеркала save_fingerprint / get_track_audio_url / insert_detection,
# цель — dj_mix_fingerprints / dj_mix_detections (миграция 132). Существующие функции
# не трогаются, риск для трекового пути = 0.


def save_mix_fingerprint(mix_id, fingerprint, watermark_id, duration, watermarked=False):
    """Зеркало save_fingerprint для DJ-миксов -> dj_mix_fingerprints."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO dj_mix_fingerprints
                  (mix_id, fingerprint, watermark_id, duration, status, watermarked_at)
                VALUES (%s, %s, %s, %s, 'done', CASE WHEN %s THEN NOW() ELSE NULL END)
                ON CONFLICT (mix_id) DO UPDATE
                  SET fingerprint = EXCLUDED.fingerprint,
                      watermark_id = EXCLUDED.watermark_id,
                      duration = EXCLUDED.duration,
                      status = 'done',
                      fingerprinted_at = NOW(),
                      watermarked_at = CASE WHEN %s THEN NOW()
                                            ELSE dj_mix_fingerprints.watermarked_at END
            """, (mix_id, fingerprint, watermark_id, duration, watermarked, watermarked))
        conn.commit()


def get_mix_audio_url(mix_id):
    """audio_url для DJ-микса."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT audio_url FROM dj_mixes WHERE id = %s", (mix_id,))
            row = cur.fetchone()
            return row[0] if row else None


def insert_mix_detection(mix_id, station_id, station_name, confidence,
                         detection_method, watermark_confirmed, dedup_window_seconds=0):
    """Зеркало insert_detection для DJ-миксов -> dj_mix_detections.
    dedup_window_seconds>0: пропустить, если тот же (mix_id, station_name) уже
    детектился в окне — часовой микс в эфире = один факт, не 20 строк (контракт §6-тер п.3)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            if dedup_window_seconds and dedup_window_seconds > 0:
                cur.execute("""
                    INSERT INTO dj_mix_detections
                      (mix_id, station_id, station_name, confidence,
                       detection_method, watermark_confirmed)
                    SELECT %s, %s, %s, %s, %s, %s
                    WHERE NOT EXISTS (
                        SELECT 1 FROM dj_mix_detections
                        WHERE mix_id = %s AND station_name = %s
                          AND detected_at > now() - make_interval(secs => %s)
                    )
                """, (mix_id, station_id, station_name, confidence,
                      detection_method, watermark_confirmed,
                      mix_id, station_name, int(dedup_window_seconds)))
            else:
                cur.execute("""
                    INSERT INTO dj_mix_detections
                      (mix_id, station_id, station_name, confidence,
                       detection_method, watermark_confirmed)
                    VALUES (%s, %s, %s, %s, %s, %s)
                """, (mix_id, station_id, station_name, confidence,
                      detection_method, watermark_confirmed))
        conn.commit()


def get_all_fingerprints_unified():
    """Треки + миксы для матчинга, каждая строка помечена content_type/content_id.
    Через VIEW promo_check_all_fingerprints (миграция 132). Заменяет get_all_fingerprints()
    в monitor.py на детект-стороне (см. monitor.py.detection-delta.md — это уже п.4-гейт)."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT content_type, content_id, fingerprint, watermark_id, duration
                FROM promo_check_all_fingerprints
                WHERE status = 'done'
            """)
            return cur.fetchall()
