import { Hono } from 'hono';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';

const coinsRoutes = new Hono();

// GET /coins/balance
coinsRoutes.get('/balance', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const balance = await db.getCoinBalance(userId);
    return c.json({ success: true, data: balance || { balance: 0, userId } });
  } catch (error) {
    return c.json({ success: true, data: { balance: 0 } });
  }
});

// GET /coins/transactions
coinsRoutes.get('/transactions', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const txns = await db.getCoinTransactions(userId);
    return c.json({ success: true, data: txns || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// POST /coins/transactions
coinsRoutes.post('/transactions', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const txId = `cointx-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const transaction = {
      id: txId,
      userId,
      amount: body.amount || 0,
      type: (body.type === 'expense' || body.type === 'refund') ? body.type : 'expense', // Users cannot create 'reward' transactions
      description: body.description || '',
      createdAt: now,
    };

    // Update balance
    const current = await db.getCoinBalance(userId);
    const currentBalance = Number(current?.balance) || 0;
    // Users can only subtract coins (expense); positive additions require admin/webhook
    const safeAmount = transaction.type === 'expense' ? -Math.abs(Number(transaction.amount || 0)) : Number(transaction.amount || 0);
    const newBalance = currentBalance + safeAmount;
    await db.setCoinBalance(userId, newBalance);

    // Save transaction
    await db.createCoinTransaction(userId, txId, transaction);

    return c.json({ success: true, data: { transaction, balance: newBalance } }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /coins/topup — create payment session to buy coins
const COINS_PER_RUBLE = 10;

coinsRoutes.post('/topup', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const { gateway, amount, returnUrl } = body;

    // Validate returnUrl — prevent open redirect
    if (returnUrl) {
      const ALLOWED_ORIGINS = ['https://promo-music.ru', 'https://www.promo-music.ru', 'https://promofm.org'];
      try {
        const returnOrigin = new URL(returnUrl).origin;
        if (!ALLOWED_ORIGINS.includes(returnOrigin)) {
          return c.json({ success: false, error: 'returnUrl must be on promo-music.ru' }, 400);
        }
      } catch {
        return c.json({ success: false, error: 'Invalid returnUrl format' }, 400);
      }
    }

    if (!gateway || !['yookassa', 'tbank'].includes(gateway)) {
      return c.json({ success: false, error: 'Укажите gateway: "yookassa" или "tbank"' }, 400);
    }
    if (!amount || amount < 10) {
      return c.json({ success: false, error: 'Минимальная сумма пополнения — 10 ₽' }, 400);
    }

    const coinAmount = Math.floor(amount * COINS_PER_RUBLE);

    const { getGateway } = await import('./payment-gateway.tsx');
    const gw = getGateway(gateway);
    const orderId = crypto.randomUUID();

    const result = await gw.createPayment({
      amount,
      currency: 'RUB',
      description: `Пополнение баланса: ${coinAmount} монет`,
      gateway,
      userId,
      orderId,
      returnUrl: returnUrl || 'https://promo-music.ru/cabinet/coins?payment=result',
      metadata: { coinAmount: String(coinAmount), type: 'topup' },
      savePaymentMethod: false,
      type: 'topup',
    });

    // Save session
    await db.upsertPaymentSession(orderId, {
      orderId,
      userId,
      gateway,
      gatewayPaymentId: result.sessionId,
      amount,
      currency: 'RUB',
      status: 'pending',
      type: 'topup',
      description: `Пополнение баланса: ${coinAmount} монет`,
      metadata: { coinAmount: String(coinAmount) },
      savePaymentMethod: false,
      confirmationUrl: result.confirmationUrl,
      returnUrl: returnUrl || 'https://promo-music.ru/cabinet/coins?payment=result',
      createdAt: new Date().toISOString(),
    });

    return c.json({
      success: true,
      data: {
        orderId,
        confirmationUrl: result.confirmationUrl,
        coinAmount,
        rubleAmount: amount,
      },
    });
  } catch (error: any) {
    console.error('Error POST /coins/topup:', error);
    return c.json({ success: false, error: safeErrorMessage(error) || String(error) }, 500);
  }
});

export default coinsRoutes;
