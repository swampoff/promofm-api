import { Hono } from 'hono';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth, optionalAuth } from './auth-middleware.tsx';
import { pool, ensureSchemaInline } from './db-client.tsx';
import { SUBSCRIPTION_PLANS } from './subscriptions-routes.tsx';

const donationsRoutes = new Hono();

// ── Tier-aware donation commission ─────────────────────────────────────────
//
// The pricing matrix on PricingPage.tsx promises tier-based donation
// commission:
//   spark (free)   — 10%
//   start          — 7%
//   pro            — 5%
//   elite          — 3%
//
// Until this PR the backend hardcoded 0.03 for everyone — Spark
// freeloaders were paying the Elite rate (revenue leak), and the
// marketing matrix was lying. This helper resolves the artist's
// active subscription tier and returns the advertised rate.
//
// Defaults: any failure (missing user_id, no active subscription,
// expired subscription, DB hiccup, unknown tier) → spark rate
// (0.10). Rationale: spark is the implicit «free» tier for any
// artist without an explicit subscription, so it's the correct
// fallback for «we don't know what tier this user is».
//
// The platform is the source of truth for the rate, the artist's
// withdrawal request only includes the amount — the rate is
// computed server-side. No way for the artist to fake their
// commission by tampering with the request body.

const DEFAULT_DONATION_COMMISSION = 0.10; // spark / unknown tier

