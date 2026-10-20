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
 *   subscriptionStatus       'pending_card' | 'trial' | 'active' | 'expired' | 'cancelled'
 *                            (no status = 'pending_card')
 *   subscriptionPlan         'start' | 'business' | 'network' | 'enterprise'
 *                            (during the trial: the tier chosen at card binding)
 *   subscriptionExpiresAt    ISO date (end of the paid period; for a trial = trial_expires_at)
 *   subscriptionInterval     'month' | 'year'
 *   subscriptionPriceRub     last paid price (audit)
 *   subscriptionUpdatedAt    ISO date
 *   trial_expires_at         ISO date, set when the card is bound (webhook)
 *   cancelledFromStatus      'trial' | 'active' while status='cancelled'
 *   subscriptionCancelledAt  ISO date of the cancel
 *
 * Saved payment method: stored in the existing `payment_methods` SQL
 * table (the same one artist subscriptions use). The newest card with a
 * gateway token is the one charged (db.tsx getChargeablePaymentMethod).
 *
 * Endpoints:
 *   GET    /plans                    — public tariff list (prices, trial
 *                                       days, limits) for the cabinets
 *                                       and promoair.ru.
 *   POST   /subscribe                — create YooKassa session for
 *                                       chosen tier+interval. Sets
 *                                       savePaymentMethod=true so
 *                                       the gateway returns a
 *                                       reusable token for the
 *                                       recurring cron.
 *   POST   /attach-card              — 1 ₽ card check that starts the
 *                                       trial for the chosen tier.
 *   POST   /cancel                   — status='cancelled', access stays
 *                                       until the paid/trial period
 *                                       ends, no further charges.
 *   POST   /resume                   — undo a cancel while the period
 *                                       is still running (or turn on
 *                                       autorenew of an admin-assigned
 *                                       plan, autoRenew:false).
 *   GET    /me                       — current venue subscription
 *                                       state + saved payment
 *                                       method info (last4, brand)
 *                                       + next charge (date, amount).
 *   POST   /cron/charge-recurring    — CRON_SECRET-protected.
 *                                       Sister of /server/subscriptions/
 *                                       charge-recurring but for
 *                                       venue_profiles only.
 *
 * subscribe / attach-card / cancel / resume / me: only a venue account
 * (users.role='venue', status active) or an admin (requireVenueAccount).
 *
 * Webhook activation: handled in checkout-routes.tsx by the
 * `metadata.type === 'venue_subscription'` branch (paid tier) and the
 * `metadata.type === 'venue_card_attach'` branch (trial start).
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { ensureVenueProfile, getVenueProfile as dbGetVenueProfile, upsertVenueProfile, getChargeablePaymentMethod, upsertPaymentSession, insertPaymentTx } from './db.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { safeErrorMessage } from './security.tsx';
import { emitSSE } from './sse-routes.tsx';
import { originFromRequest, siteForUserId, PATH } from './site-origin.tsx';
import { loadVenueReceiptEmail, requireVenueAccount, isChargeableAccount, pauseVenueStreams, settleChargeSession } from './venue-billing-helpers.tsx';
import { VENUE_PLAN_LIMITS, getEffectiveVenuePlan } from './venue-plan-limits.tsx';
import { TRIAL_PERIOD_DAYS } from './venue-trial.tsx';
import type { VenueExpiredReason } from './email-helper.tsx';

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

import {
  VENUE_PLANS_CORE, VENUE_YEAR_MONTHS, FULL_RADIO_PLAN, RENEWAL_LEAD_DAYS,
  isVenuePaidTier, venuePlanPrice, parseVenuePlanChoice, getVenueNextCharge, isVenueAutoRenewOff,
} from './venue-plans-constants.tsx';

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

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });

