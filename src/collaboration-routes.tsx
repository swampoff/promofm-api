/**
 * COLLABORATION ROUTES - Producer-Artist сотрудничество
 * 
 * Продюсер предлагает биты/услуги артисту через систему предложений.
 * Артист может принять, отклонить или обсудить предложение.
 * 
 * KV Keys:
 *   collab_offers:{artistId}     -> CollabOffer[]
 *   collab_offers_by:{producerId} -> CollabOffer[]
 *   collab_chat:{offerId}        -> CollabMessage[]
 * 
 * Endpoints:
 * POST   /offers              - Создать предложение (producer)
 * GET    /offers/artist/:id   - Предложения для артиста
 * GET    /offers/producer/:id - Предложения от продюсера
 * PUT    /offers/:id/respond  - Ответить на предложение (artist)
 * GET    /chat/:offerId       - Сообщения по предложению
 * POST   /chat/:offerId       - Отправить сообщение
 * GET    /stats/:userId       - Статистика коллабораций
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import { collabMessagesStore, collabOffersByArtistStore, collabOffersByProducerStore } from './db.tsx';
import { emitSSE } from './sse-routes.tsx';

import { requireAuth } from './auth-middleware.tsx';

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

// ── POST /offers - Создать предложение ──

app.post('/offers', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get('userId'); // IDOR fix: from JWT
    const { producerName, artistId, artistName, type, title, description, price, audioPreviewUrl, bpm, key: musicKey, genre, tags, deadline } = body;

    if (!artistId || !title) {
      return c.json({ success: false, error: 'artistId, title required' }, 400);
    }

    const offer: CollabOffer = {
      id: genId('offer'),
      producerId,
      producerName: producerName || 'Продюсер',
      producerAvatar: body.producerAvatar,
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Сохраняем для артиста
    const artistKey = `collab_offers:${artistId}`;
    const artistOffers: CollabOffer[] = (await collabOffersByArtistStore.get(artistId)) || [];
    artistOffers.unshift(offer);
    await collabOffersByArtistStore.set(artistId, artistOffers);

    // Сохраняем для продюсера
    const producerKey = `collab_offers_by:${producerId}`;
    const producerOffers: CollabOffer[] = (await collabOffersByProducerStore.get(offer.producerId)) || [];
    producerOffers.unshift(offer);
    await collabOffersByProducerStore.set(producerId, producerOffers);

    // SSE уведомление артисту
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

app.get('/offers/artist/:id', requireAuth, async (c) => {
  const artistId = c.req.param('id');
  try {
    const offers: CollabOffer[] = (await collabOffersByArtistStore.get(artistId)) || [];
    return c.json({ success: true, offers });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /offers/producer/:id ──

app.get('/offers/producer/:id', requireAuth, async (c) => {
  const producerId = c.req.param('id');
  try {
    const offers: CollabOffer[] = (await collabOffersByProducerStore.get(producerId)) || [];
    return c.json({ success: true, offers });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── PUT /offers/:id/respond ──

app.put('/offers/:id/respond', requireAuth, async (c) => {
  const offerId = c.req.param('id');
  try {
    const { artistId, status, comment } = await c.req.json();
    if (!artistId || !status) {
      return c.json({ success: false, error: 'artistId and status required' }, 400);
    }

    const validStatuses = ['accepted', 'declined', 'discussion'];
    if (!validStatuses.includes(status)) {
      return c.json({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, 400);
    }

    // Обновляем в списке артиста
    const artistKey = `collab_offers:${artistId}`;
    const artistOffers: CollabOffer[] = (await collabOffersByArtistStore.get(artistId)) || [];
    const offerIdx = artistOffers.findIndex(o => o.id === offerId);
    if (offerIdx === -1) {
      return c.json({ success: false, error: 'Offer not found' }, 404);
    }

    const offer = artistOffers[offerIdx];
    offer.status = status;
    offer.updatedAt = new Date().toISOString();
    offer.respondedAt = new Date().toISOString();
    if (comment) offer.artistComment = comment;
    artistOffers[offerIdx] = offer;
    await collabOffersByArtistStore.set(artistId, artistOffers);

    // Обновляем в списке продюсера
    const producerKey = `collab_offers_by:${offer.producerId}`;
    const producerOffers: CollabOffer[] = (await collabOffersByProducerStore.get(offer.producerId)) || [];
    const pIdx = producerOffers.findIndex(o => o.id === offerId);
    if (pIdx !== -1) {
      producerOffers[pIdx] = { ...offer };
      await collabOffersByProducerStore.set(offer.producerId, producerOffers);
    }

    // SSE уведомление продюсеру
    const statusLabel = status === 'accepted' ? 'принял' : status === 'declined' ? 'отклонил' : 'хочет обсудить';
    emitSSE(offer.producerId, {
      type: 'collab_response',
      data: {
        offerId,
        artistName: offer.artistName,
        status,
        message: `${offer.artistName} ${statusLabel} предложение "${offer.title}"`,
      },
    });

    return c.json({ success: true, offer });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /chat/:offerId ──

app.get('/chat/:offerId', requireAuth, async (c) => {
  const offerId = c.req.param('offerId');
  try {
    const messages: CollabMessage[] = (await collabMessagesStore.get(offerId)) || [];
    return c.json({ success: true, messages });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── POST /chat/:offerId ──

app.post('/chat/:offerId', requireAuth, async (c) => {
  const offerId = c.req.param('offerId');
  try {
    const { senderId, senderName, senderRole, text, attachment } = await c.req.json();
    if (!senderId || !text) {
      return c.json({ success: false, error: 'senderId and text required' }, 400);
    }

    const message: CollabMessage = {
      id: genId('cmsg'),
      offerId,
      senderId,
      senderName: senderName || 'User',
      senderRole: senderRole || 'artist',
      text,
      attachment,
      createdAt: new Date().toISOString(),
    };

    const chatKey = `collab_chat:${offerId}`;
    const messages: CollabMessage[] = (await collabMessagesStore.get(offerId)) || [];
    messages.push(message);
    await collabMessagesStore.set(offerId, messages);

    // Определяем получателя — ищем оффер в обоих KV по senderId
    let recipientId = '';
    // Если отправитель — продюсер, оффер лежит в его producer-store
    // Если артист — в его artist-store
    const senderOffers = senderRole === 'producer'
      ? ((await collabOffersByProducerStore.get(senderId)) || [])
      : ((await collabOffersByArtistStore.get(senderId)) || []);
    const matchedOffer = senderOffers.find((o: any) => o.id === offerId);
    if (matchedOffer) {
      recipientId = senderRole === 'producer' ? matchedOffer.artistId : matchedOffer.producerId;
    }

    if (recipientId) {
      emitSSE(recipientId, {
        type: 'collab_message',
        data: {
          offerId,
          senderName,
          text: text.length > 100 ? text.slice(0, 100) + '...' : text,
          message: `${senderName}: ${text.length > 60 ? text.slice(0, 60) + '...' : text}`,
        },
      });
    }

    return c.json({ success: true, message });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /stats/:userId ──

app.get('/stats/:userId', requireAuth, async (c) => {
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
