/**
 * SUBSCRIPTIONS ROUTES
 * Управление подписками пользователей
 */

import { Hono } from 'hono';
import { getSubscription, upsertSubscription, getAllSubscriptions, getPaymentBalance, getPaymentMethods, upsertPaymentBalance, upsertPaymentSession, getPaymentSession, insertPaymentTx } from './db.tsx';
import { notifyAllAdmins, notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { emitSSE } from './sse-routes.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const subscriptions = new Hono();

const SUBSCRIPTION_PREFIX = 'subscription:';

/**
 * КАНОНИЧНАЯ СИСТЕМА ПОДПИСОК АРТИСТА (v19)
 * 
 * Кредитная модель: подписка даёт кредиты на рассылки + скидки на услуги.
 * Годовая оплата = 10 месяцев по цене (экономия ~17%).
 * 
 * | ID     | Название    | Мес.      | Год.        | Кредитов | Доп. рассылка |
 * |--------|-------------|-----------|-------------|----------|---------------|
 * | spark  | Тест-драйв  | 0 ₽       | -           | 0        | 7 000 ₽       |
 * | start  | Старт       | 8 990 ₽   | 89 900 ₽    | 1        | 5 000 ₽       |
 * | pro    | Про         | 39 990 ₽  | 399 900 ₽   | 3        | 4 000 ₽       |
 * | elite  | Бизнес      | 149 990 ₽ | 1 499 900 ₽ | 10       | 3 000 ₽       |
 */
// `tests_per_month` (added 2026-05-25 product decision) — quota of
// PromoLab track-tests included in each subscription. Was: separate
// product with 3 fake tiers (Express ₽990 / Pro ₽2990 / Premium ₽7990)
// on the landing and a hardcoded ₽3000 flat in track-test-routes
// regardless of which tier the artist "chose". Now: tests are a
// quota in the main subscription (like `credits_per_month` for
// mailings). Over-quota — flat 3000 ₽ (no track_test discount —
// the tier benefit is the quota itself, not a price discount on
// over-quota tests).
export const SUBSCRIPTION_PLANS = {
  spark: {
    name: 'Тест-драйв',
    price_month: 0,
    price_year: 0,
    credits_per_month: 0,
    tests_per_month: 0,
    extra_mailing_price: 7000,
    discounts: {
      // 'promotion' covers both pitching and marketing (release distribution
      // to playlists/curators + future DSP API integration). Was: two
      // separate keys `pitching` (5/10/15%) and `marketing` (5/15/25%);
      // merged 2026-05-25 to single bucket per product decision.
      // Code keeps backward-compat reads (subscription-pricing.tsx) for
      // existing subscription rows in DB that still carry the old keys.
      promotion: 0,
      banners: 0,
    },
    donation_fee: 0.10,
    coins_bonus: 0,
    description: 'Тест-драйв платформы. Профиль, загрузка треков, пресс-релиз для 1 трека, база знаний.',
  },
  start: {
    name: 'Старт',
    price_month: 8990,
    price_year: 89900,
    credits_per_month: 1,
    tests_per_month: 1,
    extra_mailing_price: 5000,
    discounts: {
      promotion: 0.05,
      banners: 0.05,
    },
    donation_fee: 0.07,
    coins_bonus: 0.05,
    description: 'Для старта и редких релизов. 1 рассылка + 1 тест трека/мес + скидки на продвижение.',
  },
  pro: {
    name: 'Про',
    price_month: 39990,
    price_year: 399900,
    credits_per_month: 3,
    tests_per_month: 3,
    extra_mailing_price: 4000,
    discounts: {
      promotion: 0.10,
      banners: 0.10,
    },
    donation_fee: 0.05,
    coins_bonus: 0.15,
    description: 'Для активных артистов. 3 рассылки + 3 теста трека/мес.',
  },
  elite: {
    name: 'Бизнес',
    price_month: 149990,
    price_year: 1499900,
    credits_per_month: 10,
    tests_per_month: 10,
    extra_mailing_price: 3000,
    discounts: {
      promotion: 0.15,
      banners: 0.15,
    },
    donation_fee: 0.03,
    coins_bonus: 0.25,
    description: 'Для лейблов, менеджеров и агентств. 10 рассылок + 10 тестов трека/мес.',
  },
};

/**
 * GET /subscriptions/plans
 * Получить все доступные планы подписок (каноничные)
 */
subscriptions.get('/plans', async (c) => {
  try {
    const plans = [
      {
        id: 'spark',
        name: 'Тест-драйв',
        price: 0,
        price_year: 0,
        currency: 'RUB',
        interval: 'month',
        credits_per_month: 0,
        tests_per_month: 0,
        extra_mailing_price: 7000,
        features: [
          'Профиль артиста',
          'Загрузка треков',
          'Пресс-релиз для 1 трека',
          'Доступ к базе знаний',
          'Комиссия 10% на донаты',
        ],
        color: 'gray',
      },
      {
        id: 'start',
        name: 'Старт',
        price: 8990,
        price_year: 89900,
        currency: 'RUB',
        interval: 'month',
        credits_per_month: 1,
        tests_per_month: 1,
        extra_mailing_price: 5000,
        features: [
          '1 рассылка/мес (экономия 28%)',
          '1 тест трека/мес включён',
          'Скидка 5% на продвижение',
          'Скидка 5% на баннеры',
          'Комиссия 7% на донаты',
          '+5% бонусных коинов',
        ],
        popular: false,
        color: 'green',
      },
      {
        id: 'pro',
        name: 'Про',
        price: 39990,
        price_year: 399900,
        currency: 'RUB',
        interval: 'month',
        credits_per_month: 3,
        tests_per_month: 3,
        extra_mailing_price: 4000,
        features: [
          '3 рассылки/мес (экономия 43%)',
          '3 теста трека/мес включено',
          'Скидка 10% на продвижение',
          'Скидка 10% на баннеры',
          'Комиссия 5% на донаты',
          '+15% бонусных коинов',
          'Приоритетная поддержка',
        ],
        popular: true,
        color: 'purple',
      },
      {
        id: 'elite',
        name: 'Бизнес',
        price: 149990,
        price_year: 1499900,
        currency: 'RUB',
        interval: 'month',
        credits_per_month: 10,
        tests_per_month: 10,
        extra_mailing_price: 3000,
        features: [
          '10 рассылок/мес (экономия 57%)',
          '10 тестов трека/мес включено',
          'Скидка 15% на продвижение',
          'Скидка 15% на баннеры',
          'Комиссия 3% на донаты',
          '+25% бонусных коинов',
          'Персональный менеджер',
        ],
        popular: false,
        color: 'yellow',
      },
    ];
    
    return c.json({
      success: true,
      plans
    });
  } catch (error) {
    console.error('Error loading plans:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to load plans' 
    }, 500);
  }
});

