/**
 * BOOKING ROUTES - API для системы букинга артистов
 * Маршруты бронирования (JSON stores)
 * 
 * KV ключи:
 * - booking:{id} - данные букинга
 * - bookings_by_user:{userId} - JSON массив booking ID для пользователя (обе роли)
 * - booking_payment:{id} - данные платежа
 * - booking_calendar:{performerId}:{date} - заблокированные даты
 * - notification:{userId}:{id} - уведомления
 * 
 * Endpoints:
 * - POST /create - Создание заявки на букинг
 * - GET /list - Список букингов пользователя
 * - PUT /:id/accept - Принять заявку (Artist)
 * - PUT /:id/reject - Отклонить заявку (Artist)
 * - POST /:id/pay-deposit - Оплатить депозит (Venue)
 * - POST /:id/pay-final - Оплатить остаток (Venue)
 * - PUT /:id/cancel - Отменить букинг
 * - GET /:id - Получить детали букинга
 */

import { getDbClient } from './db-client.tsx';
import { apiError } from './error-codes.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { Hono } from 'hono';
import { requireAuth, requireRole } from './auth-middleware.tsx';
import { getArtistProfile, getBooking, getBookingsByUser, getDjProfile, getVenueProfile, upsertBooking, upsertNotification, bookingCalendarStore, getPaymentSession } from './db.tsx';
import { notifyBookingRequest } from './email-helper.tsx';
import { emitSSE } from './sse-routes.tsx';

const app = new Hono();
const dbClient = getDbClient();

// =====================================================
// HELPER: Получить пользователя из токена
// =====================================================
async function getUserFromToken(authHeader: string | null) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.split(' ')[1];
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as any;
    return { id: decoded.userId || decoded.sub, email: decoded.email, role: decoded.role };
  } catch {
    return null;
  }
}

// =====================================================
// HELPER: legacy no-op (bookings indexed via WHERE user_id query)
// =====================================================
async function addBookingToUserIndex(_userId: string, _bookingId: string) {
  // No-op: bookings_by_user index removed in Phase 5; queries hit `bookings` table directly.
}

// =====================================================
// HELPER: Отправить уведомление через KV
// =====================================================
async function sendNotification(params: {
  userId: string;
  type: string;
  title: string;
  message: string;
  data?: any;
}) {
  try {
    const notifId = `notif-${crypto.randomUUID()}`;
    const notification = {
      id: notifId,
      userId: params.userId,
      type: params.type,
      title: params.title,
      message: params.message,
      data: params.data || {},
      read: false,
      createdAt: new Date().toISOString(),
    };
    await upsertNotification(params.userId, notifId, notification);

    // Emit SSE for real-time delivery
    emitSSE(params.userId, {
      type: 'booking_update',
      data: {
        notificationId: notifId,
        bookingType: params.type,
        title: params.title,
        message: params.message,
        ...params.data,
        createdAt: notification.createdAt,
      },
    });
  } catch (error) {
    console.error('Failed to send notification via KV:', error);
  }
}

// =====================================================
// HELPER: Получить профиль исполнителя из KV
// =====================================================
async function getPerformerProfile(performerId: string, performerType: string) {
  // Try artist KV data first
  const artistData = await getArtistProfile(performerId);
  if (artistData) {
    const artist = artistData;
    return {
      userId: artist.id,
      displayName: artist.name,
      avatar: artist.avatar,
      hourlyRate: artist.hourlyRate || 5000,
      minimumBookingHours: artist.minimumBookingHours || 2,
      bookingEnabled: true,
    };
  }

  // Try DJ profile.
  // Editor stores data nested under `profile` / `booking`. Legacy rows are
  // flat. Read both shapes so a booking can be created against either.
  const djData = await getDjProfile(performerId);
  if (djData) {
    const dj: any = djData;
    const p = dj.profile || dj;
    const b = dj.booking || dj;
    return {
      userId: dj.userId || dj.id,
      displayName: p.djName || dj.djName || dj.name || '',
      avatar: p.avatarUrl || dj.avatar || '',
      hourlyRate: b.ratePerHour || dj.hourlyRate || 4000,
      minimumBookingHours: b.minBookingHours || dj.minimumBookingHours || 2,
      // Backend supports a per-DJ off-switch via booking.openForBookings.
      bookingEnabled: b.openForBookings !== false,
    };
  }

  // Fallback: check users table — any registered user can be a performer
  try {
    const { pool } = await import('./db-client.tsx');
    const res = await pool.query('SELECT id, email, username, full_name FROM users WHERE id = $1', [performerId]);
    if (res.rows.length > 0) {
      const u = res.rows[0];
      return {
        userId: u.id,
        displayName: u.full_name || u.username || u.email,
        avatar: null,
        hourlyRate: 5000,
        minimumBookingHours: 2,
        bookingEnabled: true,
      };
    }
  } catch {}

  return null;
}

