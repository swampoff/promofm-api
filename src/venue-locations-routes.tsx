/**
 * VENUE-LOCATIONS ROUTES — multi-branch management for Сеть/Enterprise.
 *
 * Lets a network venue (Шоколадница, Кофемания, Тануки и т.п.)
 * register multiple physical points under a single account. Each
 * location has its own address / city / timezone / contact /
 * capacity; the primary one mirrors the profile address.
 *
 * Gating: `limits.multiLocation` (boolean) — free/start/business
 * see ONLY the auto-seeded primary location (no add/edit/delete);
 * network/enterprise can add as many as needed.
 *
 * Endpoints mounted at /server/api/venue-locations:
 *
 *   GET    /                  — list all locations (auto-seeds
 *                                «Основная точка» from venue profile
 *                                on first call so the response is
 *                                never empty for a registered venue)
 *   POST   /                  — create (gated by multiLocation flag)
 *   PUT    /:id               — patch update (gated)
 *   POST   /:id/make-primary  — atomic primary swap
 *   DELETE /:id               — refuses primary + last-remaining
 *
 * All endpoints require auth + are scoped to JWT userId.
 *
 * Persistence: `venue_locations` table (src/migrations/
 * 016_venue_locations.sql).
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

function rowToLocation(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    venueId: r.venue_id,
    name: r.name,
    address: r.address,
    city: r.city,
    country: r.country,
    timezone: r.timezone,
    contactPhone: r.contact_phone,
    contactEmail: r.contact_email,
    capacity: r.capacity,
    isPrimary: r.is_primary,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function listLocations(userId: string): Promise<any[]> {
  const r = await pool.query(
    `SELECT * FROM venue_locations
      WHERE user_id = $1
      ORDER BY is_primary DESC, sort_order ASC, created_at ASC`,
    [userId]
  );
  return r.rows.map(rowToLocation);
}

// ──────────────────────────────────────────────────────────────────
// GET / — list (auto-seeds primary from venue profile on first call)
// ──────────────────────────────────────────────────────────────────
app.get('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, locations: [], multiLocationEnabled: false });
    }

    let locations = await listLocations(userId);
    const limits = getEffectiveVenueLimits(profile);

    // Auto-seed: every venue gets a primary location derived from
    // its profile address on first call. Subsequent calls (or
    // explicit POST /make-primary) won't re-create it.
    if (locations.length === 0) {
      const ins = await pool.query(
        `INSERT INTO venue_locations
           (user_id, venue_id, name, address, city, country, is_primary,
            is_active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE, 0)
         RETURNING *`,
        [
          userId,
          profile.id,
          profile.venueName || 'Основная точка',
          profile.address || null,
          profile.city || null,
          profile.country || 'Россия',
        ]
      );
      locations = [rowToLocation(ins.rows[0])];
    }

    return c.json({
      success: true,
      locations,
      multiLocationEnabled: limits.multiLocation === true,
    });
  } catch (error: any) {
    console.error('GET /venue-locations:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST / — create a new location (gated by multiLocation flag)
// ──────────────────────────────────────────────────────────────────
app.post('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);
    if (!limits.multiLocation) {
      return c.json(featureBlocked('multiLocation', profile), 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return c.json({ success: false, error: 'name is required' }, 400);

    // sortOrder defaults to current count so new locations land at
    // the end of the user's list.
    const current = await listLocations(userId);
    const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder : current.length;

    const r = await pool.query(
      `INSERT INTO venue_locations
         (user_id, venue_id, name, address, city, country, timezone,
          contact_phone, contact_email, capacity, is_active, sort_order,
          notes, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, FALSE)
       RETURNING *`,
      [
        userId,
        profile.id,
        name,
        body.address || null,
        body.city || null,
        body.country || 'Россия',
        body.timezone || 'Europe/Moscow',
        body.contactPhone || null,
        body.contactEmail || null,
        Number.isInteger(body.capacity) ? body.capacity : null,
        body.isActive === false ? false : true,
        sortOrder,
        body.notes || null,
      ]
    );

    return c.json({ success: true, location: rowToLocation(r.rows[0]) });
  } catch (error: any) {
    console.error('POST /venue-locations:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// PUT /:id — patch update (gated)
// ──────────────────────────────────────────────────────────────────
app.put('/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);
    if (!limits.multiLocation) {
      // Allow editing the primary even on locked plans — they should
      // still be able to fix their own address typo. Non-primary
      // edits are blocked entirely.
      const lookup = await pool.query(
        `SELECT is_primary FROM venue_locations WHERE id::text = $1 AND user_id = $2`,
        [c.req.param('id'), userId]
      );
      if (lookup.rowCount === 0) {
        return c.json({ success: false, error: 'Location not found' }, 404);
      }
      if (lookup.rows[0].is_primary !== true) {
        return c.json(featureBlocked('multiLocation', profile), 403);
      }
    }

    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    const existing = await pool.query(
      `SELECT * FROM venue_locations WHERE id::text = $1 AND user_id = $2`,
      [id, userId]
    );
    if (existing.rowCount === 0) {
      return c.json({ success: false, error: 'Location not found' }, 404);
    }
    const cur = existing.rows[0];

    const name = body.name !== undefined ? String(body.name).trim() : cur.name;
    if (!name) return c.json({ success: false, error: 'name cannot be empty' }, 400);

    const r = await pool.query(
      `UPDATE venue_locations
          SET name           = $1,
              address        = $2,
              city           = $3,
              country        = $4,
              timezone       = $5,
              contact_phone  = $6,
              contact_email  = $7,
              capacity       = $8,
              is_active      = $9,
              sort_order     = $10,
              notes          = $11,
              updated_at     = NOW()
        WHERE id::text = $12 AND user_id = $13
        RETURNING *`,
      [
        name,
        body.address          !== undefined ? body.address          : cur.address,
        body.city             !== undefined ? body.city             : cur.city,
        body.country          !== undefined ? body.country          : cur.country,
        body.timezone         !== undefined ? body.timezone         : cur.timezone,
        body.contactPhone     !== undefined ? body.contactPhone     : cur.contact_phone,
        body.contactEmail     !== undefined ? body.contactEmail     : cur.contact_email,
        Number.isInteger(body.capacity)     ? body.capacity         : cur.capacity,
        typeof body.isActive === 'boolean'  ? body.isActive         : cur.is_active,
        Number.isInteger(body.sortOrder)    ? body.sortOrder        : cur.sort_order,
        body.notes            !== undefined ? body.notes            : cur.notes,
        id,
        userId,
      ]
    );

    return c.json({ success: true, location: rowToLocation(r.rows[0]) });
  } catch (error: any) {
    console.error('PUT /venue-locations/:id:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /:id/make-primary — atomic swap of which location is primary
// ──────────────────────────────────────────────────────────────────
app.post('/:id/make-primary', requireAuth, async (c) => {
  const client = await pool.connect();
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);
    if (!limits.multiLocation) {
      return c.json(featureBlocked('multiLocation', profile), 403);
    }

    const id = c.req.param('id');

    await client.query('BEGIN');

    const exists = await client.query(
      `SELECT id FROM venue_locations
        WHERE id::text = $1 AND user_id = $2 AND venue_id = $3`,
      [id, userId, profile.id]
    );
    if (exists.rowCount === 0) {
      await client.query('ROLLBACK');
      return c.json({ success: false, error: 'Location not found' }, 404);
    }

    // Clear primary on all of this venue's locations first, then
    // set on the chosen one. Single TX so the partial unique index
    // never sees two TRUE values mid-flight.
    await client.query(
      `UPDATE venue_locations SET is_primary = FALSE, updated_at = NOW()
        WHERE venue_id = $1 AND is_primary = TRUE`,
      [profile.id]
    );
    await client.query(
      `UPDATE venue_locations SET is_primary = TRUE, updated_at = NOW()
        WHERE id::text = $1`,
      [id]
    );

    await client.query('COMMIT');

    const fresh = await listLocations(userId);
    return c.json({ success: true, locations: fresh });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /venue-locations/:id/make-primary:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  } finally {
    client.release();
  }
});

// ──────────────────────────────────────────────────────────────────
// DELETE /:id — refuses primary + last-remaining
// ──────────────────────────────────────────────────────────────────
app.delete('/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const id = c.req.param('id');

    const lookup = await pool.query(
      `SELECT is_primary FROM venue_locations
        WHERE id::text = $1 AND user_id = $2`,
      [id, userId]
    );
    if (lookup.rowCount === 0) {
      return c.json({ success: false, error: 'Location not found' }, 404);
    }
    if (lookup.rows[0].is_primary === true) {
      return c.json({
        success: false,
        error: 'Нельзя удалить основную точку. Сначала назначьте другую основной (Сделать основной).',
      }, 400);
    }

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM venue_locations WHERE user_id = $1`,
      [userId]
    );
    if ((count.rows[0]?.n ?? 0) <= 1) {
      return c.json({
        success: false,
        error: 'Нельзя удалить последнюю точку – заведение должно иметь хотя бы одну.',
      }, 400);
    }

    await pool.query(
      `DELETE FROM venue_locations WHERE id::text = $1 AND user_id = $2`,
      [id, userId]
    );
    return c.json({ success: true });
  } catch (error: any) {
    console.error('DELETE /venue-locations/:id:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
