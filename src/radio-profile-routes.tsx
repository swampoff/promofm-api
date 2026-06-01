/**
 * RADIO STATION PROFILE ROUTES
 * Получение и обновление профиля радиостанции
 * Источник данных: PostgreSQL
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { getRadioProfile, upsertRadioProfile } from './db.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { saveUpload, IMAGE_EXTS, MAX_IMAGE_BYTES } from './cabinet-uploads.tsx';

const app = new Hono();

// ── Типы ──────────────────────────────────────────────────

interface RadioSocials {
  instagram: string;
  facebook: string;
  twitter: string;
  youtube: string;
}

interface RadioProfile {
  id: string;
  name: string;
  email: string;
  city: string;
  country: string;
  frequency: string;
  broadcast_cities: string[];
  formats: string[];
  listeners: string;
  status: string;
  description: string;
  founded: string;
  phone: string;
  website: string;
  address: string;
  streamUrl: string;
  backupStreamUrl: string;
  bitrate: string;
  audioFormat: string;
  socials: RadioSocials;
  tracksInRotation: number;
  partners: number;
  monthlyReach: string;
  totalArtistRequests: number;
  totalAdSlots: number;
  revenue: number;
  createdAt: string;
}

const ALLOWED_UPDATE_FIELDS = new Set([
  'name', 'email', 'city', 'country', 'frequency', 'broadcast_cities', 'formats',
  'description', 'founded', 'phone', 'website', 'address',
  'streamUrl', 'backupStreamUrl', 'bitrate', 'audioFormat',
  'socials', 'listeners', 'status',
]);

// ── Helpers ───────────────────────────────────────────────

const EMPTY_SOCIALS: RadioSocials = {
  instagram: '', facebook: '', twitter: '', youtube: '',
};

function makeRadioProfile(overrides: Partial<RadioProfile> & { id: string; name: string; email: string }): RadioProfile {
  return {
    city: '',
    country: 'Россия',
    frequency: '',
    broadcast_cities: [],
    formats: [],
    listeners: '0',
    status: 'Online',
    description: '',
    founded: '',
    phone: '',
    website: '',
    address: '',
    streamUrl: '',
    backupStreamUrl: '',
    bitrate: '320 kbps',
    audioFormat: 'MP3',
    socials: { ...EMPTY_SOCIALS },
    tracksInRotation: 0,
    partners: 0,
    monthlyReach: '0',
    totalArtistRequests: 0,
    totalAdSlots: 0,
    revenue: 0,
    createdAt: '',
    ...overrides,
    socials: { ...EMPTY_SOCIALS, ...overrides.socials },
  };
}

function parseKvProfile(raw: unknown): RadioProfile | null {
  if (!raw) return null;
  return raw as RadioProfile;
}

async function loadFromKv(radioId: string): Promise<RadioProfile | null> {
  const raw = await getRadioProfile(radioId);
  return parseKvProfile(raw);
}

async function saveToKv(radioId: string, profile: RadioProfile): Promise<void> {
  await upsertRadioProfile(radioId, profile as Record<string, unknown>);
}

function sanitizeUpdates(updates: Record<string, unknown>): Partial<RadioProfile> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(updates)) {
    if (ALLOWED_UPDATE_FIELDS.has(key)) {
      clean[key] = updates[key];
    }
  }
  return clean as Partial<RadioProfile>;
}

// ── Routes ────────────────────────────────────────────────

/**
 * GET /profile/:radioId
 * Загрузка из KV → 404
 *
 * Audit INC-R2 (2026-05-31): requireAuth + ownsRadioProfile check.
 * Раньше любой мог читать чужой profile через guess radioId — потенциально
 * leak'ал email/phone владельца станции из jsonb. Public-snapshot для
 * лендинга идёт отдельным endpoint'ом (через `radio_stations` table,
 * без PII), этот же — owner-only (+ admin для модерации).
 */
