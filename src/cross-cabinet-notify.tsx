/**
 * CROSS-CABINET NOTIFICATIONS - Хелпер для отправки уведомлений между кабинетами
 *
 * Создаёт уведомление в KV Store и сразу эмитит SSE-событие целевому пользователю.
 * Используется из любого серверного маршрута для real-time доставки.
 *
 * Поддерживаемые типы:
 * - publish_status    → Артист ← Админ (смена статуса публикации)
 * - pitching_update   → Артист ← Система (статус питчинга)
 * - collab_offer      → Продюсер/Артист (предложение коллаборации)
 * - collab_response   → Продюсер/Артист (ответ на коллаборацию)
 * - booking_update    → DJ/Площадка (обновление букинга)
 * - track_moderation  → Артист ← Админ (модерация трека)
 * - order_update      → Обе стороны (статус заказа контента)
 * - payment_received  → Артист/Продюсер (получение оплаты)
 * - system_alert      → Любой кабинет (системное уведомление)
 * - admin_action      → Артист ← Админ (действие админ��стратора)
 */

import { getCcnByUser, getCcnUnreadCount, setCcnUnreadCount, upsertCcn } from './db.tsx';
import { emitSSE } from './sse-routes.tsx';

// ── Types ────────────────────────────────────────────────────────────────────

export type NotificationType =
  | 'publish_status'
  | 'pitching_update'
  | 'collab_offer'
  | 'collab_response'
  | 'collab_message'
  | 'booking_update'
  | 'track_moderation'
  | 'order_update'
  | 'payment_received'
  | 'system_alert'
  | 'admin_action'
  | 'service_order_new'
  | 'service_order_update'
  | 'beat_purchased'
  | 'new_direct_message'
  | 'subscription_updated'
  | 'subscription_payment';

export type CabinetRole = 'artist' | 'dj' | 'admin' | 'radio' | 'venue' | 'producer';

export interface CrossCabinetNotification {
  id: string;
  targetUserId: string;
  targetRole: CabinetRole;
  sourceRole: CabinetRole;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, any>;
  read: boolean;
  createdAt: string;
}

interface NotifyParams {
  targetUserId: string;
  targetRole: CabinetRole;
  sourceRole: CabinetRole;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, any>;
}

// ── Main function ─────���──────────────────────────────────────────────────────

/**
 * Отправить cross-cabinet уведомление:
 * 1) Сохраняет в KV Store
 * 2) Пушит через SSE (если пользователь онлайн)
 * 3) Возвращает созданное уведомление
 */
export async function notifyCrossCabinet(params: NotifyParams): Promise<CrossCabinetNotification> {
  const id = `ccn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const notification: CrossCabinetNotification = {
    id,
    targetUserId: params.targetUserId,
    targetRole: params.targetRole,
    sourceRole: params.sourceRole,
    type: params.type,
    title: params.title,
    message: params.message,
    link: params.link,
    metadata: params.metadata,
    read: false,
    createdAt: new Date().toISOString(),
  };

  // 1. Сохраняем в KV
  await upsertCcn(params.targetUserId, id, notification);

  // Обновляем индекс непрочитанных
  const current = await getCcnUnreadCount(params.targetUserId);
  await setCcnUnreadCount(params.targetUserId, current + 1);

  // 2. Emit SSE (если пользователь подключён - доставитс�� мгновенно)
  emitSSE(params.targetUserId, {
    type: mapTypeToSSEEvent(params.type),
    data: {
      notificationId: id,
      type: params.type,
      title: params.title,
      message: params.message,
      sourceRole: params.sourceRole,
      link: params.link,
      metadata: params.metadata,
      createdAt: notification.createdAt,
    },
  });

  return notification;
}

/**
 * Отправить уведомление нескольким пользователям одновременно
 */
export async function notifyMultiple(
  targets: Array<{ userId: string; role: CabinetRole }>,
  common: Omit<NotifyParams, 'targetUserId' | 'targetRole'>
): Promise<CrossCabinetNotification[]> {
  const results: CrossCabinetNotification[] = [];
  for (const target of targets) {
    const notif = await notifyCrossCabinet({
      ...common,
      targetUserId: target.userId,
      targetRole: target.role,
    });
    results.push(notif);
  }
  return results;
}

/**
 * Получить все непрочитанные cross-cabinet уведомления пользователя
 */
export async function getUnreadNotifications(userId: string): Promise<CrossCabinetNotification[]> {
  const all = await getCcnByUser(userId) as CrossCabinetNotification[];
  return (all || [])
    .filter(n => n && !n.read)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Получить все уведомления пользователя (с пагинацией)
 */
export async function getAllNotifications(userId: string, limit = 50): Promise<CrossCabinetNotification[]> {
  const all = await getCcnByUser(userId) as CrossCabinetNotification[];
  return (all || [])
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

/**
 * Пометить уведомление как прочитанное
 */
export async function markAsRead(userId: string, notificationId: string): Promise<void> {
  const all = await getCcnByUser(userId) as CrossCabinetNotification[];
  const notif = (all || []).find(n => n && n.id === notificationId) || null;
  if (notif && !notif.read) {
    notif.read = true;
    await upsertCcn(userId, notificationId, notif);
    // Уменьшаем счётчик
    const current = await getCcnUnreadCount(userId);
    await setCcnUnreadCount(userId, Math.max(0, current - 1));
  }
}

/**
 * Пометить все уведомления как прочитанные
 */
export async function markAllAsRead(userId: string): Promise<number> {
  const all = await getCcnByUser(userId) as CrossCabinetNotification[];
  let count = 0;
  for (const notif of (all || [])) {
    if (notif && !notif.read) {
      notif.read = true;
      await upsertCcn(userId, notif.id, notif);
      count++;
    }
  }
  await setCcnUnreadCount(userId, 0);
  return count;
}

/**
 * Получить количество непрочитанных
 */
export async function getUnreadCount(userId: string): Promise<number> {
  return (await getCcnUnreadCount(userId) as number) || 0;
}

// ── SSE event mapping ────────────────────────────────────────────────────────

/**
 * Маппинг типа уведомления → SSE event name.
 * Каждый тип эмитится как свой именованный SSE-event (1:1),
 * чтобы фронтенд мог подписываться точечно.
 * Неизвестные типы фолбэчатся на 'notification'.
 */
function mapTypeToSSEEvent(type: NotificationType): string {
  const directMap: Record<string, string> = {
    collab_offer: 'collab_offer',
    collab_response: 'collab_response',
    collab_message: 'collab_message',
    new_direct_message: 'new_direct_message',
    booking_update: 'booking_update',
    service_order_new: 'service_order_new',
    service_order_update: 'service_order_update',
    beat_purchased: 'beat_purchased',
    order_update: 'order_update',
    publish_status: 'publish_status',
    payment_received: 'payment_received',
    system_alert: 'system_alert',
    track_moderation: 'moderation_update',
    pitching_update: 'notification',
    admin_action: 'notification',
    subscription_updated: 'subscription_updated',
    subscription_payment: 'subscription_payment',
  };
  return directMap[type] || 'notification';
}