/**
 * CONCERTS ROUTES v2 — Uses typed concerts table + performance_history
 */

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

// GET /performance-history
app.get('/performance-history', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const { rows } = await pool.query(
      'SELECT * FROM performance_history WHERE user_id = $1 ORDER BY event_date DESC',
      [userId]
    );
    return c.json({ success: true, data: rows });
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
      `INSERT INTO performance_history (user_id, venue_name, city, country, event_date, event_type, setlist, notes, audience_count, was_headliner)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [userId, body.venue_name, body.city || null, body.country || 'Россия', body.event_date, body.event_type || 'live', body.setlist || null, body.notes || null, body.audience_count || null, body.was_headliner || false]
    );
    return c.json({ success: true, data: rows });
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
    const allowed = ['venue_name','city','country','event_date','event_type','setlist','notes','audience_count','was_headliner'];
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, val] of Object.entries(body)) {
      if (allowed.includes(key)) {
        fields.push(`${key} = $${i++}`);
        values.push(val);
      }
    }
    if (fields.length === 0) return c.json({ success: false, error: 'No fields to update' }, 400);
    fields.push('updated_at = NOW()');
    values.push(id, userId);
    const { rows } = await pool.query(
      `UPDATE performance_history SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: rows });
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

    return c.json({ success: true, data: concert }, 201);
  } catch (error) {
    console.error('Error in POST /concerts:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /:id — Update concert
app.put('/:id', requireAuth, async (c) => {
  try {
    const concertId = c.req.param('id');
    const body = await c.req.json();

    const concert = await typed.updateConcert(concertId, body);
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

    const concert = await typed.getConcertById(concertId);
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
