/**
 * Checkout Routes — Payment session management + webhooks
 *
 * Endpoints:
 *   POST /create-session           — create payment, return redirect URL
 *   GET  /session/:orderId         — check payment status
 *   GET  /methods                  — list saved payment methods
 *   DELETE /methods/:id            — remove saved method
 *   POST /webhook/yookassa         — YooKassa webhook (NO AUTH)
 *   POST /webhook/tbank            — T-Bank webhook (NO AUTH)
 */

import { Hono } from 'hono';
import { claimPaymentSessionForProcessing, createCoinTransactionKv, creditAvailableAtomic, deletePaymentMethod, getCoinBalance, getPaymentBalance, getPaymentMethods, getPaymentSession, incrementCoinBalanceAtomic, reserveCreditOnce, revertPaymentSessionToPending, setCoinBalance, setPaymentSessionShopId, upsertPaymentBalance, upsertPaymentMethod, upsertPaymentSession, upsertSubscription, insertPaymentTx } from './db.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';
import {
  getGateway,
  type GatewayName,
  type PaymentSession,
  type PaymentType,
  type SavedPaymentMethod,
  type WebhookPayload,
} from './payment-gateway.tsx';
import { SUBSCRIPTION_PLANS } from './subscriptions-routes.tsx';

import { createLogger } from "./logger.tsx";
import { notifyPaymentReceived, notifyPaymentExpired } from './email-helper.tsx';

// Bounds for free-form payment amounts (donation/topup/purchase). RUB.
// Subscription amounts are validated against SUBSCRIPTION_PLANS below.
// track_publish amounts are validated against the track's own price below.
const MIN_PAYMENT_AMOUNT_RUB = 1;
const MAX_PAYMENT_AMOUNT_RUB = 1_000_000;

// Fallback when track has no per-track price set.
// Must match PUBLICATION_PRICE in track-moderation-routes.tsx.
import { getPublicationPrice } from './pricing.tsx';

const log = createLogger("checkout");

const checkoutRoutes = new Hono();


// ── Helper: process successful payment ──

