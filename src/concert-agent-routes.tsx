/**
 * CONCERT AGENT ROUTES — HTTP endpoints для агента концертов
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { concertAgentStore } from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import {
  fetchAllConcerts,
  fetchConcertsFromSource,
  getPublishedConcerts,
  clearOldConcerts,
  CONCERT_SOURCES,
} from './concert-agent.tsx';

const concertAgent = new Hono();

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
 * POST /fetch — запустить сбор концертов из всех источников
 */
concertAgent.post('/fetch', requireAdminOrKey, async (c) => {
  try {
    console.log('[concert-agent] Starting full concert fetch...');
    const result = await fetchAllConcerts();
    return c.json({
      success: true,
      totalAdded: result.totalAdded,
      results: result.results,
    });
  } catch (error) {
    console.error('[concert-agent] Fetch error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /fetch/:sourceId — сбор из конкретного источника
 */
concertAgent.post('/fetch/:sourceId', requireAdminOrKey, async (c) => {
  try {
    const sourceId = c.req.param('sourceId');
    const source = CONCERT_SOURCES.find(s => s.id === sourceId);
    if (!source) {
      return c.json({ success: false, error: `Unknown source: ${sourceId}` }, 404);
    }

    console.log(`[concert-agent] Fetching from ${source.name}...`);
    const result = await fetchConcertsFromSource(sourceId);
    return c.json({ success: true, sourceId, ...result });
  } catch (error) {
    console.error('[concert-agent] Fetch error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /concerts — публичный список концертов
 */
concertAgent.get('/concerts', requireAdminOrKey, async (c) => {
  try {
    const city = c.req.query('city');
    const limit = parseInt(c.req.query('limit') || '50');
    const concerts = await getPublishedConcerts(city);
    return c.json({
      success: true,
      data: concerts.slice(0, limit),
      total: concerts.length,
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /sources — список источников
 */
concertAgent.get('/sources', requireAdminOrKey, async (c) => {
  return c.json({
    success: true,
    data: CONCERT_SOURCES.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      logo: s.logo,
      urls: s.urls,
    })),
  });
});

/**
 * GET /status — статистика агента
 */
concertAgent.get('/status', requireAdminOrKey, async (c) => {
  try {
    const all = await concertAgentStore.getAll();
    const published = all.filter((c: any) => c.status === 'published');
    const today = new Date().toISOString().split('T')[0];
    const upcoming = published.filter((c: any) => !c.date || c.date >= today);

    // Count by source
    const bySource: Record<string, number> = {};
    for (const concert of published) {
      const src = (concert as any).sourceId || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
    }

    // Count by city
    const byCity: Record<string, number> = {};
    for (const concert of upcoming) {
      const city = (concert as any).city || 'unknown';
      byCity[city] = (byCity[city] || 0) + 1;
    }

    return c.json({
      success: true,
      data: {
        totalConcerts: all.length,
        published: published.length,
        upcoming: upcoming.length,
        bySource,
        byCity,
        sourcesCount: CONCERT_SOURCES.length,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /cleanup — удалить прошедшие концерты (admin)
 */
concertAgent.post('/cleanup', requireAdminOrKey, async (c) => {
  try {
    const deleted = await clearOldConcerts();
    return c.json({ success: true, deleted });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * DELETE /clear — очистить все концерты (admin)
 */
concertAgent.delete('/clear', requireAdminOrKey, async (c) => {
  try {
    const all = await concertAgentStore.getAll();
    let deleted = 0;
    for (const concert of all) {
      if ((concert as any).id) {
        await concertAgentStore.del((concert as any).id);
        deleted++;
      }
    }
    return c.json({ success: true, deleted });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default concertAgent;
