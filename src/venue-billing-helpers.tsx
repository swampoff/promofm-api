/**
 * VENUE BILLING HELPERS — non-route shared logic, importable from
 * crons and other modules without pulling the Hono app graph.
 *
 * Scope: VENUE only. Mirrors a slice of venue-billing-routes.tsx
 * (the cron's per-row work) so the trial-expiry cron can attempt
 * an auto-charge before falling back to «mark expired».
 */

import crypto from 'crypto';
import type { Context, Next } from 'hono';
import { pool } from './db-client.tsx';
import { getChargeablePaymentMethod, upsertPaymentSession, getPaymentSession, insertPaymentTx } from './db.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { emitSSE } from './sse-routes.tsx';
import { isAdminEmail } from './roles.tsx';

// Money source of truth — shared venue-plans-constants.tsx (PR 2026-06-10).
// Раньше тут была копия (комментарий «duplicated to avoid circular
// import»). venue-plans-constants — листовой модуль без импортов
// routes/helpers, так что circular-import больше не возникает.
import { resolveVenueChargePlan, isVenueAutoRenewOff } from './venue-plans-constants.tsx';

/**
 * Кабинет заведения (venue-billing, анкета эфира): только аккаунт с ролью
 * venue в статусе active по БД (не по токену) или админ (роль admin/superadmin
 * и e-mail из ADMIN_EMAILS, как requireAdmin). Раньше любой вошедший (артист
 * активен сразу, без проверки) создавал себе профиль заведения, брал пробный
 * и попадал под автосписания, а в разделе PROMO.AIR админки его не было.
 * Ставится после requireAuth.
 */
export async function requireVenueAccount(c: Context, next: Next) {
  const userId = String(c.get('userId') || '');
  let u: any = null;
  try {
    const r = await pool.query(
      `SELECT role::text AS role, status::text AS status, email FROM users WHERE id::text = $1 AND deleted_at IS NULL`,
      [userId]
    );
    u = r.rows[0] || null;
  } catch (e: any) {
    console.error('[venue-billing-helpers] account check failed for', userId, ':', e?.message);
    return c.json({ success: false, error: 'Не удалось проверить аккаунт' }, 500);
  }
  const isVenue = u?.role === 'venue' && u?.status === 'active';
  const isAdmin = (u?.role === 'admin' || u?.role === 'superadmin') && isAdminEmail(u?.email);
  if (!isVenue && !isAdmin) {
    return c.json({ success: false, code: 'venue_only', error: 'Раздел доступен только заведениям' }, 403);
  }
  await next();
}

/**
 * Кого кроны могут списывать: аккаунт существует, не удалён и active.
 * Заблокированных, отклонённых, удалённых и строки без пользователя не
 * списываем: доступа в кабинет у них нет, отменить подписку они не могут.
 * Их период по окончании просто истекает.
 */
export function isChargeableAccount(row: { account_status?: string | null; user_deleted?: boolean | null }): boolean {
  return row.account_status === 'active' && !row.user_deleted;
}

/**
 * Пауза потоков при истечении подписки (кроны пробного и продлений). Потоки
 * не трогаем, пока действует абонемент эфира во второй системе
 * (venue_radio_subscriptions: efir, старые планы, пробный при сборке станции):
 * иначе конец одного тарифа останавливал бы эфир, оплаченный в другом.
 * Строки абонемента ключуются user_id или старым venue_profiles.id (как
 * OWN_SUB в venue-radio-routes).
 */
export async function pauseVenueStreams(userId: string): Promise<number> {
  const r = await pool.query(
    `UPDATE venue_station_streams
        SET status = 'paused', updated_at = NOW()
      WHERE user_id = $1 AND status IN ('provisioned', 'live')
        AND NOT EXISTS (
          SELECT 1 FROM venue_radio_subscriptions s
           WHERE (s.venue_id = $1 OR s.venue_id IN (SELECT vp.id FROM venue_profiles vp WHERE vp.user_id = $1))
             AND s.status = 'active'
             AND (s.current_period_end IS NULL OR s.current_period_end > NOW()))`,
    [userId]
  );
  return r.rowCount || 0;
}

/**
 * Итог автосписания в payment_sessions. Сессия пишется pending ДО запроса к
 * шлюзу, поэтому вебхук может обработать платёж раньше ответа: тогда строка
 * уже не pending, итог не трогаем и деньги второй раз не учитываем (их учёл
 * вебхук). Если строки нет вовсе (запись pending не удалась), пишем её, как
 * раньше. true = итог записали мы, деньги учитывает вызывающий.
 */