async function processPaymentSuccess(session: PaymentSession, webhook: WebhookPayload) {
  const now = new Date().toISOString();

  // Validate webhook amount matches session amount
  if (webhook.amount !== undefined && webhook.amount !== null) {
    const wAmt = Number(webhook.amount);
    const sAmt = Number(session.amount);
    if (Math.abs(wAmt - sAmt) > 0.01) {
      log.error({ orderId: session.orderId, expected: sAmt, received: wAmt }, 'amount_mismatch');
      throw new Error('Payment amount mismatch');
    }
  }

  // Update session
  session.status = 'succeeded';
  session.completedAt = now;
  if (webhook.paymentMethodId) {
    session.savedMethodId = webhook.paymentMethodId;
  }
  await upsertPaymentSession(session.orderId, session);

  // Record transaction in PostgreSQL
  await insertPaymentTx({
    id: `tx-${session.orderId}`,
    userId: session.userId,
    orderId: session.orderId,
    type: 'income',
    category: session.type,
    amount: session.amount,
    currency: session.currency,
    gateway: session.gateway,
    description: session.description,
    metadata: session.metadata,
    status: 'completed',
    createdAt: now,
  });

  // Update user balance for donations/topups. Uses atomic SQL increment to
  // survive concurrent webhook deliveries — the previous read-modify-write
  // dropped updates when two fulfillments for the same recipient overlapped
  // (donation + topup, or two donations from different fans).
  if (session.type === 'donation' || session.type === 'topup') {
    const targetUserId = session.type === 'donation'
      ? (session.metadata.artistId || session.userId)
      : session.userId;
    // Idempotency guard: webhook retry'и от YooKassa могут попасть
    // сюда повторно если первый раз упал ПОСЛЕ credit'а но ДО return.
    // claimPaymentSessionForProcessing откатывается → второй webhook
    // снова входит сюда. creditAvailableAtomic — атомарный, но
    // unconditional add. Без ledger-guard'а это double-credit на каждом
    // retry. reserveCreditOnce инсертит в payment_credit_ledger,
    // вторая попытка получает false → skip.
    const kind = session.type === 'donation' ? 'donation_credit' : 'topup_balance';
    if (await reserveCreditOnce(session.orderId, kind)) {
      await creditAvailableAtomic(targetUserId, session.amount);
    } else {
      log.info({ orderId: session.orderId, kind, targetUserId, amount: session.amount }, 'credit_skipped_already_reserved');
    }
  }

  // Topup coins — same race-safety treatment.
  if (session.type === 'topup' && session.metadata.coinAmount) {
    const coinAmount = parseInt(session.metadata.coinAmount);
    if (coinAmount > 0) {
      // Отдельный kind 'topup_coins' — топап balance уже зарезервирован
      // выше, а coins это отдельный credit (one orderId → два credit'а).
      if (await reserveCreditOnce(session.orderId, 'topup_coins')) {
        await incrementCoinBalanceAtomic(session.userId, coinAmount);

        const coinTx = {
          id: `cointx-${session.orderId}`,
          userId: session.userId,
          amount: coinAmount,
          type: 'purchase',
          description: `Пополнение: ${coinAmount} монет`,
          createdAt: now,
        };
        await createCoinTransactionKv(session.userId, coinTx.id, coinTx);
      } else {
        log.info({ orderId: session.orderId, userId: session.userId, coinAmount }, 'topup_coins_skipped_already_reserved');
      }
    }
  }


  // ─── Activate subscription ───
  if (session.type === 'subscription' && session.metadata?.planKey) {
    try {
      // NOTE: shape changes (latest 2026-05-25):
      //   - merged `discounts.pitching + .marketing → .promotion`
      //   - dropped `discounts.track_test` (replaced by tests_per_month quota)
      //   - added `tests_per_month` (PromoLab quota; 0/1/3/10 by tier)
      // Source-of-truth lives in src/subscriptions-routes.tsx
      // SUBSCRIPTION_PLANS; this table duplicates it for the
      // webhook's offline activation path (we don't import to
      // avoid pulling the Hono app graph here).
      const PLANS: Record<string, any> = {
        spark:  { name: 'Тест-драйв', price_month: 0,      credits_per_month: 0,  tests_per_month: 0,  extra_mailing_price: 7000, discounts: { promotion: 0,    banners: 0    }, donation_fee: 0.10, coins_bonus: 0 },
        start:  { name: 'Старт',       price_month: 8990,   credits_per_month: 1,  tests_per_month: 1,  extra_mailing_price: 5000, discounts: { promotion: 0.05, banners: 0.05 }, donation_fee: 0.07, coins_bonus: 0.05 },
        pro:    { name: 'Про',         price_month: 39990,  credits_per_month: 3,  tests_per_month: 3,  extra_mailing_price: 4000, discounts: { promotion: 0.10, banners: 0.10 }, donation_fee: 0.05, coins_bonus: 0.15 },
        elite:  { name: 'Бизнес',     price_month: 149990, credits_per_month: 10, tests_per_month: 10, extra_mailing_price: 3000, discounts: { promotion: 0.15, banners: 0.15 }, donation_fee: 0.03, coins_bonus: 0.25 },
      };
      const planKey = session.metadata.planKey;
      const plan = PLANS[planKey];
      if (plan) {
        const interval = session.metadata.interval || 'month';
        const daysToAdd = interval === 'year' ? 365 : 30;
        const expiresAt = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000).toISOString();
        const subData = {
          user_id: session.userId,
          tier: planKey,
          tierName: plan.name,
          price: session.amount,
          interval,
          expires_at: expiresAt,
          status: 'active',
          credits_remaining: plan.credits_per_month,
          credits_per_month: plan.credits_per_month,
          tests_per_month: plan.tests_per_month,
          extra_mailing_price: plan.extra_mailing_price,
          discounts: plan.discounts,
          donation_fee: plan.donation_fee,
          coins_bonus: plan.coins_bonus,
          gateway: session.gateway,
          gateway_payment_id: session.gatewayPaymentId,
          created_at: now,
          updated_at: now,
        };
        await upsertSubscription(session.userId, subData);
        log.info({ userId: session.userId, plan: planKey, interval }, 'subscription_activated');
      }
    } catch (err) {
      // Surface so the webhook reverts the session to 'pending' and the
      // gateway retries. Previously the user was charged with no subscription
      // record created — silent revenue loss with no recovery.
      log.error({ err, userId: session.userId }, 'subscription_activation_error');
      throw err;
    }
  }

  // ─── Fulfill venue subscription ───
  //
  // Activates the venue's chosen tier when YooKassa confirms payment
  // (initial subscribe OR — for cron-driven recurring — the
  // re-charge succeeds via saved payment method). Idempotent: a
  // re-delivered webhook with the same orderId is a no-op because
  // the period is computed from `subscriptionExpiresAt` which only
  // gets extended forward, never duplicated.
  //
  // Money source of truth — shared venue-plans-constants.tsx
  // (PR 2026-06-10). Раньше тут жил VENUE_PLANS_LOCAL дубликат с
  // комментарием «duplicates minimum fields» — drift-риск как DJ_PLANS
  // (PR #221). venue-plans-constants — листовой модуль (без Hono app
  // graph), dynamic import дешёвый.
  if (session.type === 'venue_subscription' && session.metadata?.planKey) {
    try {
      const { VENUE_PLANS_CORE } = await import('./venue-plans-constants.tsx');
      const planKey = session.metadata.planKey;
      const plan = VENUE_PLANS_CORE[planKey as keyof typeof VENUE_PLANS_CORE];
      if (plan) {
        const interval = session.metadata.interval === 'year' ? 'year' : 'month';
        const daysToAdd = interval === 'year' ? 365 : 30;
        // Webhook target = JWT'у создававшего сессию (session.userId), а
        // НЕ metadata.userId (тот мог быть подменён). create-session уже
        // проверяет совпадение, но webhook второй защитной линией не
        // принимает metadata.userId как override. Если кто-то пробил
        // create-session — webhook апгрейдит ИМЕННО плательщика, не его
        // жертву.
        const userId = session.userId;
        if (session.metadata.userId && String(session.metadata.userId) !== String(userId)) {
          log.warn({ sessionUserId: userId, claimedUserId: session.metadata.userId, orderId: session.orderId }, 'venue_subscription_impersonation_blocked_webhook');
          // Не throw — webhook должен идемпотентно вернуть 200, чтобы
          // YooKassa не ретраила. Просто фиксируем атаку и не апгрейдим
          // никого. Платеж уже на счету платформы — обработается
          // вручную через admin-refund (см. промо-сейф).
          return;
        }

        // Read current profile; extend the existing expiry if any,
        // else start from now. This keeps mid-cycle upgrades fair
        // (customer doesn't lose remaining paid days).
        const { pool: dbPool } = await import('./db-client.tsx');
        const cur = await dbPool.query(
          `SELECT data FROM venue_profiles WHERE user_id = $1`,
          [userId]
        );
        const curData = cur.rows[0]?.data || {};
        const existingExpiry = curData.subscriptionExpiresAt ? new Date(curData.subscriptionExpiresAt) : null;
        const baseMs = existingExpiry && existingExpiry.getTime() > Date.now()
          ? existingExpiry.getTime()
          : Date.now();
        const newExpiry = new Date(baseMs + daysToAdd * 24 * 60 * 60 * 1000).toISOString();

        const nextData = {
          ...curData,
          subscriptionStatus:     'active',
          subscriptionPlan:        planKey,
          subscriptionExpiresAt:   newExpiry,
          subscriptionInterval:    interval,
          subscriptionPriceRub:    session.amount,
          subscriptionUpdatedAt:   now,
          subscriptionGateway:     session.gateway,
          subscriptionGatewayPaymentId: session.gatewayPaymentId,
          updatedAt:               now,
        };

        await dbPool.query(
          `UPDATE venue_profiles SET data = $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
          [JSON.stringify(nextData), userId]
        );

        // If venue had paused streams (e.g. coming back from
        // expiry), un-pause them so the APK starts playing again
        // on the next poll. Bearer tokens that were revoked on
        // expiry are NOT auto-restored — those were nuked
        // intentionally so the venue regenerates them; new tokens
        // come from /server/api/venue-api/tokens.
        await dbPool.query(
          `UPDATE venue_station_streams
              SET status     = 'provisioned',
                  updated_at = NOW()
            WHERE user_id = $1 AND status = 'paused'`,
          [userId]
        );

        log.info({ userId, planKey, interval, newExpiry }, 'venue_subscription_activated');
      }
    } catch (err) {
      log.error({ err, userId: session.userId, orderId: session.orderId }, 'venue_subscription_activation_error');
      throw err;
    }
  }

  // ─── Fulfill DJ subscription ───
  //
  // DJ paid plans (Pro 990₽, Agency 2990₽). Frontend sends
  // `type: 'subscription' + metadata.role: 'dj' + metadata.planId`
  // (NOT `metadata.planKey` — that's the artist surface). Without
  // this branch, paid DJ subscriptions used to silently fail:
  // YooKassa took the money, webhook hit, neither artist nor venue
  // branch matched, DJ stayed on Starter. Discovered in the DJ
  // pipeline audit on 2026-05-25.
  //
  // Source-of-truth for DJ_PLANS lives in
  // src/dj-studio-routes.tsx; this table duplicates the minimum
  // fields the webhook needs to avoid pulling the Hono app graph.
  if (
    session.type === 'subscription' &&
    session.metadata?.role === 'dj' &&
    session.metadata?.planId
  ) {
    try {
      const DJ_PLANS_LOCAL: Record<string, {
        name: string; price: number; priceYear: number;
        limits: { mixes: number; events: number; analytics: string };
      }> = {
        starter: { name: 'Starter', price: 0,    priceYear: 0,     limits: { mixes: 5,  events: 5,  analytics: 'basic' } },
        pro:     { name: 'Pro',     price: 990,  priceYear: 9900,  limits: { mixes: 20, events: 50, analytics: 'advanced' } },
        agency:  { name: 'Agency',  price: 2990, priceYear: 29900, limits: { mixes: -1, events: -1, analytics: 'full' } },
      };
      const planId = String(session.metadata.planId);
      const plan = DJ_PLANS_LOCAL[planId];
      if (plan) {
        const interval = session.metadata.interval === 'year' ? 'year' : 'month';
        // Webhook second line of defence: даже если кто-то обошёл
        // create-session, метаджDjId должен совпадать с плательщиком.
        // Без metadata.djId fall back на session.userId — безопасно.
        if (session.metadata.djId && String(session.metadata.djId) !== String(session.userId)) {
          log.warn({ sessionUserId: session.userId, claimedDjId: session.metadata.djId, orderId: session.orderId }, 'dj_subscription_impersonation_blocked_webhook');
          return;
        }
        const djId = String(session.metadata.djId || session.userId);
        const start = new Date(now);
        const end = new Date(start);
        if (interval === 'year') end.setFullYear(end.getFullYear() + 1);
        else end.setMonth(end.getMonth() + 1);

        const subscription = {
          djId,
          planId,
          planName: plan.name,
          status: 'active',
          price: interval === 'year' ? plan.priceYear : plan.price,
          currency: 'RUB',
          interval,
          startDate: start.toISOString(),
          endDate: end.toISOString(),
          limits: plan.limits,
          gateway: session.gateway,
          gatewayPaymentId: session.gatewayPaymentId,
        };

        // jsonbStore upsert — same shape as POST /dj-studio/subscription/:djId/change
        const { djSubscriptionsStore } = await import('./db.tsx');
        await djSubscriptionsStore.set(djId, subscription);

        log.info({ djId, planId, interval, endDate: end.toISOString() }, 'dj_subscription_activated');
      } else {
        log.warn({ planId, djId: session.metadata.djId }, 'dj_subscription_unknown_plan');
      }
    } catch (err) {
      log.error({ err, djId: session.metadata?.djId, orderId: session.orderId }, 'dj_subscription_activation_error');
      throw err;
    }
  }


  // ─── Fulfill venue_radio_subscription (type='subscription') ───
  //
  // /subscribe (venue-radio-routes) создаёт сессию с type='subscription' и
  // metadata.type='venue_radio_subscription' (БЕЗ itemType). Раньше активация
  // жила под guard'ом purchase+itemType (см. ниже) и была НЕДОСТИЖИМА →
  // заведение платило, подписка навсегда pending_payment, stream-token 403:
  // деньги взяты, доступ не выдан. Теперь активируем на subscription-пути.
  // Идемпотентность — orderId-keyed (COALESCE(payment_order_id,'') <> $1):
  // retry с тем же orderId апдейтит 0 строк, реальное продление (новый
  // orderId) продлевает от max(текущий конец, сейчас).
  // Привязка карты заведением (1 ₽): включаем пробные 2 недели и возвращаем рубль.
  // Карта уже сохранена общим блоком savePaymentMethod выше.
  if (session.metadata?.type === 'venue_card_attach') {
    const venueUserId = String(session.metadata.userId || session.userId || '');
    try {
      const { getVenueProfile, upsertVenueProfile } = await import('./db.tsx');
      const prof: any = await getVenueProfile(venueUserId);
      if (prof && prof.subscriptionStatus !== 'active') {
        const until = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        await upsertVenueProfile(venueUserId, {
          ...prof,
          subscriptionStatus: 'trial',
          trial_expires_at: until,
          subscriptionExpiresAt: until,
          cardAttachedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        log.info({ venueUserId, until }, 'venue_trial_started_after_card');
        import('./email-helper.tsx')
          .then((m: any) => m.notifyAdminNewVenue?.({
            venueName: prof.venueName || prof.name || '',
            city: prof.city,
            venueType: prof.venueType,
            email: prof.email,
            userId: venueUserId,
            stage: 'card_attached',
          }))
          .catch((e: any) => log.warn({ err: e?.message }, 'venue_card_admin_notify_failed'));
      }
    } catch (e: any) {
      log.error({ err: e?.message, venueUserId }, 'venue_card_attach_trial_failed');
    }
    // Возврат проверочного рубля — не блокируем ответ вебхука.
    try {
      const { getGateway } = await import('./payment-gateway.tsx');
      const gw: any = getGateway('yookassa');
      if (typeof gw.refund === 'function' && webhook.sessionId) {
        gw.refund(webhook.sessionId, 1, {
          description: 'Возврат проверочного платежа за привязку карты',
          idempotenceKey: `refund-attach-${session.orderId}`,
        }).then(() => log.info({ orderId: session.orderId }, 'venue_card_attach_refunded'))
          .catch((e: any) => log.warn({ err: e?.message }, 'venue_card_attach_refund_failed'));
      }
    } catch (e: any) {
      log.warn({ err: e?.message }, 'venue_card_attach_refund_skipped');
    }
  }

  if (
    session.type === 'subscription' &&
    session.metadata?.type === 'venue_radio_subscription' &&
    session.metadata?.subscriptionId
  ) {
    try {
      const { pool: vrPool } = await import('./db-client.tsx');
      const subId = String(session.metadata.subscriptionId);
      const r = await vrPool.query(
        `UPDATE venue_radio_subscriptions
            SET status = 'active',
                current_period_start = COALESCE(current_period_start, NOW()),
                current_period_end = GREATEST(COALESCE(current_period_end, NOW()), NOW()) + INTERVAL '30 days',
                payment_order_id = $1, payment_gateway = $2,
                auto_renew = true, updated_at = NOW()
          WHERE id = $3
            AND COALESCE(payment_order_id, '') <> $1
          RETURNING venue_id, plan_id, current_period_end`,
        [session.orderId, session.gateway, subId]
      );
      if (r.rows.length > 0) {
        log.info({ subscriptionId: subId, venueId: r.rows[0].venue_id, planId: r.rows[0].plan_id, until: r.rows[0].current_period_end, amount: session.amount }, 'venue_radio_subscription_activated');
        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(r.rows[0].venue_id, {
            type: 'venue_radio_activated',
            data: {
              title: 'Подписка ПРОМО.ЭИР активна',
              message: `Доступ к эфиру до ${new Date(r.rows[0].current_period_end).toLocaleDateString('ru-RU')}`,
              subscriptionId: subId,
              planId: r.rows[0].plan_id,
            },
          });
        } catch {}
      }
    } catch (err) {
      log.error({ err, subscriptionId: session.metadata?.subscriptionId, orderId: session.orderId }, 'venue_radio_subscription_activation_error');
      throw err;
    }
  }

  // ─── Fulfill marketplace purchase ───
  if (session.type === 'purchase' && session.metadata?.itemType) {
    try {
      const itemType = session.metadata.itemType;
      
      // Skip the simple beat-purchase path if this webhook also matches the
      // full beat_purchase fulfillment block below (which records commission
      // + platform payout). Otherwise both blocks fire and the producer is
      // credited twice for the same payment.
      if (itemType === 'beat' && session.metadata.beatId && session.metadata.type !== 'beat_purchase') {
        // Fulfill beat purchase
        const { getBeat } = await import('./db.tsx');
        const { pool: cPool1 } = await import('./db-client.tsx');
        const beat = await getBeat(session.metadata.beatId);
        if (beat) {
          const purchase = {
            // Deterministic id keyed on orderId → ON CONFLICT (id) below makes a
            // YooKassa retry a 0-row no-op instead of a duplicate purchase
            // (random uuid never collided, so retries duplicated). Same id-space
            // as the full beat_purchase block → one order = at most one row.
            id: `bp-${session.orderId}`,
            beatId: session.metadata.beatId,
            beatTitle: beat.title || session.metadata.beatTitle || 'Beat',
            buyerId: session.userId,
            buyerName: session.metadata.buyerName || session.userId,
            sellerId: beat.producerId || session.metadata.sellerId || '',
            sellerName: beat.producerName || session.metadata.sellerName || '',
            price: session.amount,
            licenseType: session.metadata.licenseType || 'basic',
            status: 'completed',
            createdAt: now,
          };
          const ins = await cPool1.query(
            `INSERT INTO beat_purchases (id, beat_id, buyer_id, producer_id, amount, license_type, status, data, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb, NOW())
             ON CONFLICT (id) DO NOTHING`,
            [purchase.id, purchase.beatId || null, purchase.buyerId || session.userId,
             // Field is named sellerId on the in-memory purchase object — the
             // previous `purchase.producerId` reference was always undefined
             // and producer_id ended up NULL, breaking seller-payout attribution.
             purchase.sellerId || null, purchase.price || session.amount,
             purchase.licenseType || null,
             JSON.stringify({ ...purchase, paymentOrderId: session.orderId })]
          );
          if (ins.rowCount && ins.rowCount > 0) {
            log.info({ purchaseId: purchase.id, beatTitle: beat.title }, 'beat_purchase_fulfilled');
            // Notify seller via SSE — only on first fulfillment, not retries.
            if (beat.producerId) {
              try {
                const { emitSSE } = await import('./sse-routes.tsx');
                emitSSE(beat.producerId, { type: 'beat_sold', data: { beatTitle: beat.title, price: session.amount, buyerName: purchase.buyerName } });
              } catch {}
            }
          } else {
            log.info({ purchaseId: purchase.id, orderId: session.orderId }, 'beat_purchase_already_fulfilled_skip');
          }
        }
      }
      
      if (itemType === 'digital_good' && session.metadata.goodId) {
        // Fulfill digital good purchase
        const { pool: cPool2 } = await import('./db-client.tsx');
        const purchase = {
          // Deterministic id keyed on orderId → ON CONFLICT (id) makes retries
          // idempotent. Same dgp- id-space as the full digital_purchase block →
          // one order = at most one digital_purchases row. (Was `bp-`+random,
          // which both mis-prefixed and duplicated on retry.)
          id: `dgp-${session.orderId}`,
          goodId: session.metadata.goodId,
          goodTitle: session.metadata.goodTitle || 'Digital Good',
          buyerId: session.userId,
          buyerName: session.metadata.buyerName || session.userId,
          sellerId: session.metadata.sellerId || '',
          price: session.amount,
          status: 'completed',
          createdAt: now,
        };
        const insDg = await cPool2.query(
          `INSERT INTO digital_purchases (id, good_id, buyer_id, amount, data, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
           ON CONFLICT (id) DO NOTHING`,
          // Field is named goodId on the in-memory purchase — previous
          // `purchase.digitalGoodId` was always undefined.
          [purchase.id, purchase.goodId || null, purchase.buyerId || session.userId,
           purchase.price || session.amount,
           JSON.stringify({ ...purchase, paymentOrderId: session.orderId })]
        );
        log.info({ purchaseId: purchase.id, inserted: (insDg.rowCount ?? 0) > 0 }, 'digital_good_fulfilled');
      }
      
      if (itemType === 'radio_campaign' && session.metadata.stationId) {
        // Create radio campaign after payment. Native row-per-campaign since
        // migration 082. Fixes legacy bug — set(campaign.id) wrote to wrong PK
        // на per-venue таблице, кампания была невидима в venue cabinet.
        const { insertVenueAdCampaign } = await import('./db.tsx');
        const campaign = {
          // Deterministic id keyed on orderId → insertVenueAdCampaign now does
          // ON CONFLICT (id) DO NOTHING, so a webhook retry creates 0 extra
          // campaigns instead of a duplicate paid campaign per retry.
          id: `rc-${session.orderId}`,
          venueId: session.userId,
          stationId: session.metadata.stationId,
          stationName: session.metadata.stationName || '',
          advertiserId: session.userId,
          packageType: session.metadata.packageType || 'standard',
          status: 'paid',
          audioUrl: null,
          startDate: session.metadata.startDate || new Date().toISOString().split('T')[0],
          endDate: session.metadata.endDate || '',
          targetPlays: parseInt(session.metadata.targetPlays || '0'),
          totalPlays: 0,
          budget: session.amount,
          spent: 0,
          impressions: 0,
          ctr: 0,
          timeSlots: [],
          extra: {},
          createdAt: now,
          updatedAt: now,
        };
        const campaignInserted = await insertVenueAdCampaign(campaign);
        // BLOCKER B (migration 101): записываем payment-метаданные сразу
        // после INSERT, чтобы refund-helper в radio-routes мог найти
        // session.gatewayPaymentId по campaign.payment_order_id. До этого
        // PR'а insertVenueAdCampaign не знал об этих колонках; патч
        // оставлен как inline UPDATE чтобы не расширять interface
        // VenueAdCampaignRow одним PR'ом.
        try {
          const { pool: rcPool } = await import('./db-client.tsx');
          await rcPool.query(
            `UPDATE venue_ad_campaigns
                SET payment_order_id = $2,
                    payment_gateway  = $3,
                    paid_at          = NOW()
              WHERE id = $1`,
            [campaign.id, session.orderId, session.gateway]
          );
        } catch (paymentMetaErr: any) {
          log.warn({ campaignId: campaign.id, err: paymentMetaErr?.message }, 'radio_campaign_payment_meta_write_failed');
        }

        if (campaignInserted > 0) {
          log.info({ campaignId: campaign.id }, 'radio_campaign_created');
          // Notify station owner — only on first fulfillment, not retries.
          if (session.metadata.stationOwnerId) {
            try {
              const { emitSSE } = await import('./sse-routes.tsx');
              emitSSE(session.metadata.stationOwnerId, { type: 'new_radio_campaign', data: { budget: session.amount, packageType: campaign.packageType } });
            } catch {}
          }
        } else {
          log.info({ campaignId: campaign.id, orderId: session.orderId }, 'radio_campaign_already_created_skip');
        }

        // Оплата прошла → делаем заявку заведения видимой радио. Заявка
        // (radio_venue_requests) создаётся в venue-routes как
        // 'pending_payment' и до этого момента НЕ показывается станции и не
        // может быть одобрена. Идемпотентно: WHERE status='pending_payment'
        // (webhook retry → 0 строк). id заявки == metadata.campaignId.
        if (session.metadata.campaignId) {
          try {
            const { pool: rvrPool } = await import('./db-client.tsx');
            const flipped = await rvrPool.query(
              `UPDATE radio_venue_requests
                  SET status = 'pending', updated_at = NOW()
                WHERE id = $1 AND status = 'pending_payment'`,
              [String(session.metadata.campaignId)]
            );
            if (flipped.rowCount) {
              log.info({ campaignId: session.metadata.campaignId }, 'radio_venue_request_marked_paid');
            }
          } catch (rvrErr: any) {
            log.warn({ campaignId: session.metadata.campaignId, err: rvrErr?.message }, 'radio_venue_request_flip_failed');
          }
        }
      }

      if (itemType === 'content_order' && session.metadata.contentOrderId) {
        const { pool: coPool } = await import('./db-client.tsx');
        const coid = session.metadata.contentOrderId;
        const r = await coPool.query(
          `UPDATE content_orders SET status = 'pending', paid_at = $1, payment_order_id = $2, payment_gateway = $3, updated_at = NOW() WHERE id = $4 RETURNING id`,
          [now, session.orderId, session.gateway, coid]
        );
        if (r.rows.length > 0) {
          log.info({ contentOrderId: coid, amount: session.amount }, 'content_order_paid');
        }
      }

      // venue_radio_subscription активируется на subscription-пути выше
      // (type='subscription'), НЕ здесь — этот purchase+itemType guard для
      // неё никогда не срабатывал (сессия создаётся с type='subscription').


      if (itemType === 'booking_payment' && session.metadata.bookingId) {
        const { getBooking, upsertBooking } = await import('./db.tsx');
        const { pool: bpPool } = await import('./db-client.tsx');
        const bid = session.metadata.bookingId;
        const payType = session.metadata.paymentType || 'deposit';
        const booking = await getBooking(bid);
        if (booking) {
          const newStatus = payType === 'deposit' ? 'deposit_paid' : 'confirmed';
          booking.status = newStatus;
          booking.updatedAt = now;
          if (payType === 'deposit') {
            booking.depositPaidAt = now;
          } else {
            booking.finalPaidAt = now;
          }
          await upsertBooking(bid, booking);

          await bpPool.query(
            `INSERT INTO booking_payments (booking_id, amount, payment_type, status, data, created_at)
             VALUES ($1, $2, $3, 'paid', $4::jsonb, NOW())
             ON CONFLICT DO NOTHING`,
            [bid, session.amount, payType,
             JSON.stringify({ gateway: session.gateway, orderId: session.orderId, paidAt: now })]
          );

          log.info({ bookingId: bid, paymentType: payType, amount: session.amount }, 'booking_payment_paid');
        }
      }

      // ── Fulfill distribution order — flip pending → paid ──────
      //
      // Order rows are created upfront via POST /server/api/distribution/
      // with status='pending'. When the artist pays through YooKassa
      // with metadata.itemType='distribution' + metadata.orderId, this
      // webhook flips the row to 'paid' so admin's queue picks it up
      // (idx_distribution_orders_admin_queue filters on status IN
      // ('pending', 'paid', 'submitted')).
      //
      // The order's payment_session_id is back-filled with session.orderId
      // for audit/reconciliation. Idempotent via WHERE status='pending'
      // — a duplicate webhook for the same order is a no-op.
      if (itemType === 'distribution' && session.metadata.orderId) {
        const { pool: distPool } = await import('./db-client.tsx');
        const orderId = String(session.metadata.orderId);
        const r = await distPool.query(
          `UPDATE distribution_orders
              SET status = 'paid',
                  payment_session_id = $2
            WHERE id::text = $1
              AND status = 'pending'
            RETURNING id::text AS id, track_id::text AS "trackId", target_dsp AS "targetDsp", user_id AS "userId"`,
          [orderId, session.orderId],
        );
        if (r.rowCount && r.rowCount > 0) {
          log.info({ orderId, trackId: r.rows[0].trackId, targetDsp: r.rows[0].targetDsp, amount: session.amount }, 'distribution_order_paid');
        } else {
          // Order missing OR already past 'pending' (re-delivered webhook,
          // manual admin advance). Logged so we can spot reconciliation
          // mismatches in the field; not thrown — there's nothing to
          // recover here.
          log.warn({ orderId, sessionOrderId: session.orderId }, 'distribution_order_paid_noop');
        }
      }

      // ─── Fulfill pitching_bundle ───
      // The session is created in pitching-routes.tsx (POST /pitching/submit)
      // with submissions left in status='pending_payment'. finalizePitchingBundle
      // flips them to 'pending' and fans out admin notifications. This wiring was
      // missing — paid pitches rotted in pending_payment forever (money taken,
      // pitch never reached moderation). Idempotent: the UPDATE is guarded by
      // status='pending_payment' AND payment_session_id=orderId, so a webhook
      // retry flips 0 rows.
      if (itemType === 'pitching_bundle' && session.metadata.submission_ids) {
        const { finalizePitchingBundle } = await import('./pitching-routes.tsx');
        const submissionIds = String(session.metadata.submission_ids)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        await finalizePitchingBundle(session.orderId, submissionIds);
        log.info({ orderId: session.orderId, count: submissionIds.length }, 'pitching_bundle_fulfilled');
      }

} catch (err) {
      // Surface to the caller so the webhook handler can revert the session
      // back to 'pending' and let the gateway retry. Previously this catch
      // swallowed the error → webhook returned success → money taken with
      // beat / digital_good / radio_campaign / venue_radio / booking NEVER
      // delivered (silent service loss).
      log.error({ err, orderId: session.orderId }, 'marketplace_fulfillment_error');
      throw err;
    }
  }

  // ─── Fulfill track_test payment ───
  if (session.metadata?.type === 'track_test' && session.metadata?.requestId) {
    try {
      const { trackTestRequestsStore } = await import('./db.tsx');
      const reqId = session.metadata.requestId;
      const testReq = await trackTestRequestsStore.get(reqId);
      if (testReq && testReq.payment_status !== 'completed') {
        testReq.payment_status = 'completed';
        testReq.status = 'payment_succeeded';
        testReq.payment_transaction_id = session.orderId;
        testReq.updated_at = now;
        await trackTestRequestsStore.set(reqId, testReq);
        log.info({ requestId: reqId, amount: session.amount }, 'track_test_payment_fulfilled');

        // Notify admin about new paid track test. SSE — эфемерный (закрытая
        // админ-вкладка = сигнал потерян), поэтому дублируем durable
        // email+TG: деньги взяты, следующий шаг (модерация) за админом.
        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE('admin', {
            type: 'track_test_paid',
            data: {
              requestId: reqId,
              trackTitle: session.metadata.trackTitle || testReq.track_title,
              amount: session.amount,
            },
          });
        } catch {}
        import('./email-helper.tsx')
          .then(m => m.notifyTrackTestPending({
            trackTitle: session.metadata.trackTitle || testReq.track_title || 'Без названия',
            artistName: testReq.artist_name || 'Артист',
            source: 'оплата YooKassa',
            amount: Number(session.amount) || undefined,
          }))
          .catch(() => {});
      }
    } catch (err) {
      log.error({ err }, 'track_test_fulfillment_error');
    }
  }




  // ─── Fulfill track_publish payment (approved → upcoming → published) ───
  // History: webhook once flipped straight to 'published' (instant Новинки,
  // skipping «Скоро»); then it landed on 'paid' + a manual admin gate
  // (/approve-paid → 'upcoming'). Owner decision 2026-06-17: remove the manual
  // gate — a paid track auto-promotes to 'upcoming' on payment, symmetric with
  // dj_mix_publish (below) and free-track publishing. The track already passed
  // moderation ('approved') BEFORE it could be paid, so payment is a sufficient
  // signal. Lands on 'upcoming' for UPCOMING_DAYS in «Скоро»; then VPS cron
  // /promote-upcoming flips expired upcoming → 'published'. /approve-paid kept
  // as a manual fallback (no-op in the normal flow).
  if (session.metadata?.type === 'track_publish' && session.metadata?.trackId) {
    try {
      const trackId = session.metadata.trackId;
      const { pool: tpPool } = await import('./db-client.tsx');

      // Raw UPDATE with jsonb merge — `data = data || jsonb_build_object(...)`
      // runs against the CURRENT row, not against a stale JS snapshot. The
      // earlier `getTrackById + spread + updateTrack` pattern lost concurrent
      // jsonb writes because the spread used pre-SELECT state (Nadezhda's
      // track e77b1053 incident: payment_amount overwritten 1 → 5000 after
      // a parallel /manageTrackModeration call).
      //
      // WHERE moderation_status='approved' is a soft guard: webhook should
      // only fulfil tracks that the artist actually has the right to pay
      // for (already approved by moderator). If the row is in any other
      // state — already paid (duplicate webhook), pending (skipped
      // moderation somehow), upcoming/published (already advanced) — we
      // skip the write and log loudly. RETURNING tells us which case hit.
      // Auto-promote to 'upcoming' on payment (mirror dj_mix_publish below).
      const UPCOMING_DAYS = 3;
      const upcomingUntilIso = new Date(Date.now() + UPCOMING_DAYS * 86400000).toISOString();
      const result = await tpPool.query(
        // Native cols после migration 062 — payment_amount/payment_completed/
        // payment_order_id/payment_gateway/paid_at промоутнуты из data jsonb.
        // WHERE moderation_status='approved' keeps this idempotent: a duplicate
        // webhook finds the row already 'upcoming' (!= approved) -> 0 rows -> no-op.
        `UPDATE tracks
            SET moderation_status        = 'upcoming',
                is_paid                  = true,
                is_hidden                = false,
                payment_completed        = TRUE,
                payment_amount           = $2::numeric,
                payment_order_id         = $3::text,
                payment_gateway          = $4::text,
                paid_at                  = $5::timestamptz,
                upcoming_until           = $7::timestamptz,
                approved_for_release_at  = $5::timestamptz,
                updated_at               = $6::timestamptz
          WHERE id = $1
            AND moderation_status = 'approved'
          RETURNING payment_amount AS amount, moderation_status`,
        [trackId, session.amount, session.orderId, session.gateway, now, now, upcomingUntilIso]
      );

      if (result.rowCount === 0) {
        const { getTrackById } = await import('./db-typed.tsx');
        const current = await getTrackById(String(trackId));
        log.warn(
          { trackId, currentStatus: current?.moderation_status, isPaid: current?.is_paid },
          'track_payment_received_but_state_mismatch'
        );
        // Don't bail — payment money is real. Surface the mismatch for
        // ops to reconcile manually; webhook still 200s to the gateway
        // so it doesn't retry-storm.
      } else {
        log.info(
          { trackId, amount: session.amount, orderId: session.orderId, storedAmount: result.rows[0]?.amount },
          'track_payment_received'
        );
      }

      // SSE fan-out.
      //   artist  — 'track_paid' so their cabinet shows «Оплачено, ждёт публикации»,
      //             not the old «Опубликован» which was a lie until admin acted.
      //   admin   — 'track_paid' so the admin bell lights up with a NEW action
      //             item (call /approve-paid) instead of a passive «published» FYI.
      try {
        const { emitSSE } = await import('./sse-routes.tsx');
        emitSSE(session.userId, {
          type: 'track_paid',
          data: {
            trackId,
            trackTitle: session.metadata.trackTitle || '',
            amount: session.amount,
          },
        });
        emitSSE('admin', {
          type: 'track_paid',
          data: {
            trackId,
            trackTitle: session.metadata.trackTitle || '',
            userId: session.userId,
            amount: session.amount,
          },
        });
        const actingUserId = session.metadata?.actingForArtistUserId as string | undefined;
        if (actingUserId && actingUserId !== session.userId) {
          emitSSE(actingUserId, {
            type: 'track_paid',
            data: {
              trackId,
              trackTitle: session.metadata.trackTitle || '',
              amount: session.amount,
              viaLabel: true,
            },
          });
        }
      } catch {}
    } catch (err) {
      // Money was taken but track update failed — flag for manual intervention.
      // Webhook still returns success to the gateway (no retry), so without this flag
      // the failure would be invisible: paid session + un-published track.
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, trackId: session.metadata.trackId, orderId: session.orderId }, 'track_publish_fulfillment_error');
      try {
        session.metadata = {
          ...(session.metadata || {}),
          fulfillment_failed: 'true',
          fulfillment_error: errMsg,
          fulfillment_failed_at: now,
        };
        await upsertPaymentSession(session.orderId, session);
      } catch {}
      try {
        const { emitSSE } = await import('./sse-routes.tsx');
        emitSSE('admin', {
          type: 'track_publish_failed',
          data: {
            trackId: session.metadata.trackId,
            trackTitle: session.metadata.trackTitle || '',
            userId: session.userId,
            orderId: session.orderId,
            amount: session.amount,
            error: errMsg,
          },
        });
      } catch {}
    }
  }

  // ─── Fulfill track_test_promote — артист оплатил продвижение трека
  // в секцию «Протестировано экспертами» на 14 дней (см.
  // track-test-routes.tsx /pipeline/promoteToNovelty). ───
  if (session.metadata?.type === 'track_test_promote' && session.metadata?.trackId) {
    try {
      const trackId = String(session.metadata.trackId);
      const requestId = String(session.metadata.requestId || '');
      const { pool: ttpPool } = await import('./db-client.tsx');

      const ttpResult = await ttpPool.query(
        `UPDATE tracks
            SET expert_tested_until    = NOW() + INTERVAL '14 days',
                expert_test_request_id = $2::uuid,
                updated_at             = NOW()
          WHERE id = $1::uuid
          RETURNING id, title, artist`,
        [trackId, requestId || null]
      );

      if (ttpResult.rowCount === 0) {
        log.warn({ trackId, orderId: session.orderId }, 'track_test_promote_no_track_row');
      } else {
        log.info({ trackId, orderId: session.orderId }, 'track_test_promote_fulfilled');

        // Mark the track_test_request so admin sees "оплачено".
        if (requestId) {
          try {
            const { trackTestRequestsStore } = await import('./db.tsx');
            const req: any = await trackTestRequestsStore.get(requestId);
            if (req) {
              req.data = req.data || {};
              req.data.pipeline = req.data.pipeline || {};
              req.data.pipeline.promote = {
                ...(req.data.pipeline.promote || {}),
                paid_at: now,
                payment_amount: session.amount,
              };
              req.updated_at = now;
              await trackTestRequestsStore.set(requestId, req);
            }
          } catch (e) {
            log.warn({ err: (e as any)?.message, requestId }, 'track_test_promote_request_mark_failed');
          }
        }

        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(session.userId, {
            type: 'notification',
            data: {
              title: 'Трек продвигается',
              comment: `«${ttpResult.rows[0]?.title || session.metadata.trackTitle}» — теперь в секции «Протестировано экспертами» на 14 дней`,
            },
          });
        } catch {}
      }
    } catch (err) {
      log.error({ err, trackId: session.metadata.trackId, orderId: session.orderId }, 'track_test_promote_fulfillment_error');
    }
  }

  // ─── Fulfill track_test_exclusive — артист оплатил эксклюзив-pitch
  // A&R-аудитории. Шлёт эксклюзивную рассылку всем label/producer (см.
  // track-test-routes.tsx /pipeline/exclusivePitch). ───
  if (session.metadata?.type === 'track_test_exclusive' && session.metadata?.requestId) {
    try {
      const requestId = String(session.metadata.requestId);
      const { trackTestRequestsStore } = await import('./db.tsx');
      const req: any = await trackTestRequestsStore.get(requestId);
      if (!req) {
        log.warn({ requestId, orderId: session.orderId }, 'track_test_exclusive_no_request');
      } else if (req?.data?.pipeline?.exclusive?.paid_at) {
        log.info({ requestId, orderId: session.orderId }, 'track_test_exclusive_duplicate_webhook_skip');
      } else {
        const { pool: tepPool } = await import('./db-client.tsx');
        const recipientsRes = await tepPool.query(
          `SELECT email FROM users
            WHERE role IN ('label','producer')
              AND email IS NOT NULL AND email <> ''
              AND COALESCE((data->>'unsubscribed_newsletter')::boolean, false) = false`
        );
        const emails: string[] = recipientsRes.rows.map((r: any) => String(r.email)).filter(Boolean);

        const trackUrl = `https://promo-music.ru/tracks/${req.track_id || ''}`;
        const subject = `[ЭКСКЛЮЗИВ A&R] ${req.track_title} — экспертный анализ`;
        const html = `
          <div style="font-family:system-ui,sans-serif;max-width:600px;">
            <div style="background:#FF577F;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0;font-weight:700;">
              ЭКСКЛЮЗИВНОЕ ПРЕДЛОЖЕНИЕ A&R
            </div>
            <div style="border:1px solid #eee;border-top:none;padding:16px;border-radius:0 0 8px 8px;">
              <h2 style="margin-top:0;">${req.track_title}</h2>
              <p><strong>${req.artist_name}</strong> · ${req.genre || '—'}</p>
              <p>Средняя оценка экспертов: <strong>${req.average_rating ?? '—'}/10</strong></p>
              ${req.consolidated_feedback ? `<div style="background:#f8f8f8;padding:12px;border-radius:6px;"><strong>Анализ экспертов:</strong><br>${req.consolidated_feedback}</div>` : ''}
              <p style="margin-top:16px;"><a href="${trackUrl}" style="display:inline-block;padding:10px 20px;background:#FF577F;color:#fff;text-decoration:none;border-radius:6px;">Послушать и связаться</a></p>
            </div>
            <p style="color:#999;font-size:11px;margin-top:12px;">Эксклюзив-pitch на promo-music.ru для A&R и продюсеров.</p>
          </div>`;

        let sent = 0, failed = 0;
        if (emails.length > 0) {
          const { smtpSendBatch } = await import('./smtp-sender.tsx');
          const r = await smtpSendBatch(
            emails.map(e => ({ email: e })),
            subject, html,
            { campaignId: `track_test_exclusive:${requestId}` },
          );
          sent = r.sent;
          failed = r.failed;
        }

        req.data = req.data || {};
        req.data.pipeline = req.data.pipeline || {};
        req.data.pipeline.exclusive = {
          ...(req.data.pipeline.exclusive || {}),
          paid_at: now,
          payment_amount: session.amount,
          recipients_count: emails.length,
          success_count: sent,
          fail_count: failed,
        };
        req.updated_at = now;
        await trackTestRequestsStore.set(requestId, req);

        log.info({ requestId, recipients: emails.length, sent, failed, orderId: session.orderId }, 'track_test_exclusive_fulfilled');

        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(session.userId, {
            type: 'notification',
            data: {
              title: 'Эксклюзив-pitch отправлен',
              comment: `«${req.track_title}» — оценка отправлена ${emails.length} A&R менеджерам`,
            },
          });
        } catch {}
      }
    } catch (err) {
      log.error({ err, orderId: session.orderId }, 'track_test_exclusive_fulfillment_error');
    }
  }

  // ─── Fulfill video_promote — артист оплатил продвижение клипа в
  // секцию «Новые клипы» на главной на 14 дней (см. videos-routes.tsx
  // /promoteToNovelty, migration 122). Idempotency: повторный webhook
  // просто передвинет promoted_until от NOW() — вреда нет, paid_at
  // перезаписывается тем же значением сессии. ───
  if (session.metadata?.type === 'video_promote' && session.metadata?.videoId) {
    try {
      const videoId = String(session.metadata.videoId);
      const { pool: vpPool } = await import('./db-client.tsx');

      // videos.id — uuid, metadata.videoId — text → сравнение по ::text
      const vpResult = await vpPool.query(
        `UPDATE videos
            SET promoted_until = NOW() + INTERVAL '14 days',
                pipeline = jsonb_set(
                  COALESCE(pipeline, '{}'::jsonb),
                  '{promote}',
                  COALESCE(pipeline->'promote', '{}'::jsonb)
                    || jsonb_build_object('paid_at', $2::text, 'payment_amount', $3::numeric),
                  true),
                updated_at = NOW()
          WHERE id::text = $1
          RETURNING id, title, user_id`,
        [videoId, now, session.amount]
      );

      if (vpResult.rowCount === 0) {
        log.warn({ videoId, orderId: session.orderId }, 'video_promote_no_video_row');
      } else {
        log.info({ videoId, orderId: session.orderId }, 'video_promote_fulfilled');
        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(session.userId, {
            type: 'notification',
            data: {
              title: 'Клип продвигается',
              comment: `«${vpResult.rows[0]?.title || session.metadata.videoTitle}» — теперь в секции «Новые клипы» на главной на 14 дней`,
            },
          });
        } catch {}
      }
    } catch (err) {
      log.error({ err, videoId: session.metadata.videoId, orderId: session.orderId }, 'video_promote_fulfillment_error');
    }
  }

  // ─── Fulfill video_exclusive — артист оплатил эксклюзив-pitch клипа.
  // Шлёт рассылку по той же ТВ/радио-базе, что weekly-дайджест
  // (getWeeklyRecipients: radio-юзеры + radio_partner_contacts минус
  // curated_2026 и отписки). Idempotency: pipeline.exclusive.paid_at. ───
  if (session.metadata?.type === 'video_exclusive' && session.metadata?.videoId) {
    try {
      const videoId = String(session.metadata.videoId);
      const { pool: vePool } = await import('./db-client.tsx');

      const veRow = await vePool.query(
        `SELECT v.id, v.title, v.video_url, v.thumbnail_url, v.pipeline,
                COALESCE(NULLIF(u.full_name, ''), NULLIF(u.display_name, ''), 'Артист') AS artist_name
           FROM videos v
           LEFT JOIN users u ON u.id::text = v.user_id::text
          WHERE v.id::text = $1
          LIMIT 1`,
        [videoId]
      );
      const video = veRow.rows[0];

      if (!video) {
        log.warn({ videoId, orderId: session.orderId }, 'video_exclusive_no_video_row');
      } else if (video?.pipeline?.exclusive?.paid_at) {
        log.info({ videoId, orderId: session.orderId }, 'video_exclusive_duplicate_webhook_skip');
      } else {
        const { getWeeklyRecipients } = await import('./radio-digest-routes.tsx');
        const recipients = await getWeeklyRecipients(vePool);

        const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const watchUrl = video.video_url && String(video.video_url).startsWith('http')
          ? String(video.video_url)
          : `https://promo-music.ru${String(video.video_url || '').startsWith('/') ? '' : '/'}${video.video_url || ''}`;
        const subject = `[ЭКСКЛЮЗИВ] Клип для эфира: ${video.artist_name} — ${video.title}`;
        const html = `
          <div style="font-family:system-ui,sans-serif;max-width:600px;">
            <div style="background:#7C3AED;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0;font-weight:700;">
              ЭКСКЛЮЗИВНОЕ ПРЕДЛОЖЕНИЕ ДЛЯ ЭФИРА
            </div>
            <div style="border:1px solid #eee;border-top:none;padding:16px;border-radius:0 0 8px 8px;">
              ${video.thumbnail_url ? `<img src="${esc(video.thumbnail_url)}" alt="" style="width:100%;max-width:568px;border-radius:8px;display:block;margin-bottom:12px;" />` : ''}
              <h2 style="margin-top:0;">${esc(video.title)}</h2>
              <p><strong>${esc(video.artist_name)}</strong></p>
              <p>Здравствуйте, {{name}}! Предлагаем клип артиста ПРОМО.МУЗЫКА к размещению в вашем эфире — эксклюзивно, до широкой ротации.</p>
              <p style="margin-top:16px;"><a href="${esc(watchUrl)}" style="display:inline-block;padding:10px 20px;background:#7C3AED;color:#fff;text-decoration:none;border-radius:6px;">Смотреть клип</a></p>
            </div>
            <p style="color:#999;font-size:11px;margin-top:12px;">Эксклюзив-pitch на promo-music.ru для ТВ и радио.</p>
          </div>`;

        let sent = 0, failed = 0;
        if (recipients.length > 0) {
          const { smtpSendBatch } = await import('./smtp-sender.tsx');
          const r = await smtpSendBatch(
            recipients.map((rc: any) => ({ email: rc.email, vars: { name: rc.name } })),
            subject, html,
            { campaignId: `video_exclusive:${videoId}` },
          );
          sent = r.sent;
          failed = r.failed;
        }

        await vePool.query(
          `UPDATE videos
              SET pipeline = jsonb_set(
                    COALESCE(pipeline, '{}'::jsonb),
                    '{exclusive}',
                    COALESCE(pipeline->'exclusive', '{}'::jsonb)
                      || jsonb_build_object(
                           'paid_at', $2::text,
                           'payment_amount', $3::numeric,
                           'recipients_count', $4::int,
                           'success_count', $5::int,
                           'fail_count', $6::int),
                    true),
                  updated_at = NOW()
            WHERE id::text = $1`,
          [videoId, now, session.amount, recipients.length, sent, failed]
        );

        log.info({ videoId, recipients: recipients.length, sent, failed, orderId: session.orderId }, 'video_exclusive_fulfilled');
        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(session.userId, {
            type: 'notification',
            data: {
              title: 'Эксклюзив-pitch отправлен',
              comment: `Клип «${video.title}» отправлен ${recipients.length} ТВ/радио-редакторам`,
            },
          });
        } catch {}
      }
    } catch (err) {
      log.error({ err, videoId: session.metadata.videoId, orderId: session.orderId }, 'video_exclusive_fulfillment_error');
    }
  }

  // ─── Fulfill banner_publish ───
  //
  // До 2026-06-16 ЭТО ОТСУТСТВОВАЛО ПОЛНОСТЬЮ. /checkout/create-session
  // валидировал banner_publish (строки ~1394-1428 этого файла), webhook
  // приходил, но НИКАКОЙ блок не апдейтил banner_ads — деньги шли на
  // счёт платформы, а кампания оставалась в moderation_status='approved'
  // без status='active', start_date, end_date. Юзер платил, баннер не
  // крутился. Silent gold-bug.
  //
  // Логика активации зеркалит admin-only POST /banner/:id/manual-activate
  // (banner-routes.tsx:280-340): status='active', moderation_status='paid',
  // start_date=now, end_date=now+duration_days.
  //
  // Idempotency: WHERE moderation_status='approved' (или 'paid' — пишем
  // payment_order_id и start_date/end_date только при первой обработке;
  // повторный webhook на ту же сессию UPDATE'нёт 0 строк и выйдет).
  if (session.metadata?.type === 'banner_publish' && session.metadata?.bannerId) {
    const bannerId = String(session.metadata.bannerId);
    try {
      const { pool: bpPool } = await import('./db-client.tsx');

      // Сначала читаем duration_days, чтобы посчитать end_date. SELECT
      // выполняется до UPDATE, потому что нужен duration ИЗ строки —
      // нельзя считать в одном UPDATE без подзапроса с COALESCE.
      const dur = await bpPool.query(
        `SELECT duration_days FROM banner_ads WHERE id = $1 LIMIT 1`,
        [bannerId]
      );
      if (dur.rows.length === 0) {
        log.warn({ bannerId, orderId: session.orderId }, 'banner_publish_webhook_banner_missing');
      } else {
        const days = Number(dur.rows[0]?.duration_days) || 7;
        const startDate = new Date(now);
        const endDate = new Date(startDate.getTime() + days * 86400000);

        const result = await bpPool.query(
          `UPDATE banner_ads
              SET status            = 'active',
                  moderation_status = 'paid',
                  start_date        = $2::timestamptz,
                  end_date          = $3::timestamptz,
                  payment_order_id  = $4::text,
                  payment_gateway   = $5::text,
                  paid_at           = $6::timestamptz,
                  updated_at        = $7::timestamptz
            WHERE id = $1
              AND moderation_status = 'approved'
              AND (payment_order_id IS NULL OR payment_order_id = $4)
            RETURNING id, end_date`,
          [bannerId, startDate.toISOString(), endDate.toISOString(),
           session.orderId, session.gateway, now, now]
        );

        if (result.rowCount === 0) {
          // Либо банер уже paid (повторный webhook — идемпотентно ОК),
          // либо в нежданном статусе. Читаем чтобы залогировать.
          const { getBannerById } = await import('./db-typed.tsx');
          const cur = await getBannerById(bannerId).catch(() => null);
          log.warn(
            { bannerId, currentStatus: cur?.moderation_status, currentBannerStatus: cur?.status, orderId: session.orderId },
            'banner_payment_received_but_state_mismatch'
          );
        } else {
          log.info(
            { bannerId, amount: session.amount, orderId: session.orderId, endDate: result.rows[0]?.end_date, days },
            'banner_payment_received'
          );

          // SSE → артист, чтобы кабинет «Реклама» подтянул активный баннер.
          try {
            const { emitSSE } = await import('./sse-routes.tsx');
            emitSSE(session.userId, {
              type: 'banner_paid',
              data: {
                bannerId,
                title: session.metadata?.bannerTitle || '',
                amount: session.amount,
                endDate: result.rows[0]?.end_date,
              },
            });
          } catch {}
        }
      }
    } catch (err) {
      // Money already taken, banner activation failed — нужно ручное
      // вмешательство. Не throw, чтобы YooKassa не ретраила.
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errMsg, bannerId, orderId: session.orderId }, 'banner_payment_fulfilment_error');
      try {
        const { emitSSE } = await import('./sse-routes.tsx');
        emitSSE('admin', {
          type: 'banner_payment_fulfilment_error',
          data: { bannerId, orderId: session.orderId, error: errMsg },
        });
      } catch {}
    }
  }

  // ─── Fulfill dj_mix_publish (approved → upcoming → published через cron) ───
  // Симметрично track_publish: оплаченный микс уходит в 'upcoming' на
  // UPCOMING_DAYS (3 дня), показывается в «Скоро» наряду с треками
  // артистов и UNION'ится в Новинки недели (где «Новинки» = upcoming ∪
  // published). Cron POST /track-moderation/promote-upcoming затем
  // расширен на dj_mixes — переводит upcoming в published когда
  // upcoming_until истёк.
  //
  // Раньше webhook ставил сразу published — миксы попадали в Новинки
  // мгновенно без «Скоро»-стадии. user-reported: DJ Ден появлялся в
  // /tracks/new сразу, минуя upcoming-витрину.
  if (session.metadata?.type === 'dj_mix_publish' && session.metadata?.mixId) {
    try {
      const mixId = String(session.metadata.mixId);
      const { pool: mxPool } = await import('./db-client.tsx');

      const UPCOMING_DAYS = 3;
      const upcomingUntilIso = new Date(Date.now() + UPCOMING_DAYS * 86400000).toISOString();

      // Native cols (migration 046): payment_* + upcoming_until +
      // approved_for_release_at стали колонками, data jsonb DROPped.
      const result = await mxPool.query(
        `UPDATE dj_mixes
            SET moderation_status        = 'upcoming',
                is_hidden                = false,
                status                   = 'upcoming',
                payment_completed        = TRUE,
                payment_amount           = $2,
                payment_order_id         = $3,
                payment_gateway          = $4,
                paid_at                  = $5::timestamptz,
                upcoming_until           = $7::timestamptz,
                approved_for_release_at  = $5::timestamptz,
                moderated_at             = COALESCE(moderated_at, $6::timestamptz),
                updated_at               = $6
          WHERE id = $1
            AND moderation_status = 'approved'
          RETURNING dj_id, title`,
        [mixId, session.amount, session.orderId, session.gateway, now, now, upcomingUntilIso]
      );

      if (result.rowCount === 0) {
        log.warn(
          { mixId, orderId: session.orderId },
          'dj_mix_payment_received_but_state_mismatch'
        );
      } else {
        const { dj_id: djId, title } = result.rows[0];
        log.info(
          { mixId, djId, amount: session.amount, orderId: session.orderId },
          'dj_mix_payment_published'
        );

        // Inbox + SSE — теперь это «в Скоро на 3 дня», а не сразу
        // опубликован. После promote-upcoming придёт второй notif
        // «теперь в Новинках недели».
        try {
          const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
          await notifyCrossCabinet({
            targetUserId: djId,
            targetRole: 'dj',
            sourceRole: 'system',
            type: 'mix_published',
            title: 'Микс попал в «Скоро»',
            message: `"${title}" появится в «Новинках недели» через 3 дня`,
            link: '/dj/mixes',
            metadata: { mixId, amount: session.amount },
          });
        } catch (err) {
          log.warn({ err, mixId }, 'dj_mix_published_notify_failed');
        }
        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(djId, {
            type: 'mix_published',
            data: { mixId, title, amount: session.amount },
          });
          emitSSE('admin', {
            type: 'mix_published',
            data: { mixId, title, djId, amount: session.amount },
          });
        } catch {}
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, mixId: session.metadata.mixId, orderId: session.orderId }, 'dj_mix_publish_fulfillment_error');
      // Money taken — flag для ops чтобы вручную поправить состояние.
      try {
        session.metadata = {
          ...(session.metadata || {}),
          fulfillment_failed: 'true',
          fulfillment_error: errMsg,
          fulfillment_failed_at: now,
        };
        await upsertPaymentSession(session.orderId, session);
      } catch {}
    }
  }

  // ─── Fulfill video_publish / concert_publish (publish_orders → paid) ───
  // Pipeline aligned with tracks: payment makes the order 'paid', NOT 'published'.
  // Admin must explicitly publish from the moderation panel after verifying payment.
  if (
    (session.metadata?.type === 'video_publish' || session.metadata?.type === 'concert_publish')
    && session.metadata?.orderId
  ) {
    try {
      // publish_orders data column DROPPED в migration 078 — typed getPublishOrder
      // / updatePublishOrder читают/пишут native cols. Раньше этот flow silently
      // failed payment fulfillment — order оставался в pending_payment forever.
      const { getPublishOrder, updatePublishOrder } = await import('./db.tsx');
      const orderId = String(session.metadata.orderId);
      const ord = await getPublishOrder(orderId);
      if (!ord) {
        log.warn({ orderId }, 'publish_order_not_found_for_fulfillment');
      } else {
        await updatePublishOrder(orderId, {
          status: 'paid',
          paidAt: now,
          paymentMethod: session.gateway,
        });
        log.info({ orderId, type: session.metadata.type, amount: session.amount }, 'publish_order_payment_fulfilled');

        // Notify artist payment received + admin that an order awaits publication.
        try {
          const { createArtistNotification } = await import('./publish-routes.tsx');
          await createArtistNotification(session.userId, orderId, ord.title || '', 'paid');
        } catch (err) {
          log.warn({ err, orderId }, 'publish_paid_notification_failed');
        }
        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE('admin', {
            type: 'publish_paid',
            data: { orderId, type: ord.type, title: ord.title, userId: session.userId },
          });
        } catch {}
      }
    } catch (err) {
      log.error({ err, orderId: session.metadata.orderId }, 'publish_order_fulfillment_error');
    }
  }

  // ─── Fulfill market_purchase (готовые биты/минусы/песни, 25.09.2026) ───
  if (session.metadata?.type === 'market_purchase' && session.metadata?.purchaseId) {
    try {
      const { fulfillMarketPurchase } = await import('./market-routes.tsx');
      await fulfillMarketPurchase(String(session.metadata.purchaseId), session.orderId, Number(session.amount));
      log.info({ purchaseId: session.metadata.purchaseId, orderId: session.orderId }, 'market_purchase_fulfilled');
    } catch (err) {
      log.error({ err, purchaseId: session.metadata.purchaseId }, 'market_purchase_fulfillment_error');
    }
  }

  // ─── Fulfill beat_purchase (Beats Marketplace) ───
  if (session.metadata?.type === 'beat_purchase' && session.metadata?.beatId) {
    try {
      const { getBeat, upsertBeat } = await import('./db.tsx');
      const { pool: cPool3 } = await import('./db-client.tsx');
      const { recordPlatformCommission } = await import('./platform-revenue.tsx');
      const beatId = session.metadata.beatId;
      const licenseType = session.metadata.licenseType;
      const buyerId = session.userId;
      const buyerName = session.metadata.buyerName || 'Покупатель';

      const raw = await getBeat(beatId);
      if (raw) {
        const beat = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const price = session.amount;
        const commission = Math.round(price * 0.1);
        const producerPayout = price - commission;
        // Deterministic id keyed on orderId. Critical: the INSERT's rowCount
        // now gates recordPlatformCommission + sales-increment + SSE below.
        // Previously a random id meant ON CONFLICT never fired AND the producer
        // payout was recorded again on every YooKassa retry → double-credit.
        const purchaseId = `bp-${session.orderId}`;

        const purchase = {
          id: purchaseId, beatId, beatTitle: beat.title,
          producerId: beat.producerId, producerName: beat.producer,
          buyerId, buyerName, licenseType, price, commission, producerPayout,
          status: 'completed', paymentOrderId: session.orderId, paymentGateway: session.gateway,
          createdAt: now,
        };

        const insBp = await cPool3.query(
          `INSERT INTO beat_purchases (id, beat_id, buyer_id, producer_id, amount, license_type, status, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [purchaseId, beatId, buyerId, beat.producerId || null, price, licenseType,
           JSON.stringify(purchase)]
        );

        if (insBp.rowCount && insBp.rowCount > 0) {
          beat.purchases = (beat.purchases || 0) + 1;
          if (licenseType === 'exclusive') beat.status = 'sold';
          await upsertBeat(beatId, beat);

          await recordPlatformCommission('beat', beat.title, price, commission, producerPayout, {
            producerId: beat.producerId, producerName: beat.producer, buyerId, buyerName,
          });

          try {
            const { emitSSE } = await import('./sse-routes.tsx');
            emitSSE(beat.producerId, {
              type: 'beat_purchased',
              data: { title: 'Продажа бита', purchaseId, beatId, licenseType, price, producerPayout },
            });
          } catch {}

          log.info({ beatId, purchaseId, price, orderId: session.orderId }, 'beat_purchase_fulfilled');
        } else {
          log.info({ beatId, purchaseId, orderId: session.orderId }, 'beat_purchase_already_fulfilled_skip');
        }
      }
    } catch (err) {
      log.error({ err, beatId: session.metadata.beatId }, 'beat_purchase_fulfillment_error');
    }
  }

  // ─── Fulfill digital_purchase (Digital Goods Marketplace) ───
  if (session.metadata?.type === 'digital_purchase' && session.metadata?.digitalGoodId) {
    try {
      const { getDigitalGood, incrementDigitalGoodSales } = await import('./db.tsx');
      const { pool: cPool4 } = await import('./db-client.tsx');
      const { recordPlatformCommission } = await import('./platform-revenue.tsx');
      const goodId = session.metadata.digitalGoodId;
      const buyerId = session.userId;
      const buyerName = session.metadata.buyerName || 'Покупатель';

      const good = await getDigitalGood(goodId);
      if (good) {
        const price = session.amount;
        const commission = Math.round(price * 0.1);
        const producerPayout = price - commission;
        // Deterministic id keyed on orderId. The INSERT rowCount now gates
        // recordPlatformCommission + sales-increment + SSE. Previously the
        // random id + unconditional side-effects double-credited the producer
        // and double-incremented sales on every YooKassa retry. (The inline
        // "race-free на retry" comment was wrong — the INSERT was guarded by a
        // never-colliding id, so retries always re-ran the payout.)
        const purchaseId = `dgp-${session.orderId}`;

        const purchase = {
          id: purchaseId, digitalGoodId: goodId, title: good.title, category: good.category,
          producerId: good.producerId, producerName: good.producer,
          buyerId, buyerName, price, commission, producerPayout,
          status: 'completed', paymentOrderId: session.orderId, paymentGateway: session.gateway,
          createdAt: now,
        };

        const insDgp = await cPool4.query(
          `INSERT INTO digital_purchases (id, good_id, buyer_id, amount, data, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [purchaseId, goodId, buyerId, price, JSON.stringify(purchase)]
        );

        if (insDgp.rowCount && insDgp.rowCount > 0) {
          await incrementDigitalGoodSales(goodId);

          await recordPlatformCommission('digital_good', good.title, price, commission, producerPayout, {
            producerId: good.producerId, producerName: good.producer, buyerId, buyerName,
          });

          try {
            const { emitSSE } = await import('./sse-routes.tsx');
            emitSSE(good.producerId, {
              type: 'digital_purchased',
              data: { title: 'Продажа цифрового товара', purchaseId, digitalGoodId: goodId, price, producerPayout },
            });
          } catch {}

          log.info({ goodId, purchaseId, price, orderId: session.orderId }, 'digital_purchase_fulfilled');
        } else {
          log.info({ goodId, purchaseId, orderId: session.orderId }, 'digital_purchase_already_fulfilled_skip');
        }
      }
    } catch (err) {
      log.error({ err, goodId: session.metadata.digitalGoodId }, 'digital_purchase_fulfillment_error');
    }
  }

  // ─── Fulfill production_360_payment (Production 360 Marketplace) ───
  if (session.metadata?.type === 'production_360_payment' && session.metadata?.productionOrderId) {
    try {
      const { getProduction360Order, upsertProduction360Order } = await import('./db.tsx');
      const productionOrderId = session.metadata.productionOrderId;
      const order: any = await getProduction360Order(productionOrderId);
      if (order && order.status === 'pending_payment') {
        order.status = 'paid';
        order.statusEnteredAt = now;
        order.paidAt = now;
        order.updatedAt = now;
        order.paymentOrderId = session.orderId;
        order.paymentGateway = session.gateway;
        await upsertProduction360Order(productionOrderId, order);

        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(order.artistId, {
            type: 'production_360_paid',
            data: { title: 'Заказ оплачен', orderId: productionOrderId, amount: session.amount },
          });
          emitSSE('admin', {
            type: 'production_360_paid',
            data: { orderId: productionOrderId, amount: session.amount, artistId: order.artistId },
          });
        } catch {}

        log.info({ productionOrderId, amount: session.amount, orderId: session.orderId }, 'production_360_fulfilled');
      }
    } catch (err) {
      log.error({ err, productionOrderId: session.metadata.productionOrderId }, 'production_360_fulfillment_error');
    }
  }

  // ─── Fulfill engineer_order (маркетплейс звукоинженера) ───
  // accepted → in_progress после успешной оплаты. Идемпотентно:
  // WHERE status='accepted' гарантирует, что повторный вебхук не сбросит
  // уже продвинутый заказ (delivered/completed) назад в in_progress.
  if (session.metadata?.type === 'engineer_order' && session.metadata?.engineerOrderId) {
    const engOrderId = String(session.metadata.engineerOrderId);
    try {
      const { pool: vpool } = await import('./db-client.tsx');
      const upd = await vpool.query(
        `UPDATE engineer_orders
           SET status='in_progress', payment_order_id=$1, paid_at=NOW(), updated_at=NOW()
         WHERE id=$2 AND status='accepted'
         RETURNING engineer_id, client_id, title`,
        [session.orderId, engOrderId],
      );
      if (upd.rows.length > 0) {
        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(upd.rows[0].engineer_id, {
            type: 'engineer_order_paid',
            data: { title: upd.rows[0].title, orderId: engOrderId, amount: session.amount },
          });
        } catch {}
        // E-mail инженеру: «деньги пришли, можно приступать». SSE
        // покрывает кабинет, email — мобильник / offline. Per-user
        // toggle (миграция 105: notify_email_on_paid, default TRUE)
        // тащим тем же JOIN'ом — лишний round-trip не нужен.
        try {
          const { pool: vpool2 } = await import('./db-client.tsx');
          const u = await vpool2.query(
            `SELECT u.email, u.full_name,
                    COALESCE(ep.notify_email_on_paid, TRUE) AS notify
               FROM users u
               LEFT JOIN engineer_profiles ep ON ep.user_id = u.id
              WHERE u.id = $1`,
            [upd.rows[0].engineer_id],
          );
          const eng = u.rows[0];
          if (eng?.email && eng.notify) {
            const { notifyEngineerOrderPaid } = await import('./email-helper.tsx');
            void notifyEngineerOrderPaid(eng.email, eng.full_name || '', upd.rows[0].title, Number(session.amount));
          }
        } catch (err) { log.warn({ err, engOrderId }, 'engineer_order_paid_email'); }
        log.info({ engOrderId, amount: session.amount, orderId: session.orderId }, 'engineer_order_paid');
      } else {
        log.warn({ engOrderId, orderId: session.orderId }, 'engineer_order_not_accepted_for_fulfillment');
      }
    } catch (err) {
      log.error({ err, engOrderId: session.metadata.engineerOrderId }, 'engineer_order_fulfillment_error');
    }
  }

  // ─── Fulfill donation ───
  if (session.type === 'donation' && session.metadata?.donationId) {
    try {
      // 2026-06-14: ранее тут был импорт `getDonation` которого в db.tsx
      // не существует (есть только getDonationsByArtist). Любая попытка
      // довести donation_pending webhook до этого блока крашила процесс
      // с ReferenceError. Реально нужный API — getDonationsByArtist, что
      // и подтверждает логика ниже (Array.isArray → find by id).
      const { getDonationsByArtist, createDonation } = await import('./db.tsx');
      const donationId = session.metadata.donationId;
      const artistId = session.metadata.artistId;
      if (artistId && donationId) {
        // Try to load existing donation record
        let donation: any = null;
        try {
          const allDonations = await getDonationsByArtist(artistId) as any;
          if (Array.isArray(allDonations)) {
            donation = allDonations.find((d: any) => d.id === donationId);
          }
        } catch {}

        if (donation) {
          // Update existing donation to completed
          donation.status = 'completed';
          donation.paidAt = now;
          donation.paymentOrderId = session.orderId;
          donation.paymentGateway = session.gateway;
          await createDonation(artistId, donationId, donation);
        } else {
          // Create donation record from webhook data
          const newDonation = {
            id: donationId,
            artistId,
            donorId: session.userId,
            donorName: session.metadata.donorName || 'Anonymous',
            amount: session.amount,
            currency: session.currency || 'RUB',
            isAnonymous: session.metadata.isAnonymous === 'true',
            status: 'completed',
            paidAt: now,
            paymentOrderId: session.orderId,
            paymentGateway: session.gateway,
            createdAt: now,
          };
          await createDonation(artistId, donationId, newDonation);
        }
        log.info({ donationId, artistId, amount: session.amount }, 'donation_fulfilled');

        // Q1 (2026-06-04): уведомить артиста о донате. Раньше он узнавал ТОЛЬКО
        // зайдя в кабинет (pull через GET /donations) — realtime/in-app push'а не было.
        // SSE (мгновенно) + persisted cross-cabinet нотификация (инбокс артиста).
        if (artistId !== 'unknown') {
          const donorLabel = session.metadata.isAnonymous === 'true'
            ? 'Анонимный слушатель'
            : (session.metadata.donorName || 'Слушатель');
          try {
            // notifyCrossCabinet сам эмитит SSE (mapTypeToSSEEvent) сразу после
            // persist — отдельный emitSSE убран (моб-ревью #196), чтобы артист
            // не получал ДВА SSE-сообщения. sourceRole='system' — донат от
            // слушателя/системы, не от админа.
            const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
            await notifyCrossCabinet({
              targetUserId: artistId,
              targetRole: 'artist',
              sourceRole: 'system',
              type: 'donation_received',
              title: 'Новый донат! 💜',
              message: `${donorLabel} поддержал(а) вас на ${session.amount} ₽`,
              metadata: { donationId, amount: Number(session.amount), donorName: donorLabel },
            });
          } catch (notifyErr) {
            log.warn({ err: notifyErr, artistId, donationId }, 'donation_notify_failed');
          }
        }
      }
    } catch (err) {
      log.error({ err }, 'donation_fulfillment_error');
    }
  }

  // ─── Fulfill collab_accept: escrow_pending → escrow_held ───
  //
  // Idempotent: WHERE payment_status='escrow_pending' guard — a re-delivered
  // YooKassa webhook returns 0 rowCount and logs a warning without
  // double-crediting the producer (release happens at /complete or auto-complete cron).
  if (session.metadata?.type === 'collab_accept' && session.metadata?.offerId) {
    try {
      const { pool: cpPool } = await import('./db-client.tsx');
      const offerId = String(session.metadata.offerId);
      const upd = await cpPool.query(
        `UPDATE collab_offers
            SET payment_status  = 'escrow_held',
                status          = 'accepted',
                paid_at         = NOW(),
                accept_deadline = COALESCE(deadline, NOW()) + INTERVAL '7 days',
                updated_at      = NOW()
          WHERE id = $1
            AND payment_status  = 'escrow_pending'
          RETURNING id, artist_id, producer_id, title, price`,
        [offerId]
      );
      if (upd.rowCount && upd.rowCount > 0) {
        const row = upd.rows[0];
        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(row.artist_id, {
            type: 'collab_escrow_held',
            data: { offerId, title: row.title, amount: Number(row.price) || 0 },
          });
          emitSSE(row.producer_id, {
            type: 'collab_escrow_held',
            data: { offerId, title: row.title, amount: Number(row.price) || 0 },
          });
        } catch {}
        log.info({ offerId, amount: session.amount, orderId: session.orderId }, 'collab_accept_escrow_held');
      } else {
        log.warn({ offerId, orderId: session.orderId }, 'collab_accept_escrow_noop');
      }
    } catch (err) {
      log.error({ err, offerId: session.metadata.offerId }, 'collab_accept_fulfillment_error');
    }
  }

  // Save payment method if requested
  if (session.savePaymentMethod && webhook.paymentMethodId) {
    const method: SavedPaymentMethod = {
      id: `pm-${Date.now()}`,
      userId: session.userId,
      gateway: session.gateway,
      gatewayMethodId: webhook.paymentMethodId,
      type: 'bank_card',
      title: `${session.gateway === 'yookassa' ? 'ЮКасса' : session.gateway === 'stripe' ? 'Stripe' : 'Т-Банк'} карта`,
      createdAt: now,
    };
    await upsertPaymentMethod(method.id, session.userId, method);
  }

  // Record platform revenue (using existing platform-revenue if available)
  try {
    const { recordRevenue } = await import('./platform-revenue.tsx');
    const commissionRate = session.type === 'donation' ? 0 : 0.1; // 10% commission except donations

    // 2026-06-18: payee resolution для не-artist'овых платежей.
    // До этого PR'а `payeeId: session.metadata.artistId` хардкодилось —
    // для engineer_order (FE передаёт только engineerOrderId, не artistId)
    // payeeId писался NULL → /engineer/earnings WHERE payee_id = $1 не
    // находил ни одной строки → инженер видел «доход 0 ₽» даже после
    // оплаченных заказов. Тот же класс silent data-loss что и
    // _getRadioBalance=0 (radio #285).
    //
    // Canonical engineer_id берём из engineer_orders, не из metadata:
    // (а) IDOR-safe — клиент не влияет на payee
    // (б) идемпотентно для webhook retry
    let payeeId: string | undefined = session.metadata.artistId;
    let payeeName: string | undefined = session.metadata.artistName;
    // FE (EngineerStorefront) шлёт metadata.type='engineer_order', НЕ itemType.
    // Проверка только itemType (как было) → payee_id=NULL и channel='purchase'
    // → /engineer/earnings (WHERE channel='engineer_order') вечно 0 строк —
    // инженер не видел заработок вообще. Принимаем оба ключа.
    const isEngineerOrder =
      session.metadata?.itemType === 'engineer_order' ||
      session.metadata?.type === 'engineer_order';
    if (isEngineerOrder && session.metadata?.engineerOrderId) {
      try {
        const { pool: rrPool } = await import('./db-client.tsx');
        const r = await rrPool.query(
          'SELECT engineer_id FROM engineer_orders WHERE id = $1',
          [String(session.metadata.engineerOrderId)],
        );
        if (r.rows[0]?.engineer_id) {
          payeeId = r.rows[0].engineer_id;
          payeeName = payeeName || 'engineer';
        }
      } catch (e: any) {
        log.warn({ err: e?.message, orderId: session.metadata.engineerOrderId }, 'engineer_payee_lookup_failed');
      }
    }

    await recordRevenue({
      // isEngineerOrder-ветка: без неё channel падал в 'purchase' (см. выше).
      // Узко только для engineer_order — прочие metadata.type (collab_accept,
      // banner_publish…) НЕ должны менять channel, их семантика другая.
      channel: session.type === 'purchase'
        ? (session.metadata.itemType || (isEngineerOrder ? 'engineer_order' : 'purchase'))
        : session.type,
      description: session.description,
      grossAmount: session.amount,
      platformRevenue: session.amount * commissionRate,
      payoutAmount: session.amount * (1 - commissionRate),
      commissionRate,
      payerId: session.userId,
      payerName: session.metadata.payerName || session.userId,
      payeeId,
      payeeName,
      metadata: { orderId: session.orderId, gateway: session.gateway },
    });
  } catch (err) {
    log.warn({ err }, 'revenue_recording_skipped');
  }

  // Email notification to admin
  notifyPaymentReceived({
    amount: session.amount,
    currency: session.currency,
    type: session.type,
    description: session.description,
    gateway: session.gateway,
    userName: session.metadata.payerName || session.metadata.artistName || '',
    userEmail: session.metadata.payerEmail || '',
    orderId: session.orderId,
  }).catch(err => log.warn({ err: err.message }, 'payment_email_notify_failed'));

  log.info({ orderId: session.orderId, gateway: session.gateway, amount: session.amount, currency: session.currency }, 'payment_completed');
}