/**
 * POST /subscriptions/:userId/change-plan
 * Изменить план подписки
 */

/**
 * GET /subscriptions/:userId
 * Получить подписку пользователя
 */
subscriptions.get('/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  const userRole = c.get('userRole');
  if (userId !== authUserId && userRole !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
  
  try {
    const subscription = await getSubscription(userId);

    // Если подписки нет, создаём Тест-драйв (spark)
    if (!subscription) {
      const sparkSubscription = {
        user_id: userId,
        tier: 'spark',
        tierName: SUBSCRIPTION_PLANS.spark.name,
        price: 0,
        interval: 'month',
        expires_at: null,
        status: 'active',
        credits_remaining: 0,
        credits_per_month: 0,
        extra_mailing_price: SUBSCRIPTION_PLANS.spark.extra_mailing_price,
        discounts: SUBSCRIPTION_PLANS.spark.discounts,
        donation_fee: SUBSCRIPTION_PLANS.spark.donation_fee,
        coins_bonus: SUBSCRIPTION_PLANS.spark.coins_bonus,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await upsertSubscription(userId, sparkSubscription);
      return c.json({ success: true, data: sparkSubscription });
    }

    // Проверяем истечение подписки
    if (subscription.tier !== 'spark' && subscription.expires_at) {
      const expiresAt = new Date(subscription.expires_at);
      const now = new Date();

      if (now > expiresAt && subscription.status === 'active') {
        subscription.status = 'expired';
        subscription.tier = 'spark';
        subscription.tierName = SUBSCRIPTION_PLANS.spark.name;
        subscription.credits_remaining = 0;
        subscription.credits_per_month = 0;
        subscription.extra_mailing_price = SUBSCRIPTION_PLANS.spark.extra_mailing_price;
        subscription.discounts = SUBSCRIPTION_PLANS.spark.discounts;
        subscription.donation_fee = SUBSCRIPTION_PLANS.spark.donation_fee;
        subscription.coins_bonus = SUBSCRIPTION_PLANS.spark.coins_bonus;
        subscription.updated_at = new Date().toISOString();
        await upsertSubscription(userId, subscription);
      }
    }
    
    return c.json({ success: true, data: subscription });
  } catch (error) {
    console.error('Error loading subscription:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to load subscription' 
    }, 500);
  }
});

