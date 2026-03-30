/**
 * RADIO ROUTES - API для кабинета радиостанций
 * Маршруты радио (JSON stores)
 * 
 * KV ключи:
 * - radio_station:{userId} - профиль радиостанции
 * - radio_ad_slot:{stationId}:{slotId} - рекламный слот
 * - radio_ad_slots_index:{stationId} - JSON массив slot ID
 * - radio_artist_requests:{stationId} - заявки артистов (JSON массив)
 * - radio_venue_requests:{stationId} - заявки заведений (JSON массив)
 * - radio_finance:{stationId} - финансовая сводка
 * - radio_transactions:{stationId} - транзакции (JSON массив)
 * - radio_notifications:{stationId} - уведомления (JSON массив)
 * - radio_analytics:{stationId} - детальная аналитика
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
import { getRadioAdSlot, getRadioProfile, upsertRadioAdSlot, radioAdSlotIndexStore, radioAdSlotsStore, radioAnalyticsStore, radioArtistRequestsStore, radioFinanceStore, radioNotificationsStore, radioTransactionsStore, radioVenueRequestsStore } from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { notifyArtistRequest, notifyVenueRequest } from './email-helper.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

// Fallback radio user ID (не должен использоваться для записи)
const FALLBACK_RADIO_USER_ID = 'anonymous';

// Helper: получить userId через единый хелпер авторизации
async function getRadioUserId(c: any): Promise<string> {
  return c.get('userId') || FALLBACK_RADIO_USER_ID;
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

    const slotId = `slot-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const adSlot = {
      id: slotId,
      stationId: station.id,
      slotType: slotType || 'standard',
      timeSlot: timeSlot || '12:00-13:00',
      price: price || 0,
      duration: duration || 30,
      maxPerHour: maxPerHour || 4,
      description: description || '',
      status: 'available',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Сохранить слот
    await upsertRadioAdSlot(station.id, slotId, adSlot);

    // Обновить индекс
    const indexData = await radioAdSlotIndexStore.get(station.id);
    const slotIds: string[] = Array.isArray(indexData) ? indexData : [];
    slotIds.unshift(slotId);
    await radioAdSlotIndexStore.set(station.id, slotIds);

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

    const indexData = await radioAdSlotIndexStore.get(station.id);
    const slotIds: string[] = Array.isArray(indexData) ? indexData : [];

    if (slotIds.length === 0) {
      return c.json({ success: true, adSlots: [] });
    }

    const slotValues = await Promise.all(slotIds.map((id: string) => getRadioAdSlot(station.id, id)));
    const adSlots = slotValues
      .filter(v => v !== null);

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
    const slotData = await getRadioAdSlot(station.id, slotId);
    if (!slotData) {
      return c.json({ error: 'Ad slot not found' }, 404);
    }

    const slot = slotData;
    const body = await c.req.json();

    if (body.slotType !== undefined) slot.slotType = body.slotType;
    if (body.timeSlot !== undefined) slot.timeSlot = body.timeSlot;
    if (body.price !== undefined) slot.price = body.price;
    if (body.duration !== undefined) slot.duration = body.duration;
    if (body.maxPerHour !== undefined) slot.maxPerHour = body.maxPerHour;
    if (body.description !== undefined) slot.description = body.description;
    if (body.status !== undefined) slot.status = body.status;
    slot.updatedAt = new Date().toISOString();

    await upsertRadioAdSlot(station.id, slotId, slot);
    return c.json({ success: true, adSlot: slot });
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
    await radioAdSlotsStore.del(slotId);

    // Обновить индекс
    const indexData = await radioAdSlotIndexStore.get(station.id);
    const slotIds: string[] = Array.isArray(indexData) ? indexData : [];
    const filtered = slotIds.filter(id => id !== slotId);
    await radioAdSlotIndexStore.set(station.id, filtered);

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

    const requestsData = await radioArtistRequestsStore.get(station.id);
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
    const requestsData = await radioArtistRequestsStore.get(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const idx = requests.findIndex((r: any) => r.id === requestId);
    if (idx === -1) {
      return c.json({ error: 'Request not found' }, 404);
    }

    requests[idx].status = 'accepted';
    requests[idx].respondedAt = new Date().toISOString();
    await radioArtistRequestsStore.set(station.id, requests);

    // Email admin about accepted artist request
    notifyArtistRequest({ artistName: req.artistName || 'Unknown', trackTitle: req.trackTitle || '', stationId: station.id }).catch(() => {});

    return c.json({ success: true, data: requests[idx] });
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
    const requestsData = await radioArtistRequestsStore.get(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const idx = requests.findIndex((r: any) => r.id === requestId);
    if (idx === -1) {
      return c.json({ error: 'Request not found' }, 404);
    }

    requests[idx].status = 'rejected';
    requests[idx].rejectionReason = body.reason || '';
    requests[idx].respondedAt = new Date().toISOString();
    await radioArtistRequestsStore.set(station.id, requests);

    return c.json({ success: true, data: requests[idx] });
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

    const requestsData = await radioVenueRequestsStore.get(station.id);
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
    const requestsData = await radioVenueRequestsStore.get(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const idx = requests.findIndex((r: any) => r.id === requestId);
    if (idx === -1) {
      return c.json({ error: 'Venue request not found' }, 404);
    }

    requests[idx].status = 'approved';
    requests[idx].approvedAt = new Date().toISOString();
    requests[idx].reviewedAt = new Date().toISOString();
    await radioVenueRequestsStore.set(station.id, requests);

    // Email admin about approved venue request
    notifyVenueRequest({ venueName: req.venueName || 'Unknown', venueCity: req.venueCity, totalPrice: req.totalPrice, stationId: station.id }).catch(() => {});

    return c.json({ success: true, data: requests[idx] });
  } catch (error: any) {
    console.error('Error approving venue request:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

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
    const requestsData = await radioVenueRequestsStore.get(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const idx = requests.findIndex((r: any) => r.id === requestId);
    if (idx === -1) {
      return c.json({ error: 'Venue request not found' }, 404);
    }

    requests[idx].status = 'rejected';
    requests[idx].rejectionReason = body.reason || '';
    requests[idx].reviewedAt = new Date().toISOString();
    await radioVenueRequestsStore.set(station.id, requests);

    return c.json({ success: true, data: requests[idx] });
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
    const requestsData = await radioVenueRequestsStore.get(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const idx = requests.findIndex((r: any) => r.id === requestId);
    if (idx === -1) {
      return c.json({ error: 'Venue request not found' }, 404);
    }

    if (requests[idx].status !== 'approved') {
      return c.json({ error: 'Request must be approved before broadcasting' }, 400);
    }

    requests[idx].status = 'in_progress';
    await radioVenueRequestsStore.set(station.id, requests);

    return c.json({ success: true, data: requests[idx] });
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

    const requestId = c.req.param('id');
    const requestsData = await radioVenueRequestsStore.get(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const idx = requests.findIndex((r: any) => r.id === requestId);
    if (idx === -1) {
      return c.json({ error: 'Venue request not found' }, 404);
    }

    if (requests[idx].status !== 'in_progress') {
      return c.json({ error: 'Request must be in_progress to complete' }, 400);
    }

    const req = requests[idx];
    req.status = 'completed';
    req.completedAt = new Date().toISOString();
    req.completedPlays = req.targetPlays || req.completedPlays || 0;

    await radioVenueRequestsStore.set(station.id, requests);

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

    const requestsData = await radioVenueRequestsStore.get(station.id);
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
app.put('/orders/:id/approve', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const orderId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const requestsData = await radioVenueRequestsStore.get(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const idx = requests.findIndex((r: any) => r.id === orderId);
    if (idx === -1) {
      return c.json({ error: 'Order not found' }, 404);
    }
    if (requests[idx].status !== 'pending') {
      return c.json({ error: 'Only pending orders can be approved' }, 400);
    }

    requests[idx].status = 'approved';
    requests[idx].reviewedAt = new Date().toISOString();
    requests[idx].approvedAt = new Date().toISOString();
    requests[idx].reviewNotes = body.notes || '';
    await radioVenueRequestsStore.set(station.id, requests);

    return c.json({ success: true, data: requests[idx] });
  } catch (error: any) {
    console.error('Error approving order:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /orders/:id/reject
app.put('/orders/:id/reject', requireAuth, async (c) => {
  try {
    const userId = await getRadioUserId(c);
    const station = await getStation(userId);
    if (!station) {
      return c.json({ error: 'Radio station not found' }, 404);
    }

    const orderId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const requestsData = await radioVenueRequestsStore.get(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const idx = requests.findIndex((r: any) => r.id === orderId);
    if (idx === -1) {
      return c.json({ error: 'Order not found' }, 404);
    }
    if (!['pending', 'approved'].includes(requests[idx].status)) {
      return c.json({ error: 'Only pending or approved orders can be rejected' }, 400);
    }

    requests[idx].status = 'rejected';
    requests[idx].rejectionReason = body.reason || '';
    requests[idx].reviewedAt = new Date().toISOString();
    await radioVenueRequestsStore.set(station.id, requests);

    return c.json({ success: true, data: requests[idx] });
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
    const requestsData = await radioVenueRequestsStore.get(station.id);
    const requests = Array.isArray(requestsData) ? requestsData : [];

    const idx = requests.findIndex((r: any) => r.id === orderId);
    if (idx === -1) {
      return c.json({ error: 'Order not found' }, 404);
    }
    if (!['approved', 'in_progress'].includes(requests[idx].status)) {
      return c.json({ error: 'Only approved or in-progress orders can be fulfilled' }, 400);
    }

    const req = requests[idx];
    req.status = 'completed';
    req.completedAt = new Date().toISOString();
    req.completedPlays = req.targetPlays || req.completedPlays || 0;
    await radioVenueRequestsStore.set(station.id, requests);

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

    const financeData = await radioFinanceStore.get(station.id);
    const finance = financeData || {
      totalRevenue: 0,
      monthlyRevenue: 0,
      adRevenue: 0,
      subscriptionRevenue: 0,
      pendingPayments: 0,
      growth: 0,
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

    const txData = await radioTransactionsStore.get(station.id);
    const transactions = Array.isArray(txData) ? txData : [];

    return c.json({ success: true, transactions });
  } catch (error: any) {
    console.error('Error fetching transactions:', error);
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

    const notifData = await radioNotificationsStore.get(station.id);
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
    const notifData = await radioNotificationsStore.get(station.id);
    const notifications = Array.isArray(notifData) ? notifData : [];

    const idx = notifications.findIndex((n: any) => n.id === notifId);
    if (idx !== -1) {
      notifications[idx].read = true;
      await radioNotificationsStore.set(station.id, notifications);
    }

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

    const notifData = await radioNotificationsStore.get(station.id);
    const notifications = Array.isArray(notifData) ? notifData : [];

    for (const n of notifications) {
      n.read = true;
    }
    await radioNotificationsStore.set(station.id, notifications);

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

    // Собираем данные из раз��ых KV-ключей
    const [artistReqData, venueReqData, financeData, adSlotsIndex, transactionsData, detailedAnalyticsData] = await Promise.all([
      radioArtistRequestsStore.get(station.id),
      radioVenueRequestsStore.get(station.id),
      radioFinanceStore.get(station.id),
      radioAdSlotIndexStore.get(station.id),
      radioTransactionsStore.get(station.id),
      radioAnalyticsStore.get(station.id),
    ]);

    const artistRequests = Array.isArray(artistReqData) ? artistReqData : [];
    const venueRequests = Array.isArray(venueReqData) ? venueReqData : [];
    const finance = financeData || {};
    const adSlotIds = Array.isArray(adSlotsIndex) ? adSlotsIndex : [];
    const transactions = Array.isArray(transactionsData) ? transactionsData : [];
    const detailedAnalytics = detailedAnalyticsData || {};

    // Агрегация заявок артистов
    const artistStats = {
      total: artistRequests.length,
      pending: artistRequests.filter((r: any) => r.status === 'pending').length,
      approved: artistRequests.filter((r: any) => r.status === 'approved' || r.status === 'in_rotation').length,
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
      .filter((r: any) => r.status === 'approved' || r.status === 'in_rotation')
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
        adSlotsCount: adSlotIds.length,
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
    const authToken = `tok-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

export default app;
