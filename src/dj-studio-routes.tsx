/**
 * DJ STUDIO ROUTES - События и Коллаборации DJ
 * 
 * Endpoints:
 * - GET/POST   /events           - список событий DJ / создание
 * - GET/PUT    /events/:id       - детали / обновление события
 * - DELETE     /events/:id       - удаление события
 * - GET/POST   /collaborations   - коллаборации DJ
 * - PUT        /collaborations/:id/accept  - принять коллаборацию
 * - PUT        /collaborations/:id/decline - отклонить
 * - GET        /notifications    - уведомления DJ
 * - POST       /notifications/read - пометить прочитанным
 * - GET        /plans            - тарифные планы DJ
 * - GET        /subscription/:djId - текущая подписка DJ
 * - POST       /subscription/:djId/change - смена плана
 */

import { Hono } from 'hono';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  getDjProfile, upsertDjProfile,
  djNotificationsStore, djSubscriptionsStore,
  djCampaignsStore, djWithdrawalsStore, djTransactionsStore,
  getCoinBalance,
} from './db.tsx';
import { pool } from './db-client.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { requireAuth, requireRole } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

// Все DJ-эндпоинты требуют роль 'dj' (или admin/superadmin для служебного
// доступа). Без этого артист/радио/заведение с валидным токеном могли
// бы дёрнуть PUT /profile и создать orphan-запись dj_profiles на свой
// userId.
const requireDjRole = requireRole('dj', 'admin', 'superadmin');

// Fallback DJ user ID
const FALLBACK_DJ_USER_ID = 'anonymous';

// Helper: получить userId через единый хелпер авторизации
async function getUserId(c: any): Promise<string> {
  return c.get('userId') || FALLBACK_DJ_USER_ID;
}

function generateId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// dj_events row (row-per-event after migration 036) → внешний API контракт.
// API исторически camelCase + плоский, БД snake_case + extra jsonb для
// неосновных полей. `id` во внешнем API = app_id в БД ('ev-uuid').
type DjEventRow = {
  app_id: string;
  dj_id: string;
  title: string;
  venue: string | null;
  city: string | null;
  event_date: Date | null;
  fee: number;
  capacity: number;
  status: string;
  event_type: string;
  notes: string | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  extra: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

function mapEventRow(row: DjEventRow): Record<string, any> {
  const iso = (d: Date | null) => d ? (d instanceof Date ? d.toISOString() : String(d)) : undefined;
  return {
    ...(row.extra || {}),
    id: row.app_id,
    djId: row.dj_id,
    title: row.title,
    venue: row.venue || '',
    city: row.city || '',
    date: iso(row.event_date),
    fee: row.fee,
    capacity: row.capacity,
    status: row.status,
    type: row.event_type,
    notes: row.notes || undefined,
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function fetchDjEvents(djId: string): Promise<Record<string, any>[]> {
  const r = await pool.query(
    `SELECT app_id, dj_id, title, venue, city, event_date, fee, capacity,
            status, event_type, notes, completed_at, cancelled_at, extra,
            created_at, updated_at
       FROM dj_events
      WHERE dj_id = $1
      ORDER BY event_date DESC NULLS LAST, created_at DESC`,
    [djId]
  );
  return r.rows.map(mapEventRow);
}

// Self-heal dj_collab_invites — row-per-invite table replaces the old
// jsonbStore which stored invites in the SENDER's row (bug — receiver
// never saw the invite). Called from /collaborations endpoints.
let djCollabInvitesSchemaReady: Promise<void> | null = null;
function ensureDjCollabInvitesSchema(): Promise<void> {
  if (djCollabInvitesSchemaReady) return djCollabInvitesSchemaReady;
  djCollabInvitesSchemaReady = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS dj_collab_invites (
          id TEXT PRIMARY KEY,
          from_dj_id TEXT NOT NULL,
          to_dj_id TEXT NOT NULL,
          type TEXT,
          message TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_dj_collab_invites_from ON dj_collab_invites(from_dj_id);
        CREATE INDEX IF NOT EXISTS idx_dj_collab_invites_to ON dj_collab_invites(to_dj_id);
        CREATE INDEX IF NOT EXISTS idx_dj_collab_invites_status ON dj_collab_invites(status);
      `);
    } catch (err) {
      console.error('[dj-studio] ensureDjCollabInvitesSchema failed:', err);
      djCollabInvitesSchemaReady = null;
    }
  })();
  return djCollabInvitesSchemaReady;
}

// Self-heal dj_mixes shape — CREATE TABLE on fresh deploys, ADD COLUMN
// IF NOT EXISTS for existing deployments. Cheap idempotent SQL, called
// from /mixes endpoints so first request after deploy doesn't 500.
let djMixesSchemaReady: Promise<void> | null = null;
function ensureDjMixesSchema(): Promise<void> {
  if (djMixesSchemaReady) return djMixesSchemaReady;
  djMixesSchemaReady = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS dj_mixes (
          id TEXT PRIMARY KEY,
          dj_id TEXT NOT NULL,
          title TEXT,
          genre TEXT,
          duration INTEGER DEFAULT 0,
          plays_count INTEGER DEFAULT 0,
          audio_url TEXT,
          cover_url TEXT,
          description TEXT,
          bpm_range TEXT,
          status TEXT DEFAULT 'published',
          data JSONB DEFAULT '{}'::jsonb,
          moderation_status TEXT DEFAULT 'pending',
          moderated_at TIMESTAMPTZ,
          moderation_comment TEXT,
          rejection_reason TEXT,
          is_hidden BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE dj_mixes
          ADD COLUMN IF NOT EXISTS audio_url TEXT,
          ADD COLUMN IF NOT EXISTS cover_url TEXT,
          ADD COLUMN IF NOT EXISTS description TEXT,
          ADD COLUMN IF NOT EXISTS bpm_range TEXT,
          ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'published',
          ADD COLUMN IF NOT EXISTS moderation_status TEXT,
          ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS moderation_comment TEXT,
          ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
          ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT TRUE;
        -- Backfill старых строк до того как переключим default + NOT NULL
        UPDATE dj_mixes
           SET moderation_status = 'published',
               is_hidden         = FALSE,
               moderated_at      = COALESCE(updated_at, created_at, NOW())
         WHERE moderation_status IS NULL;
        ALTER TABLE dj_mixes
          ALTER COLUMN moderation_status SET DEFAULT 'pending';
        CREATE INDEX IF NOT EXISTS idx_dj_mixes_dj_id ON dj_mixes(dj_id);
        CREATE INDEX IF NOT EXISTS idx_dj_mixes_created_at ON dj_mixes(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_dj_mixes_moderation_status ON dj_mixes(moderation_status);
      `);
    } catch (err) {
      console.error('[dj-studio] ensureDjMixesSchema failed:', err);
      djMixesSchemaReady = null; // allow retry on next request
    }
  })();
  return djMixesSchemaReady;
}

// ════════════════════════════════════════
// PROFILE
// ════════════════════════════════════════

// Wrap a flat-shape blob into the editor's nested envelope so the
// frontend (`DjProfileEditor.tsx`) finds `data.profile.djName`,
// `data.profile.bio`, etc. on first load. Two reasons this matters:
//
//   1. Legacy rows in `dj_profiles.data` that were saved before
//      2026-05-25 may carry the flat shape because the old
//      upsertDjProfile() didn't preserve a nested envelope.
//   2. SQL-seeded accounts (e.g. /tmp/create_test_dj.sql QA seed)
//      stored fields flat — `{ djName, openForBookings, ... }` —
//      and the editor rendered «Имя ещё не задано» because it
//      reads `d.profile.djName` only.
//
// Idempotent: when `blob.profile` is already present we trust it
// and return as-is.
function ensureNestedDjEnvelope(blob: any): any {
  if (!blob || typeof blob !== 'object') return blob;
  if (blob.profile && typeof blob.profile === 'object') return blob;

  // Common editor-side keys; anything else stays where it is.
  const editorProfileKeys = new Set([
    'djName', 'dj_name', 'stageName',
    'bio', 'about',
    'avatarUrl', 'avatar_url', 'coverUrl',
    'city', 'country', 'location',
    'genres', 'tags', 'specializations',
    'hourlyRate', 'ratePerHour', 'ratePerEvent', 'priceFrom',
    'openForBookings', 'isAvailable',
    'experienceYears', 'completedGigs', 'rating',
    'photo', 'photo_url',
  ]);
  const profileBucket: Record<string, any> = {};
  const rest: Record<string, any> = {};
  for (const [k, v] of Object.entries(blob)) {
    if (editorProfileKeys.has(k)) profileBucket[k] = v;
    else rest[k] = v;
  }
  return Object.keys(profileBucket).length > 0
    ? { ...rest, profile: profileBucket }
    : blob;
}