app.get('/profile/:radioId', requireAuth, async (c) => {
  const radioId = c.req.param('radioId');
  console.log(`[RadioProfile] GET ${radioId}`);

  if (!(await ownsRadioProfile(c, radioId))) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  try {
    const kvProfile = await loadFromKv(radioId);
    if (kvProfile) {
      return c.json({ success: true, source: 'kv', data: kvProfile });
    }

    return c.json({ success: false, error: 'Radio profile not found' }, 404);
  } catch (error) {
    console.error(`[RadioProfile] GET error: ${error}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /profile/:radioId
 * Обновить профиль радиостанции (requires auth)
 */
app.put('/profile/:radioId', requireAuth, async (c) => {
  const radioId = c.req.param('radioId');
  console.log(`[RadioProfile] PUT ${radioId}`);

  // Audit INC-R1 (2026-05-31): ownership check. Раньше любая авторизованная
  // radio_station могла переписать чужой profile через crafted radioId.
  // ownsRadioProfile проверяет radio_profiles.user_id == c.get('userId')
  // (admin/superadmin auto-pass для модерации).
  if (!(await ownsRadioProfile(c, radioId))) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  try {
    const rawUpdates = await c.req.json();
    const updates = sanitizeUpdates(rawUpdates);

    if (Object.keys(updates).length === 0) {
      return c.json({ success: false, error: 'No valid fields to update' }, 400);
    }

    // Load existing or create new
    let currentProfile = await loadFromKv(radioId);
    if (!currentProfile) {
      const userEmail = c.get('userEmail') || '';
      currentProfile = makeRadioProfile({
        id: radioId,
        name: (updates.name as string) || '',
        email: userEmail,
        createdAt: new Date().toISOString(),
      });
    }

    const updatedProfile: RadioProfile = {
      ...currentProfile,
      ...updates,
      socials: {
        ...currentProfile.socials,
        ...(updates.socials || {}),
      },
    };

    await saveToKv(radioId, updatedProfile);

    console.log(`[RadioProfile] Updated: ${radioId} → ${updatedProfile.name}`);
    return c.json({ success: true, data: updatedProfile });
  } catch (error) {
    console.error(`[RadioProfile] PUT error: ${error}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /request-verification — radio station submits a verification
 * request. Mirrors artist's POST /artist-profile/request-verification
 * (migration 058) and venue's new POST /venue/request-verification.
 * Admin processes via POST /auth/admin/verify-profile { role:
 * 'radio_station', isVerified, rejectionReason? }.
 *
 * Idempotent: re-clicking refreshes verification_requested_at and
 * clears rejection_reason. Authenticated user_id is the station —
 * URL param is not needed (the existing :radioId routes use the URL
 * param, but for request-verification the JWT identity is sufficient).
 *
 * Migration 062 added the underlying columns.
 */
app.post('/request-verification', requireAuth, async (c) => {
  const userId = c.get('userId' as never) as string | undefined;
  if (!userId) {
    return c.json({ success: false, error: 'Не авторизован' }, 401);
  }
  try {
    const { rows } = await pool.query(
      `SELECT is_verified FROM radio_profiles WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) {
      return c.json({ success: false, error: 'Radio profile not found' }, 404);
    }
    if (rows[0].is_verified) {
      return c.json({ success: false, error: 'Профиль уже верифицирован' }, 400);
    }
    await pool.query(
      `UPDATE radio_profiles
          SET verification_requested_at     = NOW(),
              verification_rejection_reason = NULL
        WHERE user_id = $1`,
      [userId],
    );
    console.log(`[RadioProfile] Verification requested by ${userId}`);
    return c.json({
      success: true,
      message: 'Заявка на верификацию отправлена. Ожидайте рассмотрения администратором.',
    });
  } catch (error) {
    console.error('[RadioProfile] request-verification error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /profile/:radioId/stats
 * Статистика радиостанции
 */
app.get('/profile/:radioId/stats', async (c) => {
  const radioId = c.req.param('radioId');

  try {
    const profile = await loadFromKv(radioId);
    if (profile) {
      return c.json({
        success: true,
        data: {
          listeners: profile.listeners,
          tracksInRotation: profile.tracksInRotation,
          partners: profile.partners,
          monthlyReach: profile.monthlyReach,
          totalArtistRequests: profile.totalArtistRequests,
          totalAdSlots: profile.totalAdSlots,
          revenue: profile.revenue,
        },
      });
    }

    return c.json({ success: false, error: 'Radio profile not found' }, 404);
  } catch (error) {
    console.error(`[RadioProfile] Stats error: ${error}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── Logo / cover uploads ────────────────────────────────────────
//
// Радио до миграции 026 единственный кабинет без logo поля в БД.
// Эти endpoint-ы используют тот же shared `cabinet-uploads.tsx`
// что dj-studio / producer-studio / label / engineer. Файлы в
// subdir-ах `radio-logos` / `radio-covers` под UPLOADS_BASE,
// nginx раздаёт через `/server/uploads/` alias.
//
// Gate: requireAuth + сравнение userId с user_id строки radio_profiles
// (admin'у разрешено для модерации).

async function ownsRadioProfile(c: any, radioId: string): Promise<boolean> {
  const userId = String(c.get('userId') || '');
  const role = String(c.get('userRole') || '');
  if (role === 'admin' || role === 'superadmin') return true;
  if (!userId) return false;
  const r = await pool.query(
    `SELECT 1 FROM radio_profiles WHERE id::text = $1 AND user_id = $2 LIMIT 1`,
    [radioId, userId],
  );
  return r.rows.length > 0;
}

// Атомарно обновить и native колонку (для маркетплейса / cross-cabinet),
// и jsonb data (для editor-rehydration через `getRadioProfile`).
// Без второго update GET /profile вернёт jsonb без logoUrl потому
// что parseKvProfile читает только из data.
async function persistRadioImage(radioId: string, field: 'logoUrl' | 'coverUrl', url: string) {
  const column = field === 'logoUrl' ? 'logo_url' : 'cover_url';
  await pool.query(
    `UPDATE radio_profiles SET ${column} = $1, updated_at = NOW() WHERE id::text = $2`,
    [url, radioId],
  );
  // Merge в data jsonb тоже — editor / GET читают именно оттуда.
  const existing = (await getRadioProfile(radioId)) as any || {};
  await upsertRadioProfile(radioId, { ...existing, [field]: url });
}

app.post('/profile/:radioId/logo', requireAuth, async (c) => {
  const radioId = c.req.param('radioId');
  try {
    if (!(await ownsRadioProfile(c, radioId))) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);
    const uploaded = await saveUpload(file, 'radio-logos', `logo-${radioId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);
    await persistRadioImage(radioId, 'logoUrl', uploaded.url);
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Radio logo upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

app.post('/profile/:radioId/cover', requireAuth, async (c) => {
  const radioId = c.req.param('radioId');
  try {
    if (!(await ownsRadioProfile(c, radioId))) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);
    const uploaded = await saveUpload(file, 'radio-covers', `cover-${radioId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);
    await persistRadioImage(radioId, 'coverUrl', uploaded.url);
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Radio cover upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

export default app;
