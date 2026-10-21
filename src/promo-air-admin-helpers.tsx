/**
 * PROMO.AIR ADMIN: чистые помощники для promo-air-admin-routes.tsx.
 *
 * Курсоры (created_at, id), фильтры списка заведений, допустимые переходы
 * статуса аккаунта, разбор ввода админа, расчёт данных тарифа и пробного
 * периода, сборка строк ответа. Без БД и сети: проверяются
 * ~/Projects/promoair/tools/be-admin.test.mts.
 *
 * SQL-фрагменты ниже рассчитаны на псевдонимы u (users) и vp
 * (venue_profiles), как в запросах promo-air-admin-routes.tsx.
 */

import { getEffectiveVenuePlan, type VenuePlanId } from './venue-plan-limits.tsx';
import { isVenuePaidTier, isVenueAutoRenewOff, type VenueInterval, type VenuePlanKey } from './venue-plans-constants.tsx';

const DAY_MS = 24 * 60 * 60 * 1000;

export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const isoOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return String(v);
};

// ── Пагинация: limit 1..100 (по умолчанию 50), курсор (created_at, id) ──

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

export function parseLimit(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return PAGE_DEFAULT;
  return Math.min(Math.max(n, 1), PAGE_MAX);
}

export type IdKind = 'uuid' | 'bigint';
export interface Cursor { at: string; id: string }

// Время курсора берём из Postgres текстом (created_at::text), а не из JS Date:
// Date режет микросекунды, и строки внутри одной миллисекунды терялись бы
// между страницами.
const PG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
}

/** Пустой курсор = первая страница; мусор = { ok: false } (ответ 400). */
export function decodeCursor(raw: unknown, idKind: IdKind): { ok: true; cursor: Cursor | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, cursor: null };
  if (typeof raw !== 'string' || raw.length > 200) return { ok: false };
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2) return { ok: false };
    const [at, id] = v;
    if (typeof at !== 'string' || !PG_TIMESTAMP_RE.test(at)) return { ok: false };
    const idOk = idKind === 'uuid' ? isUuid(id) : typeof id === 'string' && /^\d{1,19}$/.test(id);
    if (!idOk) return { ok: false };
    return { ok: true, cursor: { at, id } };
  } catch {
    return { ok: false };
  }
}

/** Запрос берёт limit + 1 строк: лишняя означает, что есть следующая страница. */
export function pageOf<T extends { cursor_at: string; cursor_id: string }>(rows: T[], limit: number): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: encodeCursor(last.cursor_at, last.cursor_id) };
}

// ── Фильтры списка заведений ──

// 'suspended' кодом не ставится, но в админке значит то же, что блокировка.
export const BLOCKED_STATUSES = ['banned', 'blocked', 'suspended'] as const;

const ACCOUNT_STATUS_FILTER: Record<string, readonly string[]> = {
  pending: ['pending'],
  active: ['active'],
  rejected: ['rejected'],
  inactive: ['inactive'],
  blocked: BLOCKED_STATUSES,
};
export const SUBSCRIPTION_STATUSES = ['pending_card', 'trial', 'active', 'cancelled', 'expired'] as const;
export const EFFECTIVE_PLANS: readonly VenuePlanId[] = ['free', 'start', 'business', 'network', 'enterprise'];

export const VENUE_NAME_SQL = `COALESCE(vp.venue_name, vp.data->>'venueName', vp.data->>'name')`;
export const CITY_SQL = `COALESCE(vp.city, vp.data->>'city')`;
// Контактное лицо из регистрации (users.settings.application, auth-routes) или профиля.
export const CONTACT_NAME_SQL = `NULLIF(COALESCE(NULLIF(u.settings->'application'->>'contactName', ''), vp.data->>'contactName'), '')`;
// Заявка при регистрации (21.10.2026, venue-application.tsx): телефон, город, тип
// и число точек. Профиль заведения (его правит кабинет) первым, затем заявка:
// у заведения на проверке профиля ещё нет, и команда видит данные заявки.
export const VENUE_PHONE_SQL = `NULLIF(COALESCE(NULLIF(vp.phone, ''), NULLIF(vp.data->>'phone', ''), u.settings->'application'->>'phone'), '')`;
export const VENUE_CITY_SQL = `NULLIF(COALESCE(NULLIF(${CITY_SQL}, ''), u.settings->'application'->>'city'), '')`;
export const VENUE_TYPE_SQL = `NULLIF(COALESCE(NULLIF(COALESCE(vp.venue_type, vp.data->>'venueType', vp.data->>'type'), ''), u.settings->'application'->>'venueType'), '')`;
export const VENUE_POINTS_SQL = `NULLIF(u.settings->'application'->>'points', '')`;
export const SUB_STATUS_SQL = `lower(COALESCE(NULLIF(vp.data->>'subscriptionStatus', ''), 'pending_card'))`;

