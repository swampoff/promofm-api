/**
 * CONCERTS ROUTES v2 — Uses typed concerts table + performance_history
 */

import { notifyConcertCreated } from './email-helper.tsx';
import { Hono } from 'hono';
import * as typed from './db-typed.tsx';
import { safeErrorMessage } from './security.tsx';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';

const app = new Hono();

// ═══════════════════════════════════════
// PUBLIC endpoints (no auth required)
// ═══════════════════════════════════════

// GET /public — Published upcoming concerts
app.get('/public', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const concerts = await typed.getPublishedConcerts(limit);
    return c.json({ success: true, data: concerts });
  } catch (error) {
    console.error('Error in GET /concerts/public:', error);
    return c.json({ success: true, data: [] });
  }
});

// GET /promoted — Promoted concerts for banners/hero
app.get('/promoted', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '10');
    const concerts = await typed.getPromotedConcerts(limit);
    return c.json({ success: true, data: concerts });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// ═══════════════════════════════════════
// PERFORMANCE HISTORY
// ═══════════════════════════════════════

// Map DB row → UI shape (PerformanceHistoryItem)
function toUiPerformance(row: any) {
  return {
    id: row.id,
    event_name: row.event_name || '',
    venue_name: row.venue_name,
    city: row.city,
    date: row.event_date,
    audience_size: row.audience_count,
    type: row.event_type,
    description: row.description,
    photos: Array.isArray(row.photos) ? row.photos : [],
  };
}

