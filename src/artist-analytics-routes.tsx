/**
 * ARTIST ANALYTICS ROUTES - real numbers off native track columns.
 *
 * After the KV→native migrations (003-007), per-track counts live in
 * canonical columns: tracks.plays_count, tracks.likes_count,
 * tracks.moderation_status. The old queries against `data->>'plays'`
 * / `data->>'artistId'` always returned 0 — the JSONB keys aren't
 * populated anymore. That's why /artist/settings → tab=analytics
 * showed every metric as 0 ("не работает совсем").
 *
 * COLUMN TYPES (verified against codebase queries, cabinet schema as of
 * 2026-05-23; see CLAUDE.md → SQL writing pitfalls):
 *   tracks.user_id            : text   → URL-param compare, no cast
 *   tracks.moderation_status  : text
 *   tracks.plays_count        : integer
 *   tracks.likes_count        : integer
 *   artist_profiles.user_id   : text   → no cast
 *   artist_profiles.total_followers : integer
 *
 * NOTE: requireOwner('artistId') means the :artistId URL param is the
 * caller's user_id (JWT-derived), not artist_profiles.id. So we filter
 * tracks WHERE user_id = $1. Label-on-behalf uploads (where artist_id
 * ≠ uploader's user_id) won't show up here — that's an accepted gap
 * for v1; can be solved with a JOIN on artist_profiles later.
 *
 * Endpoints:
 *   GET /overview/:artistId   real aggregates over tracks
 *   GET /timeline/:artistId   not yet tracked → empty []
 *   GET /tracks/:artistId     real per-track stats
 *   GET /geography/:artistId  not yet tracked → empty []
 *   GET /platforms/:artistId  not yet tracked → empty []
 */

import { Hono } from 'hono';
import { requireAuth, requireOwner } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { type RadioScope, parseRadioScope, scopeTracksSql, scopeItemsSql } from './radio-scope.tsx';

// Cache TTL для overview-аналитики. 5 минут — баланс между скоростью
// и свежестью: COUNT/SUM по tracks дёшев (≤500мс), но повторы внутри
// одной сессии артиста (refresh dashboard, переключение period) ловит
// кэш. Прогорклые записи не нужно ловить отдельным cron — следующий
// compute их перезатрёт.
const CACHE_TTL_SECONDS = 5 * 60;

const app = new Hono();