/**
 * POST /subscriptions/subscribe
 * Оформить/изменить подписку
 */
subscriptions.post('/subscribe', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const user_id = c.get('userId');
    const { tier, interval: requestedInterval } = body;
    
    if (!tier) {
      return c.json({ 
        success: false, 
        error: 'Missing required fields' 
      }, 400);
    }
    
    const plan = SUBSCRIPTION_PLANS[tier as keyof typeof SUBSCRIPTION_PLANS];
    if (!plan) {
      return c.json({ 
        success: false, 
        error: 'Invalid subscription tier' 
      }, 400);
    }
    
    const interval = requestedInterval === 'year' ? 'year' : 'month';
    const price = interval === 'year' ? plan.price_year : plan.price_month;

    // Paid plans require real payment via YooKassa
    if (price > 0) {
      try {
        const { getGateway } = await import('./payment-gateway.tsx');
        const gateway = getGateway('yookassa');
        const orderId = crypto.randomUUID();
        const returnUrl = `https://promo-music.ru/cabinet/subscription?payment=success&tier=${tier}`;
        const desc = `${plan.name} (${interval === 'year' ? 'year' : 'month'})`;

        const result = await gateway.createPayment({
          orderId,
          amount: price,
          currency: 'RUB',
          description: desc,
          returnUrl,
          gateway: 'yookassa',
          userId: user_id,
          type: 'subscription',
          metadata: { type: 'subscription', planKey: tier, interval },
        });

        await upsertPaymentSession(orderId, {
          orderId,
          userId: user_id,
          gateway: 'yookassa',
          gatewayPaymentId: result.sessionId,
          amount: price,
          currency: 'RUB',
          status: 'pending',
          type: 'subscription',
          description: desc,
          metadata: { planKey: tier, interval },
          savePaymentMethod: false,
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
      } catch (err) {
        console.error('[subscriptions] Payment session error:', err);
        return c.json({ success: false, error: 'Payment session creation failed' }, 500);
      }
    }

    // Free plan (spark): activate immediately
    const subscription = {
      user_id,
      tier,
      tierName: plan.name,
      price: 0,
      interval,
      expires_at: null,
      status: 'active',
      credits_remaining: plan.credits_per_month,
      credits_per_month: plan.credits_per_month,
      extra_mailing_price: plan.extra_mailing_price,
      discounts: plan.discounts,
      donation_fee: plan.donation_fee,
      coins_bonus: plan.coins_bonus,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await upsertSubscription(user_id, subscription);

    // ── Шаг 4: E2E платёж + уведомления ──

    // 1. Записываем платёжную транзакцию пользователя
    if (subscription.price > 0) {
      const txId = `tx-sub-${crypto.randomUUID()}`;
      const tx = {
        id: txId,
        userId: user_id,
        type: 'expense',
        category: 'subscription',
        amount: subscription.price,
        description: `Подписка «${plan.name}» (${interval === 'year' ? 'год' : 'мес'})`,
        metadata: { tier, interval },
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      await insertPaymentTx(tx);

      // Обновляем баланс
      const bal: any = (await getPaymentBalance(user_id)) || { userId: user_id, available: 0, pending: 0, total: 0 };
      bal.userId = user_id;
      bal.available -= subscription.price;
      bal.total = bal.available + (bal.pending || 0);
      await upsertPaymentBalance(user_id, bal);

      // 2. Записываем доход платформы (подписки = 100% платформе)
      try {
        await recordRevenue({
          channel: 'subscription',
          description: `Подписка «${plan.name}» (${interval}): ${user_id}`,
          grossAmount: subscription.price,
          platformRevenue: subscription.price,
          payoutAmount: 0,
          commissionRate: 1.0,
          payerId: user_id,
          payerName: user_id,
          metadata: { tier, interval, subscriptionId: txId },
        });
      } catch (e) {
        console.log('[subscriptions] recordRevenue warning:', e);
      }
    }

    // 3. SSE → юзеру: подписка обновлена
    emitSSE(user_id, {
      type: 'subscription_updated',
      data: {
        tier: subscription.tier,
        tierName: subscription.tierName,
        price: subscription.price,
        interval: subscription.interval,
        expiresAt: subscription.expires_at,
        creditsPerMonth: subscription.credits_per_month,
      },
    });

    // 4. Cross-cabinet → юзеру: уведомление о подписке
    try {
      // Определяем роль кабинета по user_id
      const cabinetRole = user_id.startsWith('dj') ? 'dj' as const
        : user_id.startsWith('radio') ? 'radio' as const
        : user_id.startsWith('venue') ? 'venue' as const
        : user_id.startsWith('producer') ? 'producer' as const
        : 'artist' as const;

      await notifyCrossCabinet({
        targetUserId: user_id,
        targetRole: cabinetRole,
        sourceRole: 'admin',
        type: 'subscription_updated',
        title: `Подписка «${plan.name}» активирована`,
        message: subscription.price > 0
          ? `Тариф «${plan.name}» активен до ${new Date(subscription.expires_at!).toLocaleDateString('ru-RU')}. ${plan.credits_per_month} рассылок/мес включено.`
          : `Бесплатный тариф «${plan.name}» активирован.`,
        metadata: { tier, interval, price: subscription.price },
      });

      // 5. Cross-cabinet → ВСЕМ админам (role-based broadcast)
      if (subscription.price > 0) {
        await notifyAllAdmins({
          sourceRole: cabinetRole,
          type: 'subscription_payment',
          title: `Новая подписка: ${plan.name}`,
          message: `Пользователь ${user_id} оформил подписку «${plan.name}» за ${subscription.price.toLocaleString()} ₽/${interval === 'year' ? 'год' : 'мес'}`,
          metadata: { userId: user_id, tier, interval, price: subscription.price },
        });
      }
    } catch (e) {
      console.log('[subscriptions] notification warning:', e);
    }

    // ── Конец E2E ──
    
    return c.json({ 
      success: true, 
      data: subscription 
    });
  } catch (error) {
    console.error('Error subscribing:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to subscribe' 
    }, 500);
  }
});

/**
 * POST /subscriptions/:userId/cancel
 * Отменить подписку
 */
subscriptions.post('/:userId/cancel', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  const userRole = c.get('userRole');
  if (userId !== authUserId && userRole !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
  
  try {
    const subscription = await getSubscription(userId);

    if (!subscription) {
      return c.json({
        success: false,
        error: 'Subscription not found'
      }, 404);
    }

    subscription.status = 'cancelled';
    subscription.updated_at = new Date().toISOString();
    await upsertSubscription(userId, subscription);
    
    // SSE + cross-cabinet при отмене
    emitSSE(userId, {
      type: 'subscription_updated',
      data: { tier: 'spark', tierName: 'Тест-драйв', status: 'cancelled' },
    });

    try {
      const role = userId.startsWith('dj') ? 'dj' as const
        : userId.startsWith('radio') ? 'radio' as const
        : userId.startsWith('venue') ? 'venue' as const
        : userId.startsWith('producer') ? 'producer' as const
        : 'artist' as const;

      await notifyCrossCabinet({
        targetUserId: userId, targetRole: role, sourceRole: 'admin',
        type: 'subscription_updated',
        title: 'Подписка отменена',
        message: `Подписка «${subscription.tierName || subscription.tier}» отменена. Доступ сохраняется до конца оплаченного периода.`,
        metadata: { tier: subscription.tier, status: 'cancelled' },
      });

      await notifyAllAdmins({
        sourceRole: role,
        type: 'subscription_payment',
        title: 'Отмена подписки',
        message: `Пользователь ${userId} отменил подписку «${subscription.tierName || subscription.tier}»`,
        metadata: { userId, tier: subscription.tier },
      });
    } catch (e) { console.log('[subscriptions] cancel notify warning:', e); }

    return c.json({ 
      success: true, 
      data: subscription 
    });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to cancel subscription' 
    }, 500);
  }
});

