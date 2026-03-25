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
import { createCoinTransactionKv, deletePaymentMethod, getCoinBalance, getPaymentBalance, getPaymentMethods, getPaymentSession, setCoinBalance, upsertPaymentBalance, upsertPaymentMethod, upsertPaymentSession, upsertSubscription, paymentTransactionsStore, paymentWebhookLogsStore } from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { safeErrorMessage } from './security.tsx';
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


  // ─── Activate subscription ───
  if (session.type === 'subscription' && session.metadata?.planKey) {
    try {
      const PLANS: Record<string, any> = {
        spark:  { name: 'Тест-драйв', price_month: 0,      credits_per_month: 0,  extra_mailing_price: 7000, discounts: { pitching: 0, marketing: 0, track_test: 0, banners: 0 }, donation_fee: 0.10, coins_bonus: 0 },
        start:  { name: 'Старт',       price_month: 8990,   credits_per_month: 1,  extra_mailing_price: 5000, discounts: { pitching: 0.05, marketing: 0.05, track_test: 0, banners: 0.05 }, donation_fee: 0.07, coins_bonus: 0.05 },
        pro:    { name: 'Про',         price_month: 39990,  credits_per_month: 3,  extra_mailing_price: 4000, discounts: { pitching: 0.10, marketing: 0.15, track_test: 0.10, banners: 0.10 }, donation_fee: 0.05, coins_bonus: 0.15 },
        elite:  { name: 'Бизнес',     price_month: 149990, credits_per_month: 10, extra_mailing_price: 3000, discounts: { pitching: 0.15, marketing: 0.25, track_test: 0.20, banners: 0.15 }, donation_fee: 0.03, coins_bonus: 0.25 },
      };
      const planKey = session.metadata.planKey;
      const plan = PLANS[planKey];
      if (plan) {
        const interval = session.metadata.interval || 'month';
        const daysToAdd = interval === 'year' ? 365 : 30;
        const expiresAt = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000).toISOString();
        const subData = {
          user_id: session.userId,
          tier: planKey,
          tierName: plan.name,
          price: session.amount,
          interval,
          expires_at: expiresAt,
          status: 'active',
          credits_remaining: plan.credits_per_month,
          credits_per_month: plan.credits_per_month,
          extra_mailing_price: plan.extra_mailing_price,
          discounts: plan.discounts,
          donation_fee: plan.donation_fee,
          coins_bonus: plan.coins_bonus,
          gateway: session.gateway,
          gateway_payment_id: session.gatewayPaymentId,
          created_at: now,
          updated_at: now,
        };
        await upsertSubscription(session.userId, subData);
        console.log('Subscription activated:', session.userId, '->', planKey, interval);
      }
    } catch (err) {
      console.error('Subscription activation error:', err);
    }
  }


  // ─── Fulfill marketplace purchase ───
  if (session.type === 'purchase' && session.metadata?.itemType) {
    try {
      const itemType = session.metadata.itemType;
      
      if (itemType === 'beat' && session.metadata.beatId) {
        // Fulfill beat purchase
        const { beatPurchasesStore, getBeat } = await import('./db.tsx');
        const beat = await getBeat(session.metadata.beatId);
        if (beat) {
          const purchase = {
            id: `bp_${Date.now()}`,
            beatId: session.metadata.beatId,
            beatTitle: beat.title || session.metadata.beatTitle || 'Beat',
            buyerId: session.userId,
            buyerName: session.metadata.buyerName || session.userId,
            sellerId: beat.producerId || session.metadata.sellerId || '',
            sellerName: beat.producerName || session.metadata.sellerName || '',
            price: session.amount,
            licenseType: session.metadata.licenseType || 'basic',
            status: 'completed',
            createdAt: now,
          };
          await beatPurchasesStore.set(purchase.id, purchase);
          console.log('Beat purchase fulfilled:', purchase.id, beat.title);
          
          // Notify seller via SSE
          if (beat.producerId) {
            try {
              const { emitSSE } = await import('./sse-routes.tsx');
              emitSSE(beat.producerId, 'beat_sold', { beatTitle: beat.title, price: session.amount, buyerName: purchase.buyerName });
            } catch {}
          }
        }
      }
      
      if (itemType === 'digital_good' && session.metadata.goodId) {
        // Fulfill digital good purchase
        const { digitalPurchasesStore } = await import('./db.tsx');
        const purchase = {
          id: `bp_${Date.now()}`,
          goodId: session.metadata.goodId,
          goodTitle: session.metadata.goodTitle || 'Digital Good',
          buyerId: session.userId,
          buyerName: session.metadata.buyerName || session.userId,
          sellerId: session.metadata.sellerId || '',
          price: session.amount,
          status: 'completed',
          createdAt: now,
        };
        await digitalPurchasesStore.set(purchase.id, purchase);
        console.log('Digital good purchase fulfilled:', purchase.id);
      }
      
      if (itemType === 'radio_campaign' && session.metadata.stationId) {
        // Create radio campaign after payment
        const { venueAdCampaignsStore } = await import('./db.tsx');
        const campaign = {
          id: `bp_${Date.now()}`,
          stationId: session.metadata.stationId,
          stationName: session.metadata.stationName || '',
          advertiserId: session.userId,
          packageType: session.metadata.packageType || 'standard',
          budget: session.amount,
          status: 'paid',
          startDate: session.metadata.startDate || new Date().toISOString().split('T')[0],
          endDate: session.metadata.endDate || '',
          targetPlays: parseInt(session.metadata.targetPlays || '0'),
          createdAt: now,
        };
        await venueAdCampaignsStore.set(campaign.id, campaign);
        console.log('Radio campaign created after payment:', campaign.id);
        
        // Notify station owner
        if (session.metadata.stationOwnerId) {
          try {
            const { emitSSE } = await import('./sse-routes.tsx');
            emitSSE(session.metadata.stationOwnerId, 'new_radio_campaign', { budget: session.amount, packageType: campaign.packageType });
          } catch {}
        }
      }
    } catch (err) {
      console.error('Marketplace purchase fulfillment error:', err);
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
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
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
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
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
