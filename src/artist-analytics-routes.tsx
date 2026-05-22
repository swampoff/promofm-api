/**
 * ARTIST ANALYTICS ROUTES - Real data only (NO simulations)
 *
 * KV Keys:
 *   artist_analytics:{artistId}   -> cached analytics
 *
 * Endpoints:
 * GET /overview/:artistId   - Real analytics from DB
 * GET /tracks/:artistId     - Real track stats from DB
 * GET /geography/:artistId  - Not yet tracked
 * GET /platforms/:artistId  - Not yet tracked
 * GET /timeline/:artistId   - Not yet tracked
 */

import { Hono } from 'hono';
import { requireAuth, requireOwner } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { getArtistProfile, artistAnalyticsCacheStore } from './db.tsx';

const app = new Hono();

// GET /overview/:artistId — Real analytics from tracks table
app.get('/overview/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  const artistId = c.req.param('artistId');
  const period = c.req.query('period') || 'month';

  try {
    const cacheKey = `${artistId}:${period}`;
    const cached = await artistAnalyticsCacheStore.get(cacheKey);
    if (cached) {
      return c.json({ success: true, analytics: cached, source: 'cache' });
    }

    // Real data from tracks table
    const tracksResult = await pool.query(
      `SELECT
        COUNT(*) as track_count,
        COALESCE(SUM(CASE WHEN data->>'status' = 'approved' THEN 1 ELSE 0 END), 0) as approved_tracks,
        COALESCE(SUM((data->>'plays')::int), 0) as total_plays,
        COALESCE(SUM((data->>'likes')::int), 0) as total_likes,
        COALESCE(SUM((data->>'shares')::int), 0) as total_shares
      FROM tracks WHERE data->>'artistId' = $1`,
      [artistId]
    );

    const stats = tracksResult.rows[0] || {};
    const totalPlays = Number(stats.total_plays) || 0;
    const totalLikes = Number(stats.total_likes) || 0;
    const totalShares = Number(stats.total_shares) || 0;
    const trackCount = Number(stats.track_count) || 0;
    const approvedTracks = Number(stats.approved_tracks) || 0;

    // Profile data
    const artistProfile = await getArtistProfile(artistId);
    const subscribers = (artistProfile as any)?.subscribers || 0;

    const analytics = {
      period,
      totalPlays,
      totalLikes,
      totalShares,
      trackCount,
      approvedTracks,
      followers: subscribers,
      engagementRate: totalPlays > 0 ? +((totalLikes / totalPlays) * 100).toFixed(1) : 0,
      // Not yet tracked — return null instead of fake data
      followersGrowth: null,
      playsGrowth: null,
      likesGrowth: null,
      revenueGrowth: null,
      revenue: null,
      activeListeners: null,
      avgListenDuration: null,
      completionRate: null,
      peakHour: null,
      platforms: null,
      geography: null,
      demographics: null,
      hourlyActivity: null,
    };

    // Cache for 5 minutes
    await artistAnalyticsCacheStore.set(cacheKey, analytics);

    return c.json({ success: true, analytics, source: 'db' });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /timeline/:artistId — Not yet tracked (no historical data)
app.get('/timeline/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  return c.json({
    success: true,
    timeline: [],
    period: c.req.query('period') || 'month',
    message: 'Historical timeline data is not yet available',
  });
});

// GET /tracks/:artistId — Real track stats from DB
app.get('/tracks/:artistId', requireAuth, requireOwner('artistId'), async (c) => {
  const artistId = c.req.param('artistId');

  try {
    const result = await pool.query(
      `SELECT id, data FROM tracks
       WHERE data->>'artistId' = $1
       ORDER BY COALESCE((data->>'plays')::int, 0) DESC
       LIMIT 50`,
      [artistId]
    );

    const tracks = result.rows.map((row: any) => {
      const d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      return {
        id: row.id,
        title: d.title || 'Без названия',
        plays: Number(d.plays) || 0,
        likes: Number(d.likes) || 0,
        shares: Number(d.shares) || 0,
        saves: Number(d.saves) || 0,
        status: d.status || 'pending',
        genre: d.genre || null,
        // Not tracked — null instead of fake values
        completionRate: null,
        avgListenTime: null,
        trend: null,
        trendValue: null,
      };
    });

    return c.json({ success: true, tracks, source: 'db' });
  } catch (err) {
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

export default app;