/**
 * GET /subscriptions/:userId/limits
 * Получить лимиты подписки (discounts, donation_fee, coins_bonus, credits)
 */
subscriptions.get('/:userId/limits', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  const userRole = c.get('userRole');
  if (userId !== authUserId && userRole !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
  
  try {
    const subscription = await getSubscription(userId);

    if (!subscription) {
      const sparkPlan = SUBSCRIPTION_PLANS.spark;
      return c.json({
        success: true,
        data: {
          credits_per_month: sparkPlan.credits_per_month,
          extra_mailing_price: sparkPlan.extra_mailing_price,
          discounts: sparkPlan.discounts,
          donation_fee: sparkPlan.donation_fee,
          coins_bonus: sparkPlan.coins_bonus,
        }
      });
    }

    return c.json({
      success: true,
      data: {
        credits_per_month: subscription.credits_per_month,
        credits_remaining: subscription.credits_remaining,
        extra_mailing_price: subscription.extra_mailing_price,
        discounts: subscription.discounts,
        donation_fee: subscription.donation_fee,
        coins_bonus: subscription.coins_bonus,
      }
    });
  } catch (error) {
    console.error('Error loading limits:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to load limits' 
    }, 500);
  }
});

/**
 * POST /subscriptions/:userId/check-limit
 * Проверить доступные кредиты рассылок
 */
