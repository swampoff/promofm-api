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

const PRICING = {
  video: {
    free: { price: 0, label: 'Бесплатно', features: ['Публикация на платформе', 'Базовая аналитика', 'Модерация 48ч'] },
    standard: { price: 990, label: 'Стандарт', features: ['Публикация на платформе', 'Продвижение в ленте', 'Расширенная аналитика', 'Модерация 24ч', 'Попадание в рекомендации'] },
    premium: { price: 2990, label: 'Премиум', features: ['Публикация на платформе', 'Продвижение в ленте + баннер', 'Полная аналитика', 'Модерация 4ч', 'Топ рекомендаций', 'Публикация в соцсетях ПРОМО.МУЗЫКА', 'Рассылка подписчикам'] },
  },
  concert: {
    free: { price: 0, label: 'Бесплатно', features: ['Страница события', 'Базовая аналитика', 'Модерация 48ч'] },
    standard: { price: 1490, label: 'Стандарт', features: ['Страница события', 'Продвижение на главной', 'Продажа билетов', 'Модерация 24ч', 'Push-уведомления подписчикам'] },
    premium: { price: 4990, label: 'Премиум', features: ['Страница события', 'Баннер на главной', 'Продажа билетов', 'Модерация 4ч', 'Push + email рассылка', 'Публикация в ПРОМО.ГИД', 'Таргетированное продвижение'] },
  },
};

function generateId(): string {
  return `pub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    const notifId = `pn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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

app.post('/orders', async (c) => {
  try {
    const body = await c.req.json();
    const { userId, type, title, description, plan = 'free', ...rest } = body;

    if (!userId || !type || !title) {
      return c.json({ success: false, error: 'Missing required fields: userId, type, title' }, 400);
    }

    if (!['video', 'concert'].includes(type)) {
      return c.json({ success: false, error: 'Type must be "video" or "concert"' }, 400);
    }

    if (!['free', 'standard', 'premium'].includes(plan)) {
      return c.json({ success: false, error: 'Plan must be "free", "standard", or "premium"' }, 400);
    }

    const pricingInfo = PRICING[type as PublishType][plan as keyof typeof PRICING.video];

    const order: PublishOrder = {
      id: generateId(),
      userId,
      type,
      status: 'draft',
      title,
      description: description || '',
      plan,
      price: pricingInfo.price,
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
    return c.json({ success: false, error: `Failed to create order: ${error.message}` }, 500);
  }
});

// ── GET /orders ──────────────────────────────────────────

app.get('/orders', async (c) => {
  try {
    const userId = c.req.query('userId');
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

app.get('/orders/:id', async (c) => {
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

app.put('/orders/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    const order: PublishOrder = JSON.parse(data);

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

app.put('/orders/:id/submit', async (c) => {
  try {
    const id = c.req.param('id');
    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    const order: PublishOrder = JSON.parse(data);

    if (!['draft', 'revision'].includes(order.status)) {
      return c.json({ success: false, error: 'Only draft/revision orders can be submitted' }, 400);
    }

    order.status = 'pending_review';
    order.updatedAt = new Date().toISOString();

    await publishOrdersStore.set(id, JSON.stringify(order), { user_id: order.userId });

    console.log(`Publish order submitted for review: ${id}`);

    return c.json({ success: true, order });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /orders/:id/pay ──────────────────────────────────

app.put('/orders/:id/pay', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    const order: PublishOrder = JSON.parse(data);

    if (order.status !== 'approved' && order.status !== 'pending_payment') {
      return c.json({ success: false, error: 'Order must be approved before payment' }, 400);
    }

    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    order.paymentMethod = body.paymentMethod || 'card';
    order.updatedAt = new Date().toISOString();

    // Auto-publish for free plans
    if (order.price === 0) {
      order.status = 'published';
      order.publishedAt = new Date().toISOString();
    }

    await publishOrdersStore.set(id, JSON.stringify(order), { user_id: order.userId });

    console.log(`Publish order paid: ${id}, method: ${order.paymentMethod}`);

    return c.json({ success: true, order });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /orders/:id/status (admin) ───────────────────────

app.put('/orders/:id/status', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { status, comment, reason } = body;

    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    const order: PublishOrder = JSON.parse(data);

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

app.delete('/orders/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const data = await publishOrdersStore.get(id);
    if (!data) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }

    await publishOrdersStore.del(id);

    console.log(`Publish order deleted: ${id}`);

    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── GET /admin/all ───────────────────────────────────────

app.get('/admin/all', async (c) => {
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

app.get('/admin/stats', async (c) => {
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

app.put('/admin/batch-status', async (c) => {
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

        const order: PublishOrder = JSON.parse(data);
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

app.get('/notifications/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
    const notifications = await getNotificationsByUser(userId);
    const unreadCount = notifications.filter((n: any) => !n.read).length;

    return c.json({ success: true, notifications, unreadCount });
  } catch (error: any) {
    console.error('Error fetching artist notifications:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /notifications/:userId/read ──────────────────────

app.put('/notifications/:userId/read', async (c) => {
  try {
    const userId = c.req.param('userId');
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
      id: `em_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
app.get('/email-prefs/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
    const prefs = await getEmailPrefs(userId);
    return c.json({ success: true, prefs });
  } catch (error: any) {
    console.error('Error fetching email prefs:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /email-prefs/:userId
app.put('/email-prefs/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
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
app.get('/email-log/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
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