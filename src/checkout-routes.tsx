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
import { claimPaymentSessionForProcessing, createCoinTransactionKv, creditAvailableAtomic, deletePaymentMethod, getCoinBalance, getPaymentBalance, getPaymentMethods, getPaymentSession, incrementCoinBalanceAtomic, revertPaymentSessionToPending, setCoinBalance, upsertPaymentBalance, upsertPaymentMethod, upsertPaymentSession, upsertSubscription, insertPaymentTx } from './db.tsx';
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
const DEFAULT_TRACK_PUBLICATION_PRICE_RUB = 5000;

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
    await creditAvailableAtomic(targetUserId, session.amount);
  }

  // Topup coins — same race-safety treatment.
  if (session.type === 'topup' && session.metadata.coinAmount) {
    const coinAmount = parseInt(session.metadata.coinAmount);
    if (coinAmount > 0) {
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
  // Source-of-truth for VENUE_PLANS lives in
  // src/venue-billing-routes.tsx; this table duplicates the
  // minimum fields the webhook needs to avoid pulling the Hono app
  // graph into this module.
  if (session.type === 'venue_subscription' && session.metadata?.planKey) {
    try {
      const VENUE_PLANS_LOCAL: Record<string, { name: string; price_month: number; price_year: number }> = {
        start:    { name: 'Старт',   price_month: 4990,  price_year: 49900 },
        business: { name: 'Бизнес',  price_month: 9990,  price_year: 99900 },
        network:  { name: 'Сеть',    price_month: 14990, price_year: 149900 },
      };
      const planKey = session.metadata.planKey;
      const plan = VENUE_PLANS_LOCAL[planKey];
      if (plan) {
        const interval = session.metadata.interval === 'year' ? 'year' : 'month';
        const daysToAdd = interval === 'year' ? 365 : 30;
        const userId = session.userId || session.metadata.userId;

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
            id: `bp-${crypto.randomUUID()}`,
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
          await cPool1.query(
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
          log.info({ purchaseId: purchase.id, beatTitle: beat.title }, 'beat_purchase_fulfilled');
          
          // Notify seller via SSE
          if (beat.producerId) {
            try {
              const { emitSSE } = await import('./sse-routes.tsx');
              emitSSE(beat.producerId, { type: 'beat_sold', data: { beatTitle: beat.title, price: session.amount, buyerName: purchase.buyerName } });
            } catch {}
          }
        }
      }
      
      if (itemType === 'digital_good' && session.metadata.goodId) {
        // Fulfill digital good purchase
        const { pool: cPool2 } = await import('./db-client.tsx');
        const purchase = {
          id: `bp-${crypto.randomUUID()}`,
          goodId: session.metadata.goodId,
          goodTitle: session.metadata.goodTitle || 'Digital Good',
          buyerId: session.userId,
          buyerName: session.metadata.buyerName || session.userId,
          sellerId: session.metadata.sellerId || '',
          price: session.amount,
          status: 'completed',
          createdAt: now,
        };
        await cPool2.query(
          `INSERT INTO digital_purchases (id, good_id, buyer_id, amount, data, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
           ON CONFLICT (id) DO NOTHING`,
          // Field is named goodId on the in-memory purchase — previous
          // `purchase.digitalGoodId` was always undefined.
          [purchase.id, purchase.goodId || null, purchase.buyerId || session.userId,
           purchase.price || session.amount,
           JSON.stringify({ ...purchase, paymentOrderId: session.orderId })]
        );
        log.info({ purchaseId: purchase.id }, 'digital_good_fulfilled');
      }
      
      if (itemType === 'radio_campaign' && session.metadata.stationId) {
        // Create radio campaign after payment
        const { venueAdCampaignsStore } = await import('./db.tsx');
        const campaign = {
          id: `bp-${crypto.randomUUID()}`,
          stationId: session.metadata.stationId,
          stationName: session.metadata.stationName || '',
          advertiserId: session.userId,
          packageType: session.metadata.packageType || 'standard',
          budget: session.amount,
          status: 'paid',
          startDate: session.metadata.startDate || new Date().toISOString().split('T')[0],
          endDate: session.metadata.endDate || '',
          targetPlays: parseInt(session.metadata.targetPlays || '0'),
          createdAt: now,
        };
        await venueAdCampaignsStore.set(campaign.id, campaign);
        log.info({ campaignId: campaign.id }, 'radio_campaign_created');
        
        // Notify station owner
        if (session.metadata.stationOwnerId) {
          try {
            const { emitSSE } = await import('./sse-routes.tsx');
            emitSSE(session.metadata.stationOwnerId, { type: 'new_radio_campaign', data: { budget: session.amount, packageType: campaign.packageType } });
          } catch {}
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

      // ─── Fulfill venue_radio_subscription ───
      if (itemType === 'venue_radio_subscription' && session.metadata.subscriptionId) {
        const { pool: vrPool } = await import('./db-client.tsx');
        const subId = session.metadata.subscriptionId;
        // Activate for 30 days; extend if already active
        const r = await vrPool.query(
          `UPDATE venue_radio_subscriptions
           SET status = 'active',
               current_period_start = COALESCE(current_period_start, NOW()),
               current_period_end = COALESCE(current_period_end, NOW()) + INTERVAL '30 days',
               payment_order_id = $1, payment_gateway = $2,
               auto_renew = true, updated_at = NOW()
           WHERE id = $3
           RETURNING venue_id, plan_id, current_period_end`,
          [session.orderId, session.gateway, subId]
        );
        if (r.rows.length > 0) {
          log.info({
            subscriptionId: subId, venueId: r.rows[0].venue_id, planId: r.rows[0].plan_id,
            until: r.rows[0].current_period_end, amount: session.amount,
          }, 'venue_radio_subscription_activated');

          // SSE notify venue
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
      }


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

        // Notify admin about new paid track test
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
      }
    } catch (err) {
      log.error({ err }, 'track_test_fulfillment_error');
    }
  }




  // ─── Fulfill track_publish payment (moderation → paid, awaits admin gate) ───
  // Prior behaviour: webhook flipped moderation_status straight to 'published',
  // dumping the track into Новинки недели the moment money cleared. That
  // bypassed two stages the rest of the codebase was built around:
  //   • 'paid'      — money received, admin gate not yet passed
  //   • 'upcoming'  — admin approved, sitting in «Скоро» for UPCOMING_DAYS
  // (see track-moderation-routes.tsx /approve-paid + /promote-upcoming).
  // Webhook now lands on 'paid' only; admin clicks «Опубликовать» which calls
  // /approve-paid → 'upcoming', then a VPS cron hitting /promote-upcoming
  // promotes expired upcoming → 'published'.
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
      const result = await tpPool.query(
        `UPDATE tracks
            SET moderation_status = 'paid',
                is_paid           = true,
                is_hidden         = false,
                data              = COALESCE(data, '{}'::jsonb)
                                    || jsonb_build_object(
                                         'payment_completed', true,
                                         'payment_amount',   $2::numeric,
                                         'payment_order_id', $3::text,
                                         'payment_gateway',  $4::text,
                                         'paid_at',          $5::text
                                       ),
                updated_at        = $6
          WHERE id = $1
            AND moderation_status = 'approved'
          RETURNING data->>'payment_amount' AS amount, moderation_status`,
        [trackId, session.amount, session.orderId, session.gateway, now, now]
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

  // ─── Fulfill video_publish / concert_publish (publish_orders → paid) ───
  // Pipeline aligned with tracks: payment makes the order 'paid', NOT 'published'.
  // Admin must explicitly publish from the moderation panel after verifying payment.
  if (
    (session.metadata?.type === 'video_publish' || session.metadata?.type === 'concert_publish')
    && session.metadata?.orderId
  ) {
    try {
      const { pool: pubPool } = await import('./db-client.tsx');
      const orderId = String(session.metadata.orderId);
      const row = await pubPool.query(`SELECT data FROM publish_orders WHERE id = $1`, [orderId]);
      if (row.rows.length === 0) {
        log.warn({ orderId }, 'publish_order_not_found_for_fulfillment');
      } else {
        const ord = typeof row.rows[0].data === 'string' ? JSON.parse(row.rows[0].data) : row.rows[0].data;
        ord.status = 'paid';
        ord.paidAt = now;
        ord.paymentMethod = session.gateway;
        ord.paymentSessionId = session.gatewayPaymentId;
        ord.updatedAt = now;
        await pubPool.query(
          `UPDATE publish_orders SET data = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(ord), orderId]
        );
        log.info({ orderId, type: session.metadata.type, amount: session.amount }, 'publish_order_payment_fulfilled');

        // Notify artist payment received + admin that an order awaits publication.
        // createArtistNotification persists to the `notifications` table (drives the
        // unread bell badge) and emits the SSE push. Without this call the artist's
        // UI only shows the new 'paid' status after a manual refresh.
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
        const purchaseId = 'bp_' + Math.random().toString(36).substring(2, 12);

        const purchase = {
          id: purchaseId, beatId, beatTitle: beat.title,
          producerId: beat.producerId, producerName: beat.producer,
          buyerId, buyerName, licenseType, price, commission, producerPayout,
          status: 'completed', paymentOrderId: session.orderId, paymentGateway: session.gateway,
          createdAt: now,
        };

        await cPool3.query(
          `INSERT INTO beat_purchases (id, beat_id, buyer_id, producer_id, amount, license_type, status, data, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [purchaseId, beatId, buyerId, beat.producerId || null, price, licenseType,
           JSON.stringify(purchase)]
        );

        beat.purchases = (beat.purchases || 0) + 1;
        if (licenseType === 'exclusive') beat.status = 'sold';
        await upsertBeat(beatId, JSON.stringify(beat));

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
      }
    } catch (err) {
      log.error({ err, beatId: session.metadata.beatId }, 'beat_purchase_fulfillment_error');
    }
  }

  // ─── Fulfill digital_purchase (Digital Goods Marketplace) ───
  if (session.metadata?.type === 'digital_purchase' && session.metadata?.digitalGoodId) {
    try {
      const { digitalGoodsStore } = await import('./db.tsx');
      const { pool: cPool4 } = await import('./db-client.tsx');
      const { recordPlatformCommission } = await import('./platform-revenue.tsx');
      const goodId = session.metadata.digitalGoodId;
      const buyerId = session.userId;
      const buyerName = session.metadata.buyerName || 'Покупатель';

      const raw = await digitalGoodsStore.get(goodId);
      if (raw) {
        const good = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const price = session.amount;
        const commission = Math.round(price * 0.1);
        const producerPayout = price - commission;
        const purchaseId = 'dgp_' + Math.random().toString(36).substring(2, 12);

        const purchase = {
          id: purchaseId, digitalGoodId: goodId, title: good.title, category: good.category,
          producerId: good.producerId, producerName: good.producer,
          buyerId, buyerName, price, commission, producerPayout,
          status: 'completed', paymentOrderId: session.orderId, paymentGateway: session.gateway,
          createdAt: now,
        };

        await cPool4.query(
          `INSERT INTO digital_purchases (id, good_id, buyer_id, amount, data, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [purchaseId, goodId, buyerId, price, JSON.stringify(purchase)]
        );

        good.sales = (good.sales || 0) + 1;
        await digitalGoodsStore.set(goodId, JSON.stringify(good));

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
      }
    } catch (err) {
      log.error({ err, goodId: session.metadata.digitalGoodId }, 'digital_purchase_fulfillment_error');
    }
  }

  // ─── Fulfill production_360_payment (Production 360 Marketplace) ───
  if (session.metadata?.type === 'production_360_payment' && session.metadata?.productionOrderId) {
    try {
      const { production360OrdersStore } = await import('./db.tsx');
      const productionOrderId = session.metadata.productionOrderId;
      const order: any = await production360OrdersStore.get(productionOrderId);
      if (order && order.status === 'pending_payment') {
        order.status = 'paid';
        order.statusEnteredAt = now;
        order.paidAt = now;
        order.updatedAt = now;
        order.paymentOrderId = session.orderId;
        order.paymentGateway = session.gateway;
        await production360OrdersStore.set(productionOrderId, order);

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

  // ─── Fulfill donation ───
  if (session.type === 'donation' && session.metadata?.donationId) {
    try {
      const { getDonation, createDonation } = await import('./db.tsx');
      const donationId = session.metadata.donationId;
      const artistId = session.metadata.artistId;
      if (artistId && donationId) {
        // Try to load existing donation record
        let donation: any = null;
        try {
          const allDonations = await getDonation(artistId) as any;
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
      }
    } catch (err) {
      log.error({ err }, 'donation_fulfillment_error');
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
    await recordRevenue({
      channel: session.type === 'purchase' ? (session.metadata.itemType || 'purchase') : session.type,
      description: session.description,
      grossAmount: session.amount,
      platformRevenue: session.amount * commissionRate,
      payoutAmount: session.amount * (1 - commissionRate),
      commissionRate,
      payerId: session.userId,
      payerName: session.metadata.payerName || session.userId,
      payeeId: session.metadata.artistId,
      payeeName: session.metadata.artistName,
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
    if (type === 'subscription') {
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
        const expected = Number((track as any)?.data?.payment_amount) || DEFAULT_TRACK_PUBLICATION_PRICE_RUB;
        if (Math.abs(amount - expected) > 0.01) {
          log.warn({ userId, trackId, expected, received: amount }, 'track_publish_amount_tampering_blocked');
          return c.json({ success: false, error: 'Сумма не соответствует цене публикации' }, 400);
        }
      } catch (err) {
        log.error({ err, trackId }, 'track_publish_validation_error');
        return c.json({ success: false, error: 'Не удалось проверить трек' }, 500);
      }
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

    // Save session to KV
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
        const { djWithdrawalsStore } = await import('./db.tsx');
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
        const list: any[] = (await djWithdrawalsStore.get(djId)) || [];
        const idx = list.findIndex((w: any) => w.yooPayoutId === payoutId || w.id === withdrawalId);
        if (idx === -1) {
          log.warn({ payoutId, djId }, 'payout_withdrawal_not_found');
          return c.json({ success: true, message: 'Withdrawal not found — acknowledged' });
        }
        const newStatus = verified.status === 'succeeded' ? 'succeeded'
          : verified.status === 'canceled' ? 'canceled' : list[idx].status;
        const prevStatus = list[idx].status;
        list[idx] = {
          ...list[idx],
          status: newStatus,
          ...(newStatus === 'succeeded' ? { paidAt: new Date().toISOString() } : {}),
          ...(newStatus === 'canceled' ? { canceledAt: new Date().toISOString() } : {}),
          updatedAt: new Date().toISOString(),
        };
        await djWithdrawalsStore.set(djId, list);
        log.info({ payoutId, djId, status: newStatus }, 'payout_status_updated');

        // Cross-cabinet push to the DJ (SSE + persisted notification)
        if (newStatus !== prevStatus) {
          try {
            const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
            const w = list[idx];
            await notifyCrossCabinet({
              targetUserId: djId,
              targetRole: 'dj',
              sourceRole: 'admin',
              type: 'payment_update',
              title: newStatus === 'succeeded' ? 'Выплата успешна' : 'Выплата отменена',
              message: newStatus === 'succeeded'
                ? `${w.amount} ₽ → ${w.destinationLabel || w.method}`
                : `${w.amount} ₽: выплата отклонена ЮКассой`,
              metadata: {
                withdrawalId: w.id,
                yooPayoutId: payoutId,
                status: newStatus,
                amount: w.amount,
                method: w.method,
              },
            });
          } catch (notifyErr) {
            log.warn({ err: notifyErr, djId, payoutId }, 'payout_notify_failed');
          }
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