export async function settleChargeSession(
  orderId: string,
  status: 'succeeded' | 'canceled' | 'pending',
  gatewayPaymentId: string | null | undefined,
  session: Record<string, any>,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE payment_sessions
        SET status = $2,
            provider_session_id = COALESCE($3, provider_session_id),
            data = COALESCE(data, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('status', $2::text, 'gatewayPaymentId', $3::text)),
            updated_at = NOW()
      WHERE order_id = $1 AND status = 'pending'`,
    [orderId, status, gatewayPaymentId || null]
  );
  if ((r.rowCount || 0) > 0) return true;
  if (await getPaymentSession(orderId)) return false;
  await upsertPaymentSession(orderId, { ...session, status, gatewayPaymentId: gatewayPaymentId || '' });
  return true;
}

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
 *   not_trial — статус уже не trial (отменили в кабинете или оплатили);
 *   not_renewing — пробный назначил админ (autoRenew:false), согласия на
 *               списание нет → caller переводит в expired без списания.
 */
export type TrialChargeOutcome = 'charged' | 'no_card' | 'declined' | 'pending' | 'error' | 'not_trial' | 'not_renewing';

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
 * marks the session succeeded. The pending session is written BEFORE the
 * gateway call, so an early webhook finds it (settleChargeSession).
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
  if (isVenueAutoRenewOff(data)) return 'not_renewing';

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
  // Платёж уже у шлюза (есть его id) или его обрабатывает вебхук: ждём итог.
  // pending без id шлюза = прошлый запрос не дошёл или упал: повторяем с тем
  // же ключом (идемпотентно, второго списания не будет).
  if (prior && (prior.status === 'processing' || (prior.status === 'pending' && prior.gatewayPaymentId))) {
    console.warn('[venue-billing-helpers] first charge still pending at gateway for', userId, orderId);
    return 'pending';
  }
  if (prior && prior.status === 'succeeded') {
    // Деньги уже списаны (вебхук подтвердил ранее pending-платёж или прошлый
    // прогон упал после списания): только включаем тариф, выручку не дублируем.
    await activateAfterTrial(userId, { tier, interval, amount: Number(prior.amount) || amount, name, orderId, now, gateway: card.gateway || 'yookassa', recordMoney: false });
    return 'charged';
  }

  const session = {
    orderId,
    userId,
    gateway: card.gateway || 'yookassa',
    gatewayPaymentId: '',
    amount, currency: 'RUB',
    status: 'pending',
    type: 'venue_subscription',
    description: `Первый период «${name}» после пробного`,
    metadata: { tier, interval, autoTrialEnd: true, userId },
    savePaymentMethod: false,
    confirmationUrl: '',
    returnUrl: 'https://promo-music.ru/venue',
    createdAt: now.toISOString(),
  };
  let chargeStatus: 'succeeded' | 'canceled' | 'pending';
  let ownsMoney = false;
  try {
    // Сессия до запроса к шлюзу: вебхук, пришедший раньше ответа, найдёт её
    // (раньше отвечал «Session not in DB», и оплата не включала тариф).
    await upsertPaymentSession(orderId, session);
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
    // Сбой записи итога не делает списание «ошибкой»: деньги у шлюза уже
    // взяты; сессия осталась pending, и её учтёт вебхук.
    ownsMoney = await settleChargeSession(orderId, chargeStatus, chargeResult.sessionId, session).catch((e: any) => {
      console.error('[venue-billing-helpers] charge session settle failed for', userId, orderId, ':', e?.message);
      return false;
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

  // ownsMoney = false: вебхук успел раньше и сам учёл деньги.
  await activateAfterTrial(userId, { tier, interval, amount, name, orderId, now, gateway: card.gateway || 'yookassa', recordMoney: ownsMoney });
  return 'charged';
}

// Пробный → платный тариф после подтверждённого списания. Период от «сейчас»
// (момента окончания пробного): 30 дней месяц, 365 дней год.
async function activateAfterTrial(
  userId: string,
  p: { tier: string; interval: 'month' | 'year'; amount: number; name: string; orderId: string; now: Date; gateway: string; recordMoney: boolean },
): Promise<void> {
  const { tier, interval, amount, name, orderId, now } = p;
  const daysToAdd = interval === 'year' ? 365 : 30;
  const newExpiry = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  // Только поля подписки поверх текущей строки (jsonb ||): правки профиля,
  // сделанные, пока шёл запрос к шлюзу, не затираются старой копией.
  const patch = {
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
    `UPDATE venue_profiles SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE user_id = $2`,
    [JSON.stringify(patch), userId]
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
