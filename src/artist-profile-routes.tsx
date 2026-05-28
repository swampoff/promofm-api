/**
 * ARTIST PROFILE ROUTES
 * Получение и обновление профиля артиста
 * Источники данных: VPS (152-ФЗ) + SQL
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import { vpsGetProfile, vpsSaveProfile, vpsListProfiles } from './vps-userdata.tsx';
import { requireAuth, requireOwner } from './auth-middleware.tsx';

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
  /**
   * Legal/passport name from the users table (signup). For most artists
   * this matches their stage name, but for Russian-speaking artists who
   * signed up with a Latin transliteration (e.g. "Nadezhda Guskova") the
   * stage name lives in `artistName` instead and should be preferred for
   * display in artist-facing surfaces.
   */
  fullName: string;
  /**
   * Stage / artist name from `artist_profiles.artist_name`. Optional —
   * empty when the artist hasn't claimed an artist profile yet. The
   * frontend prefers this over fullName wherever a public-facing
   * identity is shown (sidebar avatar, track "Исполнитель", etc.).
   */
  artistName: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
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
  'fullName', 'artistName', 'bio', 'avatarUrl', 'coverUrl', 'location',
  'city', 'country', 'website', 'phone', 'genres', 'label', 'manager',
  'bookingEmail', 'careerStart', 'languages', 'username', 'email', 'socials',
]);

// ── Helpers ───────────────────────────────────────────────

/**
 * Fetches the canonical artist_profiles row for a user (by either
 * user_id, profile id, or slug). Returns null when no row matches.
 *
 * NOTE on casts: `artist_profiles.id` is UUID, `artist_profiles.user_id`
 * is TEXT, and the URL-param `$1` arrives as TEXT. Comparing TEXT to
 * UUID without `::text` cast fails on production — same pitfall that
 * forced a revert of an earlier version of this helper. Always cast
 * the UUID side to TEXT when matching against a string param.
 */
async function lookupArtistProfileRow(idOrUserId: string): Promise<Record<string, any> | null> {
  if (!idOrUserId) return null;
  try {
    const { pool } = await import('./db-client.tsx');
    const { rows } = await pool.query(
      `SELECT * FROM artist_profiles
       WHERE id::text = $1 OR user_id = $1
       LIMIT 1`,
      [idOrUserId],
    );
    return rows[0] || null;
  } catch (err) {
    console.warn('[ArtistProfile] lookupArtistProfileRow failed:', err);
    return null;
  }
}

/**
 * Fetches just `artist_profiles.artist_name` for an artist by either
 * user_id or profile id. Returns empty string when no row matches.
 * Used to augment auth-derived profile responses where users.name is a
 * Latin transliteration but the artist has registered a Cyrillic stage
 * name in artist_profiles.
 */
async function lookupArtistName(idOrUserId: string): Promise<string> {
  const row = await lookupArtistProfileRow(idOrUserId);
  const name = row?.artist_name as string | null | undefined;
  return name && name.trim() ? name : '';
}

const EMPTY_SOCIALS: ArtistSocials = {
  instagram: '', twitter: '', facebook: '',
  youtube: '', spotify: '', appleMusic: '',
};