// =====================================================
// POST /create - Создать заявку на букинг
// =====================================================
app.post('/create', requireAuth, async (c) => {
  try {
    const user = { id: c.get('userId'), email: c.get('userEmail'), role: c.get('userRole') };

    const body = await c.req.json();
    const {
      performerId,
      performerType,
      eventType,
      eventTitle,
      eventDescription,
      eventDate,
      startTime,
      durationHours,
      venueAddress,
      venueCity,
      venueType,
      expectedAudience,
      audienceType,
      technicalRequirements,
      specialRequests,
    } = body;

    if (!performerId || !performerType || !eventType || !eventTitle || !eventDate || !durationHours) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS');
    }

    // Получить профиль performer'а из KV
    const performer = await getPerformerProfile(performerId, performerType);
    if (!performer) {
      console.error('Performer not found in KV:', performerId);
      return apiError(c, 'NOT_FOUND', 'Исполнитель не найден');
    }

    if (!performer.bookingEnabled) {
      return apiError(c, 'BOOKING_DISABLED');
    }

    if (durationHours < performer.minimumBookingHours) {
      return c.json({ 
        error: `Minimum booking is ${performer.minimumBookingHours} hours`,
        minimumHours: performer.minimumBookingHours
      }, 400);
    }

    // Расчет цен
    const offeredPrice = performer.hourlyRate * durationHours;
    const platformCommission = offeredPrice * 0.10;
    const performerFee = offeredPrice - platformCommission;
    const depositAmount = offeredPrice * 0.30;
    const finalAmount = offeredPrice * 0.70;

    // Получить venue profile из KV
    const venueProfileData = await getVenueProfile(user.id);
    const venueProfile = venueProfileData || null;

    // Создать букинг
    const bookingId = `booking-${crypto.randomUUID()}`;
    const booking = {
      id: bookingId,
      requesterId: user.id,
      requesterType: 'venue',
      performerId,
      performerType,
      eventType,
      eventTitle,
      eventDescription,
      eventDate,
      startTime,
      durationHours,
      venueId: venueProfile?.id,
      venueName: venueProfile?.venueName || 'Неизвестное заведение',
      venueAddress,
      venueCity,
      venueType,
      expectedAudience,
      audienceType,
      offeredPrice,
      performerFee,
      platformCommission,
      depositAmount,
      depositPercentage: 30.0,
      finalAmount,
      technicalRequirements: technicalRequirements || {},
      specialRequests,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Populated fields for frontend
      performer: {
        id: performer.userId,
        displayName: performer.displayName,
        avatarUrl: performer.avatar,
      },
      requester: {
        id: user.id,
        displayName: venueProfile?.venueName || user.email,
        avatarUrl: venueProfile?.logoUrl,
      },
    };

    // Сохранить в KV
    await upsertBooking(bookingId, booking);

    // Email notification to admin
    notifyBookingRequest({
      venueName: booking.venueName || 'Unknown',
      eventTitle: booking.eventTitle || 'Booking',
      eventDate: booking.eventDate || '',
      offeredPrice: booking.offeredPrice,
    }).catch(() => {});

    // Обновить индексы для обоих пользователей
    await addBookingToUserIndex(user.id, bookingId);
    await addBookingToUserIndex(performerId, bookingId);

    // Уведомление артисту
    await sendNotification({
      userId: performerId,
      type: 'booking_request_new',
      title: 'Новая заявка на букинг',
      message: `Заведение ${venueProfile?.venueName || 'неизвестное'} хочет забронировать вас на ${eventDate}`,
      data: { bookingId },
    });

    console.log('Booking created via KV:', bookingId);
    return c.json({ 
      success: true,
      booking,
      message: 'Booking request created successfully'
    });

  } catch (error: any) {
    console.error('Error creating booking:', error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// =====================================================
// GET /list - Получить список букингов
// =====================================================
app.get('/list', requireAuth, async (c) => {
  try {
    const user = { id: c.get('userId'), email: c.get('userEmail'), role: c.get('userRole') };

    const role = c.req.query('role');
    const statusFilter = c.req.query('status');

    // Получить букинги пользователя (getBookingsByUser returns full objects)
    const allBookings = await getBookingsByUser(user.id);

    if (!allBookings || allBookings.length === 0) {
      return c.json({ success: true, bookings: [] });
    }

    let bookings = allBookings.filter((v: any) => v !== null);
    
    // Фильтр по роли
    if (role === 'requester') {
      bookings = bookings.filter(b => b.requesterId === user.id);
    } else if (role === 'performer') {
      bookings = bookings.filter(b => b.performerId === user.id);
    }

    // Фильтр по статусу
    if (statusFilter) {
      bookings = bookings.filter(b => b.status === statusFilter);
    }

    // Сортировка по дате создания (newest first)
    bookings.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({ success: true, bookings });

  } catch (error: any) {
    console.error('Error fetching bookings:', error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// =====================================================
// GET /:id - Получить детали букинга
// =====================================================
app.get('/:id', requireAuth, async (c) => {
  try {
    const user = { id: c.get('userId'), email: c.get('userEmail'), role: c.get('userRole') };

    const bookingId = c.req.param('id');
    const bookingData = await getBooking(bookingId);

    if (!bookingData) {
      return apiError(c, 'NOT_FOUND', 'Букинг не найден');
    }

    const booking = bookingData;

    // Проверка доступа
    if (booking.requesterId !== user.id && booking.performerId !== user.id) {
      return apiError(c, 'AUTH_ACCESS_DENIED');
    }

    return c.json({ success: true, booking });

  } catch (error: any) {
    console.error('Error fetching booking:', error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// =====================================================
// PUT /:id/accept - Принять заявку (Artist)
// =====================================================
app.put('/:id/accept', requireAuth, async (c) => {
  try {
    const user = { id: c.get('userId'), email: c.get('userEmail'), role: c.get('userRole') };

    const bookingId = c.req.param('id');
    const bookingData = await getBooking(bookingId);

    if (!bookingData) {
      return apiError(c, 'NOT_FOUND', 'Букинг не найден');
    }

    const booking = bookingData;

    if (booking.performerId !== user.id) {
      return apiError(c, 'NOT_FOUND', 'Букинг не найден');
    }

    if (booking.status !== 'pending') {
      return apiError(c, 'ALREADY_PROCESSED');
    }

    // Обновить статус
    booking.status = 'accepted';
    booking.acceptedAt = new Date().toISOString();
    booking.updatedAt = new Date().toISOString();

    await upsertBooking(bookingId, booking);

    // Уведомление venue
    await sendNotification({
      userId: booking.requesterId,
      type: 'booking_accepted',
      title: 'Заявка принята!',
      message: `Артист принял вашу заявку на ${booking.eventTitle}. Оплатите депозит ${booking.depositAmount} руб.`,
      data: { bookingId },
    });

    console.log('Booking accepted via KV:', bookingId);
    return c.json({ success: true, booking, message: 'Booking accepted successfully' });

  } catch (error: any) {
    console.error('Error accepting booking:', error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// =====================================================
// PUT /:id/reject - О��клонить заявку (Artist)
// =====================================================
app.put('/:id/reject', requireAuth, async (c) => {
  try {
    const user = { id: c.get('userId'), email: c.get('userEmail'), role: c.get('userRole') };

    const bookingId = c.req.param('id');
    const { rejectionReason } = await c.req.json();

    const bookingData = await getBooking(bookingId);
    if (!bookingData) {
      return apiError(c, 'NOT_FOUND', 'Букинг не найден');
    }

    const booking = bookingData;

    if (booking.performerId !== user.id) {
      return apiError(c, 'NOT_FOUND', 'Букинг не найден');
    }

    if (booking.status !== 'pending') {
      return apiError(c, 'ALREADY_PROCESSED');
    }

    booking.status = 'rejected';
    booking.rejectedAt = new Date().toISOString();
    booking.cancellationReason = rejectionReason || 'No reason provided';
    booking.cancelledBy = user.id;
    booking.updatedAt = new Date().toISOString();

    await upsertBooking(bookingId, booking);

    await sendNotification({
      userId: booking.requesterId,
      type: 'booking_rejected',
      title: 'Заявка отклонена',
      message: `Артист отклонил вашу заявку на ${booking.eventTitle}`,
      data: { bookingId, reason: rejectionReason },
    });

    console.log('Booking rejected via KV:', bookingId);
    return c.json({ success: true, booking, message: 'Booking rejected' });

  } catch (error: any) {
    console.error('Error rejecting booking:', error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// =====================================================
// POST /:id/pay-deposit - Оплатить депозит (Venue)
// =====================================================
// DEPRECATED: Оплата депозита теперь через checkout (YooKassa redirect)
// Frontend: BookingPaymentModal -> redirectToPayment -> webhook -> processPaymentSuccess
app.post('/:id/pay-deposit', requireAuth, async (c) => {
  return c.json({ success: false, error: 'Оплата депозита через /api/checkout/create-session' }, 400);
});

// =====================================================
// DEPRECATED: Финальная оплата теперь через checkout (YooKassa redirect)
// Frontend: BookingPaymentModal -> redirectToPayment -> webhook -> processPaymentSuccess
app.post('/:id/pay-final', requireAuth, async (c) => {
  return c.json({ success: false, error: 'Оплата через /api/checkout/create-session' }, 400);
});

// =====================================================
// PUT /:id/cancel - Отменить букинг
// =====================================================
app.put('/:id/cancel', requireAuth, async (c) => {
  try {
    const user = { id: c.get('userId'), email: c.get('userEmail'), role: c.get('userRole') };

    const bookingId = c.req.param('id');
    const { cancellationReason } = await c.req.json();

    const bookingData = await getBooking(bookingId);
    if (!bookingData) {
      return apiError(c, 'NOT_FOUND', 'Букинг не найден');
    }

    const booking = bookingData;

    const isAdmin = user.role === 'admin' || user.role === 'superadmin';
    const isParty = booking.requesterId === user.id || booking.performerId === user.id;
    if (!isParty && !isAdmin) {
      return apiError(c, 'AUTH_ACCESS_DENIED');
    }

    if (booking.status === 'cancelled' || booking.status === 'completed') {
      return apiError(c, 'CANNOT_CANCEL');
    }

    // Once money has moved (deposit paid or full payment confirmed), the
    // party who didn't pay can't unilaterally torch the booking — that
    // strands the other party's funds with no automated refund. Admin
    // override is the only escape (support manually issues the refund).
    if (!isAdmin && (booking.status === 'deposit_paid' || booking.status === 'confirmed')) {
      return apiError(c, 'CANCEL_REQUIRES_ADMIN');
    }

    booking.status = 'cancelled';
    booking.cancelledAt = new Date().toISOString();
    booking.cancelledBy = user.id;
    booking.cancelledByRole = user.role;
    booking.cancellationReason = cancellationReason || 'No reason provided';
    booking.updatedAt = new Date().toISOString();

    await upsertBooking(bookingId, booking);

    // Разблокировать дату
    await bookingCalendarStore.del(booking.performerId);

    // Уведомление другой стороне
    const otherUserId = booking.requesterId === user.id ? booking.performerId : booking.requesterId;
    await sendNotification({
      userId: otherUserId,
      type: 'booking_cancelled',
      title: 'Букинг отменен',
      message: `Букинг "${booking.eventTitle}" был отменен`,
      data: { bookingId, reason: cancellationReason },
    });

    console.log('Booking cancelled via KV:', bookingId);
    return c.json({ success: true, booking, message: 'Booking cancelled successfully' });

  } catch (error: any) {
    console.error('Error cancelling booking:', error);
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// =====================================================
// POST /:id/admin/refund-and-cancel
// =====================================================
// Admin-only escape hatch for the "deposit_paid / confirmed" cancel
// case: issues YooKassa refunds against every paid payment for this
// booking, then flips status to 'cancelled'. Idempotence is enforced
// by the gateway — calling twice with the same key won't double-refund.
app.post(
  '/:id/admin/refund-and-cancel',
  requireAuth,
  requireRole('admin', 'superadmin'),
  async (c) => {
    try {
      const user = { id: c.get('userId'), role: c.get('userRole') };
      const bookingId = c.req.param('id');
      const body = await c.req.json().catch(() => ({}));
      const reason: string = String((body as any).reason || 'Отменено администратором с возвратом');

      const booking = await getBooking(bookingId);
      if (!booking) return apiError(c, 'NOT_FOUND', 'Букинг не найден');
      if (booking.status === 'cancelled' || booking.status === 'completed') {
        return apiError(c, 'CANNOT_CANCEL');
      }

      // Find every paid leg of this booking. booking_payments stores one
      // row per deposit/final attempt with status=paid for completed ones
      // and data.gateway / data.orderId for matching the payment session.
      const { pool } = await import('./db-client.tsx');
      // Self-heal in case checkout never created the table on a fresh
      // deploy.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS booking_payments (
          id SERIAL PRIMARY KEY,
          booking_id TEXT NOT NULL,
          amount NUMERIC NOT NULL,
          payment_type TEXT NOT NULL,
          status TEXT NOT NULL,
          data JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_booking_payments_booking_id ON booking_payments(booking_id);
      `).catch(() => {});
      const { rows: payments } = await pool.query(
        `SELECT id, amount, payment_type, status, data, created_at
           FROM booking_payments
          WHERE booking_id = $1 AND status = 'paid'
          ORDER BY created_at ASC`,
        [bookingId]
      );

      const refundResults: Array<{ paymentType: string; amount: number; refundId: string; status: string }> = [];
      const refundErrors: string[] = [];

      for (const pmt of payments) {
        try {
          const pmtData = (typeof pmt.data === 'string' ? JSON.parse(pmt.data) : (pmt.data || {})) as any;
          const orderId = pmtData.orderId;
          if (!orderId) {
            refundErrors.push(`${pmt.payment_type}: нет orderId — refund невозможен`);
            continue;
          }
          const session = await getPaymentSession(orderId) as any;
          if (!session?.gatewayPaymentId) {
            refundErrors.push(`${pmt.payment_type}: payment session не найден`);
            continue;
          }
          if (session.gateway !== 'yookassa') {
            // Stripe/T-Bank refund flow is separate — not wired here yet.
            refundErrors.push(`${pmt.payment_type}: gateway ${session.gateway} не поддерживается auto-refund'ом`);
            continue;
          }
          const { YooKassaGateway } = await import('./gateway-yookassa.tsx');
          const yk = new YooKassaGateway();
          const result = await yk.refund(session.gatewayPaymentId, Number(pmt.amount), {
            description: `Возврат по букингу #${bookingId}: ${reason.slice(0, 100)}`,
            idempotenceKey: `refund-booking-${bookingId}-${pmt.id}`,
            metadata: { bookingId, paymentType: pmt.payment_type, refundedBy: user.id },
          });
          refundResults.push({
            paymentType: pmt.payment_type,
            amount: result.amount,
            refundId: result.id,
            status: result.status,
          });
          // Mark the payment as refunded
          await pool.query(
            `UPDATE booking_payments SET status = 'refunded',
               data = jsonb_set(COALESCE(data, '{}'::jsonb), '{refundId}', to_jsonb($2::text))
             WHERE id = $1`,
            [pmt.id, result.id]
          );
        } catch (refundErr: any) {
          refundErrors.push(`${pmt.payment_type}: ${refundErr?.message || refundErr}`);
        }
      }

      // Flip booking status only if at least one refund actually succeeded
      // or there was nothing to refund — never strand "cancelled but money
      // still on the venue's side" without a clear audit row.
      if (payments.length > 0 && refundResults.length === 0) {
        return c.json({
          success: false,
          error: 'Ни один платёж не удалось возвратить',
          details: refundErrors,
        }, 502);
      }

      booking.status = 'cancelled';
      booking.cancelledAt = new Date().toISOString();
      booking.cancelledBy = user.id;
      booking.cancelledByRole = user.role;
      booking.cancellationReason = reason;
      (booking as any).refunds = refundResults;
      booking.updatedAt = new Date().toISOString();
      await upsertBooking(bookingId, booking);

      // Free the date in the performer's calendar
      try { await bookingCalendarStore.del(booking.performerId); } catch {}

      // Notify both parties
      const partyMessage = `Букинг "${booking.eventTitle}" отменён администратором` +
        (refundResults.length > 0
          ? `. Возвращено: ${refundResults.reduce((s, r) => s + r.amount, 0)} ₽.`
          : '.');
      try {
        await Promise.all([
          sendNotification({
            userId: booking.requesterId,
            type: 'booking_cancelled',
            title: 'Букинг отменён администратором',
            message: partyMessage,
            data: { bookingId, refunds: refundResults },
          }),
          sendNotification({
            userId: booking.performerId,
            type: 'booking_cancelled',
            title: 'Букинг отменён администратором',
            message: partyMessage,
            data: { bookingId, refunds: refundResults },
          }),
        ]);
      } catch (notifyErr) {
        console.warn('[admin refund-and-cancel] notify failed:', notifyErr);
      }

      return c.json({
        success: true,
        booking,
        refunds: refundResults,
        warnings: refundErrors,
      });
    } catch (error: any) {
      console.error('[admin refund-and-cancel] failed:', error);
      return apiError(c, 'INTERNAL_ERROR');
    }
  }
);

export default app;