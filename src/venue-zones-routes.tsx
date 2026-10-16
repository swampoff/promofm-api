/**
 * VENUE-ZONES ROUTES — multi-room music for Бизнес+ venues.
 *
 * A "zone" is a physical area of a venue with its own audio output
 * (bar / restaurant / lounge / terrace). The cabinet lets the venue
 * owner set `current_playlist_id` per zone; the stream-server reads
 * the current playlist via `GET /:zoneId/current` (future use; the
 * row is already part of the response).
 *
 * Quota: `VENUE_PLAN_LIMITS[plan].zones` caps the row count per
 * venue. Free/Старт = 1, Бизнес = 4, Сеть/Enterprise = unlimited
 * (-1). POST enforces the cap with `quotaExceeded(...)`. Trial venues
 * effectively get the Бизнес cap (4) per the trial promise.
 *
 * Endpoints mounted at /server/api/venue-zones:
 *
 *   GET    /                  — list all zones for the auth'd venue
 *                                (auto-creates "Основная зона" on
 *                                first call so every venue starts
 *                                with at least one row)
 *   POST   /                  — create a zone (quota-gated)
 *   PUT    /:id               — update name/description/playlist
 *   DELETE /:id               — delete (refuses when only one left
 *                                so the venue always has ≥1 zone)
 *   PUT    /:id/playlist      — convenience: set current playlist
 *
 * All endpoints require auth + are scoped to the JWT userId.
 *
 * Persistence: `venue_zones` table (src/migrations/015_venue_zones.sql).
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { getVenueProfile as dbGetVenueProfile } from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import {
  getEffectiveVenueLimits,
  quotaExceeded,
} from './venue-plan-limits.tsx';

const app = new Hono();

// Inline-бутстрап схемы (контракт migration-runner: каждый модуль создаёт свою
// схему сам). 015_venue_zones.sql помечена MANUAL DEPLOY и на проде не накатана —
// без этого GET/POST /venue-zones стабильно 500. Идемпотентно + мемоизировано.
let _zonesSchemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!_zonesSchemaReady) {
    _zonesSchemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS venue_zones (
          id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id             TEXT         NOT NULL,
          venue_id            TEXT         NOT NULL,
          name                TEXT         NOT NULL,
          description         TEXT,
          current_playlist_id TEXT,
          is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
          sort_order          INTEGER      NOT NULL DEFAULT 0,
          created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_venue_zones_user_id ON venue_zones (user_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_venue_zones_venue_id ON venue_zones (venue_id, sort_order)`);
    })().catch((e) => { _zonesSchemaReady = null; throw e; });
  }
  return _zonesSchemaReady;
}

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

function rowToZone(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    venueId: r.venue_id,
    name: r.name,
    description: r.description,
    currentPlaylistId: r.current_playlist_id,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function listZones(userId: string): Promise<any[]> {
  await ensureSchema();
  const r = await pool.query(
    `SELECT * FROM venue_zones
      WHERE user_id = $1
      ORDER BY sort_order ASC, created_at ASC`,
    [userId]
  );
  return r.rows.map(rowToZone);
}

// ──────────────────────────────────────────────────────────────────
// GET / — list zones (auto-seeds default zone on first call)
// ──────────────────────────────────────────────────────────────────
app.get('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, zones: [], maxZones: 1 });
    }

    let zones = await listZones(userId);
    const limits = getEffectiveVenueLimits(profile);

    // Auto-seed: every venue gets «Основная зона» if it has none.
    // This keeps the rest of the cabinet simple — "zones[0]" is
    // always safe, no special-case for "venue has 0 zones".
    if (zones.length === 0) {
      const ins = await pool.query(
        `INSERT INTO venue_zones (user_id, venue_id, name, sort_order, is_active)
         VALUES ($1, $2, $3, 0, TRUE)
         RETURNING *`,
        [userId, profile.id, 'Основная зона']
      );
      zones = [rowToZone(ins.rows[0])];
    }

    return c.json({
      success: true,
      zones,
      maxZones: limits.zones,                  // -1 = unlimited
      canAddMore: limits.zones === -1 || zones.length < limits.zones,
    });
  } catch (error: any) {
    console.error('GET /venue-zones:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST / — create a zone (quota-gated by limits.zones)
// ──────────────────────────────────────────────────────────────────
app.post('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);
    const current = await listZones(userId);

    if (limits.zones !== -1 && current.length >= limits.zones) {
      return c.json(
        quotaExceeded('zones', current.length, limits.zones, profile),
        403,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return c.json({ success: false, error: 'name is required' }, 400);

    const description = body.description ? String(body.description) : null;
    const playlistId = body.currentPlaylistId ? String(body.currentPlaylistId) : null;
    const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder : current.length;
    const isActive = body.isActive === false ? false : true;

    const r = await pool.query(
      `INSERT INTO venue_zones
         (user_id, venue_id, name, description, current_playlist_id,
          sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [userId, profile.id, name, description, playlistId, sortOrder, isActive]
    );

    return c.json({ success: true, zone: rowToZone(r.rows[0]) });
  } catch (error: any) {
    console.error('POST /venue-zones:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// PUT /:id — patch update
// ──────────────────────────────────────────────────────────────────
app.put('/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const zoneId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    const existing = await pool.query(
      `SELECT * FROM venue_zones WHERE id::text = $1 AND user_id = $2`,
      [zoneId, userId]
    );
    if (existing.rowCount === 0) {
      return c.json({ success: false, error: 'Zone not found' }, 404);
    }

    const cur = existing.rows[0];
    const name = body.name !== undefined ? String(body.name).trim() : cur.name;
    if (!name) return c.json({ success: false, error: 'name cannot be empty' }, 400);

    const description = body.description !== undefined ? body.description : cur.description;
    const playlistId  = body.currentPlaylistId !== undefined ? body.currentPlaylistId : cur.current_playlist_id;
    const sortOrder   = Number.isInteger(body.sortOrder) ? body.sortOrder : cur.sort_order;
    const isActive    = typeof body.isActive === 'boolean' ? body.isActive : cur.is_active;

    const r = await pool.query(
      `UPDATE venue_zones
          SET name                 = $1,
              description          = $2,
              current_playlist_id  = $3,
              sort_order           = $4,
              is_active            = $5,
              updated_at           = NOW()
        WHERE id::text = $6 AND user_id = $7
        RETURNING *`,
      [name, description, playlistId, sortOrder, isActive, zoneId, userId]
    );

    return c.json({ success: true, zone: rowToZone(r.rows[0]) });
  } catch (error: any) {
    console.error('PUT /venue-zones/:id:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// PUT /:id/playlist — convenience endpoint for the player UI
// ──────────────────────────────────────────────────────────────────
app.put('/:id/playlist', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const zoneId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const playlistId = body.playlistId !== undefined ? body.playlistId : body.currentPlaylistId;
    if (playlistId === undefined) {
      return c.json({ success: false, error: 'playlistId is required (use null to clear)' }, 400);
    }

    const r = await pool.query(
      `UPDATE venue_zones
          SET current_playlist_id = $1,
              updated_at = NOW()
        WHERE id::text = $2 AND user_id = $3
        RETURNING *`,
      [playlistId, zoneId, userId]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Zone not found' }, 404);
    }
    return c.json({ success: true, zone: rowToZone(r.rows[0]) });
  } catch (error: any) {
    console.error('PUT /venue-zones/:id/playlist:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// DELETE /:id — remove zone (refuses if it's the last one)
// ──────────────────────────────────────────────────────────────────
app.delete('/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const zoneId = c.req.param('id');

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM venue_zones WHERE user_id = $1`,
      [userId]
    );
    if ((count.rows[0]?.n ?? 0) <= 1) {
      return c.json({
        success: false,
        error: 'Нельзя удалить последнюю зону – заведение должно иметь хотя бы одну.',
      }, 400);
    }

    const r = await pool.query(
      `DELETE FROM venue_zones WHERE id::text = $1 AND user_id = $2`,
      [zoneId, userId]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Zone not found' }, 404);
    }
    return c.json({ success: true });
  } catch (error: any) {
    console.error('DELETE /venue-zones/:id:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
