/**
 * PIPELINE ENGINE — Единый движок пайплайна для всех типов контента
 *
 * 1. State Machine — допустимые переходы статусов + хуки + роли
 * 2. Unified executeTransition() — transition + audit + SSE в одном вызове
 * 3. Audit Log — персистентный (DB) + in-memory кэш
 * 4. SLA Tracking — дедлайны, просрочки, batch-проверка
 * 5. Analytics — аналитика по всем пайплайнам
 */

import { emitSSE } from './sse-routes.tsx';

// ============================================
// 1. STATE MACHINE — ДОПУСТИМЫЕ ПЕРЕХОДЫ
// ============================================

/** Допустимые переходы для пайплайна треков/клипов */
const CONTENT_TRANSITIONS: Record<string, string[]> = {
  awaiting_moderation: ['moderated', 'rejected'],
  moderated:           ['in_novelty', 'in_newsletter', 'exclusive_pitched'],
  rejected:            ['awaiting_moderation'], // повторная подача
  in_novelty:          ['moderated', 'in_newsletter', 'exclusive_pitched', 'completed'],
  in_newsletter:       ['moderated', 'exclusive_pitched', 'completed'],
  exclusive_pitched:   ['completed'],
  completed:           [],
};

/** Допустимые переходы для пайплайна тест-трека */
const TRACK_TEST_TRANSITIONS: Record<string, string[]> = {
  pending_payment:          ['payment_succeeded', 'cancelled'],
  payment_succeeded:        ['pending_moderation'],
  pending_moderation:       ['moderation_rejected', 'pending_expert_assignment'],
  moderation_rejected:      [],
  pending_expert_assignment:['experts_assigned'],
  experts_assigned:         ['in_review', 'review_in_progress'],
  in_review:                ['review_in_progress', 'analysis_generated'],
  review_in_progress:       ['analysis_generated'],
  analysis_generated:       ['pending_admin_approval', 'pending_admin_review'],
  pending_admin_approval:   ['completed', 'rejected'],
  pending_admin_review:     ['completed', 'rejected'],
  completed:                [],
  rejected:                 [],
  cancelled:                [],
};

/** Допустимые переходы для питчинга */
const PITCHING_TRANSITIONS: Record<string, string[]> = {
  draft:          ['pending_payment', 'pending_review'],
  pending_payment:['pending_review', 'cancelled'],
  pending_review: ['in_progress', 'rejected'],
  in_progress:    ['completed', 'cancelled'],
  completed:      [],
  rejected:       ['pending_review'], // повторная подача
  cancelled:      [],
};

/** Допустимые переходы для маркетинговых кампаний */
const MARKETING_TRANSITIONS: Record<string, string[]> = {
  pending_review: ['approved', 'rejected'],
  approved:       ['active', 'cancelled'],
  rejected:       ['pending_review'],  // повторная подача после доработки
  active:         ['paused', 'completed'],
  paused:         ['active', 'cancelled'],
  completed:      [],
  cancelled:      [],
};

/** Допустимые переходы для аудиобрендирования */
const AUDIO_BRANDING_TRANSITIONS: Record<string, string[]> = {
  draft:              ['pending_payment'],
  pending_payment:    ['paid', 'cancelled'],
  paid:               ['pending_review'],
  pending_review:     ['in_production', 'rejected'],
  rejected:           ['draft'],                         // доработка брифа
  in_production:      ['recording', 'cancelled'],
  recording:          ['mixing'],
  mixing:             ['mastering'],
  mastering:          ['ready_for_review'],
  ready_for_review:   ['client_approved', 'revision'],
  revision:           ['recording', 'mixing'],           // доработка
  client_approved:    ['delivering'],
  delivering:         ['completed'],
  completed:          [],
  cancelled:          [],
};

