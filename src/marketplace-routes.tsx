/**
 * MARKETPLACE ROUTES - API для маркетплейса битов и услуг
 *
 * KV ключи:
 * - beat:public:{id}              - данные бита (seeded в demo-seed)
 * - producer_service:public:{id}  - данные услуги (seeded в demo-seed)
 * - beat_purchase:{purchaseId}    - запись о покупке
 * - beat_purchases_by_user:{uid}  - JSON-массив purchaseId для покупателя
 * - beat_purchases_by_prod:{uid}  - JSON-массив purchaseId для продюсера
 * - beat_favorites:{uid}          - JSON-массив beatId
 * - beat_review:{beatId}:{revId}  - отзыв на бит
 * - service_order:{orderId}       - заказ услуги
 * - service_orders_by_client:{uid}  - JSON-массив orderId
 * - service_orders_by_producer:{uid} - JSON-массив orderId
 * - stats:platform                - общая статистика (обновляется)
 * - contract:{orderId}             - контракт с этапами (milestones)
 * - digital_good:public:{id}       - цифровой товар
 * - digital_purchase:{purchaseId}  - покупка цифрового товара
 * - digital_purchases_by_user:{uid} - JSON-массив purchaseId
 *
 * Endpoints - Beats:
 * - GET    /beats              - Публичный каталог с фильтрами
 * - GET    /beats/stats        - Статистика маркетплейса битов
 * - GET    /beats/:id          - Детали бита
 * - POST   /beats              - Загрузить бит (auth)
 * - PUT    /beats/:id          - Обновить бит (auth, owner)
 * - DELETE /beats/:id          - Удалить бит (auth, owner)
 * - POST   /beats/:id/purchase - Купить бит (auth)
 * - POST   /beats/:id/favorite - Добавить/убрать из избранного (auth)
 * - GET    /beats/favorites    - Избранное пользователя (auth)
 * - GET    /beats/purchases    - Покупки пользователя (auth)
 *
 * Endpoints - Services:
 * - GET    /services           - Публичный каталог с фильтрами
 * - GET    /services/stats     - Статистика маркетплейса услуг
 * - GET    /services/:id       - Детали услуги
 * - POST   /services/:id/order - Заказать услугу (auth)
 * - GET    /orders             - Заказы пользователя (auth)
 * - PUT    /orders/:id/status  - Обновить статус заказа (auth, producer)
 *
 * Endpoints - Contracts:
 * - POST   /orders/:id/contract          - Создать контракт с этапами
 * - GET    /contracts/:id                - Детали контракта
 * - PUT    /contracts/:id/milestones/:mid - Обновить статус этапа
 *
 * Endpoints - Digital Goods:
 * - GET    /digital-goods                - Каталог цифровых товаров
 * - GET    /digital-goods/:id            - Детали товара
 * - POST   /digital-goods                - Создать товар (auth, producer)
 * - POST   /digital-goods/:id/purchase   - Купить товар (auth)
 */

import { Hono } from 'hono';
import { pool as mpPool } from './db-client.tsx';
import {
  deleteBeat, getBeat, getBeats, upsertBeat, upsertNotification,
  // beat_reviews (native cols since migration 060):
  getBeatReview, upsertBeatReview, listBeatReviewsByBeat,
  getBeatReviewsAggregateStats, findBeatReviewByUser,
  // beat_favorites — row-per-favorite (migration 062):
  listBeatFavorites, toggleBeatFavorite,
  contractsStore, digitalGoodsStore,
  platformRevenueLogStore, platformStatsStore,
  producerServicesStore, serviceOrdersByClientStore,
  serviceOrdersByProducerStore, serviceOrdersStore,
} from './db.tsx';
import { emitSSE } from './sse-routes.tsx';
import { getRevenueStats, recordRevenue } from './platform-revenue.tsx';

import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const app = new Hono();

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Записать комиссию маркетплейса через единую систему platform-revenue.tsx
 * Делегирует в recordRevenue(), которая пишет в ledger, баланс и revenue log.
 */
async function recordPlatformCommission(
  type: 'beat' | 'digital_good' | 'service',
  itemTitle: string,
  totalPrice: number,
  commission: number,
  producerPayout: number,
  meta: Record<string, any>,
) {
  await recordRevenue({
    channel: `marketplace_${type}`,
    description: itemTitle,
    grossAmount: totalPrice,
    platformRevenue: commission,
    payoutAmount: producerPayout,
    commissionRate: 0.10,
    payerId: meta.buyerId || '',
    payerName: meta.buyerName || 'Покупатель',
    payeeId: meta.producerId,
    payeeName: meta.producerName,
    metadata: meta,
  });
}

/** SSE уведомление: KV-персистенция + real-time доставка (fire-and-forget) */
async function sendSSE(userId: string, event: string, data: any) {
  try {
    // 1. Сохранить в KV для истории уведомлений
    const notifId = genId('notif');
    await upsertNotification(userId, notifId, JSON.stringify({
      id: notifId,
      userId,
      type: event,
      title: data.title || event,
      message: data.message || '',
      data,
      read: false,
      createdAt: nowIso(),
    }));
    // 2. Real-time доставка через SSE stream
    emitSSE(userId, { type: event, data });
  } catch (e) {
    console.log('sendSSE marketplace error:', e);
  }
}

/** Собрать все биты из KV по префиксу */
async function getAllBeats(): Promise<any[]> {
  try {
    const entries = await getBeats();
    if (!entries || entries.length === 0) return [];
    return entries.map((raw: any) => {
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    }).filter(Boolean);
  } catch (e) {
    console.log('getAllBeats error:', e);
    return [];
  }
}

/** Собрать все публичные услуги из DB */
async function getAllServices(): Promise<any[]> {
  try {
    const entries = await producerServicesStore.getAll();
    if (!entries || entries.length === 0) return [];
    return entries.map((raw: any) => {
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    }).filter(Boolean);
  } catch (e) {
    console.log('getAllServices error:', e);
    return [];
  }
}

// ═══════════════════════════════════════════════
//  B E A T S
// ═══════════════════════════════════════════════

/**
 * GET /beats - Публичный каталог битов
 * Query: search, genre, key, bpm_min, bpm_max, price_min, price_max, sort, limit, offset, producerId
 */
