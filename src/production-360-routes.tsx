/**
 * PRODUCTION 360° ROUTES — Полный пайплайн 360-градусного продакшна
 *
 * Пайплайн: draft → pending_payment → paid → pending_review → approved →
 *           concept → recording → mixing → [video_production] → distribution →
 *           promotion → ready_for_review → client_approved → completed
 *
 * Endpoints:
 *   POST   /production360/orders                — Создать проект
 *   POST   /production360/calculate-price        — Калькулятор цены
 *   GET    /production360/orders                 — Список проектов
 *   GET    /production360/orders/:id             — Проект по ID
 *   POST   /production360/orders/:id/pay         — Подтвердить оплату
 *   POST   /production360/orders/:id/transition  — Переход статуса
 *   POST   /production360/orders/:id/revision    — Запросить доработку (клиент)
 *   POST   /production360/orders/:id/approve     — Утвердить результат (клиент)
 *   POST   /production360/orders/:id/progress    — Обновить прогресс (admin/expert)
 *   POST   /production360/orders/:id/upload      — Загрузить файл
 *   DELETE /production360/orders/:id             — Удалить проект
 *   GET    /production360/stats                  — Статистика (admin)
 */

import { Hono } from 'npm:hono@4';
import {
  production360OrdersStore,
  production360ByStatusStore,
  production360ByArtistStore,
} from './db.tsx';
import { emitSSE } from './sse-routes.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { executeTransition, validateTransition, logAudit, calculateSLA } from './pipeline-engine.tsx';
import type { ActorRole } from './pipeline-engine.tsx';
import {
  PRODUCTION_360_SERVICE_PRICES,
  PRODUCTION_360_ADDON_PRICES,
  calculateProduction360Price,
} from '../../src/constants/financial.ts';

const app = new Hono();

// ── Типы ──

type ProductionStage = 'concept' | 'recording' | 'mixing' | 'video_production' | 'distribution' | 'promotion';

export interface Production360Order {
  id: string;
  artistId: string;
  artistName: string;
  // Проект
  serviceType: keyof typeof PRODUCTION_360_SERVICE_PRICES;
  projectTitle: string;
  projectDescription: string;
  projectGoals?: string;
  targetAudience?: string;
  genre?: string;
  // Услуги
  services: {
    concept: boolean;
    recording: boolean;
    mixing: boolean;
    videoContent: boolean;
    distribution: boolean;
    promotion: boolean;
  };
  addons: string[];
  references?: string[];
  existingMaterial?: string;
  deadline?: string;
  // Финансы
  servicePrice: number;
  addonsTotal: number;
  discount: number;
  finalPrice: number;
  subscription: string;
  estimatedFullPrice?: number;
  // Статус
  status: string;
  statusEnteredAt: string;
  // Прогресс
  progress: {
    currentStage: ProductionStage;
    completedPercentage: number;
    stageProgress: Record<ProductionStage, number>;   // % по каждому этапу
    estimatedCompletion?: string;
  };
  // Команда
  assignedTeam: { id: string; name: string; role: string }[];
  // Файлы
  files: { url: string; type: string; stage: string; uploadedAt: string; description?: string }[];
  // Обратная связь
  adminComment?: string;
  clientFeedback?: string;
  revisionNotes?: string;
  revisionCount: number;
  rejectionReason?: string;
  // Timestamps
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
  approvedDate?: string;
  completedDate?: string;
}

// ── Маппинг статус → этап для прогресса ──

const STATUS_TO_STAGE: Record<string, ProductionStage> = {
  concept: 'concept',
  recording: 'recording',
  mixing: 'mixing',
  video_production: 'video_production',
  distribution: 'distribution',
  promotion: 'promotion',
};

const STAGE_WEIGHTS: Record<ProductionStage, number> = {
  concept: 10,
  recording: 25,
  mixing: 20,
  video_production: 20,
  distribution: 10,
  promotion: 15,
};