/** Допустимые переходы для 360° продакшна */
const PRODUCTION_360_TRANSITIONS: Record<string, string[]> = {
  draft:                ['pending_payment'],
  pending_payment:      ['paid', 'cancelled'],
  paid:                 ['pending_review'],
  pending_review:       ['approved', 'rejected'],
  rejected:             ['draft'],                         // доработка заявки
  approved:             ['concept', 'cancelled'],
  concept:              ['recording'],                     // концепция → запись
  recording:            ['mixing'],                        // запись → сведение
  mixing:               ['video_production', 'distribution'], // сведение → видео / сразу дистрибуция
  video_production:     ['distribution'],                  // видео → дистрибуция
  distribution:         ['promotion'],                     // дистрибуция → продвижение
  promotion:            ['ready_for_review'],              // продвижение → финальный ревью
  ready_for_review:     ['client_approved', 'revision'],
  revision:             ['concept', 'recording', 'mixing', 'video_production'], // доработка любого этапа
  client_approved:      ['completed'],
  completed:            [],
  cancelled:            [],
};

type PipelineType = 'content' | 'track_test' | 'pitching' | 'marketing' | 'audio_branding' | 'production_360';
type ContentType = 'track' | 'video' | 'track_test' | 'pitching' | 'marketing' | 'audio_branding' | 'production_360';
type ActorRole = 'admin' | 'artist' | 'expert' | 'system';

const TRANSITION_MAPS: Record<PipelineType, Record<string, string[]>> = {
  content: CONTENT_TRANSITIONS,
  track_test: TRACK_TEST_TRANSITIONS,
  pitching: PITCHING_TRANSITIONS,
  marketing: MARKETING_TRANSITIONS,
  audio_branding: AUDIO_BRANDING_TRANSITIONS,
  production_360: PRODUCTION_360_TRANSITIONS,
};

// ── Роли, которым разрешён переход ──

const TRANSITION_ROLES: Partial<Record<PipelineType, Record<string, ActorRole[]>>> = {
  content: {
    'awaiting_moderation→moderated': ['admin'],
    'awaiting_moderation→rejected': ['admin'],
    'moderated→in_novelty': ['admin'],
    'moderated→in_newsletter': ['admin'],
    'moderated→exclusive_pitched': ['admin'],
    'rejected→awaiting_moderation': ['artist'],
  },
  track_test: {
    'pending_payment→payment_succeeded': ['system'],
    'pending_moderation→moderation_rejected': ['admin'],
    'pending_moderation→pending_expert_assignment': ['admin'],
    'pending_expert_assignment→experts_assigned': ['admin'],
    'pending_admin_approval→completed': ['admin'],
    'pending_admin_approval→rejected': ['admin'],
  },
  pitching: {
    'pending_review→in_progress': ['admin'],
    'pending_review→rejected': ['admin'],
    'rejected→pending_review': ['artist'],
  },
  marketing: {
    'pending_review→approved': ['admin'],
    'pending_review→rejected': ['admin'],
    'approved→active': ['admin'],
    'approved→cancelled': ['admin', 'artist'],
    'rejected→pending_review': ['artist'],
    'active→paused': ['admin'],
    'active→completed': ['admin', 'system'],
    'paused→active': ['admin'],
    'paused→cancelled': ['admin'],
  },
  audio_branding: {
    'draft→pending_payment': ['artist'],
    'pending_payment→paid': ['system'],
    'pending_payment→cancelled': ['artist', 'admin'],
    'paid→pending_review': ['system'],
    'pending_review→in_production': ['admin'],
    'pending_review→rejected': ['admin'],
    'rejected→draft': ['artist'],
    'in_production→recording': ['admin', 'expert'],
    'in_production→cancelled': ['admin'],
    'recording→mixing': ['admin', 'expert'],
    'mixing→mastering': ['admin', 'expert'],
    'mastering→ready_for_review': ['admin', 'expert'],
    'ready_for_review→client_approved': ['artist'],
    'ready_for_review→revision': ['artist'],
    'revision→recording': ['admin', 'expert'],
    'revision→mixing': ['admin', 'expert'],
    'client_approved→delivering': ['admin'],
    'delivering→completed': ['admin', 'system'],
  },
  production_360: {
    'draft→pending_payment': ['artist'],
    'pending_payment→paid': ['system'],
    'pending_payment→cancelled': ['artist', 'admin'],
    'paid→pending_review': ['system'],
    'pending_review→approved': ['admin'],
    'pending_review→rejected': ['admin'],
    'rejected→draft': ['artist'],
    'approved→concept': ['admin', 'expert'],
    'approved→cancelled': ['admin'],
    'concept→recording': ['admin', 'expert'],
    'recording→mixing': ['admin', 'expert'],
    'mixing→video_production': ['admin', 'expert'],
    'mixing→distribution': ['admin', 'expert'],
    'video_production→distribution': ['admin', 'expert'],
    'distribution→promotion': ['admin', 'expert'],
    'promotion→ready_for_review': ['admin', 'expert'],
    'ready_for_review→client_approved': ['artist'],
    'ready_for_review→revision': ['artist'],
    'revision→concept': ['admin', 'expert'],
    'revision→recording': ['admin', 'expert'],
    'revision→mixing': ['admin', 'expert'],
    'revision→video_production': ['admin', 'expert'],
    'client_approved→completed': ['admin', 'system'],
  },
};

