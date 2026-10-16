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
import { getChargeablePaymentMethod, upsertPaymentSession, getPaymentSession, insertPaymentTx } from './db.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { emitSSE } from './sse-routes.tsx';

// Money source of truth — shared venue-plans-constants.tsx (PR 2026-06-10).
// Раньше тут была копия (комментарий «duplicated to avoid circular
// import»). venue-plans-constants — листовой модуль без импортов
// routes/helpers, так что circular-import больше не возникает.
import { resolveVenueChargePlan } from './venue-plans-constants.tsx';

/** E-mail заведения для чека 54-ФЗ (users.email). null, если адреса нет. */
export async function loadVenueReceiptEmail(userId: string): Promise<string | null> {
  try {
    const r = await pool.query(`SELECT email FROM users WHERE id::text = $1 LIMIT 1`, [userId]);
    const email = String(r.rows[0]?.email || '').trim();
    return email.includes('@') ? email : null;
  } catch (e: any) {
    console.warn('[venue-billing-helpers] receipt email lookup failed for', userId, ':', e?.message);
    return null;
  }
}

/**
 * Исход попытки первого списания по окончании пробного периода:
 *   charged   — списано (или найдено уже успешное списание), тариф активен;
 *   no_card   — сохранённой карты нет → caller отключает заведение;
 *   declined  — шлюз отклонил карту → caller отключает заведение;
 *   pending   — платёж ещё в обработке у шлюза → ждём вебхук, повтор на
 *               следующем прогоне (с тем же orderId, повторно не спишет);
 *   error     — сбой сети / БД / шлюза → caller повторит на следующем прогоне;
 *   not_trial — статус уже не trial (отменили в кабинете или оплатили).
 */
export type TrialChargeOutcome = 'charged' | 'no_card' | 'declined' | 'pending' | 'error' | 'not_trial';

/**
 * Charge the venue's saved card for the first paid period at the moment
 * its trial expires (called by the expire-trials cron, venue-trial.tsx).
 *
 * Plan: the tier/interval chosen before the card was attached
 * (subscriptionPlan / subscriptionInterval), fallback «Старт» monthly
 * (resolveVenueChargePlan). Year = price_year (10 months).
 *
 * orderId is deterministic per trial (`venue-first-<user>-<trialEndMs>`):
 * it is the YooKassa Idempotence-Key, so a crash or overlap between the
 * charge and the session write cannot charge twice, and a payment that
 * the gateway left pending is picked up on the next run once its webhook
 * marks the session succeeded.
 *
 * On success: venue_profiles.data → status 'active', chosen plan, period
 * from now (+30 / +365 days); payment_txns + revenue; SSE.
 */
