/**
 * Promo.check Routes — Radio airplay monitoring API
 * /server/api/promo-check/*
 */

import { Hono } from "hono";
import { spawn } from "child_process";
import { pool } from "./db-client.tsx";
import { requireAuth, requireOwner } from "./auth-middleware.tsx";

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
     WHERE t.artist_id = $1
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

  if (trackId) {
    sql += ` WHERE d.track_id = $${params.length + 1}`;
    params.push(trackId);
  } else if (artistId) {
    sql += ` WHERE t.artist_id = $${params.length + 1}`;
    params.push(artistId);
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

export { app as promoCheckRoutes };