async function resolveDonationCommissionRate(
  userId: string | null | undefined,
): Promise<{ rate: number; tier: string }> {
  if (!userId) return { rate: DEFAULT_DONATION_COMMISSION, tier: 'spark' };

  try {
    const r = await pool.query(
      `SELECT data FROM subscriptions WHERE user_id = $1
       ORDER BY (data->>'updated_at') DESC NULLS LAST,
                (data->>'created_at') DESC NULLS LAST
       LIMIT 1`,
      [userId],
    );
    if (r.rows.length === 0) return { rate: DEFAULT_DONATION_COMMISSION, tier: 'spark' };

    const raw = r.rows[0].data;
    const sub: any = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!sub) return { rate: DEFAULT_DONATION_COMMISSION, tier: 'spark' };

    if (sub.status !== 'active' && sub.status !== 'trial') {
      return { rate: DEFAULT_DONATION_COMMISSION, tier: 'spark' };
    }
    if (sub.expires_at) {
      const expires = new Date(sub.expires_at).getTime();
      if (Number.isFinite(expires) && expires < Date.now()) {
        return { rate: DEFAULT_DONATION_COMMISSION, tier: 'spark' };
      }
    }

    const tier = String(sub.tier || sub.planId || 'spark').toLowerCase();
    const plan = (SUBSCRIPTION_PLANS as any)[tier];
    if (!plan) return { rate: DEFAULT_DONATION_COMMISSION, tier };

    const rate = Number(plan.donation_fee);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      return { rate: DEFAULT_DONATION_COMMISSION, tier };
    }
    return { rate, tier };
  } catch (err: any) {
    console.warn('[donations] resolveDonationCommissionRate failed:', err?.message);
    return { rate: DEFAULT_DONATION_COMMISSION, tier: 'spark' };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

// row-per-withdrawal (migration 043). Все донат-заявки имеют source='donation'.
function mapWithdrawalRow(r: any): any {
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : undefined);
  return {
    id: r.app_id,
    source: r.source,
    userId: r.user_id,
    amount: Number(r.amount),
    commission: r.commission !== null ? Number(r.commission) : undefined,
    commissionRate: r.commission_rate !== null ? Number(r.commission_rate) : undefined,
    commissionTier: r.commission_tier || undefined,
    payout: r.payout !== null ? Number(r.payout) : undefined,
    paymentMethod: r.payment_method || undefined,
    paymentDetails: r.payment_details || null,
    status: r.status,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

async function getDonationWithdrawals(userId: string): Promise<any[]> {
  const r = await pool.query(
    `SELECT app_id, user_id, source, amount, commission, commission_rate,
            commission_tier, payout, payment_method, payment_details, status,
            created_at, updated_at
       FROM payment_withdrawals
      WHERE user_id = $1 AND source = 'donation'
      ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows.map(mapWithdrawalRow);
}

async function getDonationBalance(artistId: string): Promise<number> {
  const dons = await db.getDonationsByArtist(artistId) as any[];
  const earned = (dons || [])
    .filter((d: any) => d?.status === 'completed' || d?.status === 'paid')
    .reduce((sum: number, d: any) => sum + (Number(d?.amount) || 0), 0);

  // SQL уже фильтрует source='donation' — filter в JS убран.
  const wds = await getDonationWithdrawals(artistId);
  const reserved = wds
    .filter((w: any) => w?.status !== 'rejected' && w?.status !== 'cancelled')
    .reduce((s: number, w: any) => s + (Number(w?.amount) || 0), 0);

  return Math.max(0, earned - reserved);
}

// ── GET /donations — list donations received by this artist ──
donationsRoutes.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const donations = await db.getDonationsByArtist(userId);
    return c.json({ success: true, data: donations || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// ── GET /donations/list — alias of GET / with balance ──
donationsRoutes.get('/list', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const donations = await db.getDonationsByArtist(userId);
    const balance = await getDonationBalance(userId);
    // Include the artist's current commission rate so the cabinet can
    // preview «вы получите X ₽ после удержания Y%» before they
    // submit the withdrawal — without re-deriving the tier logic
    // client-side.
    const { rate, tier } = await resolveDonationCommissionRate(String(userId || ''));
    return c.json({
      success: true,
      data: donations || [],
      balance,
      commission: { rate, tier },
    });
  } catch (error) {
    return c.json({ success: true, data: [], balance: 0 });
  }
});

// ── GET /donations/withdrawals — список заявок на вывод ──
donationsRoutes.get('/withdrawals', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    // getDonationWithdrawals возвращает уже отсортированный список
    // только source='donation'.
    const donationWds = await getDonationWithdrawals(userId);
    const balance = await getDonationBalance(userId);
    const { rate, tier } = await resolveDonationCommissionRate(String(userId || ''));
    return c.json({
      success: true,
      // getDonationWithdrawals уже ORDER BY created_at DESC — sort убран.
      data: donationWds,
      balance,
      commission: { rate, tier },
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /donations/withdrawals — создать заявку на вывод ──
// body: { amount: number, paymentMethod?: string, paymentDetails?: any }
// Минимум 1000 ₽. Комиссия зависит от тарифа артиста (10/7/5/3%
// для spark/start/pro/elite — см. resolveDonationCommissionRate).
// POST /donations/withdrawals — sync autopayout через ЮКассу.
//
// До: артист подавал заявку → INSERT pending → админ платил руками.
// После: артист жмёт «Вывести» → backend сразу зовёт YK Payouts API
// (zerкалит dj-studio-routes.tsx:1298) → ответ donor'у с реальным
// status (succeeded / pending / failed).
//
// Body shape:
//   amount: number               — РУБли, мин 1000
//   method: 'sbp'|'yoomoney'|'card'
//   phone?: string               — для sbp (+7XXXXXXXXXX)
//   account?: string             — для yoomoney (15-20 цифр)
//   payoutToken?: string         — для card (PCI-safe токен от YK widget)
//   cardLast4?: string           — для card (UI label, не критично)
//
// Что должно стать правдой после merge:
//   - Артист с balance >= 1000 ₽ жмёт «Вывести 1000 ₽ на СБП +79991234567»
//     → POST /donations/withdrawals → 201 со status 'succeeded'/'pending',
//     yooPayoutId сохранён.
//   - При повторном клике с тем же app_id (idempotenceKey) — YK
//     возвращает существующую выплату, ON CONFLICT (user_id, app_id)
//     срабатывает, дубля нет.
//   - При YK 4xx/5xx — 502, INSERT с status='failed' + error message,
//     ничего не списано с баланса (commission_rate / payout записаны
//     для отчётности; реального движения денег не было).
donationsRoutes.post('/withdrawals', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const amount = Number(body.amount);
    const method = String(body.method || 'sbp');

    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ success: false, error: 'amount must be > 0' }, 400);
    }
    if (amount < 1000) {
      return c.json({ success: false, error: 'Минимальная сумма вывода — 1000 ₽' }, 400);
    }
    if (!['sbp', 'yoomoney', 'card'].includes(method)) {
      return c.json({ success: false, error: 'Недопустимый способ вывода (sbp/yoomoney/card)' }, 400);
    }

    // Валидация destination по methodу — зеркало dj-studio-routes.tsx:1241.
    let destination: any;
    let destinationLabel = '';
    if (method === 'sbp') {
      // Нормализуем СРАЗУ: выкидываем всё кроме цифр и ведущего «+».
      // Это чинит две вещи: (1) пользователь вводит «+7 (999) 123-45-67»
      // — раньше .replace(/\s/g) убирал только пробелы, скобки/дефисы
      // валили валидацию; (2) маскировка ниже требует непрерывных цифр —
      // на номере с пробелами regex не матчился и в destination_label
      // (→ UI/логи) утекал ПОЛНЫЙ номер артиста.
      const phone = String(body.phone || '').replace(/[^\d+]/g, '');
      if (!/^\+?\d{10,15}$/.test(phone)) {
        return c.json({ success: false, error: 'Укажите телефон в формате +7…' }, 400);
      }
      destination = { type: 'sbp', phone };
      destinationLabel = `СБП ${phone.replace(/(\+\d{1,3})\d+(\d{4})/, '$1***$2')}`;
    } else if (method === 'yoomoney') {
      const account = String(body.account || '').replace(/\D/g, '');
      if (!/^\d{11,20}$/.test(account)) {
        return c.json({ success: false, error: 'Укажите номер кошелька ЮMoney (только цифры)' }, 400);
      }
      destination = { type: 'yoo_money', account };
      destinationLabel = `ЮMoney …${account.slice(-4)}`;
    } else {
      // card — требует payoutToken (PCI-токен от виджета YK на фронте).
      // Мы НИКОГДА не принимаем PAN в открытом виде — это PCI DSS scope.
      const payoutToken = String(body.payoutToken || '');
      const cardLast4 = String(body.cardLast4 || '').slice(0, 4);
      if (!payoutToken) {
        return c.json({
          success: false,
          error: 'Для вывода на карту нужен payoutToken (токенизация через ЮКасса-виджет)',
        }, 400);
      }
      destination = { type: 'bank_card', payoutToken };
      destinationLabel = cardLast4 ? `Карта …${cardLast4}` : 'Карта';
    }

    const balance = await getDonationBalance(userId);
    if (amount > balance) {
      return c.json({
        success: false,
        error: `Недостаточно средств. Доступно: ${balance} ₽`,
        balance,
      }, 400);
    }

    // Tier-aware commission. spark=10%, start=7%, pro=5%, elite=3%.
    // The rate is resolved server-side from the artist's active
    // subscription — the request body cannot influence it.
    const { rate: commissionRate, tier } = await resolveDonationCommissionRate(String(userId || ''));
    const commission = Math.round(amount * commissionRate * 100) / 100;
    const payout = Math.round((amount - commission) * 100) / 100;
    const id = `wd-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    // Self-heal native columns added by migration 103. Защита от deploy-
    // ordering — если миграция ещё не накачена, ALTER IF NOT EXISTS
    // добавит их при первом запросе.
    await ensureSchemaInline(
      'payment_withdrawals:autopayout_cols',
      `ALTER TABLE payment_withdrawals
        ADD COLUMN IF NOT EXISTS yoo_payout_id     TEXT,
        ADD COLUMN IF NOT EXISTS destination_label TEXT,
        ADD COLUMN IF NOT EXISTS error             TEXT,
        ADD COLUMN IF NOT EXISTS requested_at      TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS paid_at           TIMESTAMPTZ`,
    );

    // Сначала пытаемся создать выплату — только при успехе записываем
    // succeeded/pending row. На фейле — INSERT failed-row, чтобы артист
    // видел что произошло, и возвращаем 502.
    let payoutId = '';
    let payoutStatus: 'pending' | 'succeeded' | 'canceled' = 'pending';
    try {
      const { createYooKassaPayout } = await import('./gateway-yookassa-payouts.tsx');
      const result = await createYooKassaPayout({
        amountRub: payout,  // выплачиваем payout (после commission), не gross amount
        destination,
        description: `Выплата донатов артисту ${userId}`,
        idempotenceKey: id,
        metadata: { withdrawal_id: id, artist_id: userId, source: 'donation', commission, commission_rate: commissionRate },
      });
      payoutId = result.id;
      payoutStatus = (result.status as any) === 'succeeded' ? 'succeeded'
        : (result.status as any) === 'canceled' ? 'canceled' : 'pending';
    } catch (payoutErr: any) {
      console.error('YooKassa donation payout failed:', payoutErr);
      const errMsg = payoutErr?.message || 'Не удалось создать выплату';
      // Logging failed row — артист видит «не получилось, ошибка X».
      // INSERT атомарно, никакого race condition.
      await pool.query(
        `INSERT INTO payment_withdrawals
           (app_id, user_id, source, amount, commission, commission_rate,
            commission_tier, payout, payment_method, destination_label,
            status, error, requested_at)
         VALUES ($1, $2, 'donation', $3, $4, $5, $6, $7, $8, $9, 'failed', $10, $11)
         ON CONFLICT (user_id, app_id) DO NOTHING`,
        [id, userId, amount, commission, commissionRate, tier, payout,
         method, destinationLabel, errMsg, now]
      );
      return c.json({ success: false, error: errMsg }, 502);
    }

    // Успешный (или pending) payout — записываем с yoo_payout_id.
    // payment_details оставляем NULL (raw destination содержит token/
    // phone — не храним в БД даже зашифрованным; destination_label —
    // достаточно для UI).
    await pool.query(
      `INSERT INTO payment_withdrawals
         (app_id, user_id, source, amount, commission, commission_rate,
          commission_tier, payout, payment_method, destination_label,
          status, yoo_payout_id, requested_at, paid_at)
       VALUES ($1, $2, 'donation', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (user_id, app_id) DO NOTHING`,
      [id, userId, amount, commission, commissionRate, tier, payout,
       method, destinationLabel, payoutStatus, payoutId, now,
       payoutStatus === 'succeeded' ? now : null]
    );

    const response = {
      id,
      source: 'donation',
      userId,
      amount,
      commission,
      commissionRate,
      commissionTier: tier,
      payout,
      paymentMethod: method,
      destinationLabel,
      status: payoutStatus,
      yooPayoutId: payoutId,
      requestedAt: now,
      createdAt: now,
    };

    return c.json({
      success: true,
      data: response,
      balance: balance - amount,
    }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /donations — create a pending donation and route to payment gateway ──
// PUBLIC (optionalAuth): донатить может ЛЮБОЙ — фанат/слушатель без аккаунта.
// Раньше стоял requireAuth → незалогиненный получал 401 «Authorization required»
// → платёж не создавался → кнопка «Поддержать» «не перекидывала» на ЮKassa.
// Залогинен → donorId = его id; аноним → donorId = null (+ donorName/isAnonymous из body).
donationsRoutes.post('/', optionalAuth, async (c) => {
  try {
    const userId = c.get('userId') || null;
    const body = await c.req.json();
    const donationId = `donation-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    if (!body.amount || body.amount <= 0) {
      return c.json({ success: false, error: 'Amount must be > 0' }, 400);
    }
    if (body.amount > 100000) {
      return c.json({ success: false, error: 'Max donation amount is 100000 RUB' }, 400);
    }
    if (!body.artistId) {
      return c.json({ success: false, error: 'artistId required' }, 400);
    }

    // Optional per-track donation. Allows the artist's analytics to
    // surface «доната пришло на этот трек» as a separate line item.
    // When omitted, donation lives only at artist level (old shape).
    const trackId: string | null = body.trackId ? String(body.trackId) : null;

    const { status: _s, ...safeBody } = body;

    const donation: any = {
      id: donationId,
      ...safeBody,
      status: 'pending_payment',
      artistId: body.artistId,
      trackId,                          // null when no track context
      donorId: userId,
      createdAt: now,
    };

    await db.createDonation(donation.artistId, donationId, donation);

    try {
      const { getGateway } = await import('./payment-gateway.tsx');
      const { upsertPaymentSession } = await import('./db.tsx');
      const gateway = body.paymentMethod === 'sbp' ? 'tbank' : 'yookassa';
      const gw = getGateway(gateway);
      const orderId = crypto.randomUUID();
      const returnUrl = `https://promo-music.ru/cabinet/donations?payment=success&donationId=${donationId}`;
      const donorLabel = body.isAnonymous ? 'Anonymous' : (body.donorName || 'Listener');

      const result = await gw.createPayment({
        orderId,
        amount: body.amount,
        currency: 'RUB',
        description: `Donation for artist from ${donorLabel}`,
        returnUrl,
        metadata: {
          type: 'donation',
          donationId,
          artistId: body.artistId,
          ...(trackId ? { trackId } : {}),
          donorName: donorLabel,
          isAnonymous: String(body.isAnonymous || false),
          // message: сопровождающий текст доната. Без него webhook читал
          // session.metadata.message → undefined → '' → текст терялся.
          // Обрезаем до 500 символов чтобы metadata не пухла.
          ...(body.message ? { message: String(body.message).slice(0, 500) } : {}),
        },
      });

      await upsertPaymentSession(orderId, {
        orderId,
        userId,
        gateway,
        gatewayPaymentId: result.paymentId || result.sessionId,
        amount: body.amount,
        currency: 'RUB',
        status: 'pending',
        type: 'donation',
        description: `Donation for artist from ${donorLabel}`,
        metadata: {
          donationId,
          artistId: body.artistId,
          ...(trackId ? { trackId } : {}),
          donorName: donorLabel,
          isAnonymous: String(body.isAnonymous || false),
          // см. коммент выше — message должен дожить до webhook fulfillment.
          ...(body.message ? { message: String(body.message).slice(0, 500) } : {}),
        },
        savePaymentMethod: false,
        confirmationUrl: result.confirmationUrl,
        returnUrl,
        createdAt: now,
      });

      donation.paymentOrderId = orderId;
      donation.status = 'pending_payment';
      await db.createDonation(donation.artistId, donationId, donation);

      return c.json({
        success: true,
        data: {
          ...donation,
          orderId,
          confirmationUrl: result.confirmationUrl,
        },
      }, 201);
    } catch (payErr: any) {
      console.error('[donations] Payment session error:', payErr);
      return c.json({
        success: true,
        data: donation,
        paymentError: 'Payment gateway unavailable, donation saved as pending',
      }, 201);
    }
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default donationsRoutes;
