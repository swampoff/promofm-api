import { Hono } from 'hono';
import * as db from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';

const coinsRoutes = new Hono();
const FALLBACK_USER = 'anonymous';

// GET /coins/balance
coinsRoutes.get('/balance', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const balance = await db.getCoinBalance(userId);
    return c.json({ success: true, data: balance || { balance: 0, userId } });
  } catch (error) {
    return c.json({ success: true, data: { balance: 0 } });
  }
});

// GET /coins/transactions
coinsRoutes.get('/transactions', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const txns = await db.getCoinTransactions(userId);
    return c.json({ success: true, data: txns || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// POST /coins/transactions
coinsRoutes.post('/transactions', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const body = await c.req.json();
    const txId = `cointx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const transaction = {
      id: txId,
      userId,
      amount: body.amount || 0,
      type: body.type || 'reward',
      description: body.description || '',
      createdAt: now,
    };

    // Update balance
    const current = await db.getCoinBalance(userId);
    const currentBalance = current?.balance || 0;
    const newBalance = currentBalance + (transaction.amount || 0);
    await db.setCoinBalance(userId, newBalance);

    // Save transaction
    await db.createCoinTransaction(userId, txId, transaction);

    return c.json({ success: true, data: { transaction, balance: newBalance } }, 201);
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// POST /coins/topup — create payment session to buy coins
const COINS_PER_RUBLE = 10;

coinsRoutes.post('/topup', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const body = await c.req.json();

    const { gateway, amount, returnUrl } = body;

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
      returnUrl: returnUrl || 'https://promo.music/payment/result',
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
      returnUrl: returnUrl || 'https://promo.music/payment/result',
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
    return c.json({ success: false, error: error.message || String(error) }, 500);
  }
});

export default coinsRoutes;
