/**
 * NEWS AGENT ROUTES — HTTP endpoints для управления агентом новостей
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { listAllNewsPublic, deleteNewsPublic } from './db.tsx';
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
  return requireAuth(c, async () => { await requireAdmin(c, next); });
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

    // Accept host override from cron (single DJ per shift)
    const body = await c.req.json().catch(() => ({}));
    const hostName = body?.host;
    let overridePoster: any = undefined;
    if (hostName) {
      const POSTERS_MAP: Record<string, { name: string; avatar: string }> = {
        'DJ Den': { name: 'DJ Den', avatar: '/avatars/avatar_dj_den.png' },
        'Сандра': { name: 'Сандра', avatar: '/avatars/avatar_sandra.png' },
        'Лиана': { name: 'Лиана', avatar: '/avatars/avatar_liana.png' },
        'Макс': { name: 'Макс', avatar: '/avatars/avatar_max.png' },
        'Марк': { name: 'Марк', avatar: '/avatars/avatar_mark.png' },
        'Пабло': { name: 'Пабло', avatar: '/avatars/avatar_pablo.png' },
        'Нико': { name: 'Нико', avatar: '/avatars/avatar_nico.png' },
        'РэдКэт': { name: 'РэдКэт', avatar: '/avatars/avatar_radkat.png' },
        'Стелла': { name: 'Стелла', avatar: '/avatars/avatar_stella.png' },
      };
      overridePoster = POSTERS_MAP[hostName];
    }

    console.log(`[news-agent] Fetching from ${source.name}${hostName ? ` (host: ${hostName})` : ''}...`);
    const result = await fetchNewsFromSource(source, overridePoster);
    return c.json({ success: true, sourceId, ...result });
  } catch (error) {
    console.error('[news-agent] Fetch error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /sources — список источников
 */
newsAgent.get('/sources', requireAdminOrKey, async (c) => {
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
newsAgent.get('/status', requireAdminOrKey, async (c) => {
  try {
    const allNews = await listAllNewsPublic();
    const published = allNews.filter(n => n.status === 'published');

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
    const allNews = await listAllNewsPublic();
    let deleted = 0;
    for (const n of allNews) {
      if (n.id) {
        await deleteNewsPublic(n.id);
        deleted++;
      }
    }
    return c.json({ success: true, deleted });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /generate-article — одна АВТОРСКАЯ статья (article-agent.tsx):
 * ротация 7 аудиторий по дню, внутри — первая неиспользованная тема.
 * Body (опц.): { audience, topicSlug } — ручной запуск конкретной темы.
 * Cron VPS (раз в день):
 *   0 9 * * * curl -s -X POST -H "X-Internal-Key: $VPS_INTERNAL_KEY" http://127.0.0.1:3000/server/api/news-agent/generate-article
 * Advisory-lock 924180 — двойной тик публикует одну статью, не две.
 */
newsAgent.post('/generate-article', requireAdminOrKey, async (c) => {
  const { pool } = await import('./db-client.tsx');
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const lk = await lockClient.query('SELECT pg_try_advisory_lock(924180) AS got');
    locked = !!lk.rows[0]?.got;
    if (!locked) return c.json({ success: true, skipped: 'locked' });

    const body = await c.req.json().catch(() => ({}));
    const { generateDailyArticle } = await import('./article-agent.tsx');
    const r = await generateDailyArticle(body?.audience, body?.topicSlug);
    return c.json({ success: r.ok, ...r });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock(924180)').catch(() => {});
    lockClient.release();
  }
});

/** GET /article-topics — остаток банка тем по аудиториям. */
newsAgent.get('/article-topics', requireAdminOrKey, async (c) => {
  try {
    const { articleTopicsStatus } = await import('./article-agent.tsx');
    return c.json({ success: true, audiences: await articleTopicsStatus() });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default newsAgent;
