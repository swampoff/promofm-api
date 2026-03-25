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
import { getDjProfile, upsertDjProfile, djCollaborationsStore, djEventsStore, djNotificationsStore, djSubscriptionsStore } from './db.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

// Fallback DJ user ID
const FALLBACK_DJ_USER_ID = 'anonymous';

// Helper: получить userId через единый хелпер авторизации
async function getUserId(c: any): Promise<string> {
  return resolveUserId(c, FALLBACK_DJ_USER_ID);
}

function generateId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

export default app;
