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

// ── Admin-модерация пользовательских новостей (таблица news) ──
//
// Раньше админ-таб «Новости» вообще не имел бэкенда: approve/reject были
// локальным setState + фейковыми тостами («автор получит уведомление» —
// никто ничего не получал), а список грузился из news_public (уже
// ОПУБЛИКОВАННЫЕ статьи) со status по умолчанию 'pending'.
//
// Реальный контур: пользователь создаёт новость POST /news → таблица news
// (status='draft'/'pending'); админ видит их здесь; approve → status='approved'
// + публикация в news_public (лента лендинга) + уведомление автору;
// reject → status='rejected' + уведомление с причиной.

newsRoutes.get('/admin/list', requireAuth, requireAdmin, async (c) => {
  try {
    const { pool } = await import('./db-client.tsx');
    // image_url — migration 130; обложка нужна админ-карточкам и уходит
    // в news_public при approve (иначе лента без картинок).
    const r = await pool.query(
      `SELECT id, author_id, title, content, summary, category, status,
              author_name, image_url, created_at, updated_at
         FROM news
        ORDER BY created_at DESC
        LIMIT 500`
    );
    return c.json({
      success: true,
      data: r.rows.map((n: any) => ({
        id: n.id,
        title: n.title,
        content: n.content,
        preview: n.summary || (n.content || '').slice(0, 100),
        coverImage: n.image_url || '',
        category: n.category || 'general',
        status: n.status === 'draft' ? 'pending' : (n.status || 'pending'),
        author: n.author_name || '',
        authorId: n.author_id,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
      })),
    });
  } catch (error) {
    console.error('[news] admin/list error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

newsRoutes.post('/admin/:id/moderate', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('id');
    const { action, note } = await c.req.json() as { action: string; note?: string };
    if (action !== 'approve' && action !== 'reject') {
      return c.json({ success: false, error: "action должен быть 'approve' или 'reject'" }, 400);
    }
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const { pool } = await import('./db-client.tsx');
    const r = await pool.query(
      `UPDATE news SET status = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING id, author_id, title, content, summary, category, author_name, image_url`,
      [id, newStatus]
    );
    if (!r.rowCount) return c.json({ success: false, error: 'Новость не найдена' }, 404);
    const row = r.rows[0];

    // Причина отклонения — на строке (migration 131), артист видит её в
    // кабинете через GET /mine. Best-effort: если 131 ещё не применена,
    // модерация не падает — причина остаётся только в уведомлении.
    if (action === 'reject' && note) {
      await pool.query(
        `UPDATE news SET moderation_note = $2, moderated_at = NOW() WHERE id = $1`,
        [id, String(note).slice(0, 2000)]
      ).catch(() => {});
    }

    // Approve → публикация в news_public (это и есть публичная лента лендинга).
    if (action === 'approve') {
      try {
        await db.upsertNewsPublic({
          id: row.id,
          title: row.title,
          excerpt: row.summary || (row.content || '').slice(0, 200),
          content: row.content || '',
          category: row.category || 'industry',
          source: 'user',
          authorName: row.author_name || null,
          imageUrl: row.image_url || null,
          status: 'published',
        } as any);
      } catch (pubErr) {
        console.error('[news] publish to news_public failed:', pubErr);
        return c.json({ success: false, error: 'Статус обновлён, но публикация в ленту не удалась' }, 500);
      }
      // IndexNow + Yandex-ping — иначе одобренная артист-новость ждёт
      // планового обхода sitemap вместо мгновенной индексации.
      import('./landing-data-routes.tsx')
        .then(m => m.pingSitemapAsync(String(row.id)))
        .catch(() => {});
    }

    // Уведомление автору — то, что фейковый тост только обещал.
    if (row.author_id) {
      try {
        const notifId = `notif_news_${action}_${Date.now()}`;
        await db.upsertNotification(row.author_id, notifId, {
          id: notifId,
          userId: row.author_id,
          type: 'info',
          title: action === 'approve' ? 'Новость опубликована' : 'Новость отклонена',
          message: action === 'approve'
            ? `«${row.title}» одобрена и опубликована в ленте.`
            : `«${row.title}» отклонена.${note ? ` Причина: ${note}` : ''}`,
          read: false,
          createdAt: new Date().toISOString(),
        });
      } catch { /* уведомление best-effort */ }
    }

    return c.json({ success: true, id, status: newStatus });
  } catch (error) {
    console.error('[news] moderate error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Восстановлено 2026-07-07 (выпало при prep/ms7sbs-prod-мерже) ──
// Свои новости артиста — news-page.tsx server-режим. ДО '/:id'
// (Hono route ordering). moderation_note — причина отклонения (mig 131).
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

// Approved-новости артиста для его публичной страницы
// (ArtistPublicProfile «Новости артиста»). Принимает users.id ИЛИ
// artist_profiles.id. ДО '/:id'.
newsRoutes.get('/artist/:artistId', async (c) => {
  try {
    const artistId = c.req.param('artistId');
    const { pool } = await import('./db-client.tsx');
    const { rows } = await pool.query(
      `SELECT n.id, n.title, n.summary, n.content, n.image_url, n.created_at
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
    const userId = String(c.get('userId') || '');
    const body = await c.req.json();
    const newsId = body.id || `news-${crypto.randomUUID()}`;

    // Owner-guard (восстановлен 2026-07-07): upsertNews апсертит по id
    // вслепую — без проверки артист A мог POST'нуть id чужой новости и
    // перезаписать её.
    if (body.id) {
      const { pool } = await import('./db-client.tsx');
      const existing = await pool.query(
        `SELECT author_id FROM news WHERE id = $1 LIMIT 1`,
        [String(body.id)]
      );
      if (existing.rows[0] && String(existing.rows[0].author_id) !== userId) {
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

// Удаление своей новости (восстановлено 2026-07-07). id и author_id —
// text, кастов не нужно.
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