// Действующий тариф в SQL: копия getEffectiveVenuePlan (venue-plan-limits.tsx)
// для фильтра ?plan= с курсорной пагинацией. Нет профиля = статус pending_card
// = 'free'. Битая дата в data не роняет запрос (pg_input_is_valid, PG 16) и
// читается как «срок прошёл», как NaN в JS. Совпадение с JS проверяет
// tools/be-admin-e2e.test.mts; меняя одно, меняйте и другое.
const PLAN_SQL = `lower(COALESCE(vp.data->>'subscriptionPlan', ''))`;
const TRIAL_PLAN_SQL = `CASE WHEN ${PLAN_SQL} IN ('start', 'business', 'network') THEN ${PLAN_SQL} ELSE 'start' END`;
const CANCEL_UNTIL_SQL = `COALESCE(NULLIF(vp.data->>'subscriptionExpiresAt', ''), NULLIF(vp.data->>'trial_expires_at', ''))`;
export const EFFECTIVE_PLAN_SQL = `(CASE ${SUB_STATUS_SQL}
  WHEN 'trial' THEN ${TRIAL_PLAN_SQL}
  WHEN 'cancelled' THEN CASE
    WHEN NOT COALESCE(pg_input_is_valid(${CANCEL_UNTIL_SQL}, 'timestamptz'), false) THEN 'free'
    WHEN (${CANCEL_UNTIL_SQL})::timestamptz <= NOW() THEN 'free'
    WHEN vp.data->>'cancelledFromStatus' = 'trial' THEN ${TRIAL_PLAN_SQL}
    WHEN ${PLAN_SQL} IN ('start', 'business', 'network', 'enterprise') THEN ${PLAN_SQL}
    ELSE 'free' END
  WHEN 'active' THEN CASE
    WHEN COALESCE(NULLIF(${PLAN_SQL}, ''), 'start') IN ('free', 'start', 'business', 'network', 'enterprise')
      THEN COALESCE(NULLIF(${PLAN_SQL}, ''), 'start')
    ELSE 'free' END
  ELSE 'free' END)`;

/** % _ и \ из поиска ищутся буквально, а не как шаблон LIKE. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export type FilterResult =
  | { ok: true; where: string[]; params: unknown[] }
  | { ok: false; field: string; message: string };

/**
 * WHERE-условия списка заведений из query (?q=&status=&plan=&city=&sub=).
 * Плейсхолдеры нумеруются с firstParam. status: статус аккаунта
 * (blocked = banned / blocked / suspended); plan: действующий тариф;
 * sub: статус подписки (pending_card / trial / active / cancelled / expired).
 */
