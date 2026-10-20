/**
 * STREAM-PLAYER ROUTES — venue music playout state snapshot.
 *
 * This module is the "what should be playing right now" oracle. A
 * future ffmpeg worker will read `stream_player_state` to decide
 * which playlist file to push to its Icecast/HLS output. For the
 * MVP we just RECORD the resolved state so:
 *   1. Operators can see «is scheduling actually firing?» in admin.
 *   2. The venue cabinet can read its own current-playing without
 *      re-computing the schedule resolution every time.
 *   3. When the playout worker lands later, it has a battle-tested
 *      table to query — no new resolution logic to debug.
 *
 * Tick frequency: every 60 seconds via systemd timer hitting
 * `POST /cron/tick` with CRON_SECRET. The tick:
 *   - Iterates every venue that has at least one schedule OR zone.
 *   - For each venue: resolves the current-minute schedule for
 *     each zone (zone-specific override → venue-wide fallback).
 *   - UPSERTs `stream_player_state` rows. Bumps `last_tick_at`
 *     always; bumps `last_change_at` only when `current_playlist_id`
 *     actually flipped.
 *   - Returns a summary: scanned, changed, errors.
 *
 * Endpoints mounted at /server/api/stream-player:
 *
 *   POST   /cron/tick                     CRON_SECRET-protected.
 *                                         Iterates all venues, writes
 *                                         state. Idempotent.
 *   GET    /me                            JWT-auth. Returns the
 *                                         auth'd venue's state rows
 *                                         (one per zone + venue-wide).
 *
 * The endpoints do NOT do plan-gating — stream_player_state is
 * informational; venues on a tier without scheduling will simply
 * have an idle row with no current_schedule_id. That's harmless.
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { getVenueProfile as dbGetVenueProfile } from './db.tsx';
import { safeErrorMessage, secretMatches } from './security.tsx';

const app = new Hono();

// ── Moscow time helpers ──────────────────────────────────────────
// Mirror the venue-schedule-routes resolution: Moscow = UTC+3
// fixed offset, no DST since 2014. Avoid pulling tz libs.

function nowInMoscow(): { dayOfWeek: number; minuteOfDay: number } {
  const nowUtc = new Date();
  const moscow = new Date(nowUtc.getTime() + 3 * 60 * 60 * 1000);
  const dayUtc = moscow.getUTCDay();                 // 0=Sun..6=Sat
  const dayOfWeek = (dayUtc + 6) % 7;                // 0=Mon..6=Sun
  const minuteOfDay = moscow.getUTCHours() * 60 + moscow.getUTCMinutes();
  return { dayOfWeek, minuteOfDay };
}

// ── helpers ──────────────────────────────────────────────────────

async function getUserId(c: any): Promise<string> {
  return (c as any).get('userId') || 'anonymous';
}

function parse(data: any): any {
  if (!data) return null;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data;
}

async function loadVenueProfile(userId: string): Promise<any | null> {
  const data = await dbGetVenueProfile(userId);
  return parse(data);
}

function rowToState(r: any) {
  return {
    id: r.id,
    venueId: r.venue_id,
    userId: r.user_id,
    zoneId: r.zone_id,
    currentScheduleId: r.current_schedule_id,
    currentPlaylistId: r.current_playlist_id,
    status: r.status,
    errorText: r.error_text,
    lastTickAt: r.last_tick_at,
    lastChangeAt: r.last_change_at,
    createdAt: r.created_at,
  };
}

// Detect whether the deployed venue_schedules has the zone_id
// column (added by migration 019). Lets this module ship before
// or after 019 lands without crashing — we just fall back to the
// pre-zone-link query when the column is absent.
let _zoneIdColCache: boolean | null = null;
async function venueSchedulesHasZoneId(): Promise<boolean> {
  if (_zoneIdColCache !== null) return _zoneIdColCache;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'venue_schedules' AND column_name = 'zone_id'
        LIMIT 1`
    );
    _zoneIdColCache = (r.rowCount ?? 0) > 0;
  } catch {
    _zoneIdColCache = false;
  }
  return _zoneIdColCache;
}

// ──────────────────────────────────────────────────────────────────
// Core resolution: for a single venue, compute what should play in
// each zone (+ the venue-wide fallback row) and UPSERT state.
// ──────────────────────────────────────────────────────────────────

interface VenueRow {
  venueId: string;
  userId: string;
}

interface TickStats {
  venuesScanned: number;
  rowsUpserted: number;
  changes: number;
  errors: number;
}

async function tickAllVenues(): Promise<TickStats> {
  const stats: TickStats = { venuesScanned: 0, rowsUpserted: 0, changes: 0, errors: 0 };
  const { dayOfWeek, minuteOfDay } = nowInMoscow();
  const hasZoneId = await venueSchedulesHasZoneId();

  // Find every venue that has either a schedule OR a zone row.
  // Excluding venues with neither keeps the loop tight on production
  // (most venues never touched scheduling/zones).
  const venues = await pool.query<VenueRow>(
    `SELECT DISTINCT venue_id AS "venueId", user_id AS "userId" FROM (
       SELECT venue_id, user_id FROM venue_schedules WHERE is_active = TRUE
       UNION
       SELECT venue_id, user_id FROM venue_zones      WHERE is_active = TRUE
     ) AS active_venues`
  );

  for (const v of venues.rows) {
    stats.venuesScanned++;
    try {
      // Resolve all zones for this venue (+ a synthetic 'venue-wide'
      // pseudo-zone with null id).
      const zr = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM venue_zones
          WHERE user_id = $1 AND venue_id = $2 AND is_active = TRUE`,
        [v.userId, v.venueId]
      );
      const targets: (string | null)[] = [null, ...zr.rows.map((r) => r.id)];

      for (const zoneId of targets) {
        const resolved = await resolveSchedule(v, zoneId, dayOfWeek, minuteOfDay, hasZoneId);
        const upserted = await upsertState(v, zoneId, resolved);
        stats.rowsUpserted++;
        if (upserted.changed) stats.changes++;
      }
    } catch (err: any) {
      console.error('[stream-player] venue tick error:', v.venueId, err?.message);
      stats.errors++;
    }
  }

  return stats;
}

async function resolveSchedule(
  v: VenueRow,
  zoneId: string | null,
  dayOfWeek: number,
  minuteOfDay: number,
  hasZoneId: boolean,
): Promise<{ scheduleId: string | null; playlistId: string | null }> {
  // Pre-019 schema: no zone_id column. Skip zone-aware queries and
  // serve the same venue-wide row for every zone target — better than
  // crashing.
  if (!hasZoneId) {
    const r = await pool.query(
      `SELECT id::text AS id, playlist_id
         FROM venue_schedules
        WHERE user_id = $1 AND venue_id = $2
          AND is_active = TRUE
          AND day_of_week = $3
          AND start_minute <= $4
          AND end_minute   >  $4
        ORDER BY priority DESC, start_minute ASC
        LIMIT 1`,
      [v.userId, v.venueId, dayOfWeek, minuteOfDay]
    );
    if (r.rowCount === 0) return { scheduleId: null, playlistId: null };
    return { scheduleId: r.rows[0].id, playlistId: r.rows[0].playlist_id };
  }

  // Zone-aware path. CASE rank: zone-specific (0) beats venue-wide (1).
  if (zoneId) {
    const r = await pool.query(
      `SELECT id::text AS id, playlist_id,
              CASE WHEN zone_id = $5 THEN 0 ELSE 1 END AS zone_rank
         FROM venue_schedules
        WHERE user_id = $1 AND venue_id = $2
          AND is_active = TRUE
          AND day_of_week = $3
          AND start_minute <= $4
          AND end_minute   >  $4
          AND (zone_id = $5 OR zone_id IS NULL)
        ORDER BY zone_rank ASC, priority DESC, start_minute ASC
        LIMIT 1`,
      [v.userId, v.venueId, dayOfWeek, minuteOfDay, zoneId]
    );
    if (r.rowCount === 0) return { scheduleId: null, playlistId: null };
    return { scheduleId: r.rows[0].id, playlistId: r.rows[0].playlist_id };
  }

  // zoneId === null → venue-wide fallback row. Only consider rows
  // explicitly tagged as venue-wide (zone_id IS NULL).
  const r = await pool.query(
    `SELECT id::text AS id, playlist_id
       FROM venue_schedules
      WHERE user_id = $1 AND venue_id = $2
        AND is_active = TRUE
        AND zone_id IS NULL
        AND day_of_week = $3
        AND start_minute <= $4
        AND end_minute   >  $4
      ORDER BY priority DESC, start_minute ASC
      LIMIT 1`,
    [v.userId, v.venueId, dayOfWeek, minuteOfDay]
  );
  if (r.rowCount === 0) return { scheduleId: null, playlistId: null };
  return { scheduleId: r.rows[0].id, playlistId: r.rows[0].playlist_id };
}

async function upsertState(
  v: VenueRow,
  zoneId: string | null,
  resolved: { scheduleId: string | null; playlistId: string | null },
): Promise<{ changed: boolean }> {
  // The state row's PK identity is (venue_id, zone_id) — see the
  // partial unique indexes. Postgres ON CONFLICT can't reference a
  // partial index target, so we do read-then-write inside a TX.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      zoneId === null
        ? `SELECT current_playlist_id FROM stream_player_state
            WHERE venue_id = $1 AND zone_id IS NULL`
        : `SELECT current_playlist_id FROM stream_player_state
            WHERE venue_id = $1 AND zone_id = $2`,
      zoneId === null ? [v.venueId] : [v.venueId, zoneId]
    );

    const prevPlaylist = sel.rows[0]?.current_playlist_id ?? null;
    const status = resolved.playlistId ? 'playing' : 'idle';
    const changed = prevPlaylist !== resolved.playlistId;

    if (sel.rowCount === 0) {
      await client.query(
        `INSERT INTO stream_player_state
           (venue_id, user_id, zone_id, current_schedule_id,
            current_playlist_id, status, last_tick_at, last_change_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
        [v.venueId, v.userId, zoneId, resolved.scheduleId,
         resolved.playlistId, status]
      );
    } else {
      await client.query(
        zoneId === null
          ? `UPDATE stream_player_state
                SET current_schedule_id = $2,
                    current_playlist_id = $3,
                    status              = $4,
                    last_tick_at        = NOW(),
                    last_change_at      = CASE WHEN $5::boolean
                                           THEN NOW()
                                           ELSE last_change_at
                                          END
              WHERE venue_id = $1 AND zone_id IS NULL`
          : `UPDATE stream_player_state
                SET current_schedule_id = $2,
                    current_playlist_id = $3,
                    status              = $4,
                    last_tick_at        = NOW(),
                    last_change_at      = CASE WHEN $5::boolean
                                           THEN NOW()
                                           ELSE last_change_at
                                          END
              WHERE venue_id = $1 AND zone_id = $6`,
        zoneId === null
          ? [v.venueId, resolved.scheduleId, resolved.playlistId, status, changed]
          : [v.venueId, resolved.scheduleId, resolved.playlistId, status, changed, zoneId]
      );
    }
    await client.query('COMMIT');
    return { changed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ──────────────────────────────────────────────────────────────────
// POST /cron/tick — system timer hits this every 60s
// ──────────────────────────────────────────────────────────────────
app.post('/cron/tick', async (c) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[stream-player/cron] CRON_SECRET env var not set');
    return c.json({ success: false, error: 'Server misconfiguration' }, 500);
  }
  const provided = c.req.header('X-Cron-Secret') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (!secretMatches(provided, expected)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  try {
    const t0 = Date.now();
    const stats = await tickAllVenues();
    return c.json({ success: true, durationMs: Date.now() - t0, ...stats });
  } catch (err: any) {
    console.error('[stream-player/cron] tick failed:', err?.message);
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /me — auth'd venue reads its own resolved state rows
// ──────────────────────────────────────────────────────────────────
app.get('/me', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, states: [] });
    }
    const r = await pool.query(
      `SELECT * FROM stream_player_state
        WHERE venue_id = $1
        ORDER BY zone_id NULLS FIRST, last_tick_at DESC`,
      [profile.id]
    );
    return c.json({
      success: true,
      states: r.rows.map(rowToState),
    });
  } catch (error: any) {
    console.error('GET /stream-player/me:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
