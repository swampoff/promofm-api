/**
 * COLLABORATION ROUTES - Producer-Artist сотрудничество
 *
 * Storage (migration 058 — row-per-offer native cols):
 *   collab_offers (id PK, artist_id, producer_id, native fields…) —
 *     индексы (artist_id, created_at DESC), (producer_id, created_at DESC),
 *     partial (status) WHERE open. Раньше: dual-array-index anti-pattern
 *     (collab_offers_by_artist + collab_offers_by_producer DROPPED).
 *   collab_messages (pk: app_id, row-per-message since migration 038).
 *
 * Endpoints:
 * POST   /offers              - Создать предложение (producer; producerId из JWT)
 * GET    /offers/artist/:id   - Предложения для артиста
 * GET    /offers/producer/:id - Предложения от продюсера
 * PUT    /offers/:id/respond  - Ответить на предложение (artist из JWT)
 * PUT    /offers/:id/complete - Подтвердить завершение (artist из JWT)
 * GET    /chat/:offerId       - Сообщения по предложению
 * POST   /chat/:offerId       - Отправить сообщение (sender из JWT)
 * GET    /stats/:userId       - Статистика коллабораций
 */

import { Hono } from 'hono';
import {
  getCollabOffer,
  upsertCollabOffer,
  listCollabOffersByArtist,
  listCollabOffersByProducer,
  getCollabOfferStatsByUser,
} from './db.tsx';
import { pool } from './db-client.tsx';
import { emitSSE } from './sse-routes.tsx';

import { requireAuth, requireOwner, requireAdmin } from './auth-middleware.tsx';
import { creditAvailableAtomic } from './db.tsx';

const app = new Hono();

interface CollabOffer {
  id: string;
  producerId: string;
  producerName: string;
  producerAvatar?: string;
  artistId: string;
  artistName: string;
  type: 'beat' | 'mixing' | 'mastering' | 'arrangement' | 'ghost_production' | 'collab_track';
  title: string;
  description: string;
  price?: number;
  currency: string;
  audioPreviewUrl?: string;
  bpm?: number;
  key?: string;
  genre?: string;
  tags?: string[];
  status: 'pending' | 'accepted' | 'declined' | 'discussion' | 'completed' | 'cancelled';
  deadline?: string;
  createdAt: string;
  updatedAt: string;
  respondedAt?: string;
  completedAt?: string;
  artistComment?: string;
}

