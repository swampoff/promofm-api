/**
 * VENUE BILLING HELPERS — non-route shared logic, importable from
 * crons and other modules without pulling the Hono app graph.
 *
 * Scope: VENUE only. Mirrors a slice of venue-billing-routes.tsx
 * (the cron's per-row work) so the trial-expiry cron can attempt
 * an auto-charge before falling back to «mark expired».
 */

import crypto from 'crypto';
import { pool } from './db-client.tsx';
import { getPaymentMethods, upsertPaymentSession, getPaymentSession, insertPaymentTx } from './db.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { emitSSE } from './sse-routes.tsx';

// Same plan table as venue-billing-routes.tsx — duplicated to avoid
// a circular import (routes → helpers → routes). Keep in sync.
const VENUE_PLANS: Record<string, { name: string; price_month: number; price_year: number }> = {
  start:    { name: 'Старт',   price_month: 4990,  price_year: 49900 },
  business: { name: 'Бизнес',  price_month: 9990,  price_year: 99900 },
  network:  { name: 'Сеть',    price_month: 14990, price_year: 149900 },
};

/**
 * Attempt to charge the venue's saved card for the first paid month
 * at the moment their trial expires.
 *
 * Behaviour:
 *   - No saved card → return false. Caller falls back to «mark expired».
 *   - Card present → attempt charge. On success:
 *       - Updates venue_profiles.data (status='active', plan,
 *         expiresAt, interval, priceRub).
 *       - Inserts payment_txns + revenue records (same shape the
 *         artist cron uses).
 *       - Emits SSE so the cabinet updates immediately.
 *       - Returns true. Caller skips the «mark expired» path.
 *   - Card present, charge throws → return false. Caller falls
 *     back to «mark expired». A re-attempt happens once the trial
 *     row is past expiry on the next cron tick anyway (venue-billing
 *     cron picks up active/cancelled rows past expiry too).
 *
 * Plan choice for the first charge: takes
 * `data.subscriptionPlan` if the venue already picked a tier during
 * onboarding (default 'business' — set in /venue/profile during the
 * trial). Falls back to 'business' otherwise. Interval: monthly.
 */
export async function tryAutoChargeAtTrialEnd(userId: string, profileData: any): Promise<boolean> {
  if (!profileData) return false;

  // Look up saved payment method. The artist cron uses the same
  // `payment_methods` KV store — we read the first available method.
  const methods = await getPaymentMethods(userId).catch(() => null) as any;
  const card = Array.isArray(methods?.data) ? methods.data[0]
              : Array.isArray(methods)        ? methods[0]
              : methods?.savedMethods?.[0]    || null;
  if (!card) return false;
  if (!(card.gatewayMethodId || card.id)) return false;

  const tier = String(profileData.subscriptionPlan || 'business').toLowerCase();
  const plan = VENUE_PLANS[tier];
  if (!plan) return false;          // unknown plan → fail closed

  const interval = profileData.subscriptionInterval === 'year' ? 'year' : 'month';
  const amount = interval === 'year' ? plan.price_year : plan.price_month;
  const now = new Date();
  const orderId = `venue-first-${userId}-${now.getTime()}`;

  // Idempotency: if a prior charge for the same trial-expiry tick is
  // already in flight (extremely rare — cron is 1/day), skip.
  const prior = await getPaymentSession(orderId).catch(() => null) as any;
  if (prior && (prior.status === 'succeeded' || prior.status === 'processing')) {
    return false;
  }

  try {
    const { getGateway } = await import('./payment-gateway.tsx');
    const gateway = getGateway(card.gateway || 'yookassa');
    const chargeResult = await gateway.chargeRecurring({
      amount,
      currency: 'RUB',
      paymentMethodId: card.gatewayMethodId || card.id,
      orderId,
      description: `Первый месяц подписки «${plan.name}» (после триала)`,
      userId,
    });

    await upsertPaymentSession(orderId, {
      orderId,
      userId,
      gateway: card.gateway || 'yookassa',
      gatewayPaymentId: chargeResult.sessionId,
      amount, currency: 'RUB',
      status: 'pending',
      type: 'venue_subscription',
      description: `Первый месяц «${plan.name}» после триала`,
      metadata: { planKey: tier, interval, autoTrialEnd: true, userId },
      savePaymentMethod: false,
      confirmationUrl: '',
      returnUrl: 'https://promo-music.ru/venue',
      createdAt: now.toISOString(),
    });

    // Extend period. Starts from NOW (the trial expiry moment) —
    // venue has been getting free service these 14 days, so the
    // 30 paid days run from this moment forward.
    const daysToAdd = interval === 'year' ? 365 : 30;
    const newExpiry = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
    const nextData = {
      ...profileData,
      subscriptionStatus:    'active',
      subscriptionPlan:       tier,
      subscriptionExpiresAt:  newExpiry.toISOString(),
      subscriptionInterval:   interval,
      subscriptionPriceRub:   amount,
      subscriptionUpdatedAt:  now.toISOString(),
      trial_ended_at:         now.toISOString(),
      updatedAt:              now.toISOString(),
    };
    await pool.query(
      `UPDATE venue_profiles SET data = $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
      [JSON.stringify(nextData), userId]
    );

    await insertPaymentTx({
      id: `tx-venue-first-${crypto.randomUUID()}`,
      userId,
      orderId,
      type: 'expense',
      category: 'venue_subscription',
      amount, currency: 'RUB',
      gateway: card.gateway || 'yookassa',
      description: `Первый месяц «${plan.name}» после триала`,
      metadata: { tier, interval, autoTrialEnd: true, orderId },
      status: 'pending',
      createdAt: now.toISOString(),
    });

    try {
      await recordRevenue({
        channel: 'venue_subscription',
        description: `Первый месяц «${plan.name}» (auto-charge after trial): venue ${userId}`,
        grossAmount: amount, platformRevenue: amount, payoutAmount: 0,
        commissionRate: 1.0, payerId: userId, payerName: userId,
        metadata: { tier, interval, autoTrialEnd: true, orderId },
      });
    } catch (e) {
      console.warn('[venue-billing-helpers] recordRevenue warning:', e);
    }

    emitSSE(userId, {
      type: 'venue_subscription_activated',
      data: { tier, expiresAt: newExpiry.toISOString(), via: 'trial_auto_charge' },
    });

    return true;
  } catch (err: any) {
    console.warn('[venue-billing-helpers] auto-charge failed for', userId, ':', err?.message);
    return false;
  }
}
