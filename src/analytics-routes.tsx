import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';

const analyticsRoutes = new Hono();

// GET /analytics/track/:trackId
analyticsRoutes.get('/track/:trackId', requireAuth, requireAdmin, async (c) => {
  try {
    const trackId = c.req.param('trackId');
    const userId = c.get('userId');
    const track = await db.getTrack(userId, trackId);
    const analytics = await db.getTrackAnalytics(trackId);

    return c.json({
      success: true,
      data: analytics || {
        trackId,
        plays: track?.plays || 0,
        likes: track?.likes || 0,
        downloads: track?.downloads || 0,
        shares: 0,
        comments: 0,
        dailyStats: [],
      },
    });
  } catch (error) {
    return c.json({
      success: true,
      data: {
        trackId: c.req.param('trackId'),
        plays: 0, likes: 0, downloads: 0, shares: 0, comments: 0, dailyStats: [],
      },
    });
  }
});

// POST /analytics/track/:trackId/play — record play
analyticsRoutes.post('/track/:trackId/play', requireAuth, requireAdmin, async (c) => {
  try {
    const trackId = c.req.param('trackId');
    const userId = c.get('userId');

    // Increment plays on the track itself
    const track = await db.getTrack(userId, trackId);
    if (track) {
      track.plays = (track.plays || 0) + 1;
      track.updatedAt = new Date().toISOString();
      await db.upsertTrack(userId, trackId, track);
    }

    // Update analytics
    const analytics = await db.getTrackAnalytics(trackId) || {
      trackId, plays: 0, likes: 0, downloads: 0, shares: 0, comments: 0, dailyStats: [],
    };
    analytics.plays = (analytics.plays || 0) + 1;
    await db.upsertTrackAnalytics(trackId, analytics);

    return c.json({ success: true, data: analytics });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default analyticsRoutes;
