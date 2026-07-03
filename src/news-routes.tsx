import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
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
    audio_url: r.audioUrl || null,
    voice_duration: r.voiceDuration || 0,
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

// Own news of the authenticated artist (таблица news, не news_public).
// Регистрируется ДО '/:id' — Hono route ordering (см. память проекта).
// До 2026-07-02 такого роута не было: news-page.tsx жила целиком на
// localStorage и после подключения POST не могла бы перечитать своё.
newsRoutes.get('/mine', requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId') || '');
    const items = await db.getNewsByUser(userId);
    return c.json({ success: true, data: items });
  } catch (error) {
    console.error('[news] GET /mine error:', error);
    return c.json({ success: true, data: [] });
  }
});

// ── Артист-новости: модерация + публичная выборка (2026-07-02) ──
//
// Продуктовое решение: одобренная новость артиста выходит (а) в общую
// ленту news_public (копия через upsertNewsPublic, source='artist' —
// GET '/' подхватывает её без изменений) и (б) на публичную страницу
// артиста (GET /artist/:artistId ниже). Требует migration 126.

// Очередь модерации для админа (все статусы, фильтрует фронт).
newsRoutes.get('/admin/artist-queue', requireAuth, requireAdmin, async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit') || '500', 10) || 500, 1000);
    const { pool } = await import('./db-client.tsx');
    const { rows } = await pool.query(
      `SELECT n.id, n.author_id, n.title, n.content, n.summary, n.category,
              n.status, n.image_url, n.moderation_note, n.created_at,
              COALESCE(NULLIF(n.author_name, ''), NULLIF(u.full_name, ''), NULLIF(u.display_name, ''), 'Артист') AS artist_name
         FROM news n
         LEFT JOIN users u ON u.id::text = n.author_id
        ORDER BY n.created_at DESC
        LIMIT $1`,
      [limit]
    );
    return c.json({
      success: true,
      data: rows.map((r: any) => ({
        id: String(r.id),
        userId: r.author_id ? String(r.author_id) : '',
        title: r.title || 'Без названия',
        content: r.content || '',
        preview: r.summary || (r.content || '').slice(0, 100),
        coverImage: r.image_url || '',
        category: r.category || 'general',
        status: r.status || 'pending',
        moderationNote: r.moderation_note || '',
        createdAt: r.created_at,
        artist: r.artist_name,
      })),
    });
  } catch (error) {
    console.error('[news] admin/artist-queue error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// Решение админа. approved → копия в news_public (общая лента) +
// уведомление артисту; rejected → moderation_note + уведомление.
newsRoutes.post('/admin/:id/moderate', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const status = String(body.status || '');
    if (status !== 'approved' && status !== 'rejected') {
      return c.json({ success: false, error: "status must be 'approved' or 'rejected'" }, 400);
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
    if (status === 'rejected' && !note) {
      return c.json({ success: false, error: 'Причина отклонения обязательна' }, 400);
    }

    const { pool } = await import('./db-client.tsx');
    const { rows } = await pool.query(
      `UPDATE news
          SET status = $2,
              moderation_note = NULLIF($3, ''),
              moderated_at = NOW(),
              moderated_by = $4,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, author_id, title, content, summary, category, image_url, author_name`,
      [String(id), status, note, String(c.get('userEmail') || c.get('userId') || '')]
    );
    if (rows.length === 0) return c.json({ success: false, error: 'Article not found' }, 404);
    const article = rows[0];

    // Имя артиста для ленты/уведомления
    let artistName = article.author_name || '';
    if (!artistName && article.author_id) {
      const u = await pool.query(
        `SELECT COALESCE(NULLIF(full_name, ''), NULLIF(display_name, ''), '') AS name
           FROM users WHERE id::text = $1 LIMIT 1`,
        [String(article.author_id)]
      );
      artistName = u.rows[0]?.name || '';
    }

    if (status === 'approved') {
      // В общую ленту — тем же механизмом, что и агентские новости.
      const { upsertNewsPublic } = await import('./db.tsx');
      await upsertNewsPublic({
        id: String(article.id),
        title: article.title || 'Без названия',
        excerpt: article.summary || (article.content || '').slice(0, 200),
        content: article.content || '',
        category: article.category || 'music',
        tags: [],
        source: 'artist',
        imageUrl: article.image_url || null,
        authorName: artistName || 'Артист',
        publishedAt: new Date().toISOString(),
        processedAt: new Date().toISOString(),
        status: 'published',
      } as any);
    }

    if (article.author_id) {
      try {
        const { upsertNotification } = await import('./db.tsx');
        const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await upsertNotification(String(article.author_id), notifId, {
          type: status === 'approved' ? 'news_approved' : 'news_rejected',
          title: status === 'approved' ? '✅ Новость опубликована!' : '❌ Новость отклонена',
          message: status === 'approved'
            ? `Ваша новость «${article.title}» прошла модерацию: она в общей ленте и на вашей странице.`
            : `Ваша новость «${article.title}» не прошла модерацию. Причина: ${note}`,
          metadata: { news_id: String(article.id) },
          created_at: new Date().toISOString(),
          read: false,
        });
        const { emitSSE } = await import('./sse-routes.tsx');
        emitSSE(String(article.author_id), {
          type: 'notification',
          data: {
            title: status === 'approved' ? 'Новость опубликована' : 'Новость отклонена',
            comment: `«${article.title}»${status === 'rejected' ? ` — ${note}` : ''}`,
          },
        });
      } catch (notifyErr) {
        console.error('[news] moderate notify failed:', notifyErr);
      }
    }

    return c.json({ success: true, id: String(article.id), status });
  } catch (error) {
    console.error('[news] moderate error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// Публичная выборка одобренных новостей артиста для его страницы.
// :artistId принимает и users.id, и artist_profiles.id (страница
// оперирует artistId, чей смысл исторически плавает).
newsRoutes.get('/artist/:artistId', async (c) => {
  try {
    const artistId = c.req.param('artistId');
    const { pool } = await import('./db-client.tsx');
    const { rows } = await pool.query(
      `SELECT n.id, n.title, n.summary, n.content, n.category, n.image_url, n.created_at
         FROM news n
        WHERE n.status = 'approved'
          AND (n.author_id = $1
               OR n.author_id = (SELECT ap.user_id FROM artist_profiles ap WHERE ap.id::text = $1 LIMIT 1))
        ORDER BY n.created_at DESC
        LIMIT 20`,
      [String(artistId)]
    );
    return c.json({
      success: true,
      data: rows.map((r: any) => ({
        id: String(r.id),
        title: r.title || '',
        excerpt: r.summary || (r.content || '').slice(0, 160),
        coverImage: r.image_url || '',
        publishedAt: r.created_at,
      })),
    });
  } catch (error) {
    console.error('[news] GET /artist error:', error);
    return c.json({ success: true, data: [] });
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
    const userId = String(c.get('userId') || '');
    const body = await c.req.json();
    const newsId = body.id || `news-${crypto.randomUUID()}`;

    // Owner-guard на upsert: без него артист A мог бы POST'нуть id чужой
    // новости и перезаписать её (upsertNews апсертит по id вслепую).
    if (body.id) {
      const { data: existing } = await getDbClient()
        .from('news')
        .select('author_id')
        .eq('id', String(body.id))
        .maybeSingle();
      if (existing && String(existing.author_id) !== userId) {
        return c.json({ success: false, error: 'Not your article' }, 403);
      }
    }

    await db.upsertNews(userId, newsId, {
      ...body,
      status: body.status || 'draft',
    });
    return c.json({ success: true, id: newsId }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// Delete own article. news.id и news.author_id — text, кастов не нужно.
newsRoutes.delete('/:id', requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId') || '');
    const id = c.req.param('id');
    const { pool } = await import('./db-client.tsx');
    const r = await pool.query(
      `DELETE FROM news WHERE id = $1 AND author_id = $2`,
      [String(id), userId]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Article not found' }, 404);
    }
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default newsRoutes;
