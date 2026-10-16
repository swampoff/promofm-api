import { Hono } from 'hono';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { isAllowedUrl, originFromRequest } from './site-origin.tsx';

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
      type: 'expense', // Users can only create expense transactions; topups/rewards via webhook only
      description: body.description || '',
      createdAt: now,
    };

    // Атомарное списание с полом (2026-07-02). Раньше get→set: (а) баланс мог
    // уйти в произвольный минус (спенд 500 при 100 → −400, но фулфилмент шёл);
    // (б) lost-update — два одновременных спенда по 100 при балансе 100 оба
    // читали 100 и оба писали 0 → товара на 200 за 100 коинов. Теперь одна
    // команда UPDATE ... WHERE balance >= amount закрывает оба вектора.
    const spend = Math.abs(Number(transaction.amount || 0));
    if (!Number.isFinite(spend) || spend <= 0) {
      return c.json({ success: false, error: 'Некорректная сумма' }, 400);
    }
    const newBalance = await db.debitCoinBalanceAtomic(userId, spend);
    if (newBalance === null) {
      return c.json({ success: false, error: 'Недостаточно коинов' }, 400);
    }

    // Save transaction (amount в истории остаётся положительным — контракт с FE)
    await db.createCoinTransaction(userId, txId, { ...transaction, amount: spend });

    return c.json({ success: true, data: { transaction: { ...transaction, amount: spend }, balance: newBalance } }, 201);
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

    // Validate returnUrl: prevent open redirect (только https на наши сайты, site-origin.tsx)
    if (returnUrl) {
      try {
        new URL(returnUrl);
      } catch {
        return c.json({ success: false, error: 'Invalid returnUrl format' }, 400);
      }
      if (!isAllowedUrl(returnUrl)) {
        return c.json({ success: false, error: 'returnUrl must be on promo-music.ru' }, 400);
      }
    }
    const defaultReturnUrl = `${originFromRequest(c)}/cabinet/coins?payment=result`;

    if (!gateway || !['yookassa', 'tbank'].includes(gateway)) {
      return c.json({ success: false, error: 'Укажите gateway: "yookassa" или "tbank"' }, 400);
    }
    if (!amount || amount < 10) {
      return c.json({ success: false, error: 'Минимальная сумма пополнения – 10 ₽' }, 400);
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
      returnUrl: returnUrl || defaultReturnUrl,
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
      returnUrl: returnUrl || defaultReturnUrl,
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