// GET /profile - загрузить профиль DJ
app.get('/profile', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const data = await getDjProfile(userId);

    if (!data) {
      // Отдаём пустой ответ, фронт подставит дефолты
      return c.json({ success: true, data: null });
    }

    return c.json({ success: true, data: ensureNestedDjEnvelope(data) });
  } catch (error) {
    console.error('Error loading DJ profile:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /profile - сохранить профиль DJ
app.put('/profile', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const role = c.get('userRole');
    const body = await c.req.json();

    // Admin-only fields: a regular DJ shouldn't be able to self-verify
    // through PUT /profile (mapRow returns `verified` to the public
    // marketplace). Strip on both levels we support — root and nested.
    if (role !== 'admin' && role !== 'superadmin') {
      if (body && typeof body === 'object') {
        delete body.verified;
        delete body.is_verified;
        if (body.profile && typeof body.profile === 'object') {
          delete body.profile.verified;
        }
      }
    }

    await upsertDjProfile(userId, body);
    return c.json({ success: true, data: body });
  } catch (error) {
    console.error('Error saving DJ profile:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// EVENTS
// ════════════════════════════════════════

// GET /events - список событий DJ
app.get('/events', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const events = await fetchDjEvents(userId);
    return c.json({ success: true, data: events });
  } catch (error) {
    console.error('Error fetching DJ events:', error);
    return c.json({ success: true, data: [] });
  }
});

const EVENT_STATUSES = new Set(['upcoming', 'confirmed', 'completed', 'cancelled']);
const EVENT_TYPES    = new Set(['club', 'festival', 'private', 'stream']);

// POST /events - создать событие
app.post('/events', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    if (!body?.title || typeof body.title !== 'string' || !body.title.trim()) {
      return c.json({ success: false, error: 'title обязателен' }, 400);
    }

    // Enforce DJ-plan «events» quota (Starter=5/mo, Pro=50/mo,
    // Agency=-1 unlimited). Counts events in the SAME calendar month
    // as the requested date — upcoming + completed both count toward
    // the cap, cancelled doesn't.
    const limits = await getDjPlanLimits(String(userId));
    if (limits.events !== -1) {
      const requestedDate = body.date ? new Date(body.date) : new Date();
      const monthStart = new Date(Date.UTC(requestedDate.getUTCFullYear(), requestedDate.getUTCMonth(), 1));
      const monthEnd = new Date(monthStart);
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

      const cnt = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM dj_events
          WHERE dj_id = $1
            AND status != 'cancelled'
            AND event_date >= $2 AND event_date < $3`,
        [userId, monthStart.toISOString(), monthEnd.toISOString()]
      );
      const sameMonth = cnt.rows[0]?.n ?? 0;
      if (sameMonth >= limits.events) {
        return c.json({
          success: false,
          error: `Достигнут лимит событий (${sameMonth}/${limits.events}) на текущем тарифе. Обновите подписку или дождитесь следующего месяца.`,
          limit: limits.events,
          current: sameMonth,
        }, 403);
      }
    }

    const appId = generateId('ev');
    const title    = String(body.title).slice(0, 200).trim();
    const venue    = String(body.venue || '').slice(0, 200);
    const city     = String(body.city || '').slice(0, 100);
    const fee      = Math.max(0, Number(body.fee) || 0);
    const capacity = Math.max(0, Number(body.capacity) || 0);
    const status   = EVENT_STATUSES.has(body.status) ? body.status : 'upcoming';
    const evType   = EVENT_TYPES.has(body.type) ? body.type : 'club';
    const notes    = typeof body.notes === 'string' ? body.notes : null;
    const eventDate = body.date ? new Date(body.date).toISOString() : null;

    // Поля, которых нет в нативных колонках — складываем в `extra` jsonb.
    const KNOWN = new Set([
      'id','title','venue','city','date','fee','capacity','status','type',
      'notes','djId','completedAt','cancelledAt','createdAt','updatedAt',
    ]);
    const extra: Record<string, unknown> = {};
    for (const k of Object.keys(body)) {
      if (!KNOWN.has(k)) extra[k] = body[k];
    }

    const r = await pool.query(
      `INSERT INTO dj_events
         (app_id, dj_id, title, venue, city, event_date, fee, capacity,
          status, event_type, notes, extra, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
       RETURNING app_id, dj_id, title, venue, city, event_date, fee, capacity,
                 status, event_type, notes, completed_at, cancelled_at, extra,
                 created_at, updated_at`,
      [appId, userId, title, venue || null, city || null, eventDate, fee, capacity,
       status, evType, notes, JSON.stringify(extra)]
    );
    return c.json({ success: true, data: mapEventRow(r.rows[0]) }, 201);
  } catch (error) {
    console.error('Error creating DJ event:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /events/:id
app.get('/events/:id', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const eventId = c.req.param('id');
    const r = await pool.query(
      `SELECT app_id, dj_id, title, venue, city, event_date, fee, capacity,
              status, event_type, notes, completed_at, cancelled_at, extra,
              created_at, updated_at
         FROM dj_events
        WHERE app_id = $1 AND dj_id = $2`,
      [eventId, userId]
    );
    if (r.rowCount === 0) return c.json({ success: false, error: 'Event not found' }, 404);
    return c.json({ success: true, data: mapEventRow(r.rows[0]) });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /events/:id
app.put('/events/:id', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const eventId = c.req.param('id');
    const body = await c.req.json();

    // Loaded current row for status-transition stamping + extra merge.
    const cur = await pool.query(
      `SELECT app_id, completed_at, cancelled_at, extra FROM dj_events
        WHERE app_id = $1 AND dj_id = $2`,
      [eventId, userId]
    );
    if (cur.rowCount === 0) return c.json({ success: false, error: 'Event not found' }, 404);

    // Re-clamp like POST does, plus reject any djId reassignment.
    const sets: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    const push = (col: string, val: any) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (typeof body.title === 'string')                                        push('title',       body.title.slice(0, 200));
    if (typeof body.venue === 'string')                                        push('venue',       body.venue.slice(0, 200));
    if (typeof body.city === 'string')                                         push('city',        body.city.slice(0, 100));
    if (body.date !== undefined)                                               push('event_date',  body.date ? new Date(body.date).toISOString() : null);
    if (body.fee !== undefined)                                                push('fee',         Math.max(0, Number(body.fee) || 0));
    if (body.capacity !== undefined)                                           push('capacity',    Math.max(0, Number(body.capacity) || 0));
    if (typeof body.status === 'string' && EVENT_STATUSES.has(body.status))    push('status',      body.status);
    if (typeof body.type === 'string' && EVENT_TYPES.has(body.type))           push('event_type',  body.type);
    if (body.notes !== undefined)                                              push('notes',       typeof body.notes === 'string' ? body.notes : null);

    // Status-transition stamps — synced to updated_at.
    const newStatus = typeof body.status === 'string' && EVENT_STATUSES.has(body.status) ? body.status : undefined;
    if (newStatus === 'completed' && !cur.rows[0].completed_at) push('completed_at', new Date().toISOString());
    if (newStatus === 'cancelled' && !cur.rows[0].cancelled_at) push('cancelled_at', new Date().toISOString());
    if (newStatus === 'upcoming' || newStatus === 'confirmed') {
      push('completed_at', null);
      push('cancelled_at', null);
    }

    // Merge unknown fields into `extra`. djId is silently dropped.
    const KNOWN = new Set([
      'id','title','venue','city','date','fee','capacity','status','type',
      'notes','djId','completedAt','cancelledAt','createdAt','updatedAt',
    ]);
    const extraPatch: Record<string, unknown> = {};
    for (const k of Object.keys(body)) {
      if (!KNOWN.has(k)) extraPatch[k] = body[k];
    }
    if (Object.keys(extraPatch).length > 0) {
      const merged = { ...(cur.rows[0].extra || {}), ...extraPatch };
      push('extra', JSON.stringify(merged));
    }

    params.push(eventId, userId);
    const idxA = params.length - 1;
    const idxB = params.length;
    const r = await pool.query(
      `UPDATE dj_events SET ${sets.join(', ')}
        WHERE app_id = $${idxA} AND dj_id = $${idxB}
       RETURNING app_id, dj_id, title, venue, city, event_date, fee, capacity,
                 status, event_type, notes, completed_at, cancelled_at, extra,
                 created_at, updated_at`,
      params
    );
    return c.json({ success: true, data: mapEventRow(r.rows[0]) });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /events/:id
app.delete('/events/:id', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const eventId = c.req.param('id');
    await pool.query(
      `DELETE FROM dj_events WHERE app_id = $1 AND dj_id = $2`,
      [eventId, userId]
    );
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// COLLABORATIONS
// ════════════════════════════════════════

// Helper: enrich invite row with display fields from dj_profiles for the
// "other" party (from the caller's perspective).
async function enrichInvite(row: any, viewerId: string) {
  const otherId = row.from_dj_id === viewerId ? row.to_dj_id : row.from_dj_id;
  let other: any = { djId: otherId, djName: '', djCity: '', rating: 0, genres: [] };
  try {
    const { rows } = await pool.query(
      `SELECT id, dj_name, location, genres, rating, data
         FROM dj_profiles WHERE id = $1 OR user_id = $1 LIMIT 1`,
      [otherId]
    );
    if (rows[0]) {
      const d = rows[0].data || {};
      const p = d.profile || d;
      other.djName = rows[0].dj_name || p.djName || '';
      other.djCity = rows[0].location || p.city || '';
      other.genres = rows[0].genres || p.genres || [];
      other.rating = parseFloat(rows[0].rating) || 0;
    }
  } catch { /* fall through with bare otherId */ }

  const direction = row.from_dj_id === viewerId ? 'outgoing' : 'incoming';
  // UI status mapping (incoming-pending shows as 'incoming' for the tab).
  let uiStatus = row.status;
  if (row.status === 'pending') uiStatus = direction === 'incoming' ? 'incoming' : 'outgoing';

  return {
    id: row.id,
    fromDjId: row.from_dj_id,
    toDjId: row.to_dj_id,
    direction,
    djId: otherId,
    djName: other.djName,
    djCity: other.djCity,
    genres: other.genres,
    rating: other.rating,
    type: row.type || 'b2b',
    message: row.message || '',
    status: uiStatus,            // incoming | outgoing | accepted | declined | cancelled
    rawStatus: row.status,
    reason: row.reason || '',
    date: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /collaborations — all invites involving the caller (incoming + outgoing)
app.get('/collaborations', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    await ensureDjCollabInvitesSchema();
    const { rows } = await pool.query(
      `SELECT id, from_dj_id, to_dj_id, type, message, status, reason,
              created_at, updated_at
         FROM dj_collab_invites
        WHERE from_dj_id = $1 OR to_dj_id = $1
        ORDER BY created_at DESC LIMIT 200`,
      [userId]
    );
    const enriched = await Promise.all(rows.map(r => enrichInvite(r, userId)));
    return c.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Error fetching DJ collaborations:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /collaborations — invite a target DJ to collaborate.
// Body: { toDjId, type?, message? }
app.post('/collaborations', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const toDjId = String(body.toDjId || body.targetDjId || '').trim();
    if (!toDjId) return c.json({ success: false, error: 'toDjId обязателен' }, 400);
    if (toDjId === userId) return c.json({ success: false, error: 'Нельзя пригласить самого себя' }, 400);

    const allowedTypes = new Set(['b2b', 'remix', 'event', 'mentorship']);
    const type = allowedTypes.has(body.type) ? body.type : 'b2b';
    const message = String(body.message || '').slice(0, 2000);

    await ensureDjCollabInvitesSchema();

    // Verify target is an actual DJ profile (don't let invites pile up
    // orphaned against non-existent userIds).
    const targetExists = await pool.query(
      `SELECT 1 FROM dj_profiles WHERE id = $1 OR user_id = $1 LIMIT 1`,
      [toDjId]
    );
    if (targetExists.rowCount === 0) {
      return c.json({ success: false, error: 'DJ-получатель не найден' }, 404);
    }

    // Dedupe: don't create another pending invite to the same DJ.
    const dup = await pool.query(
      `SELECT id FROM dj_collab_invites
        WHERE from_dj_id = $1 AND to_dj_id = $2 AND status = 'pending'
        LIMIT 1`,
      [userId, toDjId]
    );
    if (dup.rows.length > 0) {
      return c.json({ success: false, error: 'Активный инвайт этому DJ уже есть' }, 409);
    }

    const id = generateId('collab');
    await pool.query(
      `INSERT INTO dj_collab_invites (id, from_dj_id, to_dj_id, type, message, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [id, userId, toDjId, type, message || null]
    );

    // Notify recipient (cross-cabinet — SSE + persisted)
    try {
      const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
      await notifyCrossCabinet({
        targetUserId: toDjId,
        targetRole: 'dj',
        sourceRole: 'dj',
        type: 'collab_offer',
        title: 'Новое предложение коллаборации',
        message: message || `Тип: ${type}`,
        metadata: { inviteId: id, fromDjId: userId, type },
      });
    } catch (e: any) {
      console.warn('[dj-collab] notifyCrossCabinet failed:', e?.message);
    }

    const { rows } = await pool.query(
      `SELECT id, from_dj_id, to_dj_id, type, message, status, reason, created_at, updated_at
         FROM dj_collab_invites WHERE id = $1`,
      [id]
    );
    const out = await enrichInvite(rows[0], userId);
    return c.json({ success: true, data: out }, 201);
  } catch (error) {
    console.error('Error creating DJ collab invite:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /collaborations/:id/accept — only the recipient can accept.
app.put('/collaborations/:id/accept', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const inviteId = c.req.param('id');
    await ensureDjCollabInvitesSchema();
    const res = await pool.query(
      `UPDATE dj_collab_invites
          SET status = 'accepted', updated_at = NOW()
        WHERE id = $1 AND to_dj_id = $2 AND status = 'pending'
        RETURNING id, from_dj_id, to_dj_id, type, message, status, reason, created_at, updated_at`,
      [inviteId, userId]
    );
    if (res.rowCount === 0) {
      return c.json({ success: false, error: 'Инвайт не найден или у вас нет прав' }, 404);
    }
    const row = res.rows[0];

    try {
      const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
      await notifyCrossCabinet({
        targetUserId: row.from_dj_id,
        targetRole: 'dj',
        sourceRole: 'dj',
        type: 'collab_response',
        title: 'Ваше предложение коллаборации принято',
        message: '',
        metadata: { inviteId, response: 'accepted' },
      });
    } catch { /* best-effort */ }

    const out = await enrichInvite(row, userId);
    return c.json({ success: true, data: out });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /collaborations/:id/decline — only the recipient can decline.
app.put('/collaborations/:id/decline', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const inviteId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const reason = String((body as any).reason || '').slice(0, 500);
    await ensureDjCollabInvitesSchema();
    const res = await pool.query(
      `UPDATE dj_collab_invites
          SET status = 'declined', reason = $3, updated_at = NOW()
        WHERE id = $1 AND to_dj_id = $2 AND status = 'pending'
        RETURNING id, from_dj_id, to_dj_id, type, message, status, reason, created_at, updated_at`,
      [inviteId, userId, reason || null]
    );
    if (res.rowCount === 0) {
      return c.json({ success: false, error: 'Инвайт не найден или у вас нет прав' }, 404);
    }
    const row = res.rows[0];

    try {
      const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
      await notifyCrossCabinet({
        targetUserId: row.from_dj_id,
        targetRole: 'dj',
        sourceRole: 'dj',
        type: 'collab_response',
        title: 'Ваше предложение коллаборации отклонено',
        message: reason || '',
        metadata: { inviteId, response: 'declined' },
      });
    } catch { /* best-effort */ }

    const out = await enrichInvite(row, userId);
    return c.json({ success: true, data: out });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /collaborations/:id — sender cancels a pending invite of his own.
app.delete('/collaborations/:id', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const inviteId = c.req.param('id');
    await ensureDjCollabInvitesSchema();
    const res = await pool.query(
      `UPDATE dj_collab_invites
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND from_dj_id = $2 AND status = 'pending'
        RETURNING from_dj_id, to_dj_id`,
      [inviteId, userId]
    );
    if (res.rowCount === 0) {
      return c.json({ success: false, error: 'Инвайт не найден или уже обработан' }, 404);
    }
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════

// GET /notifications
app.get('/notifications', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const notifications = await djNotificationsStore.get(userId) || [];
    return c.json({ success: true, data: notifications });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// POST /notifications/read
app.post('/notifications/read', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const { ids } = body;

    const notifications = (await djNotificationsStore.get(userId)) || [];
    for (const n of notifications) {
      if (!ids || ids.includes(n.id)) {
        n.read = true;
      }
    }
    await djNotificationsStore.set(userId, notifications);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// TARIFF PLANS & SUBSCRIPTIONS
// ════════════════════════════════════════

const DJ_PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: 0,
    priceYear: 0,
    currency: '₽',
    description: 'Базовый бесплатный план для начинающих DJ',
    features: [
      'Профиль на маркетплейсе',
      'До 5 промо-миксов',
      'До 5 букингов/мес',
      'Базовая аналитика',
    ],
    limits: { mixes: 5, events: 5, analytics: 'basic' },
    popular: false,
    color: 'slate',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 990,
    priceYear: 9900,
    currency: '₽',
    description: 'Профессиональный план для активных DJ',
    features: [
      'Всё из Starter',
      'До 20 промо-миксов',
      'Расширенная аналитика',
      'Приоритет в поиске',
      'Верификация профиля',
      'Продвижение на радио',
    ],
    limits: { mixes: 20, events: 50, analytics: 'advanced' },
    popular: true,
    color: 'purple',
  },
  {
    id: 'agency',
    name: 'Agency',
    price: 2990,
    priceYear: 29900,
    currency: '₽',
    description: 'Максимальный план для агентств и топ DJ',
    features: [
      'Всё из Pro',
      'Безлимитные миксы',
      'Полная аналитика + API',
      'Топ позиция в поиске',
      'Персональный менеджер',
      'Мультиаккаунт (до 5 DJ)',
      'Брендированная страница',
    ],
    limits: { mixes: -1, events: -1, analytics: 'full' },
    popular: false,
    color: 'amber',
  },
];

// GET /plans - тарифные планы
app.get('/plans', requireAuth, requireDjRole, async (c) => {
  return c.json({ success: true, data: DJ_PLANS });
});

// GET /subscription/:djId - текущая подписка DJ
app.get('/subscription/:djId', requireAuth, requireDjRole, async (c) => {
  try {
    const djId = c.req.param('djId');
    const sub = await djSubscriptionsStore.get(djId);

    if (!sub) {
      // По умолчанию - бесплатный Starter
      const defaultSub = {
        djId,
        planId: 'starter',
        planName: 'Starter',
        status: 'active',
        price: 0,
        currency: '₽',
        interval: 'month',
        startDate: new Date().toISOString(),
        endDate: null,
        limits: DJ_PLANS[0].limits,
      };
      return c.json({ success: true, data: defaultSub });
    }

    return c.json({ success: true, data: subscriptionView(sub) });
  } catch (error) {
    console.error('Error fetching DJ subscription:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /subscription/:djId/change - смена плана
app.post('/subscription/:djId/change', requireAuth, requireDjRole, async (c) => {
  try {
    const djId = c.req.param('djId');
    const body = await c.req.json();
    const { planId, interval = 'month' } = body;

    const plan = DJ_PLANS.find(p => p.id === planId);
    if (!plan) {
      return c.json({ success: false, error: 'Plan not found' }, 404);
    }

    const now = new Date();
    const endDate = new Date(now);
    if (interval === 'year') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setMonth(endDate.getMonth() + 1);
    }

    const subscription = {
      djId,
      planId: plan.id,
      planName: plan.name,
      status: 'active',
      price: interval === 'year' ? plan.priceYear : plan.price,
      currency: plan.currency,
      interval,
      startDate: now.toISOString(),
      endDate: endDate.toISOString(),
      limits: plan.limits,
    };

    await djSubscriptionsStore.set(djId, subscription);

    // Записать доход платформы при платных планах
    if (plan.price > 0) {
      try {
        const grossAmount = interval === 'year' ? plan.priceYear : plan.price;
        await recordRevenue({
          channel: 'dj_subscription',
          description: `DJ подписка ${plan.name} (${interval}): ${djId}`,
          grossAmount,
          platformRevenue: grossAmount, // подписки = 100% доход платформы
          payoutAmount: 0,
          commissionRate: 1.0,
          payerId: djId,
          payerName: djId,
        });
      } catch (revErr) {
        console.error('Revenue recording failed (non-critical):', revErr);
      }
    }

    console.log(`DJ ${djId} changed plan to ${plan.name} (${interval})`);
    return c.json({ success: true, data: subscription });
  } catch (error) {
    console.error('Error changing DJ subscription:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// COINS
// ════════════════════════════════════════

// GET /coins/balance — баланс коинов DJ (используется в сайдбаре)
app.get('/coins/balance', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const bal = await getCoinBalance(userId);
    return c.json({ success: true, data: { balance: Number(bal?.balance ?? 0) } });
  } catch (error) {
    console.error('Error fetching DJ coins balance:', error);
    return c.json({ success: true, data: { balance: 0 } });
  }
});

// ════════════════════════════════════════
// DASHBOARD STATS
// ════════════════════════════════════════

// GET /dashboard/stats — агрегированная статистика для главной DJ-кабинета
app.get('/dashboard/stats', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    await ensureDjMixesSchema();
    // dj_mixes / dj_reviews — row-per-record таблицы (не jsonbStore).
    // Считаем агрегаты прямо в SQL.
    const mixesAggPromise = pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(plays_count), 0)::int AS plays
         FROM dj_mixes WHERE dj_id = $1`,
      [userId]
    ).catch(() => ({ rows: [{ cnt: 0, plays: 0 }] }));
    const reviewsAggPromise = pool.query(
      `SELECT AVG(rating)::numeric(4,2) AS avg
         FROM dj_reviews WHERE dj_id = $1 AND rating > 0`,
      [userId]
    ).catch(() => ({ rows: [{ avg: 0 }] }));

    const [mixesAgg, reviewsAgg, events, planLimits] = await Promise.all([
      mixesAggPromise,
      reviewsAggPromise,
      fetchDjEvents(userId).catch(() => []),
      getDjPlanLimits(String(userId)).catch(() => DJ_PLANS[0].limits),
    ]);
    const mixesCount = Number(mixesAgg.rows?.[0]?.cnt || 0);
    const totalPlays = Number(mixesAgg.rows?.[0]?.plays || 0);
    const avgRating = Number(reviewsAgg.rows?.[0]?.avg || 0);
    const eventsArr: any[] = Array.isArray(events) ? events : [];

    const completedEvents = eventsArr.filter((e: any) => e.status === 'completed');
    const upcomingEvents = eventsArr.filter((e: any) => e.status === 'upcoming' || e.status === 'confirmed');
    const totalEarnings = completedEvents.reduce((s, e: any) => s + (e.fee || 0), 0);

    // followers — берём из mix-subscribers (best-effort), иначе 0
    let followers = 0;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM dj_followers WHERE dj_id = $1`,
        [userId]
      );
      followers = rows[0]?.n || 0;
    } catch {
      // таблица может отсутствовать
    }

    return c.json({
      success: true,
      data: {
        mixesCount,
        listens: totalPlays,
        bookingsCount: upcomingEvents.length,
        earnings: totalEarnings,
        rating: Number(avgRating.toFixed(2)),
        followers,
        analyticsLevel: String(planLimits?.analytics || 'basic'),
      },
    });
  } catch (error) {
    console.error('Error building DJ dashboard stats:', error);
    return c.json({
      success: true,
      data: { mixesCount: 0, listens: 0, bookingsCount: 0, earnings: 0, rating: 0, followers: 0, analyticsLevel: 'basic' },
    });
  }
});

// ════════════════════════════════════════
// FINANCES
// ════════════════════════════════════════

const COMMISSION_RATE = 0.15;

function inCurrentMonth(iso: string | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

// GET /finances/overview — балансы DJ (рассчитываются из событий + транзакций)
app.get('/finances/overview', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const [events, withdrawals, txs, planLimits] = await Promise.all([
      fetchDjEvents(userId).catch(() => []),
      djWithdrawalsStore.get(userId).catch(() => []),
      djTransactionsStore.get(userId).catch(() => []),
      getDjPlanLimits(String(userId)).catch(() => DJ_PLANS[0].limits),
    ]);
    const eventsArr: any[] = Array.isArray(events) ? events : [];
    const withdrawalsArr: any[] = Array.isArray(withdrawals) ? withdrawals : [];
    const txsArr: any[] = Array.isArray(txs) ? txs : [];

    const completed = eventsArr.filter((e: any) => e.status === 'completed');
    const pending = eventsArr.filter((e: any) => e.status === 'upcoming' || e.status === 'confirmed');

    const totalEarned = completed.reduce((s: number, e: any) => s + (e.fee || 0), 0);
    const pendingAmount = pending.reduce((s: number, e: any) => s + (e.fee || 0), 0);
    const totalWithdrawn = withdrawalsArr
      .filter((w: any) => w.status === 'completed' || w.status === 'paid')
      .reduce((s: number, w: any) => s + (w.amount || 0), 0);
    const available = Math.max(0, totalEarned - totalWithdrawn);

    const monthEarnings = completed
      .filter((e: any) => inCurrentMonth(e.completedAt || e.date))
      .reduce((s: number, e: any) => s + (e.fee || 0), 0);
    const monthBookings = eventsArr.filter((e: any) => inCurrentMonth(e.date)).length;

    return c.json({
      success: true,
      data: {
        available,
        pending: pendingAmount,
        total: available + pendingAmount,
        monthEarnings,
        monthBookings,
        commissionRate: COMMISSION_RATE,
        totalEarned,
        totalWithdrawn,
        transactionsCount: txsArr.length,
        analyticsLevel: String(planLimits?.analytics || 'basic'),
      },
    });
  } catch (error) {
    console.error('Error fetching DJ finances overview:', error);
    return c.json({
      success: true,
      data: {
        available: 0, pending: 0, total: 0,
        monthEarnings: 0, monthBookings: 0,
        commissionRate: COMMISSION_RATE,
        totalEarned: 0, totalWithdrawn: 0, transactionsCount: 0,
        analyticsLevel: 'basic',
      },
    });
  }
});

// GET /finances/transactions — история транзакций (события + явные tx-записи)
app.get('/finances/transactions', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const [events, txs, planLimits] = await Promise.all([
      fetchDjEvents(userId).catch(() => []),
      djTransactionsStore.get(userId).catch(() => []),
      getDjPlanLimits(String(userId)).catch(() => DJ_PLANS[0].limits),
    ]);
    const eventsArr: any[] = Array.isArray(events) ? events : [];
    const txsArr: any[] = Array.isArray(txs) ? txs : [];

    // События-как-транзакции: completed → income, остальные → pending
    const eventTxs = eventsArr
      .filter((e: any) => e.fee && e.fee > 0)
      .map((e: any) => ({
        id: `event:${e.id}`,
        type: e.status === 'completed' ? 'income' : 'pending',
        label: e.title && e.venue ? `${e.title} @ ${e.venue}` : e.title || 'Букинг',
        amount: e.fee || 0,
        date: e.completedAt || e.date,
        status: e.status === 'completed' ? 'completed' : 'pending',
        source: 'event',
      }));

    const explicitTxs = txsArr.map((t: any) => ({
      id: t.id || `tx:${crypto.randomUUID()}`,
      type: t.type || 'income',
      label: t.label || t.description || 'Транзакция',
      amount: t.amount || 0,
      date: t.date || t.createdAt,
      status: t.status || 'completed',
      source: t.source || 'manual',
    }));

    const combined = [...eventTxs, ...explicitTxs].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });

    // Analytics-tier gating: `basic` (Starter) sees current month
    // only; `advanced`/`full` (Pro/Agency) see the full history.
    // The cap on historical data is the only concrete capability
    // sold by the «Расширенная аналитика» feature line on the
    // pricing card. The UI gets `analyticsLevel` + `truncated` so
    // it can show a «Полная история — на Pro» CTA.
    const analyticsLevel = String(planLimits?.analytics || 'basic');
    let payload = combined;
    let truncated = false;
    if (analyticsLevel === 'basic') {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const cutoff = monthStart.getTime();
      const before = combined.length;
      payload = combined.filter((t) => {
        if (!t.date) return true;
        const ts = new Date(t.date).getTime();
        if (!Number.isFinite(ts)) return true;
        return ts >= cutoff;
      });
      truncated = payload.length < before;
    }

    return c.json({
      success: true,
      data: payload,
      meta: { analyticsLevel, truncated, totalAvailable: combined.length },
    });
  } catch (error) {
    console.error('Error fetching DJ transactions:', error);
    return c.json({ success: true, data: [], meta: { analyticsLevel: 'basic', truncated: false, totalAvailable: 0 } });
  }
});

// GET /finances/withdrawals — выплаты
app.get('/finances/withdrawals', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const list = (await djWithdrawalsStore.get(userId)) || [];
    return c.json({ success: true, data: Array.isArray(list) ? list : [] });
  } catch (error) {
    console.error('Error fetching DJ withdrawals:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /finances/withdrawals — запрос вывода (создаёт YooKassa Payout)
app.post('/finances/withdrawals', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const amount = Number(body.amount || 0);
    const method = String(body.method || 'sbp');

    if (!(amount >= 500)) {
      return c.json({ success: false, error: 'Минимальная сумма вывода — 500 ₽' }, 400);
    }
    if (!['sbp', 'yoomoney', 'card'].includes(method)) {
      return c.json({ success: false, error: 'Недопустимый способ вывода' }, 400);
    }

    // Валидация реквизитов по методу
    let destination: any;
    let destinationLabel = '';
    if (method === 'sbp') {
      const phone = String(body.phone || '').trim();
      if (!/^\+?\d{10,15}$/.test(phone.replace(/\s/g, ''))) {
        return c.json({ success: false, error: 'Укажите телефон в формате +7…' }, 400);
      }
      destination = { type: 'sbp', phone };
      destinationLabel = `СБП ${phone.replace(/(\+\d{1,3})\d+(\d{4})/, '$1***$2')}`;
    } else if (method === 'yoomoney') {
      const account = String(body.account || '').replace(/\D/g, '');
      if (!/^\d{11,20}$/.test(account)) {
        return c.json({ success: false, error: 'Укажите номер кошелька ЮMoney (только цифры)' }, 400);
      }
      destination = { type: 'yoo_money', account };
      destinationLabel = `ЮMoney …${account.slice(-4)}`;
    } else {
      // card — требует payoutToken (PCI-токен от виджета ЮКассы на фронте)
      const payoutToken = String(body.payoutToken || '');
      const cardLast4 = String(body.cardLast4 || '').slice(0, 4);
      if (!payoutToken) {
        return c.json({
          success: false,
          error: 'Для вывода на карту нужен payoutToken (токенизация через ЮКасса-виджет)',
        }, 400);
      }
      destination = { type: 'bank_card', payoutToken };
      destinationLabel = cardLast4 ? `Карта …${cardLast4}` : 'Карта';
    }

    // Проверим доступный баланс — резервируем под все pending/succeeded заявки
    const events = await fetchDjEvents(userId);
    const withdrawalsExisting = (await djWithdrawalsStore.get(userId)) || [];
    const totalEarned = (events as any[])
      .filter((e: any) => e.status === 'completed')
      .reduce((s: number, e: any) => s + (e.fee || 0), 0);
    const reservedStatuses = new Set(['pending', 'succeeded', 'paid', 'completed']);
    const totalReserved = (withdrawalsExisting as any[])
      .filter((w: any) => reservedStatuses.has(w.status))
      .reduce((s: number, w: any) => s + (w.amount || 0), 0);
    const available = Math.max(0, totalEarned - totalReserved);
    if (amount > available) {
      return c.json({ success: false, error: `Недостаточно средств. Доступно: ${available} ₽` }, 400);
    }

    const id = generateId('wd');
    const now = new Date().toISOString();

    // Сначала пробуем создать выплату — только при успехе записываем в БД
    let payoutId = '';
    let payoutStatus: 'pending' | 'succeeded' | 'canceled' = 'pending';
    try {
      const { createYooKassaPayout } = await import('./gateway-yookassa-payouts.tsx');
      const result = await createYooKassaPayout({
        amountRub: amount,
        destination,
        description: `Выплата DJ ${userId}`,
        idempotenceKey: id,
        metadata: { withdrawal_id: id, dj_id: userId },
      });
      payoutId = result.id;
      payoutStatus = (result.status as any) === 'succeeded' ? 'succeeded'
        : (result.status as any) === 'canceled' ? 'canceled' : 'pending';
    } catch (payoutErr: any) {
      console.error('YooKassa payout failed:', payoutErr);
      // Логируем failed-заявку — DJ должен видеть, что произошло
      const failed = {
        id, djId: userId, amount, method,
        destinationLabel,
        status: 'failed' as const,
        requestedAt: now, createdAt: now,
        error: payoutErr?.message || 'Не удалось создать выплату',
      };
      const list = Array.isArray(withdrawalsExisting) ? withdrawalsExisting : [];
      list.unshift(failed);
      await djWithdrawalsStore.set(userId, list);
      return c.json({ success: false, error: failed.error }, 502);
    }

    const withdrawal = {
      id,
      djId: userId,
      amount,
      method,
      destinationLabel,
      status: payoutStatus,
      yooPayoutId: payoutId,
      requestedAt: now,
      createdAt: now,
    };
    const list = Array.isArray(withdrawalsExisting) ? withdrawalsExisting : [];
    list.unshift(withdrawal);
    await djWithdrawalsStore.set(userId, list);

    return c.json({ success: true, data: withdrawal }, 201);
  } catch (error) {
    console.error('Error creating DJ withdrawal:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// PROMOTION — pitches & campaigns
// ════════════════════════════════════════

// GET /promotion/pitches — питчи миксов (на модерацию админа, как у артиста)
app.get('/promotion/pitches', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    // Гарантируем, что таблица + колонки существуют (на случай первого запроса
    // ещё до прогона миграции 006).
    await pool.query(`
      ALTER TABLE IF EXISTS pitching_submissions
        ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'artist',
        ADD COLUMN IF NOT EXISTS mix_id TEXT
    `).catch(() => {});

    const { rows } = await pool.query(
      `SELECT id, submission_type, target_id, target_name, mix_id, message,
              status, moderator_response, created_at, updated_at
         FROM pitching_submissions
        WHERE user_id = $1 AND actor_role = 'dj'
        ORDER BY created_at DESC
        LIMIT 200`,
      [userId]
    );

    // Денормализация имени микса — одним запросом по уникальным mix_id
    const mixIds: string[] = Array.from(new Set(rows.map((r: any) => r.mix_id).filter(Boolean)));
    const titleByMix: Record<string, string> = {};
    if (mixIds.length > 0) {
      const { rows: mixRows } = await pool.query(
        `SELECT id, title FROM dj_mixes WHERE id = ANY($1::text[])`,
        [mixIds]
      );
      mixRows.forEach((m: any) => { titleByMix[m.id] = m.title; });
    }

    const data = rows.map((r: any) => ({
      id: r.id,
      mixId: r.mix_id || '',
      mixTitle: titleByMix[r.mix_id] || 'Микс',
      targetType: r.submission_type === 'venue' ? 'venue' : 'radio',
      targetId: r.target_id,
      targetName: r.target_name || '',
      message: r.message || '',
      status: r.status,
      moderatorResponse: r.moderator_response || '',
      sentAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return c.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching DJ pitches:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /promotion/pitches — создать питч (на модерацию админу)
app.post('/promotion/pitches', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const mixId: string = String(body.mixId || '');
    const targetType: 'radio' | 'venue' = body.targetType === 'venue' ? 'venue' : 'radio';
    const targetId: string = String(body.targetId || '');
    const message: string = String(body.message || '').slice(0, 2000);

    if (!mixId) return c.json({ success: false, error: 'mixId обязателен' }, 400);
    if (!targetId) return c.json({ success: false, error: 'targetId обязателен' }, 400);

    await pool.query(`
      ALTER TABLE IF EXISTS pitching_submissions
        ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'artist',
        ADD COLUMN IF NOT EXISTS mix_id TEXT
    `).catch(() => {});

    // Lookup target name (radio_profiles / venue_profiles)
    let targetName = '';
    let targetListeners: number | undefined;
    try {
      const table = targetType === 'venue' ? 'venue_profiles' : 'radio_profiles';
      const { rows } = await pool.query(
        `SELECT data FROM ${table} WHERE user_id = $1 OR id = $1 LIMIT 1`,
        [targetId]
      );
      const d = rows[0]?.data || {};
      if (targetType === 'venue') {
        targetName = d.venue_name || d.venueName || d.name || 'Заведение';
      } else {
        targetName = d.station_name || d.stationName || d.name || 'Радиостанция';
        const raw = d.listeners_count ?? d.listeners;
        const n = typeof raw === 'number' ? raw : parseInt(String(raw || '').replace(/\D/g, ''), 10);
        if (Number.isFinite(n) && n > 0) targetListeners = n;
      }
    } catch (lookupErr) {
      console.warn('Pitch target lookup failed:', lookupErr);
    }

    // Verify the mix actually belongs to the caller (a DJ shouldn't be
    // able to pitch someone else's mix). Falls open ONLY when the table
    // can't be queried (fresh deploy) — the check kicks in as soon as
    // the mix table is reachable.
    let mixTitle = 'Микс';
    try {
      await ensureDjMixesSchema();
      const { rows: mr } = await pool.query(
        `SELECT title FROM dj_mixes WHERE id = $1 AND dj_id = $2 LIMIT 1`,
        [mixId, userId]
      );
      if (mr.length === 0) {
        return c.json({ success: false, error: 'Микс не найден в вашей библиотеке' }, 404);
      }
      if (mr[0]?.title) mixTitle = mr[0].title;
    } catch (e) {
      console.warn('[dj-pitch] mix ownership check skipped:', e);
    }

    // Prevent dup pending submission
    const dup = await pool.query(
      `SELECT id FROM pitching_submissions
        WHERE user_id = $1 AND target_id = $2 AND COALESCE(mix_id,'') = $3
          AND status = 'pending' AND actor_role = 'dj'`,
      [userId, targetId, mixId]
    );
    if (dup.rows.length > 0) {
      return c.json({ success: false, error: 'Заявка уже отправлена и ждёт модерации' }, 409);
    }

    const id = generateId('pitch');
    await pool.query(
      `INSERT INTO pitching_submissions
         (id, user_id, submission_type, target_id, target_name, mix_id, message, status, actor_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'dj')`,
      [id, userId, targetType, targetId, targetName, mixId, message || null]
    );

    // Notify admins
    try {
      const { notifyAllAdmins } = await import('./cross-cabinet-notify.tsx');
      await notifyAllAdmins({
        sourceRole: 'dj',
        type: 'admin_action',
        title: targetType === 'venue'
          ? 'DJ: новая заявка в заведение'
          : 'DJ: новая заявка на радио',
        message: `«${mixTitle}» → «${targetName || targetId}»`,
        link: 'pitching-moderation',
        metadata: { submissionId: id, actorRole: 'dj', submissionType: targetType, targetId, mixId },
      });
    } catch (e: any) {
      console.warn('[dj pitch] notifyAllAdmins failed:', e?.message);
    }

    const now = new Date().toISOString();
    return c.json({
      success: true,
      data: {
        id,
        mixId,
        mixTitle,
        targetType,
        targetId,
        targetName,
        targetListeners,
        message,
        status: 'pending',
        sentAt: now,
        updatedAt: now,
      },
    }, 201);
  } catch (error) {
    console.error('Error creating DJ pitch:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /promotion/campaigns — рекламные кампании
app.get('/promotion/campaigns', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const list = (await djCampaignsStore.get(userId)) || [];
    return c.json({ success: true, data: Array.isArray(list) ? list : [] });
  } catch (error) {
    console.error('Error fetching DJ campaigns:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /promotion/campaigns — создать кампанию
app.post('/promotion/campaigns', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const allowedTypes = new Set(['banner', 'social', 'email']);
    const type = allowedTypes.has(body.type) ? body.type : 'banner';

    const id = generateId('camp');
    const now = new Date().toISOString();
    const campaign = {
      id,
      djId: userId,
      title: String(body.title || 'Без названия').slice(0, 200),
      type,
      status: 'active',
      impressions: 0,
      clicks: 0,
      budget: Math.max(0, Number(body.budget || 0)),
      spent: 0,
      mixId: body.mixId || null,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const list = (await djCampaignsStore.get(userId)) || [];
    const arr = Array.isArray(list) ? list : [];
    arr.unshift(campaign);
    await djCampaignsStore.set(userId, arr);

    return c.json({ success: true, data: campaign }, 201);
  } catch (error) {
    console.error('Error creating DJ campaign:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// UPLOADS — avatar, cover, mixes, portfolio
// ════════════════════════════════════════

const UPLOADS_BASE = process.env.UPLOADS_DIR || '/opt/promofm-api/uploads';
const PUBLIC_BASE = process.env.PUBLIC_UPLOADS_BASE_URL || 'https://promo-music.ru/server/uploads';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;       // 8 MB
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;     // 200 MB (DJ mixes can be long)
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;     // 100 MB

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v']);

function sanitizeExt(name: string | undefined, allowed: Set<string>): string | null {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  return allowed.has(ext) ? ext : null;
}

// ─── Whitelist жанров для DJ-миксов ────────────────────────────────
// Зеркало datalist'а #dj-genres-list во фронте (DjMixManager.tsx).
// Сравнение case-insensitive: 'house' === 'House' === 'HOUSE'. Если
// добавляешь жанр сюда — синхронно добавь в datalist на фронте.
const DJ_MIX_GENRES = new Set([
  'house', 'deep house', 'tech house', 'progressive house',
  'future house', 'bass house', 'afro house', 'melodic house',
  'techno', 'melodic techno', 'minimal techno', 'hard techno',
  'trance', 'progressive trance', 'psy-trance', 'uplifting trance',
  'drum & bass', 'liquid dnb', 'neurofunk', 'jungle',
  'dubstep', 'riddim', 'trap', 'hardstyle',
  'disco', 'nu disco', 'funk', 'electro',
  'breakbeat', 'uk garage', 'garage house', 'speed garage',
  'ambient', 'downtempo', 'chillout', 'lo-fi',
  'hip-hop', 'r&b', 'soul', 'latin',
  'mashup', 'open format', 'top 40', 'edm',
]);

/** Возвращает нормализованный жанр (как был введён, но trimmed) или
 *  false если жанр не в whitelist. Пустой жанр возвращает '' — допустим. */
function validateMixGenre(input: string): string | false {
  const trimmed = input.trim();
  if (!trimmed) return '';
  return DJ_MIX_GENRES.has(trimmed.toLowerCase()) ? trimmed : false;
}

/** BPM: пустая строка → ''. Число в диапазоне 40-220 → строка с числом.
 *  Иначе false (валидация провалена). */
function validateMixBpm(input: string): string | false {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (!/^\d{2,3}$/.test(trimmed)) return false;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 40 || n > 220) return false;
  return String(n);
}

async function saveUpload(file: File, subdir: string, prefix: string, allowed: Set<string>, maxBytes: number) {
  if (file.size > maxBytes) {
    throw new Error(`Файл слишком большой (макс. ${Math.round(maxBytes / 1024 / 1024)} МБ)`);
  }
  const ext = sanitizeExt(file.name, allowed);
  if (!ext) throw new Error('Недопустимый формат файла');
  const dir = path.join(UPLOADS_BASE, subdir);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${prefix}-${crypto.randomUUID()}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(path.join(dir, filename), buf);
  return {
    filename,
    url: `${PUBLIC_BASE}/${subdir}/${filename}`,
    size: file.size,
    ext,
  };
}

// POST /profile/avatar — загрузить аватар DJ
app.post('/profile/avatar', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);

    const uploaded = await saveUpload(file, 'dj-avatars', `avatar-${userId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);

    const data: any = (await getDjProfile(userId)) || {};
    if (!data.profile) data.profile = {};
    data.profile.avatarUrl = uploaded.url;
    await upsertDjProfile(userId, data);

    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('DJ avatar upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

// POST /profile/cover — загрузить обложку
app.post('/profile/cover', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);

    const uploaded = await saveUpload(file, 'dj-covers', `cover-${userId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);

    const data: any = (await getDjProfile(userId)) || {};
    if (!data.profile) data.profile = {};
    data.profile.coverUrl = uploaded.url;
    await upsertDjProfile(userId, data);

    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('DJ cover upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

// POST /portfolio/upload — загрузить файл в портфолио DJ.
// Поддерживаются аудио (миксы/треки), видео (живые сеты, клипы) и
// изображения (афиши, фото с площадок). Тип определяется по расширению,
// не по MIME (юзер может ребрендить .jpg → .png и т.п. — расширение
// надёжнее в кросс-браузерных drop-event'ах).
app.post('/portfolio/upload', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    const categoryId = String(body.categoryId || 'misc');
    const displayName = String(body.name || file?.name || 'Файл');
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);

    // Определяем тип по расширению. sanitizeExt возвращает санитизированное
    // расширение если оно в allowlist'е, иначе false.
    const isVideo = sanitizeExt(file.name, VIDEO_EXTS);
    const isImage = !isVideo && sanitizeExt(file.name, IMAGE_EXTS);
    const isAudio = !isVideo && !isImage && sanitizeExt(file.name, AUDIO_EXTS);

    if (!isVideo && !isImage && !isAudio) {
      return c.json({
        success: false,
        error: 'Поддерживаются аудио (mp3, wav, m4a, aac, ogg, flac), видео (mp4, webm, mov, m4v) и изображения (jpg, png, webp, gif)',
      }, 400);
    }

    const kind: 'video' | 'audio' | 'image' = isVideo ? 'video' : isImage ? 'image' : 'audio';
    const allowed = isVideo ? VIDEO_EXTS : isImage ? IMAGE_EXTS : AUDIO_EXTS;
    const maxBytes = isVideo ? MAX_VIDEO_BYTES : isImage ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
    const subdir = isVideo ? 'dj-videos' : isImage ? 'dj-portfolio-images' : 'dj-portfolio';
    const uploaded = await saveUpload(file, subdir, `pf-${userId}`, allowed, maxBytes);

    const portfolioFile = {
      id: `pf-${crypto.randomUUID()}`,
      name: displayName,
      url: uploaded.url,
      kind,
      size: `${Math.round(uploaded.size / 1024 / 1024 * 10) / 10} МБ`,
      date: new Date().toISOString(),
    };

    const data: any = (await getDjProfile(userId)) || {};
    const cats: any[] = Array.isArray(data.portfolioCategories) ? data.portfolioCategories : [];
    let cat = cats.find((x: any) => x.id === categoryId);
    if (!cat) {
      cat = { id: categoryId, label: categoryId, files: [] };
      cats.push(cat);
    }
    cat.files = Array.isArray(cat.files) ? cat.files : [];
    cat.files.unshift(portfolioFile);
    data.portfolioCategories = cats;
    await upsertDjProfile(userId, data);

    return c.json({ success: true, data: portfolioFile });
  } catch (error: any) {
    console.error('DJ portfolio upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

// ════════════════════════════════════════
// MIXES (DJ-owned CRUD)
// ════════════════════════════════════════

// GET /mixes — список собственных миксов (для DjMixManager)
app.get('/mixes', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    await ensureDjMixesSchema();
    const { rows } = await pool.query(
      `SELECT id, dj_id, title, genre, duration, plays_count, audio_url, cover_url,
              description, bpm_range, status, data, created_at, updated_at,
              moderation_status, moderated_at, moderation_comment, rejection_reason, is_hidden
         FROM dj_mixes
        WHERE dj_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );
    const mixes = (rows || []).map((r: any) => ({
      id: r.id,
      title: r.title || '',
      genre: r.genre || '',
      duration: r.duration ? `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}` : '',
      durationSec: r.duration || 0,
      plays: r.plays_count || 0,
      likes: r.data?.likes || 0,
      downloads: r.data?.downloads || 0,
      comments: r.data?.comments || 0,
      audioUrl: r.audio_url || '',
      coverUrl: r.cover_url || '',
      description: r.description || '',
      bpmRange: r.bpm_range || '',
      isPremium: !!r.data?.isPremium,
      price: r.data?.price || 0,
      status: r.status || 'published',
      // Зеркало пайплайна tracks: pending/approved/upcoming/published/rejected.
      // Кабинет рисует badge + CTA по этому полю.
      moderationStatus: r.moderation_status || 'pending',
      moderatedAt: r.moderated_at,
      moderationComment: r.moderation_comment || '',
      rejectionReason: r.rejection_reason || '',
      isHidden: !!r.is_hidden,
      requiresPayment: !!r.data?.requires_payment,
      paymentAmount: Number(r.data?.payment_amount || 0),
      firstMixFreeApplied: !!r.data?.first_mix_free_applied,
      createdAt: r.created_at,
    }));
    return c.json({ success: true, data: mixes });
  } catch (error: any) {
    console.error('Error fetching own DJ mixes:', error);
    return c.json({ success: true, data: [] });
  }
});

/**
 * Resolve current DJ-plan limits ({ mixes, events, analytics }).
 * Defaults to starter (DJ_PLANS[0]) when the DJ has no record in
 * djSubscriptionsStore. `mixes` / `events` of -1 means unlimited.
 *
 * Exported because booking-routes.tsx also enforces the events quota
 * when a venue creates a booking against a DJ-performer.
 */
export async function getDjPlanLimits(djId: string): Promise<{ mixes: number; events: number; analytics: string }> {
  try {
    const sub: any = await djSubscriptionsStore.get(djId);
    // Lazy expiry check — if the stored subscription's endDate has
    // passed, fall back to starter limits even when the row still
    // says status:'active'. Without this the DJ would keep using
    // Pro/Agency caps forever after the paid period ended; there's
    // no cron job downgrading expired rows. See subscriptionView()
    // for the matching UI-facing fields (expired flag, daysLeft).
    if (sub?.endDate) {
      const end = new Date(sub.endDate).getTime();
      if (Number.isFinite(end) && end < Date.now()) {
        return { ...DJ_PLANS[0].limits } as any;
      }
    }
    if (sub?.limits && typeof sub.limits === 'object') {
      return {
        mixes: Number(sub.limits.mixes) || DJ_PLANS[0].limits.mixes,
        events: Number(sub.limits.events) || DJ_PLANS[0].limits.events,
        analytics: String(sub.limits.analytics || DJ_PLANS[0].limits.analytics),
      };
    }
  } catch (e: any) {
    console.warn('[dj-studio] getDjPlanLimits failed:', e?.message);
  }
  return { ...DJ_PLANS[0].limits } as any;
}

// Build the UI-facing subscription envelope. Adds `expired` and
// `daysLeft` so the cabinet can show «Подписка истекла, продлите»
// without the frontend re-implementing date math. When the stored
// row is past endDate, the `limits` field returned to the client is
// the starter ones — matches what getDjPlanLimits() enforces, so
// what the UI displays and what the backend actually allows stay in
// sync.
function subscriptionView(sub: any): any {
  if (!sub) return null;
  const out: any = { ...sub };
  if (sub.endDate) {
    const end = new Date(sub.endDate).getTime();
    if (Number.isFinite(end)) {
      const msLeft = end - Date.now();
      out.daysLeft = Math.ceil(msLeft / 86400000);
      if (msLeft < 0) {
        out.expired = true;
        out.status = 'expired';
        out.limits = { ...DJ_PLANS[0].limits };
      }
    }
  }
  return out;
}

// POST /mixes — загрузить новый микс (multipart: audio, cover, title, genre…)
app.post('/mixes', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    await ensureDjMixesSchema();

    // Enforce the per-plan mix quota. Starter = 5, Pro/Premium = -1
    // (unlimited). The landing has long shown «До 5 миксов» on Starter
    // without anything in the backend stopping a DJ from uploading the
    // 50th — this check finally honours that.
    const limits = await getDjPlanLimits(String(userId));
    if (limits.mixes !== -1) {
      const cnt = await pool.query(
        `SELECT COUNT(*)::int AS n FROM dj_mixes WHERE dj_id = $1`,
        [String(userId)],
      );
      const existing = Number(cnt.rows[0]?.n) || 0;
      if (existing >= limits.mixes) {
        return c.json({
          success: false,
          error: `Достигнут лимит миксов для текущего тарифа (${existing}/${limits.mixes}). Обновите подписку, чтобы загрузить больше.`,
          limit: limits.mixes,
          current: existing,
        }, 403);
      }
    }

    const body = await c.req.parseBody();
    const audio = body.audio as File | undefined;
    const cover = body.cover as File | undefined;
    const title = String(body.title || '').trim();
    const genreRaw = String(body.genre || '').trim();
    const description = String(body.description || '').slice(0, 2000);
    const bpmRaw = String(body.bpmRange || '').trim();
    const durationSec = Math.max(0, Number(body.durationSec || 0));
    const isPremium = String(body.isPremium || 'false') === 'true';
    const price = Math.max(0, Number(body.price || 0));

    if (!audio) return c.json({ success: false, error: 'Аудио-файл обязателен' }, 400);
    if (!title) return c.json({ success: false, error: 'Название микса обязательно' }, 400);

    // ── Whitelist жанров. Должен совпадать с datalist'ом фронта
    // (DjMixManager.tsx → dj-genres-list). Сравнение case-insensitive,
    // нормализация — lowercase + trim. Пустой жанр допустим (опциональное поле).
    const genre = validateMixGenre(genreRaw);
    if (genre === false) {
      return c.json({
        success: false,
        error: `Жанр «${genreRaw}» не поддерживается. Выберите из подсказок: House, Techno, Trance, Drum & Bass, Dubstep и др.`,
      }, 400);
    }

    // ── BPM: пусто — ок; иначе 40-220, только число.
    const bpmRange = validateMixBpm(bpmRaw);
    if (bpmRange === false) {
      return c.json({
        success: false,
        error: 'BPM должен быть числом в диапазоне 40-220',
      }, 400);
    }

    const audioUploaded = await saveUpload(audio, 'dj-mixes', `mix-${userId}`, AUDIO_EXTS, MAX_AUDIO_BYTES);
    let coverUrl = '';
    if (cover && cover.size > 0) {
      const coverUploaded = await saveUpload(cover, 'dj-mix-covers', `cover-${userId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);
      coverUrl = coverUploaded.url;
    }

    // Премиум требует положительную цену — иначе нечего продавать.
    if (isPremium && price <= 0) {
      return c.json({
        success: false,
        error: 'Премиум-микс требует положительную цену (₽). Снимите галочку «Премиум» или укажите цену.',
      }, 400);
    }

    const id = `mix-${crypto.randomUUID()}`;
    const data = {
      likes: 0, downloads: 0, comments: 0,
      isPremium, price,
      // Премиум-микс после approve должен автоматически попасть
      // в каталог для радио и venues — флаг читается админ-flow'ом.
      distribute: isPremium ? { radio: true, venues: true } : null,
    };

    // Премиум-микс сразу уходит на модерацию админу (это и есть
    // «премиум-режим»: платный + контроль качества). Обычный (бесплатный)
    // микс публикуется в личный профиль DJ без модерации; чтобы попасть
    // на радио/в venues, DJ потом сам жмёт «На радио / питчинг».
    const dbStatus           = isPremium ? 'draft'     : 'published';
    const dbModerationStatus = isPremium ? 'pending'   : 'published';
    const dbIsHidden         = isPremium ? true        : false;

    await pool.query(
      `INSERT INTO dj_mixes
         (id, dj_id, title, genre, duration, plays_count, audio_url, cover_url,
          description, bpm_range, status, data,
          moderation_status, is_hidden,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, $11,
               $12, $13,
               NOW(), NOW())`,
      [id, userId, title, genre, durationSec, audioUploaded.url, coverUrl, description, bpmRange,
       dbStatus, data, dbModerationStatus, dbIsHidden]
    );

    return c.json({
      success: true,
      data: {
        id, djId: userId, title, genre,
        duration: durationSec ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}` : '',
        durationSec,
        plays: 0, likes: 0, downloads: 0, comments: 0,
        audioUrl: audioUploaded.url,
        coverUrl,
        description, bpmRange,
        isPremium, price,
        // Возвращаем РЕАЛЬНОЕ состояние, что лежит в БД, а не lying-pending.
        status:           dbStatus,
        moderationStatus: dbModerationStatus,
        isHidden:         dbIsHidden,
        createdAt: new Date().toISOString(),
      },
    }, 201);
  } catch (error: any) {
    console.error('Error uploading DJ mix:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 500);
  }
});

// DELETE /mixes/:id — удалить микс (свой)
app.delete('/mixes/:id', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const id = c.req.param('id');
    const res = await pool.query(
      `DELETE FROM dj_mixes WHERE id = $1 AND dj_id = $2`,
      [id, userId]
    );
    if (res.rowCount === 0) {
      return c.json({ success: false, error: 'Микс не найден' }, 404);
    }
    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting DJ mix:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /mixes/:id/submit-moderation — отправить свой микс на админ-модерацию
// (опт-ин: только если DJ хочет промо на радио/питчинг). Микс уходит в
// pending + is_hidden=TRUE, исчезает из публичного профиля до апрува.
// После approve/reject админ возвращает в published — см.
// dj-mix-moderation-routes.tsx POST /manage-dj-mix-moderation.
app.post('/mixes/:id/submit-moderation', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const id = c.req.param('id');
    // Только владелец и только если микс сейчас не в очереди модерации
    // (защита от двойного сабмита, который сбрасывал бы admin-comment).
    const { rows } = await pool.query(
      `SELECT moderation_status FROM dj_mixes WHERE id = $1 AND dj_id = $2 LIMIT 1`,
      [id, userId]
    );
    if (rows.length === 0) {
      return c.json({ success: false, error: 'Микс не найден' }, 404);
    }
    const current = rows[0].moderation_status;
    if (current === 'pending') {
      return c.json({ success: false, error: 'Микс уже на модерации' }, 409);
    }
    if (current === 'approved' || current === 'upcoming') {
      return c.json({ success: false, error: 'Микс уже одобрен — повторная модерация не нужна' }, 409);
    }
    await pool.query(
      `UPDATE dj_mixes
          SET moderation_status = 'pending',
              is_hidden         = TRUE,
              moderation_comment = NULL,
              rejection_reason   = NULL,
              updated_at         = NOW()
        WHERE id = $1 AND dj_id = $2`,
      [id, userId]
    );
    return c.json({ success: true, data: { moderationStatus: 'pending', isHidden: true } });
  } catch (error: any) {
    console.error('Error submitting mix for moderation:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /mixes/:id/withdraw-moderation — снять микс с модерации,
// вернуть в published. Можно только если ещё pending (админ не
// обработал) — иначе approve/reject админа уже зафиксирован.
app.post('/mixes/:id/withdraw-moderation', requireAuth, requireDjRole, async (c) => {
  try {
    const userId = await getUserId(c);
    const id = c.req.param('id');
    const res = await pool.query(
      `UPDATE dj_mixes
          SET moderation_status = 'published',
              is_hidden         = FALSE,
              updated_at         = NOW()
        WHERE id = $1 AND dj_id = $2 AND moderation_status = 'pending'`,
      [id, userId]
    );
    if (res.rowCount === 0) {
      return c.json({ success: false, error: 'Микс не найден или уже обработан админом' }, 404);
    }
    return c.json({ success: true, data: { moderationStatus: 'published', isHidden: false } });
  } catch (error: any) {
    console.error('Error withdrawing mix from moderation:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /promotion/targets?type=radio|venue — каталог целей для питча
app.get('/promotion/targets', requireAuth, requireDjRole, async (c) => {
  try {
    const type = c.req.query('type') === 'venue' ? 'venue' : 'radio';
    const query = String(c.req.query('q') || '').trim().toLowerCase();
    const limit = Math.min(Number(c.req.query('limit') || 100), 200);

    const table = type === 'venue' ? 'venue_profiles' : 'radio_profiles';
    const { rows } = await pool.query(`SELECT user_id, data FROM ${table} LIMIT $1`, [limit]);

    const toNum = (v: any): number | null => {
      if (v == null || v === '') return null;
      const n = typeof v === 'number' ? v : parseInt(String(v).replace(/\D/g, ''), 10);
      return Number.isFinite(n) ? n : null;
    };
    const targets = (rows || []).map((r: any) => {
      const d = r.data || {};
      if (type === 'radio') {
        return {
          id: r.user_id,
          name: d.station_name || d.stationName || d.name || 'Радиостанция',
          city: d.city || '',
          genres: Array.isArray(d.genres) ? d.genres : [],
          listeners: toNum(d.listeners_count ?? d.listeners),
          logo: d.logo_url || d.logoUrl || d.avatarUrl || null,
        };
      }
      return {
        id: r.user_id,
        name: d.venue_name || d.venueName || d.name || 'Заведение',
        city: d.city || '',
        type: d.venue_type || d.type || '',
        capacity: toNum(d.capacity),
        logo: d.logo_url || d.logoUrl || d.avatarUrl || null,
      };
    });

    const filtered = query
      ? targets.filter((t: any) =>
          (t.name || '').toLowerCase().includes(query) ||
          (t.city || '').toLowerCase().includes(query)
        )
      : targets;

    return c.json({ success: true, data: filtered });
  } catch (error) {
    console.error('Error fetching promotion targets:', error);
    return c.json({ success: true, data: [] });
  }
});

export default app;