subscriptions.post('/:userId/check-limit', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  if (userId !== authUserId) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
  
  try {
    const body = await c.req.json();
    const { feature } = body;
    
    const subscription = await getSubscription(userId);

    if (!subscription || subscription.tier === 'spark') {
      return c.json({ 
        success: true, 
        allowed: false,
        credits_remaining: 0,
        message: 'Для рассылок необходима подписка Старт или выше'
      });
    }
    
    const creditsRemaining = subscription.credits_remaining || 0;
    
    return c.json({ 
      success: true, 
      allowed: creditsRemaining > 0,
      credits_remaining: creditsRemaining,
      credits_per_month: subscription.credits_per_month,
      extra_mailing_price: subscription.extra_mailing_price,
    });
  } catch (error) {
    console.error('Error checking limit:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to check limit' 
    }, 500);
  }
});

/**
 * GET /subscriptions/:userId/current
 * Получить текущую подписку пользователя
 */
subscriptions.get('/:userId/current', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  const userRole = c.get('userRole');
  if (userId !== authUserId && userRole !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
  
  try {
    const subscription = await getSubscription(userId);

    if (!subscription) {
      // Return spark (Тест-драйв) plan as default
      return c.json({
        success: true,
        subscription: {
          id: 'spark_default',
          planId: 'spark',
          planName: 'Тест-драйв',
          status: 'active',
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          cancelAtPeriodEnd: false,
          price: 0,
          currency: 'RUB',
          interval: 'month',
          credits_remaining: 0,
          credits_per_month: 0,
        }
      });
    }
    
    return c.json({
      success: true,
      subscription
    });
  } catch (error) {
    console.error('Error loading subscription:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to load subscription' 
    }, 500);
  }
});


