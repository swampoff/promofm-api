/**
 * Promo.check Routes — Radio airplay monitoring API
 * /server/api/promo-check/*
 */

import { Hono } from "hono";
import { spawn } from "child_process";
import { pool } from "./db-client.tsx";
import { requireAuth, requireOwner, requireRole } from "./auth-middleware.tsx";
import { getRadioProfile } from "./db.tsx";
import { isAdminEmail } from "./roles.tsx";

const app = new Hono();

// ─── Helper: raw pool.query wrapper ───────────────────────────────────────────

async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<{ rows: T[] }> {
  return pool.query(sql, params) as Promise<{ rows: T[] }>;
}

// ─── Stats for a single track ─────────────────────────────────────────────────

app.get("/stats/:trackId", requireAuth, async (c) => {
  const { trackId } = c.req.param();
  const days = Number(c.req.query("days") || "30");

  const [totals, byStation, timeline, fingerprinted] = await Promise.all([
    query<{ total: string; confirmed: string }>(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE watermark_confirmed = true) as confirmed
       FROM promo_check_detections
       WHERE track_id = $1 AND detected_at >= NOW() - INTERVAL '1 day' * ${Math.max(1, Math.min(Number(days) || 30, 365))}`,
      [trackId]
    ),
    query<{ station_name: string; count: string; last_detected: string }>(
      `SELECT station_name,
              COUNT(*) as count,
              MAX(detected_at) as last_detected
       FROM promo_check_detections
       WHERE track_id = $1 AND detected_at >= NOW() - INTERVAL '1 day' * ${Math.max(1, Math.min(Number(days) || 30, 365))}
       GROUP BY station_name
       ORDER BY count DESC`,
      [trackId]
    ),
    query<{ day: string; count: string }>(
      `SELECT DATE(detected_at) as day, COUNT(*) as count
       FROM promo_check_detections
       WHERE track_id = $1 AND detected_at >= NOW() - INTERVAL '1 day' * ${Math.max(1, Math.min(Number(days) || 30, 365))}
       GROUP BY DATE(detected_at)
       ORDER BY day ASC`,
      [trackId]
    ),
    query<{ fingerprinted_at: string; status: string }>(
      `SELECT fingerprinted_at, status FROM promo_check_fingerprints WHERE track_id = $1`,
      [trackId]
    ),
  ]);

  const total = totals.rows[0];
  return c.json({
    trackId,
    period_days: days,
    total_rotations: parseInt(total?.total || "0"),
    confirmed_rotations: parseInt(total?.confirmed || "0"),
    by_station: byStation.rows,
    timeline: timeline.rows,
    monitoring_active: fingerprinted.rows.length > 0,
    fingerprinted_at: fingerprinted.rows[0]?.fingerprinted_at || null,
  });
});

// ─── All tracks for an artist ─────────────────────────────────────────────────

app.get("/artist/:artistId", requireAuth, requireOwner("artistId"), async (c) => {
  const { artistId } = c.req.param();
  const days = Number(c.req.query("days") || "30");

  const result = await query<{
    track_id: string; title: string;
    total: string; confirmed: string; last_detected: string;
  }>(
    `SELECT t.id as track_id, t.title,
            COUNT(d.id) as total,
            COUNT(d.id) FILTER (WHERE d.watermark_confirmed = true) as confirmed,
            MAX(d.detected_at) as last_detected
     FROM tracks t
     LEFT JOIN promo_check_detections d
       ON d.track_id = t.id
       AND d.detected_at >= NOW() - INTERVAL '1 day' * ${Math.max(1, Math.min(Number(days) || 30, 365))}
     -- Audit 2026-06-04: caller passes userId (text), so filter tracks.user_id,
     -- not tracks.artist_id (uuid) → was 0 rows → empty Promo.check feed.
     WHERE t.user_id = $1
     GROUP BY t.id, t.title
     ORDER BY total DESC, t.created_at DESC
     LIMIT 50`,
    [artistId]
  );

  return c.json({
    artistId,
    period_days: days,
    tracks: result.rows.map((r) => ({
      track_id: r.track_id,
      title: r.title,
      total_rotations: parseInt(r.total || "0"),
      confirmed_rotations: parseInt(r.confirmed || "0"),
      last_detected: r.last_detected || null,
    })),
  });
});

// ─── Recent detections feed ───────────────────────────────────────────────────

app.get("/detections", requireAuth, async (c) => {
  const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
  const trackId = c.req.query("track_id");
  const artistId = c.req.query("artist_id");

  let sql = `
    SELECT d.id, d.track_id, t.title, t.artist_name,
           d.station_name, d.confidence, d.detection_method,
           d.watermark_confirmed, d.detected_at
    FROM promo_check_detections d
    JOIN tracks t ON t.id = d.track_id
  `;
  const params: string[] = [];

  // IDOR fix 2026-07-06: airplay feed must be scoped to the caller. Client-supplied
  // artist_id is ignored for non-admins; track_id is checked for ownership.
  const userId = c.get("userId") as string;
  const isAdmin =
    (c.get("userRole") === "admin" || c.get("userRole") === "superadmin") &&
    isAdminEmail(c.get("userEmail"));

  if (trackId) {
    sql += ` WHERE d.track_id = $${params.length + 1}`;
    params.push(trackId);
    if (!isAdmin) {
      // Only expose detections for a track the caller owns.
      sql += ` AND t.user_id = $${params.length + 1}`;
      params.push(userId);
    }
  } else {
    // Own feed by default; admins may inspect any artist via artist_id.
    const targetUserId = isAdmin && artistId ? artistId : userId;
    sql += ` WHERE t.user_id = $${params.length + 1}`;
    params.push(targetUserId);
  }

  sql += ` ORDER BY d.detected_at DESC LIMIT ${limit}`;

  const result = await query(sql, params);
  return c.json({ detections: result.rows });
});

// ─── Station monitoring status ────────────────────────────────────────────────

app.get("/stations", requireAuth, async (c) => {
  const result = await query(
    `SELECT m.station_name, m.stream_url, m.active,
            m.last_scanned_at, m.error_count, m.last_error,
            COUNT(d.id) as detections_today
     FROM promo_check_monitoring m
     LEFT JOIN promo_check_detections d
       ON d.station_name = m.station_name
       AND d.detected_at >= NOW() - INTERVAL '24 hours'
     GROUP BY m.id, m.station_name, m.stream_url, m.active,
              m.last_scanned_at, m.error_count, m.last_error
     ORDER BY m.station_name`
  );
  return c.json({
    stations: result.rows,
    monitoring_active: result.rows.some((r) => r.active),
  });
});

// ─── Trigger fingerprinting for a track ───────────────────────────────────────

app.post("/process/:trackId", requireAuth, async (c) => {
  const { trackId } = c.req.param();

  const track = await query<{ audio_url: string }>(
    "SELECT audio_url FROM tracks WHERE id = $1",
    [trackId]
  );
  if (!track.rows[0]) {
    return c.json({ error: "Track not found" }, 404);
  }
  if (!track.rows[0].audio_url) {
    return c.json({ error: "Track has no audio file" }, 422);
  }

  // Mark as pending
  await query(
    `INSERT INTO promo_check_fingerprints (track_id, fingerprint, watermark_id, duration, status)
     VALUES ($1, '{}', gen_random_uuid()::text, 0, 'pending')
     ON CONFLICT (track_id) DO UPDATE SET status = 'pending'`,
    [trackId]
  );

  // Spawn Python fingerprinter in background (non-blocking)
  const child = spawn(
    "python3",
    ["/opt/promofm-promo-check/fingerprinter.py", "--track-id", trackId],
    { detached: true, stdio: "ignore", env: { ...process.env } }
  );
  child.unref();

  return c.json({
    status: "processing",
    message: "Трек поставлен в очередь мониторинга Promo.check",
    track_id: trackId,
  });
});

// ─── Dashboard summary ────────────────────────────────────────────────────────

app.get("/dashboard", requireAuth, async (c) => {
  const [totals, topTracks, topStations] = await Promise.all([
    query<{ total: string; confirmed: string; tracks_monitored: string }>(
      `SELECT
         (SELECT COUNT(*) FROM promo_check_detections
          WHERE detected_at >= NOW() - INTERVAL '30 days') as total,
         (SELECT COUNT(*) FROM promo_check_detections
          WHERE watermark_confirmed = true
          AND detected_at >= NOW() - INTERVAL '30 days') as confirmed,
         (SELECT COUNT(*) FROM promo_check_fingerprints WHERE status = 'done') as tracks_monitored`
    ),
    query(
      `SELECT t.title, t.artist_name, COUNT(d.id) as rotations
       FROM promo_check_detections d
       JOIN tracks t ON t.id = d.track_id
       WHERE d.detected_at >= NOW() - INTERVAL '30 days'
       GROUP BY t.id, t.title, t.artist_name
       ORDER BY rotations DESC LIMIT 5`
    ),
    query(
      `SELECT station_name, COUNT(*) as detections
       FROM promo_check_detections
       WHERE detected_at >= NOW() - INTERVAL '30 days'
       GROUP BY station_name ORDER BY detections DESC LIMIT 5`
    ),
  ]);

  const summary = totals.rows[0];
  return c.json({
    period: "30 days",
    total_rotations: parseInt(summary?.total || "0"),
    confirmed_rotations: parseInt(summary?.confirmed || "0"),
    tracks_monitored: parseInt(summary?.tracks_monitored || "0"),
    top_tracks: topTracks.rows,
    top_stations: topStations.rows,
  });
});

// ─── Radio cabinet: airplay reports ──────────────────────────────────────────
//
// GET /promo-check/radio/airplay?days=30 — отчёт по эфирам для самой
// радиостанции. Match станции по совпадению имени: radio_profiles.station_name
// (текущий userId) ↔ promo_check_monitoring.station_name (text, UNIQUE index
// от 010_promo_check_monitoring_seed.sql).
//
// Состояния ответа:
//   - radio_profile отсутствует → 404
//   - profile есть, но stationName пустой → monitoring.status = 'not_configured'
//   - stationName есть, но НЕТ записи в promo_check_monitoring →
//     monitoring.status = 'not_connected', тотлы и списки пустые. На фронте —
//     onboarding с CTA на поддержку.
//   - запись в monitoring есть → monitoring.status = 'active' (или 'paused'
//     если active=false), плюс реальные totals/by_track/timeline.
//
// Период: ?days= 1-365, дефолт 30.
//
// PROMO.FM-аудит 2026-06-05: до этого endpoint'а у радио НЕ БЫЛО способа
// увидеть свой PROMO.CHECK-отчёт в кабинете. Сама system-движок (watermark
// при upload артистом + Python listener на VPS + INSERT в
// promo_check_detections) работала, но визуальная панель для радио — нет.
// LP /radio-stations был помечен «Кабинет с отчётами по эфирам — в ближайшем
// релизе»; этот endpoint и frontend-секция к нему этот «релиз» закрывают.
app.get("/radio/airplay", requireAuth, requireRole('radio_station'), async (c) => {
  const userId = (c as any).get('userId') as string;
  if (!userId) {
    return c.json({ error: 'UNAUTHORIZED_NO_USER_ID' }, 401);
  }
  const days = Math.max(1, Math.min(Number(c.req.query("days") || "30"), 365));

  const radio = await getRadioProfile(userId);
  if (!radio) {
    return c.json({ error: 'Radio profile not found' }, 404);
  }
  const stationName = (radio as any).stationName || '';
  if (!stationName) {
    return c.json({
      monitoring: { status: 'not_configured', stationName: '' },
      totals: null,
      by_track: [],
      timeline: [],
      period_days: days,
    });
  }

  const monRes = await query<{
    station_name: string; stream_url: string | null; active: boolean;
    last_scanned_at: string | null; error_count: number; last_error: string | null;
  }>(
    `SELECT station_name, stream_url, active, last_scanned_at, error_count, last_error
     FROM promo_check_monitoring WHERE station_name = $1 LIMIT 1`,
    [stationName],
  );
  if (monRes.rows.length === 0) {
    return c.json({
      monitoring: { status: 'not_connected', stationName },
      totals: null,
      by_track: [],
      timeline: [],
      period_days: days,
    });
  }
  const mon = monRes.rows[0];

  const [totals, byTrack, timeline] = await Promise.all([
    query<{ total: string; confirmed: string; unique_tracks: string }>(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE watermark_confirmed = true) as confirmed,
              COUNT(DISTINCT track_id) as unique_tracks
       FROM promo_check_detections
       WHERE station_name = $1 AND detected_at >= NOW() - INTERVAL '1 day' * ${days}`,
      [stationName],
    ),
    query<{
      track_id: string; title: string | null; artist_name: string | null;
      rotations: string; confirmed: string; last_detected: string | null;
    }>(
      `SELECT t.id::text as track_id, t.title, t.artist_name,
              COUNT(d.id) as rotations,
              COUNT(d.id) FILTER (WHERE d.watermark_confirmed = true) as confirmed,
              MAX(d.detected_at) as last_detected
       FROM promo_check_detections d
       LEFT JOIN tracks t ON t.id = d.track_id
       WHERE d.station_name = $1 AND d.detected_at >= NOW() - INTERVAL '1 day' * ${days}
       GROUP BY t.id, t.title, t.artist_name
       ORDER BY rotations DESC, last_detected DESC
       LIMIT 50`,
      [stationName],
    ),
    query<{ day: string; count: string }>(
      `SELECT DATE(detected_at) as day, COUNT(*) as count
       FROM promo_check_detections
       WHERE station_name = $1 AND detected_at >= NOW() - INTERVAL '1 day' * ${days}
       GROUP BY DATE(detected_at)
       ORDER BY day ASC`,
      [stationName],
    ),
  ]);

  const t = totals.rows[0];
  return c.json({
    monitoring: {
      status: mon.active ? 'active' : 'paused',
      stationName: mon.station_name,
      streamUrl: mon.stream_url,
      lastScannedAt: mon.last_scanned_at,
      errorCount: mon.error_count,
      lastError: mon.last_error,
    },
    totals: {
      rotations: parseInt(t?.total || '0'),
      confirmed: parseInt(t?.confirmed || '0'),
      uniqueTracks: parseInt(t?.unique_tracks || '0'),
    },
    by_track: byTrack.rows.map(r => ({
      trackId: r.track_id,
      title: r.title || 'Без названия',
      artistName: r.artist_name || 'Неизвестный артист',
      rotations: parseInt(r.rotations || '0'),
      confirmed: parseInt(r.confirmed || '0'),
      lastDetected: r.last_detected,
    })),
    timeline: timeline.rows.map(r => ({
      day: r.day,
      count: parseInt(r.count || '0'),
    })),
    period_days: days,
  });
});

export { app as promoCheckRoutes };
