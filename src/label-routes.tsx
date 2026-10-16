/**
 * LABEL ROUTES — Кабинет рекорд-лейбла
 *
 * Лейбл — самообслуживаемая роль (activates immediately on email verify, not
 * a partner). Управляет ростером артистов двух типов:
 *   • managed — создаются лейблом, без user account (artist_profiles.user_id IS NULL,
 *     managed_by_label_id = label_profiles.id)
 *   • linked  — реальные артисты, принявшие invitation (artist_profiles.user_id NOT NULL,
 *     label_id = label_profiles.id). Обе стороны могут разорвать связь.
 *
 * Publish on behalf реализован расширением POST /publish/orders с
 * actingForArtistId (см. publish-routes.tsx). Этот модуль предоставляет
 * каталог, профиль, ростер и aggregated reads.
 *
 * Public/auth endpoints:
 *   GET    /label/profile                — own profile (auth, role=label)
 *   PUT    /label/profile                — update own profile
 *   GET    /label/profile/by-slug/:slug  — public profile view
 *   GET    /label/roster                 — managed + linked artists with stats
 *
 * MVP scope (PR1): schema bootstrap + profile CRUD + empty-state roster.
 * Roster CRUD, invitations, releases come in PR2/PR3.
 */

import { Hono } from 'hono';
import { requireAuth, optionalAuth } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';
import { getPublicationPrice } from './pricing.tsx';
import { notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { sendLabelInvitationEmail, escapeHtml } from './email-helper.tsx';
import { saveUpload, IMAGE_EXTS, MAX_IMAGE_BYTES } from './cabinet-uploads.tsx';

const app = new Hono();

// ── Schema bootstrap (idempotent) ────────────────────────────────────────────

let schemaReady: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    // 1. Add 'label' to user_role enum. PG requires this to run outside the
    // transaction that uses the new value, so we run it in its own client.
    const enumClient = await pool.connect();
    try {
      await enumClient.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'label'`);
    } catch (e: any) {
      // ALTER TYPE ADD VALUE is idempotent via IF NOT EXISTS; ignore the
      // "must be owner" / replication race here.
      if (!/already exists/i.test(e?.message || '')) {
        console.warn('[label] user_role enum extension:', e?.message);
      }
    } finally {
      enumClient.release();
    }

    // 2. label_profiles — one row per user with role='label'.
    // try/catch: CREATE INDEX IF NOT EXISTS проверяет владельца ДО existence-чека,
    // поэтому на таблице, которой app-роль не владеет, бросает «must be owner»
    // даже если индекс уже есть. Не должно валить весь роутер — схема может быть
    // уже провижинена миграцией под postgres.
    try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS label_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        slug TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        legal_name TEXT,
        country TEXT,
        city TEXT,
        website TEXT,
        bio TEXT,
        avatar_url TEXT,
        cover_url TEXT,
        genres TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        socials JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_verified BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_label_profiles_user_id ON label_profiles(user_id);
      CREATE INDEX IF NOT EXISTS idx_label_profiles_slug ON label_profiles(slug);
    `);
    } catch (e: any) {
      if (!/already exists|must be owner/i.test(e?.message || '')) console.warn('[label] label_profiles schema:', e?.message);
    }

    // 3. Extend artist_profiles for managed + linked roster. user_id becomes
    // nullable; managed_by_label_id/label_id encode roster relationship.
    try {
      await pool.query(`
        ALTER TABLE artist_profiles
          ALTER COLUMN user_id DROP NOT NULL;
      `);
    } catch (e: any) {
      const msg = e?.message || '';
      if (!/cannot|does not exist|must be owner/i.test(msg)) {
        console.warn('[label] artist_profiles user_id drop not null:', msg);
      }
    }

    try {
      await pool.query(`
        ALTER TABLE artist_profiles
          ADD COLUMN IF NOT EXISTS managed_by_label_id UUID NULL REFERENCES label_profiles(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS is_managed BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS label_id UUID NULL REFERENCES label_profiles(id) ON DELETE SET NULL;
      `);
    } catch (e: any) {
      const msg = e?.message || '';
      if (!/already exists|must be owner/i.test(msg)) {
        console.warn('[label] artist_profiles add columns failed:', msg);
      }
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_artist_profiles_managed_by ON artist_profiles(managed_by_label_id) WHERE managed_by_label_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_artist_profiles_label_id   ON artist_profiles(label_id) WHERE label_id IS NOT NULL;
      `);
    } catch (e: any) {
      const msg = e?.message || '';
      if (!/already exists|must be owner/i.test(msg)) {
        console.warn('[label] artist_profiles create indexes failed:', msg);
      }
    }


    // 4. label_invitations — pending/accepted/declined invitations to existing artists.
    // try/catch — таблица может принадлежать postgres (создана миграцией вручную),
    // тогда CREATE INDEX под app-ролью бросит «must be owner»; не валим роутер.
    try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS label_invitations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        label_id UUID NOT NULL REFERENCES label_profiles(id) ON DELETE CASCADE,
        artist_user_id UUID NULL REFERENCES users(id) ON DELETE CASCADE,
        invited_email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','accepted','declined','revoked','expired')),
        message TEXT,
        invited_by UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        responded_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
      );
      CREATE INDEX IF NOT EXISTS idx_label_invitations_label   ON label_invitations(label_id);
      CREATE INDEX IF NOT EXISTS idx_label_invitations_artist  ON label_invitations(artist_user_id) WHERE artist_user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_label_invitations_email   ON label_invitations(lower(invited_email));
      CREATE INDEX IF NOT EXISTS idx_label_invitations_status  ON label_invitations(status);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_label_invitation_pending
        ON label_invitations(label_id, COALESCE(artist_user_id::text, lower(invited_email)))
        WHERE status = 'pending';
    `);
    } catch (e: any) {
      if (!/already exists|must be owner/i.test(e?.message || '')) console.warn('[label] label_invitations schema:', e?.message);
    }
  })();
  return schemaReady;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || `label-${Math.random().toString(36).slice(2, 8)}`;
}

async function requireLabelRole(c: any): Promise<{ userId: string; labelId: string | null } | Response> {
  const userId = c.get('userId') as string | undefined;
  const role = c.get('userRole') as string | undefined;
  if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (role !== 'label') {
    return c.json({ success: false, error: 'Доступ только для роли «label»' }, 403);
  }
  const r = await pool.query(`SELECT id FROM label_profiles WHERE user_id = $1`, [userId]);
  return { userId, labelId: r.rows[0]?.id || null };
}

const ALLOWED_PROFILE_FIELDS = [
  'display_name', 'legal_name', 'country', 'city', 'website',
  'bio', 'avatar_url', 'cover_url', 'genres', 'socials',
] as const;

// ── Profile endpoints ─────────────────────────────────────────────────────────

