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
import { artistAnalyticsCacheStore } from './db.tsx';

const app = new Hono();

// GET /overview/:artistId
app.get('/overview/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  const artistId = c.req.param('artistId');
  const period = c.req.query('period') || 'month';

  try {
    // Cache key prefix bumped to v2 so stale entries written by the old
    // (broken) JSONB-aggregating version are not served. Old entries
    // expire on their own TTL; we just stop reading them.
    const cacheKey = `v2:${artistId}:${period}`;
    const cached = await artistAnalyticsCacheStore.get(cacheKey);
    if (cached) {
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

    await artistAnalyticsCacheStore.set(cacheKey, analytics);
    return c.json({ success: true, analytics, source: 'db' });
  } catch (err) {
    console.error('[artist-analytics] /overview failed:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /timeline/:artistId — historical time series not yet tracked.
app.get('/timeline/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  return c.json({
    success: true,
    timeline: [],
    period: c.req.query('period') || 'month',
    message: 'Historical timeline data is not yet available',
  });
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
//   - venue rotations  → no per-artist play log table exists, only
//     venueAdCampaignsStore (KV, keyed by venue_id). Reporting honest
//     null so the UI can show "Скоро" instead of inventing a number.
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

    // ── 3. Radio rotations (only confirmed pickups for this artist's tracks) ──
    // JOIN by track_id; rp.track_id and tracks.id are both uuid → no cast.
    // Filter by tracks.user_id (text) = $1 (text from URL). Manual-confirmed
    // only — pending/rejected pickups don't count as real rotations.
    let radioRotations = 0;
    let radioStationsCount = 0;
    try {
      const { rows } = await pool.query(
        `SELECT
           COALESCE(SUM(rp.rotation_count), 0)::bigint AS rotations,
           COUNT(DISTINCT rp.station_name)::int        AS stations
         FROM track_radio_pickups rp
         JOIN tracks t ON t.id = rp.track_id
         WHERE t.user_id = $1 AND rp.report_status = 'confirmed'`,
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

export default app;