function makeProfile(overrides: Partial<ArtistProfile> & { id: string; email: string; fullName: string }): ArtistProfile {
  return {
    username: '',
    artistName: '',
    bio: '',
    avatarUrl: '',
    coverUrl: '',
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
        // Normalize legacy KV rows that predate certain fields.
        const normalized = makeProfile({
          id: artistId,
          email: kvProfile.email || '',
          fullName: kvProfile.fullName || '',
          ...kvProfile,
        });

        // Overlay canonical fields from artist_profiles. KV was caching
        // stats that haven't been recomputed since the row was written —
        // real artists with 30+ tracks saw "0 прослушиваний / 0 треков"
        // on their public profile because cached totalPlays was 0.
        // Pull live values + live published-track count.
        const apRow = await lookupArtistProfileRow(artistId);
        if (apRow) {
          if (apRow.artist_name) normalized.artistName = apRow.artist_name as string;
          if (apRow.total_plays != null) normalized.totalPlays = Number(apRow.total_plays);
          if (apRow.total_followers != null) normalized.totalFollowers = Number(apRow.total_followers);
          if (apRow.is_verified) normalized.isVerified = !!apRow.is_verified;
          if (apRow.rating != null) normalized.rating = Number(apRow.rating);
          // Migration 057 columns — surface them in the cached-profile
          // response so refresh shows what the user just saved.
          if (apRow.label         != null) normalized.label        = apRow.label         as string;
          if (apRow.manager       != null) normalized.manager      = apRow.manager       as string;
          if (apRow.booking_email != null) normalized.bookingEmail = apRow.booking_email as string;
          if (apRow.career_start  != null) normalized.careerStart  = apRow.career_start  as string;
          if (apRow.location      != null) normalized.location     = apRow.location      as string;
          if (Array.isArray(apRow.languages) && apRow.languages.length > 0) {
            normalized.languages = apRow.languages as string[];
          }

          try {
            const { pool } = await import('./db-client.tsx');
            // tracks.artist_id is UUID FK on artist_profiles.id — apRow.id
            // comes back from PG as a UUID-typed value so no cast needed
            // (matches existing path 3 query just below).
            const { rows } = await pool.query(
              `SELECT COUNT(*)::int AS cnt FROM tracks
               WHERE artist_id = $1 AND moderation_status = 'published'`,
              [apRow.id],
            );
            normalized.totalTracks = Number(rows[0]?.cnt ?? 0);
          } catch { /* keep whatever KV had */ }
        }

        return c.json({ success: true, source: 'kv', data: normalized });
      }
    }

    // 2. Try auth-created profile (stored at profile:${artistId} by signup route)
    try {
      if (!isUuidParam) throw new Error('skip');
      const authProfile = await vpsGetProfile(artistId);
      if (authProfile && typeof authProfile === 'object') {
        const ap = authProfile as Record<string, unknown>;
        const fullName = (ap.name as string) || (ap.email as string)?.split('@')[0] || 'Артист';
        const artistName = await lookupArtistName(artistId);
        const newProfile = makeProfile({
          id: artistId,
          email: (ap.email as string) || '',
          fullName,
          artistName,
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
        // Count real tracks from DB
        let realTrackCount = 0;
        try {
          const { pool } = await import('./db-client.tsx');
          const { rows: countRows } = await pool.query(
            'SELECT COUNT(*)::int as cnt FROM tracks WHERE artist_id = $1',
            [apRow.id]
          );
          realTrackCount = countRows[0]?.cnt || 0;
        } catch { /* keep 0 */ }

        const sqlProfile = makeProfile({
          id: apRow.user_id || apRow.id,
          email: apRow.data?.email || '',
          fullName: apRow.artist_name || '',
          artistName: apRow.artist_name || '',
          bio: apRow.bio || '',
          avatarUrl: apRow.avatar_url || '',
          coverUrl: apRow.data?.coverUrl || '',
          city: apRow.city || '',
          country: apRow.country || 'Россия',
          genres: apRow.sub_genres || (apRow.genre ? [apRow.genre] : []),
          totalPlays: apRow.total_plays || 0,
          totalFollowers: apRow.total_followers || 0,
          totalTracks: realTrackCount,
          isVerified: apRow.is_verified || false,
          website: apRow.website || '',
          socials: apRow.social_links || { ...EMPTY_SOCIALS },
          label:        apRow.label         || '',
          manager:      apRow.manager       || '',
          bookingEmail: apRow.booking_email || '',
          careerStart:  apRow.career_start  || '',
          location:     apRow.location      || '',
          languages: (Array.isArray(apRow.languages) && apRow.languages.length > 0)
            ? (apRow.languages as string[])
            : ['Русский'],
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
app.put('/profile/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  const artistId = c.req.param('artistId');
  console.log(`[ArtistProfile] PUT ${artistId}`);

  try {
    const rawUpdates = await c.req.json();
    const updates = sanitizeUpdates(rawUpdates);

    if (Object.keys(updates).length === 0) {
      return c.json({ success: false, error: 'No valid fields to update' }, 400);
    }

    // Если клиент явно прислал fullName — он не должен быть пустой строкой.
    // Это блокирует "пустое сохранение", из-за которого имя оставалось null.
    if ('fullName' in updates) {
      const name = typeof updates.fullName === 'string' ? updates.fullName.trim() : '';
      if (!name) {
        return c.json({ success: false, error: 'fullName cannot be empty' }, 400);
      }
      updates.fullName = name;
    }

    // Получаем текущий профиль или создаём новый
    let currentProfile = await loadFromKv(artistId);
    if (!currentProfile) {
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

    // Сохраняем в PostgreSQL (users + profiles + artist_profiles).
    // vpsSaveProfile теперь пробрасывает ошибки наверх, чтобы PUT возвращал 500
    // вместо "тихого успеха", если запись не прошла.
    await saveToKv(artistId, updatedProfile);

    console.log(`[ArtistProfile] Updated: ${artistId}`);
    return c.json({ success: true, data: updatedProfile });

  } catch (error) {
    console.error(`[ArtistProfile] PUT error: ${error}`);
    return c.json({ success: false, error: 'Failed to save profile' }, 500);
  }
});

/**
 * GET /profile/:artistId/stats
 * Лёгкий endpoint только для статистики
 */
app.get('/profile/:artistId/stats', async (c) => {
  const artistIdParam = c.req.param('artistId');

  try {
    const { pool } = await import('./db-client.tsx');

    // Resolve any incoming form (id / user_id / slug) to artist_profiles.id.
    // Same cast-aware resolver pattern as the /tracks endpoint.
    //   artist_profiles.id      = UUID  → cast UUID side to TEXT
    //   artist_profiles.user_id = TEXT  → direct compare works
    //   slug                    = TEXT  → direct compare works
    const { rows: idRows } = await pool.query(
      `SELECT id, total_plays, total_followers, rating
       FROM artist_profiles
       WHERE id::text = $1 OR user_id = $1 OR LOWER(slug) = LOWER($1)
       LIMIT 1`,
      [artistIdParam],
    );
    if (idRows.length === 0) {
      return c.json({ success: false, error: 'Stats not found' }, 404);
    }
    const ap = idRows[0];

    // Live counts from canonical tables — single source of truth.
    // tracks.artist_id is UUID FK on artist_profiles.id; ap.id is UUID
    // from pg so no cast needed for that join.
    const { rows: trackAgg } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE moderation_status = 'published')::int AS published_tracks,
         COALESCE(SUM(plays_count) FILTER (WHERE moderation_status = 'published'), 0)::bigint AS total_plays,
         COALESCE(SUM(likes_count) FILTER (WHERE moderation_status = 'published'), 0)::bigint AS total_likes
       FROM tracks WHERE artist_id = $1`,
      [ap.id],
    );

    // concerts.artist_id is TEXT in this schema; cast UUID → text to match.
    // Table may not exist on dev envs — swallow the error and return 0.
    const concertAgg = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM concerts WHERE artist_id = $1`,
      [ap.id],
    ).catch(() => ({ rows: [{ cnt: 0 }] }));

    const liveTotalPlays = Number(trackAgg[0]?.total_plays ?? 0);
    return c.json({
      success: true,
      data: {
        // Whichever is larger between the cached column and the live SUM
        // wins, so per-track increments don't shrink the displayed total
        // due to async aggregation drift in either direction.
        totalPlays: Math.max(Number(ap.total_plays ?? 0), liveTotalPlays),
        totalFollowers: Number(ap.total_followers ?? 0),
        totalConcerts: Number(concertAgg.rows[0]?.cnt ?? 0),
        coinsBalance: 0,  // not stored on artist_profiles; legacy field
        rating: Number(ap.rating ?? 0),
        publishedTracks: Number(trackAgg[0]?.published_tracks ?? 0),
        totalLikes: Number(trackAgg[0]?.total_likes ?? 0),
      },
    });
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
  try {
    // Источник 503-х (28 hits/period): раньше тянули limit(2323) всех
    // артистов в JS-память, потом sort по data->>'track_count' и slice(12).
    // На больших ростерах + slow disk это:
    //   - дёргает 2323 строк (~10MB jsonb если у каждого богатый data)
    //   - блочит pg-pool слот пока пишет JSON
    //   - сериализует/десериализует jsonb 2323 раза в pg-node
    //   - и иногда timeout'ит / OOM.
    // Делаем сортировку и лимит на стороне SQL — ORDER BY
    // (data->>'track_count')::int DESC NULLS LAST + LIMIT 12.
    // pg-node binding на jsonb path не требует доп. cast'а.
    const { pool } = await import('./db-client.tsx');
    const { rows } = await pool.query(
      `SELECT user_id, slug, artist_name, genre, sub_genres, city,
              avatar_url, total_plays, total_followers, is_verified, data
         FROM artist_profiles
        WHERE artist_name IS NOT NULL AND artist_name <> ''
        ORDER BY COALESCE(NULLIF(data->>'track_count', '')::int, 0) DESC NULLS LAST,
                 total_followers DESC NULLS LAST
        LIMIT 12`
    );

    const profiles = rows.map((p: any) => ({
      id: p.user_id,
      slug: p.slug || '',
      name: p.artist_name,
      genre: p.genre || 'Music',
      genres: p.sub_genres || [],
      city: p.city || '',
      listeners: p.total_followers || 0,
      plays: p.total_plays || 0,
      tracks: Number(p.data?.track_count) || 0,
      rating: 0,
      avatarUrl: p.avatar_url || '',
      isVerified: p.is_verified || false,
    }));

    return c.json({ success: true, data: profiles });

  } catch (error: any) {
    // 503 чтобы лендинг отличал «нет артистов» (success:true, data:[])
    // от настоящего сбоя БД. Логи нужны чтобы понять корневую причину.
    console.error(`[ArtistProfile] Popular error: ${error?.message || error}`);
    return c.json({ success: false, error: 'Failed to load popular artists' }, 503);
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

      // Resolve any incoming form (id / user_id / slug) to the canonical
      // artist_profiles.id. The previous code only resolved for non-UUID
      // params, so /profile/{user_id}/tracks queried
      // `tracks.artist_id = user_id` (with no match) and returned [] —
      // why real artists with 30+ tracks saw "0 треков" publicly.
      //
      // CAST RULES on artist_profiles:
      //   id      = UUID  → cast UUID side to TEXT for string compare
      //   user_id = TEXT  → direct compare
      //   slug    = TEXT  → direct compare
      // (Without the `id::text` cast Postgres throws on real prod
      // because PG won't implicit-cast TEXT param to UUID; reverted
      // commit 3e280ad got bitten by exactly this.)
      let resolvedId = artistIdParam;
      try {
        const { pool } = await import('./db-client.tsx');
        const { rows } = await pool.query(
          `SELECT id FROM artist_profiles
           WHERE id::text = $1 OR user_id = $1 OR LOWER(slug) = LOWER($1)
           LIMIT 1`,
          [artistIdParam],
        );
        if (rows[0]?.id) resolvedId = rows[0].id;
      } catch (resolveErr) {
        console.warn('[ArtistProfile/tracks] resolve failed, using raw param:', resolveErr);
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