async function processPaymentCanceled(session: PaymentSession, rawBody?: any) {
  session.status = 'canceled';
  session.completedAt = new Date().toISOString();
  await upsertPaymentSession(session.orderId, session);

  // Determine cancellation reason from raw YooKassa webhook payload
  const reason: string =
    rawBody?.object?.cancellation_details?.reason ||
    rawBody?.body?.object?.cancellation_details?.reason ||
    '';
  log.info({ orderId: session.orderId, reason }, 'payment_canceled');

  // Отменённая оплата товара маркетплейса освобождает эксклюзив для других покупателей.
  if (session.metadata?.type === 'market_purchase' && session.metadata?.purchaseId) {
    try {
      const { cancelMarketPurchase } = await import('./market-routes.tsx');
      await cancelMarketPurchase(String(session.metadata.purchaseId));
    } catch (err) {
      log.warn({ err, purchaseId: session.metadata.purchaseId }, 'market_purchase_cancel_error');
    }
  }

  // Email-возврат при expired_on_confirmation: пользователь начал оплату, но не довёл — шлём reminder
  if (reason === 'expired_on_confirmation') {
    try {
      // Resolve user email + name from users table
      const { pool } = await import('./db-client.tsx');
      const userRow = await pool.query(
        `SELECT email, COALESCE(display_name, full_name, username) AS name FROM users WHERE id = $1 LIMIT 1`,
        [session.userId]
      );
      const email = userRow.rows[0]?.email || session.metadata?.payerEmail || '';
      const name = userRow.rows[0]?.name || session.metadata?.payerName || '';

      if (email) {
        // Build retry deep-link based on payment type
        const meta = session.metadata || {};
        let retryUrl = 'https://promo-music.ru/artist/finances';
        if (meta.type === 'track_publish' || session.type === 'purchase') {
          retryUrl = `https://promo-music.ru/artist/tracks?retry=${encodeURIComponent(session.orderId)}`;
        } else if (session.type === 'subscription') {
          retryUrl = 'https://promo-music.ru/artist/subscription?retry=1';
        } else if (session.type === 'topup') {
          retryUrl = 'https://promo-music.ru/artist/finances?retry=1';
        }

        await notifyPaymentExpired({
          email,
          name,
          amount: session.amount,
          currency: session.currency,
          description: session.description || meta.trackTitle || '',
          retryUrl,
          orderId: session.orderId,
        });
        log.info({ orderId: session.orderId, email }, 'payment_expired_email_sent');
      } else {
        log.warn({ orderId: session.orderId, userId: session.userId }, 'payment_expired_email_skipped_no_address');
      }
    } catch (err: any) {
      log.warn({ err: err.message, orderId: session.orderId }, 'payment_expired_email_failed');
    }
  }
}

