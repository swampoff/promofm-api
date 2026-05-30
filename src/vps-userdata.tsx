/**
 * VPS UserData — прямые запросы к локальному PostgreSQL
 * Заменяет HTTP-вызовы к внешнему FastAPI сервису (152-ФЗ)
 * Все данные хранятся в таблицах users + profiles на этом же сервере
 */

import { pool, rlsQuery } from './db-client.tsx';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { insertVerificationToken, getVerificationToken, markVerificationTokenUsed } from './db.tsx';

// ── Profiles ──

export async function vpsGetProfile(userId: string): Promise<Record<string, unknown> | null> {
  if (!UUID_RE.test(userId)) return null;  // slug or non-UUID — skip PG query
  try {
    const res = await pool.query(
      `SELECT u.id as "userId", u.email, u.full_name as name, u.role, u.avatar_url as avatar,
              u.is_email_verified as "isEmailVerified", u.status as "accountStatus",
              u.bio, u.phone, u.website_url as website,
              u.instagram_url, u.youtube_url, u.twitter_url, u.facebook_url,
              u.display_name as "displayName", u.created_at as "createdAt",
              p.genre, p.city, p.social_links as "socialLinks", p.data as "extraData"
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id::text
       WHERE u.id = $1`,
      [userId]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    const extra = (row.extraData && typeof row.extraData === 'object') ? row.extraData as Record<string, unknown> : {};
    return {
      userId: row.userId,
      email: row.email,
      name: row.name || row.displayName || '',
      role: row.role || 'artist',
      avatar: row.avatar || null,
      avatarUrl: row.avatar || null,
      coverUrl: (extra.coverUrl as string) || '',
      isEmailVerified: row.isEmailVerified || false,
      accountStatus: row.accountStatus || 'active',
      bio: row.bio || '',
      phone: row.phone || '',
      website: row.website || '',
      genre: row.genre || '',
      city: row.city || '',
      socialLinks: row.socialLinks || {},
      createdAt: row.createdAt,
    };
  } catch (err) {
    console.error(`[profile] getProfile error for ${userId}:`, err);
    return null;
  }
}

export async function vpsSaveProfile(userId: string, data: Record<string, unknown>): Promise<void> {
  try {
    // Update users table
    const setClauses: string[] = [];
    const values: any[] = [];
    let idx = 1;

    const mapping: Record<string, string> = {
      name: 'full_name',
      fullName: 'full_name',
      avatarUrl: 'avatar_url',
      email: 'email',
      role: 'role',
      avatar: 'avatar_url',
      bio: 'bio',
      phone: 'phone',
      website: 'website_url',
      accountStatus: 'status',
      isEmailVerified: 'is_email_verified',
      displayName: 'display_name',
    };

    // Dedup by target column — last incoming key wins to avoid "multiple assignments to same column"
    const colToValue = new Map<string, unknown>();
    for (const [key, col] of Object.entries(mapping)) {
      if (data[key] !== undefined) colToValue.set(col, data[key]);
    }
    for (const [col, value] of colToValue) {
      setClauses.push(`${col} = $${idx}`);
      values.push(value);
      idx++;
    }

    if (setClauses.length > 0) {
      values.push(userId);
      await pool.query(
        `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    // Build jsonb blob: coverUrl + any extraData (merged non-destructively into profiles.data)
    const dataBlob: Record<string, unknown> = {
      ...((data.extraData && typeof data.extraData === 'object') ? data.extraData as Record<string, unknown> : {}),
    };
    if (typeof data.coverUrl === 'string') dataBlob.coverUrl = data.coverUrl;

    // Upsert profiles table (for genre, city, social_links, extra data)
    await rlsQuery(
      `INSERT INTO profiles (user_id, artist_name, genre, city, bio, avatar_url, social_links, data, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         artist_name = COALESCE(EXCLUDED.artist_name, profiles.artist_name),
         genre = COALESCE(EXCLUDED.genre, profiles.genre),
         city = COALESCE(EXCLUDED.city, profiles.city),
         bio = COALESCE(EXCLUDED.bio, profiles.bio),
         avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
         social_links = COALESCE(EXCLUDED.social_links, profiles.social_links),
         data = COALESCE(profiles.data, '{}'::jsonb) || EXCLUDED.data,
         updated_at = NOW()`,
      [
        userId,
        (data.fullName as string) || (data.name as string) || null,
        (data.genre as string) || (Array.isArray(data.genres) && data.genres.length > 0 ? (data.genres as string[])[0] : null),
        (data.city as string) || null,
        (data.bio as string) || null,
        (data.avatarUrl as string) || (data.avatar as string) || null,
        data.socialLinks || data.socials ? JSON.stringify(data.socialLinks || data.socials) : '{}',
        JSON.stringify(dataBlob),
      ],
      userId
    );

    // Upsert artist_profiles (required for track upload and public pages).
    // Prefer the explicit stage name from the form; fall back to legal name
    // only when artistName is absent (e.g., very early signups). Previously
    // fullName always won, which silently overwrote the stage name with
    // the Latin passport transliteration for artists like "Надежда Гуськова".
    const artistName = (data.artistName as string) || (data.fullName as string) || (data.name as string) || null;
    if (artistName) {
      const genre = (data.genre as string) || (Array.isArray(data.genres) && data.genres.length > 0 ? (data.genres as string[])[0] : null);
      const subGenres = Array.isArray(data.genres) ? (data.genres as string[]) : (data.genre ? [data.genre as string] : []);
      const slug = artistName.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '');
      const socials = data.socials || data.socialLinks || {};
      const streamingLinks: Record<string, string> = {};
      if (typeof socials === 'object' && socials !== null) {
        const s = socials as Record<string, string>;
        if (s.spotify) streamingLinks.spotify = s.spotify;
        if (s.appleMusic) streamingLinks.appleMusic = s.appleMusic;
      }

      // Migration 057 added six native columns (label, manager, booking_email,
      // career_start, languages, location) that were previously silently
      // dropped by this mapping. Pass them through explicitly; the
      // COALESCE/CASE clauses below preserve any existing value on partial
      // updates (e.g., form submits with only one field changed).
      const labelVal      = typeof data.label         === 'string' ? data.label         : null;
      const managerVal    = typeof data.manager       === 'string' ? data.manager       : null;
      const bookingEmail  = typeof data.bookingEmail  === 'string' ? data.bookingEmail  : null;
      const careerStart   = typeof data.careerStart   === 'string' ? data.careerStart   : null;
      const locationVal   = typeof data.location      === 'string' ? data.location      : null;
      const languagesVal  = Array.isArray(data.languages) ? (data.languages as string[]) : null;

      await rlsQuery(
        `INSERT INTO artist_profiles (
           user_id, slug, artist_name, genre, sub_genres, city, country, bio,
           avatar_url, website, social_links, streaming_links, data,
           label, manager, booking_email, career_start, languages, location
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, COALESCE($18, ARRAY[]::text[]), $19)
         ON CONFLICT (user_id) DO UPDATE SET
           artist_name = COALESCE(EXCLUDED.artist_name, artist_profiles.artist_name),
           genre = COALESCE(EXCLUDED.genre, artist_profiles.genre),
           sub_genres = CASE WHEN array_length(EXCLUDED.sub_genres, 1) > 0 THEN EXCLUDED.sub_genres ELSE artist_profiles.sub_genres END,
           city = COALESCE(EXCLUDED.city, artist_profiles.city),
           bio = COALESCE(EXCLUDED.bio, artist_profiles.bio),
           avatar_url = COALESCE(EXCLUDED.avatar_url, artist_profiles.avatar_url),
           website = COALESCE(EXCLUDED.website, artist_profiles.website),
           social_links = COALESCE(EXCLUDED.social_links, artist_profiles.social_links),
           streaming_links = COALESCE(EXCLUDED.streaming_links, artist_profiles.streaming_links),
           data = COALESCE(artist_profiles.data, '{}'::jsonb) || EXCLUDED.data,
           label         = COALESCE(EXCLUDED.label,         artist_profiles.label),
           manager       = COALESCE(EXCLUDED.manager,       artist_profiles.manager),
           booking_email = COALESCE(EXCLUDED.booking_email, artist_profiles.booking_email),
           career_start  = COALESCE(EXCLUDED.career_start,  artist_profiles.career_start),
           languages     = CASE WHEN array_length(EXCLUDED.languages, 1) > 0
                                THEN EXCLUDED.languages
                                ELSE artist_profiles.languages END,
           location      = COALESCE(EXCLUDED.location,      artist_profiles.location),
           updated_at = NOW()`,
        [
          userId,
          slug,
          artistName,
          genre || null,
          subGenres,
          (data.city as string) || null,
          'Russia',
          (data.bio as string) || null,
          (data.avatarUrl as string) || (data.avatar as string) || null,
          (data.website as string) || null,
          JSON.stringify(socials),
          JSON.stringify(streamingLinks),
          JSON.stringify(dataBlob),
          labelVal,
          managerVal,
          bookingEmail,
          careerStart,
          languagesVal,
          locationVal,
        ],
        userId
      );
    }
  } catch (err) {
    console.error(`[profile] saveProfile error for ${userId}:`, err);
    throw err;
  }
}

export async function vpsUpdateProfile(userId: string, updates: Record<string, unknown>): Promise<void> {
  // Delegate to save — it does upsert
  await vpsSaveProfile(userId, updates);
}

export async function vpsDeleteProfile(userId: string): Promise<void> {
  try {
    await rlsQuery('DELETE FROM profiles WHERE user_id = $1', [userId], userId);
    // Don't delete from users — that's handled by auth
  } catch (err) {
    console.error(`[profile] deleteProfile error:`, err);
  }
}

export async function vpsListProfiles(role?: string): Promise<Record<string, unknown>[]> {
  try {
    let query = `SELECT u.id as "userId", u.email, u.full_name as name, u.role,
                        u.avatar_url as avatar, u.status as "accountStatus",
                        u.is_email_verified as "isEmailVerified",
                        u.created_at as "createdAt",
                        p.genre, p.city,
                        (SELECT COUNT(*)::int FROM tracks t WHERE t.artist_id = u.id) as "tracksCount"
                 FROM users u
                 LEFT JOIN profiles p ON p.user_id = u.id::text`;
    const values: any[] = [];
    if (role) {
      query += ` WHERE u.role = $1`;
      values.push(role);
    }
    query += ` ORDER BY u.created_at DESC LIMIT 500`;
    const res = await pool.query(query, values);
    return res.rows.map(row => ({
      userId: row.userId,
      email: row.email,
      name: row.name || '',
      role: row.role,
      avatar: row.avatar,
      accountStatus: row.accountStatus,
      isEmailVerified: row.isEmailVerified,
      createdAt: row.createdAt,
      tracksCount: row.tracksCount || 0,
      genre: row.genre,
      city: row.city,
    }));
  } catch (err) {
    console.error(`[profile] listProfiles error:`, err);
    return [];
  }
}

// ── Verification / Reset Tokens ──

export async function vpsStoreToken(
  userId: string,
  token: string,
  type: string = "email_verify",
  expiresInHours: number = 24,
): Promise<void> {
  const expires = new Date(Date.now() + expiresInHours * 3600_000).toISOString();
  try {
    await insertVerificationToken({
      token,
      userId,
      tokenType: type,
      expiresAt: expires,
    });
  } catch (err) {
    console.error(`[token] storeToken error:`, err);
  }
}

export async function vpsGetToken(token: string): Promise<{ userId: string; type: string; expiresAt: string; createdAt: string; [k: string]: unknown } | null> {
  try {
    const row = await getVerificationToken(token);
    // getVerificationToken уже фильтрует expired + used_at, так что
    // если row !== null — token валиден и готов к использованию.
    if (row) {
      return {
        userId: row.userId,
        type: row.tokenType,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        usedAt: row.usedAt,
      };
    }
  } catch (err) {
    console.error(`[token] getToken error:`, err);
  }
  return null;
}

export async function vpsUseToken(token: string): Promise<boolean> {
  // Atomic UPDATE ... WHERE used_at IS NULL AND expires_at > NOW()
  // — закрывает race window между .get и .set в legacy реализации:
  // 2 concurrent клика на одну ссылку email верификации больше не
  // могут оба «успешно» отметить token использованным.
  try {
    return await markVerificationTokenUsed(token);
  } catch (err) {
    console.error(`[token] useToken error:`, err);
    return false;
  }
}

// ── Auth Logs (write to local PG) ──

export async function vpsLogAuth(action: string, userId?: string, ip?: string, ua?: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO kv_store (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = kv_store.value || $2::jsonb, updated_at = NOW()`,
      [
        `auth_log:${userId || 'anon'}`,
        JSON.stringify({
          logs: [{ action, ip, ua, ts: new Date().toISOString() }]
        })
      ]
    );
  } catch { /* fire and forget */ }
}