// GET /performance-history
app.get('/performance-history', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const { rows } = await pool.query(
      'SELECT * FROM performance_history WHERE user_id = $1 ORDER BY event_date DESC',
      [userId]
    );
    return c.json({ success: true, data: rows.map(toUiPerformance) });
  } catch (error) {
    console.error('Error in GET /performance-history:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /performance-history
app.post('/performance-history', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const { rows } = await pool.query(
      `INSERT INTO performance_history (user_id, event_name, venue_name, city, country, event_date, event_type, audience_count, description, photos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        userId,
        body.event_name || null,
        body.venue_name,
        body.city || null,
        body.country || 'Россия',
        body.date || body.event_date,
        body.type || body.event_type || 'Концерт',
        body.audience_size ?? body.audience_count ?? null,
        body.description || null,
        JSON.stringify(body.photos || []),
      ]
    );
    return c.json({ success: true, data: toUiPerformance(rows[0]) });
  } catch (error) {
    console.error('Error in POST /performance-history:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /performance-history/:id
app.put('/performance-history/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json();
    // Translate UI field names → DB column names
    const uiToDb: Record<string, string> = {
      event_name: 'event_name',
      venue_name: 'venue_name',
      city: 'city',
      country: 'country',
      date: 'event_date',
      event_date: 'event_date',
      type: 'event_type',
      event_type: 'event_type',
      audience_size: 'audience_count',
      audience_count: 'audience_count',
      description: 'description',
      photos: 'photos',
    };
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, val] of Object.entries(body)) {
      const col = uiToDb[key];
      if (!col) continue;
      fields.push(`${col} = $${i++}`);
      values.push(col === 'photos' ? JSON.stringify(val || []) : val);
    }
    if (fields.length === 0) return c.json({ success: false, error: 'No fields to update' }, 400);
    fields.push('updated_at = NOW()');
    values.push(id, userId);
    const { rows } = await pool.query(
      `UPDATE performance_history SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: toUiPerformance(rows[0]) });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /performance-history/:id
app.delete('/performance-history/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const id = c.req.param('id');
    const { rowCount } = await pool.query(
      'DELETE FROM performance_history WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (rowCount === 0) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, message: 'Deleted' });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ═══════════════════════════════════════
// ARTIST endpoints (auth required)
// ═══════════════════════════════════════

// GET / — Get all concerts for current user
app.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const concerts = await typed.getConcertsByUser(userId);
    return c.json({ success: true, data: concerts });
  } catch (error) {
    console.error('Error in GET /concerts:', error);
    return c.json({ success: true, data: [] });
  }
});

// GET /:id — Get single concert
app.get('/:id', requireAuth, async (c) => {
  try {
    const concertId = c.req.param('id');
    if (['public', 'promoted', 'moderation', 'performance-history'].includes(concertId)) return c.notFound();
    const concert = await typed.getConcertById(concertId);
    if (!concert) {
      return c.json({ success: false, error: 'Concert not found' }, 404);
    }
    return c.json({ success: true, data: concert });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST / — Create new concert
app.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const concert = await typed.insertConcert({
      ...body,
      user_id: userId,
      artist_name: body.artist || body.artist_name || '',
      moderation_status: body.status || 'draft',
    });

    if (!concert) {
      return c.json({ success: false, error: 'Failed to create concert' }, 500);
    }

    // Email notification to admin
    notifyConcertCreated({
      title: body.title || body.name || '',
      artist: body.artist || body.artist_name || '',
      city: body.city,
      venue: body.venue || body.venue_name || '',
      date: body.date || body.event_date || '',
    }).catch(err => console.error('[concerts] Email notify failed:', err.message));

    return c.json({ success: true, data: concert }, 201);
  } catch (error) {
    console.error('Error in POST /concerts:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// Форма кабинета (concert-schema) шлёт имена полей banner_url/ticket_url/date/…
// которые НЕ являются колонками concerts. updateConcert строит
// SET "<key>"=$n для каждого ключа → сырой body ронял весь UPDATE на
// несуществующей колонке. Нормализуем в реальные колонки, включая только
// присутствующие поля (partial update; пустая строка = осознанная очистка).
function concertFormToColumns(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const set = (col: string, val: any) => { if (val !== undefined) out[col] = val; };
  set('title', body.title);
  set('artist_name', body.artist_name ?? body.artist);
  set('description', body.description);
  set('city', body.city);
  set('venue_name', body.venue_name ?? body.venue);
  set('venue_address', body.venue_address);
  set('event_date', body.event_date ?? body.date);
  set('event_time', body.event_time ?? body.time);
  set('event_type', body.event_type ?? body.type);
  set('banner_image_url', body.banner_image_url ?? body.banner ?? body.banner_url);
  set('ticket_price_min', body.ticket_price_min ?? body.ticketPriceFrom);
  set('ticket_price_max', body.ticket_price_max ?? body.ticketPriceTo);
  set('ticket_link', body.ticket_link ?? body.ticketLink ?? body.ticket_url);
  set('ticket_capacity', body.ticket_capacity);
  return out;
}

// Ownership guard: возвращает концерт, только если вызывающий — его владелец
// (concerts.user_id === JWT userId) или админ. Иначе null. 404 отдаётся и на
// «не найдено», и на «не твой» — чтобы не палить существование чужих записей.
// Модерация правит концерты своим роутом (concert-moderation) — там свои гейты.
async function loadOwnedConcert(c: any, concertId: string): Promise<any | null> {
  const userId = c.get('userId') as string;
  const role = c.get('userRole') as string;
  const concert = await typed.getConcertById(concertId);
  if (!concert) return null;
  const isAdmin = role === 'admin' || role === 'superadmin';
  if (!isAdmin && String(concert.user_id) !== String(userId)) return null;
  return concert;
}

// PUT /:id — Update concert
app.put('/:id', requireAuth, async (c) => {
  try {
    const concertId = c.req.param('id');
    const body = await c.req.json();

    // IDOR-guard: править можно только свой концерт (или админ).
    const owned = await loadOwnedConcert(c, concertId);
    if (!owned) {
      return c.json({ success: false, error: 'Concert not found' }, 404);
    }

    const concert = await typed.updateConcert(concertId, concertFormToColumns(body));
    if (!concert) {
      return c.json({ success: false, error: 'Concert not found' }, 404);
    }

    return c.json({ success: true, data: concert });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /:id — Delete concert
app.delete('/:id', requireAuth, async (c) => {
  try {
    const concertId = c.req.param('id');

    // IDOR-guard: удалять можно только свой концерт (или админ).
    const owned = await loadOwnedConcert(c, concertId);
    if (!owned) {
      return c.json({ success: false, error: 'Concert not found' }, 404);
    }

    await typed.deleteConcert(concertId);
    return c.json({ success: true, message: 'Concert deleted' });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /:id/submit — Submit concert for moderation
app.post('/:id/submit', requireAuth, async (c) => {
  try {
    const concertId = c.req.param('id');

    // IDOR-guard: отправлять на модерацию можно только свой концерт (или админ).
    const owned = await loadOwnedConcert(c, concertId);
    if (!owned) {
      return c.json({ success: false, error: 'Concert not found' }, 404);
    }

    const concert = await typed.updateConcert(concertId, {
      moderation_status: 'pending',
    });
    if (!concert) {
      return c.json({ success: false, error: 'Concert not found' }, 404);
    }
    return c.json({ success: true, data: concert, message: 'Submitted for moderation' });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /:id/promote — Request promotion (costs coins)
app.post('/:id/promote', requireAuth, async (c) => {
  try {
    const concertId = c.req.param('id');
    const userId = c.get('userId');
    const body = await c.req.json();
    const cost = body.cost || 100;

    // IDOR-guard: продвигать (за свои коины) можно только свой концерт (или админ).
    const concert = await loadOwnedConcert(c, concertId);
    if (!concert) {
      return c.json({ success: false, error: 'Concert not found' }, 404);
    }

    const result = await typed.deductCoins(userId, cost, `Промо концерта "${concert.title}"`);
    if (result && 'error' in result) {
      return c.json({ success: false, error: result.error, balance: result.balance }, 400);
    }

    const now = new Date();
    const endDate = new Date(now.getTime() + (body.days || 7) * 86400000);
    await typed.updateConcert(concertId, {
      is_promoted: true,
      promotion_starts_at: now.toISOString(),
      promotion_ends_at: endDate.toISOString(),
      promotion_cost: cost,
    });

    return c.json({ success: true, message: 'Concert promoted', coinsSpent: cost });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
