/**
 * RADIO ROUTES - API для кабинета радиостанций
 *
 * radio_ad_slots — row-per-slot, native cols (migration 050).
 * Остальные stores ещё на kv (radio_artist_requests, radio_venue_requests,
 * radio_finance, radio_transactions, radio_notifications, radio_analytics).
 *
 * Endpoints:
 * - POST /ad-slots/create - Создать рекламный слот
 * - GET /ad-slots/list - Список рекламных слотов
 * - PUT /ad-slots/:id - Обновить слот
 * - DELETE /ad-slots/:id - Удалить слот
 * - GET /artist-requests - Заявки артистов на ротацию
 * - PUT /artist-requests/:id/accept - Принять заявку
 * - PUT /artist-requests/:id/reject - Отклонить заявку
 * - GET /venue-requests - Заявки за��едений на рекламу
 * - PUT /venue-requests/:id/approve - Одобрить заявку заведения
 * - PUT /venue-requests/:id/reject - Отклонить заявку заведения
 * - PUT /venue-requests/:id/start-broadcast - Запустить трансляцию
 * - PUT /venue-requests/:id/complete - Завершить рекламную кампанию
 * - GET /finance/overview - Финансовая сводка
 * - GET /finance/transactions - Транзакции
 * - GET /notifications - Уведомления
 * - PUT /notifications/:id/read - Прочитать уведомление
 * - PUT /notifications/read-all - Прочитать все уведомления
 * - GET /analytics - Агрегированная аналитика радиостанции
 */

import { Hono } from 'hono';
import {
  getRadioAdSlot, listRadioAdSlotsByStation, countRadioAdSlots,
  upsertRadioAdSlot, deleteRadioAdSlot,
  getRadioProfile,
  // Phase D KV→SQL closeout (2026-05-31): radio*Store facades заменены
  // на explicit list helpers ниже.
  listRadioArtistRequestsByStation,
  listRadioVenueRequestsByStation,
  listRadioNotificationsByStation,
  updateRadioArtistRequest, updateRadioVenueRequest, deleteRadioVenueRequest,
  markRadioNotificationRead, markRadioNotificationsAllRead,
} from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { requireAuth, requireRole } from './auth-middleware.tsx';
import { profileLimiter } from './rate-limiter.tsx';
import { notifyArtistRequest, notifyVenueRequest } from './email-helper.tsx';
import { logUserAction } from './audit-helper.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

// Helper: получить userId через единый хелпер авторизации.
// Audit B-R2 (2026-05-31): раньше при отсутствии userId возвращался хак
// FALLBACK_RADIO_USER_ID = 'anonymous' → ВСЕ writes падали в KV под
// одним ключом 'anonymous' (cross-station contamination — заявки/
// уведомления radioA смешивались с radioB). Все callers идут под
// requireAuth, так что null-userId это middleware-bug; fail-safe: throw
// 401-friendly Error который handler catch'нет (вместо silent write
// в чужой scope).
async function getRadioUserId(c: any): Promise<string> {
  const userId = c.get('userId');
  if (!userId) {
    throw new Error('UNAUTHORIZED_NO_USER_ID');
  }
  return userId;
}

// Helper: Get radio station for current user
async function getStation(userId: string) {
  const data = await getRadioProfile(userId);
  return data || null;
}

// =====================================================
// AD SLOTS ENDPOINTS
// =====================================================