function calcTotalProgress(stageProgress: Record<ProductionStage, number>, services: Production360Order['services']): number {
  let totalWeight = 0;
  let weighted = 0;
  const active: [ProductionStage, boolean][] = [
    ['concept', services.concept],
    ['recording', services.recording],
    ['mixing', services.mixing],
    ['video_production', services.videoContent],
    ['distribution', services.distribution],
    ['promotion', services.promotion],
  ];
  for (const [stage, enabled] of active) {
    if (enabled) {
      const w = STAGE_WEIGHTS[stage];
      totalWeight += w;
      weighted += (stageProgress[stage] || 0) * w / 100;
    }
  }
  return totalWeight > 0 ? Math.round(weighted / totalWeight * 100) : 0;
}

// ── Helpers ──

function notifyClient(order: Production360Order, step: string, details?: string) {
  emitSSE(order.artistId, {
    type: 'notification',
    data: {
      title: `360° Продакшн: ${step}`,
      message: details || `Проект «${order.projectTitle}» — ${step}`,
      category: 'production_360',
      orderId: order.id,
    },
  });
}

function notifyAdmin(order: Production360Order, step: string, details?: string) {
  emitSSE('admin-1', {
    type: 'notification',
    data: {
      title: `360° Продакшн: ${step}`,
      message: details || `${order.artistName} — ${order.projectTitle} (${order.finalPrice.toLocaleString('ru-RU')} ₽)`,
      category: 'production_360',
      orderId: order.id,
    },
  });
}

async function updateStatusIndex(orderId: string, oldStatus: string, newStatus: string) {
  const oldList: string[] = await production360ByStatusStore.get(oldStatus) || [];
  await production360ByStatusStore.set(oldStatus, oldList.filter(id => id !== orderId));
  const newList: string[] = await production360ByStatusStore.get(newStatus) || [];
  if (!newList.includes(orderId)) {
    newList.push(orderId);
    await production360ByStatusStore.set(newStatus, newList);
  }
}

function defaultStageProgress(): Record<ProductionStage, number> {
  return { concept: 0, recording: 0, mixing: 0, video_production: 0, distribution: 0, promotion: 0 };
}

// =====================================================
// CREATE PROJECT
// =====================================================