// GET /overview/:artistId
app.get('/overview/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  const artistId = c.req.param('artistId');
  const period = c.req.query('period') || 'month';

  try {
    // Cache key prefix bumped to v2 so stale entries written by the old
    // (broken) JSONB-aggregating version are not served. Native
    // expires_at column enforces TTL (migration 041) — stale rows are
    // skipped on read, overwritten on next compute.
    const cacheKey = `v2:${artistId}:${period}`;
    const cacheRes = await pool.query(
      `SELECT data FROM artist_analytics_cache
        WHERE artist_id = $1 AND expires_at > NOW()`,
      [cacheKey],
    );
    if (cacheRes.rows.length > 0) {
      const cached = cacheRes.rows[0].data;
      return c.json({ success: true, analytics: cached, source: 'cache' });
    }

    // Aggregate from native columns. user_id is TEXT, $1 is TEXT from
    // URL — direct compare, no cast.
    const tracksResult = await pool.query(
      `SELECT
         COUNT(*)::int                                                              AS track_count,
         COUNT(*) FILTER (WHERE moderation_status IN ('approved','published'))::int AS approved_tracks,
         COALESCE(SUM(plays_count) FILTER (WHERE moderation_status = 'published'), 0)::bigint AS total_plays,
         COALESCE(SUM(likes_count) FILTER (WHERE moderation_status = 'published'), 0)::bigint AS total_likes
       FROM tracks WHERE user_id = $1`,
      [artistId],
    );

    const stats = tracksResult.rows[0] || {};
    const totalPlays  = Number(stats.total_plays)  || 0;
    const totalLikes  = Number(stats.total_likes)  || 0;
    const trackCount     = Number(stats.track_count)     || 0;
    const approvedTracks = Number(stats.approved_tracks) || 0;

    // Followers from artist_profiles (canonical). Same text-to-text
    // compare; safe to skip if no profile row (returns 0).
    let followers = 0;
    try {
      const { rows } = await pool.query(
        `SELECT total_followers FROM artist_profiles WHERE user_id = $1 LIMIT 1`,
        [artistId],
      );
      followers = Number(rows[0]?.total_followers ?? 0);
    } catch { /* keep 0 */ }

    const analytics = {
      period,
      totalPlays,
      totalLikes,
      // shares column doesn't exist in tracks schema — explicit 0 instead
      // of inventing a SELECT for a missing column (CLAUDE.md pitfall #2).
      totalShares: 0,
      trackCount,
      approvedTracks,
      followers,
      engagementRate: totalPlays > 0 ? +((totalLikes / totalPlays) * 100).toFixed(1) : 0,
      // Not yet tracked — return null so the UI can render "—" rather
      // than seeding fake numbers that look real.
      followersGrowth:   null,
      playsGrowth:       null,
      likesGrowth:       null,
      revenueGrowth:     null,
      revenue:           null,
      activeListeners:   null,
      avgListenDuration: null,
      completionRate:    null,
      peakHour:          null,
      platforms:         null,
      geography:         null,
      demographics:      null,
      hourlyActivity:    null,
    };

    await pool.query(
      `INSERT INTO artist_analytics_cache (artist_id, data, expires_at, updated_at)
       VALUES ($1, $2::jsonb, NOW() + ($3 || ' seconds')::interval, NOW())
       ON CONFLICT (artist_id) DO UPDATE
         SET data = EXCLUDED.data,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`,
      [cacheKey, JSON.stringify(analytics), String(CACHE_TTL_SECONDS)],
    );
    return c.json({ success: true, analytics, source: 'db' });
  } catch (err) {
    console.error('[artist-analytics] /overview failed:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /timeline/:artistId — historical time series not yet tracked.
app.get('/timeline/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  // Раньше отдавал пустой массив: событий прослушивания не существовало.
  // С 2026-08-11 они пишутся в track_plays (жалоба Черниченко на мёртвую
  // статистику), поэтому строим реальный ряд по дням. Дни без прослушиваний
  // не выпадают из ряда, иначе график врёт формой.
  const artistId = c.req.param('artistId');
  const period = c.req.query('period') || 'month';
  const days = period === 'week' ? 7 : period === 'year' ? 365 : 30;

  try {
    const result = await pool.query(
      `SELECT d::date AS day, COALESCE(p.cnt, 0) AS plays
         FROM generate_series(now()::date - ($2::int - 1), now()::date, interval '1 day') AS d
         LEFT JOIN (
           SELECT tp.played_at::date AS day, COUNT(*) AS cnt
             FROM track_plays tp
             JOIN tracks t ON t.id = tp.track_id
            WHERE t.user_id = $1
              AND tp.played_at >= now()::date - ($2::int - 1)
            GROUP BY 1
         ) p ON p.day = d::date
        ORDER BY d`,
      [artistId, days],
    );

    const timeline = result.rows.map((row: any) => ({
      date: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10),
      plays: Number(row.plays) || 0,
    }));

    return c.json({ success: true, timeline, period });
  } catch (err) {
    console.error('[artist-analytics] /timeline failed:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /tracks/:artistId
app.get('/tracks/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  const artistId = c.req.param('artistId');

  try {
    // Native columns only — title/genre/moderation_status are TEXT,
    // counts are INTEGER, user_id is TEXT for the WHERE.
    const result = await pool.query(
      `SELECT id, title, genre, moderation_status,
              COALESCE(plays_count, 0) AS plays_count,
              COALESCE(likes_count, 0) AS likes_count
       FROM tracks
       WHERE user_id = $1
       ORDER BY plays_count DESC
       LIMIT 50`,
      [artistId],
    );

    const tracks = result.rows.map((row: any) => ({
      id:     row.id,
      title:  row.title || 'Без названия',
      plays:  Number(row.plays_count) || 0,
      likes:  Number(row.likes_count) || 0,
      // tracks.shares_count column doesn't exist — fixed 0 keeps the
      // shape stable for the frontend without inventing a column.
      shares: 0,
      saves:  0,
      status: row.moderation_status || 'pending',
      genre:  row.genre || null,
      // Not tracked — explicit null so UI can render "—".
      completionRate: null,
      avgListenTime:  null,
      trend:          null,
      trendValue:     null,
    }));

    return c.json({ success: true, tracks, source: 'db' });
  } catch (err) {
    console.error('[artist-analytics] /tracks failed:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /geography/:artistId — Not yet tracked
app.get('/geography/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  return c.json({
    success: true,
    geography: [],
    message: 'Geography data is not yet available',
  });
});

// GET /downloads/:artistId — Aggregated download stats from
// verified radio stations and venues. Returns:
//   totals: { radio_downloads, venue_downloads, unique_stations,
//             unique_venues, unique_cities }
//   byCity: [{ city, radio_count, venue_count, total }]
//   topRadio: [{ station_name, count }]
//   topVenue: [{ venue_name, count }]
//   perTrack: [{ track_id, title, radio_count, venue_count }]
// Only counts rows from the two physical tables (track_downloads_
// _by_radio + track_downloads_by_venue) — no synthetic multipliers,
// honest zeros when nothing recorded.
app.get('/downloads/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  try {
    const artistId = c.req.param('artistId');

    // Audit 2026-06-04: requireOwner('artistId') forces artistId === userId
    // (text from JWT), so this MUST filter tracks.user_id (text) — same as
    // /home and /tracks. It used tracks.artist_id (uuid = artist_profiles.id)
    // → 0 rows → the «Скачивания» card was empty by construction.
    const trackIdsRes = await pool.query(
      `SELECT id, title FROM tracks WHERE user_id = $1`,
      [artistId]
    );
    if (trackIdsRes.rows.length === 0) {
      return c.json({
        success: true,
        totals: {
          radio_downloads: 0, venue_downloads: 0,
          unique_stations: 0, unique_venues: 0, unique_cities: 0,
        },
        byCity: [], topRadio: [], topVenue: [], perTrack: [],
      });
    }
    const trackIds = trackIdsRes.rows.map((r) => r.id);

    const [
      radioAggRes,
      venueAggRes,
      cityBreakdownRes,
      topRadioRes,
      topVenueRes,
      perTrackRes,
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int                       AS total_downloads,
                COUNT(DISTINCT station_name)::int   AS unique_stations,
                COUNT(DISTINCT city) FILTER (WHERE city IS NOT NULL AND city <> '')::int AS unique_cities
           FROM track_downloads_by_radio
          WHERE track_id = ANY($1::uuid[])`,
        [trackIds]
      ),
      pool.query(
        `SELECT COUNT(*)::int                  AS total_downloads,
                COUNT(DISTINCT user_id)::int   AS unique_venues,
                COUNT(DISTINCT city) FILTER (WHERE city IS NOT NULL AND city <> '')::int AS unique_cities
           FROM track_downloads_by_venue
          WHERE track_id = ANY($1::uuid[])`,
        [trackIds]
      ),
      pool.query(
        `WITH all_dl AS (
           SELECT city, 1 AS r, 0 AS v FROM track_downloads_by_radio WHERE track_id = ANY($1::uuid[])
           UNION ALL
           SELECT city, 0 AS r, 1 AS v FROM track_downloads_by_venue WHERE track_id = ANY($1::uuid[])
         )
         SELECT COALESCE(NULLIF(city, ''), '(не указан)') AS city,
                SUM(r)::int AS radio_count,
                SUM(v)::int AS venue_count,
                (SUM(r) + SUM(v))::int AS total
           FROM all_dl
          GROUP BY COALESCE(NULLIF(city, ''), '(не указан)')
          ORDER BY total DESC
          LIMIT 20`,
        [trackIds]
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(station_name, ''), '(без названия)') AS station_name,
                COUNT(*)::int AS count
           FROM track_downloads_by_radio
          WHERE track_id = ANY($1::uuid[])
          GROUP BY COALESCE(NULLIF(station_name, ''), '(без названия)')
          ORDER BY count DESC
          LIMIT 10`,
        [trackIds]
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(venue_name, ''), '(без названия)') AS venue_name,
                COUNT(*)::int AS count
           FROM track_downloads_by_venue
          WHERE track_id = ANY($1::uuid[])
          GROUP BY COALESCE(NULLIF(venue_name, ''), '(без названия)')
          ORDER BY count DESC
          LIMIT 10`,
        [trackIds]
      ),
      pool.query(
        `WITH r AS (
           SELECT track_id, COUNT(*)::int AS c FROM track_downloads_by_radio
            WHERE track_id = ANY($1::uuid[]) GROUP BY track_id
         ),
         v AS (
           SELECT track_id, COUNT(*)::int AS c FROM track_downloads_by_venue
            WHERE track_id = ANY($1::uuid[]) GROUP BY track_id
         )
         SELECT t.id AS track_id, t.title,
                COALESCE(r.c, 0) AS radio_count,
                COALESCE(v.c, 0) AS venue_count
           FROM tracks t
           LEFT JOIN r ON r.track_id = t.id
           LEFT JOIN v ON v.track_id = t.id
          WHERE t.id = ANY($1::uuid[])
          ORDER BY (COALESCE(r.c, 0) + COALESCE(v.c, 0)) DESC`,
        [trackIds]
      ),
    ]);

    const radioRow = radioAggRes.rows[0] || { total_downloads: 0, unique_stations: 0, unique_cities: 0 };
    const venueRow = venueAggRes.rows[0] || { total_downloads: 0, unique_venues: 0, unique_cities: 0 };

    return c.json({
      success: true,
      totals: {
        radio_downloads: radioRow.total_downloads,
        venue_downloads: venueRow.total_downloads,
        unique_stations: radioRow.unique_stations,
        unique_venues:   venueRow.unique_venues,
        // unique-cities is a union not a sum; compute via cityBreakdown rows.
        unique_cities:   cityBreakdownRes.rows.filter((r) => r.city !== '(не указан)').length,
      },
      byCity:   cityBreakdownRes.rows,
      topRadio: topRadioRes.rows,
      topVenue: topVenueRes.rows,
      perTrack: perTrackRes.rows,
    });
  } catch (error) {
    console.error('[analytics/downloads] error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /platforms/:artistId — Not yet tracked
app.get('/platforms/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  return c.json({
    success: true,
    platforms: [],
    message: 'Platform data is not yet available',
  });
});

// GET /home/:artistId
//
// Stats panel for the artist home page. Single endpoint that rolls up
// every metric the home page renders so we don't make N parallel calls.
//
// COLUMN TYPES (verified against codebase queries; see CLAUDE.md cheat sheet):
//   tracks.user_id                          : text     → text=text, no cast
//   tracks.moderation_status                : text
//   tracks.plays_count / likes_count        : integer
//   tracks.id                               : uuid
//   artist_profiles.user_id                 : text
//   artist_profiles.total_followers         : integer
//   artist_profiles.monthly_listeners       : integer
//   track_radio_pickups.track_id            : uuid (FK → tracks.id, no cast on JOIN)
//   track_radio_pickups.report_status       : text
//   track_radio_pickups.rotation_count      : integer
//   pitching_submissions.user_id            : text
//   pitching_submissions.status             : text
//
// What's NOT here (audit found no SQL source):
//   - venue rotations  → no per-artist play log table exists; venue_ad_campaigns
//     holds campaign config (not per-artist plays). Reporting honest
//     null so the UI can show "Скоро" instead of inventing a number.
// Радиостанции в кабинете ($1 = users.id владельца, состав — radio-scope.tsx):
// подтверждённые отчёты о ротации (track_radio_pickups без source='auto' —
// витринный декор, инцидент 2026-07-13) + станции, скачавшие трек
// (track_downloads_by_radio; владелец 08.10.2026: «добавляй в личный кабинет
// эти радио и их ротации»), а у диджея ещё и станции, скачавшие его микс
// (mix_downloads_by_radio, 12.10.2026).
// Скачивание — не ротация: такие строки идут с rotation_count = 0,
// reported = false; ротации приходят из отчётов станции, эфиры PROMO.CHECK
// кабинет показывает отдельным блоком. airplay_verified — только водяной
// знак (детекции с watermark_confirmed и эфиры PROMO.CHECK Live):
// детекции по одному отпечатку — шум (проверка 01.10.2026).
// track_id в radio_rows — text: uuid трека или id микса ('mix-…').
function radioRowsSql(scope: RadioScope): string {
  const mixDownloads = scope === 'dj' ? `
    UNION
    SELECT DISTINCT NULL::uuid, md.mix_id, TRIM(md.station_name), NULLIF(TRIM(md.city), '')
      FROM mix_downloads_by_radio md JOIN dj_mixes m ON m.id = md.mix_id
     WHERE m.dj_id = $1 AND NULLIF(TRIM(md.station_name), '') IS NOT NULL` : '';
  return `
  WITH my AS (${scopeTracksSql(scope)}),
  items AS (${scopeItemsSql(scope)}),
  rep AS (
    SELECT rp.track_id AS tid, NULL::text AS mid, rp.station_name, NULLIF(rp.city, '') AS city,
           COALESCE(rp.rotation_count, 0)::int AS rotation_count
      FROM track_radio_pickups rp JOIN my ON my.id = rp.track_id
     WHERE rp.report_status = 'confirmed' AND rp.source IS DISTINCT FROM 'auto'
  ),
  dl AS (
    SELECT DISTINCT d.track_id AS tid, NULL::text AS mid, TRIM(d.station_name) AS station_name, NULLIF(TRIM(d.city), '') AS city
      FROM track_downloads_by_radio d JOIN my ON my.id = d.track_id
     WHERE NULLIF(TRIM(d.station_name), '') IS NOT NULL${mixDownloads}
  ),
  radio_rows AS (
    SELECT COALESCE(r.tid::text, r.mid) AS track_id, r.station_name, r.city, r.rotation_count, r.reported,
           EXISTS (SELECT 1 FROM dl WHERE (dl.tid = r.tid OR dl.mid = r.mid) AND dl.station_name = r.station_name) AS downloaded,
           (EXISTS (SELECT 1 FROM promo_check_detections d
                     WHERE d.track_id = r.tid AND d.station_name = r.station_name AND d.watermark_confirmed)
            OR EXISTS (SELECT 1 FROM promo_check_plays p
                        WHERE (p.track_id = r.tid OR p.mix_id = r.mid) AND p.station_name = r.station_name)
            OR EXISTS (SELECT 1 FROM dj_mix_detections x
                        WHERE x.mix_id = r.mid AND x.station_name = r.station_name AND x.watermark_confirmed)
           ) AS airplay_verified
      FROM (
        SELECT tid, mid, station_name, city, rotation_count, true AS reported FROM rep
        UNION ALL
        SELECT dl.tid, dl.mid, dl.station_name, dl.city, 0, false FROM dl
         WHERE NOT EXISTS (SELECT 1 FROM rep WHERE rep.tid = dl.tid AND rep.station_name = dl.station_name)
      ) r
  )`;
}

app.get('/home/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  const artistId = c.req.param('artistId');

  try {
    // ── 1. Track aggregates (plays / likes / counts by status) ──
    const tracksAgg = await pool.query(
      `SELECT
         COUNT(*)::int                                                  AS total_tracks,
         COUNT(*) FILTER (WHERE moderation_status = 'published')::int   AS published_tracks,
         COUNT(*) FILTER (WHERE moderation_status = 'pending')::int     AS pending_tracks,
         COUNT(*) FILTER (WHERE moderation_status = 'approved')::int    AS approved_tracks,
         COALESCE(SUM(plays_count) FILTER (WHERE moderation_status = 'published'), 0)::bigint AS total_plays,
         COALESCE(SUM(likes_count) FILTER (WHERE moderation_status = 'published'), 0)::bigint AS total_likes
       FROM tracks WHERE user_id = $1`,
      [artistId],
    );
    const tAgg = tracksAgg.rows[0] || {};

    // ── 2. Profile rollup (followers / monthly listeners / rating) ──
    let followers = 0;
    let monthlyListeners: number | null = null;
    let rating: number | null = null;
    try {
      const { rows } = await pool.query(
        `SELECT total_followers, monthly_listeners, rating
         FROM artist_profiles WHERE user_id = $1 LIMIT 1`,
        [artistId],
      );
      if (rows[0]) {
        followers        = Number(rows[0].total_followers ?? 0);
        monthlyListeners = rows[0].monthly_listeners != null ? Number(rows[0].monthly_listeners) : null;
        rating           = rows[0].rating != null ? Number(rows[0].rating) : null;
      }
    } catch (err) {
      console.warn('[home-stats] artist_profiles read failed:', err);
    }

    // ── 3. Radio rotations + stations (radioRowsSql) ──
    // Ротации — только подтверждённые отчёты станций; в число станций
    // входят и станции, скачавшие трек.
    let radioRotations = 0;
    let radioStationsCount = 0;
    try {
      const { rows } = await pool.query(
        `${radioRowsSql('artist')}
         SELECT COALESCE(SUM(rotation_count), 0)::bigint AS rotations,
                COUNT(DISTINCT station_name)::int        AS stations
           FROM radio_rows`,
        [artistId],
      );
      radioRotations     = Number(rows[0]?.rotations ?? 0);
      radioStationsCount = Number(rows[0]?.stations  ?? 0);
    } catch (err) {
      // Table may not exist in some envs — return 0s and warn.
      console.warn('[home-stats] radio_pickups read failed:', err);
    }

    // ── 4. Pitching submissions breakdown ──
    // pitching_submissions.user_id is text → direct compare.
    let pitchingTotal = 0;
    let pitchingPending = 0;
    let pitchingAccepted = 0;
    let pitchingRejected = 0;
    try {
      const { rows } = await pool.query(
        `SELECT status, COUNT(*)::int AS cnt
         FROM pitching_submissions
         WHERE user_id = $1
         GROUP BY status`,
        [artistId],
      );
      for (const r of rows) {
        const cnt = Number(r.cnt) || 0;
        pitchingTotal += cnt;
        if (r.status === 'pending')  pitchingPending  = cnt;
        if (r.status === 'accepted') pitchingAccepted = cnt;
        if (r.status === 'rejected') pitchingRejected = cnt;
      }
    } catch (err) {
      console.warn('[home-stats] pitching_submissions read failed:', err);
    }

    return c.json({
      success: true,
      data: {
        plays:      Number(tAgg.total_plays) || 0,
        likes:      Number(tAgg.total_likes) || 0,
        followers,
        monthlyListeners,
        rating,
        tracks: {
          total:     Number(tAgg.total_tracks) || 0,
          published: Number(tAgg.published_tracks) || 0,
          pending:   Number(tAgg.pending_tracks)   || 0,
          approved:  Number(tAgg.approved_tracks)  || 0,
        },
        radio: {
          rotations: radioRotations,
          stations:  radioStationsCount,
        },
        // No SQL source for per-artist venue plays today — explicit null
        // so the UI can show "Скоро" or a placeholder instead of 0
        // (which would falsely suggest the artist's tracks have never
        // been played at a venue).
        venue: null,
        pitching: {
          total:    pitchingTotal,
          pending:  pitchingPending,
          accepted: pitchingAccepted,
          rejected: pitchingRejected,
        },
      },
    });
  } catch (err) {
    console.error('[home-stats] failed:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /radio-details/:artistId
//
// Detailed confirmed radio pickups for the artist's tracks — which
// station, which city, how many rotations. This is the airplay
// breakdown the artist cabinet renders (station names + broadcast
// cities + rotation graph). DISTINCT from /downloads (which counts
// download EVENTS): this lists stations — confirmed rotation reports plus
// stations that downloaded the track (radioRowsSql, 08.10.2026).
//
// Reads the same radioRowsSql as /home, so the detail rows are
// consistent with the SUM/COUNT totals already shown on the home page —
// /home only aggregates these same rows, this endpoint returns them.
// ?scope=label — треки всего ростера лейбла, ?scope=dj — треки и миксы
// диджея (radio-scope.tsx, 12.10.2026); без scope — треки артиста.
//
// COLUMN TYPES (same cabinet schema as /home):
//   track_radio_pickups.track_id       : uuid (FK → tracks.id, no cast on JOIN)
//   track_radio_pickups.station_name   : text
//   track_radio_pickups.city           : text
//   track_radio_pickups.rotation_count : integer
//   track_radio_pickups.report_status  : text
//   tracks.user_id                     : text → text=text compare, no cast
app.get('/radio-details/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  const artistId = c.req.param('artistId');
  const rows = radioRowsSql(parseRadioScope(c.req.query('scope')));

  try {
    // Run the three aggregations in parallel over radioRowsSql —
    // confirmed reports + stations that downloaded the track.
    const [byStationRes, byCityRes, perTrackRes] = await Promise.all([
      // By station: each station, with how many distinct cities and total
      // rotations; reported/downloaded tell a rotation from a download.
      pool.query(
        `${rows}
         SELECT station_name,
                COUNT(DISTINCT city)::int AS city_count,
                COALESCE(SUM(rotation_count), 0)::int AS total_rotations,
                BOOL_OR(airplay_verified) AS airplay_verified,
                BOOL_OR(reported) AS reported,
                BOOL_OR(downloaded) AS downloaded
           FROM radio_rows
          GROUP BY station_name
          ORDER BY total_rotations DESC, station_name ASC`,
        [artistId],
      ),
      // By city: cities, with how many distinct stations and total
      // rotations in each.
      pool.query(
        `${rows}
         SELECT COALESCE(city, '(не указан)') AS city,
                COUNT(DISTINCT station_name)::int AS station_count,
                COALESCE(SUM(rotation_count), 0)::int AS total_rotations
           FROM radio_rows
          GROUP BY COALESCE(city, '(не указан)')
          ORDER BY total_rotations DESC, city ASC`,
        [artistId],
      ),
      // Per track: each row (station + city + rotations) so the UI can show
      // a per-release breakdown.
      pool.query(
        `${rows}
         SELECT r.track_id, items.title, items.kind, r.station_name, r.city, r.rotation_count,
                r.airplay_verified, r.reported, r.downloaded
           FROM radio_rows r
           JOIN items ON items.id = r.track_id
          ORDER BY items.title ASC, r.rotation_count DESC`,
        [artistId],
      ),
    ]);

    // Group per-track rows into { track_id, title, pickups: [...] }.
    type Pickup = { station_name: string; city: string | null; rotation_count: number; airplay_verified: boolean; reported: boolean; downloaded: boolean };
    const trackMap = new Map<string, { track_id: string; title: string; kind: string; pickups: Pickup[] }>();
    for (const r of perTrackRes.rows) {
      if (!trackMap.has(r.track_id)) {
        trackMap.set(r.track_id, { track_id: r.track_id, title: r.title || 'Без названия', kind: r.kind || 'track', pickups: [] });
      }
      trackMap.get(r.track_id)!.pickups.push({
        station_name: r.station_name || '(без названия)',
        city: r.city ?? null,
        rotation_count: Number(r.rotation_count) || 0,
        airplay_verified: r.airplay_verified === true,
        reported: r.reported === true,
        downloaded: r.downloaded === true,
      });
    }

    const totalRotations = byStationRes.rows.reduce((s: number, r: any) => s + (Number(r.total_rotations) || 0), 0);

    return c.json({
      success: true,
      stations: byStationRes.rows,
      cities: byCityRes.rows,
      tracks: Array.from(trackMap.values()),
      totals: {
        stations:  byStationRes.rows.length,
        // city list includes a synthetic '(не указан)' bucket for blank
        // cities — exclude it from the honest city count.
        cities:    byCityRes.rows.filter((r: any) => r.city !== '(не указан)').length,
        rotations: totalRotations,
      },
    });
  } catch (err) {
    // Table may be absent in some envs, or a column missing — warn and
    // return a 500 the frontend catches (section then hides) rather than
    // crashing the analytics page.
    console.error('[artist-analytics] /radio-details failed:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default app;