export function buildVenueFilters(query: Record<string, string | undefined>, firstParam = 1): FilterResult {
  const where: string[] = [];
  const params: unknown[] = [];
  const next = (v: unknown) => { params.push(v); return `$${firstParam + params.length - 1}`; };

  const q = String(query.q ?? '').trim();
  if (q) {
    if (q.length > 100) return { ok: false, field: 'q', message: 'Слишком длинный поисковый запрос (до 100 символов).' };
    const p = next(`%${escapeLike(q)}%`);
    where.push(`(u.email ILIKE ${p} ESCAPE '\\' OR u.full_name ILIKE ${p} ESCAPE '\\' OR u.display_name ILIKE ${p} ESCAPE '\\'`
      + ` OR u.username ILIKE ${p} ESCAPE '\\' OR ${VENUE_NAME_SQL} ILIKE ${p} ESCAPE '\\' OR ${VENUE_CITY_SQL} ILIKE ${p} ESCAPE '\\'`
      + ` OR ${CONTACT_NAME_SQL} ILIKE ${p} ESCAPE '\\')`);
  }

  const status = String(query.status ?? '').trim().toLowerCase();
  if (status) {
    const set = Object.prototype.hasOwnProperty.call(ACCOUNT_STATUS_FILTER, status) ? ACCOUNT_STATUS_FILTER[status] : null;
    if (!set) return { ok: false, field: 'status', message: 'Неизвестный статус аккаунта.' };
    where.push(`u.status::text = ANY(${next([...set])}::text[])`);
  }

  const plan = String(query.plan ?? '').trim().toLowerCase();
  if (plan) {
    if (!EFFECTIVE_PLANS.includes(plan as VenuePlanId)) return { ok: false, field: 'plan', message: 'Неизвестный тариф.' };
    where.push(`${EFFECTIVE_PLAN_SQL} = ${next(plan)}`);
  }

  const sub = String(query.sub ?? '').trim().toLowerCase();
  if (sub) {
    if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(sub)) return { ok: false, field: 'sub', message: 'Неизвестный статус подписки.' };
    where.push(`${SUB_STATUS_SQL} = ${next(sub)}`);
  }

  const city = String(query.city ?? '').trim();
  if (city) {
    if (city.length > 100) return { ok: false, field: 'city', message: 'Слишком длинное название города.' };
    where.push(`lower(${VENUE_CITY_SQL}) = lower(${next(city)})`);
  }

  return { ok: true, where, params };
}

// ── Статус аккаунта: допустимые переходы ──

export type AccountAction = 'approve' | 'reject' | 'block' | 'restore';

export const ACCOUNT_TRANSITIONS: Record<AccountAction, { from: readonly string[]; to: string }> = {
  approve: { from: ['pending'], to: 'active' },
  reject: { from: ['pending'], to: 'rejected' },
  block: { from: ['active', 'pending', 'rejected', 'inactive'], to: 'banned' },
  // to по умолчанию; фактически restoreTarget (статус до блокировки)
  restore: { from: BLOCKED_STATUSES, to: 'active' },
};

/**
 * Во что вернуть аккаунт при восстановлении: в статус до блокировки
 * (details.before.accountStatus последней promoair_venue_block). Иначе
 * блокировка заявки на проверке или отклонённой с последующим
 * восстановлением одобряла бы аккаунт без проверки. Нет записи (блок из
 * других разделов админки) или статус не из списка → active, как раньше.
 */
export function restoreTarget(statusBeforeBlock: unknown): string {
  return statusBeforeBlock === 'pending' || statusBeforeBlock === 'rejected' || statusBeforeBlock === 'inactive'
    ? statusBeforeBlock
    : ACCOUNT_TRANSITIONS.restore.to;
}

export function canTransition(action: AccountAction, from: string | null | undefined): boolean {
  return !!from && ACCOUNT_TRANSITIONS[action].from.includes(from);
}

/** Тариф и пробный назначаются действующим аккаунтам и ждущим проверки. */
export const PLAN_ACCOUNT_STATUSES: readonly string[] = ['active', 'pending'];

// ── Ввод админа ──

export const REASON_MAX = 500;

export function parseReason(raw: unknown, required: boolean): { ok: true; reason: string | null } | { ok: false } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return required ? { ok: false } : { ok: true, reason: null };
  return { ok: true, reason: s.slice(0, REASON_MAX) };
}

export const TRIAL_EXTEND_MAX_DAYS = 60;
export const PLAN_ACTIVE_MAX_DAYS = 3 * 366;

export function parseTrialDays(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= TRIAL_EXTEND_MAX_DAYS ? n : null;
}

/** 'YYYY-MM-DD' → конец этого дня по Москве (UTC+3, без перехода на летнее время). */
export function untilEndOfDayMsk(ymd: unknown): string | null {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return new Date(`${ymd}T23:59:59.000+03:00`).toISOString();
}

