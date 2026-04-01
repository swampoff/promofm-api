import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';
import { getDbClient } from './db-client.tsx';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';

const newsRoutes = new Hono();

function mapArticle(r: any) {
  return {
    id: r.id,
    title: r.title || '',
    excerpt: r.summary || '',
    content: r.content || '',
    category: r.category || 'music',
    author: r.author_name || 'Редакция',
    cover_image: r.image_url || '',
    published_at: r.published_at || r.created_at,
    read_time: Math.max(1, Math.ceil((r.content || '').split(/\s+/).length / 200)),
    tags: r.tags || [],
    featured: (r.tags || []).includes('featured'),
    views: r.views_count || 0,
  };
}

// Public: return ALL published news
// Alias: /public → same as /
newsRoutes.get("/public", async (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace("/public", "");
  return c.redirect(url.pathname + url.search, 301);
});
newsRoutes.get('/', async (c) => {
  try {
    const category = c.req.query('category');
    let qb = getDbClient()
      .from('news')
      .select('*')
      .eq('status', 'published')
      .order('published_at', { ascending: false });
    if (category && category !== 'all') {
      qb = qb.eq('category', category);
    }
    const { data, error } = await qb;
    if (error) console.error('[news] list error:', error);
    return c.json((data || []).map(mapArticle));
  } catch (error) {
    console.error('[news] GET error:', error);
    return c.json([]);
  }
});

// Get single article by ID
newsRoutes.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { data, error } = await getDbClient()
      .from('news')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !data) {
      return c.json({ error: 'Article not found' }, 404);
    }
    // Increment views
    getDbClient()
      .from('news')
      .update({ views_count: (data.views_count || 0) + 1 })
      .eq('id', id)
      .then(() => {});
    return c.json(mapArticle(data));
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
