/**
 * RADIO STATION PROFILE ROUTES
 * Получение и обновление профиля радиостанции
 * Источник данных: PostgreSQL
 */

import { Hono } from 'hono';
import { getRadioProfile, upsertRadioProfile } from './db.tsx';
import { requireAuth } from './auth-middleware.tsx';

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
 */
app.get('/profile/:radioId', async (c) => {
  const radioId = c.req.param('radioId');
  console.log(`[RadioProfile] GET ${radioId}`);

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

export default app;