export async function tryAutoChargeAtTrialEnd(
  userId: string,
  profileData: any,
  opts: { email?: string | null; trialEndIso?: string | null } = {},
): Promise<TrialChargeOutcome> {
  if (!profileData) return 'not_trial';

  // Свежее состояние прямо перед списанием: крон прочитал строку раньше, а
  // заведение могло за это время отменить подписку или оплатить тариф.
  let data: any;
  try {
    const fresh = await pool.query(`SELECT data FROM venue_profiles WHERE user_id = $1`, [userId]);
    data = fresh.rows[0]?.data;
  } catch (e: any) {
    console.error('[venue-billing-helpers] profile re-read failed for', userId, ':', e?.message);
    return 'error';
  }
  if (!data || data.subscriptionStatus !== 'trial') return 'not_trial';

  let card: any;
  try {
    card = await getChargeablePaymentMethod(userId);
  } catch (e: any) {
    console.error('[venue-billing-helpers] saved card lookup failed for', userId, ':', e?.message);
    return 'error';
  }
  if (!card) return 'no_card';

  const { tier, interval, amount, name } = resolveVenueChargePlan(data);
  const trialEndMs = Date.parse(opts.trialEndIso || data.trial_expires_at || '') || 0;
  const orderId = `venue-first-${userId}-${trialEndMs}`;
  const now = new Date();

  const prior = await getPaymentSession(orderId).catch(() => null) as any;
  if (prior && (prior.status === 'pending' || prior.status === 'processing')) {
    console.warn('[venue-billing-helpers] first charge still pending at gateway for', userId, orderId);
    return 'pending';
  }
  if (prior && prior.status === 'succeeded') {
    // Деньги уже списаны (вебхук подтвердил ранее pending-платёж или прошлый
    // прогон упал после списания): только включаем тариф, выручку не дублируем.
    await activateAfterTrial(userId, data, { tier, interval, amount: Number(prior.amount) || amount, name, orderId, now, gateway: card.gateway || 'yookassa', recordMoney: false });
    return 'charged';
  }

  let chargeStatus: 'succeeded' | 'canceled' | 'pending';
  try {
    const { getGateway } = await import('./payment-gateway.tsx');
    const gateway = getGateway(card.gateway || 'yookassa');
    const chargeResult = await gateway.chargeRecurring({
      amount,
      currency: 'RUB',
      paymentMethodId: card.gatewayMethodId,
      orderId,
      description: `Подписка «${name}» (${interval === 'year' ? 'год' : 'месяц'}) после пробного периода`,
      userId,
      receiptEmail: opts.email || undefined,
    });

    // Реальный исход списания (2026-07-02): раньше статус не проверялся —
    // отклонённая карта на границе триала всё равно активировала платный месяц
    // и писала фантомную выручку. planKey в metadata НЕ кладём — иначе
    // webhook-ветка venue_subscription активировала бы подписку ВТОРОЙ раз.
    chargeStatus = chargeResult.status; // 'succeeded' | 'canceled' | 'pending'

    await upsertPaymentSession(orderId, {
      orderId,
      userId,
      gateway: card.gateway || 'yookassa',
      gatewayPaymentId: chargeResult.sessionId,
      amount, currency: 'RUB',
      status: chargeStatus === 'succeeded' ? 'succeeded' : chargeStatus === 'canceled' ? 'canceled' : 'pending',
      type: 'venue_subscription',
      description: `Первый период «${name}» после пробного`,
      metadata: { tier, interval, autoTrialEnd: true, userId },
      savePaymentMethod: false,
      confirmationUrl: '',
      returnUrl: 'https://promo-music.ru/venue',
      createdAt: now.toISOString(),
    });
  } catch (err: any) {
    console.warn('[venue-billing-helpers] auto-charge failed for', userId, ':', err?.message);
    return 'error';
  }

  if (chargeStatus === 'canceled') {
    console.warn('[venue-billing-helpers] first charge declined for', userId, orderId);
    return 'declined';
  }
  if (chargeStatus !== 'succeeded') {
    console.warn('[venue-billing-helpers] first charge pending for', userId, orderId);
    return 'pending';
  }

  await activateAfterTrial(userId, data, { tier, interval, amount, name, orderId, now, gateway: card.gateway || 'yookassa', recordMoney: true });
  return 'charged';
}

// Пробный → платный тариф после подтверждённого списания. Период от «сейчас»
// (момента окончания пробного): 30 дней месяц, 365 дней год.
async function activateAfterTrial(
  userId: string,
  data: any,
  p: { tier: string; interval: 'month' | 'year'; amount: number; name: string; orderId: string; now: Date; gateway: string; recordMoney: boolean },
): Promise<void> {
  const { tier, interval, amount, name, orderId, now } = p;
  const daysToAdd = interval === 'year' ? 365 : 30;
  const newExpiry = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  const nextData = {
    ...data,
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

  if (p.recordMoney) {
    await insertPaymentTx({
      id: `tx-venue-first-${crypto.randomUUID()}`,
      userId,
      orderId,
      type: 'expense',
      category: 'venue_subscription',
      amount, currency: 'RUB',
      gateway: p.gateway,
      description: `Первый период «${name}» после пробного`,
      metadata: { tier, interval, autoTrialEnd: true, orderId },
      status: 'pending',
      createdAt: now.toISOString(),
    });

    try {
      await recordRevenue({
        channel: 'venue_subscription',
        description: `Первый период «${name}» (auto-charge after trial): venue ${userId}`,
        grossAmount: amount, platformRevenue: amount, payoutAmount: 0,
        commissionRate: 1.0, payerId: userId, payerName: userId,
        metadata: { tier, interval, autoTrialEnd: true, orderId },
      });
    } catch (e) {
      console.warn('[venue-billing-helpers] recordRevenue warning:', e);
    }
  }

  emitSSE(userId, {
    type: 'venue_subscription_activated',
    data: { tier, expiresAt: newExpiry.toISOString(), via: 'trial_auto_charge' },
  });
}
