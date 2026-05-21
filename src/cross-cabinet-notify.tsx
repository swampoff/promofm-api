/**
 * CROSS-CABINET NOTIFICATIONS - Хелпер для отправки уведомлений между кабинетами
 *
 * Создаёт уведомление в хранилище и сразу эмитит SSE-событие целевому пользователю.
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
 * 1) Сохраняет в хранилище
 * 2) Пушит через SSE (если пользователь онлайн)
 * 3) Возвращает созданное уведомление
 */
export async function notifyCrossCabinet(params: NotifyParams): Promise<CrossCabinetNotification> {
  const id = `ccn-${crypto.randomUUID()}`;

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
 * Уведомить ВСЕХ админов платформы (broadcast). Запрашивает реальных юзеров
 * с ролью admin/superadmin и создаёт notification для каждого. Заменяет
 * прежний паттерн `targetUserId: 'admin-1'` который писал в БД для
 * несуществующего юзера и оставлял уведомления orphan'ами.
 *
 * Также эмитит SSE на shared канал 'admin' для UI-подписок которые
 * слушают broadcast.
 */
export async function notifyAllAdmins(
  common: Omit<NotifyParams, 'targetUserId' | 'targetRole'>
): Promise<CrossCabinetNotification[]> {
  const { pool } = await import('./db-client.tsx');
  let admins: Array<{ userId: string; role: CabinetRole }> = [];
  try {
    const r = await pool.query(
      `SELECT id::text AS user_id, role::text AS role FROM users
       WHERE role::text IN ('admin', 'superadmin')`
    );
    admins = r.rows.map((row: any) => ({
      userId: row.user_id,
      role: 'admin' as CabinetRole,
    }));
  } catch (err: any) {
    console.warn('[notifyAllAdmins] failed to load admin users:', err?.message);
  }

  // Broadcast on the shared SSE channel regardless of how many admin rows
  // exist — admin UIs subscribed to /api/sse/stream/admin still get the push.
  emitSSE('admin', {
    type: mapTypeToSSEEvent(common.type),
    data: {
      type: common.type,
      title: common.title,
      message: common.message,
      sourceRole: common.sourceRole,
      link: common.link,
      metadata: common.metadata,
      createdAt: new Date().toISOString(),
    },
  });

  if (admins.length === 0) return [];
  return notifyMultiple(admins, common);
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
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE cross_cabinet_notifications SET is_read = true
     WHERE id = $1 AND (target_user_id = $2 OR recipient_id = $2) AND is_read = false`,
    [notificationId, userId]
  );
}

/**
 * Пометить все уведомления как прочитанные
 */
export async function markAllAsRead(userId: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `UPDATE cross_cabinet_notifications SET is_read = true
     WHERE (target_user_id = $1 OR recipient_id = $1) AND is_read = false
     RETURNING id`,
    [userId]
  );
  return r.rowCount || 0;
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