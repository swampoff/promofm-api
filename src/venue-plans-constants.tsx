/**
 * VENUE_PLANS_CORE — shared source-of-truth для тарифов кабинета
 * заведения (venue subscription: start / business / network).
 *
 * До 2026-06-10 та же таблица money-полей жила ТРИЖДЫ:
 *   1) venue-billing-routes.tsx:71  — export VENUE_PLANS (валидация
 *      amount-tampering на POST /subscribe + recurring-charge)
 *   2) venue-billing-helpers.tsx:18 — локальная копия (чтобы избежать
 *      circular import routes→helpers→routes) для trial auto-charge
 *   3) checkout-routes.tsx:184      — VENUE_PLANS_LOCAL (webhook
 *      активация подписки после оплаты)
 *
 * Тот же класс бага, что DJ_PLANS до PR #221: поменять цену в одном
 * файле, забыть в другом → venue платит 9990 ₽ за «Бизнес» (checkout
 * посчитал), а webhook читает старую цену и активирует не тот tier /
 * не ту длительность. Деньги уходят не туда.
 *
 * Контракт: money + name. Квоты (zones/maxTracks/maxPlaylists/
 * multiLocation/customBranding) живут НЕ здесь — они в gating-функциях
 * venue-routes / venue-zones-routes / venue-locations-routes, привязаны
 * к tier по id. Этот модуль — только то, что нужно платёжному слою.
 *
 * enterprise намеренно отсутствует — manual-контракты, не subscribable
 * через /subscribe (нет фиксированной цены).
 *
 * Листовой модуль (без импортов): чистые функции ниже проверяются
 * без БД, см. ~/Projects/promoair/tools/be-billing.test.mts.
 */

export interface VenuePlanCore {
  name: string;
  price_month: number;
  price_year: number;
}

// Год = 10 месяцев («2 месяца в подарок», владелец 16.10.2026), одним платежом.
export const VENUE_YEAR_MONTHS = 10;

export const VENUE_PLANS_CORE: Record<'start' | 'business' | 'network', VenuePlanCore> = {
  start:    { name: 'Старт',   price_month: 4990,  price_year: 49900 },
  business: { name: 'Бизнес',  price_month: 9990,  price_year: 99900 },
  network:  { name: 'Сеть',    price_month: 14990, price_year: 149900 },
};

export type VenuePlanKey = keyof typeof VENUE_PLANS_CORE;
export type VenueInterval = 'month' | 'year';

// «Радио полного цикла»: цена для витрины тарифов, онлайн-оплаты нет
// (заявка через анкету эфира, тариф включает админ). Та же сумма в
// venue-air-routes.tsx (LIVE_AIR_PRICE).
export const FULL_RADIO_PLAN = { id: 'full_radio', name: 'Радио полного цикла', price_month: 20000, price_year: 200000 } as const;

// Автопродление оплаченного периода: крон списывает за столько дней до конца
// периода (venue-billing-routes.tsx, /cron/charge-recurring), продление идёт
// от старой даты окончания, дни не теряются.
export const RENEWAL_LEAD_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Покупаемый тариф (own-key, без прототипа: 'constructor' и т. п. не проходят). */
export function isVenuePaidTier(tier: unknown): tier is VenuePlanKey {
  return typeof tier === 'string' && Object.prototype.hasOwnProperty.call(VENUE_PLANS_CORE, tier);
}

export function venuePlanPrice(tier: VenuePlanKey, interval: VenueInterval): number {
  const p = VENUE_PLANS_CORE[tier];
  return interval === 'year' ? p.price_year : p.price_month;
}

/**
 * Необязательный выбор тарифа из тела запроса ({tier, interval}).
 * Пустое тело = выбора нет. Неизвестные значения = ошибка (400), а не тихая
 * подмена: заведение должно платить ровно за то, что выбрало.
 */
export function parseVenuePlanChoice(body: any): { tier?: VenuePlanKey; interval?: VenueInterval; error?: string } {
  const out: { tier?: VenuePlanKey; interval?: VenueInterval; error?: string } = {};
  if (!body || typeof body !== 'object') return out;
  if (body.tier !== undefined && body.tier !== null && body.tier !== '') {
    const tier = String(body.tier).toLowerCase();
    if (!isVenuePaidTier(tier)) {
      return { error: `Unknown tier "${String(body.tier).slice(0, 40)}". Allowed: ${Object.keys(VENUE_PLANS_CORE).join(', ')}` };
    }
    out.tier = tier;
  }
  if (body.interval !== undefined && body.interval !== null && body.interval !== '') {
    if (body.interval !== 'month' && body.interval !== 'year') {
      return { error: 'interval must be "month" or "year"' };
    }
    out.interval = body.interval;
  }
  return out;
}

/**
 * Тариф и сумма первого списания после пробного периода: выбранный тариф
 * (subscriptionPlan + subscriptionInterval из venue_profiles.data), иначе
 * «Старт» помесячно. Раньше фолбэк был 'business', а в кабинете во время
 * пробного показывался «Бизнес» при сохранённом 'start' (critic A2 d).
 */
export function resolveVenueChargePlan(data: any): { tier: VenuePlanKey; interval: VenueInterval; amount: number; name: string } {
  const raw = String(data?.subscriptionPlan || '').toLowerCase();
  const tier: VenuePlanKey = isVenuePaidTier(raw) ? raw : 'start';
  const interval: VenueInterval = data?.subscriptionInterval === 'year' ? 'year' : 'month';
  return { tier, interval, amount: venuePlanPrice(tier, interval), name: VENUE_PLANS_CORE[tier].name };
}

export interface VenueNextCharge {
  at: string;                    // ISO: когда крон спишет (не раньше «сейчас»)
  amountRub: number;
  tier: VenuePlanKey;
  interval: VenueInterval;
  kind: 'trial_end' | 'renewal';
}

/**
 * Ближайшее автосписание для кабинета (GET /venue-billing/me). null, если
 * списания не будет: нет сохранённой карты, подписка отменена / истекла /
 * карта не привязана, или тариф без фиксированной цены.
 *   trial  → в момент окончания пробного (крон expire-trials, раз в час);
 *   active → за RENEWAL_LEAD_DAYS до конца периода (крон charge-recurring).
 */
export function getVenueNextCharge(data: any, hasCard: boolean, nowMs: number = Date.now()): VenueNextCharge | null {
  if (!data || !hasCard) return null;
  const status = String(data.subscriptionStatus || 'pending_card');
  if (status === 'trial') {
    const end = Date.parse(data.trial_expires_at || '');
    if (!Number.isFinite(end)) return null;
    const p = resolveVenueChargePlan(data);
    return { at: new Date(Math.max(end, nowMs)).toISOString(), amountRub: p.amount, tier: p.tier, interval: p.interval, kind: 'trial_end' };
  }
  if (status === 'active') {
    const tier = String(data.subscriptionPlan || '');
    const end = Date.parse(data.subscriptionExpiresAt || '');
    if (!isVenuePaidTier(tier) || !Number.isFinite(end)) return null;
    const interval: VenueInterval = data.subscriptionInterval === 'year' ? 'year' : 'month';
    return {
      at: new Date(Math.max(end - RENEWAL_LEAD_DAYS * DAY_MS, nowMs)).toISOString(),
      amountRub: venuePlanPrice(tier, interval), tier, interval, kind: 'renewal',
    };
  }
  return null;
}
