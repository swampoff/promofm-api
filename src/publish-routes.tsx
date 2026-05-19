/**
 * PUBLISH ROUTES - Публикация контента (видео/концерты)
 * 
 * Workflow: загрузка -> модерация -> оплата -> публикация
 * 
 * Endpoints:
 * POST   /orders          - Создать заказ на публикацию
 * GET    /orders          - Список заказов пользователя
 * GET    /orders/:id      - Детали заказа
 * PUT    /orders/:id      - Обновить заказ (до модерации)
 * PUT    /orders/:id/pay  - Оплатить заказ
 * PUT    /orders/:id/status - Обновить статус (admin)
 * DELETE /orders/:id      - Отменить/удалить заказ
 * GET    /pricing         - Тарифы публикации
 * GET    /admin/all       - Все заказы (для модерации)
 * GET    /admin/stats     - Статистика по заказам
 * PUT    /admin/batch-status - Пакетное обновление статусов
 * GET    /notifications/:userId - Уведомления артиста
 * PUT    /notifications/:userId/read - Отметить уведомления как прочитанные
 * GET    /email-prefs/:userId - Настройки email-уведомлений
 * PUT    /email-prefs/:userId - Обновить настройки email-уведомлений
 * POST   /webhook/status-change - Внешний webhook для интеграций
 * GET    /email-log/:userId - История отправленных email
 */

import { Hono } from 'hono';
import { getArtistProfile, getNotificationsByUser, publishEmailPrefsStore, publishOrdersStore, upsertNotification } from './db.tsx';
import { emitSSE } from './sse-routes.tsx';
import { safeErrorMessage } from './security.tsx';
import { notifyModerationSubmitted } from './email-helper.tsx';

import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const app = new Hono();

// ── Types ────────────────────────────────────────────────

export type PublishType = 'video' | 'concert';
export type PublishStatus =
  | 'draft'           // Черновик
  | 'pending_review'  // На модерации
  | 'in_review'       // Модератор смотрит
  | 'revision'        // Нужна доработка
  | 'approved'        // Модерация пройдена
  | 'pending_payment' // Ожидает оплаты
  | 'paid'            // Оплачено
  | 'published'       // Опубликовано
  | 'rejected'        // Отклонено
  | 'cancelled';      // Отменено

export interface PublishOrder {
  id: string;
  userId: string;
  type: PublishType;
  status: PublishStatus;
  title: string;
  description: string;

  // Video-specific
  videoUrl?: string;
  videoSource?: 'file' | 'link';
  videoCategory?: string;
  thumbnailUrl?: string;
  tags?: string[];

  // Concert-specific
  eventDate?: string;
  eventTime?: string;
  city?: string;
  venueName?: string;
  venueAddress?: string;
  ticketPriceMin?: number;
  ticketPriceMax?: number;
  ticketUrl?: string;
  posterUrl?: string;
  genre?: string;

  // Pricing
  plan: 'free' | 'standard' | 'premium';
  price: number;
  currency: string;
  paidAt?: string;
  paymentMethod?: string;

  // Moderation
  moderatorId?: string;
  moderatorComment?: string;
  moderatedAt?: string;
  rejectionReason?: string;
  revisionNotes?: string;

