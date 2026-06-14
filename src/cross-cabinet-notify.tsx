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

import { getCcnByUser, upsertCcn } from './db.tsx';
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
  | 'mix_moderation'
  | 'order_update'
  | 'payment_received'
  | 'system_alert'
  | 'admin_action'
  | 'service_order_new'
  | 'service_order_update'
  | 'beat_purchased'
  | 'new_direct_message'
  | 'subscription_updated'
  | 'subscription_payment'
  | 'payment_update'
  | 'support_ticket_new'
  | 'live_chat_message'
  | 'donation_received'
  | 'venue_request_approved'
  // Track / mix lifecycle (используются в track-moderation-routes.tsx
  // для уведомлений артиста и DJ о публикации/планируемом эфире). Без
  // этих 3 значений TS2322 на каждом sendCrossCabinetNotification вызове.
  | 'track_upcoming'
  | 'track_published'
  | 'mix_published'
  // Label lifecycle (используются в label-routes.tsx: artist принимает/
  // отклоняет приглашение в лейбл, артист уходит из лейбла, лейбл
  // отправляет приглашение артисту).
  | 'label_invitation'
  | 'label_invitation_response'
  | 'label_member_left';

// 'system' — нечеловеческий источник (донат от слушателя, авто-события).
export type CabinetRole = 'artist' | 'dj' | 'admin' | 'radio' | 'venue' | 'producer' | 'label' | 'system';

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
  /**
   * Skip the dedup-window check and always write a fresh notification.
   * Default false — the same (target, type, title) triple inside the
   * window is dropped to stop multi-step flows (track moderation,
   * subscription webhooks) from flooding a single inbox with near-
   * duplicates.
   */
  bypassDedup?: boolean;
}

// ── Dedup cache ──────────────────────────────────────────────────────────────

/**
 * Identical notifications within DEDUP_WINDOW_MS are silently dropped.
 * The same artist getting "Трек одобрен!" twice in five minutes was the
 * main source of the "9+ unread, what's going on" complaints.
 *
 * In-memory only — losing the cache on restart is acceptable: worst
 * case a single duplicate slips through right after a deploy.
 */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const DEDUP_CACHE_MAX = 5000;
const recentNotifications = new Map<string, number>();

function dedupFingerprint(p: NotifyParams): string {
  return `${p.targetUserId}|${p.type}|${p.title}`;
}

function isRecentDuplicate(fp: string): boolean {
  const now = Date.now();

  // Opportunistic eviction so the map can't grow without bound.
  if (recentNotifications.size > DEDUP_CACHE_MAX) {
    for (const [k, t] of recentNotifications) {
      if (now - t > DEDUP_WINDOW_MS) recentNotifications.delete(k);
    }
  }

  const prev = recentNotifications.get(fp);
  if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) return true;
  recentNotifications.set(fp, now);
  return false;
}

// ── Main function ─────���──────────────────────────────────────────────────────

/**
 * Отправить cross-cabinet уведомление:
 * 1) Сохраняет в хранилище
 * 2) Пушит через SSE (если пользователь онлайн)
 * 3) Возвращает созданное уведомление, или null если оно подавлено
 *    дедупом (см. NotifyParams.bypassDedup)
 */
export async function notifyCrossCabinet(params: NotifyParams): Promise<CrossCabinetNotification | null> {
  if (!params.bypassDedup && isRecentDuplicate(dedupFingerprint(params))) {
    return null;
  }

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

  // The old KV-counter (ccn_unread_count) was the source of the "9+ but
  // empty inbox" desync, since markAsRead/markAllAsRead didn't decrement
  // it. getUnreadCount() now counts directly from the table, so we no
  // longer maintain this side-channel.

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
    if (notif) results.push(notif);  // dedup-suppressed entries are null
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
 * Получить количество непрочитанных. Считаем напрямую по таблице,
 * чтобы счётчик не расходился с реальным состоянием — старый
 * `ccn_unread_count` KV-кэш инкрементировался при создании уведомления,
 * но markAsRead/markAllAsRead обновляли только `is_read` колонку и
 * никогда не декрементировали кэш. В итоге пользователь видел "9+" в
 * колокольчике, а инбокс был пустой. Источник истины — таблица.
 */
export async function getUnreadCount(userId: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM cross_cabinet_notifications
     WHERE (target_user_id = $1 OR recipient_id = $1) AND is_read = false`,
    [userId],
  );
  return (r.rows[0]?.cnt as number) || 0;
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
    mix_moderation: 'moderation_update',
    pitching_update: 'notification',
    admin_action: 'notification',
    subscription_updated: 'subscription_updated',
    subscription_payment: 'subscription_payment',
    payment_update: 'payment_update',
    support_ticket_new: 'support_ticket_new',
    live_chat_message: 'live_chat_message',
    donation_received: 'donation_received',
    venue_request_approved: 'venue_request_approved',
  };
  return directMap[type] || 'notification';
}
