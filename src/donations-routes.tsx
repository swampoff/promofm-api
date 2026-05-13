import { Hono } from 'hono';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';

const donationsRoutes = new Hono();

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
    return c.json({ success: true, data: donations || [], balance });
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
    return c.json({
      success: true,
      data: donationWds.sort((a: any, b: any) =>
        String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''))
      ),
      balance,
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /donations/withdrawals — создать заявку на вывод ──
// body: { amount: number, paymentMethod?: string, paymentDetails?: any }
// Минимум 1000 ₽, комиссия 3%, проверка баланса.
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

    const commission = Math.round(amount * 0.03 * 100) / 100;
    const payout = Math.round((amount - commission) * 100) / 100;
    const id = `wd-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const request = {
      id,
      source: 'donation',
      userId,
      amount,
      commission,
      commissionRate: 0.03,
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

    const { status: _s, ...safeBody } = body;

    const donation: any = {
      id: donationId,
      ...safeBody,
      status: 'pending_payment',
      artistId: body.artistId,
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
