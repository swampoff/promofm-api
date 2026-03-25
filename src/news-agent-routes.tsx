/**
 * NEWS AGENT ROUTES — HTTP endpoints для управления агентом новостей
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { newsPublicStore } from './db.tsx';
import { fetchAllNews, fetchNewsFromSource, NEWS_SOURCES } from './news-agent.tsx';
import { safeErrorMessage } from './security.tsx';

const newsAgent = new Hono();

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

/** Admin auth: either JWT admin or X-Internal-Key header */
async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) {
    return next();
  }
  return requireAuth(c, () => requireAdmin(c, next));
}

/**
 * POST /fetch — запустить сбор новостей из всех источников
 */
newsAgent.post('/fetch', requireAdminOrKey, async (c) => {
  try {
    console.log('[news-agent] Starting full news fetch...');
    const result = await fetchAllNews();
    return c.json({
      success: true,
      totalAdded: result.totalAdded,
      results: result.results,
    });
  } catch (error) {
    console.error('[news-agent] Fetch error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /fetch/:sourceId — запустить сбор из конкретного источника
 */
newsAgent.post('/fetch/:sourceId', requireAdminOrKey, async (c) => {
  try {
    const sourceId = c.req.param('sourceId');
    const source = NEWS_SOURCES.find(s => s.id === sourceId);
    if (!source) {
      return c.json({ success: false, error: `Unknown source: ${sourceId}` }, 404);
    }

    console.log(`[news-agent] Fetching from ${source.name}...`);
    const result = await fetchNewsFromSource(source);
    return c.json({ success: true, sourceId, ...result });
  } catch (error) {
    console.error('[news-agent] Fetch error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /sources — список источников
 */
newsAgent.get('/sources', async (c) => {
  return c.json({
    success: true,
    data: NEWS_SOURCES.map(s => ({
      id: s.id,
      name: s.name,
      url: s.url,
      category: s.category,
    })),
  });
});

/**
 * GET /status — статистика агента
 */
newsAgent.get('/status', async (c) => {
  try {
    const allNews = await newsPublicStore.getAll();
    const published = allNews.filter((n: any) => n.status === 'published');

    // Count by source
    const bySource: Record<string, number> = {};
    for (const n of published) {
      const src = (n as any).sourceId || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
    }

    // Latest news date
    const latest = published
      .map((n: any) => n.publishedAt || n.createdAt)
      .filter(Boolean)
      .sort()
      .reverse()[0] || null;

    return c.json({
      success: true,
      data: {
        totalNews: allNews.length,
        published: published.length,
        bySource,
        latestNewsDate: latest,
        sourcesCount: NEWS_SOURCES.length,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * DELETE /clear — очистить все новости (admin only)
 */
newsAgent.delete('/clear', requireAdminOrKey, async (c) => {
  try {
    const allNews = await newsPublicStore.getAll();
    let deleted = 0;
    for (const n of allNews) {
      if ((n as any).id) {
        await newsPublicStore.del((n as any).id);
        deleted++;
      }
    }
    return c.json({ success: true, deleted });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default newsAgent;
