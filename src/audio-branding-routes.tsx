/**
 * AUDIO BRANDING ROUTES — Полный пайплайн аудиобрендирования
 *
 * Пайплайн: draft → pending_payment → paid → pending_review → in_production →
 *           recording → mixing → mastering → ready_for_review →
 *           client_approved → delivering → completed
 *
 * Endpoints:
 *   POST   /audio-branding/orders              — Создать заказ (venue/artist)
 *   GET    /audio-branding/orders              — Список заказов (admin: все, venue/artist: свои)
 *   GET    /audio-branding/orders/:id          — Заказ по ID
 *   POST   /audio-branding/orders/:id/pay      — Подтвердить оплату
 *   POST   /audio-branding/orders/:id/transition — Переход статуса (admin/expert/artist)
 *   POST   /audio-branding/orders/:id/revision  — Запросить доработку (клиент)
 *   POST   /audio-branding/orders/:id/approve   — Утвердить результат (клиент)
 *   POST   /audio-branding/orders/:id/upload    — Загрузить аудиофайл (admin/expert)
 *   DELETE /audio-branding/orders/:id          — Удалить заказ
 *   GET    /audio-branding/stats               — Статистика (admin)
 *   POST   /audio-branding/calculate-price     — Рассчитать цену
 */

import { Hono } from 'npm:hono@4';
import {
  audioBrandingOrdersStore,
  audioBrandingByStatusStore,
  audioBrandingByVenueStore,
  audioBrandingByArtistStore,
} from './db.tsx';
import { emitSSE } from './sse-routes.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { executeTransition, validateTransition, logAudit, calculateSLA } from './pipeline-engine.tsx';
import type { ActorRole } from './pipeline-engine.tsx';
import {
  AUDIO_BRANDING_CONTENT_PRICES,
  AUDIO_BRANDING_STYLE_PRICES,
  AUDIO_BRANDING_DURATION_MULTIPLIERS,
  AUDIO_BRANDING_VOICE_MULTIPLIERS,
  AUDIO_BRANDING_DISCOUNTS,
  calculateAudioBrandingPrice,
} from '../../src/constants/financial.ts';

const app = new Hono();

// ── Типы ──

export interface AudioBrandingOrder {
  id: string;
  // Заказчик (venue или artist)
  clientType: 'venue' | 'artist';
  clientId: string;
  clientName: string;
  // Контент
  contentType: keyof typeof AUDIO_BRANDING_CONTENT_PRICES;
  style: keyof typeof AUDIO_BRANDING_STYLE_PRICES;
  duration: number;       // секунды
  voiceType: string;
  briefText: string;      // описание от клиента
  references?: string[];  // ссылки на референсы
  // Финансы
  basePrice: number;
  discount: number;
  finalPrice: number;
  subscription: string;
  // Статус
  status: string;
  statusEnteredAt: string;
  // Исполнитель
  assignedExpertId?: string;
  assignedExpertName?: string;
  // Файлы
  audioFiles: { url: string; version: number; uploadedAt: string; description?: string }[];
  // Комменты
  adminComment?: string;
  clientFeedback?: string;
  revisionNotes?: string;
  revisionCount: number;
  // Timestamps
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
  completedAt?: string;
}

// ── Helpers ──

function notifyClient(order: AudioBrandingOrder, step: string, details?: string) {
  emitSSE(order.clientId, {
    type: 'notification',
    data: {
      title: `Аудиобренд: ${step}`,
      message: details || `Заказ «${order.briefText.slice(0, 50)}» — ${step}`,
      category: 'audio_branding',
      orderId: order.id,
    },
  });
}

function notifyAdmin(order: AudioBrandingOrder, step: string, details?: string) {
  emitSSE('admin-1', {
    type: 'notification',
    data: {
      title: `Аудиобренд: ${step}`,
      message: details || `${order.clientName} — ${order.contentType} (${order.finalPrice.toLocaleString('ru-RU')} ₽)`,
      category: 'audio_branding',
      orderId: order.id,
    },
  });
}

