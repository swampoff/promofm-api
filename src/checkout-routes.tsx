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
import { createCoinTransactionKv, deletePaymentMethod, getCoinBalance, getPaymentBalance, getPaymentMethods, getPaymentSession, setCoinBalance, upsertPaymentBalance, upsertPaymentMethod, upsertPaymentSession, paymentTransactionsStore, paymentWebhookLogsStore } from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import {
  getGateway,
  type GatewayName,
  type PaymentSession,
  type PaymentType,
  type SavedPaymentMethod,
  type WebhookPayload,
} from './payment-gateway.tsx';

const checkoutRoutes = new Hono();
const FALLBACK_USER = 'anonymous';

// ── Helper: process successful payment ──

async function processPaymentSuccess(session: PaymentSession, webhook: WebhookPayload) {
  const now = new Date().toISOString();

  // Update session
  session.status = 'succeeded';
  session.completedAt = now;
  if (webhook.paymentMethodId) {
    session.savedMethodId = webhook.paymentMethodId;
  }
  await upsertPaymentSession(session.orderId, session);

  // Record transaction
  const transaction = {
    id: `tx-${session.orderId}`,
    userId: session.userId,
    orderId: session.orderId,
    type: 'income' as const,
    category: session.type,
    amount: session.amount,
    currency: session.currency,
    gateway: session.gateway,
    description: session.description,
    metadata: session.metadata,
    status: 'completed',
    createdAt: now,
  };

  // Save to user transactions
  const existing = (await paymentTransactionsStore.get(session.userId)) || [];
  existing.unshift(transaction);
  await paymentTransactionsStore.set(session.userId, existing);

  // Update user balance for donations/topups
  if (session.type === 'donation' || session.type === 'topup') {
    const targetUserId = session.type === 'donation'
      ? (session.metadata.artistId || session.userId)
      : session.userId;

    const balance = (await getPaymentBalance(targetUserId)) || { available: 0, pending: 0, total: 0 };
    balance.available += session.amount;
    balance.total += session.amount;
    await upsertPaymentBalance(targetUserId, balance);
  }

  // Topup coins
  if (session.type === 'topup' && session.metadata.coinAmount) {
    const coinAmount = parseInt(session.metadata.coinAmount);
    if (coinAmount > 0) {
      const coinBal = (await getCoinBalance(session.userId)) || { balance: 0, userId: session.userId };
      coinBal.balance += coinAmount;
      await setCoinBalance(session.userId, coinBal.balance);

      // Coin transaction
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
    console.warn('Revenue recording skipped:', err);
  }

  console.log(`Payment completed: ${session.orderId} (${session.gateway}) ${session.amount} ${session.currency}`);
}

async function processPaymentCanceled(session: PaymentSession) {
  session.status = 'canceled';
  session.completedAt = new Date().toISOString();
  await upsertPaymentSession(session.orderId, session);
  console.log(`Payment canceled: ${session.orderId}`);
}

// ── POST /create-session ──

checkoutRoutes.post('/create-session', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const body = await c.req.json();

    const { gateway, amount, type, description, returnUrl, savePaymentMethod, metadata } = body;

    // Validate
    if (!gateway || !['yookassa', 'tbank', 'stripe'].includes(gateway)) {
      return c.json({ success: false, error: 'Укажите gateway: "yookassa", "tbank" или "stripe"' }, 400);
    }
    if (!amount || amount <= 0) {
      return c.json({ success: false, error: 'Сумма должна быть больше 0' }, 400);
    }
    if (!type || !['purchase', 'subscription', 'donation', 'topup'].includes(type)) {
      return c.json({ success: false, error: 'Укажите type: purchase, subscription, donation или topup' }, 400);
    }
    if (!returnUrl) {
      return c.json({ success: false, error: 'returnUrl обязателен' }, 400);
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
    console.error('Error in POST /create-session:', error);
    return c.json({ success: false, error: 'Payment session creation failed' }, 500);
  }
});

// ── GET /session/:orderId ──

checkoutRoutes.get('/session/:orderId', async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const session = await getPaymentSession(orderId);

    if (!session) {
      return c.json({ success: false, error: 'Сессия не найдена' }, 404);
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
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── GET /methods ──

checkoutRoutes.get('/methods', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const methods = await getPaymentMethods(userId);
    return c.json({ success: true, data: methods || [] });
  } catch (error: any) {
    return c.json({ success: true, data: [] });
  }
});

// ── DELETE /methods/:id ──