export interface PlanAssignment {
  plan: VenuePlanKey;
  status: 'active' | 'trial';
  untilIso: string;
  interval: VenueInterval | null;
}

/**
 * POST /venues/:id/plan {plan, status, until, reason, interval?}. До: с
 * завтрашнего дня; пробный не дольше 60 дней вперёд, оплаченный не дольше
 * трёх лет. interval необязателен (по умолчанию остаётся прежний).
 */
export function parsePlanAssignment(body: any, nowMs: number): { ok: true; value: PlanAssignment } | { ok: false; field: string; message: string } {
  const plan = String(body?.plan ?? '').toLowerCase();
  if (!isVenuePaidTier(plan)) return { ok: false, field: 'plan', message: 'Тариф: start, business или network.' };
  const status = body?.status;
  if (status !== 'active' && status !== 'trial') return { ok: false, field: 'status', message: 'Статус: active или trial.' };
  let interval: VenueInterval | null = null;
  if (body?.interval !== undefined && body?.interval !== null && body?.interval !== '') {
    if (body.interval !== 'month' && body.interval !== 'year') return { ok: false, field: 'interval', message: 'Период: month или year.' };
    interval = body.interval;
  }
  const untilIso = untilEndOfDayMsk(body?.until);
  if (!untilIso) return { ok: false, field: 'until', message: 'Дата окончания в формате ГГГГ-ММ-ДД.' };
  const untilMs = Date.parse(untilIso);
  const maxDays = status === 'trial' ? TRIAL_EXTEND_MAX_DAYS : PLAN_ACTIVE_MAX_DAYS;
  if (untilMs <= nowMs) return { ok: false, field: 'until', message: 'Дата окончания должна быть в будущем.' };
  if (untilMs > nowMs + (maxDays + 1) * DAY_MS) {
    return { ok: false, field: 'until', message: status === 'trial' ? 'Пробный период: не дальше 60 дней вперёд.' : 'Оплаченный период: не дальше трёх лет вперёд.' };
  }
  return { ok: true, value: { plan, status, untilIso, interval } };
}

// ── Данные подписки (venue_profiles.data) ──

export interface SubscriptionSnapshot {
  status: string;
  plan: string | null;
  interval: string | null;
  expiresAt: string | null;
  trialExpiresAt: string | null;
}

export function subscriptionSnapshot(data: any): SubscriptionSnapshot {
  const d = data && typeof data === 'object' ? data : {};
  return {
    status: d.subscriptionStatus || 'pending_card',
    plan: d.subscriptionPlan || null,
    interval: d.subscriptionInterval || null,
    expiresAt: d.subscriptionExpiresAt || null,
    trialExpiresAt: d.trial_expires_at || null,
  };
}

/**
 * Тариф от админа без оплаты: те же поля, что пишет оплата (checkout-routes,
 * ветка venue_subscription), плюс отметка subscriptionAssignedByAdminAt.
 * Пометки отмены и истечения снимаются. subscriptionPriceRub = 0: этот
 * период никто не оплачивал. Пробный: срок пробного и сброс напоминаний
 * T-3 / T-1, чтобы они пришли к новой дате.
 * autoRenew: false: назначение «без списания» (PLAN §3.6) не превращается в
 * списание с сохранённой карты. Кроны такой период не списывают и по
 * окончании переводят в expired (письмо «автопродление не было включено»).
 * Флаг снимают оплата тарифа, /venue-billing/resume и привязка карты в пробном.
 */
export function planAssignmentData(prev: any, a: PlanAssignment, nowIso: string): Record<string, any> {
  const p = prev && typeof prev === 'object' ? prev : {};
  const next: Record<string, any> = {
    ...p,
    subscriptionStatus: a.status,
    subscriptionPlan: a.plan,
    subscriptionInterval: a.interval || (p.subscriptionInterval === 'year' ? 'year' : 'month'),
    subscriptionExpiresAt: a.untilIso,
    subscriptionPriceRub: 0,
    subscriptionUpdatedAt: nowIso,
    subscriptionAssignedByAdminAt: nowIso,
    cancelledFromStatus: null,
    subscriptionCancelledAt: null,
    subscriptionExpiredReason: null,
    autoRenew: false,
    updatedAt: nowIso,
  };
  if (a.status === 'trial') {
    next.trial_expires_at = a.untilIso;
    next.trial_warning_sent_at = null;
    next.trial_last_day_sent_at = null;
    if (!p.trialStartedAt) next.trialStartedAt = nowIso;
  }
  return next;
}