app.post('/orders', async (c) => {
  try {
    const body = await c.req.json();
    const {
      artistId, artistName, serviceType, projectTitle, projectDescription,
      projectGoals, targetAudience, genre,
      services, addons = [], references, existingMaterial, deadline,
      subscription = 'none',
    } = body;

    if (!artistId || !artistName || !serviceType || !projectTitle || !projectDescription) {
      return c.json({ success: false, error: 'Заполните обязательные поля: artistId, artistName, serviceType, projectTitle, projectDescription' }, 400);
    }

    if (!PRODUCTION_360_SERVICE_PRICES[serviceType as keyof typeof PRODUCTION_360_SERVICE_PRICES]) {
      return c.json({ success: false, error: `Неизвестный тип услуги: ${serviceType}` }, 400);
    }

    if (projectDescription.length < 20 || projectDescription.length > 5000) {
      return c.json({ success: false, error: 'Описание проекта — от 20 до 5000 символов' }, 400);
    }

    // Calculate price
    const pricing = calculateProduction360Price(
      serviceType,
      addons,
      subscription as 'none' | 'spark' | 'start' | 'pro' | 'elite',
    );

    const orderId = `p360_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    const defaultServices = {
      concept: true,
      recording: true,
      mixing: true,
      videoContent: serviceType === 'video_shooting' || serviceType === 'full_package',
      distribution: serviceType === 'full_package' || serviceType === 'distribution_promo',
      promotion: serviceType === 'full_package' || serviceType === 'distribution_promo',
    };

    const order: Production360Order = {
      id: orderId,
      artistId,
      artistName,
      serviceType,
      projectTitle,
      projectDescription,
      projectGoals,
      targetAudience,
      genre,
      services: services || defaultServices,
      addons,
      references: references || [],
      existingMaterial,
      deadline,
      servicePrice: pricing.servicePrice,
      addonsTotal: pricing.addonsTotal,
      discount: pricing.discount,
      finalPrice: pricing.finalPrice,
      subscription,
      status: 'draft',
      statusEnteredAt: now,
      progress: {
        currentStage: 'concept',
        completedPercentage: 0,
        stageProgress: defaultStageProgress(),
      },
      assignedTeam: [],
      files: [],
      revisionCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await production360OrdersStore.set(orderId, order);

    // Index
    const artistOrders: string[] = await production360ByArtistStore.get(artistId) || [];
    artistOrders.push(orderId);
    await production360ByArtistStore.set(artistId, artistOrders);

    const draftList: string[] = await production360ByStatusStore.get('draft') || [];
    draftList.push(orderId);
    await production360ByStatusStore.set('draft', draftList);

    logAudit({
      pipeline_type: 'production_360',
      content_type: 'production_360',
      item_id: orderId,
      item_title: projectTitle,
      action: 'project_created',
      from_status: null,
      to_status: 'draft',
      actor_id: artistId,
      actor_role: 'artist',
      price: pricing.finalPrice,
      details: `Тип: ${serviceType}, бюджет: ${pricing.finalPrice.toLocaleString('ru-RU')} ₽`,
    });

    notifyAdmin(order, 'Новый проект', `${artistName} — ${projectTitle} (${serviceType}) за ${pricing.finalPrice.toLocaleString('ru-RU')} ₽`);

    return c.json({ success: true, order, pricing }, 201);
  } catch (error) {
    console.error('[production-360] create error:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Failed to create project' }, 500);
  }
});

// =====================================================
// CALCULATE PRICE
// =====================================================

app.post('/calculate-price', async (c) => {
  try {
    const body = await c.req.json();
    const { serviceType, addons = [], subscription = 'none' } = body;

    const pricing = calculateProduction360Price(
      serviceType || 'full_package',
      addons,
      subscription as 'none' | 'spark' | 'start' | 'pro' | 'elite',
    );

    return c.json({ success: true, pricing });
  } catch (error) {
    return c.json({ success: false, error: 'Price calculation failed' }, 500);
  }
});

// =====================================================
// GET ORDERS
// =====================================================

app.get('/orders', async (c) => {
  try {
    const role = c.req.query('role');
    const artistId = c.req.query('artistId');
    const status = c.req.query('status');

    let orderIds: string[] = [];

    if (role === 'admin') {
      if (status) {
        orderIds = await production360ByStatusStore.get(status) || [];
      } else {
        const allStatuses = [
          'draft', 'pending_payment', 'paid', 'pending_review', 'rejected', 'approved',
          'concept', 'recording', 'mixing', 'video_production', 'distribution', 'promotion',
          'ready_for_review', 'revision', 'client_approved', 'completed', 'cancelled',
        ];
        for (const s of allStatuses) {
          const ids = await production360ByStatusStore.get(s) || [];
          orderIds.push(...ids);
        }
      }
    } else if (artistId) {
      orderIds = await production360ByArtistStore.get(artistId) || [];
    } else {
      return c.json({ success: false, error: 'artistId or role=admin required' }, 400);
    }

    const orders: Production360Order[] = [];
    for (const id of orderIds) {
      const order = await production360OrdersStore.get(id);
      if (order) orders.push(order);
    }

    const filtered = status && role !== 'admin'
      ? orders.filter(o => o.status === status)
      : orders;

    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const withSla = filtered.map(order => ({
      ...order,
      sla: calculateSLA('production_360', order.id, order.status, order.statusEnteredAt),
    }));

    return c.json({ success: true, orders: withSla, total: withSla.length });
  } catch (error) {
    console.error('[production-360] list error:', error);
    return c.json({ success: false, error: 'Failed to fetch orders' }, 500);
  }
});

// =====================================================
// GET ORDER BY ID
// =====================================================

app.get('/orders/:id', async (c) => {
  try {
    const orderId = c.req.param('id');
    const order = await production360OrdersStore.get(orderId) as Production360Order | null;
    if (!order) return c.json({ success: false, error: 'Project not found' }, 404);

    const sla = calculateSLA('production_360', order.id, order.status, order.statusEnteredAt);
    return c.json({ success: true, order, sla });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to fetch project' }, 500);
  }
});

// =====================================================
// PAY ORDER
// =====================================================

app.post('/orders/:id/pay', async (c) => {
  try {
    const orderId = c.req.param('id');
    const order = await production360OrdersStore.get(orderId) as Production360Order | null;
    if (!order) return c.json({ success: false, error: 'Project not found' }, 404);

    // draft → pending_payment
    if (order.status === 'draft') {
      const t1 = validateTransition('production_360', 'draft', 'pending_payment');
      if (!t1.valid) return c.json({ success: false, error: t1.error }, 400);
      order.status = 'pending_payment';
      order.statusEnteredAt = new Date().toISOString();
      await updateStatusIndex(orderId, 'draft', 'pending_payment');
    }

    // pending_payment → paid
    const result = executeTransition({
      pipelineType: 'production_360',
      contentType: 'production_360',
      itemId: orderId,
      itemTitle: order.projectTitle,
      fromStatus: order.status,
      toStatus: 'paid',
      actorId: 'system',
      actorRole: 'system',
      action: 'payment_confirmed',
      price: order.finalPrice,
      details: `Оплата ${order.finalPrice.toLocaleString('ru-RU')} ₽ за ${order.serviceType}`,
      notifyUserIds: [order.artistId, 'admin-1'],
      sseEventType: 'notification',
      sseData: { category: 'production_360', orderId },
    });
    if (!result.success) return c.json({ success: false, error: result.error }, 400);

    const now = new Date().toISOString();
    await updateStatusIndex(orderId, order.status, 'paid');
    order.status = 'paid';
    order.statusEnteredAt = now;
    order.paidAt = now;
    order.updatedAt = now;
    await production360OrdersStore.set(orderId, order);

    await recordRevenue({
      channel: 'production_360',
      description: `360° Продакшн: ${order.serviceType} — ${order.projectTitle}`,
      grossAmount: order.finalPrice,
      platformRevenue: order.finalPrice,
      payoutAmount: 0,
      commissionRate: 1.0,
      payerId: order.artistId,
      payerName: order.artistName,
      metadata: { orderId, serviceType: order.serviceType, addons: order.addons },
    });

    return c.json({ success: true, order });
  } catch (error) {
    console.error('[production-360] pay error:', error);
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
    const { toStatus, actorId, actorRole = 'admin', action, details, assignTeam, rejectionReason } = body;

    if (!toStatus || !actorId) {
      return c.json({ success: false, error: 'toStatus and actorId required' }, 400);
    }

    const order = await production360OrdersStore.get(orderId) as Production360Order | null;
    if (!order) return c.json({ success: false, error: 'Project not found' }, 404);

    const result = executeTransition({
      pipelineType: 'production_360',
      contentType: 'production_360',
      itemId: orderId,
      itemTitle: order.projectTitle,
      fromStatus: order.status,
      toStatus,
      actorId,
      actorRole: actorRole as ActorRole,
      action: action || `transition_to_${toStatus}`,
      details,
      notifyUserIds: [order.artistId, 'admin-1'],
      sseEventType: 'notification',
      sseData: { category: 'production_360', orderId },
    });

    if (!result.success) return c.json({ success: false, error: result.error }, 400);

    const now = new Date().toISOString();
    const oldStatus = order.status;
    order.status = toStatus;
    order.statusEnteredAt = now;
    order.updatedAt = now;

    // Обновить прогресс при переходе на производственный этап
    const stage = STATUS_TO_STAGE[toStatus];
    if (stage) {
      order.progress.currentStage = stage;
    }

    if (toStatus === 'approved') order.approvedDate = now;
    if (toStatus === 'completed') order.completedDate = now;
    if (toStatus === 'rejected' && rejectionReason) order.rejectionReason = rejectionReason;
    if (assignTeam && Array.isArray(assignTeam)) order.assignedTeam = assignTeam;

    await updateStatusIndex(orderId, oldStatus, toStatus);
    await production360OrdersStore.set(orderId, order);

    notifyClient(order, toStatus === 'completed' ? 'Проект завершён!' : `Статус: ${toStatus}`);

    return c.json({ success: true, order, transition: result.audit });
  } catch (error) {
    console.error('[production-360] transition error:', error);
    return c.json({ success: false, error: 'Transition failed' }, 500);
  }
});

// =====================================================
// PROGRESS UPDATE (admin/expert обновляет прогресс этапа)
// =====================================================

app.post('/orders/:id/progress', async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { stage, percentage, estimatedCompletion, actorId } = body;

    if (!stage || percentage === undefined || !actorId) {
      return c.json({ success: false, error: 'stage, percentage, actorId required' }, 400);
    }

    const order = await production360OrdersStore.get(orderId) as Production360Order | null;
    if (!order) return c.json({ success: false, error: 'Project not found' }, 404);

    const pct = Math.max(0, Math.min(100, parseInt(percentage)));
    order.progress.stageProgress[stage as ProductionStage] = pct;
    order.progress.completedPercentage = calcTotalProgress(order.progress.stageProgress, order.services);
    if (estimatedCompletion) order.progress.estimatedCompletion = estimatedCompletion;
    order.updatedAt = new Date().toISOString();

    await production360OrdersStore.set(orderId, order);

    logAudit({
      pipeline_type: 'production_360',
      content_type: 'production_360',
      item_id: orderId,
      item_title: order.projectTitle,
      action: 'progress_updated',
      from_status: order.status,
      to_status: order.status,
      actor_id: actorId,
      actor_role: 'admin',
      details: `${stage}: ${pct}%, общий: ${order.progress.completedPercentage}%`,
    });

    notifyClient(order, `Прогресс ${order.progress.completedPercentage}%`, `Этап «${stage}» — ${pct}%`);

    return c.json({ success: true, order, progress: order.progress });
  } catch (error) {
    return c.json({ success: false, error: 'Progress update failed' }, 500);
  }
});

// =====================================================
// REVISION (клиент запрашивает доработку)
// =====================================================

app.post('/orders/:id/revision', async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { artistId, revisionNotes, targetStage } = body;

    if (!artistId || !revisionNotes) {
      return c.json({ success: false, error: 'artistId and revisionNotes required' }, 400);
    }

    const order = await production360OrdersStore.get(orderId) as Production360Order | null;
    if (!order) return c.json({ success: false, error: 'Project not found' }, 404);

    if (order.artistId !== artistId) {
      return c.json({ success: false, error: 'Только автор проекта может запросить доработку' }, 403);
    }

    const result = executeTransition({
      pipelineType: 'production_360',
      contentType: 'production_360',
      itemId: orderId,
      itemTitle: order.projectTitle,
      fromStatus: order.status,
      toStatus: 'revision',
      actorId: artistId,
      actorRole: 'artist',
      action: 'revision_requested',
      details: `${revisionNotes}${targetStage ? ` [этап: ${targetStage}]` : ''}`,
      notifyUserIds: ['admin-1'],
      sseEventType: 'notification',
      sseData: { category: 'production_360', orderId },
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
    await production360OrdersStore.set(orderId, order);

    notifyAdmin(order, 'Доработка', `${order.artistName} запросил доработку (#${order.revisionCount}): ${revisionNotes.slice(0, 100)}`);

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
    const { artistId, feedback } = body;

    if (!artistId) return c.json({ success: false, error: 'artistId required' }, 400);

    const order = await production360OrdersStore.get(orderId) as Production360Order | null;
    if (!order) return c.json({ success: false, error: 'Project not found' }, 404);

    if (order.artistId !== artistId) {
      return c.json({ success: false, error: 'Только автор проекта может утвердить результат' }, 403);
    }

    const result = executeTransition({
      pipelineType: 'production_360',
      contentType: 'production_360',
      itemId: orderId,
      itemTitle: order.projectTitle,
      fromStatus: order.status,
      toStatus: 'client_approved',
      actorId: artistId,
      actorRole: 'artist',
      action: 'client_approved',
      details: feedback,
      notifyUserIds: ['admin-1'],
      sseEventType: 'notification',
      sseData: { category: 'production_360', orderId },
    });

    if (!result.success) return c.json({ success: false, error: result.error }, 400);

    const now = new Date().toISOString();
    await updateStatusIndex(orderId, order.status, 'client_approved');
    order.status = 'client_approved';
    order.statusEnteredAt = now;
    order.updatedAt = now;
    if (feedback) order.clientFeedback = feedback;
    await production360OrdersStore.set(orderId, order);

    notifyAdmin(order, 'Утверждён артистом', `${order.artistName} утвердил проект «${order.projectTitle}»`);

    return c.json({ success: true, order });
  } catch (error) {
    return c.json({ success: false, error: 'Approve failed' }, 500);
  }
});

// =====================================================
// UPLOAD FILE
// =====================================================

app.post('/orders/:id/upload', async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { fileUrl, fileType, stage, description, actorId, actorRole = 'admin' } = body;

    if (!fileUrl || !actorId) {
      return c.json({ success: false, error: 'fileUrl and actorId required' }, 400);
    }

    const order = await production360OrdersStore.get(orderId) as Production360Order | null;
    if (!order) return c.json({ success: false, error: 'Project not found' }, 404);

    order.files.push({
      url: fileUrl,
      type: fileType || 'other',
      stage: stage || order.progress.currentStage,
      uploadedAt: new Date().toISOString(),
      description,
    });
    order.updatedAt = new Date().toISOString();
    await production360OrdersStore.set(orderId, order);

    logAudit({
      pipeline_type: 'production_360',
      content_type: 'production_360',
      item_id: orderId,
      item_title: order.projectTitle,
      action: 'file_uploaded',
      from_status: order.status,
      to_status: order.status,
      actor_id: actorId,
      actor_role: actorRole as ActorRole,
      details: `${fileType || 'file'}: ${description || fileUrl}`,
    });

    notifyClient(order, 'Новый файл', `Загружен ${fileType || 'файл'} на этапе ${stage || order.progress.currentStage}`);

    return c.json({ success: true, order, filesCount: order.files.length });
  } catch (error) {
    return c.json({ success: false, error: 'Upload failed' }, 500);
  }
});