async function updateStatusIndex(orderId: string, oldStatus: string, newStatus: string) {
  // Remove from old status list
  const oldList: string[] = await audioBrandingByStatusStore.get(oldStatus) || [];
  await audioBrandingByStatusStore.set(oldStatus, oldList.filter(id => id !== orderId));
  // Add to new status list
  const newList: string[] = await audioBrandingByStatusStore.get(newStatus) || [];
  if (!newList.includes(orderId)) {
    newList.push(orderId);
    await audioBrandingByStatusStore.set(newStatus, newList);
  }
}

// =====================================================
// CREATE ORDER
// =====================================================

app.post('/orders', async (c) => {
  try {
    const body = await c.req.json();
    const {
      clientType, clientId, clientName,
      contentType, style, duration, voiceType,
      briefText, references,
      subscription = 'none',
    } = body;

    if (!clientId || !clientName || !contentType || !style || !duration || !voiceType || !briefText) {
      return c.json({ success: false, error: 'Заполните все обязательные поля' }, 400);
    }

    if (!AUDIO_BRANDING_CONTENT_PRICES[contentType as keyof typeof AUDIO_BRANDING_CONTENT_PRICES]) {
      return c.json({ success: false, error: `Неизвестный тип контента: ${contentType}` }, 400);
    }

    if (briefText.length < 20 || briefText.length > 2000) {
      return c.json({ success: false, error: 'Бриф должен быть от 20 до 2000 символов' }, 400);
    }

    // Calculate price
    const pricing = calculateAudioBrandingPrice(
      contentType,
      style,
      duration as keyof typeof AUDIO_BRANDING_DURATION_MULTIPLIERS,
      voiceType as keyof typeof AUDIO_BRANDING_VOICE_MULTIPLIERS,
      subscription as 'none' | 'spark' | 'start' | 'pro' | 'elite',
    );

    const orderId = `ab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    const order: AudioBrandingOrder = {
      id: orderId,
      clientType: clientType || 'venue',
      clientId,
      clientName,
      contentType,
      style,
      duration,
      voiceType,
      briefText,
      references: references || [],
      basePrice: pricing.subtotal,
      discount: pricing.discount,
      finalPrice: pricing.finalPrice,
      subscription,
      status: 'draft',
      statusEnteredAt: now,
      audioFiles: [],
      revisionCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await audioBrandingOrdersStore.set(orderId, order);

    // Index by client
    const indexStore = clientType === 'venue' ? audioBrandingByVenueStore : audioBrandingByArtistStore;
    const clientOrders: string[] = await indexStore.get(clientId) || [];
    clientOrders.push(orderId);
    await indexStore.set(clientId, clientOrders);

    // Index by status
    const draftList: string[] = await audioBrandingByStatusStore.get('draft') || [];
    draftList.push(orderId);
    await audioBrandingByStatusStore.set('draft', draftList);

    // Audit
    logAudit({
      pipeline_type: 'audio_branding',
      content_type: 'audio_branding',
      item_id: orderId,
      item_title: `${contentType}: ${briefText.slice(0, 50)}`,
      action: 'order_created',
      from_status: null,
      to_status: 'draft',
      actor_id: clientId,
      actor_role: 'artist',
      price: pricing.finalPrice,
      details: `Тип: ${contentType}, стиль: ${style}, ${duration}сек`,
    });

    notifyAdmin(order, 'Новый заказ', `${clientName} — ${contentType} за ${pricing.finalPrice.toLocaleString('ru-RU')} ₽`);

    return c.json({ success: true, order, pricing }, 201);
  } catch (error) {
    console.error('[audio-branding] create error:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Failed to create order' }, 500);
  }
});

// =====================================================
// CALCULATE PRICE (без создания заказа)
// =====================================================

app.post('/calculate-price', async (c) => {
  try {
    const body = await c.req.json();
    const { contentType, style, duration, voiceType, subscription = 'none' } = body;

    const pricing = calculateAudioBrandingPrice(
      contentType || 'jingle',
      style || 'professional',
      (duration || 15) as keyof typeof AUDIO_BRANDING_DURATION_MULTIPLIERS,
      voiceType || 'none',
      subscription as 'none' | 'spark' | 'start' | 'pro' | 'elite',
    );

    return c.json({ success: true, pricing });
  } catch (error) {
    return c.json({ success: false, error: 'Price calculation failed' }, 500);
  }
});

// =====================================================
// GET ORDERS (admin / venue / artist)
// =====================================================

app.get('/orders', async (c) => {
  try {
    const role = c.req.query('role');
    const clientId = c.req.query('clientId');
    const clientType = c.req.query('clientType') || 'venue';
    const status = c.req.query('status');

    let orderIds: string[] = [];

    if (role === 'admin') {
      if (status) {
        orderIds = await audioBrandingByStatusStore.get(status) || [];
      } else {
        const allStatuses = [
          'draft', 'pending_payment', 'paid', 'pending_review', 'rejected',
          'in_production', 'recording', 'mixing', 'mastering',
          'ready_for_review', 'revision', 'client_approved', 'delivering',
          'completed', 'cancelled',
        ];
        for (const s of allStatuses) {
          const ids = await audioBrandingByStatusStore.get(s) || [];
          orderIds.push(...ids);
        }
      }
    } else if (clientId) {
      const indexStore = clientType === 'venue' ? audioBrandingByVenueStore : audioBrandingByArtistStore;
      orderIds = await indexStore.get(clientId) || [];
    } else {
      return c.json({ success: false, error: 'clientId or role=admin required' }, 400);
    }

    const orders: AudioBrandingOrder[] = [];
    for (const id of orderIds) {
      const order = await audioBrandingOrdersStore.get(id);
      if (order) orders.push(order);
    }

    // Filter by status if client + status
    const filtered = status && role !== 'admin'
      ? orders.filter(o => o.status === status)
      : orders;

    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // SLA для каждого заказа
    const withSla = filtered.map(order => ({
      ...order,
      sla: calculateSLA('audio_branding', order.id, order.status, order.statusEnteredAt),
    }));

    return c.json({ success: true, orders: withSla, total: withSla.length });
  } catch (error) {
    console.error('[audio-branding] list error:', error);
    return c.json({ success: false, error: 'Failed to fetch orders' }, 500);
  }
});

// =====================================================
// GET ORDER BY ID
// =====================================================

app.get('/orders/:id', async (c) => {
  try {
    const orderId = c.req.param('id');
    const order = await audioBrandingOrdersStore.get(orderId) as AudioBrandingOrder | null;
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    const sla = calculateSLA('audio_branding', order.id, order.status, order.statusEnteredAt);

    return c.json({ success: true, order, sla });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to fetch order' }, 500);
  }
});

// =====================================================
// PAY ORDER
// =====================================================

app.post('/orders/:id/pay', async (c) => {
  try {
    const orderId = c.req.param('id');
    const order = await audioBrandingOrdersStore.get(orderId) as AudioBrandingOrder | null;
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    // draft → pending_payment (если ещё черновик, сначала переводим)
    if (order.status === 'draft') {
      const t1 = validateTransition('audio_branding', 'draft', 'pending_payment');
      if (!t1.valid) return c.json({ success: false, error: t1.error }, 400);
      order.status = 'pending_payment';
      order.statusEnteredAt = new Date().toISOString();
      await updateStatusIndex(orderId, 'draft', 'pending_payment');
    }

    // pending_payment → paid
    const result = executeTransition({
      pipelineType: 'audio_branding',
      contentType: 'audio_branding',
      itemId: orderId,
      itemTitle: `${order.contentType}: ${order.briefText.slice(0, 50)}`,
      fromStatus: order.status,
      toStatus: 'paid',
      actorId: 'system',
      actorRole: 'system',
      action: 'payment_confirmed',
      price: order.finalPrice,
      details: `Оплата ${order.finalPrice.toLocaleString('ru-RU')} ₽`,
      notifyUserIds: [order.clientId, 'admin-1'],
      sseEventType: 'notification',
      sseData: { category: 'audio_branding', orderId },
    });
    if (!result.success) return c.json({ success: false, error: result.error }, 400);

    const now = new Date().toISOString();
    await updateStatusIndex(orderId, order.status, 'paid');
    order.status = 'paid';
    order.statusEnteredAt = now;
    order.paidAt = now;
    order.updatedAt = now;
    await audioBrandingOrdersStore.set(orderId, order);

    // Record revenue
    await recordRevenue({
      channel: 'audio_branding',
      description: `Аудиобрендинг: ${order.contentType} для ${order.clientName}`,
      grossAmount: order.finalPrice,
      platformRevenue: order.finalPrice,
      payoutAmount: 0,
      commissionRate: 1.0,
      payerId: order.clientId,
      payerName: order.clientName,
      metadata: { orderId, contentType: order.contentType, style: order.style },
    });

    return c.json({ success: true, order });
  } catch (error) {
    console.error('[audio-branding] pay error:', error);
    return c.json({ success: false, error: 'Payment failed' }, 500);
  }
});

// =====================================================
// TRANSITION (универсальный переход статуса)
// =====================================================

app.post('/orders/:id/transition', async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { toStatus, actorId, actorRole = 'admin', action, details, assignExpertId, assignExpertName } = body;

    if (!toStatus || !actorId) {
      return c.json({ success: false, error: 'toStatus and actorId required' }, 400);
    }

    const order = await audioBrandingOrdersStore.get(orderId) as AudioBrandingOrder | null;
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    const result = executeTransition({
      pipelineType: 'audio_branding',
      contentType: 'audio_branding',
      itemId: orderId,
      itemTitle: `${order.contentType}: ${order.briefText.slice(0, 50)}`,
      fromStatus: order.status,
      toStatus,
      actorId,
      actorRole: actorRole as ActorRole,
      action: action || `transition_to_${toStatus}`,
      details,
      notifyUserIds: [order.clientId, 'admin-1'],
      sseEventType: 'notification',
      sseData: { category: 'audio_branding', orderId },
    });

    if (!result.success) return c.json({ success: false, error: result.error }, 400);

    const now = new Date().toISOString();
    const oldStatus = order.status;
    order.status = toStatus;
    order.statusEnteredAt = now;
    order.updatedAt = now;

    // Назначение эксперта при переходе в production
    if (toStatus === 'in_production' && assignExpertId) {
      order.assignedExpertId = assignExpertId;
      order.assignedExpertName = assignExpertName || assignExpertId;
    }

    if (toStatus === 'completed') {
      order.completedAt = now;
    }

    await updateStatusIndex(orderId, oldStatus, toStatus);
    await audioBrandingOrdersStore.set(orderId, order);

    notifyClient(order, toStatus === 'completed' ? 'Заказ выполнен!' : `Статус: ${toStatus}`);

    return c.json({ success: true, order, transition: result.audit });
  } catch (error) {
    console.error('[audio-branding] transition error:', error);
    return c.json({ success: false, error: 'Transition failed' }, 500);
  }
});

// =====================================================
// REVISION (клиент запрашивает доработку)
// =====================================================

app.post('/orders/:id/revision', async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { clientId, revisionNotes } = body;

    if (!clientId || !revisionNotes) {
      return c.json({ success: false, error: 'clientId and revisionNotes required' }, 400);
    }

    const order = await audioBrandingOrdersStore.get(orderId) as AudioBrandingOrder | null;
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    if (order.clientId !== clientId) {
      return c.json({ success: false, error: 'Только заказчик может запросить доработку' }, 403);
    }

    const result = executeTransition({
      pipelineType: 'audio_branding',
      contentType: 'audio_branding',
      itemId: orderId,
      itemTitle: `${order.contentType}: ${order.briefText.slice(0, 50)}`,
      fromStatus: order.status,
      toStatus: 'revision',
      actorId: clientId,
      actorRole: 'artist',
      action: 'revision_requested',
      details: revisionNotes,
      notifyUserIds: ['admin-1', order.assignedExpertId || ''].filter(Boolean),
      sseEventType: 'notification',
      sseData: { category: 'audio_branding', orderId },
    });

    if (!result.success) return c.json({ success: false, error: result.error }, 400);

    const now = new Date().toISOString();
    await updateStatusIndex(orderId, order.status, 'revision');
    order.status = 'revision';
    order.statusEnteredAt = now;
    order.updatedAt = now;
    order.revisionNotes = revisionNotes;
    order.revisionCount += 1;
    order.clientFeedback = revisionNotes;
    await audioBrandingOrdersStore.set(orderId, order);

    notifyAdmin(order, 'Доработка', `${order.clientName} запросил доработку (#${order.revisionCount}): ${revisionNotes.slice(0, 100)}`);

    return c.json({ success: true, order, revisionCount: order.revisionCount });
  } catch (error) {
    return c.json({ success: false, error: 'Revision request failed' }, 500);
  }
});

// =====================================================
// APPROVE (клиент утверждает результат)
// =====================================================

app.post('/orders/:id/approve', async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { clientId, feedback } = body;

    if (!clientId) return c.json({ success: false, error: 'clientId required' }, 400);

    const order = await audioBrandingOrdersStore.get(orderId) as AudioBrandingOrder | null;
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    if (order.clientId !== clientId) {
      return c.json({ success: false, error: 'Только заказчик может утвердить результат' }, 403);
    }

    const result = executeTransition({
      pipelineType: 'audio_branding',
      contentType: 'audio_branding',
      itemId: orderId,
      itemTitle: `${order.contentType}: ${order.briefText.slice(0, 50)}`,
      fromStatus: order.status,
      toStatus: 'client_approved',
      actorId: clientId,
      actorRole: 'artist',
      action: 'client_approved',
      details: feedback,
      notifyUserIds: ['admin-1'],
      sseEventType: 'notification',
      sseData: { category: 'audio_branding', orderId },
    });

    if (!result.success) return c.json({ success: false, error: result.error }, 400);

    const now = new Date().toISOString();
    await updateStatusIndex(orderId, order.status, 'client_approved');
    order.status = 'client_approved';
    order.statusEnteredAt = now;
    order.updatedAt = now;
    if (feedback) order.clientFeedback = feedback;
    await audioBrandingOrdersStore.set(orderId, order);

    notifyAdmin(order, 'Утверждён клиентом', `${order.clientName} утвердил ${order.contentType}`);

    return c.json({ success: true, order });
  } catch (error) {
    return c.json({ success: false, error: 'Approve failed' }, 500);
  }
});