subscriptions.post('/:userId/change-plan', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  if (userId !== authUserId) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
  
  try {
    const body = await c.req.json();
    const { planId, interval } = body;
    
    if (!planId || !interval) {
      return c.json({
        success: false,
        error: 'Plan ID and interval are required'
      }, 400);
    }
    
    const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];
    if (!plan) {
      return c.json({
        success: false,
        error: 'Invalid plan ID'
      }, 400);
    }

    // Payment-gate (2026-07-02): раньше этот эндпоинт АКТИВИРОВАЛ любой платный
    // тариф без единого рубля (self-serve elite бесплатно) и вдобавок писал
    // фантомную выручку recordRevenue на неоплаченную сумму. Платные тарифы —
    // только через /subscribe (checkout → webhook активирует по факту оплаты).
    // Self-service здесь остаётся ТОЛЬКО для бесплатного тарифа (даунгрейд на
    // spark); админ может выставить любой тариф вручную (комп/саппорт).
    const requestedPrice = interval === 'year' ? plan.price_year : plan.price_month;
    const callerRole = c.get('userRole');
    const callerIsAdmin = callerRole === 'admin' || callerRole === 'superadmin';
    if (requestedPrice > 0 && !callerIsAdmin) {
      return c.json({
        success: false,
        error: 'Платный тариф активируется через оплату — используйте оформление подписки',
        code: 'PAYMENT_REQUIRED',
      }, 402);
    }

    const currentDate = new Date();
    const nextBillingDate = new Date(currentDate);
    nextBillingDate.setMonth(nextBillingDate.getMonth() + (interval === 'year' ? 12 : 1));
    
    const newSubscription = {
      id: `sub-${crypto.randomUUID()}`,
      planId,
      planName: plan.name,
      status: 'active',
      currentPeriodStart: currentDate.toISOString(),
      currentPeriodEnd: nextBillingDate.toISOString(),
      cancelAtPeriodEnd: false,
      price: interval === 'year' ? plan.price_year : plan.price_month,
      currency: 'RUB',
      interval,
      credits_per_month: plan.credits_per_month,
      credits_remaining: plan.credits_per_month,
      extra_mailing_price: plan.extra_mailing_price,
      discounts: plan.discounts,
      donation_fee: plan.donation_fee,
      coins_bonus: plan.coins_bonus,
    };
    
    await upsertSubscription(userId, newSubscription);

    // E2E: SSE + cross-cabinet уведомления при смене плана
    const price = newSubscription.price;

    if (price > 0) {
      // Только admin-ветка (см. payment-gate выше). Транзакция — след в истории.
      const txId = `tx-sub-${crypto.randomUUID()}`;
      const tx = {
        id: txId, userId, type: 'expense', category: 'subscription',
        amount: price, description: `Смена тарифа на «${plan.name}» (${interval === 'year' ? 'год' : 'мес'}, admin)`,
        metadata: { planId, interval, via: 'admin_change_plan' }, status: 'pending', createdAt: new Date().toISOString(),
      };
      await insertPaymentTx(tx);
      // recordRevenue УБРАН (2026-07-02): деньги через этот эндпоинт не
      // проходят — admin-комп не выручка. Реальная выручка подписок пишется
      // в checkout-webhook по факту оплаты.
    }

    emitSSE(userId, {
      type: 'subscription_updated',
      data: { tier: planId, tierName: plan.name, price, interval },
    });

    try {
      const role = userId.startsWith('dj') ? 'dj' as const
        : userId.startsWith('radio') ? 'radio' as const
        : userId.startsWith('venue') ? 'venue' as const
        : userId.startsWith('producer') ? 'producer' as const
        : 'artist' as const;

      await notifyCrossCabinet({
        targetUserId: userId, targetRole: role, sourceRole: 'admin',
        type: 'subscription_updated',
        title: `Тариф изменён на «${plan.name}»`,
        message: price > 0
          ? `Новый тариф «${plan.name}» активен. ${plan.credits_per_month} рассылок/мес.`
          : `Тариф «${plan.name}» активирован.`,
        metadata: { planId, interval, price },
      });

      if (price > 0) {
        await notifyAllAdmins({
          sourceRole: role,
          type: 'subscription_payment',
          title: `Смена тарифа: ${plan.name}`,
          message: `Пользователь ${userId} сменил тариф на «${plan.name}» за ${price.toLocaleString()} ₽`,
          metadata: { userId, planId, interval, price },
        });
      }
    } catch (e) { console.log('[subscriptions] notify warning:', e); }

    return c.json({
      success: true,
      subscription: newSubscription
    });
  } catch (error) {
    console.error('Error changing plan:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to change plan' 
    }, 500);
  }
});

