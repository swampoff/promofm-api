/**
 * VENUE-SCHEDULE ROUTES — weekly playlist scheduling for Бизнес+ venues.
 *
 * A schedule entry tells the stream-server: "on day_of_week, between
 * start_minute and end_minute, play playlist_id at priority N". The
 * UI is a 7-day grid in the venue cabinet; the stream-server polls
 * `/active-now` once a minute to decide what to broadcast.
 *
 * Plan-gating: `getEffectiveVenueLimits(profile).scheduling` MUST be
 * true. Free / Старт venues hit 403 with `featureBlocked('scheduling',
 * profile)`. Trial venues are entitled (effectivePlan='business' until
 * the trial-expiry cron flips them to expired).
 *
 * Endpoints mounted at /server/api/venue-schedule:
 *
 *   GET    /                 — list all schedules for the auth'd venue
 *   POST   /                 — create a new schedule
 *   PUT    /:id              — update an existing schedule
 *   DELETE /:id              — delete a schedule
 *   GET    /active-now       — what schedule should be playing right
 *                              now for the auth'd venue (single row or
 *                              null). Used by stream-server polling.
 *
 * All endpoints require auth. Schedules are scoped to the authenticated
 * venue owner — no cross-venue reads or writes. Ownership check uses
 * venue_schedules.user_id = JWT.userId.
 *
 * Persistence: `venue_schedules` table (see src/migrations/
 * 014_venue_schedules.sql).
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { getVenueProfile as dbGetVenueProfile } from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import {
  getEffectiveVenueLimits,
  featureBlocked,
} from './venue-plan-limits.tsx';

const app = new Hono();

const FALLBACK_VENUE_USER_ID = 'anonymous';

async function getUserId(c: any): Promise<string> {
  return (c as any).get('userId') || FALLBACK_VENUE_USER_ID;
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

// Validate that a schedule payload is well-formed BEFORE hitting the
// CHECK constraints — gives the cabinet UI a cleaner 400 instead of
// a 500 with a Postgres error message.
function validatePayload(body: any): { ok: boolean; error?: string } {
  const dayOfWeek = Number(body.dayOfWeek ?? body.day_of_week);
  const startMinute = Number(body.startMinute ?? body.start_minute);
  const endMinute = Number(body.endMinute ?? body.end_minute);

  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return { ok: false, error: 'dayOfWeek must be an integer 0..6 (0=Mon, 6=Sun)' };
  }
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439) {
    return { ok: false, error: 'startMinute must be an integer 0..1439' };
  }
  if (!Number.isInteger(endMinute) || endMinute < 1 || endMinute > 1440) {
    return { ok: false, error: 'endMinute must be an integer 1..1440' };
  }
  if (endMinute <= startMinute) {
    return { ok: false, error: 'endMinute must be greater than startMinute' };
  }
  if (!body.playlistId && !body.playlist_id) {
    return { ok: false, error: 'playlistId is required' };
  }
  if (!body.name || String(body.name).trim().length === 0) {
    return { ok: false, error: 'name is required' };
  }
  return { ok: true };
}

function rowToSchedule(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    venueId: r.venue_id,
    name: r.name,
    dayOfWeek: r.day_of_week,
    startMinute: r.start_minute,
    endMinute: r.end_minute,
    playlistId: r.playlist_id,
    // NULL zone_id = venue-wide schedule (applies to every zone
    // that has no zone-specific schedule for that minute).
    zoneId: r.zone_id ?? null,
    priority: r.priority,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Resolve an incoming `zoneId` payload to a value safe for the DB:
//   - undefined → null (legacy callers don't send the field)
//   - null / '' → null (UI's «все зоны» option)
//   - string    → verify it belongs to this venue → return as-is
//                 OR 'INVALID' sentinel so the caller can 400
async function resolveZoneId(raw: unknown, userId: string, venueId: string): Promise<string | null | 'INVALID'> {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = String(raw);
  const r = await pool.query(
    `SELECT 1 FROM venue_zones WHERE id::text = $1 AND user_id = $2 AND venue_id = $3`,
    [id, userId, venueId]
  );
  return r.rowCount && r.rowCount > 0 ? id : 'INVALID';
}

// ──────────────────────────────────────────────────────────────────
// GET / — list schedules for the authenticated venue
// ──────────────────────────────────────────────────────────────────
app.get('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, schedules: [] });
    }

    const r = await pool.query(
      `SELECT * FROM venue_schedules
        WHERE user_id = $1
        ORDER BY day_of_week ASC, start_minute ASC, priority DESC`,
      [userId]
    );

    return c.json({
      success: true,
      schedules: r.rows.map(rowToSchedule),
      // Surface entitlement so the cabinet can render a lock-screen
      // when scheduling=false without making a second request.
      featureEnabled: getEffectiveVenueLimits(profile).scheduling === true,
    });
  } catch (error: any) {
    console.error('GET /venue-schedule:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST / — create a new schedule (gated by scheduling=true)
// ──────────────────────────────────────────────────────────────────
app.post('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);
    if (!limits.scheduling) {
      return c.json(featureBlocked('scheduling', profile), 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const v = validatePayload(body);
    if (!v.ok) return c.json({ success: false, error: v.error }, 400);

    const dayOfWeek = Number(body.dayOfWeek ?? body.day_of_week);
    const startMinute = Number(body.startMinute ?? body.start_minute);
    const endMinute = Number(body.endMinute ?? body.end_minute);
    const playlistId = String(body.playlistId ?? body.playlist_id);
    const name = String(body.name).trim();
    const priority = Number.isInteger(body.priority) ? body.priority : 0;
    const isActive = body.isActive === false ? false : true;
    // zoneId is optional. Empty string is treated as NULL (UI sends ''
    // from the «все зоны» option). When non-null, we verify the zone
    // belongs to this venue so callers can't link to someone else's row.
    const zoneId = await resolveZoneId(body.zoneId ?? body.zone_id, userId, profile.id);
    if (zoneId === 'INVALID') {
      return c.json({ success: false, error: 'zoneId does not belong to this venue' }, 400);
    }

    const r = await pool.query(
      `INSERT INTO venue_schedules
         (user_id, venue_id, name, day_of_week, start_minute, end_minute,
          playlist_id, priority, is_active, zone_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [userId, profile.id, name, dayOfWeek, startMinute, endMinute,
       playlistId, priority, isActive, zoneId]
    );

    return c.json({ success: true, schedule: rowToSchedule(r.rows[0]) });
  } catch (error: any) {
    console.error('POST /venue-schedule:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// PUT /:id — update an existing schedule
// ──────────────────────────────────────────────────────────────────
app.put('/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);
    if (!limits.scheduling) {
      return c.json(featureBlocked('scheduling', profile), 403);
    }

    const scheduleId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    // Patch semantics: only fields present in the body are updated.
    // Validate the merged payload by loading the existing row first
    // so partial updates still hit the integer / range checks.
    const existing = await pool.query(
      `SELECT * FROM venue_schedules WHERE id::text = $1 AND user_id = $2`,
      [scheduleId, userId]
    );
    if (existing.rowCount === 0) {
      return c.json({ success: false, error: 'Schedule not found' }, 404);
    }

    const cur = existing.rows[0];
    const merged = {
      name:        body.name ?? cur.name,
      dayOfWeek:   body.dayOfWeek ?? body.day_of_week ?? cur.day_of_week,
      startMinute: body.startMinute ?? body.start_minute ?? cur.start_minute,
      endMinute:   body.endMinute ?? body.end_minute ?? cur.end_minute,
      playlistId:  body.playlistId ?? body.playlist_id ?? cur.playlist_id,
      priority:    Number.isInteger(body.priority) ? body.priority : cur.priority,
      isActive:    typeof body.isActive === 'boolean' ? body.isActive : cur.is_active,
    };

    const v = validatePayload(merged);
    if (!v.ok) return c.json({ success: false, error: v.error }, 400);

    // zoneId: present-in-body OR keep current. Empty/null clears it.
    let nextZoneId: string | null;
    if ('zoneId' in body || 'zone_id' in body) {
      const resolved = await resolveZoneId(body.zoneId ?? body.zone_id, userId, profile.id);
      if (resolved === 'INVALID') {
        return c.json({ success: false, error: 'zoneId does not belong to this venue' }, 400);
      }
      nextZoneId = resolved;
    } else {
      nextZoneId = cur.zone_id ?? null;
    }

    const r = await pool.query(
      `UPDATE venue_schedules
          SET name         = $1,
              day_of_week  = $2,
              start_minute = $3,
              end_minute   = $4,
              playlist_id  = $5,
              priority     = $6,
              is_active    = $7,
              zone_id      = $8,
              updated_at   = NOW()
        WHERE id::text = $9 AND user_id = $10
        RETURNING *`,
      [merged.name, merged.dayOfWeek, merged.startMinute, merged.endMinute,
       merged.playlistId, merged.priority, merged.isActive,
       nextZoneId, scheduleId, userId]
    );

    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Schedule not found' }, 404);
    }

    return c.json({ success: true, schedule: rowToSchedule(r.rows[0]) });
  } catch (error: any) {
    console.error('PUT /venue-schedule/:id:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// DELETE /:id — remove a schedule
// ──────────────────────────────────────────────────────────────────
app.delete('/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const scheduleId = c.req.param('id');

    const r = await pool.query(
      `DELETE FROM venue_schedules
        WHERE id::text = $1 AND user_id = $2`,
      [scheduleId, userId]
    );

    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Schedule not found' }, 404);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('DELETE /venue-schedule/:id:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /active-now — what schedule is currently active for the
// authenticated venue. The stream-server hits this once a minute to
// decide which playlist to broadcast.
//
// Query params:
//   ?zoneId=<uuid>  — resolve for that specific zone (preferred for
//                     multi-zone venues; the worker iterates zones)
//   (no param)      — back-compat: returns the highest-priority
//                     schedule for the venue, preferring rows where
//                     zone_id IS NULL (legacy / venue-wide).
//
// Resolution rule per zone:
//   1. Prefer rows whose `zone_id = :zoneId` (zone-specific override)
//   2. Fall back to rows where `zone_id IS NULL` (venue-wide default)
//   3. Within either bucket: highest priority, lowest start_minute.
// ──────────────────────────────────────────────────────────────────
app.get('/active-now', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, active: null });
    }

    // Compute "now" in Moscow time. Moscow = UTC+3, no DST since 2014.
    // Avoid pulling tz libs — for fixed-offset zones manual arithmetic
    // is simpler and dependency-free.
    const nowUtc = new Date();
    const moscow = new Date(nowUtc.getTime() + 3 * 60 * 60 * 1000);
    const dayUtc = moscow.getUTCDay();              // 0=Sun..6=Sat
    const dayOfWeek = (dayUtc + 6) % 7;             // convert to 0=Mon..6=Sun
    const minuteOfDay = moscow.getUTCHours() * 60 + moscow.getUTCMinutes();

    const zoneIdParam = c.req.query('zoneId') || null;

    // The CASE in the ORDER BY ranks zone-specific (= zoneIdParam) above
    // venue-wide (IS NULL) so a one-off zone override beats the default.
    // When zoneIdParam is null, the CASE collapses to (0 if NULL, NULL
    // otherwise) and we filter zone_id IS NULL to preserve legacy
    // behaviour (no zone arg → ignore zone-specific rows entirely).
    const r = zoneIdParam
      ? await pool.query(
          `SELECT *,
                  CASE WHEN zone_id = $5 THEN 0 ELSE 1 END AS zone_rank
             FROM venue_schedules
            WHERE user_id = $1
              AND venue_id = $2
              AND is_active = TRUE
              AND day_of_week = $3
              AND start_minute <= $4
              AND end_minute   >  $4
              AND (zone_id = $5 OR zone_id IS NULL)
            ORDER BY zone_rank ASC, priority DESC, start_minute ASC
            LIMIT 1`,
          [userId, profile.id, dayOfWeek, minuteOfDay, zoneIdParam]
        )
      : await pool.query(
          `SELECT * FROM venue_schedules
            WHERE user_id = $1
              AND venue_id = $2
              AND is_active = TRUE
              AND day_of_week = $3
              AND start_minute <= $4
              AND end_minute   >  $4
              AND zone_id IS NULL
            ORDER BY priority DESC, start_minute ASC
            LIMIT 1`,
          [userId, profile.id, dayOfWeek, minuteOfDay]
        );

    return c.json({
      success: true,
      active: r.rows[0] ? rowToSchedule(r.rows[0]) : null,
      now: { dayOfWeek, minuteOfDay, tz: 'Europe/Moscow', zoneId: zoneIdParam },
    });
  } catch (error: any) {
    console.error('GET /venue-schedule/active-now:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
