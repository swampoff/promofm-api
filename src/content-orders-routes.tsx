/**
 * CONTENT ORDERS ROUTES — Заказы аудио-контента (джинглы, реклама, voice-over)
 * Native SQL (PostgreSQL) on `content_orders` table.
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { logAdminAction } from './audit-helper.tsx';
import { profileLimiter } from './rate-limiter.tsx';
import { pool } from './db-client.tsx';

const app = new Hono();

// ── Серверный каталог цен (source of truth) ──
// Раньше цену присылал клиент, а amount-gate чекаута сверял оплату с той же
// клиентской цифрой (ord.price) → self-referential: заказ за 1₽ на джингл в
// 10000₽ проходил. Теперь цену считает сервер, body.price игнорируется.
// Два входа с разными схемами цены:
//   • jingle-order-modal — по именованному стилю (styleTier из 5 тарифов);
//   • radio-brand inline  — по (contentType, urgency: standard|urgent).
const CONTENT_STYLE_TIER_PRICES: Record<string, number> = {
  energetic: 2000, professional: 3000, friendly: 2500, luxury: 5000, custom: 10000,
};
const CONTENT_TYPE_PRICES: Record<string, { standard: number; urgent: number }> = {
  jingles:       { standard: 1500, urgent: 2500 },
  ads:           { standard: 2000, urgent: 3000 },
  announcements: { standard: 2500, urgent: 3500 },
};
// styleTier (модалка) имеет приоритет; иначе (contentType, urgent) из radio-brand.
// Возвращает null, если спецификацию нельзя оценить (→ 400, а не молчаливый 0).
function computeContentOrderPrice(contentType: string, styleTier?: string, urgent?: boolean): number | null {
  if (styleTier && Object.prototype.hasOwnProperty.call(CONTENT_STYLE_TIER_PRICES, styleTier)) {
    return CONTENT_STYLE_TIER_PRICES[styleTier];
  }
  const t = CONTENT_TYPE_PRICES[contentType];
  if (!t) return null;
  return urgent ? t.urgent : t.standard;
}

interface ContentOrder {
  id: string;
  venueId: string;
  venueName: string;
  contentType: 'jingles' | 'ads' | 'announcements';
  text: string;
  style: string;
  duration: number;
  voiceType: string;
  price: number;
  status: 'pending_payment' | 'pending' | 'in_production' | 'ready' | 'delivered' | 'cancelled';
  audioUrl?: string;
  paymentOrderId?: string;
  paymentGateway?: string;
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToOrder(r: any): ContentOrder {
  return {
    id: r.id,
    venueId: r.venue_id,
    venueName: r.venue_name || '',
    contentType: r.content_type,
    text: r.text,
    style: r.style || '',
    duration: r.duration || 0,
    voiceType: r.voice_type || '',
    price: parseFloat(r.price) || 0,
    status: r.status,
    audioUrl: r.audio_url || undefined,
    paymentOrderId: r.payment_order_id || undefined,
    paymentGateway: r.payment_gateway || undefined,
    paidAt: r.paid_at?.toISOString?.() || r.paid_at,
    createdAt: r.created_at?.toISOString?.() || r.created_at,
    updatedAt: r.updated_at?.toISOString?.() || r.updated_at,
  };
}

// ── POST /orders ──
// Audit INC-V1 + A-V1 (2026-05-31):
// — INC-V1: venueId раньше брался из body — venue мог создать заказ
//   на ЛЮБОЙ другой venueId (impersonation, чужой venue видит/
//   оплачивает чужой заказ в своём GET /orders). Теперь venueId
//   фиксируется из JWT (c.get('userId') для venue role). Admin может
//   создавать от имени venue через body.venueId — для миграционных /
//   support-кейсов.
// — A-V1: profileLimiter — раньше venue мог спамить заказы
//   (pending_payment status, реальный money damage зависел от
//   payment gateway, но spam в admin queue + лишние notifications).
app.post('/orders', requireAuth, profileLimiter, async (c) => {
  try {
    const body = await c.req.json();
    const { venueName, contentType, text, style, duration, voiceType } = body;
    const userId = c.get('userId' as never) as string | undefined;
    const userRole = c.get('userRole' as never) as string | undefined;

    // INC-V1: venueId = JWT identity для non-admin. Body.venueId игнорируется
    // (admin/superadmin может явно указать — например импорт из старой
    // CRM или support-операция).
    const isAdmin = userRole === 'admin' || userRole === 'superadmin';
    const venueId = isAdmin && body.venueId ? String(body.venueId) : userId;

    // price НЕ из body — только required-поля спецификации.
    if (!venueId || !venueName || !contentType || !text || !style || !voiceType) {
      return c.json({ success: false, error: 'Missing required fields' }, 400);
    }
    if (!['jingles', 'ads', 'announcements'].includes(contentType)) {
      return c.json({ success: false, error: 'Invalid content type' }, 400);
    }
    if (text.length < 10 || text.length > 300) {
      return c.json({ success: false, error: 'Text must be between 10 and 300 characters' }, 400);
    }

    // Цена — только серверная (см. computeContentOrderPrice). body.price
    // намеренно игнорируется; клиент присылает styleTier ИЛИ urgent как
    // селектор тарифа, а не саму сумму.
    const price = computeContentOrderPrice(contentType, body.styleTier, !!body.urgent);
    if (price === null || !(price > 0)) {
      return c.json({ success: false, error: 'Не удалось определить цену заказа (укажите styleTier или срочность)' }, 400);
    }

    const orderId = `order_${crypto.randomUUID()}`;
    const r = await pool.query(
      `INSERT INTO content_orders
        (id, venue_id, venue_name, content_type, text, style, duration, voice_type, price, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_payment', NOW(), NOW())
       RETURNING *`,
      [orderId, venueId, venueName, contentType, text, style, duration || 30, voiceType, price]
    );

    console.log(`Content order created: ${orderId} (${contentType}) for venue=${venueId}`);
    return c.json({ success: true, order: rowToOrder(r.rows[0]) });
  } catch (error: any) {
    console.error('POST /orders error:', error);
    return c.json({ success: false, error: error.message || 'Failed to create order' }, 500);
  }
});

// ── GET /orders ── (with optional ?status=&venueId= filters)
app.get('/orders', requireAuth, async (c) => {
  try {
    const status = c.req.query('status');
    const venueId = c.req.query('venueId');
    const userRole = c.get('userRole');
    const userId = c.get('userId');

    const conditions: string[] = [];
    const params: any[] = [];
    let pIdx = 1;

    // Non-admin users can only see their own orders
    if (userRole !== 'admin' && userRole !== 'superadmin') {
      conditions.push(`venue_id = $${pIdx}`);
      params.push(userId);
      pIdx++;
    } else if (venueId) {
      conditions.push(`venue_id = $${pIdx}`);
      params.push(venueId);
      pIdx++;
    }

    if (status) {
      conditions.push(`status = $${pIdx}`);
      params.push(status);
      pIdx++;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const r = await pool.query(
      `SELECT * FROM content_orders ${where} ORDER BY created_at DESC LIMIT 500`,
      params
    );
    return c.json({ success: true, orders: r.rows.map(rowToOrder) });
  } catch (error: any) {
    console.error('GET /orders error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── GET /orders/:id ──
app.get('/orders/:id', requireAuth, async (c) => {
  try {
    const orderId = c.req.param('id');
    const r = await pool.query(`SELECT * FROM content_orders WHERE id = $1`, [orderId]);
    if (r.rows.length === 0) return c.json({ success: false, error: 'Order not found' }, 404);

    const order = rowToOrder(r.rows[0]);
    const userRole = c.get('userRole');
    const userId = c.get('userId');
    if (userRole !== 'admin' && userRole !== 'superadmin' && order.venueId !== userId) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    return c.json({ success: true, order });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── PUT /orders/:id ── (admin only — update status/audio)
app.put('/orders/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const orderId = c.req.param('id');
    const body = await c.req.json();
    const { status, audioUrl, notes } = body;

    const fields: string[] = [];
    const params: any[] = [];
    let pIdx = 1;

    if (status) {
      fields.push(`status = $${pIdx}`);
      params.push(status);
      pIdx++;
    }
    if (audioUrl !== undefined) {
      fields.push(`audio_url = $${pIdx}`);
      params.push(audioUrl);
      pIdx++;
    }
    if (notes !== undefined) {
      fields.push(`data = jsonb_set(data, '{notes}', to_jsonb($${pIdx}::text))`);
      params.push(notes);
      pIdx++;
    }
    fields.push(`updated_at = NOW()`);

    params.push(orderId);
    const r = await pool.query(
      `UPDATE content_orders SET ${fields.join(', ')} WHERE id = $${pIdx} RETURNING *`,
      params
    );
    if (r.rows.length === 0) return c.json({ success: false, error: 'Order not found' }, 404);
    return c.json({ success: true, order: rowToOrder(r.rows[0]) });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── DELETE /orders/:id ── (admin only)
app.delete('/orders/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const orderId = c.req.param('id');
    const r = await pool.query(`DELETE FROM content_orders WHERE id = $1 RETURNING id`, [orderId]);
    if (r.rows.length === 0) return c.json({ success: false, error: 'Order not found' }, 404);
    // Audit B-8 follow-up: forensic trail кто удалил content-order.
    logAdminAction(c, {
      action: 'content_order_delete',
      resourceType: 'content_order',
      targetId: String(orderId),
    });
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── GET /stats ── (admin)
app.get('/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const byStatus = await pool.query(
      `SELECT status, COUNT(*)::int as count FROM content_orders GROUP BY status`
    );
    const totals = await pool.query(
      `SELECT COUNT(*)::int as total, COALESCE(SUM(price), 0) as revenue FROM content_orders WHERE status != 'pending_payment'`
    );
    return c.json({
      success: true,
      stats: {
        byStatus: byStatus.rows.reduce((acc: any, r: any) => { acc[r.status] = r.count; return acc; }, {}),
        total: totals.rows[0].total,
        revenue: parseFloat(totals.rows[0].revenue) || 0,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── POST /upload — admin uploads audio file for completed order ──
// Keeping the existing /upload behaviour as-is (it stores in /opt/promofm-api/uploads/)
import path from 'node:path';
import fs from 'node:fs/promises';

// Audit B-5 (2026-05-31): allowlist расширений + UUID-валидация orderId.
// Раньше orderId конкатенировался в filename без sanitization (path
// traversal: orderId=../../../etc/foo), а ext бралась из user-supplied
// filename без allowlist (мог быть .php/.html).
const ALLOWED_CONTENT_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus']);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Audit 2026-06-03: size cap. Раньше hono parseBody принимал unlimited
// payload — admin случайно/через XSS в админ-UI грузил 10GB файл,
// fillил диск. 100MB — заведомо выше любого real-world audio-заказа
// (5-минутный WAV ≈ 50MB, mp3 — единицы).
const MAX_CONTENT_BYTES = 100 * 1024 * 1024;

app.post('/upload', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file as File;
    const orderId = body.orderId as string;
    if (!file || !orderId) return c.json({ success: false, error: 'file + orderId required' }, 400);

    // Validate orderId is a real UUID — no path traversal via filename.
    if (!UUID_RE.test(orderId)) {
      return c.json({ success: false, error: 'invalid orderId' }, 400);
    }

    if (file.size > MAX_CONTENT_BYTES) {
      return c.json({ success: false, error: `file too large (max ${MAX_CONTENT_BYTES / 1024 / 1024}MB)` }, 413);
    }
    if (file.size === 0) {
      return c.json({ success: false, error: 'file is empty' }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const ext = (file.name.split('.').pop() || 'mp3').toLowerCase();
    // Reject non-audio extensions (no .php/.html/.svg stored under web root).
    if (!ALLOWED_CONTENT_EXT.has(ext)) {
      return c.json({ success: false, error: `extension .${ext} not allowed` }, 400);
    }
    const filename = `content_${orderId}_${Date.now()}.${ext}`;
    const dir = '/opt/promofm-api/uploads/content-orders';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), buf);

    const audioUrl = `https://promo-music.ru/server/uploads/content-orders/${filename}`;
    await pool.query(
      `UPDATE content_orders SET audio_url = $1, status = 'ready', updated_at = NOW() WHERE id = $2`,
      [audioUrl, orderId]
    );

    return c.json({ success: true, audioUrl });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ── POST /content-upload — заведение грузит свой контент в библиотеку ──
// Отдельный от admin POST /upload (тот фулфиллит ОПЛАЧЕННЫЙ заказ → требует
// admin + multipart + orderId). Здесь venue грузит собственный аудио-итем:
// requireAuth (БЕЗ admin), venueId из cookie-сессии (JWT), тело — JSON base64,
// ровно как шлёт venue-кабинет (radio-brand.tsx UploadContentModal).
app.post('/content-upload', requireAuth, async (c) => {
  try {
    const venueId = c.get('userId');
    if (!venueId) return c.json({ success: false, error: 'unauthorized' }, 401);

    const { audioBase64, fileName, contentType, title } = await c.req.json().catch(() => ({}));
    if (!audioBase64 || !fileName) {
      return c.json({ success: false, error: 'audioBase64 + fileName required' }, 400);
    }

    const ext = (String(fileName).split('.').pop() || 'mp3').toLowerCase();
    if (!ALLOWED_CONTENT_EXT.has(ext)) {
      return c.json({ success: false, error: `extension .${ext} not allowed` }, 400);
    }

    const buf = Buffer.from(String(audioBase64), 'base64');
    if (buf.length === 0) return c.json({ success: false, error: 'file is empty' }, 400);
    if (buf.length > MAX_CONTENT_BYTES) {
      return c.json({ success: false, error: `file too large (max ${MAX_CONTENT_BYTES / 1024 / 1024}MB)` }, 413);
    }

    // venueId из JWT (доверенный) + санитизация + Date.now() → нет path traversal.
    const safeVenue = String(venueId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'venue';
    const filename = `venue_${safeVenue}_${Date.now()}.${ext}`;
    const dir = '/opt/promofm-api/uploads/content-orders';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), buf);

    const audioUrl = `https://promo-music.ru/server/uploads/content-orders/${filename}`;
    // Форма ответа = { file: {...} } — venue-кабинет читает data.file.duration.
    // Длительность бэк не считает (0); фронт может посчитать из <audio> локально.
    return c.json({
      success: true,
      file: { audioUrl, duration: 0, title: title || fileName, contentType: contentType || null },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default app;