checkoutRoutes.delete('/methods/:id', async (c) => {
  try {
    const methodId = c.req.param('id');
    const userId = await resolveUserId(c, FALLBACK_USER);
    await deletePaymentMethod(methodId);
    return c.json({ success: true, message: 'Способ оплаты удалён' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── POST /webhook/yookassa (NO AUTH) ──

checkoutRoutes.post('/webhook/yookassa', async (c) => {
  try {
    const body = await c.req.json();
    console.log('YooKassa webhook received:', JSON.stringify(body).slice(0, 500));

    // Log raw webhook
    const webhookOrderId = body?.object?.metadata?.order_id;
    if (webhookOrderId) {
      await paymentWebhookLogsStore.set(webhookOrderId, { body, receivedAt: new Date().toISOString() });
    }

    const gw = getGateway('yookassa');
    const payload = await gw.verifyWebhook(c.req.raw, body);

    if (!payload) {
      console.warn('YooKassa webhook: verification failed');
      return c.json({ success: false, error: 'Verification failed' }, 400);
    }

    // Find session
    const session = await getPaymentSession(payload.orderId) as PaymentSession | null;
    if (!session) {
      console.warn('YooKassa webhook: session not found for orderId', payload.orderId);
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    // Idempotency: skip if already processed
    if (session.status !== 'pending') {
      console.log('YooKassa webhook: session already processed', session.status);
      return c.json({ success: true, message: 'Already processed' });
    }

    if (payload.eventType === 'payment.succeeded') {
      await processPaymentSuccess(session, payload);
    } else if (payload.eventType === 'payment.canceled') {
      await processPaymentCanceled(session);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('YooKassa webhook error:', error);
    return c.json({ success: false, error: 'Webhook processing failed' }, 500);
  }
});

// ── POST /webhook/tbank (NO AUTH) ──

checkoutRoutes.post('/webhook/tbank', async (c) => {
  try {
    const body = await c.req.json();
    console.log('TBank webhook received:', JSON.stringify(body).slice(0, 500));

    // Log raw webhook
    if (body.OrderId) {
      await paymentWebhookLogsStore.set(body.OrderId, { body, receivedAt: new Date().toISOString() });
    }

    const gw = getGateway('tbank');
    const payload = await gw.verifyWebhook(c.req.raw, body);

    if (!payload) {
      console.warn('TBank webhook: verification failed');
      // T-Bank expects "OK" even on error to stop retries
      return c.text('OK');
    }

    // Find session
    const session = await getPaymentSession(payload.orderId) as PaymentSession | null;
    if (!session) {
      console.warn('TBank webhook: session not found for orderId', payload.orderId);
      return c.text('OK');
    }

    // Idempotency
    if (session.status !== 'pending') {
      return c.text('OK');
    }

    if (payload.eventType === 'payment.succeeded') {
      await processPaymentSuccess(session, payload);
    } else if (payload.eventType === 'payment.canceled') {
      await processPaymentCanceled(session);
    } else if (payload.eventType === 'payment.refunded') {
      session.status = 'refunded';
      session.completedAt = new Date().toISOString();
      await upsertPaymentSession(session.orderId, session);
    }

    // T-Bank requires "OK" as response
    return c.text('OK');
  } catch (error: any) {
    console.error('TBank webhook error:', error);
    return c.text('OK');
  }
});

// ── POST /webhook/stripe (NO AUTH) ──

checkoutRoutes.post('/webhook/stripe', async (c) => {
  try {
    const body = await c.req.json();
    console.log('Stripe webhook received:', body.type, JSON.stringify(body).slice(0, 500));

    // Log raw webhook
    const orderId = body?.data?.object?.metadata?.order_id;
    if (orderId) {
      await paymentWebhookLogsStore.set(orderId, { body, receivedAt: new Date().toISOString() });
    }

    const gw = getGateway('stripe');
    const payload = await gw.verifyWebhook(c.req.raw, body);

    if (!payload) {
      console.warn('Stripe webhook: verification failed');
      return c.json({ success: false, error: 'Verification failed' }, 400);
    }

    // Find session
    const session = await getPaymentSession(payload.orderId) as PaymentSession | null;
    if (!session) {
      console.warn('Stripe webhook: session not found for orderId', payload.orderId);
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    // Idempotency: skip if already processed
    if (session.status !== 'pending') {
      console.log('Stripe webhook: session already processed', session.status);
      return c.json({ success: true, message: 'Already processed' });
    }

    if (payload.eventType === 'payment.succeeded') {
      await processPaymentSuccess(session, payload);
    } else if (payload.eventType === 'payment.canceled') {
      await processPaymentCanceled(session);
    } else if (payload.eventType === 'payment.refunded') {
      session.status = 'refunded';
      session.completedAt = new Date().toISOString();
      await upsertPaymentSession(session.orderId, session);
    }

    return c.json({ success: true, received: true });
  } catch (error: any) {
    console.error('Stripe webhook error:', error);
    return c.json({ success: false, error: 'Webhook processing failed' }, 500);
  }
});

// ── GET /plans — subscription plans ──

checkoutRoutes.get('/plans', async (c) => {
  return c.json({
    success: true,
    data: [
      {
        id: 'artist-basic',
        name: 'Артист Базовый',
        price: 299,
        currency: 'RUB',
        interval: 'month',
        features: ['Загрузка до 10 треков', 'Базовая аналитика', 'Профиль артиста'],
      },
      {
        id: 'artist-pro',
        name: 'Артист PRO',
        price: 799,
        currency: 'RUB',
        interval: 'month',
        features: ['Безлимитные треки', 'Расширенная аналитика', 'Приоритетная модерация', 'Промо-инструменты'],
      },
      {
        id: 'producer-basic',
        name: 'Продюсер',
        price: 499,
        currency: 'RUB',
        interval: 'month',
        features: ['Витрина битов', 'Портфолио', 'Маркетплейс услуг'],
      },
      {
        id: 'radio-station',
        name: 'Радиостанция',
        price: 1499,
        currency: 'RUB',
        interval: 'month',
        features: ['Управление эфиром', 'Рекламные слоты', 'Аналитика слушателей', 'Каталог артистов'],
      },
      {
        id: 'venue',
        name: 'Заведение',
        price: 999,
        currency: 'RUB',
        interval: 'month',
        features: ['Бронирования', 'Р��дио-кампании', 'Плейлисты', 'Статистика'],
      },
    ],
  });
});

export default checkoutRoutes;