// ── Финальные статусы (нельзя ничего делать дальше) ──

const FINAL_STATUSES: Record<PipelineType, string[]> = {
  content: ['completed'],
  track_test: ['completed', 'rejected', 'cancelled', 'moderation_rejected'],
  pitching: ['completed', 'cancelled'],
  marketing: ['completed', 'cancelled'],
  audio_branding: ['completed', 'cancelled'],
  production_360: ['completed', 'cancelled'],
};

// ── Человекочитаемые названия статусов ──

const STATUS_LABELS: Record<string, string> = {
  // Content
  awaiting_moderation: 'Ожидает модерации',
  moderated: 'Промодерирован',
  in_novelty: 'В новинках',
  in_newsletter: 'В рассылке',
  exclusive_pitched: 'Эксклюзивный питчинг',
  // Track test
  pending_payment: 'Ожидает оплаты',
  payment_succeeded: 'Оплачен',
  pending_moderation: 'На модерации',
  moderation_rejected: 'Отклонён модерацией',
  pending_expert_assignment: 'Назначение экспертов',
  experts_assigned: 'Эксперты назначены',
  in_review: 'На рецензии',
  review_in_progress: 'Рецензия в процессе',
  analysis_generated: 'Анализ готов',
  pending_admin_approval: 'Ожидает одобрения',
  pending_admin_review: 'На ревью у админа',
  // Pitching
  draft: 'Черновик',
  pending_review: 'На модерации',
  in_progress: 'В работе',
  // Marketing
  approved: 'Одобрена',
  active: 'Активна',
  paused: 'На паузе',
  // Production 360
  concept: 'Концепция',
  video_production: 'Видеопродакшн',
  distribution: 'Дистрибуция',
  promotion: 'Продвижение',
  // Audio Branding
  paid: 'Оплачен',
  in_production: 'В производстве',
  recording: 'Запись',
  mixing: 'Сведение',
  mastering: 'Мастеринг',
  ready_for_review: 'Готов к прослушке',
  client_approved: 'Утверждён клиентом',
  revision: 'На доработке',
  delivering: 'Доставка файлов',
  // Common
  completed: 'Завершено',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
};

/**
 * Проверяет, допустим ли переход из текущего статуса в новый
 */
export function canTransition(pipelineType: PipelineType, currentStatus: string, newStatus: string): boolean {
  const map = TRANSITION_MAPS[pipelineType];
  const allowed = map[currentStatus];
  if (!allowed) return false;
  return allowed.includes(newStatus);
}

