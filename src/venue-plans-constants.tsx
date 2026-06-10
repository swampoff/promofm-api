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
 */

export interface VenuePlanCore {
  name: string;
  price_month: number;
  price_year: number;
}

export const VENUE_PLANS_CORE: Record<'start' | 'business' | 'network', VenuePlanCore> = {
  start:    { name: 'Старт',   price_month: 4990,  price_year: 49900 },
  business: { name: 'Бизнес',  price_month: 9990,  price_year: 99900 },
  network:  { name: 'Сеть',    price_month: 14990, price_year: 149900 },
};

export type VenuePlanKey = keyof typeof VENUE_PLANS_CORE;