// ──────────────────────────────────────────────────────────────────
// GET /plans — public tariff list (no auth, no secrets)
// ──────────────────────────────────────────────────────────────────
// Один источник цен для кабинетов и promoair.ru: VENUE_PLANS_CORE (деньги),
// VENUE_PLAN_LIMITS (что входит), TRIAL_PERIOD_DAYS. «Радио полного цикла»
// показывается с ценой, но не покупается онлайн (заявка через анкету эфира).
app.get('/plans', (c) => {
  const plans = [
    ...(Object.keys(VENUE_PLANS_CORE) as Array<keyof typeof VENUE_PLANS_CORE>).map((id) => ({
      id,
      name: VENUE_PLANS_CORE[id].name,
      monthly: VENUE_PLANS_CORE[id].price_month,
      yearly: VENUE_PLANS_CORE[id].price_year,
      purchasable: true,
      limits: VENUE_PLAN_LIMITS[id],
    })),
    {
      id: FULL_RADIO_PLAN.id,
      name: FULL_RADIO_PLAN.name,
      monthly: FULL_RADIO_PLAN.price_month,
      yearly: FULL_RADIO_PLAN.price_year,
      purchasable: false,
      limits: null,
    },
  ];
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ success: true, currency: 'RUB', trialDays: TRIAL_PERIOD_DAYS, yearMonths: VENUE_YEAR_MONTHS, plans });
});

// ──────────────────────────────────────────────────────────────────
// POST /subscribe — create YooKassa session, save payment method
// ──────────────────────────────────────────────────────────────────
app.post('/subscribe', requireAuth, requireVenueAccount, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json().catch(() => ({}));
    const choice = parseVenuePlanChoice(body);
    if (choice.error || !choice.tier) {
      return c.json({ success: false, error: choice.error || `Unknown tier "". Allowed: ${Object.keys(VENUE_PLANS).join(', ')}` }, 400);
    }
    const tier = choice.tier;
    const interval = choice.interval || 'month';
    const plan = VENUE_PLANS[tier];
    const price = venuePlanPrice(tier, interval);

    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found – register the venue first' }, 404);
    }

    const { getGateway } = await import('./payment-gateway.tsx');
    const gateway = getGateway('yookassa');
    const orderId = crypto.randomUUID();
    // Возврат на тот сайт, откуда начали оплату (сессия у promoair.ru своя).
    const returnUrl = `${originFromRequest(c)}${PATH.venueSubscription}?payment=success&tier=${tier}`;
    const desc = `Подписка «${plan.name}» (${interval === 'year' ? 'год' : 'мес'}) – ${profile.venueName || 'заведение'}`;
    // 54-ФЗ: чек на e-mail заведения (без него шлюз подставлял noreply@).
    const receiptEmail = await loadVenueReceiptEmail(userId);

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
        ...(receiptEmail ? { email: receiptEmail } : {}),
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

/**
 * POST /attach-card: привязка карты для старта бесплатного пробного периода
 * (TRIAL_PERIOD_DAYS из venue-trial.tsx: 7 дней с 16.10.2026, раньше 14).
 *
 * Владелец 2026-08-07: «заведение обязано привязывать карту». Раньше триал
 * выдавался просто статусом, карты не было, и крон trial_auto_charge не мог
 * ничего списать по окончании.
 *
 * Механика: проверочный платёж 1 ₽ с savePaymentMethod. После успеха вебхук
 * (checkout-routes.tsx, ветка venue_card_attach) сохраняет карту, включает
 * пробный на 7 дней и ВОЗВРАЩАЕТ рубль. По окончании пробного крон
 * venue-trial списывает выбранный тариф с этой карты
 * (venue-billing-helpers.tsx: tryAutoChargeAtTrialEnd).
 *
 * Тело (необязательно): {tier: 'start'|'business'|'network', interval:
 * 'month'|'year'}. Выбор пишется в профиль вебхуком: пробный идёт на этом
 * тарифе, и списывается ровно он. Без выбора: текущий тариф профиля
 * (по умолчанию «Старт», помесячно).
 *
 * Сессия платежа сохраняется так же, как в /subscribe: без неё вебхук
 * отвечал «Session not in DB» и пробный не включался (critic A2 a).
 *
 * Пробный один раз: после окончания (expired) карта привязывается через
 * /subscribe с оплатой. Во время пробного или платной подписки это смена
 * карты (срок не меняется).
 */