/**
 * Валидирует переход и возвращает ошибку, если недопустим.
 * Опционально проверяет роль актора.
 */
export function validateTransition(
  pipelineType: PipelineType,
  currentStatus: string,
  newStatus: string,
  actorRole?: ActorRole,
): { valid: boolean; error?: string } {
  if (!TRANSITION_MAPS[pipelineType]) {
    return { valid: false, error: `Неизвестный тип пайплайна: "${pipelineType}"` };
  }
  if (!TRANSITION_MAPS[pipelineType][currentStatus]) {
    return { valid: false, error: `Неизвестный статус: "${currentStatus}" для пайплайна "${pipelineType}"` };
  }
  if (!canTransition(pipelineType, currentStatus, newStatus)) {
    const allowed = TRANSITION_MAPS[pipelineType][currentStatus];
    return {
      valid: false,
      error: `Переход "${statusLabel(currentStatus)}" → "${statusLabel(newStatus)}" запрещён. Допустимые: ${allowed.map(s => statusLabel(s)).join(', ') || 'нет (финальный статус)'}`,
    };
  }
  // Проверка роли (если задана)
  if (actorRole) {
    const key = `${currentStatus}→${newStatus}`;
    const allowedRoles = TRANSITION_ROLES[pipelineType]?.[key];
    if (allowedRoles && !allowedRoles.includes(actorRole)) {
      return {
        valid: false,
        error: `Роль "${actorRole}" не может выполнить переход "${statusLabel(currentStatus)}" → "${statusLabel(newStatus)}". Допустимые роли: ${allowedRoles.join(', ')}`,
      };
    }
  }
  return { valid: true };
}

/**
 * Возвращает все допустимые следующие статусы
 */
export function getNextStatuses(pipelineType: PipelineType, currentStatus: string): string[] {
  return TRANSITION_MAPS[pipelineType]?.[currentStatus] || [];
}

/**
 * Проверяет, является ли статус финальным
 */
export function isFinalStatus(pipelineType: PipelineType, status: string): boolean {
  return FINAL_STATUSES[pipelineType]?.includes(status) || false;
}

/**
 * Человекочитаемое название статуса
 */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

/**
 * Полная карта пайплайна с метаданными
 */
export function getPipelineMap(pipelineType: PipelineType) {
  const map = TRANSITION_MAPS[pipelineType];
  if (!map) return null;
  return Object.entries(map).map(([status, nextStatuses]) => ({
    status,
    label: statusLabel(status),
    is_final: nextStatuses.length === 0,
    next: nextStatuses.map(s => ({ status: s, label: statusLabel(s) })),
    sla_hours: DEFAULT_SLA[pipelineType]?.[status] || null,
    allowed_roles: Object.entries(TRANSITION_ROLES[pipelineType] || {})
      .filter(([key]) => key.startsWith(`${status}→`))
      .map(([key, roles]) => ({ to: key.split('→')[1], roles })),
  }));
}

// ============================================
// 2. UNIFIED EXECUTE TRANSITION
// ============================================

export interface TransitionParams {
  pipelineType: PipelineType;
  contentType: ContentType;
  itemId: string;
  itemTitle: string;
  fromStatus: string;
  toStatus: string;
  actorId: string;
  actorRole: ActorRole;
  action: string;
  details?: string;
  price?: number;
  metadata?: Record<string, any>;
  // SSE уведомления
  notifyUserIds?: string[];
  sseEventType?: string;
  sseData?: Record<string, any>;
}

/**
 * Единый метод выполнения перехода:
 *   1. Валидация state machine (с проверкой роли)
 *   2. Аудит-лог
 *   3. SSE уведомления
 *
 * Возвращает { success, error?, audit? }
 * Вызывающий код сам обновляет данные в БД и вызывает recordRevenue
 */
