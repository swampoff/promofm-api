/**
 * RELEASE AGENT ROUTES — HTTP endpoints для управления агентом релизов
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import * as typed from './db-typed.tsx';
import { fetchAllReleases, fetchReleasesFromSource, RELEASE_SOURCES } from './release-agent.tsx';

const releaseAgent = new Hono();

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) {
    return next();
  }
  return requireAuth(c, () => requireAdmin(c, next));
}

releaseAgent.post('/fetch', requireAdminOrKey, async (c) => {
  try {
    console.log('[release-agent] Starting full release fetch...');
    const result = await fetchAllReleases();
    return c.json({
      success: true,
      totalAdded: result.totalAdded,
      archived: result.archived,
      results: result.results,
    });
  } catch (error) {
    console.error('[release-agent] Fetch error:', error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

releaseAgent.post('/fetch/:sourceId', requireAdminOrKey, async (c) => {
  try {
    const sourceId = c.req.param('sourceId');
    const source = RELEASE_SOURCES.find(s => s.id === sourceId);
    if (!source) {
      return c.json({ success: false, error: `Unknown source: ${sourceId}` }, 404);
    }
    console.log(`[release-agent] Fetching from ${source.name}...`);
    const result = await fetchReleasesFromSource(source);
    return c.json({ success: true, sourceId, ...result });
  } catch (error) {
    console.error('[release-agent] Fetch error:', error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

releaseAgent.get('/sources', async (c) => {
  return c.json({
    success: true,
    data: RELEASE_SOURCES.map(s => ({ id: s.id, name: s.name, url: s.url })),
  });
});

releaseAgent.get('/status', async (c) => {
  try {
    const all = await typed.getAllUpcomingReleases();
    const today = new Date().toISOString().split('T')[0];
    const upcoming = all.filter((r: any) => r.release_date >= today);
    const bySource: Record<string, number> = {};
    for (const r of upcoming) {
      const src = (r as any).source || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
    }
    return c.json({
      success: true,
      data: {
        totalReleases: all.length,
        upcoming: upcoming.length,
        bySource,
        nextRelease: upcoming[0] ? {
          artist: (upcoming[0] as any).artist_name,
          title: (upcoming[0] as any).title,
          date: (upcoming[0] as any).release_date,
        } : null,
        sourcesCount: RELEASE_SOURCES.length,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

releaseAgent.post('/archive', requireAdminOrKey, async (c) => {
  try {
    const archived = await typed.archivePastReleases();
    return c.json({ success: true, archived: archived.length });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default releaseAgent;