// ── POST /create-session ──

checkoutRoutes.post('/create-session', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ success: false, error: "Invalid request body" }, 400); }

    const { gateway, amount, type, description, returnUrl, savePaymentMethod, metadata } = body;

    // Validate
    if (!gateway || !['yookassa', 'tbank', 'stripe'].includes(gateway)) {
      return c.json({ success: false, error: 'Укажите gateway: "yookassa", "tbank" или "stripe"' }, 400);
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return c.json({ success: false, error: 'Сумма должна быть положительным числом' }, 400);
    }
    if (amount < MIN_PAYMENT_AMOUNT_RUB || amount > MAX_PAYMENT_AMOUNT_RUB) {
      return c.json({ success: false, error: `Сумма должна быть от ${MIN_PAYMENT_AMOUNT_RUB} до ${MAX_PAYMENT_AMOUNT_RUB} ₽` }, 400);
    }
    if (!type || !['purchase', 'subscription', 'donation', 'topup'].includes(type)) {
      return c.json({ success: false, error: 'Укажите type: purchase, subscription, donation или topup' }, 400);
    }
    // For subscriptions the price MUST match the canonical plan price — the client cannot
    // dictate the amount. This blocks the "open DevTools, lower the price" attack.
    //
    // ВАЖНО: до 2026-06-16 этот гард валидировал ТОЛЬКО artist plans
    // (SUBSCRIPTION_PLANS). DJ flow приходит как
    // `type='subscription' + metadata.role='dj' + metadata.planId`, venue
    // — как `type='venue_subscription' + metadata.planKey`. Оба ранее
    // НЕ проходили amount-check вообще + webhook доверял
    // metadata.djId/metadata.userId без сверки с JWT — позволяло А
    // оплатить 1 ₽ и апгрейднуть B на Pro/Network. Теперь обе ветки
    // проходят amount-gate + ownership-check (metadata.djId === userId).
    if (type === 'subscription' && metadata?.role !== 'dj') {
      // Artist subscription (роль не выставлена ИЛИ явно не 'dj').
      const planKey = metadata?.planKey;
      const interval = metadata?.interval === 'year' ? 'year' : 'month';
      const plan = planKey ? (SUBSCRIPTION_PLANS as Record<string, any>)[planKey] : null;
      if (!plan) {
        return c.json({ success: false, error: 'Invalid metadata.planKey for subscription' }, 400);
      }
      const expected = interval === 'year' ? plan.price_year : plan.price_month;
      if (Math.abs(amount - expected) > 0.01) {
        log.warn({ userId, planKey, interval, expected, received: amount }, 'subscription_amount_tampering_blocked');
        return c.json({ success: false, error: 'Сумма не соответствует тарифу' }, 400);
      }
    }

    // DJ subscription. Defensive copy of pricing inline — minimal coupling
    // to dj-studio-routes (which holds the canonical DJ_PLANS array). На
    // момент 2026-06-16: starter=0 (бесплатно — через checkout не идёт),
    // pro=990/9900, agency=2990/29900. Если pricing меняется на проде —
    // обновить и здесь, и в DJ_PLANS, и в DJ_PLANS_LOCAL в webhook'е
    // (см. строки ~270 этого файла). Long-term — общий source-of-truth.
    if (type === 'subscription' && metadata?.role === 'dj') {
      const DJ_PRICES: Record<string, { month: number; year: number }> = {
        pro:    { month: 990,  year: 9900  },
        agency: { month: 2990, year: 29900 },
      };
      const planId = String(metadata?.planId || '');
      const interval = metadata?.interval === 'year' ? 'year' : 'month';
      const prices = DJ_PRICES[planId];
      if (!prices) {
        return c.json({ success: false, error: 'Invalid metadata.planId for dj subscription' }, 400);
      }
      const expected = interval === 'year' ? prices.year : prices.month;
      if (Math.abs(amount - expected) > 0.01) {
        log.warn({ userId, planId, interval, expected, received: amount }, 'dj_subscription_amount_tampering_blocked');
        return c.json({ success: false, error: 'Сумма не соответствует тарифу DJ' }, 400);
      }
      // Ownership: если клиент передал metadata.djId, он ДОЛЖЕН совпадать
      // с userId из JWT. Иначе webhook раньше доверчиво апгрейдил чужой
      // djId. Без metadata.djId webhook fall back на session.userId (JWT)
      // — это корректно.
      if (metadata?.djId && String(metadata.djId) !== String(userId)) {
        log.warn({ userId, claimedDjId: metadata.djId }, 'dj_subscription_impersonation_blocked');
        return c.json({ success: false, error: 'Нельзя оплатить чужую подписку' }, 403);
      }
    }

    // Venue subscription. Price source-of-truth — venue-plans-constants.tsx.
    if (type === 'venue_subscription') {
      const { VENUE_PLANS_CORE } = await import('./venue-plans-constants.tsx');
      const planKey = String(metadata?.planKey || '') as keyof typeof VENUE_PLANS_CORE;
      const interval = metadata?.interval === 'year' ? 'year' : 'month';
      const plan = VENUE_PLANS_CORE[planKey];
      if (!plan) {
        return c.json({ success: false, error: 'Invalid metadata.planKey for venue subscription' }, 400);
      }
      const expected = interval === 'year' ? plan.price_year : plan.price_month;
      if (Math.abs(amount - expected) > 0.01) {
        log.warn({ userId, planKey, interval, expected, received: amount }, 'venue_subscription_amount_tampering_blocked');
        return c.json({ success: false, error: 'Сумма не соответствует тарифу заведения' }, 400);
      }
      // Ownership: те же требования что у DJ. Webhook раньше брал
      // session.metadata.userId как target — фактически любой мог
      // апгрейднуть любого. Теперь metadata.userId, если передан,
      // обязан совпадать с JWT.
      if (metadata?.userId && String(metadata.userId) !== String(userId)) {
        log.warn({ userId, claimedUserId: metadata.userId }, 'venue_subscription_impersonation_blocked');
        return c.json({ success: false, error: 'Нельзя оплатить чужую подписку' }, 403);
      }
    }
    // dj_mix_publish: те же три защиты что у трека артиста.
    // Mix должен быть owned + moderation_status='approved' (после админ-апрува,
    // ждёт оплаты). Amount = data.payment_amount (штампуется при апруве) или
    // 7000 ₽ дефолт (= MIX_PUBLICATION_PRICE; выровнено с треками 2026-07-07) — клиент
    // не может занизить через DevTools.
    if (type === 'purchase' && metadata?.type === 'dj_mix_publish') {
      const mixId = metadata?.mixId;
      if (!mixId) {
        return c.json({ success: false, error: 'metadata.mixId обязателен для dj_mix_publish' }, 400);
      }
      try {
        const { pool: vpool } = await import('./db-client.tsx');
        const { rows } = await vpool.query(
          `SELECT dj_id, moderation_status, payment_amount FROM dj_mixes WHERE id = $1 LIMIT 1`,
          [String(mixId)]
        );
        if (rows.length === 0) {
          return c.json({ success: false, error: 'Микс не найден' }, 404);
        }
        const mix = rows[0];
        if (mix.dj_id !== userId) {
          log.warn({ userId, mixId, ownerId: mix.dj_id }, 'dj_mix_publish_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужой микс' }, 403);
        }
        if (mix.moderation_status !== 'approved') {
          return c.json({ success: false, error: `Микс должен быть одобрен модератором (текущий статус: ${mix.moderation_status})` }, 400);
        }
        const expected = Number(mix.payment_amount) || 7000;
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, mixId, expected, received: amount }, 'dj_mix_publish_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене публикации микса' }, 400);
        }
      } catch (err) {
        log.error({ err, mixId }, 'dj_mix_publish_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить микс' }, 500);
      }
    }

    // For track_publish the amount MUST match the track's price (per-track or default).
    // Track must be owned by the payer and in 'approved' status (awaiting payment).
    // Blocks: pay-1-ruble exploit, pay-for-someone-elses-track, pay-twice on already-published.
    if (type === 'purchase' && metadata?.type === 'track_publish') {
      const trackId = metadata?.trackId;
      if (!trackId) {
        return c.json({ success: false, error: 'metadata.trackId обязателен для track_publish' }, 400);
      }
      try {
        const { getTrackById } = await import('./db-typed.tsx');
        const track = await getTrackById(String(trackId));
        if (!track) {
          return c.json({ success: false, error: 'Трек не найден' }, 404);
        }
        if (track.user_id !== userId) {
          log.warn({ userId, trackId, ownerId: track.user_id }, 'track_publish_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужой трек' }, 403);
        }
        if (track.moderation_status !== 'approved') {
          return c.json({ success: false, error: `Трек должен быть одобрен модератором (текущий статус: ${track.moderation_status})` }, 400);
        }
        // Native column since migration 062 (resync'd by 088). Webhook handler
        // выше (строки 645-657) тоже пишет в native — читать должны оттуда.
        // Legacy data->>'payment_amount' fallback оставлен только для
        // pre-062 rows которые могли пропустить backfill (никогда не должно
        // встречаться, но не уроним по NaN если встретится).
        const nativeAmount = (track as any)?.payment_amount;
        const legacyAmount = (track as any)?.data?.payment_amount;
        const expected =
          Number(nativeAmount) ||
          Number(legacyAmount) ||
          getPublicationPrice();
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, trackId, expected, received: amount }, 'track_publish_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене публикации' }, 400);
        }
      } catch (err) {
        log.error({ err, trackId }, 'track_publish_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить трек' }, 500);
      }
    }

    // video_publish / concert_publish (+ несуществующие пока video_promote /
    // video_exclusive) — платёжная сессия этих типов рождается ТОЛЬКО
    // сервером в publish-routes.tsx `PUT /orders/:id/pay` (amount=order.price,
    // серверная цена из PRICING; бесплатный тариф оплату вообще минует).
    // Легальный трафик НИКОГДА не шлёт эти type'ы в клиентский
    // /checkout/create-session → любой такой вызов = крафт-байпас (за 1₽
    // опубликовать клип/концерт за 10000/19990/5000/9990). Отклоняем весь
    // класс: цену/владельца проверять не нужно — этих сессий тут быть не должно.
    // (Проверено: publish-routes.tsx:664 amount=order.price, :644 free→skip.)
    if (
      type === 'purchase' &&
      ['video_publish', 'concert_publish', 'video_promote', 'video_exclusive'].includes(metadata?.type)
    ) {
      log.warn({ userId, metadataType: metadata?.type, amount }, 'publish_type_via_create_session_blocked');
      return c.json({ success: false, error: 'Оплата этого типа создаётся сервером (через кабинет публикаций), не напрямую' }, 400);
    }

    // collab_accept — артист принимает collab-оффер от продюсера с
    // price > 0. Деньги фризятся в escrow (см. webhook fulfilment в
    // companion PR'е B; здесь только gate на /create-session).
    //
    // Guard'ы (паттерн как у track_publish):
    //   - metadata.offerId обязателен
    //   - оффер существует
    //   - принимающий == offer.artistId (IDOR-safe: артист принимает
    //     только свои офферы)
    //   - оффер в принимаемом статусе ('pending' | 'discussion')
    //   - payment_status === 'unpaid' (одна сессия на один escrow;
    //     повторное «Принять» в полёте → 409)
    //   - amount === offer.price (anti-tampering)
    if (type === 'purchase' && metadata?.type === 'collab_accept') {
      const offerId = metadata?.offerId;
      if (!offerId) {
        return c.json({ success: false, error: 'metadata.offerId обязателен для collab_accept' }, 400);
      }
      try {
        const { pool: cpool } = await import('./db-client.tsx');
        const { rows } = await cpool.query(
          `SELECT id, artist_id, status, price, payment_status
             FROM collab_offers
            WHERE id = $1
            LIMIT 1`,
          [String(offerId)]
        );
        if (rows.length === 0) {
          return c.json({ success: false, error: 'Оффер не найден' }, 404);
        }
        const offer = rows[0];
        if (offer.artist_id !== userId) {
          log.warn({ userId, offerId, ownerArtistId: offer.artist_id }, 'collab_accept_unauthorized');
          return c.json({ success: false, error: 'Нельзя принять чужой оффер' }, 403);
        }
        if (offer.status !== 'pending' && offer.status !== 'discussion') {
          return c.json({ success: false, error: `Оффер в статусе ${offer.status} — принять нельзя` }, 400);
        }
        if (offer.payment_status !== 'unpaid') {
          return c.json({ success: false, error: `Платёжная сессия уже создана (payment_status=${offer.payment_status})` }, 409);
        }
        const expected = Number(offer.price);
        if (!(expected > 0)) {
          // price=0 offers — не идут через checkout (бесплатная коллаборация
          // принимается напрямую через PUT /collaboration/offers/:id/respond
          // без escrow).
          return c.json({ success: false, error: 'У оффера нет цены — escrow не требуется' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, offerId, expected, received: amount }, 'collab_accept_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене оффера' }, 400);
        }
      } catch (err) {
        log.error({ err, offerId }, 'collab_accept_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить оффер' }, 500);
      }
    }

    // banner_publish — оплата активации рекламной кампании. Сервер
    // пересчитывает цену через calculateBannerPrice (см. banner-pricing.tsx)
    // против тарифа подписки юзера на момент создания (сохранён в
    // banner.data.subscription_tier). Сумма от фронта должна точно
    // совпадать с пересчётом.
    if (type === 'purchase' && metadata?.type === 'banner_publish') {
      const bannerId = metadata?.bannerId;
      if (!bannerId) {
        return c.json({ success: false, error: 'metadata.bannerId обязателен для banner_publish' }, 400);
      }
      try {
        const { getBannerById } = await import('./db-typed.tsx');
        const banner = await getBannerById(String(bannerId));
        if (!banner) return c.json({ success: false, error: 'Кампания не найдена' }, 404);
        if (String(banner.user_id) !== userId) {
          log.warn({ userId, bannerId, ownerId: banner.user_id }, 'banner_publish_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужую кампанию' }, 403);
        }
        if (banner.moderation_status !== 'approved') {
          return c.json({
            success: false,
            error: `Кампания должна быть одобрена модератором (текущий статус: ${banner.moderation_status})`,
          }, 400);
        }
        const expected = Number(banner.price || (banner as any)?.data?.final_price || 0);
        if (expected <= 0) {
          return c.json({ success: false, error: 'Цена кампании не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, bannerId, expected, received: amount }, 'banner_publish_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене кампании' }, 400);
        }
      } catch (err) {
        log.error({ err, bannerId }, 'banner_publish_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить кампанию' }, 500);
      }
    }
    // engineer_order — оплата заказа услуги звукоинженера. Клиент платит
    // ТОЛЬКО за свой собственный заказ в статусе 'accepted' (инженер уже
    // согласовал цену). Сумма берётся с сервера (engineer_orders.price) —
    // занижение через DevTools заблокировано, как у track_publish.
    if (type === 'purchase' && metadata?.type === 'engineer_order') {
      const engOrderId = metadata?.engineerOrderId;
      if (!engOrderId) {
        return c.json({ success: false, error: 'metadata.engineerOrderId обязателен для engineer_order' }, 400);
      }
      try {
        const { pool: vpool } = await import('./db-client.tsx');
        const { rows } = await vpool.query(
          `SELECT client_id, status, price FROM engineer_orders WHERE id = $1 LIMIT 1`,
          [String(engOrderId)],
        );
        if (rows.length === 0) {
          return c.json({ success: false, error: 'Заказ не найден' }, 404);
        }
        const ord = rows[0];
        if (ord.client_id !== userId) {
          log.warn({ userId, engOrderId, ownerId: ord.client_id }, 'engineer_order_pay_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужой заказ' }, 403);
        }
        if (ord.status !== 'accepted') {
          return c.json({ success: false, error: `Заказ должен быть принят инженером (текущий статус: ${ord.status})` }, 400);
        }
        const expected = Number(ord.price) || 0;
        if (expected <= 0) {
          return c.json({ success: false, error: 'Цена заказа не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, engOrderId, expected, received: amount }, 'engineer_order_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене заказа' }, 400);
        }
      } catch (err) {
        log.error({ err, engOrderId }, 'engineer_order_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить заказ' }, 500);
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // Add-only amount-gates: серия покрытий итемов которые раньше шли
    // через webhook БЕЗ amount-проверки и БЕЗ ownership-проверки. Раньше
    // юзер мог оплатить 1₽ и получить любой digital good / production-360
    // / track-test и т.д. Все 6 типов теперь: 1) проверяют что плательщик
    // владеет тем что покупает (или для marketplace — что покупка
    // авторизована), 2) сверяют amount с server-side ценой, 3) при
    // tampering'е возвращают 400 *_amount_tampering_blocked.
    //
    // ВАЖНО: гарды НЕ меняют поведение webhook'а. Webhook остаётся как
    // был — он fulfilled, как только покинули create-session с
    // confirmationUrl. Эти гарды — анти-DevTools заслон НА ЭТАПЕ
    // выпуска сессии: если amount не совпадает, юзер вообще не уйдёт
    // на ЮКассу.
    // ────────────────────────────────────────────────────────────────────

    // booking_payment — оплата депозита (30%) или final (70%) букинга.
    // Только requester может платить за свой booking, в правильном статусе.
    if (type === 'purchase' && metadata?.itemType === 'booking_payment') {
      const bookingId = metadata?.bookingId;
      const paymentType = metadata?.paymentType === 'final' ? 'final' : 'deposit';
      if (!bookingId) {
        return c.json({ success: false, error: 'metadata.bookingId обязателен' }, 400);
      }
      try {
        const { getBooking } = await import('./db.tsx');
        const booking = await getBooking(String(bookingId));
        if (!booking) {
          return c.json({ success: false, error: 'Букинг не найден' }, 404);
        }
        if (booking.requesterId !== userId) {
          log.warn({ userId, bookingId, ownerId: booking.requesterId }, 'booking_payment_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужой букинг' }, 403);
        }
        // depositAmount = 30%, finalAmount = 70% (см. booking-routes.tsx:245-246).
        // Booking сохранён в jsonb-store, depositAmount/finalAmount — native
        // на объекте.
        const expected = paymentType === 'deposit'
          ? Number(booking.depositAmount) || 0
          : Number(booking.finalAmount) || 0;
        if (!(expected > 0)) {
          return c.json({ success: false, error: `Сумма ${paymentType} не определена в букинге` }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, bookingId, paymentType, expected, received: amount }, 'booking_payment_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене букинга' }, 400);
        }
        // Статусная защита: deposit можно платить только из 'accepted',
        // final — только из 'deposit_paid'. Без этого можно «оплатить»
        // второй раз и снова списать.
        const allowedStatus = paymentType === 'deposit' ? 'accepted' : 'deposit_paid';
        if (booking.status !== allowedStatus) {
          return c.json({ success: false, error: `Букинг должен быть в статусе ${allowedStatus} (текущий: ${booking.status})` }, 400);
        }
      } catch (err) {
        log.error({ err, bookingId }, 'booking_payment_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить букинг' }, 500);
      }
    }

    // content_order — продюсер заказывает контент. Owner+price check.
    if (type === 'purchase' && metadata?.itemType === 'content_order') {
      const contentOrderId = metadata?.contentOrderId;
      if (!contentOrderId) {
        return c.json({ success: false, error: 'metadata.contentOrderId обязателен' }, 400);
      }
      try {
        const { pool: cpool } = await import('./db-client.tsx');
        const { rows } = await cpool.query(
          `SELECT venue_id, status, price FROM content_orders WHERE id = $1 LIMIT 1`,
          [String(contentOrderId)],
        );
        if (rows.length === 0) {
          return c.json({ success: false, error: 'Заказ контента не найден' }, 404);
        }
        const ord = rows[0];
        if (ord.venue_id !== userId) {
          log.warn({ userId, contentOrderId, ownerId: ord.venue_id }, 'content_order_pay_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужой заказ' }, 403);
        }
        if (ord.status !== 'pending_payment' && ord.status !== 'draft') {
          return c.json({ success: false, error: `Заказ в статусе ${ord.status} — оплата невозможна` }, 400);
        }
        const expected = Number(ord.price) || 0;
        if (!(expected > 0)) {
          return c.json({ success: false, error: 'Цена заказа не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, contentOrderId, expected, received: amount }, 'content_order_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене заказа' }, 400);
        }
      } catch (err) {
        log.error({ err, contentOrderId }, 'content_order_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить заказ' }, 500);
      }
    }

    // distribution — оплата релиза в DSP'и. price_rub — native колонка.
    if (type === 'purchase' && metadata?.itemType === 'distribution') {
      const distOrderId = metadata?.orderId;
      if (!distOrderId) {
        return c.json({ success: false, error: 'metadata.orderId обязателен для distribution' }, 400);
      }
      try {
        const { pool: dpool } = await import('./db-client.tsx');
        const { rows } = await dpool.query(
          `SELECT user_id, status, price_rub FROM distribution_orders WHERE id = $1 LIMIT 1`,
          [String(distOrderId)],
        );
        if (rows.length === 0) {
          return c.json({ success: false, error: 'Заказ дистрибуции не найден' }, 404);
        }
        const ord = rows[0];
        if (ord.user_id !== userId) {
          log.warn({ userId, distOrderId, ownerId: ord.user_id }, 'distribution_pay_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужой заказ дистрибуции' }, 403);
        }
        if (ord.status !== 'pending') {
          return c.json({ success: false, error: `Заказ в статусе ${ord.status} — оплата невозможна` }, 400);
        }
        const expected = Number(ord.price_rub) || 0;
        if (!(expected > 0)) {
          return c.json({ success: false, error: 'Цена дистрибуции не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, distOrderId, expected, received: amount }, 'distribution_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене дистрибуции' }, 400);
        }
      } catch (err) {
        log.error({ err, distOrderId }, 'distribution_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить заказ дистрибуции' }, 500);
      }
    }

    // venue_radio_subscription — venue оплачивает подписку у radio_station
    // через venue_radio_subscriptions. Ownership: только venue-юзер,
    // указанный в подписке как customer, может её продлевать.
    if (type === 'purchase' && metadata?.itemType === 'venue_radio_subscription') {
      const subId = metadata?.subscriptionId;
      if (!subId) {
        return c.json({ success: false, error: 'metadata.subscriptionId обязателен' }, 400);
      }
      try {
        const { pool: vrpool } = await import('./db-client.tsx');
        const { rows } = await vrpool.query(
          `SELECT venue_id, plan_id, status FROM venue_radio_subscriptions WHERE id = $1 LIMIT 1`,
          [String(subId)],
        );
        if (rows.length === 0) {
          return c.json({ success: false, error: 'Подписка не найдена' }, 404);
        }
        const sub = rows[0];
        if (sub.venue_id !== userId) {
          log.warn({ userId, subId, ownerId: sub.venue_id }, 'venue_radio_subscription_pay_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужую подписку' }, 403);
        }
        // Цена тарифа — из venue_radio_plans.price_month по plan_id
        // (на самой подписке колонки цены нет). Источник тот же, что у
        // venue-radio плана: venue_radio_plans (basic/pro/business).
        const planRes = await vrpool.query(
          `SELECT price_month FROM venue_radio_plans WHERE id = $1 AND is_active = true LIMIT 1`,
          [String(sub.plan_id)],
        );
        if (planRes.rows.length === 0) {
          return c.json({ success: false, error: 'Тариф подписки не найден или неактивен' }, 400);
        }
        const expected = Number(planRes.rows[0].price_month) || 0;
        if (!(expected > 0)) {
          return c.json({ success: false, error: 'Цена подписки не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, subId, expected, received: amount }, 'venue_radio_subscription_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует тарифу' }, 400);
        }
      } catch (err) {
        log.error({ err, subId }, 'venue_radio_subscription_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить подписку' }, 500);
      }
    }

    // digital_purchase — покупка digital good. server-side price из
    // digital_goods.price_rub. Покупатель не обязан быть owner — это
    // marketplace покупка; но amount должен совпадать.
    if (type === 'purchase' && metadata?.type === 'digital_purchase') {
      const goodId = metadata?.goodId;
      if (!goodId) {
        return c.json({ success: false, error: 'metadata.goodId обязателен для digital_purchase' }, 400);
      }
      try {
        const { pool: gpool } = await import('./db-client.tsx');
        const { rows } = await gpool.query(
          `SELECT id, price, status FROM digital_goods WHERE id = $1 LIMIT 1`,
          [String(goodId)],
        );
        if (rows.length === 0) {
          return c.json({ success: false, error: 'Товар не найден' }, 404);
        }
        const good = rows[0];
        if (good.status !== 'active') {
          return c.json({ success: false, error: 'Товар не доступен для покупки' }, 400);
        }
        const expected = Number(good.price) || 0;
        if (!(expected > 0)) {
          return c.json({ success: false, error: 'Цена товара не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, goodId, expected, received: amount }, 'digital_purchase_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене товара' }, 400);
        }
      } catch (err) {
        log.error({ err, goodId }, 'digital_purchase_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить товар' }, 500);
      }
    }

    // beat purchase — server recomputes price from the beat's license tiers;
    // client `amount` must match. Covers the marketplace flow
    // (metadata.type='beat_purchase') AND the legacy simple path
    // (itemType='beat') — both reach beat-fulfilling webhook handlers and both
    // were ungated, so a crafted create-session with amount=1 minted a beat
    // purchase / producer commission for 1 ₽. Uses getBeat (same helper +
    // price expression as marketplace-routes) — no column guessing.
    if (type === 'purchase' && (metadata?.type === 'beat_purchase' || metadata?.itemType === 'beat')) {
      const beatId = metadata?.beatId;
      if (!beatId) {
        return c.json({ success: false, error: 'metadata.beatId обязателен для покупки бита' }, 400);
      }
      try {
        const { getBeat } = await import('./db.tsx');
        const raw = await getBeat(String(beatId));
        if (!raw) return c.json({ success: false, error: 'Бит не найден' }, 404);
        const beat = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (beat.status !== 'active') {
          return c.json({ success: false, error: 'Бит недоступен для покупки' }, 400);
        }
        const licenseType = metadata?.licenseType || 'basic';
        const expected = Number(beat.licenseTypes?.[licenseType] ?? beat.price) || 0;
        if (!(expected > 0)) {
          return c.json({ success: false, error: 'Цена бита не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, beatId, licenseType, expected, received: amount }, 'beat_purchase_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене бита' }, 400);
        }
      } catch (err) {
        log.error({ err, beatId }, 'beat_purchase_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить бит' }, 500);
      }
    }

    // digital_good legacy simple path (itemType='digital_good') — same price
    // source as digital_purchase (digital_goods.price), keyed on metadata.goodId.
    // The full digital_purchase gate above doesn't fire for the itemType variant,
    // leaving it ungated.
    if (type === 'purchase' && metadata?.itemType === 'digital_good') {
      const goodId = metadata?.goodId;
      if (!goodId) {
        return c.json({ success: false, error: 'metadata.goodId обязателен для digital_good' }, 400);
      }
      try {
        const { pool: dgPool } = await import('./db-client.tsx');
        const { rows } = await dgPool.query(
          `SELECT id, price, status FROM digital_goods WHERE id = $1 LIMIT 1`,
          [String(goodId)],
        );
        if (rows.length === 0) return c.json({ success: false, error: 'Товар не найден' }, 404);
        if (rows[0].status !== 'active') return c.json({ success: false, error: 'Товар не доступен для покупки' }, 400);
        const expected = Number(rows[0].price) || 0;
        if (!(expected > 0)) return c.json({ success: false, error: 'Цена товара не определена' }, 400);
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, goodId, expected, received: amount }, 'digital_good_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене товара' }, 400);
        }
      } catch (err) {
        log.error({ err, goodId }, 'digital_good_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить товар' }, 500);
      }
    }

    // production_360_payment — Production 360 заказ.
    if (type === 'purchase' && metadata?.type === 'production_360_payment') {
      const orderId = metadata?.orderId;
      if (!orderId) {
        return c.json({ success: false, error: 'metadata.orderId обязателен' }, 400);
      }
      try {
        const { pool: ppool } = await import('./db-client.tsx');
        const { rows } = await ppool.query(
          `SELECT client_id, price, status FROM production_360_orders WHERE id = $1 LIMIT 1`,
          [String(orderId)],
        );
        if (rows.length === 0) {
          return c.json({ success: false, error: 'Заказ Production 360 не найден' }, 404);
        }
        const ord = rows[0];
        if (ord.client_id !== userId) {
          log.warn({ userId, orderId, ownerId: ord.client_id }, 'production_360_pay_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужой заказ' }, 403);
        }
        if (ord.status !== 'pending_payment') {
          return c.json({ success: false, error: `Заказ в статусе ${ord.status} — оплата невозможна` }, 400);
        }
        const expected = Number(ord.price) || 0;
        if (!(expected > 0)) {
          return c.json({ success: false, error: 'Цена заказа не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, orderId, expected, received: amount }, 'production_360_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене заказа' }, 400);
        }
      } catch (err) {
        log.error({ err, orderId }, 'production_360_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить заказ' }, 500);
      }
    }

    // ── radio_campaign — venue оплачивает рекламную кампанию на радио.
    // Canonical price = venue_ad_campaigns.budget. С 2026-07-03 budget
    // считается СЕРВЕРОМ в POST /radio-campaigns: SUM(radio_ad_slots.price
    // выбранных слотов станции) × durationDays — body.budget игнорируется.
    // Этот gate сверяет оплату с той серверной цифрой (полная цепочка:
    // слоты станции → серверный бюджет → amount-gate → webhook 10%/90%).
    //
    // Guards (паттерн как у pitching_bundle, track_test_promote):
    //   - metadata.campaignId обязателен
    //   - campaign существует (404 иначе)
    //   - campaign.venueId === venue profile id у userId (IDOR-safe:
    //     платить можно только за свою campaign)
    //   - campaign.status === 'pending' (нельзя дважды оплатить)
    //   - amount === campaign.budget ± 0.01 (anti-tampering)
    if (type === 'purchase' && metadata?.itemType === 'radio_campaign') {
      const campaignId = metadata?.campaignId;
      if (!campaignId) {
        return c.json({ success: false, error: 'metadata.campaignId обязателен для radio_campaign' }, 400);
      }
      try {
        const { getVenueAdCampaign, getVenueProfile: rcGetVenue } = await import('./db.tsx');
        const campaign = await getVenueAdCampaign(String(campaignId));
        if (!campaign) {
          return c.json({ success: false, error: 'Кампания не найдена' }, 404);
        }
        const venueProfile = await rcGetVenue(userId);
        const venueProfileId = (venueProfile as any)?.id;
        if (!venueProfileId || campaign.venueId !== venueProfileId) {
          log.warn({ userId, campaignId, campaignVenueId: campaign.venueId, venueProfileId }, 'radio_campaign_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужую кампанию' }, 403);
        }
        if (campaign.status !== 'pending') {
          return c.json({ success: false, error: `Кампания в статусе ${campaign.status} — оплатить нельзя` }, 409);
        }
        const expected = Number(campaign.budget);
        if (!(expected > 0)) {
          return c.json({ success: false, error: 'Бюджет кампании не определён' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, campaignId, expected, received: amount }, 'radio_campaign_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует бюджету кампании' }, 400);
        }
      } catch (err) {
        log.error({ err, campaignId }, 'radio_campaign_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить кампанию' }, 500);
      }
    }

    // ── pitching_bundle — артист оплачивает пакет питчинга (influencers +
    // media + playlists). Canonical price = SUM(pitching_submissions.price_rub)
    // у submissions с этим payment_session_id. POST /pitching/submit делает
    // server-side calc через applySubscriptionDiscount (pitching-routes.tsx
    // :726, итог в data.amount/total) и кладёт finalPrice в каждую строку.
    //
    // Vector: артист открывает DevTools, подменяет amount=1₽; webhook
    // flip'ит submissions в 'pending' без amount-check; платформа теряет
    // 15000₽–30000₽ за каждый bundle (BLOCKER C класс, тот же что мы
    // закрыли для track_publish, dj_mix_publish, beat_purchase, track_test_*).
    //
    // Guards:
    //   - submission_ids обязателен и парсится из CSV-строки в metadata
    //   - все submissions существуют + принадлежат userId (IDOR-safe)
    //   - все в status='pending_payment' (повторная оплата того же bundle → 409)
    //   - SUM(price_rub) === amount (tampering-gate)
    if (type === 'purchase' && metadata?.itemType === 'pitching_bundle') {
      const submissionIdsRaw = metadata?.submission_ids;
      if (!submissionIdsRaw) {
        return c.json({ success: false, error: 'metadata.submission_ids обязателен для pitching_bundle' }, 400);
      }
      const submissionIds = String(submissionIdsRaw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (submissionIds.length === 0) {
        return c.json({ success: false, error: 'submission_ids пуст' }, 400);
      }
      try {
        const { pool: pp } = await import('./db-client.tsx');
        const { rows } = await pp.query(
          `SELECT id, user_id, status, price_rub
             FROM pitching_submissions
            WHERE id = ANY($1)`,
          [submissionIds]
        );
        if (rows.length !== submissionIds.length) {
          return c.json({ success: false, error: 'Часть submissions не найдена' }, 404);
        }
        const alienSubmission = rows.find((r: any) => r.user_id !== userId);
        if (alienSubmission) {
          log.warn({ userId, submissionId: alienSubmission.id, ownerId: alienSubmission.user_id }, 'pitching_bundle_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужой питчинг' }, 403);
        }
        const notPending = rows.find((r: any) => r.status !== 'pending_payment');
        if (notPending) {
          return c.json({ success: false, error: `Submission ${notPending.id} уже в статусе ${notPending.status}` }, 409);
        }
        const expected = rows.reduce((s: number, r: any) => s + Number(r.price_rub || 0), 0);
        if (!(expected > 0)) {
          return c.json({ success: false, error: 'Серверная цена bundle не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, submissionIds, expected, received: amount }, 'pitching_bundle_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене питчинга' }, 400);
        }
      } catch (err) {
        log.error({ err, submissionIds }, 'pitching_bundle_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить bundle' }, 500);
      }
    }

    // ── track_test_promote — артист оплачивает продвижение трека в секцию
    // «Протестировано экспертами» на 14 дней (3000 ₽). Создание сессии
    // делает админ через POST /track-test/pipeline/promoteToNovelty;
    // артист переходит по payment-link из in-app notification. Этот
    // gate защищает от tampering (артист подменяет amount на 1 ₽) и от
    // прямого create-session с поддельной metadata.requestId.
    if (type === 'purchase' && metadata?.type === 'track_test_promote') {
      const reqId = metadata?.requestId;
      if (!reqId) {
        return c.json({ success: false, error: 'metadata.requestId обязателен для track_test_promote' }, 400);
      }
      try {
        const { trackTestRequestsStore } = await import('./db.tsx');
        const request: any = await trackTestRequestsStore.get(String(reqId));
        if (!request) {
          return c.json({ success: false, error: 'Заявка не найдена' }, 404);
        }
        if (request.user_id !== userId) {
          log.warn({ userId, reqId, ownerId: request.user_id }, 'track_test_promote_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужую заявку' }, 403);
        }
        if (request.status !== 'completed') {
          return c.json({ success: false, error: `Заявка не завершена (статус: ${request.status})` }, 400);
        }
        if (request?.data?.pipeline?.promote?.paid_at) {
          return c.json({ success: false, error: 'Продвижение уже оплачено' }, 409);
        }
        const TRACK_TEST_PROMOTE_PRICE = 3000;
        if (Math.abs(amount - TRACK_TEST_PROMOTE_PRICE) > 0.01) {
          log.warn({ userId, reqId, expected: TRACK_TEST_PROMOTE_PRICE, received: amount }, 'track_test_promote_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене продвижения' }, 400);
        }
      } catch (err) {
        log.error({ err, reqId }, 'track_test_promote_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить заявку' }, 500);
      }
    }

    // ── track_test_exclusive — артист оплачивает эксклюзив-pitch A&R
    // (7000 ₽). Идемпотентность по pipeline.exclusive.paid_at;
    // ownership-check симметричный track_test_promote.
    if (type === 'purchase' && metadata?.type === 'track_test_exclusive') {
      const reqId = metadata?.requestId;
      if (!reqId) {
        return c.json({ success: false, error: 'metadata.requestId обязателен для track_test_exclusive' }, 400);
      }
      try {
        const { trackTestRequestsStore } = await import('./db.tsx');
        const request: any = await trackTestRequestsStore.get(String(reqId));
        if (!request) {
          return c.json({ success: false, error: 'Заявка не найдена' }, 404);
        }
        if (request.user_id !== userId) {
          log.warn({ userId, reqId, ownerId: request.user_id }, 'track_test_exclusive_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужую заявку' }, 403);
        }
        if (request.status !== 'completed') {
          return c.json({ success: false, error: `Заявка не завершена (статус: ${request.status})` }, 400);
        }
        if (request?.data?.pipeline?.exclusive?.paid_at) {
          return c.json({ success: false, error: 'Эксклюзив уже оплачен' }, 409);
        }
        const TRACK_TEST_EXCLUSIVE_PRICE = 7000;
        if (Math.abs(amount - TRACK_TEST_EXCLUSIVE_PRICE) > 0.01) {
          log.warn({ userId, reqId, expected: TRACK_TEST_EXCLUSIVE_PRICE, received: amount }, 'track_test_exclusive_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене эксклюзив-pitch' }, 400);
        }
      } catch (err) {
        log.error({ err, reqId }, 'track_test_exclusive_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить заявку' }, 500);
      }
    }

    // track_test — экспертный тест. SQL-таблица track_test_requests.
    if (type === 'purchase' && metadata?.type === 'track_test') {
      const reqId = metadata?.requestId;
      if (!reqId) {
        return c.json({ success: false, error: 'metadata.requestId обязателен' }, 400);
      }
      try {
        const { trackTestRequestsStore } = await import('./db.tsx');
        const req = await trackTestRequestsStore.get(String(reqId));
        if (!req) {
          return c.json({ success: false, error: 'Заявка на тест не найдена' }, 404);
        }
        if (req.user_id !== userId) {
          log.warn({ userId, reqId, ownerId: req.user_id }, 'track_test_pay_unauthorized');
          return c.json({ success: false, error: 'Нельзя оплатить чужую заявку' }, 403);
        }
        if (req.payment_status === 'completed') {
          return c.json({ success: false, error: 'Заявка уже оплачена' }, 409);
        }
        const expected = Number(req.payment_amount) || 0;
        if (!(expected > 0)) {
          return c.json({ success: false, error: 'Цена тестирования не определена' }, 400);
        }
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, reqId, expected, received: amount }, 'track_test_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене тестирования' }, 400);
        }
      } catch (err) {
        log.error({ err, reqId }, 'track_test_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить заявку' }, 500);
      }
    }

    // topup — пополнение коин-баланса. Канон-курс 1 ₽ = COINS_PER_RUBLE (=10)
    // коинов (source-of-truth: coins-routes.tsx COINS_PER_RUBLE). Defensive
    // copy inline — как DJ_PRICES/venue выше. metadata.coinAmount из клиента
    // НЕ доверяем: webhook (см. ~стр.108) кредитует
    // incrementCoinBalanceAtomic(parseInt(metadata.coinAmount)) ДОСЛОВНО, т.е.
    // {type:'topup',amount:1,metadata:{coinAmount:'1000000'}} = 1 ₽ → 1e6 коинов.
    // Пересчитываем серверно из amount и ПЕРЕЗАПИСЫВАЕМ metadata.coinAmount
    // (не ломает UX). metadata — тот же object-reference, что уходит в
    // createPayment и в session ниже, поэтому мутации достаточно.
    if (type === 'topup' && metadata && metadata.coinAmount !== undefined && metadata.coinAmount !== null) {
      const expectedCoins = Math.floor(amount * 10);
      if (String(metadata.coinAmount) !== String(expectedCoins)) {
        log.warn({ userId, amount, claimedCoinAmount: metadata.coinAmount, expectedCoins }, 'topup_coin_amount_tampering_rewritten');
      }
      metadata.coinAmount = String(expectedCoins);
    }

    if (!returnUrl) {
      return c.json({ success: false, error: 'returnUrl обязателен' }, 400);
    }
    // Validate returnUrl — prevent open redirect
    const ALLOWED_ORIGINS = ['https://promo-music.ru', 'https://www.promo-music.ru', 'https://promofm.org'];
    try {
      const returnOrigin = new URL(returnUrl).origin;
      if (!ALLOWED_ORIGINS.includes(returnOrigin)) {
        return c.json({ success: false, error: 'returnUrl must be on promo-music.ru' }, 400);
      }
    } catch {
      return c.json({ success: false, error: 'Invalid returnUrl format' }, 400);
    }

    const orderId = crypto.randomUUID();
    const gw = getGateway(gateway as GatewayName);

    const result = await gw.createPayment({
      amount,
      currency: 'RUB',
      description: description || `Оплата на promo.music`,
      gateway: gateway as GatewayName,
      userId,
      orderId,
      returnUrl,
      metadata: metadata || {},
      savePaymentMethod: savePaymentMethod || false,
      type: type as PaymentType,
    });

    // Save session to SQL (payment_sessions via upsertPaymentSession)
    const session: PaymentSession = {
      orderId,
      userId,
      gateway: gateway as GatewayName,
      gatewayPaymentId: result.sessionId,
      amount,
      currency: 'RUB',
      status: 'pending',
      type: type as PaymentType,
      description: description || `Оплата на promo.music`,
      metadata: metadata || {},
      savePaymentMethod: savePaymentMethod || false,
      confirmationUrl: result.confirmationUrl,
      returnUrl,
      createdAt: new Date().toISOString(),
    };
    await upsertPaymentSession(orderId, session);

    // Lock collab offer into escrow_pending immediately after session created.
    // Prevents a second create-session call from passing payment_status='unpaid'
    // check while the first payment is in-flight (TOCTOU window).
    if (type === 'purchase' && metadata?.type === 'collab_accept' && metadata?.offerId) {
      try {
        const { pool: cpPool } = await import('./db-client.tsx');
        await cpPool.query(
          `UPDATE collab_offers
              SET payment_status   = 'escrow_pending',
                  payment_order_id = $2,
                  updated_at       = NOW()
            WHERE id = $1
              AND payment_status   = 'unpaid'`,
          [String(metadata.offerId), orderId]
        );
      } catch (lockErr) {
        log.error({ err: lockErr, offerId: metadata.offerId, orderId }, 'collab_accept_lock_error');
        // Don't fail — gateway session exists; double-create is extremely
        // unlikely; second webhook would get 0 rowCount on escrow_held
        // transition and log a warning without double-crediting.
      }
    }

    return c.json({
      success: true,
      data: {
        orderId,
        confirmationUrl: result.confirmationUrl,
        gateway,
        status: 'pending',
      },
    });
  } catch (error: any) {
    log.error({ err: error }, 'create_session_error');
    return c.json({ success: false, error: 'Payment session creation failed' }, 500);
  }
});