export function executeTransition(params: TransitionParams): {
  success: boolean;
  error?: string;
  audit?: AuditEntry;
} {
  // 1. Validate
  const transition = validateTransition(
    params.pipelineType,
    params.fromStatus,
    params.toStatus,
    params.actorRole,
  );
  if (!transition.valid) {
    return { success: false, error: transition.error };
  }

  // 2. Audit log
  const audit = logAudit({
    pipeline_type: params.pipelineType,
    content_type: params.contentType,
    item_id: params.itemId,
    item_title: params.itemTitle,
    action: params.action,
    from_status: params.fromStatus,
    to_status: params.toStatus,
    actor_id: params.actorId,
    actor_role: params.actorRole,
    details: params.details,
    price: params.price,
    metadata: params.metadata,
  });

  // 3. SSE notifications
  if (params.notifyUserIds && params.sseEventType) {
    const ssePayload = {
      type: params.sseEventType,
      data: {
        itemId: params.itemId,
        itemTitle: params.itemTitle,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        action: params.action,
        price: params.price,
        ...params.sseData,
      },
    };
    for (const userId of params.notifyUserIds) {
      emitSSE(userId, ssePayload);
    }
  }

  return { success: true, audit };
}

// ============================================
// 3. AUDIT LOG — ПЕРСИСТЕНТНЫЙ + IN-MEMORY
// ============================================

export interface AuditEntry {
  id: string;
  timestamp: string;
  pipeline_type: PipelineType;
  content_type: ContentType;
  item_id: string;
  item_title: string;
  action: string;
  from_status: string | null;
  to_status: string;
  actor_id: string;
  actor_role: ActorRole;
  details?: string;
  price?: number;
  metadata?: Record<string, any>;
}

// In-memory audit log + DB persistence
const auditLog: AuditEntry[] = [];

// Lazy DB store — загружается при первом обращении
let _auditDbStore: any = null;
async function getAuditDbStore() {
  if (!_auditDbStore) {
    try {
      const dbMod = await import('./db.tsx');
      // Используем общий jsonbStore pattern — таблица pipeline_audit
      if (typeof (dbMod as any).jsonbStore === 'function') {
        _auditDbStore = (dbMod as any).jsonbStore('pipeline_audit');
      }
    } catch (_) {
      // DB not available — работаем только in-memory
    }
  }
  return _auditDbStore;
}

/**
 * Записывает действие в аудит-лог (in-memory + async persist в DB)
 */
