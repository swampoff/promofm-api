/**
 * VPS UserData — прямые запросы к локальному PostgreSQL
 * Заменяет HTTP-вызовы к внешнему FastAPI сервису (152-ФЗ)
 * Все данные хранятся в таблицах users + profiles на этом же сервере
 */

import { pool } from './db-client.tsx';
import { verificationTokensStore } from './db.tsx';

// ── Profiles ──

export async function vpsGetProfile(userId: string): Promise<Record<string, unknown> | null> {
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
    return {
      userId: row.userId,
      email: row.email,
      name: row.name || row.displayName || '',
      role: row.role || 'artist',
      avatar: row.avatar || null,
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

    for (const [key, col] of Object.entries(mapping)) {
      if (data[key] !== undefined) {
        setClauses.push(`${col} = $${idx}`);
        values.push(data[key]);
        idx++;
      }
    }

    if (setClauses.length > 0) {
      values.push(userId);
      await pool.query(
        `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    // Upsert profiles table (for genre, city, social_links, extra data)
    await pool.query(
      `INSERT INTO profiles (user_id, artist_name, genre, city, bio, avatar_url, social_links, data, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         artist_name = COALESCE(EXCLUDED.artist_name, profiles.artist_name),
         genre = COALESCE(EXCLUDED.genre, profiles.genre),
         city = COALESCE(EXCLUDED.city, profiles.city),
         bio = COALESCE(EXCLUDED.bio, profiles.bio),
         avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
         social_links = COALESCE(EXCLUDED.social_links, profiles.social_links),
         data = COALESCE(EXCLUDED.data, profiles.data),
         updated_at = NOW()`,
      [
        userId,
        data.name || null,
        data.genre || null,
        data.city || null,
        data.bio || null,
        data.avatar || null,
        data.socialLinks ? JSON.stringify(data.socialLinks) : '{}',
        data.extraData ? JSON.stringify(data.extraData) : '{}',
      ]
    );
  } catch (err) {
    console.error(`[profile] saveProfile error for ${userId}:`, err);
  }
}

export async function vpsUpdateProfile(userId: string, updates: Record<string, unknown>): Promise<void> {
  // Delegate to save — it does upsert
  await vpsSaveProfile(userId, updates);
}

export async function vpsDeleteProfile(userId: string): Promise<void> {
  try {
    await pool.query('DELETE FROM profiles WHERE user_id = $1', [userId]);
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
                        (SELECT COUNT(*)::int FROM tracks t WHERE t.artist_id = u.id::text) as "tracksCount"
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
    await verificationTokensStore.set(token, {
      id: token,
      user_id: userId,
      type,
      expires_at: expires,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[token] storeToken error:`, err);
  }
}

export async function vpsGetToken(token: string): Promise<{ userId: string; type: string; expiresAt: string; createdAt: string; [k: string]: unknown } | null> {
  try {
    const kvData = await verificationTokensStore.get(token) as any;
    if (kvData && kvData.user_id) {
      if (new Date() > new Date(kvData.expires_at)) {
        return null;
      }
      return {
        userId: kvData.user_id,
        type: kvData.type,
        expiresAt: kvData.expires_at,
        createdAt: kvData.created_at,
      };
    }
  } catch (err) {
    console.error(`[token] getToken error:`, err);
  }
  return null;
}

export async function vpsUseToken(token: string): Promise<boolean> {
  try {
    const kvData = await verificationTokensStore.get(token) as any;
    if (kvData && kvData.user_id) {
      await verificationTokensStore.set(token, { ...kvData, used_at: new Date().toISOString() });
      return true;
    }
  } catch (err) {
    console.error(`[token] useToken error:`, err);
  }
  return false;
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
