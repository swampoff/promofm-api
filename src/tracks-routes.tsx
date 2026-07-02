/**
 * TRACKS ROUTES v2 — Uses typed `tracks` table
 * Artist CRUD for their own tracks
 */

import { Hono } from 'hono';
import * as typed from './db-typed.tsx';
import { getDbClient, pool } from './db-client.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { profileLimiter } from './rate-limiter.tsx';
import { logUserAction } from './audit-helper.tsx';
import { scheduleAiCheck } from './ai-check.tsx';
import { notifyTrackUpload } from './email-helper.tsx';

/**
 * Streaming-link validator. Возвращает '' для пустой / битой ссылки,
 * нормализованный URL для валидной. Закрывает 3 атаки:
 *   1. javascript:/data: — XSS через <a href> на лендинге
 *   2. внутренние URL — open-redirect (https://promofm.org/some/...)
 *   3. > 2048 chars — DB CHECK constraint violation 500
 */
function sanitizeStreamingUrl(input: unknown): string {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed.length > 2048) return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

const tracksRoutes = new Hono();
// No demo fallback — all endpoints require auth

// GET / — Get all tracks for current user
tracksRoutes.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const tracks = await typed.getTracksByUser(userId);
    return c.json({ success: true, data: tracks });
  } catch (error) {
    console.error('Error in GET /tracks:', error);
    return c.json({ success: true, data: [] });
  }
});

