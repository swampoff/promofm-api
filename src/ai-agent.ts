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

// ── Simulated news collection ──

const SIMULATED_ARTICLES = [
  {
    title: 'Стриминговые платформы увеличили выплаты артистам на 15%',
    tag: 'Индустрия',
    excerpt: 'Крупнейшие музыкальные сервисы объявили о пересмотре модели роялти в пользу независимых артистов.',
    content: 'Крупнейшие музыкальные стриминговые сервисы объявили о совместном решении увеличить выплаты артистам на 15% начиная с нового квартала. Изменения коснутся прежде всего независимых музыкантов, чьи доходы от стриминга значительно возрастут.',
    source: 'Звук Медиа',
  },
  {
    title: 'Новый тренд: нейросети помогают в создании аранжировок',
    tag: 'Технологии',
    excerpt: 'Продюсеры всё чаще используют нейросетевые инструменты для ускорения работы над аранжировками.',
    content: 'По данным опроса среди 500 продюсеров, более 40% регулярно используют инструменты на базе нейросетей для создания демо-аранжировок. При этом финальную обработку по-прежнему выполняют вручную.',
    source: 'The Flow',
  },
  {
    title: 'Фестиваль «Дикая Мята» объявил первых хедлайнеров',
    tag: 'События',
    excerpt: 'Организаторы раскрыли имена первых артистов, которые выступят на главной сцене фестиваля.',
    content: 'Фестиваль «Дикая Мята» представил первую волну хедлайнеров. В числе подтверждённых артистов - несколько резидентов платформы ПРОМО.МУЗЫКА, что подтверждает эффективность продвижения через экосистему.',
    source: 'Sadwave',
  },
  {
    title: 'Рынок виниловых пластинок в России вырос на 30%',
    tag: 'Индустрия',
    excerpt: 'Аналитики фиксируют рекордный рост продаж винила среди молодой аудитории.',
    content: 'По итогам года продажи виниловых пластинок в России выросли на 30%. Основную долю покупателей составляет аудитория 18-35 лет, что свидетельствует о ретро-тренде в потреблении музыки.',
    source: 'Billboard Russia',
  },
  {
    title: 'Продюсерские лейблы переходят на модель ревеню-шеринга',
    tag: 'Бизнес',
    excerpt: 'Всё больше лейблов предлагают артистам партнёрство вместо традиционных контрактов.',
    content: 'Тренд на справедливое распределение доходов набирает обороты. Продюсерские лейблы предлагают модель 50/50 или даже 70/30 в пользу артиста, что привлекает талантливых исполнителей.',
    source: 'Рэп.ру',
  },
];

async function collectNews(sourceId?: string) {
  const sources = await ensureSources();
  const pending = (await newsPipelineStore.get('news:articles:pending') || []) as any[];

  const targetSources = sourceId
    ? sources.filter((s: any) => s.id === sourceId && s.enabled)
    : sources.filter((s: any) => s.enabled);

  if (targetSources.length === 0) {
    return { collected: 0, message: 'Нет активных источников' };
  }

  // Simulate collecting 1-3 articles
  const count = Math.min(Math.floor(Math.random() * 3) + 1, SIMULATED_ARTICLES.length);
  const shuffled = [...SIMULATED_ARTICLES].sort(() => Math.random() - 0.5);
  const newArticles = shuffled.slice(0, count).map((a, i) => ({
    id: `art_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    ...a,
    coverImage: `https://picsum.photos/seed/${Date.now() + i}/800/400`,
    processedAt: new Date().toISOString(),
    status: 'pending',
  }));

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
app.get('/sources', async (c) => {
  try {
    const sources = await ensureSources();
    return c.json({ success: true, sources });
  } catch (error) {
    console.log('[News Pipeline] /sources error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /stats
app.get('/stats', async (c) => {
  try {
    const stats = await getStats();
    return c.json({ success: true, stats });
  } catch (error) {
    console.log('[News Pipeline] /stats error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /pending
app.get('/pending', async (c) => {
  try {
    const articles = (await newsPipelineStore.get('news:articles:pending') || []) as any[];
    return c.json({ success: true, articles });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /published
app.get('/published', async (c) => {
  try {
    const limit = Number(c.req.query('limit') || 50);
    const articles = (await newsPipelineStore.get('news:articles:published') || []) as any[];
    return c.json({ success: true, articles: articles.slice(0, limit) });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /rejected
app.get('/rejected', async (c) => {
  try {
    const articles = (await newsPipelineStore.get('news:articles:rejected') || []) as any[];
    return c.json({ success: true, articles });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /collect
app.post('/collect', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await collectNews(body.sourceId);
    return c.json({ success: true, ...result });
  } catch (error) {
    console.log('[News Pipeline] /collect error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /:id/approve
app.post('/:id/approve', async (c) => {
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

    return c.json({ success: true, article });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /:id/reject
app.post('/:id/reject', async (c) => {
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
app.delete('/:id', async (c) => {
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
app.post('/approve-all', async (c) => {
  try {
    const pending = (await newsPipelineStore.get('news:articles:pending') || []) as any[];
    if (pending.length === 0) {
      return c.json({ success: true, approved: 0 });
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

    return c.json({ success: true, approved: approved.length });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