// =====================================================
// UPLOAD AUDIO FILE (admin/expert)
// =====================================================

app.post('/orders/:id/upload', async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { audioUrl, description, actorId, actorRole = 'admin' } = body;

    if (!audioUrl || !actorId) {
      return c.json({ success: false, error: 'audioUrl and actorId required' }, 400);
    }

    const order = await audioBrandingOrdersStore.get(orderId) as AudioBrandingOrder | null;
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    const version = order.audioFiles.length + 1;
    order.audioFiles.push({
      url: audioUrl,
      version,
      uploadedAt: new Date().toISOString(),
      description: description || `Версия ${version}`,
    });
    order.updatedAt = new Date().toISOString();
    await audioBrandingOrdersStore.set(orderId, order);

    logAudit({
      pipeline_type: 'audio_branding',
      content_type: 'audio_branding',
      item_id: orderId,
      item_title: `${order.contentType}: ${order.briefText.slice(0, 50)}`,
      action: 'audio_uploaded',
      from_status: order.status,
      to_status: order.status,
      actor_id: actorId,
      actor_role: actorRole as ActorRole,
      details: `Версия ${version}: ${description || ''}`,
    });

    notifyClient(order, 'Новая версия аудио', `Загружена версия ${version} для вашего заказа`);

    return c.json({ success: true, order, version });
  } catch (error) {
    return c.json({ success: false, error: 'Upload failed' }, 500);
  }
});

