/**
 * DJ STUDIO ROUTES - События и Коллаборации DJ
 * 
 * Endpoints:
 * - GET/POST   /events           - список событий DJ / создание
 * - GET/PUT    /events/:id       - детали / обновление события
 * - DELETE     /events/:id       - удаление события
 * - GET/POST   /collaborations   - коллаборации DJ
 * - PUT        /collaborations/:id/accept  - принять коллаборацию
 * - PUT        /collaborations/:id/decline - отклонить
 * - GET        /notifications    - уведомления DJ
 * - POST       /notifications/read - пометить прочитанным
 * - GET        /plans            - тарифные планы DJ
 * - GET        /subscription/:djId - текущая подписка DJ
 * - POST       /subscription/:djId/change - смена плана
 */

import { Hono } from 'hono';
import {
  getDjProfile, upsertDjProfile,
  djCollaborationsStore, djEventsStore, djNotificationsStore, djSubscriptionsStore,
  djMixesStore, djReviewsStore,
  djPitchesStore, djCampaignsStore, djWithdrawalsStore, djTransactionsStore,
  getCoinBalance,
} from './db.tsx';
import { pool } from './db-client.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

// Fallback DJ user ID
const FALLBACK_DJ_USER_ID = 'anonymous';

// Helper: получить userId через единый хелпер авторизации
async function getUserId(c: any): Promise<string> {
  return c.get('userId') || FALLBACK_DJ_USER_ID;
}

function generateId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// ════════════════════════════════════════
// PROFILE
// ════════════════════════════════════════

