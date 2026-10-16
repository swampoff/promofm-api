/**
 * VENUE BILLING ROUTES — subscribe / save-card / charge-recurring /
 * cancel for VENUE accounts (separate from artist subscriptions).
 *
 * Mounted at /server/api/venue-billing. Sister endpoints to
 * /server/subscriptions/* which are for ARTIST tiers (spark / start /
 * pro / elite). Venues have a different plan ladder (Старт / Бизнес /
 * Сеть / Enterprise) and their state lives in venue_profiles.data
 * jsonb rather than the artist `subscriptions` SQL table — so they
 * get their own surface.
 *
 * Scope: VENUE only. The legacy /server/api/venue-radio (existing
 * partner-radio subscription) and /server/subscriptions (artist
 * tiers) are NOT touched.
 *
 * State stored in venue_profiles.data:
 *   subscriptionStatus       'trial' | 'active' | 'expired' | 'cancelled'
 *   subscriptionPlan         'start' | 'business' | 'network' | 'enterprise'
 *   subscriptionExpiresAt    ISO date (when the current paid period ends)
 *   subscriptionInterval     'month' | 'year'
 *   subscriptionPriceRub     last paid price (audit)
 *   subscriptionUpdatedAt    ISO date
 *
 * Saved payment method: stored in the existing `payment_methods` SQL
 * table (the same one artist subscriptions use). One method per
 * user is the working model; multiple methods is a future feature.
 *
 * Endpoints:
 *   POST   /subscribe                — create YooKassa session for
 *                                       chosen tier+interval. Sets
 *                                       savePaymentMethod=true so
 *                                       the gateway returns a
 *                                       reusable token for the
 *                                       recurring cron.
 *   POST   /cancel                   — flip status='cancelled' but
 *                                       leave subscriptionExpiresAt
 *                                       intact — stream keeps
 *                                       playing until end of period.
 *   GET    /me                       — current venue subscription
 *                                       state + saved payment
 *                                       method info (last4, brand)
 *                                       for cabinet display.
 *   POST   /cron/charge-recurring    — CRON_SECRET-protected.
 *                                       Sister of /server/subscriptions/
 *                                       charge-recurring but for
 *                                       venue_profiles only.
 *
 * Webhook activation: handled in checkout-routes.tsx by the
 * `metadata.type === 'venue_subscription'` branch (added in this PR).
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { ensureVenueProfile, getVenueProfile as dbGetVenueProfile, upsertVenueProfile, getPaymentMethods, upsertPaymentSession, getPaymentSession, insertPaymentTx } from './db.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { safeErrorMessage } from './security.tsx';
import { emitSSE } from './sse-routes.tsx';

const app = new Hono();

// ──────────────────────────────────────────────────────────────────
// VENUE_PLANS — money source of truth. Реэкспорт из shared-модуля
// venue-plans-constants.tsx (PR 2026-06-10): раньше таблица была
// продублирована тут + в venue-billing-helpers + в checkout-routes,
// drift-риск как у DJ_PLANS (PR #221). Реэкспорт держит старый
// импорт-контракт (другие места импортируют VENUE_PLANS отсюда)
// при едином источнике.
//
// Mirrors the frontend `venue/constants/subscription-plans.ts` so
// the API can validate amount-tampering and pick the right amount
// at recurring-charge time. Frontend правят ОТДЕЛЬНО — это
// бэкенд-зеркало; при расхождении amount-check на /subscribe
// поймает (берёт цену отсюда, не из body).
//
// enterprise has no fixed price — manual contracts, not subscribable.
// ──────────────────────────────────────────────────────────────────

import { VENUE_PLANS_CORE } from './venue-plans-constants.tsx';

export const VENUE_PLANS = VENUE_PLANS_CORE;

function parse(data: any): any {
  if (!data) return null;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data;
}

async function loadVenueProfile(userId: string): Promise<any | null> {
  // ensure: строка создаётся и без визита в «Профиль» (раньше здесь был 404).
  const data = await ensureVenueProfile(userId);
  return parse(data);
}

async function getUserId(c: any): Promise<string> {
  return (c as any).get('userId') || 'anonymous';
}

// ──────────────────────────────────────────────────────────────────
// POST /subscribe — create YooKassa session, save payment method
// ──────────────────────────────────────────────────────────────────
app.post('/subscribe', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json().catch(() => ({}));
    const tier = String(body.tier || '').toLowerCase();
    const interval = body.interval === 'year' ? 'year' : 'month';

    const plan = VENUE_PLANS[tier];
    if (!plan) {
      return c.json({ success: false, error: `Unknown tier "${tier}". Allowed: ${Object.keys(VENUE_PLANS).join(', ')}` }, 400);
    }
    const price = interval === 'year' ? plan.price_year : plan.price_month;
    if (!price || price <= 0) {
      return c.json({ success: false, error: 'Tier requires custom pricing – contact sales' }, 400);
    }

    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found – register the venue first' }, 404);
    }

    const { getGateway } = await import('./payment-gateway.tsx');
    const gateway = getGateway('yookassa');
    const orderId = crypto.randomUUID();
    const returnUrl = `https://promo-music.ru/venue/subscription?payment=success&tier=${tier}`;
    const desc = `Подписка «${plan.name}» (${interval === 'year' ? 'год' : 'мес'}) – ${profile.venueName || 'заведение'}`;

    const result = await gateway.createPayment({
      orderId,
      amount: price,
      currency: 'RUB',
      description: desc,
      returnUrl,
      userId,
      gateway: 'yookassa',
      type: 'venue_subscription',
      // CRITICAL: tells YooKassa to return a reusable
      // payment_method_id so the recurring cron can charge later
      // without redirecting the user back to the gateway.
      savePaymentMethod: true,
      metadata: {
        type: 'venue_subscription',          // ← webhook discriminator
        planKey: tier,
        interval,
        userId,
        venueId: profile.id,
      },
    });

    await upsertPaymentSession(orderId, {
      orderId,
      userId,
      gateway: 'yookassa',
      gatewayPaymentId: result.sessionId,
      amount: price,
      currency: 'RUB',
      status: 'pending',
      type: 'venue_subscription',
      description: desc,
      metadata: { planKey: tier, interval, userId, venueId: profile.id },
      savePaymentMethod: true,
      confirmationUrl: result.confirmationUrl,
      returnUrl,
      createdAt: new Date().toISOString(),
    });

    return c.json({
      success: true,
      data: {
        orderId,
        confirmationUrl: result.confirmationUrl,
        tier,
        price,
        interval,
        status: 'pending_payment',
      },
    });
  } catch (error: any) {
    console.error('POST /venue-billing/subscribe:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /cancel — flip status to 'cancelled' (stream runs to period end)
// ──────────────────────────────────────────────────────────────────
/**
 * POST /attach-card: привязка карты для старта бесплатного пробного периода
 * (TRIAL_PERIOD_DAYS из venue-trial.tsx: 7 дней с 16.10.2026, раньше 14).
 *
 * Владелец 2026-08-07: «заведение обязано привязывать карту». Раньше триал
 * выдавался просто статусом, карты не было, и крон trial_auto_charge не мог
 * ничего списать по окончании.
 *
 * Механика: проверочный платёж 1 ₽ с savePaymentMethod. После успеха вебхук
 * сохраняет payment_method_id, включает триал на 7 дней и ВОЗВРАЩАЕТ рубль.
 * По окончании триала крон venue-trial списывает первый месяц с этой карты
 * (venue-billing-helpers.tsx: tryAutoChargeAtTrialEnd).
 */
