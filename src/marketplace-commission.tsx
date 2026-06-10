/**
 * Marketplace commission — shared source-of-truth для процента,
 * который платформа удерживает с любой денежной сделки между
 * двумя пользователями (продюсер↔клиент, артист↔покупатель бита и т.п.).
 *
 * До 2026-06-10 хардкод `0.1` жил в 6 местах:
 *   - marketplace-routes.tsx:112 (recordPlatformCommission helper rate)
 *   - marketplace-routes.tsx:898 (preview commission для service_order)
 *   - marketplace-routes.tsx:1265 (milestone commission — теперь
 *     unreachable после фикса escrow-gate в PR #223, но число оставлено
 *     до удаления dead branch)
 *   - checkout-routes.tsx:908   (beat_purchase webhook — реальные деньги)
 *   - checkout-routes.tsx:964   (digital_good webhook — реальные деньги)
 *   - checkout-routes.tsx:1163  (generic recordRevenue для session.type='purchase')
 *
 * Тот же риск, что DJ_PLANS до PR #221: поменять одно значение,
 * забыть другое → клиент платит 10000 ₽, продюсер получает 9000 ₽,
 * но в БД записано «комиссия 15% / payout 8500 ₽» (или наоборот).
 *
 * Все cabinet-комиссии остаются НЕ здесь:
 *   - donation withdrawal: 10/7/5/3 % по tier (donations-routes.tsx
 *     `resolveDonationCommissionRate`) — отдельная логика, tier-aware
 *   - radio_campaign (venue→radio): 15 % (см. PRODUCT_FACTS / radio
 *     finance) — другая ставка
 *   - radio_airtime (artist→radio): 15 % (airtime-routes.tsx)
 *
 * Тут — ТОЛЬКО marketplace (beats / digital goods / services).
 */

export const MARKETPLACE_COMMISSION_RATE = 0.10;

/**
 * Вспомогательная функция: считает комиссию и payout из gross-суммы
 * с округлением до рубля (как было исторически).
 *
 * Использовать в webhook'ах + при подготовке payment-сессии для
 * preview. Не делает побочных эффектов — чистая арифметика.
 */
export function splitMarketplaceAmount(grossPrice: number): {
  commission: number;
  payout: number;
  rate: number;
} {
  const commission = Math.round(grossPrice * MARKETPLACE_COMMISSION_RATE);
  return {
    commission,
    payout: grossPrice - commission,
    rate: MARKETPLACE_COMMISSION_RATE,
  };
}
