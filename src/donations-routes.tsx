import { Hono } from 'hono';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
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

async function getWithdrawalsList(userId: string): Promise<any[]> {
  const r = await pool.query(`SELECT data FROM payment_withdrawals WHERE user_id = $1`, [userId]);
  const raw = r.rows[0]?.data;
  return Array.isArray(raw) ? raw : [];
}

async function saveWithdrawalsList(userId: string, list: any[]): Promise<void> {
  await pool.query(
    `INSERT INTO payment_withdrawals (user_id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [userId, JSON.stringify(list)]
  );
}

async function getDonationBalance(artistId: string): Promise<number> {
  const dons = await db.getDonationsByArtist(artistId) as any[];
  const earned = (dons || [])
    .filter((d: any) => d?.status === 'completed' || d?.status === 'paid')
    .reduce((sum: number, d: any) => sum + (Number(d?.amount) || 0), 0);

  const wds = await getWithdrawalsList(artistId);
  const reserved = wds
    .filter((w: any) => w?.source === 'donation' && w?.status !== 'rejected' && w?.status !== 'cancelled')
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
    const list = await getWithdrawalsList(userId);
    const donationWds = list.filter((w: any) => w?.source === 'donation');
    const balance = await getDonationBalance(userId);
    const { rate, tier } = await resolveDonationCommissionRate(String(userId || ''));
    return c.json({
      success: true,
      data: donationWds.sort((a: any, b: any) =>
        String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''))
      ),
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
donationsRoutes.post('/withdrawals', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const amount = Number(body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ success: false, error: 'amount must be > 0' }, 400);
    }
    if (amount < 1000) {
      return c.json({ success: false, error: 'Минимальная сумма вывода — 1000 ₽' }, 400);
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

    const request = {
      id,
      source: 'donation',
      userId,
      amount,
      commission,
      commissionRate,
      commissionTier: tier,
      payout,
      paymentMethod: body.paymentMethod || 'card',
      paymentDetails: body.paymentDetails || null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    const list = await getWithdrawalsList(userId);
    list.unshift(request);
    await saveWithdrawalsList(userId, list);

    return c.json({
      success: true,
      data: request,
      balance: balance - amount,
    }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /donations — create a pending donation and route to payment gateway ──
donationsRoutes.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
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
