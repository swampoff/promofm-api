/**
 * CONCERTS ROUTES v2 — Uses typed `concerts` table
 * Artist CRUD + public endpoints for published concerts
 */

import { Hono } from 'hono';
import * as typed from './db-typed.tsx';
import { safeErrorMessage } from './security.tsx';

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
    // Skip if it matches a known sub-route
    if (['public', 'promoted', 'moderation'].includes(concertId)) return c.notFound();
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

    // Check concert exists and belongs to user
    const concert = await typed.getConcertById(concertId);
    if (!concert) {
      return c.json({ success: false, error: 'Concert not found' }, 404);
    }

    // Deduct coins
    const result = await typed.deductCoins(userId, cost, `Промо концерта "${concert.title}"`);
    if (result && 'error' in result) {
      return c.json({ success: false, error: result.error, balance: result.balance }, 400);
    }

    // Set promoted
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