// ── GET /session/:orderId ──

checkoutRoutes.get('/session/:orderId', requireAuth, async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const session = await getPaymentSession(orderId);

    if (!session) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    const userId = c.get('userId');
    if (session.userId !== userId) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    return c.json({
      success: true,
      data: {
        orderId: session.orderId,
        status: session.status,
        amount: session.amount,
        currency: session.currency,
        type: session.type,
        gateway: session.gateway,
        createdAt: session.createdAt,
        completedAt: session.completedAt,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── GET /methods ──

checkoutRoutes.get('/methods', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const methods = await getPaymentMethods(userId);
    return c.json({ success: true, data: methods || [] });
  } catch (error: any) {
    return c.json({ success: true, data: [] });
  }
});

// ── DELETE /methods/:id ──

checkoutRoutes.delete('/methods/:id', requireAuth, async (c) => {
  try {
    const methodId = c.req.param('id');
    const userId = c.get('userId');
    // Ownership check: verify method belongs to this user
    const methods = await getPaymentMethods(userId);
    const ownsMethod = (methods || []).some((m: any) => m.id === methodId);
    if (!ownsMethod) {
      return c.json({ success: false, error: 'Payment method not found' }, 404);
    }
    await deletePaymentMethod(methodId);
    return c.json({ success: true, message: 'Способ оплаты удалён' });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /webhook/yookassa (NO AUTH) ──

checkoutRoutes.post('/webhook/yookassa', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }
  try {
    log.info({ gateway: 'yookassa', bodyPreview: JSON.stringify(body).slice(0, 300) }, 'webhook_received');

    // ── Payouts: payout.succeeded / payout.canceled ──
    const event: string = body?.event || '';
    if (event.startsWith('payout.')) {
      try {
        const { fetchYooKassaPayout } = await import('./gateway-yookassa-payouts.tsx');
        const { pool: cpool } = await import('./db-client.tsx');
        const payoutId: string = body?.object?.id || '';
        const withdrawalId: string = body?.object?.metadata?.withdrawal_id || '';
        const djId: string = body?.object?.metadata?.dj_id || '';
        if (!payoutId || !djId) {
          log.warn({ event, payoutId, djId }, 'payout_webhook_missing_metadata');
          return c.json({ success: true, message: 'No metadata — ignored' });
        }
        // Подтверждаем статус через API (webhook без подписи)
        const verified = await fetchYooKassaPayout(payoutId);
        if (!verified) {
          log.warn({ payoutId }, 'payout_verification_failed');
          return c.json({ success: false, error: 'Verification failed' }, 400);
        }

        // dj_withdrawals row-per-withdrawal (migration 044). Lookup
        // через partial index по yoo_payout_id (или app_id fallback
        // для legacy/before-yoo-id rows).
        const newStatus = verified.status === 'succeeded' ? 'succeeded'
          : verified.status === 'canceled' ? 'canceled' : null;
        if (!newStatus) {
          log.info({ payoutId, djId, vstatus: verified.status }, 'payout_status_noop');
          return c.json({ success: true, message: `Status ${verified.status} — no update` });
        }
        // UPDATE conditionally — обновляем только если status реально
        // меняется. Atomic: два concurrent webhook'а с одинаковым
        // newStatus — second получит rowCount=0 (status уже = newStatus),
        // не задвоит notification. RETURNING даёт нам данные для SSE.
        const upd = await cpool.query(
          `UPDATE dj_withdrawals
              SET status = $1,
                  paid_at = CASE WHEN $1 = 'succeeded' THEN NOW() ELSE paid_at END,
                  canceled_at = CASE WHEN $1 = 'canceled' THEN NOW() ELSE canceled_at END,
                  updated_at = NOW()
            WHERE dj_id = $2
              AND (yoo_payout_id = $3 OR app_id = $4)
              AND status != $1
           RETURNING app_id, amount, method, destination_label`,
          [newStatus, djId, payoutId, withdrawalId]
        );
        if (upd.rowCount === 0) {
          // Либо not found, либо status уже = newStatus (idempotent retry).
          // Проверяем какой случай:
          const check = await cpool.query(
            `SELECT status FROM dj_withdrawals
              WHERE dj_id = $1 AND (yoo_payout_id = $2 OR app_id = $3)`,
            [djId, payoutId, withdrawalId]
          );
          if (check.rowCount === 0) {
            log.warn({ payoutId, djId }, 'payout_withdrawal_not_found');
          } else {
            log.info({ payoutId, djId, currentStatus: check.rows[0].status }, 'payout_status_idempotent');
          }
          return c.json({ success: true, message: 'No update needed — acknowledged' });
        }
        const w = upd.rows[0];
        log.info({ payoutId, djId, status: newStatus }, 'payout_status_updated');

        // Cross-cabinet push to the DJ (SSE + persisted notification)
        try {
          const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
          await notifyCrossCabinet({
            targetUserId: djId,
            targetRole: 'dj',
            sourceRole: 'admin',
            type: 'payment_update',
            title: newStatus === 'succeeded' ? 'Выплата успешна' : 'Выплата отменена',
            message: newStatus === 'succeeded'
              ? `${w.amount} ₽ → ${w.destination_label || w.method}`
              : `${w.amount} ₽: выплата отклонена ЮКассой`,
            metadata: {
              withdrawalId: w.app_id,
              yooPayoutId: payoutId,
              status: newStatus,
              amount: Number(w.amount),
              method: w.method,
            },
          });
        } catch (notifyErr) {
          log.warn({ err: notifyErr, djId, payoutId }, 'payout_notify_failed');
        }
        return c.json({ success: true });
      } catch (payoutErr) {
        log.error({ err: payoutErr }, 'payout_webhook_failed');
        return c.json({ success: false, error: 'Payout processing failed' }, 500);
      }
    }

    // Log raw webhook
    const webhookOrderId = body?.object?.metadata?.order_id;
    if (webhookOrderId) {
      await (await import('./db-client.tsx')).pool.query(
        `INSERT INTO payment_webhook_logs (id, data, created_at, updated_at)
         VALUES ($1, $2::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [webhookOrderId, JSON.stringify({ body, receivedAt: new Date().toISOString() })]
      );
    }

    const gw = getGateway('yookassa');
    const payload = await gw.verifyWebhook(c.req.raw, body);

    if (!payload) {
      log.warn({ gateway: 'yookassa' }, 'webhook_verification_failed');
      return c.json({ success: false, error: 'Verification failed' }, 400);
    }

    // Find session for existence check (separate from claim so we can distinguish
    // "unknown order — third-party probe" from "already processed").
    const existing = await getPaymentSession(payload.orderId) as PaymentSession | null;
    if (!existing) {
      log.warn({ gateway: 'yookassa', orderId: payload.orderId }, 'webhook_session_not_found');
      // Return 200 OK — webhook is idempotent. Unknown order = either old test row
      // deleted from DB or 3rd-party probe. Avoid YK retry storm by acknowledging.
      return c.json({ success: true, message: 'Session not in DB — acknowledged' });
    }

    // Migration 100: persist resolvedShopId на session — targeted UPDATE
    // только колонки shop_id (и mirror в data->>shop_id), БЕЗ записи
    // полного in-memory session blob. Полная upsertPaymentSession здесь
    // была бы blind-write: переписала бы status/data, потенциально
    // откатывая параллельный claimPaymentSessionForProcessing и
    // пере-открывая double-credit race. Targeted UPDATE по WHERE
    // COALESCE(shop_id,'')<>$1 идемпотентен и orthogonal к claim.
    if (payload.resolvedShopId && (existing as any).shop_id !== payload.resolvedShopId) {
      try {
        await setPaymentSessionShopId(existing.orderId, payload.resolvedShopId);
        (existing as any).shop_id = payload.resolvedShopId;
      } catch (shopErr) {
        log.warn({ err: shopErr, orderId: existing.orderId, resolvedShopId: payload.resolvedShopId }, 'shop_id_persist_failed');
      }
    }

    // Refunds operate on already-succeeded sessions, so they bypass the
    // pending→processing claim that succeeded/canceled events use.
    if (payload.eventType === 'payment.refunded') {
      existing.status = 'refunded';
      existing.completedAt = new Date().toISOString();
      await upsertPaymentSession(existing.orderId, existing);
      log.info({ gateway: 'yookassa', orderId: payload.orderId, amount: payload.amount }, 'payment_refunded');
      return c.json({ success: true, message: 'Refund recorded' });
    }

    // Atomic claim: UPDATE WHERE status='pending' → 'processing'. Returns null if
    // another concurrent webhook delivery already claimed this order, closing the
    // double-credit race window.
    const claimed = await claimPaymentSessionForProcessing(payload.orderId) as PaymentSession | null;
    if (!claimed) {
      log.info({ gateway: 'yookassa', orderId: payload.orderId, status: existing.status }, 'webhook_already_processed');
      return c.json({ success: true, message: 'Already processed' });
    }

    try {
      if (payload.eventType === 'payment.succeeded') {
        await processPaymentSuccess(claimed, payload);
      } else if (payload.eventType === 'payment.canceled') {
        await processPaymentCanceled(claimed, body);
      } else {
        // Unhandled event type after a successful claim — revert so the gateway can retry.
        await revertPaymentSessionToPending(payload.orderId);
      }
    } catch (processErr) {
      // Revert the claim so the gateway's retry can succeed once the underlying issue is fixed.
      await revertPaymentSessionToPending(payload.orderId);
      throw processErr;
    }

    return c.json({ success: true });
  } catch (error: any) {
    log.error({ err: error, gateway: 'yookassa' }, 'webhook_error');
    return c.json({ success: false, error: 'Webhook processing failed' }, 500);
  }
});

// ── POST /webhook/tbank (NO AUTH) ──

checkoutRoutes.post('/webhook/tbank', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }
  try {
    log.info({ gateway: 'tbank', bodyPreview: JSON.stringify(body).slice(0, 300) }, 'webhook_received');

    // Log raw webhook
    if (body.OrderId) {
      await (await import('./db-client.tsx')).pool.query(
        `INSERT INTO payment_webhook_logs (id, data, created_at, updated_at)
         VALUES ($1, $2::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [body.OrderId, JSON.stringify({ body, receivedAt: new Date().toISOString() })]
      );
    }

    const gw = getGateway('tbank');
    const payload = await gw.verifyWebhook(c.req.raw, body);

    if (!payload) {
      log.warn({ gateway: 'tbank' }, 'webhook_verification_failed');
      // T-Bank expects "OK" even on error to stop retries
      return c.text('OK');
    }

    // Find session for existence check.
    const existing = await getPaymentSession(payload.orderId) as PaymentSession | null;
    if (!existing) {
      log.warn({ gateway: 'tbank', orderId: payload.orderId }, 'webhook_session_not_found');
      return c.text('OK');
    }

    // Refunds operate on already-succeeded sessions, so they bypass the pending claim.
    if (payload.eventType === 'payment.refunded') {
      existing.status = 'refunded';
      existing.completedAt = new Date().toISOString();
      await upsertPaymentSession(existing.orderId, existing);
      return c.text('OK');
    }

    // Atomic claim for succeeded/canceled. Closes the double-credit race window.
    const claimed = await claimPaymentSessionForProcessing(payload.orderId) as PaymentSession | null;
    if (!claimed) {
      log.info({ gateway: 'tbank', orderId: payload.orderId, status: existing.status }, 'webhook_already_processed');
      return c.text('OK');
    }

    try {
      if (payload.eventType === 'payment.succeeded') {
        await processPaymentSuccess(claimed, payload);
      } else if (payload.eventType === 'payment.canceled') {
        await processPaymentCanceled(claimed);
      } else {
        await revertPaymentSessionToPending(payload.orderId);
      }
    } catch (processErr) {
      await revertPaymentSessionToPending(payload.orderId);
      throw processErr;
    }

    // T-Bank requires "OK" as response
    return c.text('OK');
  } catch (error: any) {
    log.error({ err: error, gateway: 'tbank' }, 'webhook_error');
    return c.text('OK');
  }
});

// ── POST /webhook/stripe (NO AUTH) ──

checkoutRoutes.post('/webhook/stripe', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }
  try {
    log.info({ gateway: 'stripe', eventType: body.type, bodyPreview: JSON.stringify(body).slice(0, 300) }, 'webhook_received');

    // Log raw webhook
    const orderId = body?.data?.object?.metadata?.order_id;
    if (orderId) {
      await (await import('./db-client.tsx')).pool.query(
        `INSERT INTO payment_webhook_logs (id, data, created_at, updated_at)
         VALUES ($1, $2::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [orderId, JSON.stringify({ body, receivedAt: new Date().toISOString() })]
      );
    }

    const gw = getGateway('stripe');
    const payload = await gw.verifyWebhook(c.req.raw, body);

    if (!payload) {
      log.warn({ gateway: 'stripe' }, 'webhook_verification_failed');
      return c.json({ success: false, error: 'Verification failed' }, 400);
    }

    // Find session for existence check.
    const existing = await getPaymentSession(payload.orderId) as PaymentSession | null;
    if (!existing) {
      log.warn({ gateway: 'stripe', orderId: payload.orderId }, 'webhook_session_not_found');
      // Return 200 OK — webhook is idempotent. Unknown order = either old test row
      // deleted from DB or 3rd-party probe. Avoid retry storm by acknowledging.
      return c.json({ success: true, message: 'Session not in DB — acknowledged' });
    }

    // Refunds bypass the pending claim — they apply to already-succeeded sessions.
    if (payload.eventType === 'payment.refunded') {
      existing.status = 'refunded';
      existing.completedAt = new Date().toISOString();
      await upsertPaymentSession(existing.orderId, existing);
      return c.json({ success: true, received: true });
    }

    // Atomic claim for succeeded/canceled. Closes the double-credit race window.
    const claimed = await claimPaymentSessionForProcessing(payload.orderId) as PaymentSession | null;
    if (!claimed) {
      log.info({ gateway: 'stripe', orderId: payload.orderId, status: existing.status }, 'webhook_already_processed');
      return c.json({ success: true, message: 'Already processed' });
    }

    try {
      if (payload.eventType === 'payment.succeeded') {
        await processPaymentSuccess(claimed, payload);
      } else if (payload.eventType === 'payment.canceled') {
        await processPaymentCanceled(claimed);
      } else {
        await revertPaymentSessionToPending(payload.orderId);
      }
    } catch (processErr) {
      await revertPaymentSessionToPending(payload.orderId);
      throw processErr;
    }

    return c.json({ success: true, received: true });
  } catch (error: any) {
    log.error({ err: error, gateway: 'stripe' }, 'webhook_error');
    return c.json({ success: false, error: 'Webhook processing failed' }, 500);
  }
});

// ── GET /plans — subscription plans ──

checkoutRoutes.get('/plans', async (c) => {
  // Plans aligned with PLANS constant used in processPaymentSuccess
  return c.json({
    success: true,
    data: [
      {
        id: 'spark',
        name: 'Тест-драйв',
        price: 0,
        currency: 'RUB',
        interval: 'month',
        features: ['Базовый профиль', 'Загрузка до 3 треков', 'Публичная страница артиста'],
      },
      {
        id: 'start',
        name: 'Старт',
        price: 8990,
        currency: 'RUB',
        interval: 'month',
        features: ['1 кредит рассылки в месяц', 'Скидка 5% на питчинг и маркетинг', 'Сниженная комиссия донатов (7%)', 'Бонус монет +5%'],
      },
      {
        id: 'pro',
        name: 'Про',
        price: 39990,
        currency: 'RUB',
        interval: 'month',
        features: ['3 кредита рассылки в месяц', 'Скидка 10-15% на питчинг и маркетинг', 'Скидка 10% на тест треков и баннеры', 'Комиссия донатов 5%', 'Бонус монет +15%'],
      },
      {
        id: 'elite',
        name: 'Бизнес',
        price: 149990,
        currency: 'RUB',
        interval: 'month',
        features: ['10 кредитов рассылки в месяц', 'Скидка 15-25% на все услуги', 'Скидка 20% на тест треков', 'Комиссия донатов 3%', 'Бонус монет +25%', 'Приоритетная поддержка'],
      },
    ],
  });
});

export default checkoutRoutes;
