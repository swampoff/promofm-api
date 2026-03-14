/**
 * ARTIST PROFILE ROUTES
 * Получение и обновление профиля артиста
 * Источники данных: VPS (152-ФЗ) + SQL
 */

import { Hono } from 'hono';
import { getDbClient } from './db-client.tsx';
import * as db from './db.tsx';
import { vpsGetProfile, vpsSaveProfile, vpsListProfiles } from './vps-userdata.tsx';
import { requireAuth } from './auth-middleware.tsx';

const app = new Hono();

// ── Типы ──────────────────────────────────────────────────

interface ArtistSocials {
  instagram: string;
  twitter: string;
  facebook: string;
  youtube: string;
  spotify: string;
  appleMusic: string;
}

interface ArtistProfile {
  id: string;
  email: string;
  username: string;
  fullName: string;
  bio: string;
  avatarUrl: string;
  location: string;
  city: string;
  country: string;
  website: string;
  phone: string;
  genres: string[];
  rating: number;
  totalPlays: number;
  totalFollowers: number;
  totalConcerts: number;
  totalTracks: number;
  coinsBalance: number;
  isVerified: boolean;
  socials: ArtistSocials;
  careerStart: string;
  label: string;
  manager: string;
  bookingEmail: string;
  languages: string[];
  createdAt: string;
}

// Допустимые поля для обновления через PUT
const ALLOWED_UPDATE_FIELDS = new Set([
  'fullName', 'bio', 'avatarUrl', 'location', 'city', 'country',
  'website', 'phone', 'genres', 'label', 'manager', 'bookingEmail',
  'careerStart', 'languages', 'username', 'email', 'socials',
]);

// ── Helpers ───────────────────────────────────────────────

const EMPTY_SOCIALS: ArtistSocials = {
  instagram: '', twitter: '', facebook: '',
  youtube: '', spotify: '', appleMusic: '',
};

function makeProfile(overrides: Partial<ArtistProfile> & { id: string; email: string; fullName: string }): ArtistProfile {
  return {
    username: '',
    bio: '',
    avatarUrl: '',
    location: '',
    city: '',
    country: 'Россия',
    website: '',
    phone: '',
    genres: [],
    rating: 0,
    totalPlays: 0,
    totalFollowers: 0,
    totalConcerts: 0,
    totalTracks: 0,
    coinsBalance: 0,
    isVerified: false,
    socials: { ...EMPTY_SOCIALS },
    careerStart: '',
    label: '',
    manager: '',
    bookingEmail: '',
    languages: ['Русский'],
    createdAt: '',
    ...overrides,
    socials: { ...EMPTY_SOCIALS, ...overrides.socials },
  };
}

/** Безопасный парсинг KV-значения */
function parseKvProfile(raw: unknown): ArtistProfile | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as ArtistProfile;
      return null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as ArtistProfile;
  return null;
}

/** Загрузить профиль из VPS (152-ФЗ) */
async function loadFromKv(artistId: string): Promise<ArtistProfile | null> {
  const raw = await vpsGetProfile(artistId);
  return parseKvProfile(raw);
}

/** Сохранить профиль на VPS (152-ФЗ) */
async function saveToKv(artistId: string, profile: ArtistProfile): Promise<void> {
  await vpsSaveProfile(artistId, profile as Record<string, unknown>);
}

/** Фильтрация обновлений по белому списку полей */
function sanitizeUpdates(updates: Record<string, unknown>): Partial<ArtistProfile> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(updates)) {
    if (ALLOWED_UPDATE_FIELDS.has(key)) {
      clean[key] = updates[key];
    }
  }
  return clean as Partial<ArtistProfile>;
}

// ── Routes ────────────────────────────────────────────────

/**
 * GET /profile/:artistId
 * Загрузка: KV → auth-profile → 404
 */