// =====================================================
// DELETE PROJECT
// =====================================================

app.delete('/orders/:id', async (c) => {
  try {
    const orderId = c.req.param('id');
    const order = await production360OrdersStore.get(orderId) as Production360Order | null;
    if (!order) return c.json({ success: false, error: 'Project not found' }, 404);

    if (order.paidAt) {
      return c.json({ success: false, error: 'Нельзя удалить оплаченный проект' }, 400);
    }

    await production360OrdersStore.del(orderId);

    const artistOrders: string[] = await production360ByArtistStore.get(order.artistId) || [];
    await production360ByArtistStore.set(order.artistId, artistOrders.filter(id => id !== orderId));

    const statusList: string[] = await production360ByStatusStore.get(order.status) || [];
    await production360ByStatusStore.set(order.status, statusList.filter(id => id !== orderId));

    logAudit({
      pipeline_type: 'production_360',
      content_type: 'production_360',
      item_id: orderId,
      item_title: order.projectTitle,
      action: 'project_deleted',
      from_status: order.status,
      to_status: 'deleted',
      actor_id: 'admin',
      actor_role: 'admin',
    });

    return c.json({ success: true, message: 'Project deleted' });
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
      'draft', 'pending_payment', 'paid', 'pending_review', 'rejected', 'approved',
      'concept', 'recording', 'mixing', 'video_production', 'distribution', 'promotion',
      'ready_for_review', 'revision', 'client_approved', 'completed', 'cancelled',
    ];

    const stats: Record<string, number> = {};
    let total = 0;
    let totalRevenue = 0;

    for (const status of allStatuses) {
      const ids: string[] = await production360ByStatusStore.get(status) || [];
      stats[status] = ids.length;
      total += ids.length;
    }

    const completedIds: string[] = await production360ByStatusStore.get('completed') || [];
    for (const id of completedIds) {
      const order = await production360OrdersStore.get(id) as Production360Order | null;
      if (order) totalRevenue += order.finalPrice;
    }

    const productionStatuses = ['concept', 'recording', 'mixing', 'video_production', 'distribution', 'promotion'];
    const inProduction = productionStatuses.reduce((sum, s) => sum + (stats[s] || 0), 0);

    return c.json({
      success: true,
      stats,
      total,
      inProduction,
      completed: stats.completed || 0,
      totalRevenue,
      pipeline: {
        awaiting: (stats.pending_review || 0) + (stats.ready_for_review || 0) + (stats.pending_payment || 0),
        in_production: inProduction + (stats.revision || 0),
        done: (stats.completed || 0) + (stats.cancelled || 0),
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Stats failed' }, 500);
  }
});

export default app;