/**
 * Продление пробного на days дней от текущего конца (или от «сейчас», если
 * срок уже прошёл, а крон ещё не закрыл пробный). Напоминания T-3 / T-1
 * сбрасываются под новую дату.
 */
export function trialExtensionData(prev: any, currentEndMs: number, days: number, nowMs: number): { next: Record<string, any>; beforeIso: string | null; afterIso: string } {
  const p = prev && typeof prev === 'object' ? prev : {};
  const base = Number.isFinite(currentEndMs) && currentEndMs > nowMs ? currentEndMs : nowMs;
  const afterIso = new Date(base + days * DAY_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  return {
    beforeIso: Number.isFinite(currentEndMs) ? new Date(currentEndMs).toISOString() : null,
    afterIso,
    next: {
      ...p,
      trial_expires_at: afterIso,
      subscriptionExpiresAt: afterIso,
      trial_warning_sent_at: null,
      trial_last_day_sent_at: null,
      subscriptionUpdatedAt: nowIso,
      updatedAt: nowIso,
    },
  };
}

// ── Строки ответа ──

export interface VenueRow {
  userId: string;
  email: string;
  name: string | null;
  /** Контактное лицо из заявки при регистрации (PROMO.AIR); null, если не указано */
  contactName: string | null;
  /** Телефон для связи: профиль, иначе заявка при регистрации (21.10.2026) */
  phone: string | null;
  /** Город: профиль, иначе заявка */
  city: string | null;
  /** Тип заведения (cafe, bar, …): профиль, иначе заявка */
  venueType: string | null;
  /** Сколько точек указали при регистрации: '1' | '2-4' | '5+'; число точек анкеты эфира = request.points */
  points: '1' | '2-4' | '5+' | null;
  accountStatus: string;
  emailVerified: boolean;
  createdAt: string | null;
  signupSite: 'air' | 'music' | null;
  profile: { id: string; venueName: string | null; venueType: string | null; city: string | null; address: string | null } | null;
  subscription: {
    status: string;
    plan: string | null;
    effectivePlan: VenuePlanId;
    interval: 'month' | 'year' | null;
    expiresAt: string | null;
    trialExpiresAt: string | null;
    hasCard: boolean;
    /** false: тариф или пробный назначил админ, автосписания не будет */
    autoRenew: boolean;
  };
  request: { id: string; status: string; airType: string | null; points: number; createdAt: string | null } | null;
  streams: { total: number; online: number; lastSeenAt: string | null };
}

const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Строка запроса VENUE_ROW_SQL (promo-air-admin-routes.tsx) → VenueRow. */
export function toVenueRow(r: any, nowMs: number = Date.now()): VenueRow {
  const hasProfile = r.profile_id !== null && r.profile_id !== undefined;
  const data = hasProfile && r.profile_data && typeof r.profile_data === 'object' ? r.profile_data : {};
  const interval = data.subscriptionInterval === 'year' || data.subscriptionInterval === 'month' ? data.subscriptionInterval : null;
  return {
    userId: String(r.user_id),
    email: r.email || '',
    name: r.name || null,
    contactName: typeof r.contact_name === 'string' && r.contact_name.trim() ? r.contact_name.trim() : null,
    phone: textOrNull(r.phone),
    city: textOrNull(r.venue_city),
    venueType: textOrNull(r.venue_type_any),
    points: r.signup_points === '1' || r.signup_points === '2-4' || r.signup_points === '5+' ? r.signup_points : null,
    accountStatus: r.account_status,
    emailVerified: !!r.email_verified,
    createdAt: isoOrNull(r.created_at),
    signupSite: r.signup_site === 'air' || r.signup_site === 'music' ? r.signup_site : null,
    profile: hasProfile
      ? { id: String(r.profile_id), venueName: r.venue_name ?? null, venueType: r.venue_type ?? null, city: r.city ?? null, address: r.address ?? null }
      : null,
    subscription: {
      status: data.subscriptionStatus || 'pending_card',
      plan: data.subscriptionPlan || null,
      effectivePlan: getEffectiveVenuePlan(hasProfile ? data : null, nowMs),
      interval,
      expiresAt: isoOrNull(data.subscriptionExpiresAt),
      trialExpiresAt: isoOrNull(data.trial_expires_at),
      hasCard: !!r.has_card,
      autoRenew: !isVenueAutoRenewOff(data),
    },
    request: r.request_id
      ? { id: String(r.request_id), status: r.request_status, airType: r.air_type || null, points: Number(r.request_points) || 0, createdAt: isoOrNull(r.request_created_at) }
      : null,
    streams: { total: Number(r.streams_total) || 0, online: Number(r.streams_online) || 0, lastSeenAt: isoOrNull(r.streams_last_seen_at) },
  };
}

/**
 * Устройство потока из paired_device_info. Приложение PROMO.AIR шлёт
 * {model, osVersion, appVersion} при привязке и appVersion в сигнале «в сети»
 * (~/Projects/promo-air-app/src/lib/api.ts); androidVer / appVer читает
 * старый экран Android-приложения в админке. Не привязано = null.
 */
export function toDevice(info: any, pairedAt: unknown): { model: string | null; android: string | null; appVersion: string | null } | null {
  if (!pairedAt) return null;
  const i = info && typeof info === 'object' ? info : {};
  const pick = (...vals: unknown[]) => {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60);
    return null;
  };
  return {
    model: pick(i.model),
    android: pick(i.osVersion, i.androidVer, i.android),
    appVersion: pick(i.appVersion, i.appVer),
  };
}

