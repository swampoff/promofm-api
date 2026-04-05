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
  const isUuidParam = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artistId);

  try {
    // 1. KV/VPS cache (only for UUIDs — slug keys are not stored in KV)
    if (isUuidParam) {
      const kvProfile = await loadFromKv(artistId);
      if (kvProfile) {
        return c.json({ success: true, source: 'kv', data: kvProfile });
      }
    }

    // 2. Try auth-created profile (stored at profile:${artistId} by signup route)
    try {
      if (!isUuidParam) throw new Error('skip');
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

    // 3. Fallback to artist_profiles SQL table (populated from artists + tracks)
    try {
      const { getDbClient } = await import('./db-client.tsx');
      const dbClient = getDbClient();
      
      // Check if artistId is a valid UUID before UUID-based queries
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artistId);
      let apRow: any = null;

      if (isUUID) {
        // Try by user_id first, then by id
        const { data: r1 } = await dbClient
          .from('artist_profiles')
          .select('*')
          .eq('user_id', artistId)
          .maybeSingle();
        apRow = r1;

        if (!apRow) {
          const { data: r2 } = await dbClient
            .from('artist_profiles')
            .select('*')
            .eq('id', artistId)
            .maybeSingle();
          apRow = r2;
        }
      }

      // 3c. Try by slug (e.g., /profile/feduk)
      if (!apRow) {
        const { data: apRow3 } = await dbClient
          .from('artist_profiles')
          .select('*')
          .eq('slug', artistId.toLowerCase())
          .maybeSingle();
        apRow = apRow3;
      }

      // 3d. Fuzzy slug fallback (slug with hash suffix, e.g., bearwolf-6ac34de5)
      if (!apRow) {
        const { pool } = await import('./db-client.tsx');
        const { rows: fuzzyRows } = await pool.query(
          "SELECT * FROM artist_profiles WHERE slug LIKE  ORDER BY total_plays DESC NULLS LAST LIMIT 1",
          [artistId.toLowerCase() + '-%']
        );
        if (fuzzyRows.length > 0) apRow = fuzzyRows[0];
      }

      // 3e. Try by LOWER(artist_name) (e.g., /profile/bearwolf → BEARWOLF)
      if (!apRow) {
        const { pool } = await import('./db-client.tsx');
        const { rows: nameRows } = await pool.query(
          "SELECT * FROM artist_profiles WHERE LOWER(artist_name) =  ORDER BY total_plays DESC NULLS LAST LIMIT 1",
          [artistId.toLowerCase().replace(/-/g, ' ')]
        );
        if (nameRows.length > 0) apRow = nameRows[0];
      }
      
      if (apRow) {
        const sqlProfile = makeProfile({
          id: apRow.user_id || apRow.id,
          email: apRow.data?.email || '',
          fullName: apRow.artist_name || '',
          bio: apRow.bio || '',
          avatarUrl: apRow.avatar_url || '',
          city: apRow.city || '',
          country: apRow.country || 'Россия',
          genres: apRow.sub_genres || (apRow.genre ? [apRow.genre] : []),
          totalPlays: apRow.total_plays || 0,
          totalFollowers: apRow.total_followers || 0,
          totalTracks: apRow.data?.track_count || 0,
          isVerified: apRow.is_verified || false,
          website: apRow.website || '',
          socials: apRow.social_links || { ...EMPTY_SOCIALS },
        });
        return c.json({ success: true, source: 'sql', data: sqlProfile });
      }
    } catch (sqlErr) {
      console.log('[ArtistProfile] SQL fallback failed:', sqlErr);
    }

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
      const dbClient = getDbClient();
      await dbClient
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
    // Load from artist_profiles SQL table (has real data)
    const { getDbClient } = await import('./db-client.tsx');
    const dbClient = getDbClient();
    const { data: sqlProfiles } = await dbClient
      .from('artist_profiles')
      .select('user_id, slug, artist_name, genre, sub_genres, city, avatar_url, total_plays, total_followers, is_verified, data')
      .limit(2323);

    const allProfiles = (sqlProfiles || [])
      .filter((p: any) => p.artist_name)
      .sort((a: any, b: any) => (b.data?.track_count || 0) - (a.data?.track_count || 0))
      .slice(0, 12)
      .map((p: any) => ({
        id: p.user_id,
        slug: p.slug || '',
        name: p.artist_name,
        genre: p.genre || 'Music',
        genres: p.sub_genres || [],
        city: p.city || '',
        listeners: p.total_followers || 0,
        plays: p.total_plays || 0,
        tracks: p.data?.track_count || 0,
        rating: 0,
        avatarUrl: p.avatar_url || '',
        isVerified: p.is_verified || false,
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
  const artistIdParam = c.req.param('artistId');
  console.log(`[ArtistProfile] GET /profile/${artistIdParam}/tracks`);

  try {
    // Get real tracks from tracks table (linked by artist_id FK)
    try {
      const { getDbClient } = await import('./db-client.tsx');
      const dbClient = getDbClient();

      // Resolve slug/user_id/id to actual artist_profiles.id (UUID)
      let resolvedId = artistIdParam;
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artistIdParam);
      if (!isUUID) {
        // Try slug first, then user_id
        const { data: bySlug } = await dbClient
          .from('artist_profiles').select('id').eq('slug', artistIdParam.toLowerCase()).maybeSingle();
        if (bySlug) {
          resolvedId = bySlug.id;
        } else {
          const { data: byUserId } = await dbClient
            .from('artist_profiles').select('id').eq('user_id', artistIdParam).maybeSingle();
          if (byUserId) resolvedId = byUserId.id;
        }
      }

      const { data: tracks } = await dbClient
        .from('tracks')
        .select('*')
        .eq('artist_id', resolvedId)
        .order('created_at', { ascending: false });
      
      const formatted = (tracks || []).map((t: any) => ({
        id: t.id,
        title: t.title,
        artist: t.artist_name || '',
        artistId: t.artist_id,
        genre: t.genre || '',
        audioUrl: t.audio_url || '',
        coverUrl: t.cover_url || '',
        duration: t.duration || '',
        plays: t.plays_count || 0,
        likes: t.likes_count || 0,
        createdAt: t.created_at,
      }));
      return c.json({ success: true, data: formatted });
    } catch (trackErr) {
      // Fallback to old method
      const tracks = await db.getTracksByUser(artistId);
      return c.json({ success: true, data: tracks || [] });
    }
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


// ═══════ GET /search — Artist search by name (for collaboration) ═══════
app.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  if (!q || q.length < 2) {
    return c.json({ success: true, data: [] });
  }

  try {
    const { getDbClient } = await import('./db-client.tsx');
    const dbClient = getDbClient();
    const { pool } = await import('./db-client.tsx');

    const { rows } = await pool.query(
      `SELECT user_id, slug, artist_name, genre, city, avatar_url, is_verified
       FROM artist_profiles
       WHERE LOWER(artist_name) LIKE $1 
       ORDER BY total_plays DESC NULLS LAST
       LIMIT 10`,
      [`%${q}%`]
    );

    const results = rows.map((r: any) => ({
      id: r.user_id,
      slug: r.slug || '',
      name: r.artist_name,
      genre: r.genre || '',
      city: r.city || '',
      avatarUrl: r.avatar_url || '',
      isVerified: r.is_verified || false,
    }));

    return c.json({ success: true, data: results });
  } catch (error) {
    console.error('[ArtistProfile] Search error:', error);
    return c.json({ success: true, data: [] });
  }
});

export default app;
