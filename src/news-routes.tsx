import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';
import { getDbClient } from './db-client.tsx';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';

const newsRoutes = new Hono();

// Map news_public JSONB data → frontend article format
function mapArticle(row: any) {
  // news_public stores everything in `data` JSONB column
  const r = row.data ?? row;
  return {
    id: r.id || row.id,
    title: r.title || '',
    excerpt: r.excerpt || r.summary || '',
    content: r.content || '',
    category: r.category || 'music',
    author: r.authorName || r.author_name || 'Редакция',
    author_avatar: r.authorAvatar || '',
    source: r.source || '',
    cover_image: r.imageUrl || r.image_url || '',
    published_at: r.publishedAt || r.published_at || r.createdAt || row.created_at,
    read_time: Math.max(1, Math.ceil((r.content || '').split(/\s+/).length / 200)),
    tags: r.tags || [],
    featured: (r.tags || []).includes('featured'),
    views: r.views_count || r.viewsCount || 0,
  };
}

// Public: return ALL published news from news_public
newsRoutes.get("/public", async (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace("/public", "");
  return c.redirect(url.pathname + url.search, 301);
});

newsRoutes.get('/', async (c) => {
  try {
    const category = c.req.query('category');
    const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);
    const offset = parseInt(c.req.query('offset') || '0');

    let qb = getDbClient()
      .from('news_public')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error } = await qb;
    if (error) console.error('[news] list error:', error);

    let articles = (data || []).map(mapArticle);

    // Filter by category client-side (JSONB column)
    if (category && category !== 'all') {
      articles = articles.filter(a => a.category === category);
    }

    return c.json(articles);
  } catch (error) {
    console.error('[news] GET error:', error);
    return c.json([]);
  }
});

// Get single article by ID
newsRoutes.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');

    // Try news_public first (main source — 567+ articles)
    const { data: pubData } = await getDbClient()
      .from('news_public')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (pubData) {
      return c.json(mapArticle(pubData));
    }

    // Fallback: try old news table (16 legacy articles)
    const { data: legacyData } = await getDbClient()
      .from('news')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (legacyData) {
      return c.json(mapArticle(legacyData));
    }

    return c.json({ error: 'Article not found' }, 404);
  } catch (error) {
    return c.json({ error: 'Not found' }, 404);
  }
});

// Create/update article (authenticated)
newsRoutes.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const newsId = body.id || `news-${crypto.randomUUID()}`;
    await db.upsertNews(userId, newsId, {
      ...body,
      status: body.status || 'draft',
    });
    return c.json({ success: true, id: newsId }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default newsRoutes;