/** Поток заведения для карточки: код подключения виден, пока устройство не привязано. */
export function toStreamItem(r: any) {
  return {
    id: String(r.id),
    pointName: r.point_name || null,
    status: r.status,
    streamUrl: r.stream_url || null,
    pairingCode: r.paired_at ? null : r.pairing_code || null,
    pairingExpiresAt: isoOrNull(r.pairing_expires_at),
    pairedAt: isoOrNull(r.paired_at),
    lastSeenAt: isoOrNull(r.last_seen_at),
    online: !!r.online,
    device: toDevice(r.paired_device_info, r.paired_at),
  };
}

/** Тип платежа заведения для админки из payment_sessions.purpose + data.metadata. */
export function venuePaymentType(purpose: string | null, meta: any): string {
  const m = meta && typeof meta === 'object' ? meta : {};
  if (m.type === 'venue_card_attach') return 'card_check';
  if (m.type === 'venue_radio_subscription' || m.itemType === 'venue_radio_subscription') return 'radio_subscription';
  if (purpose === 'venue_subscription') {
    if (m.autoTrialEnd) return 'trial_charge';
    if (m.recurring) return 'renewal';
    return 'subscription';
  }
  return purpose || 'other';
}

export function toPaymentItem(r: any) {
  const meta = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
  return {
    id: String(r.id),
    userId: r.user_id || null,
    email: r.email || null,
    type: venuePaymentType(r.purpose, meta),
    status: r.status || null,
    amountRub: Number(r.amount) || 0,
    createdAt: isoOrNull(r.created_at),
    description: r.description || null,
    plan: meta.planKey || meta.tier || meta.trialPlan || meta.planId || null,
    interval: meta.interval || meta.trialInterval || null,
  };
}

export function toAuditItem(r: any) {
  const details = r.details && typeof r.details === 'object' ? r.details : {};
  const reason = typeof details.reason === 'string' ? details.reason : typeof details.message === 'string' ? details.message : null;
  return {
    id: String(r.id),
    at: isoOrNull(r.created_at),
    actorEmail: r.actor_email || null,
    action: r.action,
    reason,
    details,
    targetUserId: r.target_id || null,
    targetEmail: r.target_email || null,
    targetName: r.target_name || null,
  };
}