app.get('/profile/:artistId', async (c) => {
  const artistId = c.req.param('artistId');
  console.log(`[ArtistProfile] GET ${artistId}`);

  try {
    // 1. KV/VPS cache
    const kvProfile = await loadFromKv(artistId);
    if (kvProfile) {
      return c.json({ success: true, source: 'kv', data: kvProfile });
    }

    // 2. Try auth-created profile (stored at profile:${artistId} by signup route)
    try {
      const authProfile = await vpsGetProfile(artistId);
      if (authProfile && typeof authProfile === 'object') {
        const ap = authProfile as Record<string, unknown>;
        const fullName = (ap.name as string) || (ap.email as string)?.split('@')[0] || 'Артист';
        const newProfile = makeProfile({
          id: artistId,
          email: (ap.email as string) || '',
          fullName,
          bio: (ap.bio as string) || '',
          avatarUrl: (ap.avatar as string) || '',
          city: (ap.city as string) || '',
        });
        await saveToKv(artistId, newProfile);
        return c.json({ success: true, source: 'auth-profile', data: newProfile });
      }
    } catch { /* continue to 404 */ }

    return c.json({ success: false, error: `Artist not found: ${artistId}` }, 404);

  } catch (error) {
    console.error(`[ArtistProfile] GET error: ${error}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /profile/:artistId
 * Обновить профиль с валидацией полей
 */
app.put('/profile/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  console.log(`[ArtistProfile] PUT ${artistId}`);

  try {
    const rawUpdates = await c.req.json();
    const updates = sanitizeUpdates(rawUpdates);

    if (Object.keys(updates).length === 0) {
      return c.json({ success: false, error: 'No valid fields to update' }, 400);
    }

    // Получаем текущий профиль или создаём новый
    let currentProfile = await loadFromKv(artistId);
    if (!currentProfile) {
      const authUserId = c.get('userId');
      const userEmail = c.get('userEmail') || '';
      currentProfile = makeProfile({
        id: artistId,
        email: userEmail,
        fullName: (updates.fullName as string) || '',
        createdAt: new Date().toISOString(),
      });
    }

    // Мержим с глубоким слиянием socials
    const updatedProfile: ArtistProfile = {
      ...currentProfile,
      ...updates,
      socials: {
        ...currentProfile.socials,
        ...(updates.socials || {}),
      },
    };

    // Сохраняем в KV
    await saveToKv(artistId, updatedProfile);

    // Best-effort SQL update
    try {
      const supabase = getDbClient();
      await supabase
        .from('artists')
        .update({
          full_name: updatedProfile.fullName,
          bio: updatedProfile.bio,
          avatar_url: updatedProfile.avatarUrl,
          location: updatedProfile.location,
          website: updatedProfile.website,
          phone: updatedProfile.phone,
          instagram: updatedProfile.socials.instagram,
          twitter: updatedProfile.socials.twitter,
          facebook: updatedProfile.socials.facebook,
          youtube: updatedProfile.socials.youtube,
          spotify: updatedProfile.socials.spotify,
          apple_music: updatedProfile.socials.appleMusic,
          updated_at: new Date().toISOString(),
        })
        .eq('email', currentProfile.email);
    } catch {
      console.log('[ArtistProfile] SQL update skipped (table may not exist)');
    }

    console.log(`[ArtistProfile] Updated: ${artistId}`);
    return c.json({ success: true, data: updatedProfile });

  } catch (error) {
    console.error(`[ArtistProfile] PUT error: ${error}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /profile/:artistId/stats
 * Лёгкий endpoint только для статистики
 */
app.get('/profile/:artistId/stats', async (c) => {
  const artistId = c.req.param('artistId');

  try {
    // KV profile
    const profile = await loadFromKv(artistId);
    if (profile) {
      return c.json({
        success: true,
        data: {
          totalPlays: profile.totalPlays ?? 0,
          totalFollowers: profile.totalFollowers ?? 0,
          totalConcerts: profile.totalConcerts ?? 0,
          coinsBalance: profile.coinsBalance ?? 0,
        },
      });
    }

    return c.json({ success: false, error: 'Stats not found' }, 404);
  } catch (error) {
    console.error(`[ArtistProfile] Stats error: ${error}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /popular
 * Публичный endpoint — возвращает популярных артистов для лендинга
 * Источник: только реальные профили из VPS
 */
app.get('/popular', async (c) => {
  console.log('[ArtistProfile] GET /popular');

  try {
    const kvValues = await vpsListProfiles();
    const profiles: ArtistProfile[] = [];

    for (const rawValue of kvValues) {
      const parsed = parseKvProfile(rawValue);
      if (parsed && parsed.id && parsed.fullName) {
        profiles.push(parsed);
      }
    }

    const allProfiles = profiles
      .sort((a, b) => (b.totalPlays || 0) - (a.totalPlays || 0))
      .slice(0, 12)
      .map(p => ({
        id: p.id,
        name: p.fullName,
        genre: (p.genres && p.genres[0]) || 'Music',
        genres: p.genres || [],
        city: p.city || '',
        listeners: p.totalFollowers || 0,
        plays: p.totalPlays || 0,
        tracks: p.totalTracks || 0,
        rating: p.rating || 0,
        avatarUrl: p.avatarUrl || '',
        isVerified: p.isVerified || false,
      }));

    console.log(`[ArtistProfile] Popular: ${allProfiles.length} artists`);
    return c.json({ success: true, data: allProfiles });

  } catch (error) {
    console.error(`[ArtistProfile] Popular error: ${error}`);
    return c.json({ success: true, data: [] });
  }
});

/**
 * GET /profile/:artistId/tracks
 * Возвращает треки артиста из БД
 */
app.get('/profile/:artistId/tracks', async (c) => {
  const artistId = c.req.param('artistId');
  console.log(`[ArtistProfile] GET /profile/${artistId}/tracks`);

  try {
    // Get real tracks from tracks store
    const tracks = await db.getTracksByUser(artistId);
    return c.json({ success: true, data: tracks || [] });
  } catch (error) {
    console.error(`[ArtistProfile] Tracks error: ${error}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /profile/:artistId/similar
 * Возвращает похожих артистов по жанрам (только реальные профили)
 */
app.get('/profile/:artistId/similar', async (c) => {
  const artistId = c.req.param('artistId');
  console.log(`[ArtistProfile] GET /profile/${artistId}/similar`);

  try {
    const profile = await loadFromKv(artistId);
    if (!profile) {
      return c.json({ success: false, error: `Artist not found: ${artistId}` }, 404);
    }

    const myGenres = new Set((profile.genres || []).map((g: string) => g.toLowerCase()));

    // Collect all real profiles from VPS
    const allProfiles = new Map<string, ArtistProfile>();
    try {
      const kvValues = await vpsListProfiles();
      for (const rawValue of kvValues) {
        const parsed = parseKvProfile(rawValue);
        if (parsed && parsed.id && parsed.id !== artistId) {
          allProfiles.set(parsed.id, parsed);
        }
      }
    } catch {
      // VPS not available
    }

    // Score each artist by genre overlap
    const genreFamilies: Record<string, string[]> = {
      'electronic': ['electronic', 'synth-pop', 'techno', 'house', 'ambient', 'dream pop'],
      'rock': ['rock', 'alternative', 'post-rock', 'pop-rock', 'punk', 'shoegaze'],
      'urban': ['hip-hop', 'trap', 'r&b', 'soul', 'neo-soul'],
      'acoustic': ['folk', 'indie', 'jazz'],
      'chill': ['lo-fi', 'chillhop', 'ambient', 'dream pop'],
    };

    const scored = Array.from(allProfiles.values())
      .map(p => {
        const theirGenres = (p.genres || []).map((g: string) => g.toLowerCase());
        const overlap = theirGenres.filter((g: string) => myGenres.has(g)).length;
        let familyScore = 0;
        for (const family of Object.values(genreFamilies)) {
          const myInFamily = [...myGenres].some(g => family.includes(g));
          const theirInFamily = theirGenres.some((g: string) => family.includes(g));
          if (myInFamily && theirInFamily) familyScore += 0.5;
        }
        const totalScore = overlap * 2 + familyScore + Math.log10(Math.max(p.totalPlays || 1, 1)) * 0.1;
        return { profile: p, score: totalScore };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const similar = scored.map(s => ({
      id: s.profile.id,
      name: s.profile.fullName,
      genre: (s.profile.genres && s.profile.genres[0]) || 'Music',
      genres: s.profile.genres || [],
      city: s.profile.city || '',
      plays: s.profile.totalPlays || 0,
      followers: s.profile.totalFollowers || 0,
      avatarUrl: s.profile.avatarUrl || '',
      isVerified: s.profile.isVerified || false,
      rating: s.profile.rating || 0,
      matchScore: Math.round(s.score * 10) / 10,
    }));

    console.log(`[ArtistProfile] Similar for ${artistId}: ${similar.length} results`);
    return c.json({ success: true, data: similar });
  } catch (error) {
    console.error(`[ArtistProfile] Similar error: ${error}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default app;