export function logAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
  const full: AuditEntry = {
    ...entry,
    id: `audit-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date().toISOString(),
  };
  auditLog.push(full);

  // Ограничиваем размер in-memory лога (последние 10 000 записей)
  if (auditLog.length > 10000) {
    auditLog.splice(0, auditLog.length - 10000);
  }

  // Async persist to DB (fire-and-forget)
  persistAuditEntry(full).catch(() => {});

  return full;
}

async function persistAuditEntry(entry: AuditEntry) {
  const store = await getAuditDbStore();
  if (store) {
    await store.set(entry.id, entry);
  }
}

/**
 * Получить аудит-лог для конкретного элемента
 */
export function getAuditForItem(itemId: string): AuditEntry[] {
  return auditLog.filter(e => e.item_id === itemId);
}

/**
 * Получить аудит-лог с фильтрами
 */
export function getAuditLog(filters?: {
  pipeline_type?: PipelineType;
  content_type?: string;
  actor_id?: string;
  actor_role?: ActorRole;
  action?: string;
  item_id?: string;
  from?: string;  // ISO date
  to?: string;    // ISO date
  limit?: number;
  offset?: number;
}): { entries: AuditEntry[]; total: number } {
  let result = [...auditLog];

  if (filters?.pipeline_type) {
    result = result.filter(e => e.pipeline_type === filters.pipeline_type);
  }
  if (filters?.content_type) {
    result = result.filter(e => e.content_type === filters.content_type);
  }
  if (filters?.actor_id) {
    result = result.filter(e => e.actor_id === filters.actor_id);
  }
  if (filters?.actor_role) {
    result = result.filter(e => e.actor_role === filters.actor_role);
  }
  if (filters?.action) {
    result = result.filter(e => e.action === filters.action);
  }
  if (filters?.item_id) {
    result = result.filter(e => e.item_id === filters.item_id);
  }
  if (filters?.from) {
    result = result.filter(e => e.timestamp >= filters.from!);
  }
  if (filters?.to) {
    result = result.filter(e => e.timestamp <= filters.to!);
  }

  // Последние записи первыми
  result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const total = result.length;
  const offset = filters?.offset || 0;
  const limit = filters?.limit || 50;

  return {
    entries: result.slice(offset, offset + limit),
    total,
  };
}

/**
 * Получить хронологию переходов для элемента
 */
export function getItemTimeline(itemId: string): {
  transitions: { from: string; to: string; label: string; actor: string; timestamp: string; duration_hours?: number }[];
  total_duration_hours: number;
  current_status: string | null;
} {
  const entries = auditLog
    .filter(e => e.item_id === itemId && e.from_status !== null)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const transitions = entries.map((e, i) => {
    const nextEntry = entries[i + 1];
    const durationMs = nextEntry
      ? new Date(nextEntry.timestamp).getTime() - new Date(e.timestamp).getTime()
      : undefined;

    return {
      from: e.from_status!,
      to: e.to_status,
      label: `${statusLabel(e.from_status!)} → ${statusLabel(e.to_status)}`,
      actor: `${e.actor_role}:${e.actor_id}`,
      timestamp: e.timestamp,
      duration_hours: durationMs ? Math.round(durationMs / 3600000 * 10) / 10 : undefined,
    };
  });

  const firstTs = entries[0]?.timestamp;
  const lastTs = entries[entries.length - 1]?.timestamp;
  const totalMs = firstTs && lastTs
    ? new Date(lastTs).getTime() - new Date(firstTs).getTime()
    : 0;

  return {
    transitions,
    total_duration_hours: Math.round(totalMs / 3600000 * 10) / 10,
    current_status: entries.length > 0 ? entries[entries.length - 1].to_status : null,
  };
}

// ============================================
// 4. SLA TRACKING — ДЕДЛАЙНЫ И ПРОСРОЧКИ
// ============================================

/** SLA по умолчанию (в часах) для каждого статуса */
const DEFAULT_SLA: Record<string, Record<string, number>> = {
  content: {
    awaiting_moderation: 24,
    moderated: 72,
    in_novelty: 336,
    in_newsletter: 168,
    exclusive_pitched: 168,
  },
  track_test: {
    pending_payment: 48,
    payment_succeeded: 12,
    pending_moderation: 24,
    pending_expert_assignment: 24,
    experts_assigned: 72,
    review_in_progress: 72,
    analysis_generated: 24,
    pending_admin_approval: 24,
  },
  pitching: {
    pending_review: 48,
    in_progress: 168,
  },
  marketing: {
    pending_review: 48,
    approved: 72,
    active: 720,
    paused: 168,
  },
  audio_branding: {
    pending_payment: 72,         // 3 дня на оплату
    paid: 24,                    // 24 часа — начать ревью брифа
    pending_review: 48,          // 2 дня на ревью брифа
    in_production: 48,           // 2 дня — начать запись
    recording: 120,              // 5 дней на запись
    mixing: 72,                  // 3 дня на сведение
    mastering: 48,               // 2 дня на мастеринг
    ready_for_review: 72,        // 3 дня на прослушку клиентом
    revision: 120,               // 5 дней на доработку
    client_approved: 24,         // 24 часа — начать доставку
    delivering: 24,              // 24 часа — отправить файлы
  },
  production_360: {
    pending_payment: 72,         // 3 дня на оплату
    paid: 24,                    // 24 часа — начать ревью
    pending_review: 48,          // 2 дня на ревью заявки
    approved: 72,                // 3 дня — начать концепцию
    concept: 168,                // 7 дней на концепцию
    recording: 240,              // 10 дней на запись
    mixing: 120,                 // 5 дней на сведение
    video_production: 336,       // 14 дней на видео
    distribution: 72,            // 3 дня на дистрибуцию
    promotion: 336,              // 14 дней на продвижение
    ready_for_review: 72,        // 3 дня на финальный ревью клиентом
    revision: 168,               // 7 дней на доработку
    client_approved: 48,         // 2 дня на финализацию
  },
};

export interface SLAStatus {
  item_id: string;
  current_status: string;
  status_label: string;
  status_entered_at: string;
  sla_hours: number;
  sla_deadline: string;
  is_overdue: boolean;
  hours_remaining: number;
  urgency: 'ok' | 'warning' | 'critical' | 'overdue';
}

/**
 * Рассчитать SLA для элемента
 */
export function calculateSLA(
  pipelineType: PipelineType,
  itemId: string,
  currentStatus: string,
  statusEnteredAt: string,
): SLAStatus | null {
  const slaMap = DEFAULT_SLA[pipelineType];
  if (!slaMap || !slaMap[currentStatus]) return null;

  const slaHours = slaMap[currentStatus];
  const entered = new Date(statusEnteredAt).getTime();
  const deadline = entered + slaHours * 60 * 60 * 1000;
  const now = Date.now();
  const hoursRemaining = Math.round((deadline - now) / (60 * 60 * 1000) * 10) / 10;
  const isOverdue = now > deadline;

  let urgency: 'ok' | 'warning' | 'critical' | 'overdue' = 'ok';
  if (isOverdue) urgency = 'overdue';
  else if (hoursRemaining < slaHours * 0.1) urgency = 'critical';   // <10% — критическое
  else if (hoursRemaining < slaHours * 0.25) urgency = 'warning';   // <25% — предупреждение

  return {
    item_id: itemId,
    current_status: currentStatus,
    status_label: statusLabel(currentStatus),
    status_entered_at: statusEnteredAt,
    sla_hours: slaHours,
    sla_deadline: new Date(deadline).toISOString(),
    is_overdue: isOverdue,
    hours_remaining: hoursRemaining,
    urgency,
  };
}

/**
 * Batch SLA check — проверить SLA для списка элементов
 */
export function batchCheckSLA(items: {
  pipeline_type: PipelineType;
  item_id: string;
  current_status: string;
  status_entered_at: string;
}[]): {
  results: SLAStatus[];
  summary: { total: number; ok: number; warning: number; critical: number; overdue: number };
} {
  const results: SLAStatus[] = [];
  const summary = { total: 0, ok: 0, warning: 0, critical: 0, overdue: 0 };

  for (const item of items) {
    const sla = calculateSLA(item.pipeline_type, item.item_id, item.current_status, item.status_entered_at);
    if (sla) {
      results.push(sla);
      summary.total++;
      summary[sla.urgency]++;
    }
  }

  // Сортировка: overdue → critical → warning → ok
  const urgencyOrder = { overdue: 0, critical: 1, warning: 2, ok: 3 };
  results.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

  return { results, summary };
}

// ============================================
// 5. ANALYTICS HELPERS
// ============================================

export interface PipelineAnalytics {
  total_items: number;
  by_status: Record<string, number>;
  avg_time_in_status: Record<string, number>;
  overdue_count: number;
  completed_today: number;
  completed_this_week: number;
  revenue_total: number;
}

/**
 * Вычислить аналитику пайплайна на основе аудит-лога
 */
export function computeAnalytics(contentType: string): {
  total_actions: number;
  actions_today: number;
  actions_this_week: number;
  top_actions: { action: string; count: number }[];
  revenue_from_actions: number;
  avg_transition_hours: number;
  actors_summary: { actor_id: string; role: string; actions: number }[];
} {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);

  const entries = auditLog.filter(e => e.content_type === contentType);
  const todayEntries = entries.filter(e => e.timestamp >= todayStart.toISOString());
  const weekEntries = entries.filter(e => e.timestamp >= weekStart.toISOString());

  // Top actions
  const actionCounts: Record<string, number> = {};
  for (const e of entries) {
    actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
  }
  const topActions = Object.entries(actionCounts)
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const revenue = entries.reduce((sum, e) => sum + (e.price || 0), 0);

  // Среднее время между переходами (для элементов с несколькими записями)
  const itemGroups: Record<string, string[]> = {};
  for (const e of entries) {
    if (!itemGroups[e.item_id]) itemGroups[e.item_id] = [];
    itemGroups[e.item_id].push(e.timestamp);
  }
  let totalTransitionMs = 0;
  let transitionCount = 0;
  for (const timestamps of Object.values(itemGroups)) {
    if (timestamps.length < 2) continue;
    timestamps.sort();
    for (let i = 1; i < timestamps.length; i++) {
      totalTransitionMs += new Date(timestamps[i]).getTime() - new Date(timestamps[i - 1]).getTime();
      transitionCount++;
    }
  }
  const avgTransitionHours = transitionCount > 0
    ? Math.round(totalTransitionMs / transitionCount / 3600000 * 10) / 10
    : 0;

  // Actors summary
  const actorMap: Record<string, { role: string; actions: number }> = {};
  for (const e of entries) {
    const key = `${e.actor_role}:${e.actor_id}`;
    if (!actorMap[key]) actorMap[key] = { role: e.actor_role, actions: 0 };
    actorMap[key].actions++;
  }
  const actorsSummary = Object.entries(actorMap)
    .map(([key, val]) => ({ actor_id: key.split(':')[1], role: val.role, actions: val.actions }))
    .sort((a, b) => b.actions - a.actions)
    .slice(0, 20);

  return {
    total_actions: entries.length,
    actions_today: todayEntries.length,
    actions_this_week: weekEntries.length,
    top_actions: topActions,
    revenue_from_actions: revenue,
    avg_transition_hours: avgTransitionHours,
    actors_summary: actorsSummary,
  };
}

/**
 * Общая статистика по всем пайплайнам
 */
export function computeGlobalStats(): {
  total_audit_entries: number;
  by_pipeline: Record<string, number>;
  by_content_type: Record<string, number>;
  total_revenue: number;
  today_revenue: number;
} {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const byPipeline: Record<string, number> = {};
  const byContentType: Record<string, number> = {};
  let totalRevenue = 0;
  let todayRevenue = 0;

  for (const e of auditLog) {
    byPipeline[e.pipeline_type] = (byPipeline[e.pipeline_type] || 0) + 1;
    byContentType[e.content_type] = (byContentType[e.content_type] || 0) + 1;
    totalRevenue += e.price || 0;
    if (e.timestamp >= todayIso) todayRevenue += e.price || 0;
  }

  return {
    total_audit_entries: auditLog.length,
    by_pipeline: byPipeline,
    by_content_type: byContentType,
    total_revenue: totalRevenue,
    today_revenue: todayRevenue,
  };
}

// ============================================
// EXPORTS
// ============================================

export {
  CONTENT_TRANSITIONS,
  TRACK_TEST_TRANSITIONS,
  PITCHING_TRANSITIONS,
  MARKETING_TRANSITIONS,
  AUDIO_BRANDING_TRANSITIONS,
  PRODUCTION_360_TRANSITIONS,
  TRANSITION_ROLES,
  FINAL_STATUSES,
  STATUS_LABELS,
  DEFAULT_SLA,
};
export type { PipelineType, ContentType, ActorRole };