// ───────────────────────���──────────────────────────────────────────────
// POST /subscriptions/charge-recurring  —  Cron endpoint for recurring charges
// Protected by X-Cron-Secret header
// ──────────────────────────────────────────────────────────────────────
subscriptions.post('/charge-recurring', async (c) => {
  try {
    // Verify cron secret
    const cronSecret = c.req.header('X-Cron-Secret') || c.req.header('Authorization')?.replace('Bearer ', '');
    const expectedSecret = process.env.CRON_SECRET;
    if (!expectedSecret) {
      console.error('CRON_SECRET env var not set');
      return c.json({ success: false, error: 'Server misconfiguration' }, 500);
    }

    if (cronSecret !== expectedSecret) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }

    const results: any[] = [];
    const now = new Date();
    const soonThreshold = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days from now

    // Get all subscriptions (limit to 500 to avoid timeout)
    const allSubEntries = await getAllSubscriptions(500);
    if (!allSubEntries || allSubEntries.length === 0) {
      return c.json({ success: true, message: 'No subscriptions to process', results: [] });
    }

    let charged = 0;
    let expired = 0;
    let skipped = 0;

    for (const entry of allSubEntries) {
      const sub = entry.value;
      // Skip spark (free) tier
      if (sub.tier === 'spark' || sub.planId === 'spark') continue;
      // Skip non-active
      if (sub.status !== 'active') { skipped++; continue; }

      const expiresAt = new Date(sub.expires_at || sub.currentPeriodEnd);
      if (isNaN(expiresAt.getTime())) { skipped++; continue; }

      // Check if subscription is about to expire (within 3 days) or already expired
      if (expiresAt > soonThreshold) { skipped++; continue; }

      const userId = sub.user_id || sub.userId || entry.key.replace(SUBSCRIPTION_PREFIX, '');
      if (!userId) { skipped++; continue; }

      // Check for saved payment method
      const methods = await getPaymentMethods(userId);
      const savedMethod = methods?.[0];

      if (!savedMethod) {
        // No saved payment method — mark subscription as expiring
        if (expiresAt <= now) {
          // Already expired — downgrade to spark
          sub.status = 'expired';
          sub.tier = 'spark';
          sub.tierName = SUBSCRIPTION_PLANS.spark.name;
          sub.credits_remaining = 0;
          sub.credits_per_month = 0;
          sub.updated_at = now.toISOString();
          await upsertSubscription(userId, sub);
          expired++;
          results.push({ userId, action: 'expired', reason: 'no_payment_method' });

          // Notify user
          emitSSE(userId, {
            type: 'subscription_updated',
            data: { tier: 'spark', tierName: 'Тест-драйв', status: 'expired' },
          });
        } else {
          skipped++;
          results.push({ userId, action: 'skipped', reason: 'expiring_soon_no_method', expiresAt: expiresAt.toISOString() });
        }
        continue;
      }

      // Attempt recurring charge
      try {
        const { getGateway } = await import('./payment-gateway.tsx');
        const gateway = getGateway(savedMethod.gateway);

        const tier = sub.tier || sub.planId;
        const plan = SUBSCRIPTION_PLANS[tier as keyof typeof SUBSCRIPTION_PLANS];
        if (!plan || plan.price_month === 0) { skipped++; continue; }

        const interval = sub.interval || 'month';
        const amount = interval === 'year' ? plan.price_year : plan.price_month;

        // Deterministic orderId per renewal cycle + day-stamp (2026-07-02).
        // orderId = Idempotence-Key у YooKassa: crash между charge и session-save
        // внутри суток схлопывается в один платёж. Day-stamp нужен потому, что
        // ключ ТОЛЬКО по expiresAt после ОТКАЗА карты возвращал тот же
        // canceled-платёж на все ретраи в окне ключа (~24ч) — починивший карту
        // подписчик не мог продлиться до конца grace-периода. День в ключе:
        // idempotent внутри суток, свежий ключ на завтрашний прогон.
        const dayStamp = now.toISOString().slice(0, 10);
        const orderId = `renew-${userId}-${expiresAt.getTime()}-${dayStamp}`;
        const prior = await getPaymentSession(orderId) as any;
        if (prior && (prior.status === 'succeeded' || prior.status === 'processing')) {
          skipped++;
          results.push({ userId, action: 'skipped', reason: `renewal_already_${prior.status}`, orderId });
          continue;
        }

        const chargeResult = await gateway.chargeRecurring({
          amount,
          currency: 'RUB',
          paymentMethodId: savedMethod.gatewayMethodId,
          orderId,
          description: `Продление подписки «${plan.name}» (${interval === 'year' ? 'год' : 'мес'})`,
          userId,
        });

        // Реальный исход списания (YooKassa off-session capture:true резолвится
        // синхронно). Раньше тут хардкодили 'pending' и продлевали ВСЕГДА —
        // отклонённая карта = бесплатный период + фантом-выручка.
        const chargeStatus = chargeResult.status; // 'succeeded' | 'canceled' | 'pending'

        // Save payment session с РЕАЛЬНЫМ статусом
        await upsertPaymentSession(orderId, {
          orderId,
          userId,
          gateway: savedMethod.gateway,
          gatewayPaymentId: chargeResult.sessionId,
          amount,
          currency: 'RUB',
          status: chargeStatus === 'succeeded' ? 'succeeded' : chargeStatus === 'canceled' ? 'canceled' : 'pending',
          type: 'subscription',
          description: `Продление подписки «${plan.name}»`,
          metadata: { tier, interval, recurring: 'true' },
          savePaymentMethod: false,
          confirmationUrl: '',
          returnUrl: 'https://promo-music.ru/cabinet',
          createdAt: now.toISOString(),
        });

        // Списание не подтверждено — НЕ продлеваем.
        if (chargeStatus === 'canceled') {
          // отказ карты — переиспользуем decline-обработку в catch ниже
          // (downgrade при уже-истёкшей подписке).
          throw new Error('recurring charge declined by gateway (canceled)');
        }
        if (chargeStatus !== 'succeeded') {
          // 'pending' (редкий 3DS/async) — не продлеваем; следующий прогон через
          // Idempotence-Key вернёт уже резолвленный платёж и продлит при успехе.
          skipped++;
          results.push({ userId, action: 'charge_pending', orderId });
          continue;
        }

        // Extend subscription period
        const daysToAdd = interval === 'year' ? 365 : 30;
        const newExpiry = new Date(Math.max(expiresAt.getTime(), now.getTime()) + daysToAdd * 24 * 60 * 60 * 1000);
        sub.expires_at = newExpiry.toISOString();
        sub.currentPeriodEnd = newExpiry.toISOString();
        sub.currentPeriodStart = now.toISOString();
        sub.credits_remaining = plan.credits_per_month;
        sub.updated_at = now.toISOString();
        await upsertSubscription(userId, sub);

        charged++;
        results.push({ userId, action: 'charged', amount, gateway: savedMethod.gateway, orderId, newExpiry: newExpiry.toISOString() });

        // Record transaction via the dedicated payment_txns helper. Previous
        // implementation referenced an unimported `paymentTransactionsStore`,
        // throwing ReferenceError on every recurring charge and dropping every
        // paying subscriber down to spark via the outer catch — silent revenue loss.
        await insertPaymentTx({
          id: `tx-recur-${crypto.randomUUID()}`,
          userId,
          orderId,
          type: 'expense',
          category: 'subscription',
          amount,
          currency: 'RUB',
          gateway: savedMethod.gateway,
          description: `Автопродление «${plan.name}» (${interval === 'year' ? 'год' : 'мес'})`,
          metadata: { tier, interval, recurring: true, orderId },
          status: 'pending',
          createdAt: now.toISOString(),
        });

        // Record revenue
        try {
          await recordRevenue({
            channel: 'subscription',
            description: `Автопродление «${plan.name}» (${interval}): ${userId}`,
            grossAmount: amount, platformRevenue: amount, payoutAmount: 0,
            commissionRate: 1.0, payerId: userId, payerName: userId,
            metadata: { tier, interval, recurring: 'true', orderId },
          });
        } catch (e) { console.log('[cron] recordRevenue warning:', e); }

        // Notify user
        emitSSE(userId, {
          type: 'subscription_updated',
          data: { tier, tierName: plan.name, status: 'renewed', newExpiry: newExpiry.toISOString() },
        });
      } catch (chargeErr: any) {
        console.error(`[cron] Charge failed for ${userId}:`, chargeErr?.message || chargeErr);
        results.push({ userId, action: 'charge_failed', error: chargeErr?.message || String(chargeErr) });

        // If charge fails and subscription already expired, downgrade
        if (expiresAt <= now) {
          sub.status = 'expired';
          sub.tier = 'spark';
          sub.tierName = SUBSCRIPTION_PLANS.spark.name;
          sub.credits_remaining = 0;
          sub.credits_per_month = 0;
          sub.updated_at = now.toISOString();
          await upsertSubscription(userId, sub);
          expired++;
        }
      }
    }

    console.log(`[cron] Recurring charges: ${charged} charged, ${expired} expired, ${skipped} skipped`);
    return c.json({
      success: true,
      summary: { charged, expired, skipped, total: allSubEntries.length },
      results,
    });
  } catch (error) {
    console.error('[cron] charge-recurring error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default subscriptions;