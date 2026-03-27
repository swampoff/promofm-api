/**
 * CONCERT MODERATION ROUTES v2 — Uses typed `concerts` table
 * Admin approve/reject concerts
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import * as typed from './db-typed.tsx';

const app = new Hono();

const COINS_ON_APPROVE = 30;

// GET /pending — Get concerts for moderation
app.get('/pending', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'pending';
    const concerts = await typed.getAllConcertsForModeration(status === 'all' ? undefined : status);

    const mapped = concerts.map((c: any) => ({
      id: c.id,
      title: c.title,
      artist: c.artist_name || '',
      city: c.city || '',
      venue: c.venue_name || '',
      venue_address: c.venue_address || '',
      date: c.event_date,
      time: c.event_time || '',
      type: c.event_type || 'Концерт',
      banner_image_url: c.banner_image_url || '',
      ticket_price_from: c.ticket_price_min,
      ticket_price_to: c.ticket_price_max,
      ticket_link: c.ticket_link || '',
      ticket_capacity: c.ticket_capacity,
      description: c.description || '',
      moderation_status: c.moderation_status,
      rejection_reason: c.rejection_reason || null,
      moderation_comment: c.moderation_comment || null,
      user_id: c.user_id || '',
      source: c.source || 'user',
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));

    return c.json({ success: true, data: mapped });
  } catch (error) {
    console.error('Error in concert moderation pending:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /manage — Approve or reject concert
app.post('/manage', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { concertId, action, moderator_notes, rejection_reason } = body;

    const concert = await typed.getConcertById(concertId);
    if (!concert) {
      return c.json({ error: 'Concert not found' }, 404);
    }

    const now = new Date().toISOString();

    if (action === 'approve') {
      await typed.updateConcert(concertId, {
        moderation_status: 'published',
        moderation_comment: moderator_notes || 'Концерт одобрен',
        moderated_at: now,
        is_hidden: false,
      });

      // Award coins to organizer
      let coinsAwarded = 0;
      if (concert.user_id) {
        await typed.awardCoins(
          concert.user_id,
          COINS_ON_APPROVE,
          `Концерт "${concert.title}" одобрен модерацией`
        );
        coinsAwarded = COINS_ON_APPROVE;
      }

      return c.json({
        success: true,
        message: 'Концерт одобрен и опубликован',
        concertId,
        coinsAwarded,
        published: true,
      });

    } else if (action === 'reject') {
      await typed.updateConcert(concertId, {
        moderation_status: 'rejected',
        rejection_reason: rejection_reason || '',
        moderation_comment: moderator_notes || null,
        moderated_at: now,
      });

      return c.json({ success: true, message: 'Концерт отклонён' });

    } else {
      return c.json({ error: 'Invalid action' }, 400);
    }
  } catch (error) {
    console.error('Error in concert moderation manage:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /batch — Batch approve/reject
app.post('/batch', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { concertIds, action } = body;
    const now = new Date().toISOString();

    const results = [];
    for (const concertId of concertIds) {
      const concert = await typed.getConcertById(concertId);
      if (!concert) {
        results.push({ concertId, success: false, message: 'Not found' });
        continue;
      }

      if (action === 'approve') {
        await typed.updateConcert(concertId, {
          moderation_status: 'published',
          moderated_at: now,
          is_hidden: false,
        });
        if (concert.user_id) {
          await typed.awardCoins(concert.user_id, COINS_ON_APPROVE, `Концерт "${concert.title}" одобрен`);
        }
      } else {
        await typed.updateConcert(concertId, {
          moderation_status: 'rejected',
          moderated_at: now,
        });
      }

      results.push({ concertId, success: true, message: `${action} successful` });
    }

    return c.json({ success: true, results });
  } catch (error) {
    console.error('Error in concert batch moderation:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /stats — Concert moderation stats
app.get('/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const all = await typed.getAllConcertsForModeration();
    const pending = all.filter((c: any) => c.moderation_status === 'pending').length;
    const approved = all.filter((c: any) => ['approved', 'published'].includes(c.moderation_status)).length;
    const rejected = all.filter((c: any) => c.moderation_status === 'rejected').length;

    return c.json({ total: all.length, pending, approved, rejected });
  } catch (error) {
    return c.json({ total: 0, pending: 0, approved: 0, rejected: 0 });
  }
});

export default app;