// GET /profile - загрузить профиль DJ
app.get('/profile', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const data = await getDjProfile(userId);

    if (!data) {
      // Отдаём пустой ответ, фронт подставит дефолты
      return c.json({ success: true, data: null });
    }

    return c.json({ success: true, data });
  } catch (error) {
    console.error('Error loading DJ profile:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /profile - сохранить профиль DJ
app.put('/profile', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();

    await upsertDjProfile(userId, body);
    return c.json({ success: true, data: body });
  } catch (error) {
    console.error('Error saving DJ profile:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// EVENTS
// ════════════════════════════════════════

// GET /events - список событий DJ
app.get('/events', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const events = await djEventsStore.get(userId) || [];
    return c.json({ success: true, data: events });
  } catch (error) {
    console.error('Error fetching DJ events:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /events - создать событие
app.post('/events', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const id = generateId('ev');
    const now = new Date().toISOString();

    const event = {
      id,
      ...body,
      djId: userId,
      createdAt: now,
      updatedAt: now,
    };

    const events = (await djEventsStore.get(userId)) || [];
    events.push(event);
    await djEventsStore.set(userId, events);

    return c.json({ success: true, data: event }, 201);
  } catch (error) {
    console.error('Error creating DJ event:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /events/:id
app.get('/events/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const eventId = c.req.param('id');
    const events = (await djEventsStore.get(userId)) || [];
    const event = events.find((e: any) => e.id === eventId);
    if (!event) return c.json({ success: false, error: 'Event not found' }, 404);
    return c.json({ success: true, data: event });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /events/:id
app.put('/events/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const eventId = c.req.param('id');
    const body = await c.req.json();
    const events = (await djEventsStore.get(userId)) || [];
    const idx = events.findIndex((e: any) => e.id === eventId);
    if (idx === -1) return c.json({ success: false, error: 'Event not found' }, 404);

    events[idx] = { ...events[idx], ...body, updatedAt: new Date().toISOString() };
    await djEventsStore.set(userId, events);
    return c.json({ success: true, data: events[idx] });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /events/:id
app.delete('/events/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const eventId = c.req.param('id');
    const events = (await djEventsStore.get(userId)) || [];
    const filtered = events.filter((e: any) => e.id !== eventId);
    await djEventsStore.set(userId, filtered);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// COLLABORATIONS
// ════════════════════════════════════════

// GET /collaborations
app.get('/collaborations', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const collabs = await djCollaborationsStore.get(userId) || [];
    return c.json({ success: true, data: collabs });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// POST /collaborations
app.post('/collaborations', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const id = generateId('collab');
    const now = new Date().toISOString();

    const collab = {
      id,
      ...body,
      djId: userId,
      status: 'pending',
      createdAt: now,
    };

    const collabs = (await djCollaborationsStore.get(userId)) || [];
    collabs.push(collab);
    await djCollaborationsStore.set(userId, collabs);

    return c.json({ success: true, data: collab }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /collaborations/:id/accept
app.put('/collaborations/:id/accept', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const collabId = c.req.param('id');
    const collabs = (await djCollaborationsStore.get(userId)) || [];
    const idx = collabs.findIndex((col: any) => col.id === collabId);
    if (idx === -1) return c.json({ success: false, error: 'Collaboration not found' }, 404);

    collabs[idx].status = 'accepted';
    collabs[idx].updatedAt = new Date().toISOString();
    await djCollaborationsStore.set(userId, collabs);
    return c.json({ success: true, data: collabs[idx] });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /collaborations/:id/decline
app.put('/collaborations/:id/decline', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const collabId = c.req.param('id');
    const collabs = (await djCollaborationsStore.get(userId)) || [];
    const idx = collabs.findIndex((col: any) => col.id === collabId);
    if (idx === -1) return c.json({ success: false, error: 'Collaboration not found' }, 404);

    collabs[idx].status = 'declined';
    collabs[idx].updatedAt = new Date().toISOString();
    await djCollaborationsStore.set(userId, collabs);
    return c.json({ success: true, data: collabs[idx] });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════

// GET /notifications
app.get('/notifications', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const notifications = await djNotificationsStore.get(userId) || [];
    return c.json({ success: true, data: notifications });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// POST /notifications/read
app.post('/notifications/read', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const { ids } = body;

    const notifications = (await djNotificationsStore.get(userId)) || [];
    for (const n of notifications) {
      if (!ids || ids.includes(n.id)) {
        n.read = true;
      }
    }
    await djNotificationsStore.set(userId, notifications);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// TARIFF PLANS & SUBSCRIPTIONS
// ════════════════════════════════════════

const DJ_PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: 0,
    priceYear: 0,
    currency: '₽',
    description: 'Базовый бесплатный план для начинающих DJ',
    features: [
      'Профиль на маркетплейсе',
      'До 3 промо-миксов',
      'Базовая аналитика',
      'Приём букингов',
    ],
    limits: { mixes: 3, events: 5, analytics: 'basic' },
    popular: false,
    color: 'slate',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 990,
    priceYear: 9900,
    currency: '₽',
    description: 'Профессиональный план для активных DJ',
    features: [
      'Всё из Starter',
      'До 20 промо-миксов',
      'Расширенная аналитика',
      'Приоритет в поиске',
      'Верификация профиля',
      'Продвижение на радио',
    ],
    limits: { mixes: 20, events: 50, analytics: 'advanced' },
    popular: true,
    color: 'purple',
  },
  {
    id: 'agency',
    name: 'Agency',
    price: 2990,
    priceYear: 29900,
    currency: '₽',
    description: 'Максимальный план для агентств и топ DJ',
    features: [
      'Всё из Pro',
      'Безлимитные миксы',
      'Полная аналитика + API',
      'Топ позиция в поиске',
      'Персональный менеджер',
      'Мультиаккаунт (до 5 DJ)',
      'Брендированная страница',
    ],
    limits: { mixes: -1, events: -1, analytics: 'full' },
    popular: false,
    color: 'amber',
  },
];

// GET /plans - тарифные планы
app.get('/plans', requireAuth, async (c) => {
  return c.json({ success: true, data: DJ_PLANS });
});

// GET /subscription/:djId - текущая подписка DJ
app.get('/subscription/:djId', requireAuth, async (c) => {
  try {
    const djId = c.req.param('djId');
    const sub = await djSubscriptionsStore.get(djId);

    if (!sub) {
      // По умолчанию - бесплатный Starter
      const defaultSub = {
        djId,
        planId: 'starter',
        planName: 'Starter',
        status: 'active',
        price: 0,
        currency: '₽',
        interval: 'month',
        startDate: new Date().toISOString(),
        endDate: null,
        limits: DJ_PLANS[0].limits,
      };
      return c.json({ success: true, data: defaultSub });
    }

    return c.json({ success: true, data: sub });
  } catch (error) {
    console.error('Error fetching DJ subscription:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /subscription/:djId/change - смена плана
app.post('/subscription/:djId/change', requireAuth, async (c) => {
  try {
    const djId = c.req.param('djId');
    const body = await c.req.json();
    const { planId, interval = 'month' } = body;

    const plan = DJ_PLANS.find(p => p.id === planId);
    if (!plan) {
      return c.json({ success: false, error: 'Plan not found' }, 404);
    }

    const now = new Date();
    const endDate = new Date(now);
    if (interval === 'year') {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      endDate.setMonth(endDate.getMonth() + 1);
    }

    const subscription = {
      djId,
      planId: plan.id,
      planName: plan.name,
      status: 'active',
      price: interval === 'year' ? plan.priceYear : plan.price,
      currency: plan.currency,
      interval,
      startDate: now.toISOString(),
      endDate: endDate.toISOString(),
      limits: plan.limits,
    };

    await djSubscriptionsStore.set(djId, subscription);

    // Записать доход платформы при платных планах
    if (plan.price > 0) {
      try {
        const grossAmount = interval === 'year' ? plan.priceYear : plan.price;
        await recordRevenue({
          channel: 'dj_subscription',
          description: `DJ подписка ${plan.name} (${interval}): ${djId}`,
          grossAmount,
          platformRevenue: grossAmount, // подписки = 100% доход платформы
          payoutAmount: 0,
          commissionRate: 1.0,
          payerId: djId,
          payerName: djId,
        });
      } catch (revErr) {
        console.error('Revenue recording failed (non-critical):', revErr);
      }
    }

    console.log(`DJ ${djId} changed plan to ${plan.name} (${interval})`);
    return c.json({ success: true, data: subscription });
  } catch (error) {
    console.error('Error changing DJ subscription:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// COINS
// ════════════════════════════════════════

// GET /coins/balance — баланс коинов DJ (используется в сайдбаре)
app.get('/coins/balance', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const bal = await getCoinBalance(userId);
    return c.json({ success: true, data: { balance: Number(bal?.balance ?? 0) } });
  } catch (error) {
    console.error('Error fetching DJ coins balance:', error);
    return c.json({ success: true, data: { balance: 0 } });
  }
});

// ════════════════════════════════════════
// DASHBOARD STATS
// ════════════════════════════════════════

// GET /dashboard/stats — агрегированная статистика для главной DJ-кабинета
app.get('/dashboard/stats', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const [mixes, events, reviews] = await Promise.all([
      djMixesStore.get(userId).catch(() => []),
      djEventsStore.get(userId).catch(() => []),
      djReviewsStore.get(userId).catch(() => []),
    ]);
    const mixesArr: any[] = Array.isArray(mixes) ? mixes : [];
    const eventsArr: any[] = Array.isArray(events) ? events : [];
    const reviewsArr: any[] = Array.isArray(reviews) ? reviews : [];

    const totalPlays = mixesArr.reduce((s, m) => s + (m.plays || 0), 0);
    const completedEvents = eventsArr.filter((e: any) => e.status === 'completed');
    const upcomingEvents = eventsArr.filter((e: any) => e.status === 'upcoming' || e.status === 'confirmed');
    const totalEarnings = completedEvents.reduce((s, e: any) => s + (e.fee || 0), 0);
    const ratingValues = reviewsArr.map((r: any) => Number(r.rating || 0)).filter((n: number) => n > 0);
    const avgRating = ratingValues.length > 0 ? ratingValues.reduce((s: number, n: number) => s + n, 0) / ratingValues.length : 0;

    // followers — берём из mix-subscribers (best-effort), иначе 0
    let followers = 0;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM dj_followers WHERE dj_id = $1`,
        [userId]
      );
      followers = rows[0]?.n || 0;
    } catch {
      // таблица может отсутствовать
    }

    return c.json({
      success: true,
      data: {
        mixesCount: mixesArr.length,
        listens: totalPlays,
        bookingsCount: upcomingEvents.length,
        earnings: totalEarnings,
        rating: Number(avgRating.toFixed(2)),
        followers,
      },
    });
  } catch (error) {
    console.error('Error building DJ dashboard stats:', error);
    return c.json({
      success: true,
      data: { mixesCount: 0, listens: 0, bookingsCount: 0, earnings: 0, rating: 0, followers: 0 },
    });
  }
});

// ════════════════════════════════════════
// FINANCES
// ════════════════════════════════════════

const COMMISSION_RATE = 0.15;

function inCurrentMonth(iso: string | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

// GET /finances/overview — балансы DJ (рассчитываются из событий + транзакций)
app.get('/finances/overview', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const [events, withdrawals, txs] = await Promise.all([
      djEventsStore.get(userId).catch(() => []),
      djWithdrawalsStore.get(userId).catch(() => []),
      djTransactionsStore.get(userId).catch(() => []),
    ]);
    const eventsArr: any[] = Array.isArray(events) ? events : [];
    const withdrawalsArr: any[] = Array.isArray(withdrawals) ? withdrawals : [];
    const txsArr: any[] = Array.isArray(txs) ? txs : [];

    const completed = eventsArr.filter((e: any) => e.status === 'completed');
    const pending = eventsArr.filter((e: any) => e.status === 'upcoming' || e.status === 'confirmed');

    const totalEarned = completed.reduce((s: number, e: any) => s + (e.fee || 0), 0);
    const pendingAmount = pending.reduce((s: number, e: any) => s + (e.fee || 0), 0);
    const totalWithdrawn = withdrawalsArr
      .filter((w: any) => w.status === 'completed' || w.status === 'paid')
      .reduce((s: number, w: any) => s + (w.amount || 0), 0);
    const available = Math.max(0, totalEarned - totalWithdrawn);

    const monthEarnings = completed
      .filter((e: any) => inCurrentMonth(e.completedAt || e.date))
      .reduce((s: number, e: any) => s + (e.fee || 0), 0);
    const monthBookings = eventsArr.filter((e: any) => inCurrentMonth(e.date)).length;

    return c.json({
      success: true,
      data: {
        available,
        pending: pendingAmount,
        total: available + pendingAmount,
        monthEarnings,
        monthBookings,
        commissionRate: COMMISSION_RATE,
        totalEarned,
        totalWithdrawn,
        transactionsCount: txsArr.length,
      },
    });
  } catch (error) {
    console.error('Error fetching DJ finances overview:', error);
    return c.json({
      success: true,
      data: {
        available: 0, pending: 0, total: 0,
        monthEarnings: 0, monthBookings: 0,
        commissionRate: COMMISSION_RATE,
        totalEarned: 0, totalWithdrawn: 0, transactionsCount: 0,
      },
    });
  }
});

// GET /finances/transactions — история транзакций (события + явные tx-записи)
app.get('/finances/transactions', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const [events, txs] = await Promise.all([
      djEventsStore.get(userId).catch(() => []),
      djTransactionsStore.get(userId).catch(() => []),
    ]);
    const eventsArr: any[] = Array.isArray(events) ? events : [];
    const txsArr: any[] = Array.isArray(txs) ? txs : [];

    // События-как-транзакции: completed → income, остальные → pending
    const eventTxs = eventsArr
      .filter((e: any) => e.fee && e.fee > 0)
      .map((e: any) => ({
        id: `event:${e.id}`,
        type: e.status === 'completed' ? 'income' : 'pending',
        label: e.title && e.venue ? `${e.title} @ ${e.venue}` : e.title || 'Букинг',
        amount: e.fee || 0,
        date: e.completedAt || e.date,
        status: e.status === 'completed' ? 'completed' : 'pending',
        source: 'event',
      }));

    const explicitTxs = txsArr.map((t: any) => ({
      id: t.id || `tx:${crypto.randomUUID()}`,
      type: t.type || 'income',
      label: t.label || t.description || 'Транзакция',
      amount: t.amount || 0,
      date: t.date || t.createdAt,
      status: t.status || 'completed',
      source: t.source || 'manual',
    }));

    const combined = [...eventTxs, ...explicitTxs].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });

    return c.json({ success: true, data: combined });
  } catch (error) {
    console.error('Error fetching DJ transactions:', error);
    return c.json({ success: true, data: [] });
  }
});

// GET /finances/withdrawals — выплаты
app.get('/finances/withdrawals', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const list = (await djWithdrawalsStore.get(userId)) || [];
    return c.json({ success: true, data: Array.isArray(list) ? list : [] });
  } catch (error) {
    console.error('Error fetching DJ withdrawals:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /finances/withdrawals — запрос вывода
app.post('/finances/withdrawals', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const amount = Number(body.amount || 0);
    const method = String(body.method || 'bank');

    if (!(amount >= 500)) {
      return c.json({ success: false, error: 'Минимальная сумма вывода — 500 ₽' }, 400);
    }
    if (!['bank', 'yoomoney', 'card'].includes(method)) {
      return c.json({ success: false, error: 'Недопустимый способ вывода' }, 400);
    }

    // Проверим доступный баланс
    const events = (await djEventsStore.get(userId)) || [];
    const withdrawalsExisting = (await djWithdrawalsStore.get(userId)) || [];
    const totalEarned = (events as any[])
      .filter((e: any) => e.status === 'completed')
      .reduce((s: number, e: any) => s + (e.fee || 0), 0);
    const totalAlreadyWithdrawn = (withdrawalsExisting as any[])
      .filter((w: any) => w.status !== 'rejected')
      .reduce((s: number, w: any) => s + (w.amount || 0), 0);
    const available = Math.max(0, totalEarned - totalAlreadyWithdrawn);
    if (amount > available) {
      return c.json({ success: false, error: `Недостаточно средств. Доступно: ${available} ₽` }, 400);
    }

    const id = generateId('wd');
    const now = new Date().toISOString();
    const withdrawal = {
      id,
      djId: userId,
      amount,
      method,
      details: body.details || null,
      status: 'pending',
      requestedAt: now,
      createdAt: now,
    };
    const list = Array.isArray(withdrawalsExisting) ? withdrawalsExisting : [];
    list.unshift(withdrawal);
    await djWithdrawalsStore.set(userId, list);

    return c.json({ success: true, data: withdrawal }, 201);
  } catch (error) {
    console.error('Error creating DJ withdrawal:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// PROMOTION — pitches & campaigns
// ════════════════════════════════════════

// GET /promotion/pitches — питчи миксов на радио/в заведения
app.get('/promotion/pitches', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const list = (await djPitchesStore.get(userId)) || [];
    return c.json({ success: true, data: Array.isArray(list) ? list : [] });
  } catch (error) {
    console.error('Error fetching DJ pitches:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /promotion/pitches — создать новый питч (отправить микс)
app.post('/promotion/pitches', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const mixId: string = String(body.mixId || '');
    const targetType: 'radio' | 'venue' = body.targetType === 'venue' ? 'venue' : 'radio';
    const targetId: string = String(body.targetId || '');
    const message: string = String(body.message || '').slice(0, 2000);

    if (!mixId) return c.json({ success: false, error: 'mixId обязателен' }, 400);
    if (!targetId) return c.json({ success: false, error: 'targetId обязателен' }, 400);

    // Денормализуем поля для UI (mix title, target name)
    const djMixes = (await djMixesStore.get(userId)) || [];
    const mix: any = (djMixes as any[]).find((m: any) => m.id === mixId);

    let targetName = '';
    let targetListeners: number | undefined;
    try {
      if (targetType === 'radio') {
        const { rows } = await pool.query(
          `SELECT data FROM radio_profiles WHERE user_id = $1 OR id = $1 LIMIT 1`,
          [targetId]
        );
        targetName = rows[0]?.data?.station_name || rows[0]?.data?.stationName || rows[0]?.data?.name || 'Радиостанция';
        targetListeners = rows[0]?.data?.listeners_count || rows[0]?.data?.listeners;
      } else {
        const { rows } = await pool.query(
          `SELECT data FROM venue_profiles WHERE user_id = $1 OR id = $1 LIMIT 1`,
          [targetId]
        );
        targetName = rows[0]?.data?.venue_name || rows[0]?.data?.venueName || rows[0]?.data?.name || 'Заведение';
      }
    } catch (lookupErr) {
      // лучше отправить питч с пустым названием, чем валиться
      console.warn('Pitch target lookup failed:', lookupErr);
    }

    const id = generateId('pitch');
    const now = new Date().toISOString();
    const pitch = {
      id,
      djId: userId,
      mixId,
      mixTitle: mix?.title || 'Микс',
      targetType,
      targetId,
      targetName,
      targetListeners,
      message,
      status: 'pending' as const,
      sentAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const list = (await djPitchesStore.get(userId)) || [];
    const arr = Array.isArray(list) ? list : [];
    arr.unshift(pitch);
    await djPitchesStore.set(userId, arr);

    return c.json({ success: true, data: pitch }, 201);
  } catch (error) {
    console.error('Error creating DJ pitch:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /promotion/campaigns — рекламные кампании
app.get('/promotion/campaigns', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const list = (await djCampaignsStore.get(userId)) || [];
    return c.json({ success: true, data: Array.isArray(list) ? list : [] });
  } catch (error) {
    console.error('Error fetching DJ campaigns:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /promotion/campaigns — создать кампанию
app.post('/promotion/campaigns', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const allowedTypes = new Set(['banner', 'social', 'email']);
    const type = allowedTypes.has(body.type) ? body.type : 'banner';

    const id = generateId('camp');
    const now = new Date().toISOString();
    const campaign = {
      id,
      djId: userId,
      title: String(body.title || 'Без названия').slice(0, 200),
      type,
      status: 'active',
      impressions: 0,
      clicks: 0,
      budget: Number(body.budget || 0),
      spent: 0,
      mixId: body.mixId || null,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const list = (await djCampaignsStore.get(userId)) || [];
    const arr = Array.isArray(list) ? list : [];
    arr.unshift(campaign);
    await djCampaignsStore.set(userId, arr);

    return c.json({ success: true, data: campaign }, 201);
  } catch (error) {
    console.error('Error creating DJ campaign:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /promotion/targets?type=radio|venue — каталог целей для питча
app.get('/promotion/targets', requireAuth, async (c) => {
  try {
    const type = c.req.query('type') === 'venue' ? 'venue' : 'radio';
    const query = String(c.req.query('q') || '').trim().toLowerCase();
    const limit = Math.min(Number(c.req.query('limit') || 100), 200);

    const table = type === 'venue' ? 'venue_profiles' : 'radio_profiles';
    const { rows } = await pool.query(`SELECT user_id, data FROM ${table} LIMIT $1`, [limit]);

    const targets = (rows || []).map((r: any) => {
      const d = r.data || {};
      if (type === 'radio') {
        return {
          id: r.user_id,
          name: d.station_name || d.stationName || d.name || 'Радиостанция',
          city: d.city || '',
          genres: d.genres || [],
          listeners: d.listeners_count || d.listeners || null,
          logo: d.logo_url || d.logoUrl || null,
        };
      }
      return {
        id: r.user_id,
        name: d.venue_name || d.venueName || d.name || 'Заведение',
        city: d.city || '',
        type: d.venue_type || d.type || '',
        capacity: d.capacity || null,
        logo: d.logo_url || d.logoUrl || null,
      };
    });

    const filtered = query
      ? targets.filter((t: any) =>
          (t.name || '').toLowerCase().includes(query) ||
          (t.city || '').toLowerCase().includes(query)
        )
      : targets;

    return c.json({ success: true, data: filtered });
  } catch (error) {
    console.error('Error fetching promotion targets:', error);
    return c.json({ success: true, data: [] });
  }
});

export default app;