// =====================================================
// DELETE ORDER
// =====================================================

app.delete('/orders/:id', async (c) => {
  try {
    const orderId = c.req.param('id');
    const order = await audioBrandingOrdersStore.get(orderId) as AudioBrandingOrder | null;
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    // Нельзя удалить оплаченный заказ
    if (order.paidAt) {
      return c.json({ success: false, error: 'Нельзя удалить оплаченный заказ' }, 400);
    }

    await audioBrandingOrdersStore.del(orderId);

    // Clean indexes
    const indexStore = order.clientType === 'venue' ? audioBrandingByVenueStore : audioBrandingByArtistStore;
    const clientOrders: string[] = await indexStore.get(order.clientId) || [];
    await indexStore.set(order.clientId, clientOrders.filter(id => id !== orderId));

    const statusList: string[] = await audioBrandingByStatusStore.get(order.status) || [];
    await audioBrandingByStatusStore.set(order.status, statusList.filter(id => id !== orderId));

    logAudit({
      pipeline_type: 'audio_branding',
      content_type: 'audio_branding',
      item_id: orderId,
      item_title: `${order.contentType}: ${order.briefText.slice(0, 50)}`,
      action: 'order_deleted',
      from_status: order.status,
      to_status: 'deleted',
      actor_id: 'admin',
      actor_role: 'admin',
    });

    return c.json({ success: true, message: 'Order deleted' });
  } catch (error) {
    return c.json({ success: false, error: 'Delete failed' }, 500);
  }
});

