import { Hono } from 'hono';
import * as db from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';

const newsRoutes = new Hono();
const FALLBACK_USER = 'anonymous';

newsRoutes.get('/', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const news = await db.getNewsByUser(userId);
    return c.json({ success: true, data: news || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

newsRoutes.post('/', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const body = await c.req.json();
    const newsId = body.id || `news-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const item = {
      id: newsId, likes: 0, comments: 0,
      ...body, userId,
      createdAt: body.createdAt || now, updatedAt: now,
    };
    await db.upsertNews(userId, newsId, item);
    return c.json({ success: true, data: item }, 201);
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default newsRoutes;
