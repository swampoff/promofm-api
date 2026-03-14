import { Hono } from 'hono';
import * as db from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';

const videosRoutes = new Hono();
const FALLBACK_USER = 'anonymous';

videosRoutes.get('/', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const videos = await db.getVideosByUser(userId);
    return c.json({ success: true, data: videos || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

videosRoutes.post('/', async (c) => {
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
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default videosRoutes;