app.get('/profile', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const userId = c.get('userId') as string;
    const role = c.get('userRole') as string;
    if (role !== 'label') {
      return c.json({ success: false, error: 'Доступ только для роли «label»' }, 403);
    }
    const r = await pool.query(
      `SELECT lp.*, u.email, u.full_name
       FROM label_profiles lp
       JOIN users u ON u.id = lp.user_id
       WHERE lp.user_id = $1`,
      [userId]
    );
    if (r.rows.length === 0) {
      // First-time access — auto-create skeleton profile so the cabinet
      // doesn't show errors before the user fills it in.
      const u = await pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
      if (u.rows.length === 0) return c.json({ success: false, error: 'User not found' }, 404);
      const displayName = u.rows[0].full_name || u.rows[0].email.split('@')[0];
      const baseSlug = slugify(displayName);
      // Avoid slug collisions across all label_profiles.
      let finalSlug = baseSlug;
      for (let attempt = 0; attempt < 5; attempt++) {
        const exists = await pool.query(`SELECT 1 FROM label_profiles WHERE slug = $1`, [finalSlug]);
        if (exists.rows.length === 0) break;
        finalSlug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
      }
      const ins = await pool.query(
        `INSERT INTO label_profiles (user_id, slug, display_name)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [userId, finalSlug, displayName]
      );
      return c.json({
        success: true,
        profile: { ...ins.rows[0], email: u.rows[0].email, full_name: u.rows[0].full_name },
      });
    }
    return c.json({ success: true, profile: r.rows[0] });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.put('/profile', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;

    const body = await c.req.json();
    const sets: string[] = [];
    const args: any[] = [];
    let i = 1;
    for (const key of ALLOWED_PROFILE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        sets.push(`${key} = $${i++}`);
        args.push((body as any)[key]);
      }
    }
    // Slug change handled separately — must remain unique.
    if (Object.prototype.hasOwnProperty.call(body, 'slug')) {
      const newSlug = slugify(String(body.slug || ''));
      if (newSlug) {
        const taken = await pool.query(
          `SELECT 1 FROM label_profiles WHERE slug = $1 AND user_id != $2`,
          [newSlug, gate.userId]
        );
        if (taken.rows.length > 0) {
          return c.json({ success: false, error: 'Этот slug уже занят' }, 409);
        }
        sets.push(`slug = $${i++}`);
        args.push(newSlug);
      }
    }
    if (sets.length === 0) {
      return c.json({ success: false, error: 'No editable fields supplied' }, 400);
    }
    args.push(gate.userId);
    const r = await pool.query(
      `UPDATE label_profiles SET ${sets.join(', ')}, updated_at = NOW()
       WHERE user_id = $${i}
       RETURNING *`,
      args
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Label profile not found' }, 404);
    }
    return c.json({ success: true, profile: r.rows[0] });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.get('/profile/by-slug/:slug', async (c) => {
  try {
    await ensureSchema();
    const slug = c.req.param('slug');
    const r = await pool.query(
      `SELECT id, slug, display_name, country, city, website, bio,
              avatar_url, cover_url, genres, socials, is_verified, created_at
       FROM label_profiles WHERE slug = $1`,
      [slug]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Label not found' }, 404);
    }
    return c.json({ success: true, profile: r.rows[0] });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /label/profile/by-slug/:slug/roster — PUBLIC roster snapshot for the
 * label's public page (no auth). Returns the same shape as the
 * authenticated /roster but excludes nothing — managed and linked alike are
 * visible to anyone browsing the label.
 */
app.get('/profile/by-slug/:slug/roster', async (c) => {
  try {
    await ensureSchema();
    const slug = c.req.param('slug');
    const lp = await pool.query(`SELECT id FROM label_profiles WHERE slug = $1`, [slug]);
    if (lp.rows.length === 0) {
      return c.json({ success: false, error: 'Label not found' }, 404);
    }
    const labelId = lp.rows[0].id;
    const r = await pool.query(
      `SELECT
         ap.id            AS artist_profile_id,
         ap.user_id       AS artist_user_id,
         ap.slug          AS slug,
         ap.artist_name   AS display_name,
         ap.avatar_url    AS avatar_url,
         ap.city          AS city,
         ap.is_verified   AS is_verified,
         ap.is_managed    AS is_managed,
         CASE
           WHEN ap.managed_by_label_id = $1 THEN 'managed'
           WHEN ap.label_id = $1 THEN 'linked'
           ELSE 'unknown'
         END              AS kind,
         ap.total_plays   AS total_plays,
         ap.total_followers AS total_followers
       FROM artist_profiles ap
       WHERE ap.managed_by_label_id = $1 OR ap.label_id = $1
       ORDER BY ap.total_plays DESC NULLS LAST, ap.artist_name ASC`,
      [labelId]
    );
    return c.json({ success: true, roster: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Roster ────────────────────────────────────────────────────────────────────

app.get('/roster', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    if (!gate.labelId) {
      // Profile not yet provisioned — auto-create via GET /profile, then retry.
      return c.json({ success: true, roster: [] });
    }
    const r = await pool.query(
      `SELECT
         ap.id            AS artist_profile_id,
         ap.user_id       AS artist_user_id,
         ap.slug          AS slug,
         ap.artist_name   AS display_name,
         ap.avatar_url    AS avatar_url,
         ap.city          AS city,
         ap.is_verified   AS is_verified,
         ap.is_managed    AS is_managed,
         -- Поля для формы правки артиста ростера: без них форма открывалась
         -- пустой, и каждое сохранение затирало поджанры и соцсети (аудит 10-05).
         ap.genre         AS genre,
         ap.sub_genres    AS sub_genres,
         ap.country       AS country,
         ap.bio           AS bio,
         ap.cover_url     AS cover_url,
         ap.social_links  AS social_links,
         ap.data          AS data,
         CASE
           WHEN ap.managed_by_label_id = $1 THEN 'managed'
           WHEN ap.label_id = $1 THEN 'linked'
           ELSE 'unknown'
         END              AS kind,
         ap.created_at    AS joined_at,
         (SELECT COUNT(*)::int FROM tracks t WHERE t.artist_id = ap.id) AS tracks_count,
         (SELECT COUNT(*)::int FROM tracks t WHERE t.artist_id = ap.id AND t.moderation_status = 'published') AS published_count,
         (SELECT COALESCE(SUM(rp.rotation_count), 0)::int
            FROM track_radio_pickups rp JOIN tracks t ON t.id = rp.track_id
           WHERE t.artist_id = ap.id AND rp.report_status = 'confirmed'
             AND rp.source IS DISTINCT FROM 'auto') AS radio_rotations,
         (SELECT COALESCE(SUM(rp.rotation_count), 0)::int
            FROM track_radio_pickups rp JOIN tracks t ON t.id = rp.track_id
           WHERE t.artist_id = ap.id AND rp.report_status = 'confirmed'
             AND rp.source IS DISTINCT FROM 'auto'
             AND EXISTS (SELECT 1 FROM promo_check_detections d
                          WHERE d.track_id = rp.track_id AND d.station_name = rp.station_name)
         ) AS radio_rotations_verified,
         (SELECT COUNT(DISTINCT rp.station_name)::int
            FROM track_radio_pickups rp JOIN tracks t ON t.id = rp.track_id
           WHERE t.artist_id = ap.id AND rp.report_status = 'confirmed'
             AND rp.source IS DISTINCT FROM 'auto') AS radio_stations,
         -- 14.10.2026: станции, скачавшие треки артиста (скачивание ещё не ротация, но это результат)
         (SELECT COUNT(DISTINCT d.station_name)::int
            FROM track_downloads_by_radio d JOIN tracks t ON t.id = d.track_id
           WHERE t.artist_id = ap.id AND d.station_name IS NOT NULL AND d.station_name <> '') AS radio_downloads
       FROM artist_profiles ap
       WHERE ap.managed_by_label_id = $1 OR ap.label_id = $1
       ORDER BY ap.created_at DESC`,
      [gate.labelId]
    );
    return c.json({ success: true, roster: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Roster: managed artists CRUD ──────────────────────────────────────────────
//
// Managed artists are artist_profiles rows with user_id IS NULL and
// managed_by_label_id = this label. Only the owning label can edit them.
// Deletion is hard-DELETE only when no tracks reference the artist; otherwise
// the response is 409 with a hint.

const ALLOWED_MANAGED_FIELDS = [
  'artist_name', 'slug', 'genre', 'sub_genres', 'country', 'city', 'bio',
  'avatar_url', 'cover_url', 'data', 'social_links',
] as const;

app.post('/roster/managed', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    if (!gate.labelId) {
      return c.json({ success: false, error: 'Сначала заполните профиль лейбла' }, 400);
    }
    const body = await c.req.json();
    const displayName = String(body?.display_name || body?.artist_name || '').trim();
    if (!displayName) {
      return c.json({ success: false, error: 'Имя артиста обязательно' }, 400);
    }
    // Slug: explicit or derived; collision-retry against existing rows.
    let slug = slugify(String(body?.slug || displayName));
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await pool.query(`SELECT 1 FROM artist_profiles WHERE slug = $1`, [slug]);
      if (exists.rows.length === 0) break;
      slug = `${slugify(displayName)}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const r = await pool.query(
      `INSERT INTO artist_profiles
         (artist_name, slug, genre, sub_genres, country, city, bio,
          avatar_url, cover_url, data, social_links, is_managed, managed_by_label_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12)
       RETURNING id, slug, artist_name, avatar_url, city, is_verified, created_at`,
      [
        displayName,
        slug,
        body?.genre || null,
        Array.isArray(body?.sub_genres) ? body.sub_genres : null,
        body?.country || null,
        body?.city || null,
        body?.bio || null,
        body?.avatar_url || null,
        body?.cover_url || null,
        body?.data ? JSON.stringify(body.data) : null,
        body?.social_links ? JSON.stringify(body.social_links) : null,
        gate.labelId,
      ]
    );
    return c.json({ success: true, artist: r.rows[0] });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.put('/roster/managed/:id', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;

    const id = c.req.param('id');
    // Ownership guard — only the label that manages this artist can edit.
    const owner = await pool.query(
      `SELECT managed_by_label_id FROM artist_profiles WHERE id = $1`,
      [id]
    );
    if (owner.rows.length === 0 || owner.rows[0].managed_by_label_id !== gate.labelId) {
      return c.json({ success: false, error: 'Артист не найден в вашем ростере' }, 404);
    }

    const body = await c.req.json();
    // slug раньше писался как есть: пустой, с пробелами и заглавными, а занятый
    // ронял UPDATE на уникальности (аудит 10-05). Нормализуем как при создании.
    if (Object.prototype.hasOwnProperty.call(body, 'slug')) {
      const raw = String(body.slug ?? '').trim();
      if (!raw) {
        delete body.slug; // пустое поле — оставляем прежний адрес
      } else {
        body.slug = slugify(raw);
        const taken = await pool.query(`SELECT 1 FROM artist_profiles WHERE slug = $1 AND id::text <> $2 LIMIT 1`, [body.slug, id]);
        if (taken.rows.length) return c.json({ success: false, error: 'Этот адрес (slug) уже занят – выберите другой' }, 409);
      }
    }
    const sets: string[] = [];
    const args: any[] = [];
    let i = 1;
    for (const key of ALLOWED_MANAGED_FIELDS) {
      const incomingKey = key === 'artist_name' && body.display_name !== undefined ? 'display_name' : key;
      if (Object.prototype.hasOwnProperty.call(body, incomingKey)) {
        sets.push(`${key} = $${i++}`);
        args.push((key === 'data' || key === 'social_links') ? JSON.stringify((body as any)[incomingKey]) : (body as any)[incomingKey]);
      }
    }
    if (sets.length === 0) {
      return c.json({ success: false, error: 'No editable fields supplied' }, 400);
    }
    args.push(id);
    const r = await pool.query(
      `UPDATE artist_profiles SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${i} AND managed_by_label_id = $${i + 1}
       RETURNING id`,
      [...args, gate.labelId]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Артист не найден' }, 404);
    }
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// Avatar/cover upload for a managed artist (file from computer, not URL).
app.post('/roster/managed/:id/avatar', requireAuth, async (c) => {
  try {
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    if (!gate.labelId) return c.json({ success: false, error: 'Сначала заполните профиль лейбла' }, 400);
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);
    const uploaded = await saveUpload(file, 'artist-avatars', `artist-${id}`, IMAGE_EXTS, MAX_IMAGE_BYTES);
    const r = await pool.query(
      `UPDATE artist_profiles SET avatar_url = $1, updated_at = NOW() WHERE id = $2 AND managed_by_label_id = $3 RETURNING id`,
      [uploaded.url, id, gate.labelId]
    );
    if (r.rowCount === 0) return c.json({ success: false, error: 'Артист не найден в вашем ростере' }, 404);
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Managed artist avatar upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

app.post('/roster/managed/:id/cover', requireAuth, async (c) => {
  try {
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    if (!gate.labelId) return c.json({ success: false, error: 'Сначала заполните профиль лейбла' }, 400);
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);
    const uploaded = await saveUpload(file, 'artist-covers', `artist-${id}`, IMAGE_EXTS, MAX_IMAGE_BYTES);
    const r = await pool.query(
      `UPDATE artist_profiles SET cover_url = $1, updated_at = NOW() WHERE id = $2 AND managed_by_label_id = $3 RETURNING id`,
      [uploaded.url, id, gate.labelId]
    );
    if (r.rowCount === 0) return c.json({ success: false, error: 'Артист не найден в вашем ростере' }, 404);
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Managed artist cover upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

app.delete('/roster/managed/:id', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    const id = c.req.param('id');

    // Ownership guard.
    const owner = await pool.query(
      `SELECT managed_by_label_id FROM artist_profiles WHERE id = $1`,
      [id]
    );
    if (owner.rows.length === 0 || owner.rows[0].managed_by_label_id !== gate.labelId) {
      return c.json({ success: false, error: 'Артист не найден в вашем ростере' }, 404);
    }

    // Refuse if any tracks reference this artist — pushes the human decision
    // back to the label (transfer? archive?). DB-level no-op is much worse
    // than a clear 409.
    const t = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tracks WHERE artist_id = $1`,
      [id]
    );
    if (Number(t.rows[0]?.n || 0) > 0) {
      return c.json({
        success: false,
        error: 'У артиста есть треки – сначала удалите или передайте их.',
        code: 'has_tracks',
      }, 409);
    }

    await pool.query(`DELETE FROM artist_profiles WHERE id = $1`, [id]);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Roster: sever linked artist (label-initiated) ─────────────────────────────

app.delete('/roster/linked/:id', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    const id = c.req.param('id');

    const before = await pool.query(
      `SELECT user_id, artist_name FROM artist_profiles
       WHERE id = $1 AND label_id = $2`,
      [id, gate.labelId]
    );
    if (before.rows.length === 0) {
      return c.json({ success: false, error: 'Артист не привязан к вашему лейблу' }, 404);
    }
    await pool.query(
      `UPDATE artist_profiles SET label_id = NULL, updated_at = NOW()
       WHERE id = $1 AND label_id = $2`,
      [id, gate.labelId]
    );

    // Notify the artist that the label has severed the link.
    if (before.rows[0].user_id) {
      try {
        const labelRow = await pool.query(
          `SELECT display_name FROM label_profiles WHERE id = $1`,
          [gate.labelId]
        );
        const labelName = labelRow.rows[0]?.display_name || 'Лейбл';
        await notifyCrossCabinet({
          targetUserId: before.rows[0].user_id,
          targetRole: 'artist',
          sourceRole: 'label',
          type: 'label_member_left',
          title: 'Лейбл прекратил сотрудничество',
          message: `Лейбл «${labelName}» снял вас с ростера.`,
          metadata: { labelId: gate.labelId, artistProfileId: id, initiatedBy: 'label' },
        });
      } catch (e: any) {
        console.warn('[label] linked-sever notify failed:', e?.message);
      }
    }
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Invitations (label side) ──────────────────────────────────────────────────

// Ссылка в письме ведёт на страницу приглашения (GET /invite/:id ниже), а не сразу
// в настройки артиста. Тикет 05.10.2026 (Monisha Star): артистка открыла ссылку в
// браузере, где был вход в кабинет её лейбла, охрана кабинета артиста молча
// перевела её в кабинет лейбла, приглашение осталось непринятым.
function makeAcceptUrl(invitationId: string): string {
  const base = process.env.PUBLIC_URL || 'https://promo-music.ru';
  return `${base}/server/api/label/invite/${invitationId}`;
}

// ── Страница приглашения из письма (05.10.2026) ───────────────────────────────
//
// Смотрит, кто сейчас вошёл в браузере:
//   - артист, которому адресовано приглашение → кнопка «Принять приглашение»
//     (POST /invitations/:id/accept, та же логика, что в настройках артиста);
//   - вход под другим аккаунтом (лейбл, другой артист, другая роль) → объяснение
//     и «Выйти и войти как артист»;
//   - никто не вошёл → «Войти»; после входа артист попадает в «Настройки → Лейблы».
// Возврат после входа — тот же механизм, что у кабинетов: sessionStorage
// 'pf_return_to' (frontend utils/auth/return-path.ts).

const ROLE_NAMES: Record<string, string> = {
  artist: 'артиста', label: 'лейбла', dj: 'диджея', producer: 'продюсера', radio_station: 'радиостанции',
  venue: 'заведения', engineer: 'звукорежиссёра', admin: 'администратора', superadmin: 'администратора',
};

function maskEmail(email: string): string {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  const keep = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${keep}${'*'.repeat(Math.max(1, Math.min(6, local.length - keep.length)))}@${domain}`;
}

function invitePage(c: any, status: number, title: string, body: string) {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · ПРОМО.МУЗЫКА</title>
<style>
 *{box-sizing:border-box}
 body{margin:0;background:#0a0a1a;color:#e6e6f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
      display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px 16px}
 .card{max-width:520px;width:100%;background:#14142a;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:28px}
 .brand{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#a5a5c0;margin:0 0 14px}
 .brand b{color:#fff}
 h1{font-size:21px;line-height:1.3;margin:0 0 12px;color:#fff}
 p{font-size:15px;line-height:1.6;color:#c8c8d8;margin:0 0 14px}
 b{color:#fff}
 .msg{border-left:3px solid #FF577F;margin:0 0 16px;padding:4px 14px;color:#c8c8d8;font-style:italic}
 .btn{display:block;width:100%;padding:14px 18px;margin:10px 0 0;border:0;border-radius:12px;font-size:15px;font-weight:700;
      cursor:pointer;text-align:center;text-decoration:none}
 .primary{background:linear-gradient(135deg,#FF577F,#7C3AED);color:#fff}
 .ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:#e6e6f0;font-weight:600}
 .note{font-size:13px;color:#8a8aa0;margin-top:14px}
 .ok{color:#6EE7B7}
 .err{color:#FCA5A5}
 button:disabled{opacity:.6;cursor:default}
</style></head><body><div class="card">
<p class="brand"><b>ПРОМО.МУЗЫКА</b> · приглашение в лейбл</p>
${body}
</div></body></html>`;
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  return c.html(html, status);
}

app.get('/invite/:id', optionalAuth, async (c) => {
  try {
    await ensureSchema();
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return invitePage(c, 404, 'Приглашение не найдено', '<h1>Приглашение не найдено</h1><p>Проверьте ссылку из письма.</p>');
    }
    const r = await pool.query(
      `SELECT li.id, li.status, li.invited_email, li.artist_user_id::text AS artist_user_id, li.expires_at, li.message,
              lp.display_name AS label_name
         FROM label_invitations li
         LEFT JOIN label_profiles lp ON lp.id = li.label_id
        WHERE li.id = $1`,
      [id],
    );
    const inv = r.rows[0];
    if (!inv) {
      return invitePage(c, 404, 'Приглашение не найдено', '<h1>Приглашение не найдено</h1><p>Возможно, лейбл отозвал его. Проверьте ссылку из письма.</p>');
    }
    const labelName = escapeHtml(inv.label_name || 'Лейбл');
    const invitedMasked = escapeHtml(maskEmail(inv.invited_email));
    const cabinet = '<a class="btn ghost" href="/artist">Открыть кабинет артиста</a>';

    if (inv.status === 'accepted') {
      return invitePage(c, 200, 'Приглашение принято',
        `<h1>Приглашение уже принято</h1><p>Аккаунт артиста состоит в лейбле <b>«${labelName}»</b>.</p>${cabinet}`);
    }
    if (inv.status !== 'pending') {
      return invitePage(c, 200, 'Приглашение недействительно',
        `<h1>Приглашение недействительно</h1><p>Оно уже отклонено или отозвано. Если это ошибка, попросите лейбл <b>«${labelName}»</b> отправить новое.</p>`);
    }
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      return invitePage(c, 200, 'Срок приглашения истёк',
        `<h1>Срок приглашения истёк</h1><p>Попросите лейбл <b>«${labelName}»</b> отправить новое приглашение.</p>`);
    }

    const head = `<h1>Лейбл «${labelName}» приглашает вас в свой ростер</h1>
${inv.message ? `<p class="msg">${escapeHtml(String(inv.message))}</p>` : ''}
<p>После принятия лейбл сможет выпускать ваши релизы через модерацию платформы. Выйти из лейбла можно в любой момент в настройках кабинета артиста.</p>`;
    const returnPath = '/artist/settings?tab=labels';
    const relogin = `<script>
(function(){
  var b=document.getElementById('relogin'); if(!b) return;
  b.addEventListener('click',function(){
    b.disabled=true;
    try{sessionStorage.setItem('pf_return_to',${JSON.stringify(returnPath)});}catch(e){}
    var go=function(){location.href='/login';};
    if(b.getAttribute('data-signout')==='1'){
      fetch('/server/auth/signout',{method:'POST',credentials:'include'}).then(go,go);
    } else { go(); }
  });
})();
</script>`;

    const userId = c.get('userId') as string | undefined;
    const role = (c.get('userRole') as string | undefined) || '';
    if (!userId) {
      return invitePage(c, 200, 'Приглашение в лейбл', `${head}
<p>Чтобы принять приглашение, войдите в аккаунт артиста с почтой <b>${invitedMasked}</b>. Если аккаунта ещё нет, зарегистрируйтесь как артист с этой почтой.</p>
<button type="button" class="btn primary" id="relogin">Войти как артист</button>
<p class="note">После входа откроется раздел «Настройки → Лейблы» с этим приглашением.</p>${relogin}`);
    }

    const me = await pool.query(`SELECT lower(email) AS email FROM users WHERE id = $1`, [userId]);
    const myEmail = me.rows[0]?.email || '';
    const isTarget = role === 'artist'
      && (inv.artist_user_id === userId || (myEmail && myEmail === String(inv.invited_email || '').toLowerCase()));

    if (!isTarget) {
      const who = role === 'artist'
        ? `в другой аккаунт артиста (${escapeHtml(maskEmail(myEmail))})`
        : `в кабинет ${ROLE_NAMES[role] || 'другой роли'}${myEmail ? ` (${escapeHtml(maskEmail(myEmail))})` : ''}`;
      return invitePage(c, 200, 'Приглашение в лейбл', `${head}
<p>Сейчас в этом браузере выполнен вход ${who}. Приглашение адресовано артисту с почтой <b>${invitedMasked}</b>, принять его можно только из этого аккаунта.</p>
<button type="button" class="btn primary" id="relogin" data-signout="1">Выйти и войти как артист</button>
<p class="note">Совет: если вы работаете и в кабинете артиста, и в кабинете лейбла, открывайте их в разных браузерах.</p>${relogin}`);
    }

    return invitePage(c, 200, 'Приглашение в лейбл', `${head}
<button type="button" class="btn primary" id="accept">Принять приглашение</button>
<a class="btn ghost" href="${returnPath}">Посмотреть в настройках</a>
<p class="note" id="res"></p>
<script>
(function(){
  var b=document.getElementById('accept'), res=document.getElementById('res');
  var LN=${JSON.stringify(String(inv.label_name || 'Лейбл')).replace(/</g, '\\u003c')};
  b.addEventListener('click',function(){
    b.disabled=true;
    fetch('/server/api/label/invitations/${id}/accept',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json();})
      .then(function(j){
        if(j.success){res.className='note ok';res.textContent='Готово! Вы в лейбле «'+LN+'». Лейбл сможет выпускать ваши релизы.';b.style.display='none';}
        else{res.className='note err';res.textContent=j.error||'Не получилось принять приглашение';b.disabled=false;}
      })
      .catch(function(){res.className='note err';res.textContent='Не получилось принять приглашение, попробуйте ещё раз';b.disabled=false;});
  });
})();
</script>`);
  } catch (error: any) {
    console.error('[label] invite page failed:', error?.message || error);
    return invitePage(c, 500, 'Ошибка', '<h1>Что-то пошло не так</h1><p>Попробуйте открыть ссылку ещё раз через минуту.</p>');
  }
});

app.post('/invitations', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    if (!gate.labelId) {
      return c.json({ success: false, error: 'Сначала заполните профиль лейбла' }, 400);
    }
    const body = await c.req.json();
    const invitedEmail = String(body?.invited_email || '').trim().toLowerCase();
    const message = body?.message ? String(body.message).slice(0, 1000) : null;
    if (!invitedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitedEmail)) {
      return c.json({ success: false, error: 'Некорректный email' }, 400);
    }

    // Resolve user_id if the artist is already registered.
    const u = await pool.query(
      `SELECT id, role::text AS role FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`,
      [invitedEmail]
    );
    const artistUserId: string | null = u.rows[0]?.id || null;
    if (artistUserId && u.rows[0].role !== 'artist') {
      return c.json({ success: false, error: 'Пользователь не зарегистрирован как артист' }, 400);
    }
    // Self-invite guard.
    if (artistUserId === gate.userId) {
      return c.json({ success: false, error: 'Нельзя пригласить самого себя' }, 400);
    }
    // If the artist is already linked to *this* label, no invitation needed.
    if (artistUserId) {
      const linked = await pool.query(
        `SELECT 1 FROM artist_profiles WHERE user_id = $1 AND label_id = $2`,
        [artistUserId, gate.labelId]
      );
      if (linked.rows.length > 0) {
        return c.json({ success: false, error: 'Артист уже в вашем ростере' }, 409);
      }
    }

    // Insert; partial unique index will reject duplicate pending invites.
    let invitationId: string;
    try {
      const ins = await pool.query(
        `INSERT INTO label_invitations
           (label_id, artist_user_id, invited_email, status, message, invited_by)
         VALUES ($1, $2, $3, 'pending', $4, $5)
         RETURNING id`,
        [gate.labelId, artistUserId, invitedEmail, message, gate.userId]
      );
      invitationId = ins.rows[0].id;
    } catch (e: any) {
      if (e?.code === '23505') {
        return c.json({ success: false, error: 'Приглашение уже отправлено и ждёт ответа' }, 409);
      }
      throw e;
    }

    // Look up label name once for both the email and the SSE push.
    const labelRow = await pool.query(
      `SELECT display_name FROM label_profiles WHERE id = $1`,
      [gate.labelId]
    );
    const labelName = labelRow.rows[0]?.display_name || 'Лейбл';

    // SSE push if the artist is already registered.
    if (artistUserId) {
      try {
        await notifyCrossCabinet({
          targetUserId: artistUserId,
          targetRole: 'artist',
          sourceRole: 'label',
          type: 'label_invitation',
          title: 'Приглашение от лейбла',
          message: `${labelName} приглашает вас в ростер.`,
          link: '/artist/settings?tab=labels',
          metadata: { invitationId, labelId: gate.labelId },
        });
      } catch (e: any) {
        console.warn('[label] invitation notify failed:', e?.message);
      }
    }

    // Email — fires for both registered and not-yet-registered artists.
    try {
      await sendLabelInvitationEmail(invitedEmail, labelName, message, makeAcceptUrl(invitationId));
    } catch (e: any) {
      console.warn('[label] invitation email failed:', e?.message);
    }

    return c.json({ success: true, invitationId, artistFound: !!artistUserId });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.get('/invitations', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    if (!gate.labelId) return c.json({ success: true, invitations: [] });

    const statusFilter = c.req.query('status');
    const args: any[] = [gate.labelId];
    let where = `label_id = $1`;
    if (statusFilter) {
      where += ` AND status = $2`;
      args.push(statusFilter);
    }
    const r = await pool.query(
      `SELECT id, artist_user_id, invited_email, status, message,
              created_at, responded_at, expires_at
       FROM label_invitations
       WHERE ${where}
       ORDER BY created_at DESC LIMIT 200`,
      args
    );
    return c.json({ success: true, invitations: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.delete('/invitations/:id', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    const id = c.req.param('id');

    const r = await pool.query(
      `UPDATE label_invitations
         SET status = 'revoked', responded_at = NOW()
       WHERE id = $1 AND label_id = $2 AND status = 'pending'
       RETURNING id`,
      [id, gate.labelId]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Приглашение не найдено или не в статусе pending' }, 404);
    }
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Invitations (artist side) ─────────────────────────────────────────────────
//
// Mounted here under /label/* for namespace cohesion — the existing
// auth middleware in artist-profile-routes only checks bearer, role check
// happens in-handler. Frontend client calls /label/invitations/incoming/*.

app.get('/invitations/incoming', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const userId = c.get('userId') as string;
    const userEmailRow = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    const userEmail = (userEmailRow.rows[0]?.email || '').toLowerCase();

    const r = await pool.query(
      `SELECT li.id, li.label_id, li.invited_email, li.status, li.message,
              li.created_at, li.expires_at,
              lp.display_name AS label_display_name,
              lp.avatar_url   AS label_avatar_url,
              lp.slug         AS label_slug
       FROM label_invitations li
       JOIN label_profiles lp ON lp.id = li.label_id
       WHERE (li.artist_user_id = $1 OR lower(li.invited_email) = $2)
         AND li.status = 'pending'
         AND li.expires_at > NOW()
       ORDER BY li.created_at DESC`,
      [userId, userEmail]
    );
    return c.json({ success: true, invitations: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/invitations/:id/accept', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const userId = c.get('userId') as string;
    const role = c.get('userRole') as string;
    if (role !== 'artist') {
      return c.json({ success: false, error: 'Принимать приглашение может только артист' }, 403);
    }
    const id = c.req.param('id');
    const userEmailRow = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    const userEmail = (userEmailRow.rows[0]?.email || '').toLowerCase();

    const inv = await pool.query(
      `SELECT label_id, status, expires_at
       FROM label_invitations
       WHERE id = $1 AND (artist_user_id = $2 OR lower(invited_email) = $3)`,
      [id, userId, userEmail]
    );
    if (inv.rows.length === 0) {
      return c.json({ success: false, error: 'Приглашение не найдено' }, 404);
    }
    if (inv.rows[0].status !== 'pending') {
      return c.json({ success: false, error: 'Приглашение уже обработано' }, 409);
    }
    if (new Date(inv.rows[0].expires_at) < new Date()) {
      return c.json({ success: false, error: 'Срок приглашения истёк' }, 410);
    }

    const labelId = inv.rows[0].label_id;

    // Single transaction: lock artist's own profile, set label_id, flip invite.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The artist may have multiple artist_profiles rows in legacy data; pick
      // the canonical one (most recently updated).
      const ap = await client.query(
        `SELECT id, label_id FROM artist_profiles
         WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [userId]
      );
      if (ap.rows.length === 0) {
        await client.query('ROLLBACK');
        return c.json({ success: false, error: 'Профиль артиста не найден' }, 400);
      }
      if (ap.rows[0].label_id && ap.rows[0].label_id !== labelId) {
        // Artist is already linked to another label — explicit decision needed.
        await client.query('ROLLBACK');
        return c.json({
          success: false,
          error: 'Сначала покиньте текущий лейбл, чтобы принять новое приглашение',
          code: 'already_linked',
        }, 409);
      }
      await client.query(
        `UPDATE artist_profiles SET label_id = $1, updated_at = NOW() WHERE id = $2`,
        [labelId, ap.rows[0].id]
      );
      await client.query(
        `UPDATE label_invitations
           SET status = 'accepted', responded_at = NOW(), artist_user_id = $1
         WHERE id = $2`,
        [userId, id]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Notify the label.
    try {
      const owner = await pool.query(
        `SELECT user_id FROM label_profiles WHERE id = $1`,
        [labelId]
      );
      if (owner.rows[0]?.user_id) {
        const artistName = await pool.query(
          `SELECT artist_name FROM artist_profiles WHERE user_id = $1 LIMIT 1`,
          [userId]
        );
        await notifyCrossCabinet({
          targetUserId: owner.rows[0].user_id,
          targetRole: 'label',
          sourceRole: 'artist',
          type: 'label_invitation_response',
          title: 'Артист принял приглашение',
          message: `${artistName.rows[0]?.artist_name || userEmail} в вашем ростере.`,
          link: '/label/roster',
          metadata: { invitationId: id, decision: 'accepted', artistUserId: userId },
        });
      }
    } catch (e: any) {
      console.warn('[label] accept notify failed:', e?.message);
    }

    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/invitations/:id/decline', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const userId = c.get('userId') as string;
    const role = c.get('userRole') as string;
    if (role !== 'artist') {
      return c.json({ success: false, error: 'Только артист может отклонить приглашение' }, 403);
    }
    const id = c.req.param('id');
    const userEmailRow = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    const userEmail = (userEmailRow.rows[0]?.email || '').toLowerCase();

    const r = await pool.query(
      `UPDATE label_invitations
         SET status = 'declined', responded_at = NOW(), artist_user_id = $1
       WHERE id = $2 AND status = 'pending'
         AND (artist_user_id = $1 OR lower(invited_email) = $3)
       RETURNING label_id`,
      [userId, id, userEmail]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Приглашение не найдено или уже обработано' }, 404);
    }

    // Notify the label.
    try {
      const owner = await pool.query(
        `SELECT user_id FROM label_profiles WHERE id = $1`,
        [r.rows[0].label_id]
      );
      if (owner.rows[0]?.user_id) {
        await notifyCrossCabinet({
          targetUserId: owner.rows[0].user_id,
          targetRole: 'label',
          sourceRole: 'artist',
          type: 'label_invitation_response',
          title: 'Приглашение отклонено',
          message: `${userEmail} отклонил(а) приглашение в ростер.`,
          link: '/label/roster',
          metadata: { invitationId: id, decision: 'declined' },
        });
      }
    } catch (e: any) {
      console.warn('[label] decline notify failed:', e?.message);
    }

    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/invitations/leave', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const userId = c.get('userId') as string;
    const role = c.get('userRole') as string;
    if (role !== 'artist') {
      return c.json({ success: false, error: 'Только артист может покинуть лейбл' }, 403);
    }

    // Find the artist's current label (if any) before clearing.
    const before = await pool.query(
      `SELECT id, label_id FROM artist_profiles
       WHERE user_id = $1 AND label_id IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
      [userId]
    );
    if (before.rows.length === 0) {
      return c.json({ success: false, error: 'Вы не состоите в лейбле' }, 404);
    }
    const labelId: string = before.rows[0].label_id;
    await pool.query(
      `UPDATE artist_profiles SET label_id = NULL, updated_at = NOW()
       WHERE id = $1`,
      [before.rows[0].id]
    );

    // Notify the label.
    try {
      const owner = await pool.query(
        `SELECT user_id FROM label_profiles WHERE id = $1`,
        [labelId]
      );
      if (owner.rows[0]?.user_id) {
        const artistName = await pool.query(
          `SELECT artist_name FROM artist_profiles WHERE user_id = $1 LIMIT 1`,
          [userId]
        );
        await notifyCrossCabinet({
          targetUserId: owner.rows[0].user_id,
          targetRole: 'label',
          sourceRole: 'artist',
          type: 'label_member_left',
          title: 'Артист покинул лейбл',
          message: `${artistName.rows[0]?.artist_name || ''} вышел(а) из вашего ростера.`,
          link: '/label/roster',
          metadata: { artistUserId: userId, initiatedBy: 'artist' },
        });
      }
    } catch (e: any) {
      console.warn('[label] leave notify failed:', e?.message);
    }
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Aggregated reads: releases + analytics across roster ──────────────────────

/**
 * GET /label/releases — list publish orders submitted by this label across
 * its roster. Returns orders + the resolved artist display_name for each.
 */
app.get('/releases', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    if (!gate.labelId) return c.json({ success: true, releases: [] });

    // Заказы публикации (клипы, концерты) лейбла. Колонки `data` в publish_orders
    // больше нет — поля разложены по native-колонкам, читаем через db-хелпер.
    // До 28.09.2026 здесь был SELECT data → 500 на каждый запрос, и лейблы видели
    // «пока нет релизов» вместо своих треков и кнопки «Оплатить». Сбой заказов
    // не должен прятать треки — ловим отдельно.
    const releases: any[] = [];
    try {
      const { listPublishOrdersByUser } = await import('./db.tsx');
      const orders = await listPublishOrdersByUser(gate.userId);
      for (const o of orders.slice(0, 200)) {
        if (o.labelId && o.labelId !== gate.labelId) continue;
        releases.push(o);
      }
    } catch (e: any) {
      console.error('[label/releases] publish orders:', e?.message);
    }

    // Resolve artist display names for the actingFor* set in one query.
    const artistIds = Array.from(new Set(
      releases.map(r => r?.actingForArtistId).filter(Boolean)
    ));
    const nameMap = new Map<string, string>();
    if (artistIds.length > 0) {
      const ap = await pool.query(
        `SELECT id, artist_name FROM artist_profiles WHERE id = ANY($1)`,
        [artistIds]
      );
      for (const row of ap.rows) nameMap.set(row.id, row.artist_name);
    }
    for (const r of releases) {
      r.actingForArtistName = r.actingForArtistId ? nameMap.get(r.actingForArtistId) || null : null;
    }

    // Tracks: include audio tracks the label has uploaded on behalf of
    // roster artists. Either user_id = label OR data.labelId = label
    // catches both the "uploaded via /api/tracks" and the
    // "/api/track-moderation/submitTrack" branches.
    const tr = await pool.query(
      // Migration 089 промоутнула data->>'labelId' в native t.label_id.
      // Используем native cols + индекс idx_tracks_label_id.
      `SELECT t.id, t.title, t.artist_name, t.moderation_status,
              t.cover_url, t.audio_url, t.genre, t.created_at, t.updated_at,
              t.artist_id, t.label_id, t.payment_amount,
              COALESCE(t.is_legacy, false) AS is_legacy,
              COALESCE(t.is_paid, false) OR COALESCE(t.payment_completed, false) AS is_paid,
              ap.artist_name AS resolved_artist_name
       FROM tracks t
       LEFT JOIN artist_profiles ap ON ap.id = t.artist_id
       WHERE t.user_id = $1
          OR t.label_id = $2
       ORDER BY t.created_at DESC
       LIMIT 200`,
      [gate.userId, gate.labelId]
    );

    // Adapt track rows into the same release shape the UI already renders
    // so the frontend doesn't have to deal with two collections. `type:
    // 'track'` is a new union member; `status` maps moderation_status →
    // existing release-status vocab so the same status pills work.
    // Для трека moderation_status='approved' = «одобрен, ждёт ОПЛАТЫ
    // публикации» (checkout-gate track_publish пускает только approved).
    // FE рисует кнопку «Оплатить» на 'pending_payment' → мапим
    // approved→pending_payment. Раньше approved→approved — кнопка не
    // показывалась НИКОГДА, платная публикация лейбла была мертва.
    // paid/upcoming — постоплатные статусы, для лейбла это «опубликован».
    const STATUS_MAP: Record<string, string> = {
      draft: 'draft',
      pending: 'pending_review',
      approved: 'pending_payment',
      pending_payment: 'pending_payment',
      paid: 'published',
      upcoming: 'published',
      published: 'published',
      rejected: 'rejected',
    };
    for (const row of tr.rows) {
      // Guard: skip rows owned by this user but explicitly labeled for a
      // different label (legacy migration safety). Native label_id since 089.
      if (row.label_id && row.label_id !== gate.labelId) continue;
      // Архив promo.fm (is_legacy) и уже оплаченные треки остаются 'approved',
      // но платить за них нельзя: архив — «Одобрено» без кнопки (как в кабинете
      // артиста), оплаченный — «Опубликовано». Иначе блок «Ждут оплаты» звал бы
      // заплатить 10 000 ₽ за архивный трек (25.09.2026).
      let status = STATUS_MAP[row.moderation_status] || row.moderation_status;
      if (row.moderation_status === 'approved') {
        if (row.is_legacy) status = 'approved';
        else if (row.is_paid) status = 'published';
      }
      releases.push({
        id: row.id,
        type: 'track',
        title: row.title,
        status,
        plan: 'track',
        // Цена из track.payment_amount (фиксируется при одобрении); запасная —
        // актуальный тариф, тот же, что amount-gate чекаута берёт при пустом
        // payment_amount. Хардкоды 5000/7000 расходились с тарифом → оплата
        // отбивалась 400 по несовпадению суммы.
        price: status === 'pending_payment' ? (Number(row.payment_amount) || getPublicationPrice()) : 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        actingForArtistId: row.artist_id,
        actingForArtistName: row.resolved_artist_name || row.artist_name || null,
        thumbnailUrl: row.cover_url || null,
        genre: row.genre || null,
      });
    }

    // Re-sort merged collection by createdAt DESC.
    releases.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

    return c.json({ success: true, releases });
  } catch (error: any) {
    console.error('[label/releases]', error?.message);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /label/analytics/artist/:artistProfileId — ДЕТАЛИЗАЦИЯ радио по артисту.
 * Владелец лейбла (2026-07-30): «как посмотреть статистику каждого артиста?» —
 * агрегатов «13 ротаций · 4 станц.» мало, нужно видеть КАКИЕ станции, города и
 * когда. Отдаём разбивку по станциям (города + даты) и по трекам.
 */
app.get('/analytics/artist/:artistProfileId', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    if (!gate.labelId) return c.json({ success: false, error: 'Профиль лейбла не заполнен' }, 400);

    const artistProfileId = c.req.param('artistProfileId');

    // Ownership: артист обязан быть в ростере ЭТОГО лейбла (иначе чужая аналитика).
    const own = await pool.query(
      `SELECT id, artist_name FROM artist_profiles
        WHERE id::text = $1 AND (managed_by_label_id = $2 OR label_id = $2) LIMIT 1`,
      [artistProfileId, gate.labelId]
    );
    if (own.rows.length === 0) {
      return c.json({ success: false, error: 'Артист не найден в вашем ростере' }, 404);
    }
    const artistName = own.rows[0].artist_name;

    // По станциям: города + окно дат + сумма ротаций. Только подтверждённые,
    // без source='auto' (витринный декор — в кабинет не показываем).
    const byStation = await pool.query(
      `SELECT rp.station_name,
              COALESCE(SUM(rp.rotation_count), 0)::int      AS rotations,
              COUNT(DISTINCT rp.city)::int                  AS cities_count,
              ARRAY_AGG(DISTINCT rp.city) FILTER (WHERE rp.city IS NOT NULL) AS cities,
              MIN(rp.picked_up_at)::date                    AS first_pickup,
              MAX(rp.picked_up_at)::date                    AS last_pickup,
              COUNT(DISTINCT rp.track_id)::int              AS tracks_count,
              -- Подтверждение эфиром: есть ли детекция фингерпринта по этому
              -- треку на этой станции. Считаем на лету – как только ПРОМО.CHECK
              -- поймает трек, статус сам станет «подтверждён» (инцидент
              -- 2026-08-03: партнёрские заявки показывались как факт эфира).
              BOOL_OR(EXISTS (
                SELECT 1 FROM promo_check_detections d
                 WHERE d.track_id = rp.track_id AND d.station_name = rp.station_name
              ))                                            AS airplay_verified,
              BOOL_OR(rp.source = 'radio_cabinet')          AS from_station_cabinet
         FROM track_radio_pickups rp
         JOIN tracks t ON t.id = rp.track_id
        WHERE t.artist_id = $1
          AND rp.report_status = 'confirmed'
          AND rp.source IS DISTINCT FROM 'auto'
        GROUP BY rp.station_name
        ORDER BY rotations DESC, rp.station_name`,
      [artistProfileId]
    );

    // По трекам артиста: сколько станций/городов/ротаций у каждого.
    const byTrack = await pool.query(
      `SELECT t.id, t.title, t.moderation_status, t.plays_count, t.cover_url,
              COALESCE(SUM(rp.rotation_count), 0)::int AS rotations,
              COUNT(DISTINCT rp.station_name)::int     AS stations,
              COUNT(DISTINCT rp.city)::int             AS cities,
              COALESCE(SUM(rp.rotation_count) FILTER (WHERE EXISTS (
                SELECT 1 FROM promo_check_detections d
                 WHERE d.track_id = rp.track_id AND d.station_name = rp.station_name)), 0)::int AS rotations_verified
         FROM tracks t
         LEFT JOIN track_radio_pickups rp
                ON rp.track_id = t.id
               AND rp.report_status = 'confirmed'
               AND rp.source IS DISTINCT FROM 'auto'
        WHERE t.artist_id = $1
        GROUP BY t.id, t.title, t.moderation_status, t.plays_count, t.cover_url
        ORDER BY rotations DESC, t.created_at DESC`,
      [artistProfileId]
    );

    const totals = byStation.rows.reduce(
      (acc: any, r: any) => ({
        rotations: acc.rotations + Number(r.rotations || 0),
        rotationsVerified: acc.rotationsVerified + (r.airplay_verified ? Number(r.rotations || 0) : 0),
        stationsVerified: acc.stationsVerified + (r.airplay_verified ? 1 : 0),
      }),
      { rotations: 0, rotationsVerified: 0, stationsVerified: 0 }
    );
    const allCities = new Set<string>();
    for (const r of byStation.rows) for (const city of (r.cities || [])) allCities.add(String(city));

    return c.json({
      success: true,
      artist: { id: artistProfileId, name: artistName },
      totals: {
        rotations: totals.rotations,
        rotationsVerified: totals.rotationsVerified,
        rotationsDeclared: totals.rotations - totals.rotationsVerified,
        stations: byStation.rows.length,
        stationsVerified: totals.stationsVerified,
        cities: allCities.size,
        tracks: byTrack.rows.length,
      },
      stations: byStation.rows,
      tracks: byTrack.rows,
    });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /label/analytics/overview — aggregated counters across the entire
 * roster. Sums plays/likes/followers from artist_profiles + tracks for any
 * artist where managed_by_label_id OR label_id = this label.
 */
app.get('/analytics/overview', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    if (!gate.labelId) {
      return c.json({
        success: true,
        overview: {
          artistsManaged: 0, artistsLinked: 0,
          totalPlays: 0, totalLikes: 0, totalFollowers: 0,
          totalTracks: 0, publishedTracks: 0,
          topArtists: [],
        },
      });
    }

    const cnt = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE managed_by_label_id = $1) AS managed,
         COUNT(*) FILTER (WHERE label_id = $1)             AS linked,
         COALESCE(SUM(total_plays), 0)                     AS total_plays,
         COALESCE(SUM(total_followers), 0)                 AS total_followers
       FROM artist_profiles
       WHERE managed_by_label_id = $1 OR label_id = $1`,
      [gate.labelId]
    );

    const tr = await pool.query(
      `SELECT
         COUNT(*)                                  AS total_tracks,
         -- Audit 2026-06-04: 'approved' = hidden (is_hidden), NOT live; live is
         -- 'published' (matches artist-profile-routes canonical). And plays/likes
         -- must sum only 'published' or the label sees MORE than the artist's own page.
         COUNT(*) FILTER (WHERE t.moderation_status = 'published') AS published_tracks,
         COALESCE(SUM(t.likes_count) FILTER (WHERE t.moderation_status = 'published'), 0) AS total_likes,
         COALESCE(SUM(t.plays_count) FILTER (WHERE t.moderation_status = 'published'), 0) AS total_track_plays
       FROM tracks t
       JOIN artist_profiles ap ON ap.id = t.artist_id
       WHERE ap.managed_by_label_id = $1 OR ap.label_id = $1`,
      [gate.labelId]
    );

    const top = await pool.query(
      `SELECT ap.id, ap.artist_name AS display_name, ap.avatar_url,
              ap.total_plays, ap.total_followers
       FROM artist_profiles ap
       WHERE ap.managed_by_label_id = $1 OR ap.label_id = $1
       ORDER BY ap.total_plays DESC NULLS LAST
       LIMIT 5`,
      [gate.labelId]
    );

    // Радио-след ростера: подтверждённые ротации (source='auto' — витринный
    // декор, не считаем). Раньше лейбл-кабинет НЕ показывал радио вовсе —
    // «нет статистики, а треки качали радио» (кейс clubtop 2026-07-27).
    const radio = await pool.query(
      `SELECT
         COALESCE(SUM(rp.rotation_count), 0)::int AS rotations,
         COUNT(DISTINCT rp.station_name)::int     AS stations,
         COUNT(DISTINCT rp.city)::int             AS cities,
         COALESCE(SUM(rp.rotation_count) FILTER (WHERE EXISTS (
           SELECT 1 FROM promo_check_detections d
            WHERE d.track_id = rp.track_id AND d.station_name = rp.station_name)), 0)::int AS rotations_verified
       FROM track_radio_pickups rp
       JOIN tracks t ON t.id = rp.track_id
       JOIN artist_profiles ap ON ap.id = t.artist_id
       WHERE (ap.managed_by_label_id = $1 OR ap.label_id = $1)
         AND rp.report_status = 'confirmed'
         AND rp.source IS DISTINCT FROM 'auto'`,
      [gate.labelId]
    );

    // 14.10.2026: станции и города считаем вместе со скачиваниями (track_downloads_by_radio).
    // Раньше «Станций / городов» было 0, хотя станции уже скачали трек ростера (кейс лейбла Арины).
    const reach = await pool.query(
      `SELECT COUNT(DISTINCT s.station_name)::int AS stations,
              COUNT(DISTINCT s.city) FILTER (WHERE s.city IS NOT NULL AND s.city <> '')::int AS cities,
              COUNT(DISTINCT s.station_name) FILTER (WHERE s.kind = 'dl')::int AS downloaded
         FROM (
           SELECT rp.station_name, rp.city, 'rp' AS kind
             FROM track_radio_pickups rp
             JOIN tracks t ON t.id = rp.track_id
             JOIN artist_profiles ap ON ap.id = t.artist_id
            WHERE (ap.managed_by_label_id = $1 OR ap.label_id = $1)
              AND rp.report_status = 'confirmed' AND rp.source IS DISTINCT FROM 'auto'
           UNION ALL
           SELECT d.station_name, d.city, 'dl'
             FROM track_downloads_by_radio d
             JOIN tracks t ON t.id = d.track_id
             JOIN artist_profiles ap ON ap.id = t.artist_id
            WHERE (ap.managed_by_label_id = $1 OR ap.label_id = $1)
              AND d.station_name IS NOT NULL AND d.station_name <> ''
         ) s`,
      [gate.labelId]
    );

    const row = cnt.rows[0] || {};
    const trRow = tr.rows[0] || {};
    const radioRow = radio.rows[0] || {};
    const reachRow = reach.rows[0] || {};
    return c.json({
      success: true,
      overview: {
        artistsManaged: Number(row.managed) || 0,
        artistsLinked: Number(row.linked) || 0,
        totalPlays: Number(trRow.total_track_plays) || 0, // live published SUM (was Math.max with stale, unwritten ap.total_plays)
        totalLikes: Number(trRow.total_likes) || 0,
        totalFollowers: Number(row.total_followers) || 0,
        totalTracks: Number(trRow.total_tracks) || 0,
        publishedTracks: Number(trRow.published_tracks) || 0,
        radioRotations: Number(radioRow.rotations) || 0,
        radioRotationsVerified: Number(radioRow.rotations_verified) || 0,
        radioRotationsDeclared: (Number(radioRow.rotations) || 0) - (Number(radioRow.rotations_verified) || 0),
        radioStations: Math.max(Number(reachRow.stations) || 0, Number(radioRow.stations) || 0),
        radioCities: Math.max(Number(reachRow.cities) || 0, Number(radioRow.cities) || 0),
        radioStationsDownloaded: Number(reachRow.downloaded) || 0,
        topArtists: top.rows,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Profile image uploads ──
//
// Label profile editor (Promomusicfigma/src/app/components/label/
// LabelProfilePage.tsx) historically only let users paste an avatar
// URL into a text field. These endpoints add a proper file-upload
// path matching the DJ profile editor's UX. Files land in shared
// `label-avatars` / `label-covers` subdirs under UPLOADS_BASE; the
// public URL is written into the existing `avatar_url` / `cover_url`
// columns on `label_profiles`.
//
// IMAGE_EXTS / MAX_IMAGE_BYTES (8 MB) come from cabinet-uploads.tsx
// — same contract as future cabinets.

app.post('/profile/avatar', requireAuth, async (c) => {
  try {
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);
    const uploaded = await saveUpload(file, 'label-avatars', `avatar-${gate.userId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);
    await pool.query(
      `UPDATE label_profiles SET avatar_url = $1, updated_at = NOW() WHERE user_id = $2`,
      [uploaded.url, gate.userId]
    );
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Label avatar upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

app.post('/profile/cover', requireAuth, async (c) => {
  try {
    const gate = await requireLabelRole(c);
    if (gate instanceof Response) return gate;
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);
    const uploaded = await saveUpload(file, 'label-covers', `cover-${gate.userId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);
    await pool.query(
      `UPDATE label_profiles SET cover_url = $1, updated_at = NOW() WHERE user_id = $2`,
      [uploaded.url, gate.userId]
    );
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Label cover upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

export default app;

