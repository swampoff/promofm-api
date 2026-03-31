/**
 * NEWS PIPELINE (AI Agent) - Сбор, обработка и модерация новостей
 *
 * Endpoints:
 * GET  /sources       - список источников новостей
 * GET  /stats         - статистика pipeline
 * GET  /pending       - статьи на модерации
 * GET  /published     - опубликованные статьи
 * GET  /rejected      - отклонённые статьи
 * POST /collect       - запуск сбора новостей (опционально sourceId)
 * POST /:id/approve   - одобрить статью
 * POST /:id/reject    - отклонить статью
 * DELETE /:id         - удалить статью
 * POST /approve-all   - одобрить все pending
 */

import { Hono } from 'hono';
import { newsPipelineStore } from './db.tsx';
import { quickLLM } from './llm-router.tsx';
import { safeErrorMessage } from './security.tsx';

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) {
    return next();
  }
  // Fall back to requireAuth + requireAdmin
  const { requireAuth, requireAdmin } = await import('./auth-middleware.tsx');
  return requireAuth(c, () => requireAdmin(c, next));
}


// ── Helpers ──

async function callClaude(prompt: string, systemPrompt: string, maxTokens = 2000): Promise<string | null> {
  try {
    return await quickLLM(systemPrompt, prompt, { maxTokens, tag: 'news-pipeline' });
  } catch (error) {
    console.log(`[News Pipeline] LLM call failed: ${error}`);
    return null;
  }
}

// ── Default sources ──

const DEFAULT_SOURCES = [
  { id: 'src-1', name: 'Звук Медиа', url: 'https://zvuk.com/news', type: 'html', category: 'Индустрия', enabled: true },
  { id: 'src-2', name: 'The Flow', url: 'https://the-flow.ru', type: 'html', category: 'Хип-хоп', enabled: true },
  { id: 'src-3', name: 'Sadwave', url: 'https://sadwave.com', type: 'html', category: 'Инди', enabled: true },
  { id: 'src-4', name: 'Музыкальный Олимп', url: 'https://music-olymp.ru', type: 'rss', category: 'Классика', enabled: false },
  { id: 'src-5', name: 'Рэп.ру', url: 'https://rap.ru', type: 'html', category: 'Рэп', enabled: true },
  { id: 'src-6', name: 'Billboard Russia', url: 'https://billboard.ru', type: 'html', category: 'Чарты', enabled: true },
];

async function ensureSources() {
  const existing = await newsPipelineStore.get('news:sources');
  if (!existing) {
    const sources = DEFAULT_SOURCES.map(s => ({
      ...s,
      status: {
        sourceId: s.id,
        sourceName: s.name,
        lastFetchAt: null,
        lastFetchStatus: 'never' as const,
        articlesCollected: 0,
      },
    }));
    await newsPipelineStore.set('news:sources', sources);
    return sources;
  }
  return existing as any[];
}

async function getStats() {
  const pending = (await newsPipelineStore.get('news:articles:pending') || []) as any[];
  const published = (await newsPipelineStore.get('news:articles:published') || []) as any[];
  const rejected = (await newsPipelineStore.get('news:articles:rejected') || []) as any[];
  const sources = await ensureSources();
  const lastRun = await newsPipelineStore.get('news:last_run') as string | null;

  return {
    totalCollected: pending.length + published.length + rejected.length,
    totalPending: pending.length,
    totalPublished: published.length,
    totalRejected: rejected.length,
    lastRunAt: lastRun,
    sourcesActive: sources.filter((s: any) => s.enabled).length,
  };
}

// ── News collection (real pipeline only) ──

async function collectNews(sourceId?: string) {
  const sources = await ensureSources();
  const targetSources = sourceId
    ? sources.filter((s: any) => s.id === sourceId && s.enabled)
    : sources.filter((s: any) => s.enabled);

  if (targetSources.length === 0) {
    return { collected: 0, message: 'Нет активных источников' };
  }

  // Real news collection happens via news-cron.sh + OpenRouter AI pipeline
  // This endpoint only updates source fetch timestamps
    // Update source statuses
  for (const src of targetSources) {
    src.status.lastFetchAt = new Date().toISOString();
    src.status.lastFetchStatus = 'success';
    src.status.articlesCollected += newArticles.filter((a: any) => a.source === src.name).length;
  }
  await newsPipelineStore.set('news:sources', sources);

  // Add to pending
  const updated = [...newArticles, ...pending];
  await newsPipelineStore.set('news:articles:pending', updated);
  await newsPipelineStore.set('news:last_run', new Date().toISOString());

  return { collected: newArticles.length, articles: newArticles };
}

