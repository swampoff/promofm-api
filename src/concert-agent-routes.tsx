/**
 * CONCERT AGENT ROUTES — HTTP endpoints для агента концертов
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { getConcertAgentStats, listConcertAgentItems, deleteConcertAgentItem } from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import {
  fetchAllConcerts,
  fetchAllConcertsExtended,
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
  return requireAuth(c, async () => { await requireAdmin(c, next); });
}

/**
 * POST /fetch — запустить сбор концертов из всех источников
 */
concertAgent.post('/fetch', requireAdminOrKey, async (c) => {
  try {
    console.log('[concert-agent] Starting full concert fetch...');
    const result = await fetchAllConcertsExtended();
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
    // SQL aggregation (COUNT FILTER + GROUP BY) — single round-trip
    // вместо getAll() + JS filter+group.
    const stats = await getConcertAgentStats();
    return c.json({
      success: true,
      data: {
        totalConcerts: stats.total,
        published: stats.published,
        upcoming: stats.upcoming,
        bySource: stats.bySource,
        byCity: stats.byCity,
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
    // Single SQL DELETE — раньше getAll + N per-id del.
    const { pool } = await import('./db-client.tsx');
    const r = await pool.query(`DELETE FROM concert_agent_data`);
    return c.json({ success: true, deleted: r.rowCount || 0 });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default concertAgent;