app.post('/attach-card', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Профиль заведения не найден' }, 404);
    }

    const { getGateway } = await import('./payment-gateway.tsx');
    const gateway = getGateway('yookassa');
    const orderId = crypto.randomUUID();

    const result = await gateway.createPayment({
      orderId,
      amount: 1,
      currency: 'RUB',
      description: `Привязка карты для пробного периода – ${profile.venueName || 'заведение'} (1 ₽ вернётся автоматически)`,
      returnUrl: 'https://promo-music.ru/venue/subscription?card=attached',
      userId,
      gateway: 'yookassa',
      type: 'venue_subscription',
      savePaymentMethod: true,
      metadata: {
        type: 'venue_card_attach',
        userId,
        venueId: String(profile.id || ''),
      },
    });

    return c.json({
      success: true,
      confirmationUrl: result.confirmationUrl,
      orderId,
      note: 'Списываем 1 ₽ для проверки карты и сразу возвращаем. Пробный период включится после подтверждения.',
    });
  } catch (error: any) {
    console.error('[venue-billing] attach-card failed:', error?.message || error);
    return c.json({ success: false, error: 'Не удалось начать привязку карты' }, 500);
  }
});

app.post('/cancel', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const nextData = {
      ...(profile.data || profile),
      subscriptionStatus: 'cancelled',
      subscriptionUpdatedAt: new Date().toISOString(),
      // Intentionally keep subscriptionExpiresAt — the stream
      // continues until the paid period ends, then the next cron
      // run flips status='expired' + revokes the bearer token.
      updatedAt: new Date().toISOString(),
    };

    await pool.query(
      `UPDATE venue_profiles SET data = $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
      [JSON.stringify(nextData), userId]
    );

    emitSSE(userId, {
      type: 'venue_subscription_cancelled',
      data: { expiresAt: nextData.subscriptionExpiresAt || null },
    });

    return c.json({
      success: true,
      message: 'Подписка отменена. Эфир будет работать до конца оплаченного периода.',
      subscriptionStatus: 'cancelled',
      subscriptionExpiresAt: nextData.subscriptionExpiresAt || null,
    });
  } catch (error: any) {
    console.error('POST /venue-billing/cancel:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /me — current state + saved payment method for cabinet display
// ──────────────────────────────────────────────────────────────────
app.get('/me', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, subscription: null, savedCard: null });
    }

    const data = profile.data || profile;
    const subscription = {
      status:      data.subscriptionStatus      || 'trial',
      plan:        data.subscriptionPlan        || 'business',  // trial default
      expiresAt:   data.subscriptionExpiresAt   || data.trial_expires_at || null,
      interval:    data.subscriptionInterval    || null,
      priceRub:    data.subscriptionPriceRub    || null,
      updatedAt:   data.subscriptionUpdatedAt   || null,
      planLabel:   VENUE_PLANS[data.subscriptionPlan]?.name || null,
    };

    // Surface a tiny saved-card summary (last4, brand) without
    // exposing the full PCI surface. payment_methods rows from the
    // same store the artist cron uses.
    const methods = await getPaymentMethods(userId).catch(() => null) as any;
    const card = Array.isArray(methods?.data) ? methods.data[0]
                : Array.isArray(methods)        ? methods[0]
                : methods?.savedMethods?.[0]    || null;
    const savedCard = card ? {
      last4:    card.last4 || card.card?.last4 || null,
      brand:    card.brand || card.card?.brand || null,
      gateway:  card.gateway || 'yookassa',
      gatewayMethodId: card.gatewayMethodId || card.id || null,
    } : null;

    return c.json({ success: true, subscription, savedCard });
  } catch (error: any) {
    console.error('GET /venue-billing/me:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /cron/charge-recurring — CRON_SECRET, mirrors artist cron
// ──────────────────────────────────────────────────────────────────
//
// Runs daily. Finds venues with subscriptionExpiresAt within 3 days
// or already past + status='active'/'cancelled' and either:
//  - Charges the saved card → extends period by 30/365 days.
//  - No card and past expiry → flips to 'expired' + revokes bearer
//    tokens for their venue_station_streams (APK gets 401 next poll).
//
// Cancelled status is treated like active for the charge — we honour
// the paid period. After it expires, no new charge attempt (status
// stays cancelled→expired, no auto-renewal).
//
app.post('/cron/charge-recurring', async (c) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[venue-billing] CRON_SECRET env var not set');
    return c.json({ success: false, error: 'Server misconfiguration' }, 500);
  }
  const provided = c.req.header('X-Cron-Secret') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (provided !== expected) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const now = new Date();
  const soonMs = now.getTime() + 3 * 24 * 60 * 60 * 1000;
  const results: any[] = [];
  let charged = 0, expired = 0, skipped = 0;

  try {
    // Find venues whose subscription is past or within 3 days of expiry.
    // We process trial expiries via the existing venue-trial cron;
    // here we only deal with already-paid venues (status=active/cancelled).
    const q = await pool.query(
      `SELECT vp.user_id,
              vp.data,
              u.email AS email
         FROM venue_profiles vp
         LEFT JOIN users u ON u.id::text = vp.user_id
        WHERE vp.data->>'subscriptionStatus' IN ('active', 'cancelled')
          AND vp.data->>'subscriptionExpiresAt' IS NOT NULL
          AND (vp.data->>'subscriptionExpiresAt')::timestamptz <= $1::timestamptz
        LIMIT 500`,
      [new Date(soonMs).toISOString()]
    );

    for (const row of q.rows as any[]) {
      try {
        const data = row.data || {};
        const expiresAt = new Date(data.subscriptionExpiresAt);
        const tier = data.subscriptionPlan;
        const interval = data.subscriptionInterval === 'year' ? 'year' : 'month';
        const plan = VENUE_PLANS[tier];

        if (!plan) {
          skipped++;
          results.push({ userId: row.user_id, action: 'skipped', reason: 'unknown_plan', tier });
          continue;
        }

        const isCancelled = data.subscriptionStatus === 'cancelled';
        const methods = await getPaymentMethods(row.user_id).catch(() => null) as any;
        const card = Array.isArray(methods?.data) ? methods.data[0]
                    : Array.isArray(methods)        ? methods[0]
                    : methods?.savedMethods?.[0]    || null;

        // No saved card OR cancelled → if past expiry, mark expired
        // and revoke bearer tokens so the APK stops streaming.
        if (!card || isCancelled) {
          if (expiresAt.getTime() <= now.getTime()) {
            await markVenueExpired(row.user_id, row.email, isCancelled ? 'cancelled_period_ended' : 'no_saved_card');
            expired++;
            results.push({ userId: row.user_id, action: 'expired', reason: isCancelled ? 'cancelled' : 'no_card' });
          } else {
            skipped++;
            results.push({ userId: row.user_id, action: 'skipped', reason: isCancelled ? 'cancelled_awaiting_period_end' : 'no_card_but_within_grace' });
          }
          continue;
        }

        // Card present + active → charge it.
        const amount = interval === 'year' ? plan.price_year : plan.price_month;
        // Day-stamp в orderId (2026-07-02): orderId = Idempotence-Key у YooKassa.
        // Чисто-детерминированный ключ по expiresAt после ОТКАЗА карты возвращал
        // тот же canceled-платёж на все ретраи в окне ключа — починивший карту
        // подписчик не мог продлиться. День в ключе: crash-safe внутри суток,
        // свежий ключ на следующий прогон.
        const dayStamp = now.toISOString().slice(0, 10);
        const orderId = `venue-renew-${row.user_id}-${expiresAt.getTime()}-${dayStamp}`;
        const prior = await getPaymentSession(orderId) as any;
        if (prior && (prior.status === 'succeeded' || prior.status === 'processing')) {
          skipped++;
          results.push({ userId: row.user_id, action: 'skipped', reason: `renewal_already_${prior.status}`, orderId });
          continue;
        }

        const { getGateway } = await import('./payment-gateway.tsx');
        const gateway = getGateway(card.gateway || 'yookassa');
        const chargeResult = await gateway.chargeRecurring({
          amount,
          currency: 'RUB',
          paymentMethodId: card.gatewayMethodId || card.id,
          orderId,
          description: `Продление «${plan.name}» (${interval === 'year' ? 'год' : 'мес'})`,
          userId: row.user_id,
        });

        // Реальный исход списания (YooKassa off-session capture:true — синхронно).
        // 2026-07-02: раньше статус игнорировался ПОЛНОСТЬЮ — отклонённая карта
        // всё равно продлевала venue на месяц и писала фантомную выручку (та же
        // бага, что чинили в артистском рекурренте). ВАЖНО: planKey из metadata
        // УБРАН — иначе webhook-ветка venue_subscription (checkout-routes, гейт
        // по metadata.planKey) продлевала бы период ВТОРОЙ раз на каждый
        // успешный платёж (30 дней оплачено → 60 выдано). Единственная точка
        // фулфилмента рекуррента — этот cron, как у артистов.
        const chargeStatus = chargeResult.status; // 'succeeded' | 'canceled' | 'pending'

        await upsertPaymentSession(orderId, {
          orderId,
          userId: row.user_id,
          gateway: card.gateway || 'yookassa',
          gatewayPaymentId: chargeResult.sessionId,
          amount, currency: 'RUB',
          status: chargeStatus === 'succeeded' ? 'succeeded' : chargeStatus === 'canceled' ? 'canceled' : 'pending',
          type: 'venue_subscription',
          description: `Продление «${plan.name}»`,
          metadata: { tier, interval, recurring: true, userId: row.user_id, venueId: data.id },
          savePaymentMethod: false,
          confirmationUrl: '',
          returnUrl: 'https://promo-music.ru/venue',
          createdAt: now.toISOString(),
        });

        if (chargeStatus === 'canceled') {
          // отказ карты — в catch ниже (там mark-expired при истёкшем периоде)
          throw new Error('venue recurring charge declined by gateway (canceled)');
        }
        if (chargeStatus !== 'succeeded') {
          // 'pending' (редкий async) — не продлеваем, следующий прогон добьёт
          skipped++;
          results.push({ userId: row.user_id, action: 'charge_pending', orderId });
          continue;
        }

        // Extend period in profile (paid in advance — extend from
        // current expires_at, not from now, so customers who pay
        // 25-29 days into the cycle aren't shorted).
        const daysToAdd = interval === 'year' ? 365 : 30;
        const newExpiry = new Date(Math.max(expiresAt.getTime(), now.getTime()) + daysToAdd * 24 * 60 * 60 * 1000);
        const nextData = {
          ...data,
          subscriptionExpiresAt: newExpiry.toISOString(),
          subscriptionStatus: 'active',
          subscriptionUpdatedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        await pool.query(
          `UPDATE venue_profiles SET data = $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
          [JSON.stringify(nextData), row.user_id]
        );

        await insertPaymentTx({
          id: `tx-venue-recur-${crypto.randomUUID()}`,
          userId: row.user_id,
          orderId,
          type: 'expense',
          category: 'venue_subscription',
          amount, currency: 'RUB',
          gateway: card.gateway || 'yookassa',
          description: `Автопродление «${plan.name}»`,
          metadata: { tier, interval, recurring: true, orderId },
          status: 'pending',
          createdAt: now.toISOString(),
        });

        try {
          await recordRevenue({
            channel: 'venue_subscription',
            description: `Автопродление «${plan.name}»: venue ${row.user_id}`,
            grossAmount: amount, platformRevenue: amount, payoutAmount: 0,
            commissionRate: 1.0, payerId: row.user_id, payerName: row.user_id,
            metadata: { tier, interval, recurring: true, orderId },
          });
        } catch (e) {
          console.warn('[venue-billing] recordRevenue warning:', e);
        }

        charged++;
        results.push({ userId: row.user_id, action: 'charged', amount, orderId, newExpiry: newExpiry.toISOString() });

        emitSSE(row.user_id, {
          type: 'venue_subscription_renewed',
          data: { tier, expiresAt: newExpiry.toISOString() },
        });
      } catch (chargeErr: any) {
        console.error('[venue-billing] charge failed for', row.user_id, chargeErr?.message);
        // Mark expired on hard charge failure (insufficient funds, card
        // declined, etc.) — same revenue-protection pattern as the artist
        // cron. Soft network errors will retry on next cron run.
        if (expiresAt(row.data?.subscriptionExpiresAt).getTime() <= now.getTime()) {
          await markVenueExpired(row.user_id, row.email, 'charge_failed').catch(() => {});
          expired++;
        }
        results.push({ userId: row.user_id, action: 'error', error: chargeErr?.message || String(chargeErr) });
      }
    }

    return c.json({
      success: true,
      durationMs: Date.now() - now.getTime(),
      scanned: q.rowCount,
      charged, expired, skipped,
      results,
    });
  } catch (error: any) {
    console.error('POST /venue-billing/cron/charge-recurring:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function expiresAt(iso: string | null | undefined): Date {
  if (!iso) return new Date(0);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

// Mark a venue's subscription expired + revoke their bearer tokens
// so the in-venue APK gets 401 on its next poll and shows the
// «оплатите чтобы продолжить» screen. Also pauses their streams in
// venue_station_streams. Idempotent.
export async function markVenueExpired(userId: string, email: string | null, reason: string) {
  const now = new Date().toISOString();

  // Read current profile, flip status + plan in the jsonb.
  const profile = await loadVenueProfile(userId);
  if (profile) {
    const data = profile.data || profile;
    const next = {
      ...data,
      subscriptionStatus: 'expired',
      subscriptionPlan: 'free',
      subscriptionUpdatedAt: now,
      subscriptionExpiredReason: reason,
      updatedAt: now,
    };
    await pool.query(
      `UPDATE venue_profiles SET data = $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
      [JSON.stringify(next), userId]
    );
  }

  // Revoke every active bearer token for this venue → Go-service +
  // any third-party POS integration loses access immediately.
  await pool.query(
    `UPDATE venue_api_tokens
        SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );

  // Pause every active stream so the dashboard shows the correct
  // state and admin can see what to re-enable on reactivation.
  await pool.query(
    `UPDATE venue_station_streams
        SET status     = 'paused',
            updated_at = NOW()
      WHERE user_id = $1 AND status IN ('provisioned', 'live')`,
    [userId]
  );

  emitSSE(userId, {
    type: 'venue_subscription_expired',
    data: { reason },
  });

  // Use the existing trial-expired email (same message — «эфир
  // приостановлен, оплатите чтобы вернуть»). When we add a dedicated
  // post-trial expiry email, swap it here.
  if (email) {
    try {
      const { sendVenueTrialExpiredEmail } = await import('./email-helper.tsx');
      await sendVenueTrialExpiredEmail({
        toEmail: email,
        venueName: (profile as any)?.venueName || 'ваше заведение',
      });
    } catch (e) {
      console.warn('[venue-billing] expired email failed:', (e as any)?.message);
    }
  }
}

export default app;