interface CollabMessage {
  id: string;
  offerId: string;
  senderId: string;
  senderName: string;
  senderRole: 'producer' | 'artist';
  text: string;
  attachment?: { type: 'audio' | 'image' | 'file'; name: string; url?: string };
  createdAt: string;
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// writeOfferAtomic + findOffer DELETED — раньше оффер дублировался в
// обоих сторах через transactional dual-write. Single source of truth
// после migration 058: одна row-per-offer таблица + native indexes на
// artist_id / producer_id для тех же per-user lookups. Просто
// upsertCollabOffer / getCollabOffer.

// ── POST /offers — создать предложение (продюсер) ──

app.post('/offers', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get('userId') as string; // IDOR-safe: from JWT
    const {
      producerName, producerAvatar,
      artistId, artistName,
      type, title, description,
      price, audioPreviewUrl, bpm, key: musicKey, genre, tags, deadline,
    } = body;

    if (!artistId || !title) {
      return c.json({ success: false, error: 'artistId, title required' }, 400);
    }
    if (artistId === producerId) {
      return c.json({ success: false, error: 'Cannot offer collaboration to yourself' }, 400);
    }

    const now = new Date().toISOString();
    const offer: CollabOffer = {
      id: genId('offer'),
      producerId,
      producerName: producerName || 'Продюсер',
      producerAvatar,
      artistId,
      artistName: artistName || 'Артист',
      type: type || 'beat',
      title,
      description: description || '',
      price: price ? Number(price) : undefined,
      currency: 'RUB',
      audioPreviewUrl,
      bpm: bpm ? Number(bpm) : undefined,
      key: musicKey,
      genre,
      tags: tags || [],
      status: 'pending',
      deadline,
      createdAt: now,
      updatedAt: now,
    };

    await upsertCollabOffer(offer.id, offer);

    emitSSE(artistId, {
      type: 'collab_offer',
      data: {
        offerId: offer.id,
        producerName: offer.producerName,
        title: offer.title,
        type: offer.type,
        message: `${offer.producerName} предлагает: ${offer.title}`,
      },
    });

    return c.json({ success: true, offer });
  } catch (err) {
    console.log('Error creating collab offer:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /offers/artist/:id ──

app.get('/offers/artist/:id', requireAuth, requireOwner('id'), async (c) => {
  const artistId = c.req.param('id');
  try {
    const offers = await listCollabOffersByArtist(artistId);
    return c.json({ success: true, offers });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /offers/producer/:id ──

app.get('/offers/producer/:id', requireAuth, requireOwner('id'), async (c) => {
  const producerId = c.req.param('id');
  try {
    const offers = await listCollabOffersByProducer(producerId);
    return c.json({ success: true, offers });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── PUT /offers/:id/respond — артист отвечает (accept/decline/discussion) ──

app.put('/offers/:id/respond', requireAuth, async (c) => {
  const offerId = c.req.param('id');
  try {
    const { status, comment } = await c.req.json();
    const userId = c.get('userId') as string;

    const validStatuses = ['accepted', 'declined', 'discussion'];
    if (!validStatuses.includes(status)) {
      return c.json(
        { success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
        400,
      );
    }

    const original = await getCollabOffer(offerId);
    // Single source of truth + ownership check (artist может respond
    // только на свои офферы). Для атакующего 404 неотличимо от «not yours».
    if (!original || original.artistId !== userId) {
      return c.json({ success: false, error: 'Offer not found' }, 404);
    }

    if (original.status !== 'pending' && original.status !== 'discussion') {
      return c.json(
        { success: false, error: `Cannot respond to offer in status ${original.status}` },
        409,
      );
    }

    // Source-of-truth money guard: платный оффер НЕЛЬЗЯ принять напрямую
    // этим эндпоинтом — деньги обязаны пройти через escrow
    // (POST /checkout/create-session {type:'collab_accept'} → webhook
    // ставит status='accepted' + payment_status='escrow_held'). Иначе оффер
    // стал бы 'accepted' при payment_status='unpaid', и /complete пропустил
    // бы release → продюсер не получил бы выплату. decline/discussion —
    // бесплатны, поэтому разрешены. Бесплатные офферы (price 0/пусто)
    // принимаются здесь напрямую без escrow.
    if (status === 'accepted' && Number(original.price) > 0) {
      return c.json(
        {
          success: false,
          error: 'Платный оффер принимается через оплату (escrow), не напрямую. Используйте checkout collab_accept.',
          code: 'payment_required',
        },
        402,
      );
    }

    const now = new Date().toISOString();
    const updated: CollabOffer = {
      ...original,
      status,
      updatedAt: now,
      respondedAt: now,
      ...(comment ? { artistComment: comment } : {}),
    };

    await upsertCollabOffer(offerId, updated);

    const statusLabel =
      status === 'accepted' ? 'принял' :
      status === 'declined' ? 'отклонил' :
      'хочет обсудить';
    emitSSE(updated.producerId, {
      type: 'collab_response',
      data: {
        offerId,
        artistName: updated.artistName,
        status,
        message: `${updated.artistName} ${statusLabel} предложение "${updated.title}"`,
      },
    });

    return c.json({ success: true, offer: updated });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── PUT /offers/:id/complete — артист подтверждает завершение коллабы ──
//
// Для escrow-офферов (payment_status='escrow_held'): atomically
// credit producer + mark payment_status='released' in one transaction,
// then set status='completed'. Zero commission (0%).
// Для price=0-офферов (payment_status='unpaid'): просто status='completed',
// никаких денег.

app.put('/offers/:id/complete', requireAuth, async (c) => {
  const offerId = c.req.param('id');
  try {
    const userId = c.get('userId') as string;

    const original = await getCollabOffer(offerId);
    if (!original || original.artistId !== userId) {
      return c.json({ success: false, error: 'Offer not found' }, 404);
    }

    if (original.status !== 'accepted') {
      return c.json(
        { success: false, error: `Can complete only accepted offers (current: ${original.status})` },
        409,
      );
    }

    // Release escrow atomically: credit producer and mark released in
    // one transaction so a crash between the two doesn't create a state
    // where the producer is credited but the offer is still 'escrow_held'
    // (or vice-versa).
    if (original.paymentStatus === 'escrow_held') {
      const price = Number(original.price);
      if (!(price > 0)) {
        return c.json({ success: false, error: 'Offer price is zero but payment_status is escrow_held' }, 500);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO payment_balances (user_id, available, pending, total, updated_at)
           VALUES ($1, $2::numeric, 0, $2::numeric, NOW())
           ON CONFLICT (user_id) DO UPDATE
             SET available  = payment_balances.available + EXCLUDED.available,
                 total      = payment_balances.total     + EXCLUDED.available,
                 updated_at = NOW()`,
          [original.producerId, price]
        );
        const rel = await client.query(
          `UPDATE collab_offers
              SET payment_status = 'released',
                  released_at    = NOW(),
                  updated_at     = NOW()
            WHERE id = $1
              AND payment_status = 'escrow_held'
            RETURNING id`,
          [offerId]
        );
        if (!rel.rowCount) {
          await client.query('ROLLBACK');
          return c.json({ success: false, error: 'Escrow already released or wrong state' }, 409);
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
    }

    const now = new Date().toISOString();
    const updated: CollabOffer = { ...original, status: 'completed', updatedAt: now, completedAt: now };
    await upsertCollabOffer(offerId, updated);

    emitSSE(updated.producerId, {
      type: 'collab_response',
      data: {
        offerId,
        artistName: updated.artistName,
        status: 'completed',
        message: `${updated.artistName} подтвердил завершение коллаборации "${updated.title}"`,
      },
    });

    return c.json({ success: true, offer: updated });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /chat/:offerId ──

app.get('/chat/:offerId', requireAuth, async (c) => {
  const offerId = c.req.param('offerId');
  try {
    const userId = c.get('userId') as string;

    // Доступ только участникам оффера.
    const offer = await getCollabOffer(offerId);
    if (!offer) return c.json({ success: false, error: 'Offer not found' }, 404);
    if (offer.artistId !== userId && offer.producerId !== userId) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const r = await pool.query(
      `SELECT app_id, offer_id, sender_id, sender_name, sender_role,
              body, attachment, created_at
         FROM collab_messages
        WHERE offer_id = $1
        ORDER BY created_at ASC`,
      [offerId]
    );
    const messages: CollabMessage[] = r.rows.map((row: any) => ({
      id: row.app_id,
      offerId: row.offer_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderRole: row.sender_role as 'producer' | 'artist',
      text: row.body,
      attachment: row.attachment || undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
    return c.json({ success: true, messages });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── POST /chat/:offerId ──

app.post('/chat/:offerId', requireAuth, async (c) => {
  const offerId = c.req.param('offerId');
  try {
    const { text, attachment, senderName } = await c.req.json();
    const userId = c.get('userId') as string;

    if (!text || typeof text !== 'string' || !text.trim()) {
      return c.json({ success: false, error: 'text required' }, 400);
    }

    // Identity & authorization — нельзя писать в чат, если ты не сторона этого оффера.
    // Это же даёт нам корректный senderRole без доверия body.
    const offer = await getCollabOffer(offerId);
    if (!offer) return c.json({ success: false, error: 'Offer not found' }, 404);
    let senderRole: 'producer' | 'artist';
    let recipientId: string;
    if (offer.producerId === userId) {
      senderRole = 'producer';
      recipientId = offer.artistId;
    } else if (offer.artistId === userId) {
      senderRole = 'artist';
      recipientId = offer.producerId;
    } else {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const message: CollabMessage = {
      id: genId('cmsg'),
      offerId,
      senderId: userId,
      senderName: (typeof senderName === 'string' && senderName.trim()) || 'User',
      senderRole,
      text,
      attachment,
      createdAt: new Date().toISOString(),
    };

    // row-per-message (migration 038): INSERT — никаких race conditions.
    await pool.query(
      `INSERT INTO collab_messages
         (app_id, offer_id, sender_id, sender_name, sender_role, body,
          attachment, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (offer_id, app_id) DO NOTHING`,
      [
        message.id, offerId, userId, message.senderName, senderRole, text,
        attachment ? JSON.stringify(attachment) : null,
        message.createdAt,
      ]
    );

    emitSSE(recipientId, {
      type: 'collab_message',
      data: {
        offerId,
        senderName: message.senderName,
        text: text.length > 100 ? text.slice(0, 100) + '...' : text,
        message: `${message.senderName}: ${text.length > 60 ? text.slice(0, 60) + '...' : text}`,
      },
    });

    return c.json({ success: true, message });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── POST /offers/auto-complete — cron daily (X-Internal-Key) ──
//
// Releases escrow for offers where the artist hasn't confirmed completion
// within the deadline. Pattern: credit-first-then-mark-released in a
// per-offer transaction so a crash mid-loop leaves the offer in
// escrow_held and it is retried on the next cron run.
//
// Crontab (VPS):
//   0 4 * * *  curl -s -X POST -H "X-Internal-Key: $VPS_INTERNAL_KEY" \
//     http://127.0.0.1:3000/server/api/collaboration/offers/auto-complete \
//     >> /var/log/promofm-collab-autocomplete.log 2>&1

app.post('/offers/auto-complete', async (c) => {
  const internalKey = c.req.header('X-Internal-Key') || '';
  const expectedKey = process.env.VPS_INTERNAL_KEY || '';
  if (!expectedKey || internalKey !== expectedKey) {
    return c.json({ success: false, error: 'X-Internal-Key required' }, 401);
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, artist_id, producer_id, title, price
         FROM collab_offers
        WHERE payment_status = 'escrow_held'
          AND accept_deadline < NOW()`
    );

    let released = 0;
    for (const row of rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO payment_balances (user_id, available, pending, total, updated_at)
           VALUES ($1, $2::numeric, 0, $2::numeric, NOW())
           ON CONFLICT (user_id) DO UPDATE
             SET available  = payment_balances.available + EXCLUDED.available,
                 total      = payment_balances.total     + EXCLUDED.available,
                 updated_at = NOW()`,
          [row.producer_id, Number(row.price)]
        );
        await client.query(
          `UPDATE collab_offers
              SET payment_status = 'released',
                  released_at    = NOW(),
                  status         = 'completed',
                  completed_at   = NOW(),
                  updated_at     = NOW()
            WHERE id = $1
              AND payment_status = 'escrow_held'`,
          [row.id]
        );
        await client.query('COMMIT');
        released++;
        try {
          emitSSE(row.artist_id, {
            type: 'collab_auto_completed',
            data: { offerId: row.id, title: row.title },
          });
          emitSSE(row.producer_id, {
            type: 'collab_auto_completed',
            data: { offerId: row.id, title: row.title, amount: Number(row.price) },
          });
        } catch {}
      } catch (txErr) {
        await client.query('ROLLBACK');
        console.error('[collab auto-complete] tx error', row.id, txErr);
      } finally {
        client.release();
      }
    }
    return c.json({ success: true, released });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── POST /admin/offers/:id/resolve — admin arbitrage ──
//
// resolution='release_to_producer': credit producer payment_balance (0% commission).
// resolution='refund_to_artist':    credit artist payment_balance (platform credit,
//   not gateway refund — for actual card refund use YooKassa dashboard manually).

app.post('/admin/offers/:id/resolve', requireAuth, requireAdmin, async (c) => {
  const offerId = c.req.param('id');
  try {
    const { resolution, reason } = await c.req.json() as { resolution: string; reason?: string };
    if (resolution !== 'release_to_producer' && resolution !== 'refund_to_artist') {
      return c.json({ success: false, error: 'resolution must be release_to_producer or refund_to_artist' }, 400);
    }

    const offer = await getCollabOffer(offerId);
    if (!offer) return c.json({ success: false, error: 'Offer not found' }, 404);
    if (offer.paymentStatus !== 'escrow_held') {
      return c.json(
        { success: false, error: `Arbitrage only for escrow_held offers (current: ${offer.paymentStatus})` },
        409
      );
    }

    const price = Number(offer.price);
    const recipientId = resolution === 'release_to_producer' ? offer.producerId : offer.artistId;
    const newPaymentStatus = resolution === 'release_to_producer' ? 'released' : 'refunded';
    const timestampCol = resolution === 'release_to_producer' ? 'released_at' : 'refunded_at';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO payment_balances (user_id, available, pending, total, updated_at)
         VALUES ($1, $2::numeric, 0, $2::numeric, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET available  = payment_balances.available + EXCLUDED.available,
               total      = payment_balances.total     + EXCLUDED.available,
               updated_at = NOW()`,
        [recipientId, price]
      );
      await client.query(
        `UPDATE collab_offers
            SET payment_status = $2,
                ${timestampCol} = NOW(),
                status         = $3,
                updated_at     = NOW()
          WHERE id = $1
            AND payment_status = 'escrow_held'`,
        [offerId, newPaymentStatus, resolution === 'release_to_producer' ? 'completed' : 'cancelled']
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    try {
      emitSSE(offer.artistId, {
        type: 'collab_arbitrage_resolved',
        data: { offerId, resolution, reason: reason || '' },
      });
      emitSSE(offer.producerId, {
        type: 'collab_arbitrage_resolved',
        data: { offerId, resolution, reason: reason || '' },
      });
    } catch {}

    return c.json({ success: true, offerId, resolution });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /stats/:userId ──

app.get('/stats/:userId', requireAuth, requireOwner('userId'), async (c) => {
  const userId = c.req.param('userId');
  try {
    // SQL aggregation через native indexes — взамен SELECT-all + JS filter.
    const stats = await getCollabOfferStatsByUser(userId);
    return c.json({ success: true, stats });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export default app;