// POST /ad-slots/create
app.post('/ad-slots/create', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const body = await c.req.json();
    const { slotType, timeSlot, price, duration, maxPerHour, description } = body;

    const slotId = `slot-${crypto.randomUUID()}`;
    // Single INSERT — раньше делали 2 write'а (slot + index), без транзакции.
    await upsertRadioAdSlot(station.id, slotId, {
      slotType: slotType || 'standard',
      timeSlot: timeSlot || '12:00-13:00',
      price: price || 0,
      duration: duration || 30,
      maxPerHour: maxPerHour || 4,
      description: description || '',
      status: 'available',
    });
    const adSlot = await getRadioAdSlot(station.id, slotId);
    return c.json({ success: true, adSlot, message: 'Ad slot created successfully' });
  } catch (error: any) {
    console.error('Error creating ad slot:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /ad-slots/list
app.get('/ad-slots/list', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    // Native query через idx_radio_ad_slots_station_created — одна
    // round-trip взамен «get index array + Promise.all per-id fetch».
    const adSlots = await listRadioAdSlotsByStation(station.id);
    return c.json({ success: true, adSlots });
  } catch (error: any) {
    console.error('Error listing ad slots:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /ad-slots/:id
app.put('/ad-slots/:id', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const slotId = c.req.param('id');
    const existing = await getRadioAdSlot(station.id, slotId);
    if (!existing) {
      return c.json({ error: 'Ad slot not found' }, 404);
    }

    const body = await c.req.json();
    const merged = {
      slotType:    body.slotType    !== undefined ? body.slotType    : existing.slotType,
      timeSlot:    body.timeSlot    !== undefined ? body.timeSlot    : existing.timeSlot,
      price:       body.price       !== undefined ? body.price       : existing.price,
      duration:    body.duration    !== undefined ? body.duration    : existing.duration,
      maxPerHour:  body.maxPerHour  !== undefined ? body.maxPerHour  : existing.maxPerHour,
      description: body.description !== undefined ? body.description : existing.description,
      status:      body.status      !== undefined ? body.status      : existing.status,
    };
    await upsertRadioAdSlot(station.id, slotId, merged);
    const adSlot = await getRadioAdSlot(station.id, slotId);
    return c.json({ success: true, adSlot });
  } catch (error: any) {
    console.error('Error updating ad slot:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /ad-slots/:id
app.delete('/ad-slots/:id', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const slotId = c.req.param('id');
    // Atomic composite-key DELETE — фикс IDOR. Раньше radioAdSlotsStore
    // .del(slotId) удалял по id без проверки radio_id, любой залогиненный
    // юзер с известным slot id мог удалить чужой слот.
    const rowCount = await deleteRadioAdSlot(station.id, slotId);
    if (rowCount === 0) {
      return c.json({ error: 'Ad slot not found' }, 404);
    }
    // Audit B-R3 (2026-05-31): forensic trail — кто удалил рекламный слот.
    logUserAction(c, {
      action: 'radio_ad_slot_delete',
      resourceType: 'radio_ad_slot',
      targetId: String(slotId),
      details: { stationId: station.id },
    });
    return c.json({ success: true, message: 'Ad slot deleted' });
  } catch (error: any) {
    console.error('Error deleting ad slot:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// ARTIST REQUESTS ENDPOINTS
// =====================================================

// GET /artist-requests
app.get('/artist-requests', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const requestsData = await listRadioArtistRequestsByStation(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    return c.json({ success: true, data: requests });
  } catch (error: any) {
    console.error('Error fetching artist requests:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /artist-requests/:id/accept
app.put('/artist-requests/:id/accept', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const requestId = c.req.param('id');
    // Atomic UPDATE WHERE radio_id + id — race-free vs legacy get→mutate→set.
    const updated = await updateRadioArtistRequest(station.id, requestId, {
      status: 'accepted',
      respondedAt: new Date().toISOString(),
    });
    if (!updated) {
      return c.json({ error: 'Request not found' }, 404);
    }

    // Email admin about accepted artist request
    notifyArtistRequest({ artistName: updated.artistName || 'Unknown', trackTitle: updated.trackTitle || '', stationId: station.id }).catch(() => {});

    return c.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Error accepting artist request:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /artist-requests/:id/reject
app.put('/artist-requests/:id/reject', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const requestId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    // Atomic UPDATE — race-free vs legacy get→mutate→set.
    const updated = await updateRadioArtistRequest(station.id, requestId, {
      status: 'rejected',
      rejectionReason: body.reason || '',
      respondedAt: new Date().toISOString(),
    });
    if (!updated) {
      return c.json({ error: 'Request not found' }, 404);
    }

    return c.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Error rejecting artist request:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// VENUE REQUESTS ENDPOINTS
// =====================================================

// GET /venue-requests
app.get('/venue-requests', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const requestsData = await listRadioVenueRequestsByStation(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    return c.json({ success: true, data: requests });
  } catch (error: any) {
    console.error('Error fetching venue requests:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /venue-requests/:id/approve
app.put('/venue-requests/:id/approve', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const requestId = c.req.param('id');
    // Atomic UPDATE — race-free vs legacy get→mutate→set.
    const now = new Date().toISOString();
    const updated = await updateRadioVenueRequest(station.id, requestId, {
      status: 'approved', approvedAt: now, reviewedAt: now,
    });
    if (!updated) {
      return c.json({ error: 'Venue request not found' }, 404);
    }

    // Email admin about approved venue request
    notifyVenueRequest({ venueName: updated.venueName || 'Unknown', venueCity: updated.venueCity, totalPrice: updated.totalPrice, stationId: station.id }).catch(() => {});

    // 2026-06-05: оповестить САМО заведение об approve. Раньше письмо
    // notifyVenueRequest выше шло только админу, venue узнавал о
    // подтверждении ТОЛЬКО при reload кабинета. PROMO.FM-аудит перед
    // рассылкой по радиостанциям выявил этот sync-gap.
    // venue_id в radio_venue_requests — это venue_profiles.id (uuid);
    // user_id заведения достаём отдельным lookup'ом (venue_profiles.user_id = TEXT).
    if (updated.venueId) {
      try {
        const { pool } = await import('./db-client.tsx');
        const vRes = await pool.query<{ user_id: string }>(
          `SELECT user_id FROM venue_profiles WHERE id::text = $1 LIMIT 1`,
          [updated.venueId],
        );
        const venueUserId = vRes.rows[0]?.user_id;
        if (venueUserId) {
          const stationLabel = (station as any).stationName || (station as any).name || 'Радиостанция';
          try {
            const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
            await notifyCrossCabinet({
              targetUserId: venueUserId,
              targetRole: 'venue',
              sourceRole: 'radio',
              type: 'venue_request_approved',
              title: 'Радиостанция приняла вашу заявку',
              message: `${stationLabel} одобрила вашу рекламную кампанию на ${updated.totalPrice} ₽. Эфир скоро начнётся.`,
              metadata: {
                campaignId: updated.id,
                stationId: station.id,
                stationName: stationLabel,
                totalPrice: Number(updated.totalPrice) || 0,
              },
            });
          } catch (notifyErr) {
            console.warn('[venue_request_approved] cross-cabinet notify failed:', String(notifyErr));
          }
        }
      } catch (lookupErr) {
        console.warn('[venue_request_approved] venue user lookup failed:', String(lookupErr));
      }
    }

    return c.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Error approving venue request:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ─── Refund saga при reject оплаченной venue_ad_campaign (BLOCKER B) ───
// До этого PR'а (audit 2026-06-03): если станция реджектила оплаченную
// кампанию, /venue-requests/:id/reject и /orders/:id/reject просто
// флипали status='rejected' БЕЗ возврата денег. Venue платил впустую.
//
// Этот helper вызывается из обоих reject-handler'ов (radio-routes.tsx:326
// venue-requests и :591 orders). Идемпотентность через
// idempotenceKey=`refund-campaign-${id}` одинакова из обоих путей →
// двойной reject (через два разных endpoint'а) не приведёт к двойному
// возврату.
//
// Failure modes:
//   - Кампания не оплачена (paid_at IS NULL) → no-op, ok:true,
//     needed:false
//   - Уже refunded/cancelled → ok:true, already:'refunded', needed:false
//   - payment_session не найден → ok:false, нужен ручной возврат
//   - gateway != yookassa → ok:false, нужен manual в дашборде
//   - yk.refund() exception → ok:false с error.message, лог-warn —
//     reject status остаётся (радио сказало «нет», запись валидна),
//     но админ должен ручно refund'нуть.
async function refundVenueCampaignOnReject(
  campaignId: string,
  userId: string,
  reason: string,
): Promise<any> {
  let refundResult: any = { needed: false };
  try {
    const { pool: rePool } = await import('./db-client.tsx');
    const { ensureSchemaInline } = await import('./db-client.tsx');
    // ensureSchema — на случай если миграция 101 не успела применена
    // до restart. Не silent — log + benign-race detection.
    await ensureSchemaInline(
      'venue_ad_campaigns:payment_refund_cols',
      `ALTER TABLE venue_ad_campaigns
         ADD COLUMN IF NOT EXISTS payment_order_id TEXT,
         ADD COLUMN IF NOT EXISTS payment_gateway  TEXT,
         ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS refunded_at      TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS refund_id        TEXT,
         ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
         ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ`
    );

    const camp = await rePool.query(
      `SELECT id, venue_id, budget, payment_order_id, payment_gateway, paid_at, status, refunded_at
         FROM venue_ad_campaigns WHERE id = $1 LIMIT 1`,
      [campaignId]
    );
    if (camp.rows.length === 0 || !camp.rows[0].payment_order_id || !camp.rows[0].paid_at) {
      // Кампания не оплачена или не существует — нечего возвращать.
      return refundResult;
    }
    const campaign = camp.rows[0];
    if (campaign.status === 'refunded' || campaign.status === 'cancelled' || campaign.refunded_at) {
      return { needed: false, already: campaign.status };
    }

    refundResult.needed = true;
    const { getPaymentSession } = await import('./db.tsx');
    const session = await getPaymentSession(campaign.payment_order_id) as any;
    if (!session?.gatewayPaymentId) {
      refundResult = { needed: true, ok: false, error: 'payment_session не найден — нужен ручной refund в дашборде ЮКассы' };
      console.error('[venue-reject] payment_session not found', { campaignId });
      return refundResult;
    }
    if (session.gateway !== 'yookassa') {
      refundResult = { needed: true, ok: false, error: `Refund невозможен: gateway=${session.gateway} (Stripe/T-Bank auto-refund не настроен)` };
      console.error('[venue-reject] refund gateway mismatch', { campaignId, gateway: session.gateway });
      return refundResult;
    }

    const { YooKassaGateway } = await import('./gateway-yookassa.tsx');
    const yk = new YooKassaGateway();
    const refund = await yk.refund(session.gatewayPaymentId, Number(campaign.budget), {
      description: `Возврат: радио отклонило кампанию #${campaignId}${reason ? ': ' + reason.slice(0, 100) : ''}`.slice(0, 250),
      idempotenceKey: `refund-campaign-${campaignId}`,
      metadata: { campaignId, refundedBy: userId, reason: reason || '' },
    });
    // Флипаем кампанию в refunded ТОЛЬКО при успехе refund'а.
    await rePool.query(
      `UPDATE venue_ad_campaigns
          SET status='refunded',
              refunded_at = NOW(),
              refund_id = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [campaignId, refund.id]
    );
    refundResult = { needed: true, ok: true, refundId: refund.id, status: refund.status };
  } catch (refundErr: any) {
    console.error('[venue-reject] refund error:', refundErr);
    refundResult = { needed: true, ok: false, error: refundErr?.message || 'Refund failed' };
  }
  return refundResult;
}

// PUT /venue-requests/:id/reject
app.put('/venue-requests/:id/reject', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const requestId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    // Atomic UPDATE.
    const updated = await updateRadioVenueRequest(station.id, requestId, {
      status: 'rejected',
      rejectionReason: body.reason || '',
      reviewedAt: new Date().toISOString(),
    });
    if (!updated) {
      return c.json({ error: 'Venue request not found' }, 404);
    }

    // BLOCKER B: refund saga для оплаченной кампании.
    const refundResult = await refundVenueCampaignOnReject(requestId, userId, body.reason || '');

    logUserAction(c, {
      action: 'radio_reject_venue_request',
      resourceType: 'venue_request',
      targetId: String(requestId),
      details: { stationId: station.id, reason: body.reason || '', refund: refundResult },
    });

    return c.json({ success: true, data: updated, refund: refundResult });
  } catch (error: any) {
    console.error('Error rejecting venue request:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /venue-requests/:id/start-broadcast
app.put('/venue-requests/:id/start-broadcast', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const requestId = c.req.param('id');
    // Read for status check first; then atomic UPDATE with conditional.
    const { pool: brPool } = await import('./db-client.tsx');
    const existsRes = await brPool.query(
      `SELECT status FROM radio_venue_requests WHERE radio_id = $1 AND id = $2 LIMIT 1`,
      [station.id, requestId]
    );
    if (existsRes.rows.length === 0) {
      return c.json({ error: 'Venue request not found' }, 404);
    }
    if (existsRes.rows[0].status !== 'approved') {
      return c.json({ error: 'Request must be approved before broadcasting' }, 400);
    }

    const updated = await updateRadioVenueRequest(station.id, requestId, { status: 'in_progress' });

    return c.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Error starting broadcast for venue request:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /venue-requests/:id/complete - Завершить рекламную кампанию
app.put('/venue-requests/:id/complete', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const { pool } = await import('./db-client.tsx');
    const requestId = c.req.param('id');
    const requestsData = await listRadioVenueRequestsByStation(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];
    const idx = requests.findIndex((r: any) => r.id === requestId);
    if (idx === -1) {
      return c.json({ error: 'Venue request not found' }, 404);
    }
    if (requests[idx].status !== 'in_progress') {
      return c.json({ error: 'Request must be in_progress to complete' }, 400);
    }

    const req = requests[idx];
    // Audit A-R3 (2026-05-31): атомарный compare-and-swap. Раньше между
    // status-check выше и updateRadioVenueRequest ниже был race-window —
    // два параллельных complete от одного admin'а (двойной клик) или
    // admin+radio оба завершали одну заявку → recordRevenue вызывался
    // дважды (double billing). UPDATE WHERE status='in_progress' гарантирует
    // что second call видит rowCount=0 и handler отвечает 409.
    const completedPlays = req.targetPlays || req.completedPlays || 0;
    const guardResult = await pool.query(
      `UPDATE radio_venue_requests
          SET status = 'completed',
              completed_at = NOW(),
              completed_plays = $3,
              updated_at = NOW()
        WHERE radio_id = $1 AND id = $2 AND status = 'in_progress'
       RETURNING id`,
      [station.id, requestId, completedPlays]
    );
    if (guardResult.rowCount === 0) {
      // race: другой actor успел complete'нуть между check'ом и update'ом
      return c.json({ error: 'Request already completed by another session' }, 409);
    }
    const updated = await updateRadioVenueRequest(station.id, requestId, {});
    Object.assign(req, updated || {});

    // Записать доход платформы (комиссия 15% от рекламной сделки)
    const totalPrice = req.totalPrice || 0;
    const platformFee = req.platformFee || Math.round(totalPrice * 0.15);
    const stationPayout = req.stationPayout || (totalPrice - platformFee);

    if (totalPrice > 0) {
      await recordRevenue({
        channel: 'radio_venue',
        description: `Реклама: ${req.venueName} на ${station.name || 'радиостанции'}`,
        grossAmount: totalPrice,
        platformRevenue: platformFee,
        payoutAmount: stationPayout,
        commissionRate: 0.15,
        payerId: req.venueId || 'venue',
        payerName: req.venueName || 'Заведение',
        payeeId: station.id,
        payeeName: station.name || 'Радиостанция',
        metadata: {
          requestId: req.id,
          stationId: station.id,
          venueCity: req.venueCity,
          durationDays: req.durationDays,
          totalPlays: req.completedPlays,
          impressions: req.impressions,
        },
      });
    }

    return c.json({ success: true, data: req });
  } catch (error: any) {
    console.error('Error completing venue request:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// ORDERS ENDPOINTS (venue-requests mapped to order format)
// =====================================================

// Helper: map venue-request status to AdvertisementOrder status
function mapRequestStatusToOrderStatus(status: string): string {
  const mapping: Record<string, string> = {
    pending: 'in_review',
    approved: 'approved_by_radio',
    rejected: 'rejected_by_radio',
    in_progress: 'approved_by_radio',
    completed: 'fulfilled',
    cancelled: 'cancelled',
    paused: 'paused',
  };
  return mapping[status] || status;
}

// GET /orders
app.get('/orders', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const requestsData = await listRadioVenueRequestsByStation(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const orders = requests.map((req: any) => ({
      id: req.id,
      packageId: req.packageId || '',
      sellerRadioId: station.id,
      buyerUserId: req.venueId || '',
      buyerUserEmail: '',
      buyerUserName: req.venueName || '',
      buyerVenueName: req.venueName || '',
      broadcastSlotIds: [],
      totalSlots: (req.playsPerDay || 0) * (req.durationDays || 0),
      adCreativeFileUrl: req.audioUrl || '',
      adCreativeType: req.audioUrl ? 'audio_file' : 'text_to_speech',
      status: mapRequestStatusToOrderStatus(req.status),
      baseAmount: req.totalPrice || 0,
      discountAmount: 0,
      demandSurcharge: 0,
      paymentAmount: req.totalPrice || 0,
      commissionAmount: req.platformFee || Math.round((req.totalPrice || 0) * 0.15),
      netAmountToRadio: req.stationPayout || Math.round((req.totalPrice || 0) * 0.85),
      commissionStatus: req.status === 'completed' ? 'collected' : 'pending',
      pricingDetails: {
        basePricePerSlot: (req.totalPrice || 0) / Math.max((req.playsPerDay || 1) * (req.durationDays || 1), 1),
        totalSlots: (req.playsPerDay || 0) * (req.durationDays || 0),
        occupancyPercent: 0,
        demandMultiplierApplied: false,
        bulkDiscountApplied: false,
        discountPercent: 0,
      },
      playReport: {
        totalPlays: req.completedPlays || 0,
        playDates: [],
        detailedSchedule: [],
        completionPercent: req.targetPlays > 0
          ? Math.round(((req.completedPlays || 0) / req.targetPlays) * 100)
          : 0,
      },
      reviewedAt: req.reviewedAt,
      rejectionReason: req.rejectionReason,
      fulfilledAt: req.completedAt,
      paidAt: req.submittedAt,
      createdAt: req.submittedAt || new Date().toISOString(),
      updatedAt: req.reviewedAt || req.submittedAt || new Date().toISOString(),
    }));

    return c.json({ success: true, orders });
  } catch (error: any) {
    console.error('Error fetching orders:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /orders/:id/approve
// Audit A-R2 (2026-05-31): profileLimiter — spam accept одной заявки
// раньше был возможен (race на cross-station notifications).
app.put('/orders/:id/approve', requireAuth, profileLimiter, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const orderId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    // Status guard + atomic UPDATE.
    const requestsData = await listRadioVenueRequestsByStation(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];
    const idx = requests.findIndex((r: any) => r.id === orderId);
    if (idx === -1) return c.json({ error: 'Order not found' }, 404);
    if (requests[idx].status !== 'pending') {
      return c.json({ error: 'Only pending orders can be approved' }, 400);
    }

    // Audit B-R1 (2026-05-31): body.notes раньше silently dropped (`void
    // body.notes`). Migration 096 добавила колонку review_notes; теперь
    // сохраняется при наличии. Cap 2000 chars — frontend длинее не шлёт,
    // CHECK constraint в БД защищает от мусора.
    const reviewNotes = typeof body.notes === 'string'
      ? body.notes.slice(0, 2000)
      : undefined;
    const now = new Date().toISOString();
    const updated = await updateRadioVenueRequest(station.id, orderId, {
      status: 'approved', reviewedAt: now, approvedAt: now,
      ...(reviewNotes ? { reviewNotes } : {}),
    });

    return c.json({ success: true, data: updated || requests[idx] });
  } catch (error: any) {
    console.error('Error approving order:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /orders/:id/reject
// Audit A-R2: profileLimiter — see /approve выше.
app.put('/orders/:id/reject', requireAuth, profileLimiter, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const orderId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const requestsData = await listRadioVenueRequestsByStation(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];
    const idx = requests.findIndex((r: any) => r.id === orderId);
    if (idx === -1) return c.json({ error: 'Order not found' }, 404);
    if (!['pending', 'approved'].includes(requests[idx].status)) {
      return c.json({ error: 'Only pending or approved orders can be rejected' }, 400);
    }

    const updated = await updateRadioVenueRequest(station.id, orderId, {
      status: 'rejected',
      rejectionReason: body.reason || '',
      reviewedAt: new Date().toISOString(),
    });

    // BLOCKER B: эта ручка зовётся фронтом через rejectOrder() из секции
    // «Заказы». До этого PR'а — только флипала status, без refund'а.
    // Теперь оба reject-endpoint'а через один helper.
    const refundResult = await refundVenueCampaignOnReject(orderId, userId, body.reason || '');

    logUserAction(c, {
      action: 'radio_reject_order',
      resourceType: 'venue_request',
      targetId: String(orderId),
      details: { stationId: station.id, reason: body.reason || '', refund: refundResult },
    });

    return c.json({ success: true, data: updated || requests[idx], refund: refundResult });
  } catch (error: any) {
    console.error('Error rejecting order:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /orders/:id/fulfill
app.put('/orders/:id/fulfill', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const orderId = c.req.param('id');
    const requestsData = await listRadioVenueRequestsByStation(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];
    const idx = requests.findIndex((r: any) => r.id === orderId);
    if (idx === -1) return c.json({ error: 'Order not found' }, 404);
    if (!['approved', 'in_progress'].includes(requests[idx].status)) {
      return c.json({ error: 'Only approved or in-progress orders can be fulfilled' }, 400);
    }

    const req = requests[idx];
    // Atomic UPDATE.
    const updated = await updateRadioVenueRequest(station.id, orderId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      completedPlays: req.targetPlays || req.completedPlays || 0,
    });
    Object.assign(req, updated || {});

    // Platform revenue: 15% commission
    const totalPrice = req.totalPrice || 0;
    const platformFee = Math.round(totalPrice * 0.15);
    const stationPayout = totalPrice - platformFee;

    if (totalPrice > 0) {
      await recordRevenue({
        channel: 'radio_venue',
        description: `Ad campaign: ${req.venueName} on ${station.name || 'station'}`,
        grossAmount: totalPrice,
        platformRevenue: platformFee,
        payoutAmount: stationPayout,
        commissionRate: 0.15,
        payerId: req.venueId || 'venue',
        payerName: req.venueName || 'Venue',
        payeeId: station.id,
        payeeName: station.name || 'Radio',
        metadata: {
          orderId: req.id,
          stationId: station.id,
          venueCity: req.venueCity,
          durationDays: req.durationDays,
          totalPlays: req.completedPlays,
        },
      });
    }

    return c.json({ success: true, data: req });
  } catch (error: any) {
    console.error('Error fulfilling order:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});


// =====================================================
// FINANCE ENDPOINTS
// =====================================================

// GET /finance/overview
app.get('/finance/overview', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    // 2026-06-10: radio_finance таблица — dead store (0 writers), её
    // чтение давало вечный ₽0. Реальный доход станции от рекламы
    // заведений живёт в radio_venue_requests: stationPayout = 85% от
    // totalPrice, посчитан при создании кампании (line 581). Тот же
    // источник, что уже агрегирует /analytics — finance/overview
    // просто его не использовал. Радио из рассылки видело ₽0 дохода.
    const venueRequests = await listRadioVenueRequestsByStation((station as any).id);
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    const inMonth = (iso: string | null, m: number, y: number): boolean => {
      if (!iso) return false;
      const d = new Date(iso);
      return !isNaN(d.getTime()) && d.getMonth() === m && d.getFullYear() === y;
    };
    // earned = завершённые кампании (деньги отработаны).
    // pending = оплаченные но ещё не завершённые (approved/in_progress) —
    // деньги у платформы, станции причитаются после complete.
    const earned = venueRequests.filter((r: any) => r.status === 'completed');
    const pending = venueRequests.filter((r: any) => r.status === 'approved' || r.status === 'in_progress');
    const sum = (arr: any[], key: string) => arr.reduce((s: number, r: any) => s + (Number(r[key]) || 0), 0);

    const lastM = thisMonth === 0 ? 11 : thisMonth - 1;
    const lastY = thisMonth === 0 ? thisYear - 1 : thisYear;

    const finance = {
      // Доход станции (85%) от завершённых рекламных кампаний.
      totalRevenue: sum(earned, 'stationPayout'),
      monthlyRevenue: sum(earned.filter((r: any) => inMonth(r.completedAt || r.createdAt, thisMonth, thisYear)), 'stationPayout'),
      lastMonthRevenue: sum(earned.filter((r: any) => inMonth(r.completedAt || r.createdAt, lastM, lastY)), 'stationPayout'),
      // Весь доход станции — реклама заведений (subscription у радио нет).
      adRevenue: sum(earned, 'stationPayout'),
      subscriptionRevenue: 0,
      // Ожидается к выплате — оплаченные кампании в работе.
      pendingPayments: sum(pending, 'stationPayout'),
      // Комиссия платформы (15%) для прозрачности.
      platformCommission: sum(earned, 'platformFee'),
      completedCampaigns: earned.length,
    };

    return c.json({ success: true, finance });
  } catch (error: any) {
    console.error('Error fetching finance overview:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /finance/transactions
app.get('/finance/transactions', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    // 2026-06-10: radio_transactions — dead store (0 writers). Реальные
    // транзакции станции = рекламные кампании заведений из
    // radio_venue_requests. Каждая оплаченная/завершённая кампания —
    // строка истории: сколько станция получила (stationPayout), сколько
    // удержала платформа (platformFee), статус.
    const venueRequests = await listRadioVenueRequestsByStation((station as any).id);
    const transactions = venueRequests
      .filter((r: any) => r.status === 'completed' || r.status === 'approved' || r.status === 'in_progress')
      .map((r: any) => ({
        id: r.id,
        type: 'ad_campaign',
        venueName: r.venueName || 'Заведение',
        venueCity: r.venueCity || null,
        grossAmount: Number(r.totalPrice) || 0,
        stationPayout: Number(r.stationPayout) || 0,
        platformFee: Number(r.platformFee) || 0,
        status: r.status,
        // 'completed' = выплачено/отработано; иначе — в обработке.
        settlementStatus: r.status === 'completed' ? 'settled' : 'pending',
        createdAt: r.createdAt || null,
        completedAt: r.completedAt || null,
      }))
      .sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    return c.json({ success: true, transactions });
  } catch (error: any) {
    console.error('Error fetching transactions:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// FINANCE / WITHDRAWALS — radio station partner payouts
// =====================================================

// row-per-withdrawal (migration 043). Radio scope'ится через source='radio'.
// Legacy ключ 'radio:${userId}' распакован миграцией в user_id + source.

function mapRadioWithdrawalRow(r: any): any {
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : undefined);
  return {
    id: r.app_id,
    source: r.source,
    stationId: r.user_id,
    amount: Number(r.amount),
    paymentMethod: r.payment_method || undefined,
    paymentDetails: r.payment_details || null,
    status: r.status,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

async function _getRadioWithdrawals(stationUserId: string): Promise<any[]> {
  const { pool: rwPool } = await import('./db-client.tsx');
  const r = await rwPool.query(
    `SELECT app_id, user_id, source, amount, payment_method, payment_details,
            status, created_at, updated_at
       FROM payment_withdrawals
      WHERE user_id = $1 AND source = 'radio'
      ORDER BY created_at DESC`,
    [stationUserId]
  );
  return r.rows.map(mapRadioWithdrawalRow);
}

async function _getRadioBalance(stationUserId: string): Promise<number> {
  // radio_finance table never populated — 0 writers в codebase. Balance
  // computed solely from withdrawals (reserved amounts). Previously
  // _getRadioBalance читал из jsonb-blob, который всегда был empty.
  const balance = 0;
  const wds = await _getRadioWithdrawals(stationUserId);
  const reserved = wds
    .filter((w: any) => w?.status !== 'rejected' && w?.status !== 'cancelled')
    .reduce((s: number, w: any) => s + (Number(w?.amount) || 0), 0);
  return Math.max(0, balance - reserved);
}

// GET /finance/withdrawals — список заявок радиостанции
app.get('/finance/withdrawals', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const list = await _getRadioWithdrawals(userId);
    const balance = await _getRadioBalance(userId);
    return c.json({
      success: true,
      withdrawals: list.sort((a: any, b: any) =>
        String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''))
      ),
      balance,
    });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /finance/withdrawals — создать заявку. body: { amount, paymentMethod?, paymentDetails? }
// Минимум 500 ₽, без комиссии, проверка баланса.
app.post('/finance/withdrawals', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const body = await c.req.json();
    const amount = Number(body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ success: false, error: 'amount must be > 0' }, 400);
    }
    if (amount < 500) {
      return c.json({ success: false, error: 'Минимальная сумма вывода — 500 ₽' }, 400);
    }

    const balance = await _getRadioBalance(userId);
    if (amount > balance) {
      return c.json({ success: false, error: `Недостаточно средств. Доступно: ${balance} ₽`, balance }, 400);
    }

    const id = `wd-${crypto.randomUUID()}`;
    const paymentMethod = body.paymentMethod || 'card';
    const paymentDetails = body.paymentDetails || null;

    // row-per-withdrawal: атомарный INSERT, race-free.
    const { pool: rwPool } = await import('./db-client.tsx');
    const ins = await rwPool.query(
      `INSERT INTO payment_withdrawals
         (app_id, user_id, source, amount, payment_method, payment_details, status)
       VALUES ($1, $2, 'radio', $3, $4, $5::jsonb, 'pending')
       ON CONFLICT (user_id, app_id) DO NOTHING
       RETURNING app_id, user_id, source, amount, payment_method,
                 payment_details, status, created_at, updated_at`,
      [id, userId, amount, paymentMethod, paymentDetails ? JSON.stringify(paymentDetails) : null]
    );
    const withdrawal = ins.rowCount ? mapRadioWithdrawalRow(ins.rows[0]) : null;

    return c.json({ success: true, withdrawal, balance: balance - amount }, 201);
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /finance/withdrawals/:id/cancel — отменить pending заявку
app.post('/finance/withdrawals/:id/cancel', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const wdId = c.req.param('id');

    // Atomic UPDATE: только если status='pending' И owner совпадает.
    // Возвращает строку чтобы отличить 404 vs «not pending» vs OK.
    const { pool: rwPool } = await import('./db-client.tsx');
    const upd = await rwPool.query(
      `UPDATE payment_withdrawals
          SET status = 'cancelled', updated_at = NOW()
        WHERE app_id = $1 AND user_id = $2 AND source = 'radio' AND status = 'pending'
       RETURNING app_id, user_id, source, amount, payment_method,
                 payment_details, status, created_at, updated_at`,
      [wdId, userId]
    );
    if (upd.rowCount === 0) {
      // Проверим почему — отсутствует или not pending.
      const check = await rwPool.query(
        `SELECT status FROM payment_withdrawals
          WHERE app_id = $1 AND user_id = $2 AND source = 'radio'`,
        [wdId, userId]
      );
      if (check.rowCount === 0) {
        return c.json({ success: false, error: 'Withdrawal not found' }, 404);
      }
      return c.json({ success: false, error: `Can only cancel pending requests (current: ${check.rows[0].status})` }, 400);
    }
    return c.json({ success: true, withdrawal: mapRadioWithdrawalRow(upd.rows[0]) });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// NOTIFICATIONS ENDPOINTS
// =====================================================

// GET /notifications
app.get('/notifications', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const notifData = await listRadioNotificationsByStation(station.id);
    const notifications = Array.isArray(notifData) ? notifData : [];

    return c.json({ success: true, notifications });
  } catch (error: any) {
    console.error('Error fetching radio notifications:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /notifications/:id/read
app.put('/notifications/:id/read', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const notifId = c.req.param('id');
    // Atomic UPDATE — race-free vs legacy whole-array overwrite.
    await markRadioNotificationRead(station.id, notifId);

    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error marking notification read:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /notifications/read-all
app.put('/notifications/read-all', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    // Atomic single UPDATE на все unread rows.
    await markRadioNotificationsAllRead(station.id);

    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error marking all notifications read:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// ANALYTICS ENDPOINT
// =====================================================

// GET /analytics - Агрегированная аналитика радиостанции
app.get('/analytics', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) return c.json({ success: false, error: 'Station not found' }, 404);

    // Собираем данные из разных stores. adSlotsCount — native COUNT(*)
    // вместо чтения JSON-массива из index-таблицы (migration 050 убрала её).
    const [artistReqData, venueReqData, adSlotsCount] = await Promise.all([
      listRadioArtistRequestsByStation(station.id),
      listRadioVenueRequestsByStation(station.id),
      countRadioAdSlots(station.id),
    ]);

    const artistRequests = Array.isArray(artistReqData) ? artistReqData : [];
    const venueRequests = Array.isArray(venueReqData) ? venueReqData : [];
    // radio_finance / radio_transactions / radio_analytics: dead stores
    // (0 writers anywhere in codebase). Empty placeholders preserve API.
    const finance: any = {};
    const transactions: any[] = [];
    const detailedAnalytics: any = {};

    // Агрегация заявок артистов
    const artistStats = {
      total: artistRequests.length,
      pending: artistRequests.filter((r: any) => r.status === 'pending').length,
      // Audit 2026-06-04: the accept route writes status='accepted' (line ~228),
      // but this bucket only matched approved/in_rotation → accepted requests were
      // invisible in every bucket yet still counted in .total (total != p+a+r).
      approved: artistRequests.filter((r: any) => r.status === 'approved' || r.status === 'in_rotation' || r.status === 'accepted').length,
      rejected: artistRequests.filter((r: any) => r.status === 'rejected').length,
    };

    // Агрегация заявок заведений
    const venueStats = {
      total: venueRequests.length,
      pending: venueRequests.filter((r: any) => r.status === 'pending').length,
      approved: venueRequests.filter((r: any) => r.status === 'approved').length,
      inProgress: venueRequests.filter((r: any) => r.status === 'in_progress').length,
      completed: venueRequests.filter((r: any) => r.status === 'completed').length,
      rejected: venueRequests.filter((r: any) => r.status === 'rejected').length,
      totalRevenue: venueRequests
        .filter((r: any) => r.status !== 'rejected' && r.status !== 'cancelled')
        .reduce((sum: number, r: any) => sum + (r.totalPrice || 0), 0),
      stationRevenue: venueRequests
        .filter((r: any) => r.status !== 'rejected' && r.status !== 'cancelled')
        .reduce((sum: number, r: any) => sum + (r.stationPayout || 0), 0),
      totalImpressions: venueRequests.reduce((sum: number, r: any) => sum + (r.impressions || 0), 0),
      totalPlays: venueRequests.reduce((sum: number, r: any) => sum + (r.completedPlays || 0), 0),
    };

    // Финансовая сводка
    const revenue = {
      total: finance.totalRevenue || finance.balance || 0,
      thisMonth: finance.thisMonthRevenue || 0,
      lastMonth: finance.lastMonthRevenue || 0,
      pendingPayout: finance.pendingPayout || 0,
      totalTransactions: transactions.length,
    };

    // Топ заведения
    const topVenues = venueRequests
      .filter((r: any) => r.status === 'completed' || r.status === 'in_progress')
      .sort((a: any, b: any) => (b.totalPrice || 0) - (a.totalPrice || 0))
      .slice(0, 5)
      .map((r: any) => ({
        name: r.venueName,
        city: r.venueCity,
        revenue: r.totalPrice || 0,
        plays: r.completedPlays || 0,
        status: r.status,
      }));

    // Топ артисты (по количеству треков в ротации)
    const topArtists = artistRequests
      .filter((r: any) => r.status === 'approved' || r.status === 'in_rotation' || r.status === 'accepted')
      .sort((a: any, b: any) => (b.totalPlays || 0) - (a.totalPlays || 0))
      .slice(0, 5)
      .map((r: any) => ({
        name: r.artistName,
        genre: r.genre,
        plays: r.totalPlays || 0,
        track: r.trackTitle,
      }));

    // Последние события
    const recentActivity = [
      ...artistRequests.slice(-5).map((r: any) => ({
        type: 'artist_request',
        title: `Заявка: ${r.artistName} - "${r.trackTitle}"`,
        status: r.status,
        date: r.submittedAt || r.createdAt,
      })),
      ...venueRequests.slice(-5).map((r: any) => ({
        type: 'venue_request',
        title: `Реклама: ${r.venueName}`,
        status: r.status,
        date: r.submittedAt || r.createdAt,
      })),
    ].sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
     .slice(0, 10);

    return c.json({
      success: true,
      analytics: {
        artistStats,
        venueStats,
        revenue,
        adSlotsCount,
        topVenues,
        topArtists,
        recentActivity,
        generatedAt: new Date().toISOString(),
        detailedAnalytics,
      },
    });
  } catch (error: any) {
    console.error('Error fetching radio analytics:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});


// -- Venue Player Registration (Promo.Air web player) --
app.post('/register-player', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const { venue_id, player_type, device_id } = await c.req.json();
    const playerId = `player-${venue_id}-${Date.now()}`;
    const authToken = `tok-${crypto.randomUUID()}`;
    return c.json({
      success: true,
      player_id: playerId,
      auth_token: authToken,
      stream_url: null,
      registered_at: new Date().toISOString(),
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// -- Venue Player Heartbeat / Status Update --
app.post('/player-status', requireAuth, async (c) => {
  try {
    const { player_id, status } = await c.req.json();
    return c.json({
      success: true,
      player_id,
      acknowledged: true,
      server_time: new Date().toISOString(),
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ════════════════════════════════════════════════════════════════════
// WEEKLY RELEASES + DOWNLOAD + ROTATION REPORTS (radio_station role)
// ════════════════════════════════════════════════════════════════════

// GET /weekly-releases/current — Current weekly release with tracks (radio-only access shows download URLs)
app.get('/weekly-releases/current', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const { pool } = await import('./db-client.tsx');
    const releaseRes = await pool.query(
      `SELECT id, title, week_number, year, release_date, track_ids, published_at
        FROM weekly_releases WHERE is_published = true ORDER BY release_date DESC LIMIT 1`
    );
    if (releaseRes.rows.length === 0) {
      return c.json({ success: true, data: null });
    }
    const release = releaseRes.rows[0];
    const trackIds = release.track_ids || [];

    if (!trackIds.length) {
      return c.json({ success: true, data: { ...release, tracks: [] } });
    }

    const tracksRes = await pool.query(
      `SELECT t.id, t.title, t.artist_name, t.genre, t.duration, t.audio_url, t.cover_url, t.release_date,
               ap.slug as artist_slug, ap.is_verified as artist_verified
        FROM tracks t LEFT JOIN artist_profiles ap ON ap.id = t.artist_id
        WHERE t.id = ANY($1) ORDER BY t.created_at DESC`,
      [trackIds]
    );
    const tracks = tracksRes.rows.map((t: any) => ({
      ...t,
      downloadUrl: `/server/api/radio/tracks/${t.id}/download`,
    }));

    return c.json({ success: true, data: { ...release, tracks } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// GET /tracks/:id/download — auth radio user, log + redirect to audio_url
app.get('/tracks/:id/download', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const trackId = c.req.param('id');
    const userId = c.get('userId');
    const { pool } = await import('./db-client.tsx');

    const tr = await pool.query(`SELECT id, title, audio_url FROM tracks WHERE id = $1`, [trackId]);
    if (tr.rows.length === 0) return c.json({ success: false, error: 'Track not found' }, 404);
    const track = tr.rows[0];
    if (!track.audio_url) return c.json({ success: false, error: 'Audio file not available' }, 404);

    // Get current weekly release id (informational)
    const wr = await pool.query(
      `SELECT id FROM weekly_releases WHERE is_published = true AND $1 = ANY(track_ids) ORDER BY release_date DESC LIMIT 1`,
      [trackId]
    );
    const weeklyReleaseId = wr.rows[0]?.id || null;

    // Get station name from radio profile (best effort)
    const sp = await pool.query(`SELECT data->>'stationName' as station_name FROM profiles WHERE user_id = $1`, [userId]);
    const stationName = sp.rows[0]?.station_name || null;

    // Log download
    await pool.query(
      `INSERT INTO track_downloads_by_radio (user_id, station_name, track_id, weekly_release_id, ip_addr, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, stationName, trackId, weeklyReleaseId,
       c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
       c.req.header('user-agent') || '']
    );

    // Redirect to audio file URL (signed not needed since audio_url is public)
    return c.redirect(track.audio_url, 302);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// POST /rotations/report — submit rotation report (status='pending', awaits admin moderation)
app.post('/rotations/report', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const { trackId, airedAt, city, region, rotationCount, stationName } = body;

    if (!trackId || !airedAt) {
      return c.json({ success: false, error: 'trackId и airedAt обязательны' }, 400);
    }
    const rc = parseInt(rotationCount) || 1;
    if (rc < 1 || rc > 100) {
      return c.json({ success: false, error: 'rotationCount должен быть от 1 до 100' }, 400);
    }

    const { pool } = await import('./db-client.tsx');
    const trackCheck = await pool.query(`SELECT id, title, artist_name, user_id FROM tracks WHERE id = $1`, [trackId]);
    if (trackCheck.rows.length === 0) return c.json({ success: false, error: 'Трек не найден' }, 404);

    // Get station name from profile if not provided
    let finalStationName = stationName;
    if (!finalStationName) {
      const sp = await pool.query(`SELECT data->>'stationName' as station_name, full_name FROM users u LEFT JOIN profiles p ON p.user_id = u.id::text WHERE u.id = $1`, [userId]);
      finalStationName = sp.rows[0]?.station_name || sp.rows[0]?.full_name || 'Радиостанция';
    }

    const insRes = await pool.query(
      `INSERT INTO track_radio_pickups (track_id, station_name, city, region, country, picked_up_at, source, rotation_count, aired_at, report_status, submitted_by_user_id)
        VALUES ($1, $2, $3, $4, 'Россия', NOW(), 'radio_self_report', $5, $6, 'pending', $7) RETURNING id`,
      [trackId, finalStationName, city || null, region || null, rc, airedAt, userId]
    );

    return c.json({ success: true, data: { reportId: insRes.rows[0].id, status: 'pending', message: 'Отчёт отправлен на модерацию' } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// GET /rotations/my-reports — radio's own reports (history)
app.get('/rotations/my-reports', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const userId = c.get('userId');
    const { pool } = await import('./db-client.tsx');
    const res = await pool.query(
      `SELECT trp.id, trp.track_id, trp.station_name, trp.city, trp.rotation_count, trp.aired_at,
              trp.report_status, trp.rejection_reason, trp.picked_up_at,
              t.title as track_title, t.artist_name
       FROM track_radio_pickups trp
       LEFT JOIN tracks t ON t.id = trp.track_id
       WHERE trp.submitted_by_user_id = $1 ORDER BY trp.picked_up_at DESC LIMIT 200`,
      [userId]
    );
    return c.json({ success: true, data: res.rows });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ════════════════════════════════════════════════════════════════════
// ADMIN: rotation report moderation
// ════════════════════════════════════════════════════════════════════
app.get('/admin/rotation-reports', requireAuth, async (c) => {
  if (c.get('userRole') !== 'admin') return c.json({ success: false, error: 'Forbidden' }, 403);
  try {
    const status = c.req.query('status') || 'pending';
    const { pool } = await import('./db-client.tsx');
    const res = await pool.query(
      `SELECT trp.id, trp.track_id, trp.station_name, trp.city, trp.region, trp.rotation_count,
              trp.aired_at, trp.report_status, trp.picked_up_at, trp.submitted_by_user_id, trp.rejection_reason,
              t.title as track_title, t.artist_name, t.cover_url, t.user_id as artist_user_id,
              u.email as radio_email
       FROM track_radio_pickups trp
       LEFT JOIN tracks t ON t.id = trp.track_id
       LEFT JOIN users u ON u.id = trp.submitted_by_user_id
       WHERE trp.report_status = $1 ORDER BY trp.picked_up_at DESC LIMIT 200`,
      [status]
    );
    return c.json({ success: true, data: res.rows });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.post('/admin/rotation-reports/:id/approve', requireAuth, async (c) => {
  if (c.get('userRole') !== 'admin') return c.json({ success: false, error: 'Forbidden' }, 403);
  try {
    const reportId = c.req.param('id');
    const adminId = c.get('userId');
    const { pool } = await import('./db-client.tsx');
    const res = await pool.query(
      `UPDATE track_radio_pickups SET report_status = 'confirmed', reviewed_at = NOW(), reviewed_by = $1
        WHERE id = $2 AND report_status = 'pending'
        RETURNING track_id, station_name, city, rotation_count, submitted_by_user_id`,
      [adminId, reportId]
    );
    if (res.rows.length === 0) return c.json({ success: false, error: 'Отчёт не найден или уже модерирован' }, 404);
    const r = res.rows[0];

    // SSE → artist
    try {
      const tr = await pool.query(`SELECT user_id, title FROM tracks WHERE id = $1`, [r.track_id]);
      if (tr.rows[0]?.user_id) {
        const { emitSSE } = await import('./sse-routes.tsx');
        emitSSE(tr.rows[0].user_id, {
          type: 'rotation_confirmed',
          data: {
            title: 'Ротация подтверждена',
            message: `«${tr.rows[0].title}» в эфире ${r.station_name} (${r.city || ''}) — ${r.rotation_count} раз`,
            trackId: r.track_id, stationName: r.station_name, city: r.city,
          },
        });
      }
    } catch {}

    return c.json({ success: true, data: { reportId, status: 'confirmed' } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.post('/admin/rotation-reports/:id/reject', requireAuth, async (c) => {
  if (c.get('userRole') !== 'admin') return c.json({ success: false, error: 'Forbidden' }, 403);
  try {
    const reportId = c.req.param('id');
    const adminId = c.get('userId');
    const { reason } = await c.req.json();
    const { pool } = await import('./db-client.tsx');
    const res = await pool.query(
      `UPDATE track_radio_pickups SET report_status = 'rejected', rejection_reason = $1, reviewed_at = NOW(), reviewed_by = $2
        WHERE id = $3 AND report_status = 'pending' RETURNING submitted_by_user_id, station_name`,
      [reason || 'Отчёт не подтверждён', adminId, reportId]
    );
    if (res.rows.length === 0) return c.json({ success: false, error: 'Отчёт не найден или уже модерирован' }, 404);

    // SSE → radio submitter
    try {
      const r = res.rows[0];
      if (r.submitted_by_user_id) {
        const { emitSSE } = await import('./sse-routes.tsx');
        emitSSE(r.submitted_by_user_id, {
          type: 'rotation_rejected',
          data: {
            title: 'Отчёт отклонён', message: reason || 'Отчёт не подтверждён модератором',
            reportId,
          },
        });
      }
    } catch {}

    return c.json({ success: true, data: { reportId, status: 'rejected' } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default app;
