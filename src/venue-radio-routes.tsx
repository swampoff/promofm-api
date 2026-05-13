/**
 * VENUE RADIO ROUTES — Подписка заведения на ПРОМО.ЭИР для трансляции
 *
 * Endpoints:
 *   GET  /plans                — список планов
 *   GET  /subscription         — активная подписка текущего заведения
 *   POST /subscribe            — создать платёжную сессию (yookassa)
 *   POST /cancel               — отменить (autoRenew=false)
 *   GET  /stream-token         — получить токен для проигрывателя (только для активных)
 *   GET  /admin/subscriptions  — список всех подписок (admin)
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';

const app = new Hono();

const ALLOWED_ORIGINS = ['https://promo-music.ru', 'https://www.promo-music.ru'];

// ── GET /plans ── (public)
app.get('/plans', async (c) => {
  try {
    const r = await pool.query(
      `SELECT id, name, description, price_month, features, sort_order
       FROM venue_radio_plans WHERE is_active = true ORDER BY sort_order ASC`
    );
    const plans = r.rows.map((p: any) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      priceMonth: parseFloat(p.price_month),
      features: p.features || [],
    }));
    return c.json({ success: true, plans });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── GET /subscription ── (current venue)
app.get('/subscription', requireAuth, async (c) => {
  try {
    const venueId = c.get('userId');
    const r = await pool.query(
      `SELECT s.id, s.venue_id, s.plan_id, s.status, s.current_period_start, s.current_period_end,
              s.auto_renew, s.created_at,
              p.name as plan_name, p.price_month, p.features
       FROM venue_radio_subscriptions s
       LEFT JOIN venue_radio_plans p ON p.id = s.plan_id
       WHERE s.venue_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [venueId]
    );
    if (r.rows.length === 0) {
      return c.json({ success: true, subscription: null });
    }
    const s = r.rows[0];
    return c.json({
      success: true,
      subscription: {
        id: s.id,
        venueId: s.venue_id,
        planId: s.plan_id,
        planName: s.plan_name,
        priceMonth: parseFloat(s.price_month) || 0,
        features: s.features || [],
        status: s.status,
        currentPeriodStart: s.current_period_start,
        currentPeriodEnd: s.current_period_end,
        autoRenew: s.auto_renew,
        createdAt: s.created_at,
        isActive: s.status === 'active' && (!s.current_period_end || new Date(s.current_period_end) > new Date()),
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── POST /subscribe ── { planId, returnUrl? }
app.post('/subscribe', requireAuth, async (c) => {
  try {
    const venueId = c.get('userId');
    const venueRole = c.get('userRole');
    if (venueRole !== 'venue') {
      return c.json({ success: false, error: 'Только заведения могут подписываться' }, 403);
    }

    const { planId, returnUrl } = await c.req.json();
    if (!planId) return c.json({ success: false, error: 'planId required' }, 400);

    const planRes = await pool.query(
      `SELECT id, name, price_month FROM venue_radio_plans WHERE id = $1 AND is_active = true`,
      [planId]
    );
    if (planRes.rows.length === 0) {
      return c.json({ success: false, error: 'План не найден' }, 404);
    }
    const plan = planRes.rows[0];
    const price = parseFloat(plan.price_month);

    const safeReturnUrl = returnUrl || 'https://promo-music.ru/venue/promo-air';
    try {
      const origin = new URL(safeReturnUrl).origin;
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return c.json({ success: false, error: 'Invalid returnUrl' }, 400);
      }
    } catch {
      return c.json({ success: false, error: 'Invalid returnUrl' }, 400);
    }

    // Create pending subscription record
    const subRes = await pool.query(
      `INSERT INTO venue_radio_subscriptions (venue_id, plan_id, status, created_at, updated_at)
       VALUES ($1, $2, 'pending_payment', NOW(), NOW()) RETURNING id`,
      [venueId, planId]
    );
    const subscriptionId = subRes.rows[0].id;

    // Create YooKassa session
    const { getGateway } = await import('./payment-gateway.tsx');
    const { upsertPaymentSession } = await import('./db.tsx');
    const orderId = crypto.randomUUID();
    const gw = getGateway('yookassa');
    const result = await gw.createPayment({
      amount: price,
      currency: 'RUB',
      description: `Подписка ПРОМО.ЭИР: ${plan.name}`,
      gateway: 'yookassa',
      userId: venueId,
      orderId,
      returnUrl: safeReturnUrl,
      metadata: {
        type: 'venue_radio_subscription',
        subscriptionId,
        venueId,
        planId,
      },
      savePaymentMethod: false,
      type: 'subscription',
    });

    await upsertPaymentSession(orderId, {
      orderId,
      userId: venueId,
      gateway: 'yookassa',
      gatewayPaymentId: result.sessionId,
      amount: price,
      currency: 'RUB',
      status: 'pending',
      type: 'subscription',
      description: `Подписка ПРОМО.ЭИР: ${plan.name}`,
      metadata: {
        type: 'venue_radio_subscription',
        subscriptionId,
        venueId,
        planId,
      },
      savePaymentMethod: false,
      confirmationUrl: result.confirmationUrl,
      returnUrl: safeReturnUrl,
      createdAt: new Date().toISOString(),
    });

    return c.json({
      success: true,
      data: {
        subscriptionId,
        orderId,
        confirmationUrl: result.confirmationUrl,
      },
    });
  } catch (error: any) {
    console.error('venue-radio /subscribe:', error);
    return c.json({ success: false, error: error.message || 'Subscription failed' }, 500);
  }
});

// ── POST /cancel ── (cancels auto-renew, keeps active until period end)
app.post('/cancel', requireAuth, async (c) => {
  try {
    const venueId = c.get('userId');
    const r = await pool.query(
      `UPDATE venue_radio_subscriptions
       SET auto_renew = false, status = CASE WHEN current_period_end < NOW() THEN 'expired' ELSE status END,
           updated_at = NOW()
       WHERE venue_id = $1 AND status = 'active'
       RETURNING id, current_period_end`,
      [venueId]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Активная подписка не найдена' }, 404);
    }
    return c.json({
      success: true,
      message: `Автопродление отключено. Доступ сохраняется до ${r.rows[0].current_period_end}`,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── GET /stream-token ── Returns token for player; only for active subscriptions
app.get('/stream-token', requireAuth, async (c) => {
  try {
    const venueId = c.get('userId');
    const r = await pool.query(
      `SELECT id, current_period_end FROM venue_radio_subscriptions
       WHERE venue_id = $1 AND status = 'active' AND (current_period_end IS NULL OR current_period_end > NOW())
       LIMIT 1`,
      [venueId]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Активная подписка не найдена', code: 'NO_ACTIVE_SUBSCRIPTION' }, 403);
    }
    const sub = r.rows[0];
    // Simple bearer token = subscriptionId; for MVP this is enough.
    // Real impl: short-lived signed JWT.
    return c.json({
      success: true,
      data: {
        streamUrl: 'https://promo-music.ru/api/air/stream',
        token: sub.id,
        expiresAt: sub.current_period_end,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── GET /admin/subscriptions ──
app.get('/admin/subscriptions', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status');
    const conditions: string[] = [];
    const params: any[] = [];
    let pIdx = 1;
    if (status) {
      conditions.push(`s.status = $${pIdx}`);
      params.push(status);
      pIdx++;
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const r = await pool.query(
      `SELECT s.id, s.venue_id, s.plan_id, s.status, s.current_period_start, s.current_period_end,
              s.auto_renew, s.created_at, p.name as plan_name, p.price_month,
              u.full_name as venue_name, u.email as venue_email
       FROM venue_radio_subscriptions s
       LEFT JOIN venue_radio_plans p ON p.id = s.plan_id
       LEFT JOIN users u ON u.id::text = s.venue_id
       ${where} ORDER BY s.created_at DESC LIMIT 500`,
      params
    );
    return c.json({ success: true, subscriptions: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default app;