app.get('/beats', async (c) => {
  try {
    let beats = await getAllBeats();

    // Только активные
    beats = beats.filter(b => b.status === 'active');

    const search = c.req.query('search')?.toLowerCase();
    const genre = c.req.query('genre');
    const keyFilter = c.req.query('key');
    const bpmMin = c.req.query('bpm_min') ? Number(c.req.query('bpm_min')) : null;
    const bpmMax = c.req.query('bpm_max') ? Number(c.req.query('bpm_max')) : null;
    const priceMin = c.req.query('price_min') ? Number(c.req.query('price_min')) : null;
    const priceMax = c.req.query('price_max') ? Number(c.req.query('price_max')) : null;
    const producerId = c.req.query('producerId');
    const sort = c.req.query('sort') || 'popular';
    const limit = Math.min(Number(c.req.query('limit') || 50), 100);
    const offset = Number(c.req.query('offset') || 0);

    // Filters
    if (search) {
      beats = beats.filter(b =>
        b.title?.toLowerCase().includes(search) ||
        b.producer?.toLowerCase().includes(search) ||
        b.genre?.toLowerCase().includes(search) ||
        (b.tags || []).some((t: string) => t.toLowerCase().includes(search))
      );
    }
    if (genre) beats = beats.filter(b => b.genre === genre);
    if (keyFilter) beats = beats.filter(b => b.key === keyFilter);
    if (bpmMin != null) beats = beats.filter(b => b.bpm >= bpmMin);
    if (bpmMax != null) beats = beats.filter(b => b.bpm <= bpmMax);
    if (producerId) beats = beats.filter(b => b.producerId === producerId);

    const basePrice = (b: any) => b.licenseTypes?.basic || b.price || 0;
    if (priceMin != null) beats = beats.filter(b => basePrice(b) >= priceMin);
    if (priceMax != null) beats = beats.filter(b => basePrice(b) <= priceMax);

    // Sort
    switch (sort) {
      case 'new': beats.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()); break;
      case 'popular': beats.sort((a, b) => (b.plays || 0) - (a.plays || 0)); break;
      case 'rating': beats.sort((a, b) => (b.rating || 0) - (a.rating || 0)); break;
      case 'price_asc': beats.sort((a, b) => basePrice(a) - basePrice(b)); break;
      case 'price_desc': beats.sort((a, b) => basePrice(b) - basePrice(a)); break;
      default: beats.sort((a, b) => (b.plays || 0) - (a.plays || 0));
    }

    const total = beats.length;
    const paged = beats.slice(offset, offset + limit);

    return c.json({
      success: true,
      data: paged,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  } catch (error) {
    console.log('GET /beats error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /beats/stats - Статистика маркетплейса битов
 */
app.get('/beats/stats', async (c) => {
  try {
    const beats = await getAllBeats();
    const active = beats.filter(b => b.status === 'active');
    const totalPlays = active.reduce((s, b) => s + (b.plays || 0), 0);
    const totalSold = active.reduce((s, b) => s + (b.purchases || 0), 0);
    const producers = new Set(active.map(b => b.producerId)).size;
    const avgRating = active.length > 0
      ? +(active.reduce((s, b) => s + (b.rating || 0), 0) / active.length).toFixed(1)
      : 0;
    const genres = [...new Set(active.map(b => b.genre).filter(Boolean))];

    return c.json({
      success: true,
      data: {
        totalBeats: active.length,
        totalPlays,
        totalSold,
        activeProducers: producers,
        avgRating,
        genres,
      },
    });
  } catch (error) {
    console.log('GET /beats/stats error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /beats/favorites - Избранные биты пользователя
 */
app.get('/beats/favorites', requireAuth, async (c) => {
  try {
    const userId = c.get('userId'); // IDOR fix: from JWT
    if (!userId) return c.json({ success: false, error: 'userId required' }, 400);

    const favIds = await listBeatFavorites(userId);
    return c.json({ success: true, data: favIds });
  } catch (error) {
    console.log('GET /beats/favorites error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /beats/purchases - Покупки пользователя
 */
app.get('/beats/purchases', requireAuth, async (c) => {
  try {
    const userId = c.get('userId'); // IDOR fix: from JWT
    if (!userId) return c.json({ success: false, error: 'userId required' }, 400);

    const r = await mpPool.query(
      `SELECT id, beat_id, buyer_id, producer_id, amount, license_type, status, data, created_at
       FROM beat_purchases WHERE buyer_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    const purchases = r.rows.map((row: any) => ({
      id: row.id,
      beatId: row.beat_id,
      buyerId: row.buyer_id,
      producerId: row.producer_id,
      price: parseFloat(row.amount),
      licenseType: row.license_type,
      status: row.status,
      ...(row.data || {}),
      createdAt: row.created_at,
    }));
    return c.json({ success: true, data: purchases });
  } catch (error) {
    console.log('GET /beats/purchases error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /beats/:id - Детали бита
 */
app.get('/beats/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const raw = await getBeat(id);
    if (!raw) return c.json({ success: false, error: 'Beat not found' }, 404);
    const beat = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // Увеличить просмотры
    beat.plays = (beat.plays || 0) + 1;
    await upsertBeat(id, JSON.stringify(beat));

    return c.json({ success: true, data: beat });
  } catch (error) {
    console.log('GET /beats/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /beats - Загрузить новый бит (для продюсеров)
 */
app.post('/beats', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { producer, title, genre, bpm, key, tags, duration, price, licenseTypes } = body;
    // owner from JWT — body.producerId ignored (IDOR + PUT/DELETE
    // owner-check would 403 the creator otherwise)
    const producerId = c.get('userId');

    if (!title || !genre || !bpm || !key || !price) {
      return c.json({ success: false, error: 'title, genre, bpm, key, price required' }, 400);
    }

    const id = genId('beat');
    const beat = {
      id,
      title,
      producer: producer || 'Unknown',
      producerId,
      genre,
      bpm: Number(bpm),
      key,
      tags: tags || [],
      duration: duration || '3:00',
      price: Number(price),
      plays: 0,
      purchases: 0,
      rating: 0,
      status: 'active',
      licenseTypes: licenseTypes || {
        basic: Number(price),
        premium: Number(price) * 3,
        exclusive: Number(price) * 10,
      },
      createdAt: nowIso(),
    };

    await upsertBeat(id, JSON.stringify(beat));

    // Обновить статистику
    try {
      const statsRaw = await platformStatsStore.get('platform');
      if (statsRaw) {
        const stats = typeof statsRaw === 'string' ? JSON.parse(statsRaw) : statsRaw;
        stats.totalBeats = (stats.totalBeats || 0) + 1;
        stats.updatedAt = nowIso();
        await platformStatsStore.set('platform', JSON.stringify(stats));
      }
    } catch {}

    return c.json({ success: true, data: beat });
  } catch (error) {
    console.log('POST /beats error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /beats/:id - Обновить бит
 */
app.put('/beats/:id', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const userId = c.get('userId'); // IDOR fix: from JWT

    const raw = await getBeat(id);
    if (!raw) return c.json({ success: false, error: 'Beat not found' }, 404);
    const beat = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (beat.producerId !== userId) {
      return c.json({ success: false, error: 'Not authorized to edit this beat' }, 403);
    }

    // Обновляемые поля
    const updatable = ['title', 'genre', 'bpm', 'key', 'tags', 'duration', 'price', 'licenseTypes', 'status'];
    for (const field of updatable) {
      if (body[field] !== undefined) {
        beat[field] = body[field];
      }
    }
    beat.updatedAt = nowIso();

    await upsertBeat(id, JSON.stringify(beat));
    return c.json({ success: true, data: beat });
  } catch (error) {
    console.log('PUT /beats/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /beats/:id - Удалить бит
 */
app.delete('/beats/:id', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const userId = c.get('userId'); // IDOR fix: from JWT

    const raw = await getBeat(id);
    if (!raw) return c.json({ success: false, error: 'Beat not found' }, 404);
    const beat = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (beat.producerId !== userId) {
      return c.json({ success: false, error: 'Not authorized to delete this beat' }, 403);
    }

    await deleteBeat(id);

    // Обновить статистику
    try {
      const statsRaw = await platformStatsStore.get('platform');
      if (statsRaw) {
        const stats = typeof statsRaw === 'string' ? JSON.parse(statsRaw) : statsRaw;
        stats.totalBeats = Math.max(0, (stats.totalBeats || 1) - 1);
        stats.updatedAt = nowIso();
        await platformStatsStore.set('platform', JSON.stringify(stats));
      }
    } catch {}

    return c.json({ success: true, message: 'Beat deleted' });
  } catch (error) {
    console.log('DELETE /beats/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /beats/:id/purchase - Купить бит
 * Body: { buyerId, buyerName, licenseType: 'basic'|'premium'|'exclusive' }
 */
app.post('/beats/:id/purchase', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const buyerId = c.get('userId'); // IDOR fix: from JWT, not body
    const { buyerName, licenseType, returnUrl } = body;

    if (!buyerId || !licenseType) {
      return c.json({ success: false, error: 'licenseType required' }, 400);
    }

    const raw = await getBeat(id);
    if (!raw) return c.json({ success: false, error: 'Beat not found' }, 404);
    const beat = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (beat.status !== 'active') {
      return c.json({ success: false, error: 'Beat is not available for purchase' }, 400);
    }

    const price = beat.licenseTypes?.[licenseType] || beat.price || 0;
    if (!price) {
      return c.json({ success: false, error: 'Invalid license type' }, 400);
    }

    // Создаём платёжную сессию YooKassa. Покупка создаётся в webhook после оплаты.
    const { getGateway } = await import('./payment-gateway.tsx');
    const { upsertPaymentSession } = await import('./db.tsx');
    const orderId = crypto.randomUUID();
    const safeReturnUrl = returnUrl || 'https://promo-music.ru/marketplace/beats';

    const gw = getGateway('yookassa');
    const result = await gw.createPayment({
      amount: price,
      currency: 'RUB',
      description: `Покупка бита: ${beat.title} (${licenseType})`,
      gateway: 'yookassa',
      userId: buyerId,
      orderId,
      returnUrl: safeReturnUrl,
      metadata: {
        type: 'beat_purchase',
        beatId: id,
        licenseType,
        buyerName: buyerName || 'Покупатель',
      },
      savePaymentMethod: false,
      type: 'purchase',
    });

    await upsertPaymentSession(orderId, {
      orderId,
      userId: buyerId,
      gateway: 'yookassa',
      gatewayPaymentId: result.sessionId,
      amount: price,
      currency: 'RUB',
      status: 'pending',
      type: 'purchase',
      description: `Покупка бита: ${beat.title} (${licenseType})`,
      metadata: {
        type: 'beat_purchase',
        beatId: id,
        licenseType,
        buyerName: buyerName || 'Покупатель',
      },
      savePaymentMethod: false,
      confirmationUrl: result.confirmationUrl,
      returnUrl: safeReturnUrl,
      createdAt: new Date().toISOString(),
    });

    return c.json({
      success: true,
      data: {
        orderId,
        confirmationUrl: result.confirmationUrl,
        message: `Перейдите к оплате бита "${beat.title}" (${licenseType})`,
      },
    });
  } catch (error) {
    console.log('POST /beats/:id/purchase error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /beats/:id/favorite - Toggle избранное
 * Body: { userId }
 */
app.post('/beats/:id/favorite', requireAuth, async (c) => {
  try {
    const beatId = c.req.param('id');
    const userId = c.get('userId'); // IDOR fix: from JWT, not body

    if (!userId) return c.json({ success: false, error: 'Authorization required' }, 401);

    // Atomic toggle (INSERT ON CONFLICT DO NOTHING + проверка rowCount).
    // Раньше: get array → modify → set (race window для 2 concurrent toggles).
    const { added } = await toggleBeatFavorite(userId, beatId);

    // Обновить likes на бите
    try {
      const beatRaw = await getBeat(beatId);
      if (beatRaw) {
        const beat = typeof beatRaw === 'string' ? JSON.parse(beatRaw) : beatRaw;
        beat.likes = Math.max(0, (beat.likes || 0) + (added ? 1 : -1));
        await upsertBeat(beatId, JSON.stringify(beat));
      }
    } catch {}

    return c.json({ success: true, data: { added, favorites: favs } });
  } catch (error) {
    console.log('POST /beats/:id/favorite error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
//  B E A T   R E V I E W S
// ═══════════════════════════════════════════════

/**
 * GET /beats/:id/reviews - Отзывы на бит
 * Query: limit, offset
 */
app.get('/beats/:id/reviews', async (c) => {
  try {
    const beatId = c.req.param('id');
    const limit = Math.min(Number(c.req.query('limit') || 50), 100);
    const offset = Number(c.req.query('offset') || 0);

    // Native idx_beat_reviews_beat_created + SQL aggregation —
    // 2 SELECT'а взамен «get index → N+1 reads → JS aggregate».
    const [reviews, stats] = await Promise.all([
      listBeatReviewsByBeat(beatId, { limit, offset }),
      getBeatReviewsAggregateStats(beatId),
    ]);

    return c.json({
      success: true,
      data: {
        reviews,
        stats: { total: stats.total, avgRating: stats.avgRating, distribution: stats.distribution },
      },
      pagination: { total: stats.total, limit, offset, hasMore: offset + limit < stats.total },
    });
  } catch (error) {
    console.log('GET /beats/:id/reviews error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /beats/:id/review - Оставить отзыв на бит
 * Body: { userId, userName, rating (1-5), title?, text, licenseType? }
 * Валидация: пользователь должен иметь покупку этого бита
 */
app.post('/beats/:id/review', requireAuth, async (c) => {
  try {
    const beatId = c.req.param('id');
    const body = await c.req.json();
    const userId = c.get('userId'); // IDOR fix: from JWT
    const { userName, rating, title, text, licenseType } = body;

    if (!userId || !rating || !text) {
      return c.json({ success: false, error: 'rating and text required' }, 400);
    }

    if (rating < 1 || rating > 5) {
      return c.json({ success: false, error: 'Rating must be between 1 and 5' }, 400);
    }

    // Проверить, что бит существует
    const beatRaw = await getBeat(beatId);
    if (!beatRaw) return c.json({ success: false, error: 'Beat not found' }, 404);
    const beat = typeof beatRaw === 'string' ? JSON.parse(beatRaw) : beatRaw;

    // Проверить, что пользователь купил бит
    const purchaseCheck = await mpPool.query(
      `SELECT license_type FROM beat_purchases WHERE buyer_id = $1 AND beat_id = $2 LIMIT 1`,
      [userId, beatId]
    );
    const hasPurchased = purchaseCheck.rows.length > 0;
    const purchaseLicense = purchaseCheck.rows[0]?.license_type || '';

    if (!hasPurchased) {
      return c.json({ success: false, error: 'Only buyers can leave reviews' }, 403);
    }

    // DB-level dedup: UNIQUE (beat_id, user_id) constraint (migration 060)
    // ловит 2 concurrent отзыва от одного user'а. Pre-check для friendly 409.
    const existingByUser = await findBeatReviewByUser(beatId, userId);
    if (existingByUser) {
      return c.json({ success: false, error: 'You already reviewed this beat' }, 409);
    }

    // Создать отзыв
    const reviewId = genId('brev');
    const review = {
      id: reviewId,
      beatId,
      userId,
      userName: userName || 'Покупатель',
      rating: Math.min(5, Math.max(1, Number(rating))),
      title: title || '',
      text,
      licenseType: licenseType || purchaseLicense || 'basic',
      helpful: 0,
      createdAt: nowIso(),
    };

    try {
      await upsertBeatReview(beatId, reviewId, review);
    } catch (e: any) {
      // UNIQUE constraint violation (concurrent insert) — race protection.
      if (String(e?.message || '').includes('uq_beat_reviews_beat_user')) {
        return c.json({ success: false, error: 'You already reviewed this beat' }, 409);
      }
      throw e;
    }

    // Single SQL aggregate взамен loop через index + N+1 reads.
    const stats = await getBeatReviewsAggregateStats(beatId);
    beat.rating = stats.avgRating;
    beat.reviewsCount = stats.total;
    await upsertBeat(beatId, JSON.stringify(beat));

    // SSE уведомление продюсеру
    await sendSSE(beat.producerId, 'beat_review_new', {
      title: 'Новый отзыв на бит',
      message: `${userName || 'Покупатель'} оценил "${beat.title}" на ${rating} из 5`,
      reviewId,
      beatId,
      rating,
    });

    return c.json({
      success: true,
      data: {
        review,
        newRating: stats.avgRating,
        totalReviews: stats.total,
        message: 'Отзыв успешно опубликован',
      },
    });
  } catch (error) {
    console.log('POST /beats/:id/review error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /beats/:id/reviews/:reviewId/helpful - Отметить отзыв как полезный
 * Body: { userId }
 */
app.post('/beats/:id/reviews/:reviewId/helpful', requireAuth, async (c) => {
  try {
    const beatId = c.req.param('id');
    const reviewId = c.req.param('reviewId');
    const userId = c.get('userId'); // IDOR fix: from JWT

    if (!userId) return c.json({ success: false, error: 'Authorization required' }, 401);

    const review = await getBeatReview(beatId, reviewId);
    if (!review) return c.json({ success: false, error: 'Review not found' }, 404);

    // Toggle helpful — get-modify-set остаётся (jsonb массив helpful_users
    // в native col). Race remaining: 2 concurrent vote'а могут потерять
    // друг друга. Acceptable для helpful counter (не критический).
    const helpfulUsers: string[] = review.helpfulUsers || [];
    const idx = helpfulUsers.indexOf(userId);
    if (idx === -1) {
      helpfulUsers.push(userId);
      review.helpful = (review.helpful || 0) + 1;
    } else {
      helpfulUsers.splice(idx, 1);
      review.helpful = Math.max(0, (review.helpful || 1) - 1);
    }
    review.helpfulUsers = helpfulUsers;

    await upsertBeatReview(beatId, reviewId, review);

    return c.json({
      success: true,
      data: { helpful: review.helpful, isHelpful: idx === -1 },
    });
  } catch (error) {
    console.log('POST /beats/:id/reviews/:reviewId/helpful error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
//  S E R V I C E S
// ═══════════════════════════════════════════════

/**
 * GET /services - Публичный каталог услуг
 * Query: search, type, price_min, price_max, sort, limit, offset, producerId
 */
app.get('/services', async (c) => {
  try {
    let services = await getAllServices();

    // Только активные
    services = services.filter(s => s.status === 'active');

    const search = c.req.query('search')?.toLowerCase();
    const typeFilter = c.req.query('type');
    const priceMin = c.req.query('price_min') ? Number(c.req.query('price_min')) : null;
    const priceMax = c.req.query('price_max') ? Number(c.req.query('price_max')) : null;
    const producerId = c.req.query('producerId');
    const sort = c.req.query('sort') || 'recommended';
    const limit = Math.min(Number(c.req.query('limit') || 50), 100);
    const offset = Number(c.req.query('offset') || 0);

    // Filters
    if (search) {
      services = services.filter(s =>
        s.title?.toLowerCase().includes(search) ||
        s.description?.toLowerCase().includes(search) ||
        s.producer?.toLowerCase().includes(search) ||
        s.type?.toLowerCase().includes(search)
      );
    }
    if (typeFilter) services = services.filter(s => s.type === typeFilter);
    if (producerId) services = services.filter(s => s.producerId === producerId);
    if (priceMin != null) services = services.filter(s => (s.basePrice || s.price || 0) >= priceMin);
    if (priceMax != null) services = services.filter(s => (s.basePrice || s.price || 0) <= priceMax);

    // Sort
    switch (sort) {
      case 'recommended': services.sort((a, b) => ((b.rating || 0) * (b.orders || 0)) - ((a.rating || 0) * (a.orders || 0))); break;
      case 'popular': services.sort((a, b) => (b.orders || 0) - (a.orders || 0)); break;
      case 'rating': services.sort((a, b) => (b.rating || 0) - (a.rating || 0)); break;
      case 'price_asc': services.sort((a, b) => (a.basePrice || a.price || 0) - (b.basePrice || b.price || 0)); break;
      case 'price_desc': services.sort((a, b) => (b.basePrice || b.price || 0) - (a.basePrice || a.price || 0)); break;
      default: services.sort((a, b) => ((b.rating || 0) * (b.orders || 0)) - ((a.rating || 0) * (a.orders || 0)));
    }

    const total = services.length;
    const paged = services.slice(offset, offset + limit);

    return c.json({
      success: true,
      data: paged,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  } catch (error) {
    console.log('GET /services error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /services/stats - Статистика маркетплейса услуг
 */
app.get('/services/stats', async (c) => {
  try {
    const services = await getAllServices();
    const active = services.filter(s => s.status === 'active');
    const totalOrders = active.reduce((s, svc) => s + (svc.orders || 0), 0);
    const producers = new Set(active.map(s => s.producerId)).size;
    const avgRating = active.length > 0
      ? +(active.reduce((s, svc) => s + (svc.rating || 0), 0) / active.length).toFixed(1)
      : 0;
    const types = [...new Set(active.map(s => s.type).filter(Boolean))];

    return c.json({
      success: true,
      data: {
        totalServices: active.length,
        totalOrders,
        activeProducers: producers,
        avgRating,
        serviceTypes: types,
      },
    });
  } catch (error) {
    console.log('GET /services/stats error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /services/:id - Детали услуги
 */
app.get('/services/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const raw = await producerServicesStore.get(id);
    if (!raw) return c.json({ success: false, error: 'Service not found' }, 404);
    const service = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return c.json({ success: true, data: service });
  } catch (error) {
    console.log('GET /services/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /services/:id/order - Заказать услугу
 * Body: { clientId, clientName, message, details, urgency }
 */
app.post('/services/:id/order', requireAuth, async (c) => {
  try {
    const serviceId = c.req.param('id');
    const body = await c.req.json();
    const clientId = c.get('userId'); // IDOR fix: from JWT
    const { clientName, message, details, urgency } = body;

    if (!clientId) {
      return c.json({ success: false, error: 'Authorization required' }, 401);
    }

    const raw = await producerServicesStore.get(serviceId);
    if (!raw) return c.json({ success: false, error: 'Service not found' }, 404);
    const service = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (service.status !== 'active') {
      return c.json({ success: false, error: 'Service is not available' }, 400);
    }

    const basePrice = service.basePrice || service.price || 0;
    const urgencyMult = urgency === 'urgent' ? 2 : urgency === 'fast' ? 1.5 : 1;
    const totalPrice = Math.round(basePrice * urgencyMult);
    const commission = Math.round(totalPrice * 0.1);
    const producerPayout = totalPrice - commission;

    const orderId = genId('sord');
    const order = {
      id: orderId,
      serviceId,
      serviceTitle: service.title,
      serviceType: service.type,
      producerId: service.producerId,
      producerName: service.producer,
      clientId,
      clientName: clientName || 'Клиент',
      message: message || '',
      details: details || '',
      urgency: urgency || 'normal',
      price: totalPrice,
      commission,
      producerPayout,
      status: 'pending', // pending -> accepted -> in_progress -> revision -> completed -> reviewed
      progress: 0,
      deliveryDays: service.deliveryDays || 5,
      deadline: null,
      createdAt: nowIso(),
    };

    await serviceOrdersStore.set(orderId, JSON.stringify(order));

    // Индекс клиента
    const clientRaw = await serviceOrdersByClientStore.get(clientId);
    const clientOrders: string[] = clientRaw
      ? (typeof clientRaw === 'string' ? JSON.parse(clientRaw) : clientRaw)
      : [];
    clientOrders.unshift(orderId);
    await serviceOrdersByClientStore.set(clientId, JSON.stringify(clientOrders));

    // Индекс продюсера
    const prodRaw = await serviceOrdersByProducerStore.get(service.producerId);
    const prodOrders: string[] = prodRaw
      ? (typeof prodRaw === 'string' ? JSON.parse(prodRaw) : prodRaw)
      : [];
    prodOrders.unshift(orderId);
    await serviceOrdersByProducerStore.set(service.producerId, JSON.stringify(prodOrders));

    // SSE уведомление продюсеру
    await sendSSE(service.producerId, 'service_order_new', {
      title: 'Новый заказ',
      message: `${clientName || 'Клиент'} заказал "${service.title}" за ${totalPrice.toLocaleString()} ₽`,
      orderId,
      serviceId,
      price: totalPrice,
    });

    return c.json({
      success: true,
      data: {
        order,
        message: `Заказ "${service.title}" создан`,
      },
    });
  } catch (error) {
    console.log('POST /services/:id/order error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /orders - Заказы пользователя (как клиент или продюсер)
 * Query: userId, role ('client'|'producer')
 */
app.get('/orders', requireAuth, async (c) => {
  try {
    const userId = c.get('userId'); // IDOR fix: from JWT
    const role = c.req.query('role') || 'client';

    if (!userId) return c.json({ success: false, error: 'userId required' }, 400);

    const raw = role === 'producer'
      ? await serviceOrdersByProducerStore.get(userId)
      : await serviceOrdersByClientStore.get(userId);
    const orderIds: string[] = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];

    const orders: any[] = [];
    for (const oid of orderIds) {
      const o = await serviceOrdersStore.get(oid);
      if (o) orders.push(typeof o === 'string' ? JSON.parse(o) : o);
    }

    return c.json({ success: true, data: orders });
  } catch (error) {
    console.log('GET /orders error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /orders/:id/status - Обновить статус заказа
 * Body: { producerId, status, progress?, message? }
 * Статусы: pending -> accepted -> in_progress -> revision -> completed
 */
app.put('/orders/:id/status', requireAuth, async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const userId = c.get('userId'); // IDOR fix: from JWT
    const { status, progress, message } = body;

    const raw = await serviceOrdersStore.get(orderId);
    if (!raw) return c.json({ success: false, error: 'Order not found' }, 404);
    const order = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // Проверка владельца (продюсер или клиент)
    if (order.producerId !== userId && order.clientId !== userId) {
      return c.json({ success: false, error: 'Not authorized' }, 403);
    }

    const validTransitions: Record<string, string[]> = {
      'pending': ['accepted', 'rejected'],
      'accepted': ['in_progress'],
      'in_progress': ['revision', 'completed'],
      'revision': ['in_progress', 'completed'],
    };

    if (status && validTransitions[order.status] && !validTransitions[order.status].includes(status)) {
      return c.json({ success: false, error: `Cannot transition from ${order.status} to ${status}` }, 400);
    }

    if (status) order.status = status;
    if (progress !== undefined) order.progress = Math.min(100, Math.max(0, Number(progress)));
    if (message) order.statusMessage = message;
    order.updatedAt = nowIso();

    // При принятии - установить дедлайн
    if (status === 'accepted') {
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + (order.deliveryDays || 5));
      order.deadline = deadline.toISOString();
    }

    // При завершении - обновить счётчик за��азов услуги
    if (status === 'completed') {
      order.completedAt = nowIso();
      order.progress = 100;

      try {
        const svcRaw = await producerServicesStore.get(order.serviceId);
        if (svcRaw) {
          const svc = typeof svcRaw === 'string' ? JSON.parse(svcRaw) : svcRaw;
          svc.orders = (svc.orders || 0) + 1;
          await producerServicesStore.set(order.serviceId, JSON.stringify(svc));
        }
      } catch {}

      // Записать комиссию платформы при прямом завершении (без контракта)
      const existingContract = await contractsStore.get(orderId);
      if (!existingContract) {
        await recordPlatformCommission(
          'service',
          order.serviceTitle,
          order.price,
          order.commission,
          order.producerPayout,
          {
            producerId: order.producerId,
            producerName: order.producerName,
            buyerId: order.clientId,
            buyerName: order.clientName,
            orderId,
          },
        );
      }
    }

    await serviceOrdersStore.set(orderId, JSON.stringify(order));

    // SSE уведомление клиенту
    const statusLabels: Record<string, string> = {
      'accepted': 'принят',
      'rejected': 'отклонён',
      'in_progress': 'в работе',
      'revision': 'на ревизии',
      'completed': 'завершён',
    };

    if (status) {
      await sendSSE(order.clientId, 'service_order_update', {
        title: 'Обновление заказа',
        message: `Заказ "${order.serviceTitle}" ${statusLabels[status] || status}`,
        orderId,
        status,
      });
    }

    return c.json({ success: true, data: order });
  } catch (error) {
    console.log('PUT /orders/:id/status error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
//  C O N T R A C T S  /  M I L E S T O N E S
// ═══════════════════════════════════════════════

/**
 * POST /orders/:id/contract - Создать контракт с этапами из принятого заказа
 * Body: { milestones: [{ title, description, amount, dueDate }] }
 */
app.post('/orders/:id/contract', requireAuth, async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { milestones } = body;

    if (!milestones || !Array.isArray(milestones) || milestones.length === 0) {
      return c.json({ success: false, error: 'At least one milestone is required' }, 400);
    }

    const orderRaw = await serviceOrdersStore.get(orderId);
    if (!orderRaw) return c.json({ success: false, error: 'Order not found' }, 404);
    const order = typeof orderRaw === 'string' ? JSON.parse(orderRaw) : orderRaw;

    if (!['accepted', 'in_progress'].includes(order.status)) {
      return c.json({ success: false, error: 'Order must be accepted or in progress to create contract' }, 400);
    }

    // Проверить, нет ли уже контракта
    const existingRaw = await contractsStore.get(orderId);
    if (existingRaw) {
      return c.json({ success: false, error: 'Contract already exists for this order' }, 409);
    }

    const totalAmount = milestones.reduce((s: number, m: any) => s + (Number(m.amount) || 0), 0);

    const contractId = genId('ctr');
    const contract = {
      id: contractId,
      orderId,
      serviceTitle: order.serviceTitle,
      producerId: order.producerId,
      producerName: order.producerName,
      clientId: order.clientId,
      clientName: order.clientName,
      totalAmount,
      paidAmount: 0,
      status: 'active' as string, // active | completed | cancelled
      milestones: milestones.map((m: any, idx: number) => ({
        id: genId('ms'),
        index: idx,
        title: m.title || `Этап ${idx + 1}`,
        description: m.description || '',
        amount: Number(m.amount) || 0,
        dueDate: m.dueDate || null,
        status: 'pending' as string, // pending | in_progress | submitted | approved | revision
        paidAt: null,
        completedAt: null,
        createdAt: nowIso(),
      })),
      createdAt: nowIso(),
    };

    await contractsStore.set(orderId, JSON.stringify(contract));

    // SSE уведомление клиенту
    await sendSSE(order.clientId, 'service_order_update', {
      title: 'Контракт создан',
      message: `Продюсер составил контракт для "${order.serviceTitle}" (${milestones.length} этапов)`,
      orderId,
      contractId,
    });

    return c.json({ success: true, data: contract });
  } catch (error) {
    console.log('POST /orders/:id/contract error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /contracts/:id - Детали контракта по orderId
 */
app.get('/contracts/:id', requireAuth, async (c) => {
  try {
    const orderId = c.req.param('id');
    const raw = await contractsStore.get(orderId);
    if (!raw) return c.json({ success: false, error: 'Contract not found' }, 404);
    const contract = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return c.json({ success: true, data: contract });
  } catch (error) {
    console.log('GET /contracts/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /contracts/:id/milestones/:mid - Обновить статус этапа
 * Body: { action: 'start' | 'submit' | 'approve' | 'revision', userId }
 * 
 * Transitions:
 *   pending -> in_progress (producer: start)
 *   in_progress -> submitted (producer: submit)
 *   submitted -> approved (client: approve - triggers payment)
 *   submitted -> revision (client: revision)
 *   revision -> in_progress (producer: start)
 */
app.put('/contracts/:id/milestones/:mid', requireAuth, async (c) => {
  try {
    const orderId = c.req.param('id');
    const mid = c.req.param('mid');
    const body = await c.req.json();
    const userId = c.get('userId'); // IDOR fix: from JWT
    const { action } = body;

    if (!action || !userId) {
      return c.json({ success: false, error: 'action required' }, 400);
    }

    const raw = await contractsStore.get(orderId);
    if (!raw) return c.json({ success: false, error: 'Contract not found' }, 404);
    const contract = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (contract.status !== 'active') {
      return c.json({ success: false, error: 'Contract is not active' }, 400);
    }

    const milestone = contract.milestones.find((m: any) => m.id === mid);
    if (!milestone) {
      return c.json({ success: false, error: 'Milestone not found' }, 404);
    }

    const validActions: Record<string, { from: string[]; to: string; role: string }> = {
      start: { from: ['pending', 'revision'], to: 'in_progress', role: 'producer' },
      submit: { from: ['in_progress'], to: 'submitted', role: 'producer' },
      approve: { from: ['submitted'], to: 'approved', role: 'client' },
      revision: { from: ['submitted'], to: 'revision', role: 'client' },
    };

    const transition = validActions[action];
    if (!transition) {
      return c.json({ success: false, error: `Unknown action: ${action}` }, 400);
    }

    if (!transition.from.includes(milestone.status)) {
      return c.json({ success: false, error: `Cannot ${action} from status ${milestone.status}` }, 400);
    }

    // Role check
    if (transition.role === 'producer' && userId !== contract.producerId) {
      return c.json({ success: false, error: 'Only producer can perform this action' }, 403);
    }
    if (transition.role === 'client' && userId !== contract.clientId) {
      return c.json({ success: false, error: 'Only client can perform this action' }, 403);
    }

    milestone.status = transition.to;
    milestone.updatedAt = nowIso();

    // При approve - эмуляция оплаты
    if (action === 'approve') {
      milestone.paidAt = nowIso();
      milestone.completedAt = nowIso();
      contract.paidAmount = (contract.paidAmount || 0) + milestone.amount;

      // Проверить, все ли этапы approved
      const allApproved = contract.milestones.every((m: any) => m.status === 'approved');
      if (allApproved) {
        contract.status = 'completed';
        contract.completedAt = nowIso();

        // Завершить заказ тоже
        const orderRaw = await serviceOrdersStore.get(orderId);
        if (orderRaw) {
          const order = typeof orderRaw === 'string' ? JSON.parse(orderRaw) : orderRaw;
          order.status = 'completed';
          order.progress = 100;
          order.completedAt = nowIso();
          await serviceOrdersStore.set(orderId, JSON.stringify(order));
        }
      }

      // SSE: уведомить продюсера об оплате
      await sendSSE(contract.producerId, 'service_order_update', {
        title: 'Этап одобрен',
        message: `Клиент одобрил этап "${milestone.title}" - оплата ${milestone.amount.toLocaleString()} ₽`,
        orderId,
        milestoneId: mid,
        amount: milestone.amount,
      });

      // Записать комиссию платформы за этап
      const msCommission = Math.round(milestone.amount * 0.1);
      const msPayout = milestone.amount - msCommission;
      await recordPlatformCommission(
        'service',
        `${contract.serviceTitle} - ${milestone.title}`,
        milestone.amount,
        msCommission,
        msPayout,
        {
          producerId: contract.producerId,
          producerName: contract.producerName,
          buyerId: contract.clientId,
          buyerName: contract.clientName,
          orderId,
          milestoneId: mid,
          contractId: contract.id,
        },
      );
    } else if (action === 'submit') {
      // SSE: уведомить клиента о готовности этапа
      await sendSSE(contract.clientId, 'service_order_update', {
        title: 'Этап готов к проверке',
        message: `Продюсер завершил этап "${milestone.title}" - проверьте результат`,
        orderId,
        milestoneId: mid,
      });
    } else if (action === 'revision') {
      // SSE: уведомить продюсера о правках
      await sendSSE(contract.producerId, 'service_order_update', {
        title: 'Запрос на доработку',
        message: `Клиент запросил доработку этапа "${milestone.title}"`,
        orderId,
        milestoneId: mid,
      });
    }

    // Обновить прогресс заказа
    const approvedCount = contract.milestones.filter((m: any) => m.status === 'approved').length;
    const orderProgress = Math.round((approvedCount / contract.milestones.length) * 100);
    const orderRaw2 = await serviceOrdersStore.get(orderId);
    if (orderRaw2) {
      const order = typeof orderRaw2 === 'string' ? JSON.parse(orderRaw2) : orderRaw2;
      order.progress = orderProgress;
      await serviceOrdersStore.set(orderId, JSON.stringify(order));
    }

    await contractsStore.set(orderId, JSON.stringify(contract));

    return c.json({ success: true, data: contract });
  } catch (error) {
    console.log('PUT /contracts/:id/milestones/:mid error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
//  D I G I T A L   G O O D S
// ═══════════════════════════════════════════════

/** Собрать все цифровые товары из KV */
async function getAllDigitalGoods(): Promise<any[]> {
  try {
    const entries = await digitalGoodsStore.getAll();
    if (!entries || entries.length === 0) return [];
    return entries.map((raw: any) => {
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    }).filter(Boolean);
  } catch (e) {
    console.log('getAllDigitalGoods error:', e);
    return [];
  }
}

/**
 * GET /digital-goods - Каталог цифровых товаров
 * Query: search, category, price_min, price_max, sort, limit, offset, producerId
 */
app.get('/digital-goods', async (c) => {
  try {
    let goods = await getAllDigitalGoods();
    goods = goods.filter(g => g.status === 'active');

    const search = c.req.query('search')?.toLowerCase();
    const category = c.req.query('category');
    const priceMin = c.req.query('price_min') ? Number(c.req.query('price_min')) : null;
    const priceMax = c.req.query('price_max') ? Number(c.req.query('price_max')) : null;
    const producerId = c.req.query('producerId');
    const sort = c.req.query('sort') || 'popular';
    const limit = Math.min(Number(c.req.query('limit') || 50), 100);
    const offset = Number(c.req.query('offset') || 0);

    if (search) {
      goods = goods.filter(g =>
        g.title?.toLowerCase().includes(search) ||
        g.description?.toLowerCase().includes(search) ||
        g.producer?.toLowerCase().includes(search) ||
        (g.tags || []).some((t: string) => t.toLowerCase().includes(search))
      );
    }
    if (category) goods = goods.filter(g => g.category === category);
    if (producerId) goods = goods.filter(g => g.producerId === producerId);
    if (priceMin != null) goods = goods.filter(g => (g.price || 0) >= priceMin);
    if (priceMax != null) goods = goods.filter(g => (g.price || 0) <= priceMax);

    switch (sort) {
      case 'new': goods.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()); break;
      case 'popular': goods.sort((a, b) => (b.sales || 0) - (a.sales || 0)); break;
      case 'rating': goods.sort((a, b) => (b.rating || 0) - (a.rating || 0)); break;
      case 'price_asc': goods.sort((a, b) => (a.price || 0) - (b.price || 0)); break;
      case 'price_desc': goods.sort((a, b) => (b.price || 0) - (a.price || 0)); break;
      default: goods.sort((a, b) => (b.sales || 0) - (a.sales || 0));
    }

    const total = goods.length;
    const paged = goods.slice(offset, offset + limit);

    return c.json({
      success: true,
      data: paged,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  } catch (error) {
    console.log('GET /digital-goods error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /digital-goods/:id - Детали товара
 */
app.get('/digital-goods/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const raw = await digitalGoodsStore.get(id);
    if (!raw) return c.json({ success: false, error: 'Digital good not found' }, 404);
    const good = typeof raw === 'string' ? JSON.parse(raw) : raw;
    good.views = (good.views || 0) + 1;
    await digitalGoodsStore.set(id, JSON.stringify(good));
    return c.json({ success: true, data: good });
  } catch (error) {
    console.log('GET /digital-goods/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /digital-goods - Создать цифровой товар
 */
app.post('/digital-goods', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { producerId, producer, title, category, description, price, tags, fileSize, format } = body;

    if (!producerId || !title || !category || !price) {
      return c.json({ success: false, error: 'producerId, title, category, price required' }, 400);
    }

    const id = genId('dg');
    const good = {
      id,
      title,
      producer: producer || 'Unknown',
      producerId,
      category,
      description: description || '',
      price: Number(price),
      tags: tags || [],
      fileSize: fileSize || '0 MB',
      format: format || '',
      rating: 0,
      sales: 0,
      views: 0,
      status: 'active',
      createdAt: nowIso(),
    };

    await digitalGoodsStore.set(id, JSON.stringify(good));
    return c.json({ success: true, data: good });
  } catch (error) {
    console.log('POST /digital-goods error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /digital-goods/:id/purchase - Купить цифровой товар
 * Body: { buyerId, buyerName }
 */
app.post('/digital-goods/:id/purchase', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const buyerId = c.get('userId'); // IDOR fix: from JWT
    const { buyerName, returnUrl } = body;

    if (!buyerId) return c.json({ success: false, error: 'Authorization required' }, 401);

    const raw = await digitalGoodsStore.get(id);
    if (!raw) return c.json({ success: false, error: 'Digital good not found' }, 404);
    const good = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (good.status !== 'active') {
      return c.json({ success: false, error: 'Item is not available' }, 400);
    }

    // Создаём платёжную сессию YooKassa. Покупка создаётся в webhook после оплаты.
    const { getGateway } = await import('./payment-gateway.tsx');
    const { upsertPaymentSession } = await import('./db.tsx');
    const orderId = crypto.randomUUID();
    const safeReturnUrl = returnUrl || 'https://promo-music.ru/marketplace/digital';

    const gw = getGateway('yookassa');
    const result = await gw.createPayment({
      amount: good.price,
      currency: 'RUB',
      description: `Покупка: ${good.title}`,
      gateway: 'yookassa',
      userId: buyerId,
      orderId,
      returnUrl: safeReturnUrl,
      metadata: {
        type: 'digital_purchase',
        digitalGoodId: id,
        buyerName: buyerName || 'Покупатель',
      },
      savePaymentMethod: false,
      type: 'purchase',
    });

    await upsertPaymentSession(orderId, {
      orderId,
      userId: buyerId,
      gateway: 'yookassa',
      gatewayPaymentId: result.sessionId,
      amount: good.price,
      currency: 'RUB',
      status: 'pending',
      type: 'purchase',
      description: `Покупка: ${good.title}`,
      metadata: {
        type: 'digital_purchase',
        digitalGoodId: id,
        buyerName: buyerName || 'Покупатель',
      },
      savePaymentMethod: false,
      confirmationUrl: result.confirmationUrl,
      returnUrl: safeReturnUrl,
      createdAt: new Date().toISOString(),
    });

    return c.json({
      success: true,
      data: {
        orderId,
        confirmationUrl: result.confirmationUrl,
        message: `Перейдите к оплате "${good.title}"`,
      },
    });
  } catch (error) {
    console.log('POST /digital-goods/:id/purchase error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
//  A D M I N  -  M A R K E T P L A C E
// ═══════════════════════════════════════════════

/**
 * GET /admin/transactions - ВСЕ финансовые сделки платформы (для admin-панели)
 * Источник: platform:revenue:log (единый реестр из platform-revenue.tsx)
 * Query: channel (marketplace_beat|dj_booking|track_test|...), limit, offset
 */
app.get('/admin/transactions', requireAuth, requireAdmin, async (c) => {
  try {
    const raw = await platformRevenueLogStore.get('singleton');
    let txs: any[] = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];

    const channelFilter = c.req.query('type') || c.req.query('channel');
    if (channelFilter) txs = txs.filter(t => t.channel === channelFilter);

    txs.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

    const limit = Math.min(Number(c.req.query('limit') || 100), 500);
    const offset = Number(c.req.query('offset') || 0);
    const total = txs.length;
    const paged = txs.slice(offset, offset + limit);

    // Маппинг в формат, совместимый с фронтом
    const mapped = paged.map((t: any) => ({
      id: t.id,
      type: t.channel,
      itemTitle: t.description,
      totalPrice: t.grossAmount,
      commission: t.platformRevenue,
      producerPayout: t.payoutAmount,
      producerId: t.payeeId || '',
      producerName: t.payeeName || '-',
      buyerId: t.payerId,
      buyerName: t.payerName,
      status: t.status,
      createdAt: t.createdAt,
      orderId: t.metadata?.orderId,
      milestoneId: t.metadata?.milestoneId,
      contractId: t.metadata?.contractId,
    }));

    return c.json({
      success: true,
      data: mapped,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  } catch (error) {
    console.log('GET /admin/transactions error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /admin/stats - Единая статистика ВСЕХ доходов платформы
 * Данные из platform:revenue:log (все каналы: маркетплейс, букинг, тест трека и т.д.)
 */
app.get('/admin/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const stats = await getRevenueStats();
    return c.json({ success: true, data: stats });
  } catch (error) {
    console.log('GET /admin/stats error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default app;
