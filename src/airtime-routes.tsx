/**
 * AIRTIME ROUTES — продажа эфирного времени артистам
 *
 * Контекст: PROMO.FM аудит 2026-06-05 определил это как P0 #1 блокер
 * под уже-выкаченным обещанием в LP /radio-stations. Аналог
 * radio_ad_slots + radio_venue_requests для другой стороны рынка:
 * radio выставляет slots → artist marketplace → payment → radio
 * approve → broadcast.
 *
 * Endpoints (radio cabinet):
 *   POST   /airtime-slots/create
 *   GET    /airtime-slots/list                  — мои слоты
 *   PUT    /airtime-slots/:id                   — update
 *   DELETE /airtime-slots/:id
 *   GET    /airtime-purchases                   — заявки от артистов
 *   PUT    /airtime-purchases/:id/approve       — radio approve + scheduled_at
 *   PUT    /airtime-purchases/:id/reject        — radio reject + refund-saga
 *   PUT    /airtime-purchases/:id/broadcast     — mark as broadcasted
 *
 * Endpoints (artist cabinet — public catalog):
 *   GET    /artist/airtime-catalog              — каталог всех active slots
 *                                                 (filter: format, city, price_min/max)
 *   POST   /artist/airtime-purchase             — create purchase + YooKassa session
 *   GET    /artist/airtime-purchases            — мои покупки
 *
 * Pricing flow:
 *   slot.base_price * (1 - discount_pct/100) = total_price
 *   total_price * 0.85 = radio_payout
 *   total_price * 0.15 = platform_fee
 *   discount_pct: applySubscriptionDiscount(artistUserId, 'promotion', ...)
 *
 * Payment integration:
 *   POST /artist/airtime-purchase создаёт row status='pending_payment' и
 *   возвращает {sessionUrl, sessionId} от YooKassa. Webhook
 *   checkout-routes.tsx с itemType='radio_airtime' и metadata.purchaseId
 *   делает UPDATE radio_airtime_purchases SET status='paid' WHERE id=$1
 *   AND status='pending_payment' (idempotent).
 *
 * Notifications (cross-cabinet-notify типы добавлены отдельным PR):
 *   - artist купил → notifyCrossCabinet(radio, 'airtime_purchase_new')
 *   - radio approved → notifyCrossCabinet(artist, 'airtime_approved')
 *   - radio rejected → notifyCrossCabinet(artist, 'airtime_rejected') + refund
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth, requireRole } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';
import { getRadioProfile } from './db.tsx';
import { applySubscriptionDiscount } from './subscription-pricing.tsx';

const app = new Hono();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getUserId(c: any): Promise<string> {
  const userId = c.get('userId');
  if (!userId) throw new Error('UNAUTHORIZED_NO_USER_ID');
  return String(userId);
}

const ALLOWED_FORMATS = new Set(['interview', 'podcast', 'track_placement']);

interface ValidSlotInput {
  format: string;
  title: string;
  description: string | null;
  durationMin: number;
  basePrice: number;
  availableTimes: any[];
  maxPerPeriod: number;
}

// Returns string (error) on failure, ValidSlotInput on success.
function validateSlotInput(body: any): string | ValidSlotInput {
  const format = String(body.format || '').toLowerCase();
  if (!ALLOWED_FORMATS.has(format)) {
    return `format must be one of: ${[...ALLOWED_FORMATS].join(', ')}`;
  }
  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) return 'title required';
  const description = body.description ? String(body.description).trim().slice(0, 2000) : null;
  const durationMin = Math.max(1, Math.min(240, Number(body.durationMin) || 15));
  const basePrice = Math.max(1, Math.min(1_000_000, Number(body.basePrice) || 0));
  if (basePrice <= 0) return 'basePrice must be > 0';
  const availableTimes = Array.isArray(body.availableTimes) ? body.availableTimes.slice(0, 50) : [];
  const maxPerPeriod = Math.max(1, Math.min(1000, Number(body.maxPerPeriod) || 1));
  return { format, title, description, durationMin, basePrice, availableTimes, maxPerPeriod };
}

function mapSlotRow(r: any): any {
  if (!r) return null;
  return {
    id: r.id,
    radioId: r.radio_id,
    format: r.format,
    title: r.title,
    description: r.description,
    durationMin: Number(r.duration_min) || 0,
    basePrice: Number(r.base_price) || 0,
    availableTimes: r.available_times || [],
    maxPerPeriod: Number(r.max_per_period) || 1,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

function mapPurchaseRow(r: any): any {
  if (!r) return null;
  return {
    id: r.id,
    slotId: r.slot_id,
    radioId: r.radio_id,
    artistId: r.artist_id,
    format: r.format,
    status: r.status,
    paymentSessionId: r.payment_session_id,
    scheduledAt: r.scheduled_at instanceof Date ? r.scheduled_at.toISOString() : r.scheduled_at,
    broadcastedAt: r.broadcasted_at instanceof Date ? r.broadcasted_at.toISOString() : r.broadcasted_at,
    contentUrl: r.content_url,
    artistMessage: r.artist_message,
    rejectionReason: r.rejection_reason,
    totalPrice: Number(r.total_price) || 0,
    discountPct: Number(r.discount_pct) || 0,
    platformFee: Number(r.platform_fee) || 0,
    radioPayout: Number(r.radio_payout) || 0,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    // Joined slot/radio fields (для каталога артиста)
    slotTitle: r.slot_title,
    slotDescription: r.slot_description,
    radioStationName: r.station_name,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RADIO CABINET — управление слотами
// ─────────────────────────────────────────────────────────────────────────────

// POST /airtime-slots/create
app.post('/airtime-slots/create', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = await getUserId(c);
    const radio = await getRadioProfile(userId);
    if (!radio) return c.json({ error: 'Radio profile not found' }, 404);

    const body = await c.req.json();
    const v = validateSlotInput(body);
    if (typeof v === 'string') return c.json({ error: v }, 400);

    const r = await pool.query(
      `INSERT INTO radio_airtime_slots
        (radio_id, format, title, description, duration_min, base_price, available_times, max_per_period, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'active')
       RETURNING *`,
      [
        userId, v.format, v.title, v.description,
        v.durationMin, v.basePrice,
        JSON.stringify(v.availableTimes), v.maxPerPeriod,
      ],
    );
    return c.json({ success: true, slot: mapSlotRow(r.rows[0]) });
  } catch (error: any) {
    console.error('[airtime] create slot error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /airtime-slots/list
app.get('/airtime-slots/list', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = await getUserId(c);
    const r = await pool.query(
      `SELECT * FROM radio_airtime_slots
        WHERE radio_id = $1 AND status != 'archived'
        ORDER BY created_at DESC`,
      [userId],
    );
    return c.json({ success: true, slots: r.rows.map(mapSlotRow) });
  } catch (error: any) {
    console.error('[airtime] list slots error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /airtime-slots/:id
app.put('/airtime-slots/:id', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = await getUserId(c);
    const slotId = c.req.param('id');
    const body = await c.req.json();
    const v = validateSlotInput(body);
    if (typeof v === 'string') return c.json({ error: v }, 400);
    const allowedStatus = ['active', 'paused', 'archived'];
    const status = allowedStatus.includes(body.status) ? body.status : null;

    // Atomic owner-scoped UPDATE — без отдельного SELECT для owner-check.
    const r = await pool.query(
      `UPDATE radio_airtime_slots SET
         format = $3, title = $4, description = $5, duration_min = $6,
         base_price = $7, available_times = $8::jsonb, max_per_period = $9,
         status = COALESCE($10, status),
         updated_at = NOW()
       WHERE id::text = $1 AND radio_id = $2
       RETURNING *`,
      [
        slotId, userId,
        v.format, v.title, v.description,
        v.durationMin, v.basePrice,
        JSON.stringify(v.availableTimes), v.maxPerPeriod,
        status,
      ],
    );
    if (r.rows.length === 0) return c.json({ error: 'Slot not found' }, 404);
    return c.json({ success: true, slot: mapSlotRow(r.rows[0]) });
  } catch (error: any) {
    console.error('[airtime] update slot error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /airtime-slots/:id (soft-delete через status='archived' если есть purchases)
app.delete('/airtime-slots/:id', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = await getUserId(c);
    const slotId = c.req.param('id');

    // Если есть purchases — нельзя hard-delete (FK RESTRICT). Soft-delete.
    const hasPurchases = await pool.query(
      `SELECT 1 FROM radio_airtime_purchases WHERE slot_id::text = $1 LIMIT 1`,
      [slotId],
    );
    if (hasPurchases.rows.length > 0) {
      const u = await pool.query(
        `UPDATE radio_airtime_slots SET status = 'archived', updated_at = NOW()
          WHERE id::text = $1 AND radio_id = $2
          RETURNING id`,
        [slotId, userId],
      );
      if (u.rows.length === 0) return c.json({ error: 'Slot not found' }, 404);
      return c.json({ success: true, archived: true });
    }
    const d = await pool.query(
      `DELETE FROM radio_airtime_slots WHERE id::text = $1 AND radio_id = $2 RETURNING id`,
      [slotId, userId],
    );
    if (d.rows.length === 0) return c.json({ error: 'Slot not found' }, 404);
    return c.json({ success: true, deleted: true });
  } catch (error: any) {
    console.error('[airtime] delete slot error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /airtime-purchases — заявки от артистов в кабинет радио
app.get('/airtime-purchases', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = await getUserId(c);
    const status = c.req.query('status') || null;
    const params: any[] = [userId];
    let where = `WHERE p.radio_id = $1`;
    if (status) {
      params.push(status);
      where += ` AND p.status = $2`;
    }
    const r = await pool.query(
      `SELECT p.*, s.title as slot_title, s.description as slot_description
         FROM radio_airtime_purchases p
         LEFT JOIN radio_airtime_slots s ON s.id = p.slot_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT 200`,
      params,
    );
    return c.json({ success: true, purchases: r.rows.map(mapPurchaseRow) });
  } catch (error: any) {
    console.error('[airtime] list purchases error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /airtime-purchases/:id/approve — radio одобряет заявку (после paid)
app.put('/airtime-purchases/:id/approve', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = await getUserId(c);
    const purchaseId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const scheduledAt = body.scheduledAt ? new Date(String(body.scheduledAt)) : null;
    if (scheduledAt && isNaN(scheduledAt.getTime())) {
      return c.json({ error: 'scheduledAt must be ISO date' }, 400);
    }

    const r = await pool.query(
      `UPDATE radio_airtime_purchases SET
         status = 'approved',
         scheduled_at = $3::timestamptz,
         updated_at = NOW()
       WHERE id::text = $1 AND radio_id = $2 AND status = 'paid'
       RETURNING *`,
      [purchaseId, userId, scheduledAt ? scheduledAt.toISOString() : null],
    );
    if (r.rows.length === 0) {
      return c.json({ error: 'Purchase not found or not in paid status' }, 404);
    }
    const purchase = mapPurchaseRow(r.rows[0]);

    // Notify artist
    try {
      const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
      await notifyCrossCabinet({
        targetUserId: purchase.artistId,
        targetRole: 'artist',
        sourceRole: 'radio',
        type: 'airtime_approved',
        title: 'Радиостанция одобрила ваш эфир',
        message: `Заявка на «${purchase.format}» одобрена${
          purchase.scheduledAt ? `, эфир ${new Date(purchase.scheduledAt).toLocaleString('ru-RU')}` : ''
        }. Загрузите контент в кабинете.`,
        metadata: {
          purchaseId: purchase.id,
          slotId: purchase.slotId,
          format: purchase.format,
          scheduledAt: purchase.scheduledAt,
        },
      });
    } catch (notifyErr) {
      console.warn('[airtime_approved] notify failed:', String(notifyErr));
    }

    return c.json({ success: true, purchase });
  } catch (error: any) {
    console.error('[airtime] approve purchase error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /airtime-purchases/:id/reject — radio отклоняет (refund-saga отдельным PR)
app.put('/airtime-purchases/:id/reject', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = await getUserId(c);
    const purchaseId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const reason = String(body.reason || '').slice(0, 500);

    const r = await pool.query(
      `UPDATE radio_airtime_purchases SET
         status = 'rejected',
         rejection_reason = $3,
         updated_at = NOW()
       WHERE id::text = $1 AND radio_id = $2 AND status IN ('paid', 'approved')
       RETURNING *`,
      [purchaseId, userId, reason],
    );
    if (r.rows.length === 0) {
      return c.json({ error: 'Purchase not found or cannot be rejected from current status' }, 404);
    }
    const purchase = mapPurchaseRow(r.rows[0]);

    // TODO: refund-saga (создать payment refund в YooKassa, UPDATE status='refunded').
    // Сейчас status='rejected' — артист видит, что радио отказала; refund будет
    // обработан админом вручную до тех пор, пока не зальём refund-saga (отдельный PR).

    try {
      const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
      await notifyCrossCabinet({
        targetUserId: purchase.artistId,
        targetRole: 'artist',
        sourceRole: 'radio',
        type: 'airtime_rejected',
        title: 'Радиостанция отклонила заявку на эфир',
        message: `Заявка на «${purchase.format}» отклонена${reason ? `: ${reason}` : ''}. Возврат средств — в течение 3 рабочих дней.`,
        metadata: {
          purchaseId: purchase.id,
          slotId: purchase.slotId,
          rejectionReason: reason,
        },
      });
    } catch (notifyErr) {
      console.warn('[airtime_rejected] notify failed:', String(notifyErr));
    }

    return c.json({ success: true, purchase });
  } catch (error: any) {
    console.error('[airtime] reject purchase error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /airtime-purchases/:id/broadcast — radio помечает что эфир прошёл
// (PROMO.CHECK будет подтверждать через watermark, но manual mark тоже полезен
// для отчётности и closing flow)
app.put('/airtime-purchases/:id/broadcast', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = await getUserId(c);
    const purchaseId = c.req.param('id');
    const r = await pool.query(
      `UPDATE radio_airtime_purchases SET
         status = 'broadcasted',
         broadcasted_at = NOW(),
         updated_at = NOW()
       WHERE id::text = $1 AND radio_id = $2 AND status = 'approved'
       RETURNING *`,
      [purchaseId, userId],
    );
    if (r.rows.length === 0) {
      return c.json({ error: 'Purchase not found or not in approved status' }, 404);
    }
    return c.json({ success: true, purchase: mapPurchaseRow(r.rows[0]) });
  } catch (error: any) {
    console.error('[airtime] broadcast purchase error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ARTIST CABINET — каталог + покупка
// ─────────────────────────────────────────────────────────────────────────────

// GET /artist/airtime-catalog — публичный каталог active-слотов всех радио
app.get('/artist/airtime-catalog', requireAuth, async (c) => {
  try {
    const format = c.req.query('format');
    const priceMin = Number(c.req.query('priceMin') || 0);
    const priceMax = Number(c.req.query('priceMax') || 0);
    const stationCity = c.req.query('city');

    const params: any[] = [];
    let where = `WHERE s.status = 'active'`;
    if (format && ALLOWED_FORMATS.has(format)) {
      params.push(format);
      where += ` AND s.format = $${params.length}`;
    }
    if (priceMin > 0) {
      params.push(priceMin);
      where += ` AND s.base_price >= $${params.length}`;
    }
    if (priceMax > 0) {
      params.push(priceMax);
      where += ` AND s.base_price <= $${params.length}`;
    }
    if (stationCity) {
      params.push(stationCity);
      where += ` AND (rp.data->>'city') ILIKE $${params.length}`;
    }

    const r = await pool.query(
      `SELECT s.*,
              rp.data->>'stationName' AS station_name,
              rp.data->>'city' AS station_city,
              rp.data->>'logoUrl' AS station_logo
         FROM radio_airtime_slots s
         LEFT JOIN profiles rp ON rp.user_id = s.radio_id AND rp.role = 'radio'
         ${where}
         ORDER BY s.created_at DESC
         LIMIT 200`,
      params,
    );
    return c.json({
      success: true,
      slots: r.rows.map((row: any) => ({
        ...mapSlotRow(row),
        stationName: row.station_name || 'Радиостанция',
        stationCity: row.station_city || null,
        stationLogo: row.station_logo || null,
      })),
    });
  } catch (error: any) {
    console.error('[airtime] catalog error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /artist/airtime-purchase — создать заявку + YooKassa session
app.post('/artist/airtime-purchase', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    const slotId = String(body.slotId || '').trim();
    if (!slotId) return c.json({ error: 'slotId required' }, 400);
    const artistMessage = String(body.artistMessage || '').slice(0, 2000);

    // Lookup slot + radio
    const slotRes = await pool.query(
      `SELECT s.*, rp.data->>'stationName' AS station_name
         FROM radio_airtime_slots s
         LEFT JOIN profiles rp ON rp.user_id = s.radio_id AND rp.role = 'radio'
        WHERE s.id::text = $1 AND s.status = 'active' LIMIT 1`,
      [slotId],
    );
    if (slotRes.rows.length === 0) return c.json({ error: 'Slot not available' }, 404);
    const slot = slotRes.rows[0];

    // Pricing: subscription discount (tier-aware)
    const basePrice = Number(slot.base_price);
    const discountedRaw: any = await applySubscriptionDiscount(userId, 'promotion', basePrice);
    const discounted = Number(discountedRaw) || basePrice;
    const totalPrice = Math.round(discounted * 100) / 100;
    const platformFee = Math.round(totalPrice * 0.15 * 100) / 100;
    const radioPayout = Math.round((totalPrice - platformFee) * 100) / 100;
    const discountPct = basePrice > 0 ? Math.round(((basePrice - totalPrice) / basePrice) * 10000) / 100 : 0;

    // Create pending purchase
    const ins = await pool.query(
      `INSERT INTO radio_airtime_purchases
         (slot_id, radio_id, artist_id, format, status, artist_message,
          total_price, discount_pct, platform_fee, radio_payout)
        VALUES ($1, $2, $3, $4, 'pending_payment', $5, $6, $7, $8, $9)
        RETURNING *`,
      [
        slot.id, slot.radio_id, userId, slot.format, artistMessage,
        totalPrice, discountPct, platformFee, radioPayout,
      ],
    );
    const purchase = mapPurchaseRow(ins.rows[0]);

    return c.json({
      success: true,
      purchase,
      checkout: {
        // Фронт открывает /api/checkout/create-session с этими полями
        itemType: 'radio_airtime',
        itemId: purchase.id,
        amount: totalPrice,
        metadata: {
          purchaseId: purchase.id,
          slotId: slot.id,
          radioId: slot.radio_id,
          format: slot.format,
          stationName: slot.station_name || 'Радиостанция',
        },
      },
    });
  } catch (error: any) {
    console.error('[airtime] create purchase error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /artist/airtime-purchases — мои покупки
app.get('/artist/airtime-purchases', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const r = await pool.query(
      `SELECT p.*,
              s.title AS slot_title, s.description AS slot_description,
              rp.data->>'stationName' AS station_name
         FROM radio_airtime_purchases p
         LEFT JOIN radio_airtime_slots s ON s.id = p.slot_id
         LEFT JOIN profiles rp ON rp.user_id = p.radio_id AND rp.role = 'radio'
         WHERE p.artist_id = $1
         ORDER BY p.created_at DESC
         LIMIT 200`,
      [userId],
    );
    return c.json({ success: true, purchases: r.rows.map(mapPurchaseRow) });
  } catch (error: any) {
    console.error('[airtime] list artist purchases error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /artist/airtime-purchases/:id/content — артист загружает контент после approve
app.post('/artist/airtime-purchases/:id/content', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const purchaseId = c.req.param('id');
    const body = await c.req.json();
    const contentUrl = String(body.contentUrl || '').trim();
    if (!contentUrl) return c.json({ error: 'contentUrl required' }, 400);

    const r = await pool.query(
      `UPDATE radio_airtime_purchases SET
         content_url = $3,
         updated_at = NOW()
       WHERE id::text = $1 AND artist_id = $2 AND status = 'approved'
       RETURNING *`,
      [purchaseId, userId, contentUrl],
    );
    if (r.rows.length === 0) {
      return c.json({ error: 'Purchase not found or not in approved status' }, 404);
    }
    return c.json({ success: true, purchase: mapPurchaseRow(r.rows[0]) });
  } catch (error: any) {
    console.error('[airtime] upload content error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export { app as airtimeRoutes };
