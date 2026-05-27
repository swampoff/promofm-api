/**
 * VENUE-API ROUTES — programmatic access for Сеть/Enterprise venues.
 *
 * This module exposes TWO surfaces:
 *
 *   1. /server/api/venue-api/tokens/*    (JWT-protected, manage tokens)
 *      - POST   /                 issue a new token (returns plaintext ONCE)
 *      - GET    /                 list own tokens (no plaintext)
 *      - PUT    /:id              update name / scopes / expires_at
 *      - POST   /:id/revoke       soft-revoke (stamps revoked_at)
 *      - DELETE /:id              hard-delete (for cleanup)
 *
 *   2. /server/api/venue-public/*        (Bearer-token-protected, third-party API)
 *      - GET    /zones                          requires read:zones
 *      - GET    /zones/:id                      requires read:zones
 *      - GET    /zones/:id/current              requires read:zones
 *      - PUT    /zones/:id/playlist             requires write:zones
 *      - GET    /playlists                      requires read:playlists
 *      - GET    /playlists/:id                  requires read:playlists
 *      - GET    /now-playing                    requires read:now
 *      - GET    /me                             always allowed (echo token info)
 *
 * Security:
 *   - Token = `vpfm_` + 64 hex chars (32 random bytes). Plaintext is
 *     shown to the user ONCE at creation, never persisted.
 *   - Server stores SHA-256(plaintext) in venue_api_tokens.token_hash.
 *     Auth middleware hashes the incoming Bearer and looks up by hash.
 *   - Expired (`expires_at < NOW()`) and revoked (`revoked_at NOT NULL`)
 *     tokens are rejected with 401.
 *   - All public-API requests are scoped to the token's venue —
 *     no cross-tenant reads possible.
 *
 * Gating: creating a token requires `limits.apiAccess === true`
 * (network/enterprise). Lower tiers see 403 featureBlocked('apiAccess').
 * Existing tokens keep working until revoked even if the venue
 * downgrades — explicit revoke is the user's responsibility.
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { getVenueProfile as dbGetVenueProfile } from './db.tsx';

// Row mapper для venue_playlists (row-per-playlist после миграции 036).
// Дублирует mapPlaylistRow из venue-routes.tsx — здесь публичный API,
// контракт идентичный. При расхождениях — синхронизировать оба.
function mapPlaylistRow(row: any): Record<string, any> {
  const iso = (d: any) => d ? (d instanceof Date ? d.toISOString() : String(d)) : undefined;
  return {
    id: row.app_id,
    venueId: row.venue_id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    coverImageUrl: row.cover_image_url,
    contentItems: row.content_items || [],
    trackCount: row.track_count,
    totalDuration: row.total_duration,
    isPublic: row.is_public,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const PLAYLIST_COLS = `app_id, venue_id, owner_id, title, description, cover_image_url,
  content_items, track_count, total_duration, is_public, status, created_at, updated_at`;
import { safeErrorMessage } from './security.tsx';
import {
  getEffectiveVenueLimits,
  featureBlocked,
} from './venue-plan-limits.tsx';

// ──────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────

export const TOKEN_PREFIX = 'vpfm_';
const TOKEN_RANDOM_BYTES = 32; // → 64 hex chars
const PREFIX_DISPLAY_LEN = 12;  // "vpfm_xxxxxxx" stored for display

const ALL_SCOPES = [
  'read:zones',
  'write:zones',
  'read:locations',
  'read:playlists',
  'read:now',
] as const;
type Scope = typeof ALL_SCOPES[number];

function newToken(): { plaintext: string; hash: string; prefix: string } {
  const rand = crypto.randomBytes(TOKEN_RANDOM_BYTES).toString('hex');
  const plaintext = `${TOKEN_PREFIX}${rand}`;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const prefix = plaintext.slice(0, PREFIX_DISPLAY_LEN);
  return { plaintext, hash, prefix };
}

function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

function parseScopes(input: unknown): Scope[] {
  if (!Array.isArray(input)) return [];
  const out: Scope[] = [];
  for (const s of input) {
    if (typeof s !== 'string') continue;
    if ((ALL_SCOPES as readonly string[]).includes(s)) out.push(s as Scope);
  }
  return Array.from(new Set(out)); // dedupe
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

function rowToToken(r: any, plaintext?: string) {
  return {
    id: r.id,
    userId: r.user_id,
    venueId: r.venue_id,
    name: r.name,
    tokenPrefix: r.token_prefix,
    scopes: Array.isArray(r.scopes) ? r.scopes : (parse(r.scopes) || []),
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    // Plaintext is included ONLY when caller passed it (i.e. just
    // after POST /). Subsequent GETs never include it.
    ...(plaintext ? { token: plaintext } : {}),
  };
}

// ──────────────────────────────────────────────────────────────────
// PRIVATE: /server/api/venue-api/tokens/* — JWT-protected
// ──────────────────────────────────────────────────────────────────

const tokensApp = new Hono();

async function getUserId(c: any): Promise<string> {
  return (c as any).get('userId') || 'anonymous';
}

tokensApp.get('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const r = await pool.query(
      `SELECT * FROM venue_api_tokens
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );
    return c.json({
      success: true,
      tokens: r.rows.map((row) => rowToToken(row)),
      availableScopes: ALL_SCOPES,
    });
  } catch (error: any) {
    console.error('GET /venue-api/tokens:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

tokensApp.post('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);
    if (!limits.apiAccess) {
      return c.json(featureBlocked('apiAccess', profile), 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return c.json({ success: false, error: 'name is required' }, 400);

    const scopes = parseScopes(body.scopes);
    if (scopes.length === 0) {
      return c.json({
        success: false,
        error: `scopes is required; valid values: ${ALL_SCOPES.join(', ')}`,
      }, 400);
    }

    // expiresAt: accept ISO date string or null. Reject past dates.
    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      const d = new Date(body.expiresAt);
      if (isNaN(d.getTime())) {
        return c.json({ success: false, error: 'expiresAt must be a valid ISO timestamp' }, 400);
      }
      if (d.getTime() <= Date.now()) {
        return c.json({ success: false, error: 'expiresAt must be in the future' }, 400);
      }
      expiresAt = d;
    }

    const { plaintext, hash, prefix } = newToken();

    const r = await pool.query(
      `INSERT INTO venue_api_tokens
         (user_id, venue_id, name, token_hash, token_prefix, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [userId, profile.id, name, hash, prefix, JSON.stringify(scopes), expiresAt]
    );

    // First and only time `plaintext` ever appears in a response.
    return c.json({
      success: true,
      token: rowToToken(r.rows[0], plaintext),
      message: 'Сохраните этот токен сейчас — он больше нигде не будет показан.',
    });
  } catch (error: any) {
    console.error('POST /venue-api/tokens:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

tokensApp.put('/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    const existing = await pool.query(
      `SELECT * FROM venue_api_tokens WHERE id::text = $1 AND user_id = $2`,
      [id, userId]
    );
    if (existing.rowCount === 0) {
      return c.json({ success: false, error: 'Token not found' }, 404);
    }
    const cur = existing.rows[0];

    const name = body.name !== undefined ? String(body.name).trim() : cur.name;
    if (!name) return c.json({ success: false, error: 'name cannot be empty' }, 400);

    const scopes = Array.isArray(body.scopes) ? parseScopes(body.scopes) : (parse(cur.scopes) || []);

    let expiresAt: Date | null = cur.expires_at;
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null || body.expiresAt === '') {
        expiresAt = null;
      } else {
        const d = new Date(body.expiresAt);
        if (isNaN(d.getTime())) {
          return c.json({ success: false, error: 'expiresAt must be a valid ISO timestamp' }, 400);
        }
        expiresAt = d;
      }
    }

    const r = await pool.query(
      `UPDATE venue_api_tokens
          SET name = $1, scopes = $2::jsonb, expires_at = $3
        WHERE id::text = $4 AND user_id = $5
        RETURNING *`,
      [name, JSON.stringify(scopes), expiresAt, id, userId]
    );

    return c.json({ success: true, token: rowToToken(r.rows[0]) });
  } catch (error: any) {
    console.error('PUT /venue-api/tokens/:id:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

tokensApp.post('/:id/revoke', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const id = c.req.param('id');
    const r = await pool.query(
      `UPDATE venue_api_tokens
          SET revoked_at = NOW()
        WHERE id::text = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING *`,
      [id, userId]
    );
    if (r.rowCount === 0) {
      // Either not found or already revoked — same response either way.
      return c.json({ success: false, error: 'Token not found or already revoked' }, 404);
    }
    return c.json({ success: true, token: rowToToken(r.rows[0]) });
  } catch (error: any) {
    console.error('POST /venue-api/tokens/:id/revoke:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

tokensApp.delete('/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const id = c.req.param('id');
    const r = await pool.query(
      `DELETE FROM venue_api_tokens WHERE id::text = $1 AND user_id = $2`,
      [id, userId]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Token not found' }, 404);
    }
    return c.json({ success: true });
  } catch (error: any) {
    console.error('DELETE /venue-api/tokens/:id:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// PUBLIC: /server/api/venue-public/* — Bearer-token-protected
// ──────────────────────────────────────────────────────────────────

const publicApp = new Hono();

interface TokenContext {
  tokenId: string;
  userId: string;
  venueId: string;
  scopes: Scope[];
}

// Resolve the Bearer token → TokenContext or null.
async function resolveBearer(c: any): Promise<TokenContext | null> {
  const auth = c.req.header('Authorization') || c.req.header('authorization');
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const plaintext = m[1].trim();
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;

  const hash = hashToken(plaintext);
  const r = await pool.query(
    `SELECT id, user_id, venue_id, scopes, expires_at, revoked_at
       FROM venue_api_tokens
      WHERE token_hash = $1`,
    [hash]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  // Touch last_used_at (fire-and-forget — don't block the request).
  pool.query(
    `UPDATE venue_api_tokens SET last_used_at = NOW() WHERE id = $1`,
    [row.id]
  ).catch((err) => console.error('venue_api_tokens touch:', err));

  const scopes = Array.isArray(row.scopes) ? row.scopes : (parse(row.scopes) || []);
  return {
    tokenId: row.id,
    userId: row.user_id,
    venueId: row.venue_id,
    scopes,
  };
}

function unauthorized(c: any, reason = 'Invalid or missing API token') {
  return c.json({ success: false, error: reason }, 401);
}

function forbidden(c: any, requiredScope: string) {
  return c.json({
    success: false,
    error: `Missing required scope: ${requiredScope}`,
    requiredScope,
  }, 403);
}

// Middleware factory: enforces auth + a required scope.
function requireScope(scope: Scope) {
  return async (c: any, next: any) => {
    const ctx = await resolveBearer(c);
    if (!ctx) return unauthorized(c);
    if (!ctx.scopes.includes(scope)) return forbidden(c, scope);
    (c as any).set('apiToken', ctx);
    await next();
  };
}

// GET /me — always allowed (no scope required besides a valid token)
publicApp.get('/me', async (c) => {
  const ctx = await resolveBearer(c);
  if (!ctx) return unauthorized(c);
  return c.json({
    success: true,
    venueId: ctx.venueId,
    scopes: ctx.scopes,
  });
});

// ── Zones ────────────────────────────────────────────────────────

publicApp.get('/zones', requireScope('read:zones'), async (c) => {
  const ctx = (c as any).get('apiToken') as TokenContext;
  const r = await pool.query(
    `SELECT id, name, description, current_playlist_id,
            is_active, sort_order, created_at, updated_at
       FROM venue_zones
      WHERE user_id = $1 AND venue_id = $2
      ORDER BY sort_order ASC, created_at ASC`,
    [ctx.userId, ctx.venueId]
  );
  return c.json({
    success: true,
    zones: r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      currentPlaylistId: row.current_playlist_id,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  });
});

publicApp.get('/zones/:id', requireScope('read:zones'), async (c) => {
  const ctx = (c as any).get('apiToken') as TokenContext;
  const id = c.req.param('id');
  const r = await pool.query(
    `SELECT id, name, description, current_playlist_id,
            is_active, sort_order, created_at, updated_at
       FROM venue_zones
      WHERE id::text = $1 AND user_id = $2 AND venue_id = $3`,
    [id, ctx.userId, ctx.venueId]
  );
  if (r.rowCount === 0) {
    return c.json({ success: false, error: 'Zone not found' }, 404);
  }
  const row = r.rows[0];
  return c.json({
    success: true,
    zone: {
      id: row.id,
      name: row.name,
      description: row.description,
      currentPlaylistId: row.current_playlist_id,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  });
});

publicApp.get('/zones/:id/current', requireScope('read:zones'), async (c) => {
  const ctx = (c as any).get('apiToken') as TokenContext;
  const id = c.req.param('id');
  const zr = await pool.query(
    `SELECT current_playlist_id FROM venue_zones
      WHERE id::text = $1 AND user_id = $2 AND venue_id = $3`,
    [id, ctx.userId, ctx.venueId]
  );
  if (zr.rowCount === 0) {
    return c.json({ success: false, error: 'Zone not found' }, 404);
  }
  const playlistId = zr.rows[0].current_playlist_id;
  if (!playlistId) {
    return c.json({ success: true, currentPlaylist: null });
  }
  const pr = await pool.query(
    `SELECT ${PLAYLIST_COLS} FROM venue_playlists
      WHERE app_id = $1 AND venue_id = $2`,
    [playlistId, ctx.venueId]
  );
  return c.json({ success: true, currentPlaylist: pr.rowCount ? mapPlaylistRow(pr.rows[0]) : null });
});

publicApp.put('/zones/:id/playlist', requireScope('write:zones'), async (c) => {
  const ctx = (c as any).get('apiToken') as TokenContext;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const playlistId = body.playlistId !== undefined ? body.playlistId : body.currentPlaylistId;
  if (playlistId === undefined) {
    return c.json({ success: false, error: 'playlistId is required (use null to clear)' }, 400);
  }

  // If a non-null playlistId is supplied, verify it belongs to this venue.
  if (playlistId !== null) {
    const exists = await pool.query(
      `SELECT 1 FROM venue_playlists WHERE app_id = $1 AND venue_id = $2`,
      [playlistId, ctx.venueId]
    );
    if (exists.rowCount === 0) {
      return c.json({ success: false, error: 'Playlist not found in this venue' }, 404);
    }
  }

  const r = await pool.query(
    `UPDATE venue_zones
        SET current_playlist_id = $1, updated_at = NOW()
      WHERE id::text = $2 AND user_id = $3 AND venue_id = $4
      RETURNING id, current_playlist_id, updated_at`,
    [playlistId, id, ctx.userId, ctx.venueId]
  );
  if (r.rowCount === 0) {
    return c.json({ success: false, error: 'Zone not found' }, 404);
  }
  return c.json({
    success: true,
    zone: {
      id: r.rows[0].id,
      currentPlaylistId: r.rows[0].current_playlist_id,
      updatedAt: r.rows[0].updated_at,
    },
  });
});

// ── Playlists ────────────────────────────────────────────────────

publicApp.get('/playlists', requireScope('read:playlists'), async (c) => {
  const ctx = (c as any).get('apiToken') as TokenContext;
  const r = await pool.query(
    `SELECT ${PLAYLIST_COLS} FROM venue_playlists
      WHERE venue_id = $1 ORDER BY created_at DESC`,
    [ctx.venueId]
  );
  return c.json({ success: true, playlists: r.rows.map(mapPlaylistRow) });
});

publicApp.get('/playlists/:id', requireScope('read:playlists'), async (c) => {
  const ctx = (c as any).get('apiToken') as TokenContext;
  const id = c.req.param('id');
  const r = await pool.query(
    `SELECT ${PLAYLIST_COLS} FROM venue_playlists
      WHERE app_id = $1 AND venue_id = $2`,
    [id, ctx.venueId]
  );
  if (r.rowCount === 0) {
    return c.json({ success: false, error: 'Playlist not found' }, 404);
  }
  return c.json({ success: true, playlist: mapPlaylistRow(r.rows[0]) });
});

// ── Now-playing snapshot (all active zones with their playlists) ─

publicApp.get('/now-playing', requireScope('read:now'), async (c) => {
  const ctx = (c as any).get('apiToken') as TokenContext;
  const zr = await pool.query(
    `SELECT id, name, current_playlist_id, is_active
       FROM venue_zones
      WHERE user_id = $1 AND venue_id = $2 AND is_active = TRUE
      ORDER BY sort_order ASC`,
    [ctx.userId, ctx.venueId]
  );
  const pr = await pool.query(
    `SELECT ${PLAYLIST_COLS} FROM venue_playlists WHERE venue_id = $1`,
    [ctx.venueId]
  );
  const byId = new Map<string, any>(pr.rows.map((row: any) => [row.app_id, mapPlaylistRow(row)]));
  return c.json({
    success: true,
    zones: zr.rows.map((row) => ({
      id: row.id,
      name: row.name,
      isActive: row.is_active,
      currentPlaylist: row.current_playlist_id ? (byId.get(row.current_playlist_id) || null) : null,
    })),
  });
});

// ──────────────────────────────────────────────────────────────────
// Exports — mounted separately in index.ts
// ──────────────────────────────────────────────────────────────────

export const venueApiTokensApp = tokensApp;
export const venueApiPublicApp = publicApp;