// ── Routes ──

const app = new Hono();

// GET /sources
app.get('/sources', requireAdminOrKey, async (c) => {
  try {
    const sources = await ensureSources();
    return c.json({ success: true, data: sources });
  } catch (error) {
    console.log('[News Pipeline] /sources error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /stats
app.get('/stats', requireAdminOrKey, async (c) => {
  try {
    const stats = await getStats();
    return c.json({ success: true, data: stats });
  } catch (error) {
    console.log('[News Pipeline] /stats error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /pending
app.get('/pending', requireAdminOrKey, async (c) => {
  try {
    const articles = (await newsPipelineStore.get('news:articles:pending') || []) as any[];
    return c.json({ success: true, data: articles });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /published
app.get('/published', requireAdminOrKey, async (c) => {
  try {
    const limit = Number(c.req.query('limit') || 50);
    const articles = (await newsPipelineStore.get('news:articles:published') || []) as any[];
    return c.json({ success: true, data: articles.slice(0, limit) });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /rejected
app.get('/rejected', requireAdminOrKey, async (c) => {
  try {
    const articles = (await newsPipelineStore.get('news:articles:rejected') || []) as any[];
    return c.json({ success: true, data: articles });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /collect
app.post('/collect', requireAdminOrKey, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await collectNews(body.sourceId);
    return c.json({ success: true, data: { ...result, message: `Собрано ${result.collected} новостей` } });
  } catch (error) {
    console.log('[News Pipeline] /collect error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /:id/approve
app.post('/:id/approve', requireAdminOrKey, async (c) => {
  try {
    const id = c.req.param('id');
    const pending = (await newsPipelineStore.get('news:articles:pending') || []) as any[];
    const article = pending.find((a: any) => a.id === id);
    if (!article) {
      return c.json({ success: false, error: 'Статья не найдена' }, 404);
    }

    // Move to published
    article.status = 'published';
    article.publishedAt = new Date().toISOString();
    const published = (await newsPipelineStore.get('news:articles:published') || []) as any[];
    await newsPipelineStore.set('news:articles:published', [article, ...published]);
    await newsPipelineStore.set('news:articles:pending', pending.filter((a: any) => a.id !== id));

    return c.json({ success: true, data: article });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /:id/reject
app.post('/:id/reject', requireAdminOrKey, async (c) => {
  try {
    const id = c.req.param('id');
    const pending = (await newsPipelineStore.get('news:articles:pending') || []) as any[];
    const article = pending.find((a: any) => a.id === id);
    if (!article) {
      return c.json({ success: false, error: 'Статья не найдена' }, 404);
    }

    // Move to rejected
    article.status = 'rejected';
    article.rejectedAt = new Date().toISOString();
    const rejected = (await newsPipelineStore.get('news:articles:rejected') || []) as any[];
    await newsPipelineStore.set('news:articles:rejected', [article, ...rejected]);
    await newsPipelineStore.set('news:articles:pending', pending.filter((a: any) => a.id !== id));

    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /:id
app.delete('/:id', requireAdminOrKey, async (c) => {
  try {
    const id = c.req.param('id');

    // Try removing from all lists
    for (const listKey of ['news:articles:pending', 'news:articles:published', 'news:articles:rejected']) {
      const list = (await newsPipelineStore.get(listKey) || []) as any[];
      const filtered = list.filter((a: any) => a.id !== id);
      if (filtered.length !== list.length) {
        await newsPipelineStore.set(listKey, filtered);
        return c.json({ success: true });
      }
    }

    return c.json({ success: false, error: 'Статья не найдена' }, 404);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /approve-all
app.post('/approve-all', requireAdminOrKey, async (c) => {
  try {
    const pending = (await newsPipelineStore.get('news:articles:pending') || []) as any[];
    if (pending.length === 0) {
      return c.json({ success: true, data: { approved: 0 } });
    }

    const now = new Date().toISOString();
    const approved = pending.map((a: any) => ({
      ...a,
      status: 'published',
      publishedAt: now,
    }));

    const published = (await newsPipelineStore.get('news:articles:published') || []) as any[];
    await newsPipelineStore.set('news:articles:published', [...approved, ...published]);
    await newsPipelineStore.set('news:articles:pending', []);

    return c.json({ success: true, data: { approved: approved.length } });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
