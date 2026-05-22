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
import { requireAuth } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';

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

    // 3. Extend artist_profiles for managed + linked roster. user_id becomes
    // nullable; managed_by_label_id/label_id encode roster relationship.
    await pool.query(`
      ALTER TABLE artist_profiles
        ALTER COLUMN user_id DROP NOT NULL;
    `).catch((e) => {
      // The constraint may already be dropped on re-runs, or the column was
      // never NOT NULL on this deployment — either is fine.
      if (!/cannot|does not exist/i.test(e?.message || '')) {
        console.warn('[label] artist_profiles user_id drop not null:', e?.message);
      }
    });
    await pool.query(`
      ALTER TABLE artist_profiles
        ADD COLUMN IF NOT EXISTS managed_by_label_id UUID NULL REFERENCES label_profiles(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS is_managed BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS label_id UUID NULL REFERENCES label_profiles(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_artist_profiles_managed_by ON artist_profiles(managed_by_label_id) WHERE managed_by_label_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_artist_profiles_label_id   ON artist_profiles(label_id) WHERE label_id IS NOT NULL;
    `);

    // 4. label_invitations — pending/accepted/declined invitations to existing artists.
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
         CASE
           WHEN ap.managed_by_label_id = $1 THEN 'managed'
           WHEN ap.label_id = $1 THEN 'linked'
           ELSE 'unknown'
         END              AS kind,
         ap.created_at    AS joined_at
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

export default app;
