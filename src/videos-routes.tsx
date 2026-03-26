import { Hono } from 'hono';
import * as db from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';

const videosRoutes = new Hono();
const FALLBACK_USER = 'anonymous';

// ─── Public: New Clips for landing page ─────────────────
videosRoutes.get('/newClips', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const { platformStatsStore } = await import('./db.tsx');
    const cached: any = await platformStatsStore.get('videos:new_clips');
    if (cached?.clips?.length) {
      return c.json({ success: true, clips: cached.clips.slice(0, limit) });
    }
    return c.json({ success: true, clips: [] });
  } catch (error) {
    console.error('Error fetching new clips:', error);
    return c.json({ success: true, clips: [] });
  }
});

videosRoutes.get('/', requireAuth, async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const videos = await db.getVideosByUser(userId);
    return c.json({ success: true, data: videos || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

videosRoutes.post('/', requireAuth, async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const body = await c.req.json();
    const videoId = body.id || `video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const video = {
      id: videoId, views: 0, likes: 0,
      ...body, userId,
      createdAt: body.createdAt || now, updatedAt: now,
    };
    await db.upsertVideo(userId, videoId, video);
    return c.json({ success: true, data: video }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default videosRoutes;
