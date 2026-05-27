/**
 * COLLABORATION ROUTES - Producer-Artist сотрудничество
 *
 * Продюсер предлагает биты/услуги артисту через систему предложений.
 * Артист может принять, отклонить, начать обсуждение или подтвердить завершение.
 *
 * Storage (JSONB stores, will move to native columns later — see kv-to-sql-migration.md):
 *   collab_offers_by_artist   (pk: artist_id)   -> CollabOffer[]
 *   collab_offers_by_producer (pk: producer_id) -> CollabOffer[]
 *   collab_messages           (pk: id)          -> CollabMessage[] (one row per offer)
 *
 * Дубль (offer хранится в обоих сторах) пишется атомарно через одну PG-транзакцию
 * — иначе при сбое второй записи у одной стороны статус мог отставать.
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
  collabOffersByArtistStore,
  collabOffersByProducerStore,
} from './db.tsx';
import { pool } from './db-client.tsx';
import { emitSSE } from './sse-routes.tsx';

import { requireAuth, requireOwner } from './auth-middleware.tsx';

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

/**
 * Атомарно записывает оффер в оба JSONB-стора одной транзакцией.
 * Любая ошибка во второй записи откатывает первую — стороны не разъезжаются.
 */
async function writeOfferAtomic(artistId: string, producerId: string, offer: CollabOffer) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: artistRows } = await client.query(
      'SELECT data FROM collab_offers_by_artist WHERE artist_id = $1',
      [artistId],
    );
    const artistOffers: CollabOffer[] = (artistRows[0]?.data as CollabOffer[]) || [];
    const aIdx = artistOffers.findIndex(o => o.id === offer.id);
    if (aIdx === -1) artistOffers.unshift(offer);
    else artistOffers[aIdx] = offer;

    const { rows: producerRows } = await client.query(
      'SELECT data FROM collab_offers_by_producer WHERE producer_id = $1',
      [producerId],
    );
    const producerOffers: CollabOffer[] = (producerRows[0]?.data as CollabOffer[]) || [];
    const pIdx = producerOffers.findIndex(o => o.id === offer.id);
    if (pIdx === -1) producerOffers.unshift(offer);
    else producerOffers[pIdx] = offer;

    const updatedAt = new Date().toISOString();
    await client.query(
      `INSERT INTO collab_offers_by_artist (artist_id, data, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (artist_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [artistId, JSON.stringify(artistOffers), updatedAt],
    );
    await client.query(
      `INSERT INTO collab_offers_by_producer (producer_id, data, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (producer_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [producerId, JSON.stringify(producerOffers), updatedAt],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Найти оффер в любом из сторов по id. Возвращает null если не найден. */
async function findOffer(offerId: string): Promise<CollabOffer | null> {
  // Сначала пробуем индекс по продюсеру (offers редко бывают много к одному артисту,
  // но порядок не критичен — оффер дублируется в обоих сторах).
  const allArtists = await collabOffersByArtistStore.getAll() as CollabOffer[][];
  for (const list of allArtists) {
    const match = (list || []).find(o => o.id === offerId);
    if (match) return match;
  }
  return null;
}

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

    await writeOfferAtomic(artistId, producerId, offer);

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
    const offers: CollabOffer[] = (await collabOffersByArtistStore.get(artistId)) || [];
    return c.json({ success: true, offers });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /offers/producer/:id ──

app.get('/offers/producer/:id', requireAuth, requireOwner('id'), async (c) => {
  const producerId = c.req.param('id');
  try {
    const offers: CollabOffer[] = (await collabOffersByProducerStore.get(producerId)) || [];
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

    const artistOffers: CollabOffer[] = (await collabOffersByArtistStore.get(userId)) || [];
    const offerIdx = artistOffers.findIndex(o => o.id === offerId);
    if (offerIdx === -1) {
      // Либо нет такого оффера, либо он адресован другому артисту — для атакующего неотличимо.
      return c.json({ success: false, error: 'Offer not found' }, 404);
    }

    const original = artistOffers[offerIdx];
    if (original.status !== 'pending' && original.status !== 'discussion') {
      return c.json(
        { success: false, error: `Cannot respond to offer in status ${original.status}` },
        409,
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

    await writeOfferAtomic(updated.artistId, updated.producerId, updated);

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

app.put('/offers/:id/complete', requireAuth, async (c) => {
  const offerId = c.req.param('id');
  try {
    const userId = c.get('userId') as string;

    const artistOffers: CollabOffer[] = (await collabOffersByArtistStore.get(userId)) || [];
    const offerIdx = artistOffers.findIndex(o => o.id === offerId);
    if (offerIdx === -1) {
      return c.json({ success: false, error: 'Offer not found' }, 404);
    }

    const original = artistOffers[offerIdx];
    if (original.status !== 'accepted') {
      return c.json(
        { success: false, error: `Can complete only accepted offers (current: ${original.status})` },
        409,
      );
    }

    const now = new Date().toISOString();
    const updated: CollabOffer = { ...original, status: 'completed', updatedAt: now, completedAt: now };
    await writeOfferAtomic(updated.artistId, updated.producerId, updated);

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
    const offer = await findOffer(offerId);
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
    const offer = await findOffer(offerId);
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

// ── GET /stats/:userId ──

app.get('/stats/:userId', requireAuth, requireOwner('userId'), async (c) => {
  const userId = c.req.param('userId');
  try {
    const asArtist: CollabOffer[] = (await collabOffersByArtistStore.get(userId)) || [];
    const asProducer: CollabOffer[] = (await collabOffersByProducerStore.get(userId)) || [];

    const all = [...asArtist, ...asProducer];
    const stats = {
      totalReceived: asArtist.length,
      totalSent: asProducer.length,
      pending: all.filter(o => o.status === 'pending').length,
      accepted: all.filter(o => o.status === 'accepted').length,
      declined: all.filter(o => o.status === 'declined').length,
      inDiscussion: all.filter(o => o.status === 'discussion').length,
      completed: all.filter(o => o.status === 'completed').length,
    };

    return c.json({ success: true, stats });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export default app;