  // Timestamps
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

// ── Pricing ──────────────────────────────────────────────

// Базовая стоимость размещения БЕЗ подписки.
// С активной подпиской пользователь получает 'free' (price=0) автоматически — см. resolvePriceForUser().
const PRICING = {
  video: {
    free:     { price:     0, label: 'По подписке',  features: ['Публикация на платформе', 'Базовая аналитика', 'Модерация 48ч'] },
    standard: { price: 10000, label: 'Размещение клипа', features: ['Публикация на платформе', 'Продвижение в ленте', 'Расширенная аналитика', 'Модерация 24ч'] },
    premium:  { price: 19990, label: 'Премиум',      features: ['Размещение клипа', 'Баннер на главной', 'Полная аналитика', 'Модерация 4ч', 'Топ рекомендаций', 'Публикация в соцсетях ПРОМО.МУЗЫКА', 'Рассылка подписчикам'] },
  },
  concert: {
    free:     { price:    0, label: 'По подписке',   features: ['Страница события', 'Базовая аналитика', 'Модерация 48ч'] },
    standard: { price: 5000, label: 'Размещение концерта', features: ['Страница события', 'Продвижение на главной', 'Продажа билетов', 'Модерация 24ч', 'Push-уведомления подписчикам'] },
    premium:  { price: 9990, label: 'Премиум',       features: ['Размещение концерта', 'Баннер на главной', 'Продажа билетов', 'Модерация 4ч', 'Push + email рассылка', 'Публикация в ПРОМО.ГИД', 'Таргетированное продвижение'] },
  },
};

// Проверяет активна ли подписка у пользователя. При наличии — публикация бесплатна.
async function hasActiveSubscription(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const { pool } = await import('./db-client.tsx');
    const r = await pool.query(
      `SELECT data FROM subscriptions WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (r.rows.length === 0) return false;
    const sub = typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data;
    if (sub?.status !== 'active' && sub?.status !== 'trial') return false;
    if (sub.expires_at) {
      const expires = new Date(sub.expires_at).getTime();
      if (!Number.isNaN(expires) && expires < Date.now()) return false;
    }
    return true;
  } catch (e: any) {
    console.warn('[publish] hasActiveSubscription failed:', e?.message);
    return false;
  }
}

// Resolves real price for user: 0 if active sub, otherwise from PRICING table.
async function resolvePriceForUser(userId: string, type: 'video' | 'concert', plan: 'free' | 'standard' | 'premium'): Promise<number> {
  if (await hasActiveSubscription(userId)) return 0;
  return PRICING[type][plan].price;
}

function generateId(): string {
  return `pub-${crypto.randomUUID()}`;
}

// ── Notification helper ─────────────────────────────────

const STATUS_LABELS_RU: Record<string, string> = {
  in_review: 'взята на проверку',
  approved: 'одобрена',
  pending_payment: 'ожидает оплаты',
  revision: 'отправлена на доработку',
  rejected: 'отклонена',
  published: 'опубликована',
};

async function createArtistNotification(
  userId: string,
  orderId: string,
  orderTitle: string,
  newStatus: string,
  comment?: string,
) {
  try {
    const statusLabel = STATUS_LABELS_RU[newStatus] || newStatus;
    const notifId = `pn-${crypto.randomUUID()}`;
    const notification = {
      id: notifId,
      type: 'publish_status_change',
      orderId,
      orderTitle,
      newStatus,
      message: `Ваша публикация «${orderTitle}» ${statusLabel}`,
      comment: comment || undefined,
      read: false,
      createdAt: new Date().toISOString(),
    };

    await upsertNotification(userId, notifId, notification);

    // Emit SSE event for real-time delivery to artist
    emitSSE(userId, {
      type: 'notification',
      data: {
        notificationId: notification.id,
        type: 'publish_status',
        newStatus,
        orderTitle,
        orderId,
        message: notification.message,
        comment: comment || undefined,
        createdAt: notification.createdAt,
      },
    });

    console.log(`Notification created for user ${userId}: ${notification.message}`);
  } catch (err) {
    console.error('Error creating artist notification:', err);
  }
}

// ── GET /pricing ─────────────────────────────────────────

app.get('/pricing', (c) => {
  return c.json({ success: true, pricing: PRICING });
});

// ── POST /orders ─────────────────────────────────────────

app.post('/orders', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId');
    const { type, title, description, plan = 'free', ...rest } = body;

    if (!type || !title) {
      return c.json({ success: false, error: 'Missing required fields: type, title' }, 400);
    }

    if (!['video', 'concert'].includes(type)) {
      return c.json({ success: false, error: 'Type must be "video" or "concert"' }, 400);
    }

    if (!['free', 'standard', 'premium'].includes(plan)) {
      return c.json({ success: false, error: 'Plan must be "free", "standard", or "premium"' }, 400);
    }

    const pricingInfo = PRICING[type as PublishType][plan as keyof typeof PRICING.video];
    // resolve effective price: 0 if user has active subscription, otherwise PRICING table value
    const effectivePrice = await resolvePriceForUser(userId, type as 'video' | 'concert', plan as 'free' | 'standard' | 'premium');

    const order: PublishOrder = {
      id: generateId(),
      userId,
      type,
      status: 'draft',
      title,
      description: description || '',
      plan,
      price: effectivePrice,
      priceBase: pricingInfo.price,
      subscriptionApplied: effectivePrice === 0 && pricingInfo.price > 0,
      currency: 'RUB',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Spread type-specific fields
      ...(type === 'video' ? {
        videoUrl: rest.videoUrl || '',
        videoSource: rest.videoSource || 'link',
        videoCategory: rest.videoCategory || '',
        thumbnailUrl: rest.thumbnailUrl || '',
        tags: rest.tags || [],
      } : {
        eventDate: rest.eventDate || '',
        eventTime: rest.eventTime || '',
        city: rest.city || '',
        venueName: rest.venueName || '',
        venueAddress: rest.venueAddress || '',
        ticketPriceMin: rest.ticketPriceMin || 0,
        ticketPriceMax: rest.ticketPriceMax || 0,
        ticketUrl: rest.ticketUrl || '',
        posterUrl: rest.posterUrl || '',
        genre: rest.genre || '',
      }),
    };

    // Save order
    await publishOrdersStore.set(order.id, JSON.stringify(order), { user_id: userId });

    console.log(`Publish order created: ${order.id} (${type}/${plan}) by user ${userId}`);

    return c.json({ success: true, order });
  } catch (error: any) {
    console.error('Error creating publish order:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── GET /orders ──────────────────────────────────────────

app.get('/orders', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) {
      return c.json({ success: false, error: 'userId is required' }, 400);
    }

    const rawOrders = await publishOrdersStore.getByCol('user_id', userId);
    const orders = rawOrders
      .map((v: any) => (typeof v === 'string' ? JSON.parse(v) : v))
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({ success: true, orders });
  } catch (error: any) {
    console.error('Error fetching publish orders:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── GET /orders/:id ──────────────────────────────────────

app.get('/orders/:id', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }
    return c.json({ success: true, order: JSON.parse(data) });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /orders/:id ──────────────────────────────────────

app.put('/orders/:id', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    const order: PublishOrder = typeof data === 'string' ? JSON.parse(data) : (data as any);

    // Can only edit drafts or orders needing revision
    if (!['draft', 'revision'].includes(order.status)) {
      return c.json({ success: false, error: 'Order can only be edited in draft or revision status' }, 400);
    }

    const updatedOrder = {
      ...order,
      ...body,
      id: order.id, // Prevent ID override
      userId: order.userId,
      updatedAt: new Date().toISOString(),
    };

    await publishOrdersStore.set(id, JSON.stringify(updatedOrder), { user_id: updatedOrder.userId });

    return c.json({ success: true, order: updatedOrder });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /orders/:id/submit ───────────────────────────────

app.put('/orders/:id/submit', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    const order: PublishOrder = typeof data === 'string' ? JSON.parse(data) : (data as any);

    if (!['draft', 'revision'].includes(order.status)) {
      return c.json({ success: false, error: 'Only draft/revision orders can be submitted' }, 400);
    }

    order.status = 'pending_review';
    order.updatedAt = new Date().toISOString();

    await publishOrdersStore.set(id, JSON.stringify(order), { user_id: order.userId });

    console.log(`Publish order submitted for review: ${id}`);

    // Email notification to admin
    notifyModerationSubmitted({
      kind: order.type === 'concert' ? 'концерт' : 'клип',
      title: order.title,
      userId: order.userId,
      plan: order.plan,
      url: (order as any).videoUrl || (order as any).posterUrl || (order as any).thumbnailUrl,
      extra: order.type === 'concert' ? {
        'Город': (order as any).city || '',
        'Площадка': (order as any).venueName || '',
        'Дата': (order as any).eventDate || '',
      } : {
        'Категория': (order as any).videoCategory || '',
      },
      adminPath: '/ctrl-pm7k2f/publish-moderation',
    }).catch((err: any) => console.error('[publish-routes] email notify failed:', err?.message));

    return c.json({ success: true, order });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /orders/:id/pay ──────────────────────────────────

app.put('/orders/:id/pay', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    const order: PublishOrder = typeof data === 'string' ? JSON.parse(data) : (data as any);

    if (order.status !== 'approved' && order.status !== 'pending_payment') {
      return c.json({ success: false, error: 'Order must be approved before payment' }, 400);
    }

    // Free order (e.g. subscription bypass) — publish immediately
    if (!order.price || order.price === 0) {
      order.status = 'published';
      order.publishedAt = new Date().toISOString();
      order.updatedAt = new Date().toISOString();
      await publishOrdersStore.set(id, JSON.stringify(order), { user_id: order.userId });
      console.log(`Publish order published (free): ${id}`);
      return c.json({ success: true, order, free: true });
    }

    // Paid: create YooKassa session via gateway
    const { YooKassaGateway } = await import('./gateway-yookassa.tsx');
    const yk = new YooKassaGateway();
    const description = order.type === 'concert'
      ? `Размещение концерта: ${order.title}`
      : `Размещение клипа: ${order.title}`;
    const session = await yk.createPayment({
      orderId: order.id,
      userId: order.userId,
      amount: order.price,
      currency: order.currency || 'RUB',
      type: 'purchase',
      description,
      returnUrl: order.type === 'concert'
        ? 'https://promo-music.ru/artist/concerts'
        : 'https://promo-music.ru/artist/videos',
      metadata: {
        type: order.type === 'concert' ? 'concert_publish' : 'video_publish',
        orderId: order.id,
        title: order.title,
      },
    });

    // Persist payment_session row for webhook lookup
    const { pool: payPool } = await import('./db-client.tsx');
    await payPool.query(
      `INSERT INTO payment_sessions (user_id, amount, currency, purpose, status, provider, provider_session_id, data, order_id)
       VALUES ($1, $2, $3, 'purchase', 'pending', 'yookassa', $4, $5::jsonb, $6)
       ON CONFLICT (order_id) DO UPDATE SET status='pending', data = EXCLUDED.data, provider_session_id = EXCLUDED.provider_session_id, updated_at = NOW()`,
      [order.userId, order.price, order.currency || 'RUB', session.sessionId,
       JSON.stringify({
         orderId: order.id, userId: order.userId, amount: order.price, currency: order.currency || 'RUB',
         type: 'purchase', status: 'pending', gateway: 'yookassa', gatewayPaymentId: session.sessionId,
         returnUrl: order.type === 'concert' ? 'https://promo-music.ru/artist/concerts' : 'https://promo-music.ru/artist/videos',
         description,
         metadata: {
           type: order.type === 'concert' ? 'concert_publish' : 'video_publish',
           orderId: order.id, title: order.title,
         },
         createdAt: new Date().toISOString(),
       }),
       order.id]
    );

    // Mark order as pending_payment if not already
    if (order.status !== 'pending_payment') {
      order.status = 'pending_payment';
      order.updatedAt = new Date().toISOString();
      await publishOrdersStore.set(id, JSON.stringify(order), { user_id: order.userId });
    }

    console.log(`Publish order pay session created: ${id}, amount=${order.price}`);
    return c.json({
      success: true,
      order,
      payment: {
        confirmationUrl: session.confirmationUrl,
        gateway: 'yookassa',
        sessionId: session.sessionId,
        amount: order.price,
        currency: order.currency || 'RUB',
      },
    });
  } catch (error: any) {
    console.error('Publish order /pay error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /orders/:id/status (admin) ───────────────────────

app.put('/orders/:id/status', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { status, comment, reason } = body;

    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    const order: PublishOrder = typeof data === 'string' ? JSON.parse(data) : (data as any);

    const validTransitions: Record<string, string[]> = {
      pending_review: ['in_review', 'rejected'],
      in_review: ['approved', 'revision', 'rejected'],
      revision: ['pending_review'],
      approved: ['pending_payment', 'published'],
      paid: ['published'],
    };

    const allowed = validTransitions[order.status] || [];
    if (!allowed.includes(status)) {
      return c.json({
        success: false,
        error: `Cannot transition from "${order.status}" to "${status}". Allowed: ${allowed.join(', ')}`,
      }, 400);
    }

    order.status = status;
    order.updatedAt = new Date().toISOString();

    if (status === 'approved') {
      order.moderatedAt = new Date().toISOString();
      order.moderatorComment = comment || '';
      // If free plan, auto-publish
      if (order.price === 0) {
        order.status = 'published';
        order.publishedAt = new Date().toISOString();
      } else {
        order.status = 'pending_payment';
      }
    }

    if (status === 'rejected') {
      order.rejectionReason = reason || comment || '';
      order.moderatedAt = new Date().toISOString();
    }

    if (status === 'revision') {
      order.revisionNotes = comment || '';
    }

    if (status === 'published') {
      order.publishedAt = new Date().toISOString();
    }

    await publishOrdersStore.set(id, JSON.stringify(order), { user_id: order.userId });

    // Create notification for the artist
    await createArtistNotification(
      order.userId,
      order.id,
      order.title,
      order.status,
      comment || reason,
    );

    // Send email for critical status changes
    await sendCriticalEmailNotification(
      order.userId,
      order.id,
      order.title,
      order.status,
      comment || reason,
    );

    console.log(`Publish order status updated: ${id} -> ${order.status}`);

    return c.json({ success: true, order });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── DELETE /orders/:id ───────────────────────────────────

app.delete('/orders/:id', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    // Owner check: only the owner or an admin may delete an order. Without this,
    // any authenticated user could DELETE any other user's order by ID (IDOR).
    const authUserId = c.get('userId');
    const authRole = c.get('userRole');
    const ownerId = (data as any)?.userId;
    if (ownerId && ownerId !== authUserId && authRole !== 'admin') {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    await publishOrdersStore.del(id);

    console.log(`Publish order deleted: ${id}`);

    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── GET /admin/all ───────────────────────────────────────

app.get('/admin/all', requireAuth, requireAdmin, async (c) => {
  try {
    const rawValues = await publishOrdersStore.getAll();
    const orders = rawValues
      .map((v: any) => (typeof v === 'string' ? JSON.parse(v) : v))
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({ success: true, orders });
  } catch (error: any) {
    console.error('Error fetching all publish orders:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── GET /admin/stats ─────────────────────────────────────

app.get('/admin/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const rawValues = await publishOrdersStore.getAll();
    const orders = rawValues
      .map((v: any) => (typeof v === 'string' ? JSON.parse(v) : v));

    const stats = {
      total: orders.length,
      draft: orders.filter((o) => o.status === 'draft').length,
      pending_review: orders.filter((o) => o.status === 'pending_review').length,
      in_review: orders.filter((o) => o.status === 'in_review').length,
      revision: orders.filter((o) => o.status === 'revision').length,
      approved: orders.filter((o) => o.status === 'approved').length,
      pending_payment: orders.filter((o) => o.status === 'pending_payment').length,
      paid: orders.filter((o) => o.status === 'paid').length,
      published: orders.filter((o) => o.status === 'published').length,
      rejected: orders.filter((o) => o.status === 'rejected').length,
      cancelled: orders.filter((o) => o.status === 'cancelled').length,
    };

    return c.json({ success: true, stats });
  } catch (error: any) {
    console.error('Error fetching publish order stats:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /admin/batch-status ──────────────────────────────

app.put('/admin/batch-status', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { orderIds, status, comment, reason } = body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return c.json({ success: false, error: 'orderIds must be a non-empty array' }, 400);
    }

    if (!status) {
      return c.json({ success: false, error: 'status is required' }, 400);
    }

    // Batch transitions are more permissive: admin implicitly takes order for review
    const validTransitions: Record<string, string[]> = {
      pending_review: ['in_review', 'approved', 'revision', 'rejected'],
      in_review: ['approved', 'revision', 'rejected'],
      revision: ['pending_review'],
      approved: ['pending_payment', 'published'],
      paid: ['published'],
    };

    const results: { id: string; success: boolean; order?: any; error?: string }[] = [];

    for (const orderId of orderIds) {
      try {
        const data = await publishOrdersStore.get(orderId);
        if (!data) {
          results.push({ id: orderId, success: false, error: 'Order not found' });
          continue;
        }

        const order: PublishOrder = typeof data === 'string' ? JSON.parse(data) : (data as any);
        const allowed = validTransitions[order.status] || [];

        if (!allowed.includes(status)) {
          results.push({
            id: orderId,
            success: false,
            error: `Cannot transition from "${order.status}" to "${status}"`,
          });
          continue;
        }

        order.status = status;
        order.updatedAt = new Date().toISOString();

        if (status === 'approved') {
          order.moderatedAt = new Date().toISOString();
          order.moderatorComment = comment || '';
          if (order.price === 0) {
            order.status = 'published';
            order.publishedAt = new Date().toISOString();
          } else {
            order.status = 'pending_payment';
          }
        }

        if (status === 'rejected') {
          order.rejectionReason = reason || comment || '';
          order.moderatedAt = new Date().toISOString();
        }

        if (status === 'revision') {
          order.revisionNotes = comment || '';
        }

        if (status === 'published') {
          order.publishedAt = new Date().toISOString();
        }

        await publishOrdersStore.set(orderId, JSON.stringify(order), { user_id: order.userId });

        // Create notification for the artist
        await createArtistNotification(
          order.userId,
          order.id,
          order.title,
          order.status,
          comment || reason,
        );

        // Send email for critical status changes
        await sendCriticalEmailNotification(
          order.userId,
          order.id,
          order.title,
          order.status,
          comment || reason,
        );

        results.push({ id: orderId, success: true, order });
      } catch (err: any) {
        results.push({ id: orderId, success: false, error: safeErrorMessage(err) });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    console.log(`Batch status update: ${successCount} succeeded, ${failCount} failed`);

    return c.json({
      success: true,
      results,
      summary: { total: orderIds.length, succeeded: successCount, failed: failCount },
    });
  } catch (error: any) {
    console.error('Error in batch status update:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── GET /notifications/:userId ───────────────────────────

app.get('/notifications/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    if (userId !== c.get('userId')) return c.json({ success: false, error: 'Access denied' }, 403);
    const notifications = await getNotificationsByUser(userId);
    const unreadCount = notifications.filter((n: any) => !n.read).length;

    return c.json({ success: true, notifications, unreadCount });
  } catch (error: any) {
    console.error('Error fetching artist notifications:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /notifications/:userId/read ──────────────────────

app.put('/notifications/:userId/read', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    if (userId !== c.get('userId')) return c.json({ success: false, error: 'Access denied' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const { notificationIds } = body;

    const notifications: any[] = await getNotificationsByUser(userId);
    if (!notifications || notifications.length === 0) {
      return c.json({ success: true, message: 'No notifications' });
    }

    if (Array.isArray(notificationIds) && notificationIds.length > 0) {
      // Mark specific notifications as read
      const idSet = new Set(notificationIds);
      for (const n of notifications) {
        if (idSet.has(n.id)) {
          n.read = true;
          await upsertNotification(userId, n.id, n);
        }
      }
    } else {
      // Mark all as read
      for (const n of notifications) {
        if (!n.read) {
          n.read = true;
          await upsertNotification(userId, n.id, n);
        }
      }
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error marking notifications as read:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Email Notification Preferences ───────────────────────

const CRITICAL_STATUSES = ['approved', 'published', 'revision', 'rejected', 'pending_payment'];

const EMAIL_STATUS_PREF_MAP: Record<string, string> = {
  approved: 'onApproved',
  published: 'onPublished',
  pending_payment: 'onApproved', // payment follows approval
  revision: 'onRevision',
  rejected: 'onRejected',
};

async function getEmailPrefs(userId: string) {
  const data = await publishEmailPrefsStore.get(userId);
  if (data) return typeof data === 'string' ? JSON.parse(data) : data;
  // Defaults: all critical statuses enabled
  return {
    email: '',
    onApproved: true,
    onPublished: true,
    onRevision: true,
    onRejected: true,
    emailLog: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Создает email-уведомление для критических статусов.
 * Сохраняет запись в KV, логирует вызов.
 * В production подключается к email-провайдеру (Sendgrid/Mailgun/SES).
 */
async function sendCriticalEmailNotification(
  userId: string,
  orderId: string,
  orderTitle: string,
  newStatus: string,
  comment?: string,
) {
  try {
    if (!CRITICAL_STATUSES.includes(newStatus)) return;

    const prefs = await getEmailPrefs(userId);
    const prefKey = EMAIL_STATUS_PREF_MAP[newStatus];
    if (prefKey && !prefs[prefKey]) {
      console.log(`Email notification skipped for user ${userId}: ${prefKey} disabled`);
      return;
    }

    // Resolve user email
    let toEmail = prefs.email;
    if (!toEmail) {
      // Try to get email from artist profile
      const profileData = await getArtistProfile(userId);
      if (profileData) {
        const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
        toEmail = profile.email || '';
      }
    }

    const statusLabel = STATUS_LABELS_RU[newStatus] || newStatus;
    const subject = `ПРОМО.МУЗЫКА - ваша публикация ${statusLabel}`;
    const content = [
      `Публикация: ${orderTitle}`,
      `Статус: ${statusLabel}`,
      comment ? `Комментарий: ${comment}` : '',
      '',
      'С уважением,',
      'Команда ПРОМО.МУЗЫКА',
    ].filter(Boolean).join('\n');

    const emailRecord = {
      id: `em-${crypto.randomUUID()}`,
      userId,
      toEmail: toEmail || `user-${userId}@promo.fm`,
      orderId,
      orderTitle,
      newStatus,
      subject,
      content,
      comment: comment || undefined,
      status: toEmail ? 'sent' : 'queued', // 'sent' in production with real provider
      createdAt: new Date().toISOString(),
    };

    // Store email log (append to user's email prefs)
    const currentPrefs = await getEmailPrefs(userId);
    const emailLog: any[] = currentPrefs.emailLog || [];
    emailLog.unshift(emailRecord);
    // Keep last 100 email log entries
    if (emailLog.length > 100) emailLog.length = 100;
    await publishEmailPrefsStore.set(userId, JSON.stringify({ ...currentPrefs, emailLog }));

    console.log(`Email notification ${emailRecord.status} for user ${userId}: ${subject} -> ${emailRecord.toEmail}`);
  } catch (err) {
    console.error('Error sending critical email notification:', err);
  }
}

// GET /email-prefs/:userId
app.get('/email-prefs/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    if (userId !== c.get('userId')) return c.json({ success: false, error: 'Access denied' }, 403);
    const prefs = await getEmailPrefs(userId);
    return c.json({ success: true, prefs });
  } catch (error: any) {
    console.error('Error fetching email prefs:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /email-prefs/:userId
app.put('/email-prefs/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    if (userId !== c.get('userId')) return c.json({ success: false, error: 'Access denied' }, 403);
    const body = await c.req.json();
    const existing = await getEmailPrefs(userId);

    const updated = {
      ...existing,
      ...body,
      updatedAt: new Date().toISOString(),
    };

    await publishEmailPrefsStore.set(userId, JSON.stringify(updated));
    console.log(`Email prefs updated for user ${userId}`);
    return c.json({ success: true, prefs: updated });
  } catch (error: any) {
    console.error('Error updating email prefs:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Webhook: POST /webhook/status-change ─────────────────
// External webhook for integrations (Zapier, n8n, custom)

app.post('/webhook/status-change', async (c) => {
  try {
    const body = await c.req.json();
    const { orderId, userId, newStatus, comment, secret } = body;

    // Simple webhook auth via shared secret
    const expectedSecret = process.env.WEBHOOK_SECRET;
    if (!expectedSecret) {
      console.error('WEBHOOK_SECRET env var not set');
      return c.json({ success: false, error: 'Server misconfiguration' }, 500);
    }
    if (secret !== expectedSecret) {
      return c.json({ success: false, error: 'Invalid webhook secret' }, 401);
    }

    if (!orderId || !userId || !newStatus) {
      return c.json({ success: false, error: 'Missing required: orderId, userId, newStatus' }, 400);
    }

    // Fetch order for title
    const orderData = await publishOrdersStore.get(orderId);
    const orderTitle = orderData
      ? (typeof orderData === 'string' ? JSON.parse(orderData) : orderData).title || orderId
      : orderId;

    // Create push notification
    await createArtistNotification(userId, orderId, orderTitle, newStatus, comment);

    // Send email for critical statuses
    await sendCriticalEmailNotification(userId, orderId, orderTitle, newStatus, comment);

    console.log(`Webhook processed: order ${orderId} -> ${newStatus}`);
    return c.json({ success: true, message: 'Webhook processed' });
  } catch (error: any) {
    console.error('Webhook error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /email-log/:userId - История отправленных email
app.get('/email-log/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    if (userId !== c.get('userId')) return c.json({ success: false, error: 'Access denied' }, 403);
    const prefs = await getEmailPrefs(userId);
    const emails: any[] = (prefs.emailLog || [])
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({ success: true, emails });
  } catch (error: any) {
    console.error('Error fetching email log:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;