// =====================================================
// STATS (Admin Dashboard)
// =====================================================

app.get('/stats', async (c) => {
  try {
    const allStatuses = [
      'draft', 'pending_payment', 'paid', 'pending_review', 'rejected',
      'in_production', 'recording', 'mixing', 'mastering',
      'ready_for_review', 'revision', 'client_approved', 'delivering',
      'completed', 'cancelled',
    ];

    const stats: Record<string, number> = {};
    let total = 0;
    let totalRevenue = 0;

    for (const status of allStatuses) {
      const ids: string[] = await audioBrandingByStatusStore.get(status) || [];
      stats[status] = ids.length;
      total += ids.length;
    }

    // Считаем revenue по completed
    const completedIds: string[] = await audioBrandingByStatusStore.get('completed') || [];
    for (const id of completedIds) {
      const order = await audioBrandingOrdersStore.get(id) as AudioBrandingOrder | null;
      if (order) totalRevenue += order.finalPrice;
    }

    // Активные заказы (в работе)
    const activeStatuses = ['in_production', 'recording', 'mixing', 'mastering', 'ready_for_review', 'revision'];
    const activeCount = activeStatuses.reduce((sum, s) => sum + (stats[s] || 0), 0);

    return c.json({
      success: true,
      stats,
      total,
      active: activeCount,
      completed: stats.completed || 0,
      totalRevenue,
      pipeline: {
        awaiting_action: (stats.pending_review || 0) + (stats.ready_for_review || 0),
        in_production: activeCount,
        done: (stats.completed || 0) + (stats.cancelled || 0),
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Stats failed' }, 500);
  }
});

export default app;