app.post('/attach-card', requireAuth, requireVenueAccount, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json().catch(() => ({}));
    const choice = parseVenuePlanChoice(body);
    if (choice.error) {
      return c.json({ success: false, error: choice.error }, 400);
    }
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Профиль заведения не найден' }, 404);
    }
    const status = String(profile.subscriptionStatus || 'pending_card');
    if (status === 'expired' || status === 'inactive') {
      return c.json({
        success: false,
        code: 'trial_used',
        error: 'Пробный период уже был. Чтобы продолжить, оформите подписку.',
      }, 409);
    }

    const { getGateway } = await import('./payment-gateway.tsx');
    const gateway = getGateway('yookassa');
    const orderId = crypto.randomUUID();
    const returnUrl = `${originFromRequest(c)}${PATH.venueSubscription}?card=attached`;
    const desc = `Привязка карты для пробного периода – ${profile.venueName || 'заведение'} (1 ₽ вернётся автоматически)`;
    const receiptEmail = await loadVenueReceiptEmail(userId);
    // Выбор тарифа: trialPlan / trialInterval, НЕ planKey (см. вебхук).
    const meta: Record<string, string> = {
      type: 'venue_card_attach',
      userId,
      venueId: String(profile.id || ''),
      ...(choice.tier ? { trialPlan: choice.tier } : {}),
      ...(choice.interval ? { trialInterval: choice.interval } : {}),
    };

    const result = await gateway.createPayment({
      orderId,
      amount: 1,
      currency: 'RUB',
      description: desc,
      returnUrl,
      userId,
      gateway: 'yookassa',
      type: 'venue_subscription',
      savePaymentMethod: true,
      metadata: { ...meta, ...(receiptEmail ? { email: receiptEmail } : {}) },
    });

    await upsertPaymentSession(orderId, {
      orderId,
      userId,
      gateway: 'yookassa',
      gatewayPaymentId: result.sessionId,
      amount: 1,
      currency: 'RUB',
      status: 'pending',
      type: 'venue_subscription',
      description: desc,
      metadata: meta,
      savePaymentMethod: true,
      confirmationUrl: result.confirmationUrl,
      returnUrl,
      createdAt: new Date().toISOString(),
    });

    // Что сделает вебхук (checkout-routes.tsx, venue_card_attach): старт пробного,
    // смена карты в пробном (тариф можно сменить) или только смена карты.
    const mode = status === 'pending_card' ? 'trial_start'
      : (status === 'trial' || (status === 'cancelled' && profile.cancelledFromStatus === 'trial')) ? 'trial_card_change'
      : 'card_change';
    const appliesChoice = mode !== 'card_change';
    return c.json({
      success: true,
      confirmationUrl: result.confirmationUrl,
      orderId,
      mode,
      tier: (appliesChoice && choice.tier) || (isVenuePaidTier(profile.subscriptionPlan) ? profile.subscriptionPlan : 'start'),
      interval: (appliesChoice && choice.interval) || (profile.subscriptionInterval === 'year' ? 'year' : 'month'),
      note: 'Списываем 1 ₽ для проверки карты и сразу возвращаем. Пробный период включится после подтверждения.',
    });
  } catch (error: any) {
    console.error('[venue-billing] attach-card failed:', error?.message || error);
    return c.json({ success: false, error: 'Не удалось начать привязку карты' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /cancel — status 'cancelled', access until the period ends
// ──────────────────────────────────────────────────────────────────
// Доступ сохраняется до конца оплаченного или пробного периода
// (getEffectiveVenuePlan), списаний больше нет: крон пробного сканирует
// только status='trial', крон продлений не списывает с 'cancelled' и
// по окончании срока переводит в 'expired' (markVenueExpired).
app.post('/cancel', requireAuth, requireVenueAccount, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const data = profile.data || profile;
    const status = String(data.subscriptionStatus || 'pending_card');
    if (status === 'cancelled') {
      return c.json({
        success: true,
        message: 'Подписка уже отменена.',
        subscriptionStatus: 'cancelled',
        subscriptionExpiresAt: data.subscriptionExpiresAt || null,
      });
    }
    if (status !== 'trial' && status !== 'active') {
      return c.json({ success: false, code: 'nothing_to_cancel', error: 'Активной подписки нет' }, 409);
    }

    const nowIso = new Date().toISOString();
    // Для пробного срок доступа = конец пробного (вебхук привязки карты ставит
    // оба поля одинаково, но старые строки могли иметь только trial_expires_at).
    const accessUntil = (status === 'trial' ? data.trial_expires_at : null) || data.subscriptionExpiresAt || null;
    const nextData = {
      ...data,
      subscriptionStatus: 'cancelled',
      cancelledFromStatus: status,
      subscriptionCancelledAt: nowIso,
      subscriptionExpiresAt: accessUntil,
      subscriptionUpdatedAt: nowIso,
      // Intentionally keep the period end — the stream continues until
      // it, then the charge-recurring cron flips status='expired' +
      // revokes the bearer token.
      updatedAt: nowIso,
    };

    await pool.query(
      `UPDATE venue_profiles SET data = $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
      [JSON.stringify(nextData), userId]
    );

    emitSSE(userId, {
      type: 'venue_subscription_cancelled',
      data: { expiresAt: accessUntil },
    });

    const until = accessUntil ? fmtDate(accessUntil) : null;
    return c.json({
      success: true,
      message: status === 'trial'
        ? `Подписка отменена. Пробный период работает${until ? ` до ${until}` : ''}, списаний не будет.`
        : `Подписка отменена. Эфир будет работать до конца оплаченного периода${until ? ` (${until})` : ''}, продления не будет.`,
      subscriptionStatus: 'cancelled',
      subscriptionExpiresAt: accessUntil,
    });
  } catch (error: any) {
    console.error('POST /venue-billing/cancel:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /resume — undo a cancel while the period is still running
// ──────────────────────────────────────────────────────────────────
// Возвращает статус, из которого отменили (trial / active). Нужна
// сохранённая карта: без неё в конце срока нечего списывать (для
// пробного тогда /attach-card, он тоже снимает отмену).
// Оплата тарифа через /subscribe тоже снимает отмену (вебхук).
// Тариф или пробный от админа (autoRenew:false, без отмены): «возобновить»
// = включить автопродление с этой карты.
app.post('/resume', requireAuth, requireVenueAccount, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }
    const data = profile.data || profile;
    const until = Date.parse(data.subscriptionExpiresAt || '');
    const cancelled = data.subscriptionStatus === 'cancelled';
    const autoRenewOff = (data.subscriptionStatus === 'active' || data.subscriptionStatus === 'trial') && isVenueAutoRenewOff(data);
    if (!(cancelled || autoRenewOff) || !(until > Date.now())) {
      return c.json({ success: false, code: 'nothing_to_resume', error: 'Возобновить нечего: подписка не отменена или её срок уже закончился' }, 409);
    }
    const card = await getChargeablePaymentMethod(userId);
    if (!card) {
      return c.json({ success: false, code: 'card_required', error: 'Привяжите карту, чтобы возобновить подписку' }, 409);
    }
    const back = cancelled ? (data.cancelledFromStatus === 'trial' ? 'trial' : 'active') : data.subscriptionStatus;
    const nowIso = new Date().toISOString();
    const nextData = {
      ...data,
      subscriptionStatus: back,
      cancelledFromStatus: null,
      subscriptionCancelledAt: null,
      autoRenew: null,
      subscriptionUpdatedAt: nowIso,
      updatedAt: nowIso,
    };
    await pool.query(
      `UPDATE venue_profiles SET data = $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
      [JSON.stringify(nextData), userId]
    );
    emitSSE(userId, { type: 'venue_subscription_resumed', data: { status: back, expiresAt: data.subscriptionExpiresAt } });
    return c.json({ success: true, subscriptionStatus: back, subscriptionExpiresAt: data.subscriptionExpiresAt });
  } catch (error: any) {
    console.error('POST /venue-billing/resume:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /me — current state + saved payment method for cabinet display
// ──────────────────────────────────────────────────────────────────
// Без статуса = pending_card (карта не привязана), как в
// getEffectiveVenuePlan. Раньше здесь был 'trial'/'business', а гейтинг
// читал тот же профиль как активный «Старт» (critic A2 f).
app.get('/me', requireAuth, requireVenueAccount, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, subscription: null, savedCard: null });
    }

    const data = profile.data || profile;

    // Surface a tiny saved-card summary (last4, brand) without
    // exposing the full PCI surface. payment_methods rows from the
    // same store the artist cron uses. Только карта шлюза: её и спишут.
    const card = await getChargeablePaymentMethod(userId).catch((e: any) => {
      console.error('[venue-billing] /me card lookup failed:', e?.message);
      return null;
    });
    // Токен шлюза (gatewayMethodId) клиенту не отдаём: он нужен только кронам.
    const savedCard = card ? {
      last4:    card.last4 || card.card?.last4 || null,
      brand:    card.brand || card.card?.brand || null,
      gateway:  card.gateway || 'yookassa',
    } : null;

    const next = getVenueNextCharge(data, !!card);
    const status = data.subscriptionStatus || 'pending_card';
    // До привязки карты пробного ещё нет: дата из applyInitialTrial (создание
    // профиля) не срок, её не показываем.
    const preTrial = status === 'pending_card';
    const subscription = {
      status,
      plan:        data.subscriptionPlan        || 'start',
      effectivePlan: getEffectiveVenuePlan(data),
      expiresAt:   preTrial ? null : (data.subscriptionExpiresAt || data.trial_expires_at || null),
      interval:    data.subscriptionInterval    || null,
      priceRub:    data.subscriptionPriceRub    || null,
      updatedAt:   data.subscriptionUpdatedAt   || null,
      planLabel:   (isVenuePaidTier(data.subscriptionPlan) ? VENUE_PLANS[data.subscriptionPlan].name : null),
      trialDays:   TRIAL_PERIOD_DAYS,
      trialExpiresAt: preTrial ? null : (data.trial_expires_at || null),
      // false: тариф назначил админ, автосписания не будет (nextChargeAt null).
      autoRenew:   !isVenueAutoRenewOff(data),
      cancelledFromStatus: status === 'cancelled' ? (data.cancelledFromStatus || null) : null,
      cancelledAt: status === 'cancelled' ? (data.subscriptionCancelledAt || null) : null,
      // Ближайшее автосписание: null, если списания не будет (нет карты,
      // отменено, истекло, карта ещё не привязана).
      nextChargeAt:  next?.at || null,
      nextChargeRub: next?.amountRub ?? null,
      nextChargePlan: next?.tier || null,
      nextChargeInterval: next?.interval || null,
      // Пробный идёт, а карта не сохранилась: автосписания не будет.
      cardRequired: status === 'trial' && !card,
    };

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
// Runs every 6 hours (systemd/promofm-venue-charge-recurring.timer).
// Finds venues with subscriptionExpiresAt within RENEWAL_LEAD_DAYS (3)
// or already past + status='active'/'cancelled' and either:
//  - Charges the saved card → extends period by 30/365 days.
//  - No card and past expiry → flips to 'expired' + revokes bearer
//    tokens for their venue_station_streams (APK gets 401 next poll).
//
// Cancelled status is treated like active for the charge — we honour
// the paid period. After it expires, no new charge attempt (status
// stays cancelled→expired, no auto-renewal). The same holds for a plan
// the admin assigned (autoRenew:false) and for an account that is not
// active (blocked, rejected, deleted): never charged, expires at the end.
//
// Every attempt to renew one period carries metadata.renewFor = the
// period end (ms). A succeeded attempt (also one the webhook confirmed
// later) extends the period without a new charge; an attempt still in
// flight at the gateway is waited for. Before, a 'pending' renewal never
// extended the period and the next day's key charged the card again.
//
const RENEW_LOCK = 770452; // advisory lock, уникален (770451 = крон пробного)

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
  const soonMs = now.getTime() + RENEWAL_LEAD_DAYS * 24 * 60 * 60 * 1000;
  const results: any[] = [];
  let charged = 0, expired = 0, skipped = 0;

  // Ручной запуск поверх таймера: ключ YooKassa общий, но оба прогона
  // продлили бы период и учли выручку дважды. Второй прогон выходит сразу.
  const lockClient = await pool.connect();
  try {
    const got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [RENEW_LOCK])).rows[0]?.got;
    if (!got) {
      lockClient.release();
      console.log('[venue-billing] charge-recurring: another run is in progress, skipping.');
      return c.json({ success: true, locked: true, scanned: 0, charged, expired, skipped, results });
    }
  } catch (err: any) {
    lockClient.release();
    console.error('[venue-billing] charge-recurring lock failed:', err?.message);
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }

  try {
    // Find venues whose subscription is past or within 3 days of expiry.
    // We process trial expiries via the existing venue-trial cron;
    // here we only deal with already-paid venues (status=active/cancelled).
    const q = await pool.query(
      `SELECT vp.user_id,
              vp.data,
              u.email AS email,
              u.status::text AS account_status,
              (u.deleted_at IS NOT NULL) AS user_deleted
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

        // Без списания: аккаунт закрыт (заблокирован, отклонён, удалён, нет
        // пользователя; первым, чтобы закрытому не ушло письмо), отменено или
        // тариф от админа без автопродления.
        const isCancelled = data.subscriptionStatus === 'cancelled';
        const noRenew: string | null = !isChargeableAccount(row) ? 'account_closed'
          : isCancelled ? 'cancelled_period_ended'
          : isVenueAutoRenewOff(data) ? 'not_renewed'
          : null;
        // Карта шлюза (с токеном). Сбой чтения БД ≠ «карты нет»: не отключаем,
        // повторим на следующем прогоне.
        let card: any = null;
        try {
          card = noRenew ? null : await getChargeablePaymentMethod(row.user_id);
        } catch (e: any) {
          skipped++;
          results.push({ userId: row.user_id, action: 'skipped', reason: 'card_lookup_failed', error: e?.message });
          continue;
        }

        // No saved card OR no renewal → if past expiry, mark expired
        // and revoke bearer tokens so the APK stops streaming.
        if (!card || noRenew) {
          const reason = noRenew || 'no_saved_card';
          const short = reason === 'cancelled_period_ended' ? 'cancelled' : reason === 'no_saved_card' ? 'no_card' : reason;
          if (expiresAt.getTime() <= now.getTime()) {
            // Закрытому аккаунту письмо «оформите подписку» не шлём.
            await markVenueExpired(row.user_id, reason === 'account_closed' ? null : row.email, reason);
            expired++;
            results.push({ userId: row.user_id, action: 'expired', reason: short });
          } else {
            skipped++;
            results.push({ userId: row.user_id, action: 'skipped', reason: reason === 'no_saved_card' ? 'no_card_but_within_grace' : `${short}_awaiting_period_end` });
          }
          continue;
        }

        const amount = interval === 'year' ? plan.price_year : plan.price_month;
        const renewFor = String(expiresAt.getTime());
        const attempts = (await pool.query(
          `SELECT order_id, status, COALESCE(provider_session_id, data->>'gatewayPaymentId', '') AS gateway_payment_id
             FROM payment_sessions
            WHERE user_id = $1 AND purpose = 'venue_subscription'
              AND data->'metadata'->>'renewFor' = $2
            ORDER BY created_at DESC`,
          [row.user_id, renewFor]
        )).rows as any[];

        // Этот период уже оплачен (вебхук подтвердил платёж, ждавший шлюза,
        // или прошлый прогон упал после списания): продлеваем без списания,
        // деньги учтены тем, кто записал итог.
        const paid = attempts.find((a) => a.status === 'succeeded');
        if (paid) {
          const newExpiry = await extendVenuePeriod(row.user_id, expiresAt, interval, now);
          charged++;
          results.push({ userId: row.user_id, action: 'renewed_without_charge', orderId: paid.order_id, newExpiry });
          emitSSE(row.user_id, { type: 'venue_subscription_renewed', data: { tier, expiresAt: newExpiry } });
          continue;
        }
        // Платёж у шлюза ещё в обработке (есть его id) или его разбирает
        // вебхук: ждём итог, новую попытку не начинаем.
        const inFlight = attempts.find((a) => a.status === 'processing' || (a.status === 'pending' && a.gateway_payment_id));
        if (inFlight) {
          skipped++;
          results.push({ userId: row.user_id, action: 'skipped', reason: 'renewal_pending', orderId: inFlight.order_id });
          continue;
        }

        // Card present + active → charge it.
        // Day-stamp в orderId (2026-07-02): orderId = Idempotence-Key у YooKassa.
        // Чисто-детерминированный ключ по expiresAt после ОТКАЗА карты возвращал
        // тот же canceled-платёж на все ретраи в окне ключа — починивший карту
        // подписчик не мог продлиться. День в ключе: crash-safe внутри суток,
        // свежий ключ на следующий прогон. (Длиннее 64 символов: шлюз шлёт
        // sha256 ключа, gateway-yookassa.tsx yookassaIdempotenceKey.)
        const dayStamp = now.toISOString().slice(0, 10);
        const orderId = `venue-renew-${row.user_id}-${expiresAt.getTime()}-${dayStamp}`;
        const session = {
          orderId,
          userId: row.user_id,
          gateway: card.gateway || 'yookassa',
          gatewayPaymentId: '',
          amount, currency: 'RUB',
          status: 'pending',
          type: 'venue_subscription',
          description: `Продление «${plan.name}»`,
          metadata: { tier, interval, recurring: true, renewFor, userId: row.user_id, venueId: data.id },
          savePaymentMethod: false,
          confirmationUrl: '',
          returnUrl: 'https://promo-music.ru/venue',
          createdAt: now.toISOString(),
        };
        // Сессия pending до запроса к шлюзу: вебхук, пришедший раньше ответа,
        // найдёт её, а следующий прогон увидит попытку по renewFor.
        await upsertPaymentSession(orderId, session);

        const { getGateway } = await import('./payment-gateway.tsx');
        const gateway = getGateway(card.gateway || 'yookassa');
        const chargeResult = await gateway.chargeRecurring({
          amount,
          currency: 'RUB',
          paymentMethodId: card.gatewayMethodId,
          orderId,
          description: `Продление «${plan.name}» (${interval === 'year' ? 'год' : 'мес'})`,
          userId: row.user_id,
          // 54-ФЗ: чек на e-mail заведения
          receiptEmail: row.email || undefined,
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
        // false: вебхук успел раньше и сам учёл деньги (или запись итога не
        // удалась и сессию учтёт вебхук).
        const ownsMoney = await settleChargeSession(orderId, chargeStatus, chargeResult.sessionId, session).catch((e: any) => {
          console.error('[venue-billing] renewal session settle failed for', row.user_id, orderId, ':', e?.message);
          return false;
        });

        if (chargeStatus === 'canceled') {
          // отказ карты — в catch ниже (там mark-expired при истёкшем периоде)
          throw new Error('venue recurring charge declined by gateway (canceled)');
        }
        if (chargeStatus !== 'succeeded') {
          // 'pending' (редкий async) — не продлеваем; следующие прогоны ждут
          // итог по renewFor и продлят без нового списания.
          skipped++;
          results.push({ userId: row.user_id, action: 'charge_pending', orderId });
          continue;
        }

        // Extend period in profile (paid in advance — extend from
        // current expires_at, not from now, so customers who pay
        // 25-29 days into the cycle aren't shorted).
        const newExpiry = await extendVenuePeriod(row.user_id, expiresAt, interval, now);

        if (ownsMoney) {
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
        }

        charged++;
        results.push({ userId: row.user_id, action: 'charged', amount, orderId, newExpiry });

        emitSSE(row.user_id, {
          type: 'venue_subscription_renewed',
          data: { tier, expiresAt: newExpiry },
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
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [RENEW_LOCK]).catch(() => {});
    lockClient.release();
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

// Оплаченный период продления: +30 / +365 дней от старого конца (или от
// «сейчас», если он уже прошёл). Пишутся только поля подписки поверх текущей
// строки (jsonb ||), остальной профиль не затирается копией из начала прогона.
async function extendVenuePeriod(userId: string, periodEnd: Date, interval: 'month' | 'year', now: Date): Promise<string> {
  const daysToAdd = interval === 'year' ? 365 : 30;
  const newExpiry = new Date(Math.max(periodEnd.getTime(), now.getTime()) + daysToAdd * 24 * 60 * 60 * 1000).toISOString();
  await pool.query(
    `UPDATE venue_profiles SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
    [JSON.stringify({
      subscriptionExpiresAt: newExpiry,
      subscriptionStatus: 'active',
      subscriptionUpdatedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }), userId]
  );
  return newExpiry;
}

// Mark a venue's subscription expired + revoke their bearer tokens
// so the in-venue APK gets 401 on its next poll and shows the
// «оплатите чтобы продолжить» screen. Also pauses their streams in
// venue_station_streams (not while a station subscription is paid,
// pauseVenueStreams). Idempotent. email = null: no expiry email
// (a closed account cannot log in to subscribe).
export async function markVenueExpired(userId: string, email: string | null, reason: string) {
  const now = new Date().toISOString();

  // Flip status + plan in the jsonb: only these fields on top of the
  // current row, the rest of the profile is not rewritten.
  const profile = await loadVenueProfile(userId);
  if (profile) {
    await pool.query(
      `UPDATE venue_profiles SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
      [JSON.stringify({
        subscriptionStatus: 'expired',
        subscriptionPlan: 'free',
        subscriptionUpdatedAt: now,
        subscriptionExpiredReason: reason,
        updatedAt: now,
      }), userId]
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
  await pauseVenueStreams(userId);

  emitSSE(userId, {
    type: 'venue_subscription_expired',
    data: { reason },
  });

  // The expiry email names the reason (cancelled / admin plan without
  // autorenew / card declined / period over without a card), see
  // sendVenueTrialExpiredEmail.
  if (email) {
    try {
      const { sendVenueTrialExpiredEmail } = await import('./email-helper.tsx');
      // markVenueExpired зовёт только крон продлений: оплаченный период
      // закончился (без карты или отказ карты), подписку отменили или
      // тариф от админа шёл без автопродления.
      const emailReason: VenueExpiredReason = reason === 'cancelled_period_ended' ? 'cancelled'
        : reason === 'not_renewed' ? 'not_renewed'
        : 'period_ended';
      await sendVenueTrialExpiredEmail({
        toEmail: email,
        venueName: (profile as any)?.venueName || 'ваше заведение',
        site: await siteForUserId(userId),
        reason: emailReason,
      });
    } catch (e) {
      console.warn('[venue-billing] expired email failed:', (e as any)?.message);
    }
  }
}

export default app;