// GET /:id — Get single track
tracksRoutes.get('/:id', async (c) => {
  try {
    const trackId = c.req.param('id');
    const track = await typed.getTrackById(trackId);
    if (!track) {
      return c.json({ success: false, error: 'Track not found' }, 404);
    }
    return c.json({ success: true, data: track });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST / — Create new track
tracksRoutes.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const userRole = c.get('userRole') as string | undefined;
    const body = await c.req.json();

    // Label-on-behalf branch: when a label uploads a track for a roster
    // artist, we set tracks.user_id = label (owner/payer) and
    // tracks.artist_id = roster artist's profile.id. The artist's display
    // name is snapshotted from artist_profiles so the catalog row stays
    // stable even if the artist is later renamed or removed from the roster.
    let artistId: string | null = null;
    let artistName: string | null = null;
    let actingForArtistId: string | undefined;
    let actingForArtistUserId: string | undefined;
    let labelId: string | undefined;

    if (body.actingForArtistId) {
      if (userRole !== 'label') {
        return c.json({ success: false, error: 'actingForArtistId доступно только роли label', code: 'ROLE_FORBIDDEN' }, 403);
      }
      const lp = await pool.query(`SELECT id FROM label_profiles WHERE user_id = $1`, [userId]);
      if (lp.rows.length === 0) {
        return c.json({ success: false, error: 'Сначала заполните профиль лейбла', code: 'LABEL_PROFILE_REQUIRED' }, 400);
      }
      labelId = lp.rows[0].id;
      const ap = await pool.query(
        `SELECT id, user_id, artist_name FROM artist_profiles
         WHERE id = $1 AND (managed_by_label_id = $2 OR label_id = $2)`,
        [body.actingForArtistId, labelId]
      );
      if (ap.rows.length === 0) {
        return c.json({ success: false, error: 'Артист не в вашем ростере', code: 'ARTIST_NOT_IN_ROSTER' }, 403);
      }
      artistId = ap.rows[0].id;
      artistName = ap.rows[0].artist_name || '';
      actingForArtistId = artistId || undefined;
      actingForArtistUserId = ap.rows[0].user_id || undefined;
    } else {
      // Artist branch: REQUIRE own artist profile before track submission
      const profile = await getDbClient().from('artist_profiles').select('id, artist_name').eq('user_id', userId).maybeSingle();
      if (!profile?.data) {
        return c.json({ success: false, error: 'Сначала заполните профиль артиста в личном кабинете', code: 'PROFILE_REQUIRED' }, 403);
      }
      artistId = (profile.data as any).id;
      // Fall back to client-supplied artist_name (legacy fronts), but prefer
      // the canonical name from artist_profiles so audit trails match.
      artistName = (profile.data as any).artist_name || body.artist || body.artist_name || '';
    }

    const track = await typed.insertTrack({
      ...body,
      user_id: userId,
      artist_id: artistId,
      artist_name: artistName,
      audio_url: body.audioUrl || body.audio_url || body.audio_file_url || body.audioFile || body.audio || '',
      cover_url: body.coverUrl || body.cover_url || body.cover_image_url || body.cover || '',
      // BLOCKER A (audit 2026-06-03): non-admin client мог отправить
      // body.status='published' в POST /tracks и опубликовать трек
      // мимо модерации. Forced 'draft' для всех ролей кроме admin.
      // Admin retain'ит body.status для bulk-импорта / редакционных
      // правок (см. friday.js: впрыскивает 'published' через прямой
      // pool.query, не через эту ручку).
      moderation_status: userRole === 'admin' ? (body.status || 'draft') : 'draft',
      // Streaming-links (migration 095) — camelCase из формы, валидируем.
      yandex_music_url: sanitizeStreamingUrl(body.yandexMusicUrl ?? body.yandex_music_url),
      spotify_url:      sanitizeStreamingUrl(body.spotifyUrl     ?? body.spotify_url),
      apple_music_url:  sanitizeStreamingUrl(body.appleMusicUrl  ?? body.apple_music_url),
      youtube_url:      sanitizeStreamingUrl(body.youtubeUrl     ?? body.youtube_url),
      vk_music_url:     sanitizeStreamingUrl(body.vkMusicUrl     ?? body.vk_music_url),
      // Label-on-behalf context — native cols (migration 089). actingForArtistId
      // = artist_id (выше) — redundant, не сохраняем. Если actingForArtistId
      // не пришёл (обычный artist upload) — поля остаются NULL.
      label_id:           actingForArtistId ? labelId                : null,
      acting_for_user_id: actingForArtistId ? actingForArtistUserId  : null,
    });

    if (!track) {
      return c.json({ success: false, error: 'Failed to create track' }, 500);
    }

    // Fire-and-forget: trigger Promo.check fingerprinting in background
    if (track.audio_url) {
      fetch(`http://127.0.0.1:3000/server/api/promo-check/process/${track.id}`, { method: 'POST' })
        .catch(() => {}); // non-blocking
    }

    // Fire-and-forget: AI-detector verdict (audio file → /analyze on :8085).
    // Result lands in track_moderation.ai_check_status + data->aiCheckResult.
    // ~15s analyzer runtime, must NOT block the artist's upload response.
    scheduleAiCheck(track.id, track.audio_url || null);

    // Notify admin (email + Telegram). Resolve email/name from users so
    // admins see a real identity instead of "anonymous". Fire-and-forget —
    // the upload itself must not fail because the SMTP / Telegram side is
    // down.
    (async () => {
      try {
        const { rows } = await pool.query(
          'SELECT email, full_name, display_name FROM users WHERE id = $1 LIMIT 1',
          [userId],
        );
        const u = rows[0] || {};
        await notifyTrackUpload({
          title: track.title || body.title || 'Без названия',
          artist: u.full_name || u.display_name || track.artist_name || body.artist || body.artist_name || 'Артист',
          genre: track.genre || body.genre,
          email: u.email || c.get('userEmail') || undefined,
          userId,
        });
      } catch (notifyErr) {
        console.error('[tracks] admin notify failed:', notifyErr);
      }
    })();

    return c.json({ success: true, data: track }, 201);
  } catch (error) {
    console.error('Error in POST /tracks:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /:id — Update track (ownership check: only track owner can edit)
tracksRoutes.put('/:id', requireAuth, async (c) => {
  try {
    const trackId = c.req.param('id');
    const userId = c.get('userId');
    const body = await c.req.json();

    // Ownership check
    const existing = await typed.getTrackById(trackId);
    if (!existing) {
      return c.json({ success: false, error: 'Track not found' }, 404);
    }
    if (existing.user_id && existing.user_id !== userId) {
      return c.json({ success: false, error: 'Not authorized to edit this track' }, 403);
    }

    // Mass-assignment guard (2026-07-02): PUT раньше спредил body целиком в
    // UPDATE — владелец мог прислать moderation_status='published' (обход
    // модерации И платной публикации; BLOCKER A закрыл это в POST 2026-06-03,
    // а PUT остался дырой), payment_completed=true / requires_payment=false /
    // paid_at (обход оплаты), plays/likes (накрутка), user_id/artist_id
    // (переприсвоение). Системные поля вырезаем МОЛЧА — фронт при
    // редактировании шлёт объект трека целиком (JSON.stringify(track)),
    // reject сломал бы легитимный флоу. Канонизация ключа (lower, без '_')
    // отсекает и snake_case, и camelCase варианты.
    const PROTECTED_TRACK_FIELDS = new Set([
      'id', 'userid', 'artistid', 'artistname', 'labelid', 'actingforuserid',
      'moderationstatus', 'status',
      'paymentcompleted', 'paymentamount', 'paymentorderid', 'paymentgateway',
      'paidat', 'requirespayment', 'firsttrackfreeapplied', 'lastpaymentreminderat',
      'upcominguntil', 'approvedforreleaseat', 'publishedat',
      'plays', 'playscount', 'likes', 'likescount', 'downloads', 'shares',
      'aiscore', 'aiverdict', 'aianalysis', 'aiflagged', 'aicategory',
      'radiodigestsentat', 'radioweeklydigestsentat',
      'experttesteduntil', 'experttestavgrating', 'experttestrequestid',
      'shoutouturl', 'data', 'createdat', 'updatedat',
    ]);
    const safeBody: Record<string, any> = {};
    for (const [k, v] of Object.entries(body as Record<string, any>)) {
      if (!PROTECTED_TRACK_FIELDS.has(k.toLowerCase().replace(/_/g, ''))) safeBody[k] = v;
    }

    // Streaming-links (migration 095) — нормализуем camelCase + валидируем
    // URL. Sanitize'нутый ('') не перезаписывает уже сохранённое значение
    // (не путать «не прислал» с «удалил»). Чтобы удалить — фронт шлёт null.
    const normalized: Record<string, any> = { ...safeBody };
    for (const [camel, snake] of [
      ['yandexMusicUrl', 'yandex_music_url'],
      ['spotifyUrl',     'spotify_url'],
      ['appleMusicUrl',  'apple_music_url'],
      ['youtubeUrl',     'youtube_url'],
      ['vkMusicUrl',     'vk_music_url'],
    ] as const) {
      const raw = body[camel] ?? body[snake];
      if (raw === null) { normalized[snake] = null; delete normalized[camel]; continue; }
      if (raw === undefined) { delete normalized[snake]; delete normalized[camel]; continue; }
      normalized[snake] = sanitizeStreamingUrl(raw);
      delete normalized[camel];
    }

    const track = await typed.updateTrack(trackId, normalized);
    return c.json({ success: true, data: track });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /:id — Delete track (ownership check: only track owner can delete)
// Audit B-A1+B-A2 (2026-05-31): добавлен audit log + rate-limit (5/min).
tracksRoutes.delete('/:id', requireAuth, profileLimiter, async (c) => {
  try {
    const trackId = c.req.param('id');
    const userId = c.get('userId');

    // Ownership check
    const existing = await typed.getTrackById(trackId);
    if (!existing) {
      return c.json({ success: false, error: 'Track not found' }, 404);
    }
    if (existing.user_id && existing.user_id !== userId) {
      return c.json({ success: false, error: 'Not authorized to delete this track' }, 403);
    }

    await typed.deleteTrack(trackId);
    logUserAction(c, {
      action: 'artist_track_delete',
      resourceType: 'track',
      targetId: String(trackId),
      details: { title: existing.title, artist_name: existing.artist_name },
    });
    return c.json({ success: true, message: 'Track deleted' });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /:id/download — universal track download for verified radio/venue
//
// Two-stage gate:
//   1. Account is active — handled implicitly by JWT auth.
//   2. Profile has is_verified=true (admin trust gate) — checked below
//      against radio_profiles OR venue_profiles depending on role.
//
// Each successful download is logged with a SNAPSHOT of the
// downloader's city at that moment (radio_profiles.data->>'city' /
// venue_profiles.data->>'city'). If the profile changes city later
// historical rows keep their original value — analytics stay
// faithful to where the track actually went.
//
// Track must be in 'upcoming' or 'published' state (publicly live).
// Other states (paid waiting admin gate, rejected, draft) are not
// downloadable even by verified accounts.
tracksRoutes.get('/:id/download', requireAuth, async (c) => {
  try {
    const trackId = c.req.param('id');
    // @ts-ignore — Hono context isn't typed for these custom keys but
    // they're set by requireAuth middleware (see auth-middleware.tsx).
    const userId: string = c.get('userId');
    // @ts-ignore — same as above.
    const role: string = c.get('userRole') || '';

    if (role !== 'radio_station' && role !== 'venue') {
      return c.json({
        success: false,
        error: 'Скачивать треки могут только радиостанции и заведения',
      }, 403);
    }

    // Profile + is_verified check.
    const profileTable = role === 'radio_station' ? 'radio_profiles' : 'venue_profiles';
    const profileRes = await pool.query(
      `SELECT is_verified,
              data->>'city'        AS city,
              data->>'stationName' AS station_name,
              data->>'venueName'   AS venue_name
         FROM ${profileTable}
        WHERE user_id = $1
        LIMIT 1`,
      [userId]
    );
    const profile = profileRes.rows[0];
    if (!profile) {
      return c.json({ success: false, error: 'Профиль не найден' }, 404);
    }
    if (!profile.is_verified) {
      return c.json({
        success: false,
        error: 'Аккаунт не верифицирован администратором. Скачивание недоступно.',
      }, 403);
    }

    // Track lookup + state check.
    const trackRes = await pool.query(
      `SELECT id, title, audio_url, moderation_status
         FROM tracks
        WHERE id = $1`,
      [trackId]
    );
    const track = trackRes.rows[0];
    if (!track) {
      return c.json({ success: false, error: 'Трек не найден' }, 404);
    }
    if (!track.audio_url) {
      return c.json({ success: false, error: 'Аудиофайл недоступен' }, 404);
    }
    if (track.moderation_status !== 'upcoming' && track.moderation_status !== 'published') {
      return c.json({
        success: false,
        error: `Трек ещё не опубликован (статус: ${track.moderation_status})`,
      }, 403);
    }

    const ipAddr = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '';
    const userAgent = c.req.header('user-agent') || '';

    if (role === 'radio_station') {
      await pool.query(
        `INSERT INTO track_downloads_by_radio
           (user_id, station_name, track_id, city, weekly_release_id, ip_addr, user_agent)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
        [userId, profile.station_name || null, trackId, profile.city || null, ipAddr, userAgent]
      );
    } else {
      await pool.query(
        `INSERT INTO track_downloads_by_venue
           (user_id, venue_name, track_id, city, ip_addr, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, profile.venue_name || null, trackId, profile.city || null, ipAddr, userAgent]
      );
    }

    console.log(
      `[tracks/download] role=${role} userId=${userId} trackId=${trackId} ` +
      `city=${profile.city || '?'} -> ${track.audio_url}`
    );

    return c.redirect(track.audio_url, 302);
  } catch (error) {
    console.error('[tracks/download] error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default tracksRoutes;

// GET /radio-stats — Radio pickup stats for user's tracks (station count + city count)
tracksRoutes.get('/radio-stats/all', async (c) => {
  try {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);
    const { pool } = await import('./db-client.tsx');

    // Audit INC-A1 (2026-05-31): раньше при пустом результате был fallback
    // на ВСЕ треки всех артистов (competitor analytics leak). Удалён —
    // пустой результат значит "у этого юзера нет треков с pickups",
    // возвращаем пустой объект (не leak'аем чужие данные).
    const result = await pool.query(`
      SELECT
        t.id as track_id,
        COUNT(DISTINCT trp.station_name) as radio_count,
        COUNT(DISTINCT trp.city) as city_count
      FROM tracks t
      LEFT JOIN track_radio_pickups trp ON trp.track_id = t.id
      WHERE t.user_id = $1
      GROUP BY t.id
      HAVING COUNT(DISTINCT trp.station_name) > 0
    `, [userId]);

    // Convert to map: { trackId: { radioCount, cityCount } }
    const stats: Record<string, { radioCount: number; cityCount: number }> = {};
    for (const row of result.rows) {
      stats[row.track_id] = {
        radioCount: parseInt(row.radio_count) || 0,
        cityCount: parseInt(row.city_count) || 0,
      };
    }

    return c.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error in GET /tracks/radio-stats/all:', error);
    // Audit INC-A1: раньше catch отвечал success:true {} → клиент думал
    // "stats нет", не различая "не доступно сейчас" от "реально пусто".
    return c.json({ success: false, error: 'Failed to load radio stats' }, 500);
  }
});
