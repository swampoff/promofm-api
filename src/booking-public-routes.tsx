/**
 * БУКИНГ — публичная часть: каталог исполнителей и заявка от заказчика.
 *
 * Модель лидовая (владелец 20.09.2026): платформа не проводит деньги по
 * этому потоку, заявка — это лид, дальше связываются вручную. Поэтому
 * здесь нет ни расчёта цены, ни депозита, ни чекаута — только сбор
 * контактов и параметров мероприятия.
 *
 * Заказчиком может быть кто угодно: частное лицо, организатор фестиваля,
 * заведение. Регистрация не требуется — auth опциональный, по образцу
 * работающего гостевого пути dj-marketplace-routes.tsx:306.
 *
 * ⚠️ Гонорар наружу не отдаётся никогда. booking_profiles.fee_hint —
 * служебный ориентир для переговоров, в карточке «по запросу». Ни один
 * SELECT в этом файле его не выбирает.
 */

import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { pool } from './db-client.tsx';
import { notifyBookingRequest } from './email-helper.tsx';
import { createLogger } from './logger.tsx';

const log = createLogger('booking-public');
const app = new Hono();

/** Категории исполнителей. Новый тип — строка здесь, а не новая роль. */
const CATEGORIES = ['artist', 'dj', 'cover_band', 'host'] as const;

/**
 * Опциональная авторизация: есть валидный JWT — заявка привязывается к
 * аккаунту, нет — заказчик считается гостем и обязан оставить контакты.
 * Битый или просроченный токен не ошибка: продолжаем как гость.
 */
function optionalAuth(c: any): { userId: string | null; email: string | null } {
  const header = c.req.header('Authorization');
  if (!header) return { userId: null, email: null };
  try {
    const decoded = jwt.verify(
      header.replace('Bearer ', ''),
      process.env.JWT_SECRET!,
      { algorithms: ['HS256'] },
    ) as any;
    return { userId: decoded.sub || null, email: decoded.email || null };
  } catch {
    return { userId: null, email: null };
  }
}

// ─────────────────────────────────────────────────────────────
// GET /performers — каталог открытых для букинга
// ─────────────────────────────────────────────────────────────
app.get('/performers', async (c) => {
  try {
    const category = c.req.query('category') || '';
    const city = c.req.query('city') || '';
    const search = (c.req.query('search') || '').trim();
    const limit = Math.min(60, Math.max(1, parseInt(c.req.query('limit') || '24', 10) || 24));
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

    const where: string[] = ['bp.is_open = true', "bp.moderation_status = 'approved'"];
    const params: any[] = [];

    if (category && (CATEGORIES as readonly string[]).includes(category)) {
      params.push(category);
      where.push(`bp.performer_category = $${params.length}`);
    }
    if (city) {
      params.push(city);
      where.push(`$${params.length} = ANY(bp.cities)`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(COALESCE(bp.display_name, ap.artist_name, dp.dj_name, '') ILIKE $${params.length})`);
    }

    const whereSql = where.join(' AND ');

    const totalRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt
         FROM booking_profiles bp
         LEFT JOIN artist_profiles ap ON ap.user_id = bp.user_id
         LEFT JOIN dj_profiles dp     ON dp.user_id = bp.user_id
        WHERE ${whereSql}`,
      params,
    );

    params.push(limit, offset);
    const rows = await pool.query(
      `SELECT bp.user_id, bp.performer_category, bp.cities, bp.formats, bp.about,
              COALESCE(NULLIF(bp.display_name, ''), ap.artist_name, dp.dj_name, 'Исполнитель') AS name,
              COALESCE(ap.avatar_url, dp.data->>'avatarUrl')                                    AS avatar_url,
              COALESCE(ap.genre, dp.data->>'genre')                                             AS genre,
              COALESCE(ap.is_verified, false)                                                   AS is_verified,
              ap.slug
         FROM booking_profiles bp
         LEFT JOIN artist_profiles ap ON ap.user_id = bp.user_id
         LEFT JOIN dj_profiles dp     ON dp.user_id = bp.user_id
        WHERE ${whereSql}
        ORDER BY COALESCE(ap.is_verified, false) DESC, bp.updated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return c.json({
      success: true,
      data: {
        total: totalRes.rows[0]?.cnt ?? 0,
        limit,
        offset,
        performers: rows.rows.map((r: any) => ({
          id: r.user_id,
          name: r.name,
          category: r.performer_category,
          avatarUrl: r.avatar_url,
          genre: r.genre,
          isVerified: !!r.is_verified,
          cities: r.cities || [],
          formats: r.formats || [],
          about: r.about,
          slug: r.slug,
          // Цены нет и не будет: владелец — «всегда по запросу».
        })),
      },
    });
  } catch (error: any) {
    log.error({ err: error }, 'performers_list_failed');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /performers/:id — карточка
// ─────────────────────────────────────────────────────────────
app.get('/performers/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { rows } = await pool.query(
      `SELECT bp.user_id, bp.performer_category, bp.cities, bp.formats, bp.about,
              bp.min_duration_hours, bp.rider,
              COALESCE(NULLIF(bp.display_name, ''), ap.artist_name, dp.dj_name, 'Исполнитель') AS name,
              COALESCE(ap.avatar_url, dp.data->>'avatarUrl')                                    AS avatar_url,
              COALESCE(ap.cover_url, '')                                                        AS cover_url,
              COALESCE(ap.genre, dp.data->>'genre')                                             AS genre,
              COALESCE(ap.is_verified, false)                                                   AS is_verified,
              ap.slug, ap.bio
         FROM booking_profiles bp
         LEFT JOIN artist_profiles ap ON ap.user_id = bp.user_id
         LEFT JOIN dj_profiles dp     ON dp.user_id = bp.user_id
        WHERE bp.user_id = $1 AND bp.is_open = true AND bp.moderation_status = 'approved'
        LIMIT 1`,
      [id],
    );
    if (rows.length === 0) {
      return c.json({ success: false, error: 'Исполнитель не найден' }, 404);
    }
    const r = rows[0];
    return c.json({
      success: true,
      data: {
        id: r.user_id,
        name: r.name,
        category: r.performer_category,
        avatarUrl: r.avatar_url,
        coverUrl: r.cover_url,
        genre: r.genre,
        isVerified: !!r.is_verified,
        cities: r.cities || [],
        formats: r.formats || [],
        about: r.about || r.bio,
        minDurationHours: r.min_duration_hours,
        // Райдер показываем: заказчику полезно знать требования заранее.
        rider: r.rider || {},
        slug: r.slug,
      },
    });
  } catch (error: any) {
    log.error({ err: error }, 'performer_get_failed');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /request — заявка на букинг
// ─────────────────────────────────────────────────────────────
app.post('/request', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { userId, email: tokenEmail } = optionalAuth(c);

    const performerId = String(body.performerId || '').trim();
    const clientName = String(body.clientName || '').trim().slice(0, 200);
    const clientEmail = String(body.clientEmail || tokenEmail || '').trim().slice(0, 200);
    const clientPhone = String(body.clientPhone || '').trim().slice(0, 50);
    const eventType = String(body.eventType || 'event').trim().slice(0, 50);
    const eventTitle = String(body.eventTitle || '').trim().slice(0, 300);
    const eventDate = body.eventDate || null;
    const city = String(body.city || '').trim().slice(0, 120);
    const message = String(body.message || '').trim().slice(0, 2000);

    if (!performerId) {
      return c.json({ success: false, error: 'Не указан исполнитель', code: 'PERFORMER_REQUIRED' }, 400);
    }
    // Гость обязан оставить способ связи — иначе лид бесполезен.
    if (!userId && (!clientName || !clientEmail)) {
      return c.json({ success: false, error: 'Укажите имя и email для связи', code: 'CONTACT_REQUIRED' }, 400);
    }
    if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      return c.json({ success: false, error: 'Email указан некорректно', code: 'EMAIL_INVALID' }, 400);
    }
    if (!eventDate) {
      return c.json({ success: false, error: 'Укажите дату мероприятия', code: 'DATE_REQUIRED' }, 400);
    }

    // Исполнитель должен быть реально открыт для букинга. Проверяем здесь,
    // а не полагаемся на то, что фронт показал только открытых.
    const perf = await pool.query(
      `SELECT bp.user_id, bp.performer_category,
              COALESCE(NULLIF(bp.display_name, ''), ap.artist_name, dp.dj_name, 'Исполнитель') AS name
         FROM booking_profiles bp
         LEFT JOIN artist_profiles ap ON ap.user_id = bp.user_id
         LEFT JOIN dj_profiles dp     ON dp.user_id = bp.user_id
        WHERE bp.user_id = $1 AND bp.is_open = true AND bp.moderation_status = 'approved'
        LIMIT 1`,
      [performerId],
    );
    if (perf.rows.length === 0) {
      return c.json({ success: false, error: 'Исполнитель не принимает заявки', code: 'BOOKING_DISABLED' }, 400);
    }
    const performer = perf.rows[0];

    const bookingId = `bk-${crypto.randomUUID()}`;
    const title = eventTitle || `${eventType} — ${city || 'город не указан'}`;

    await pool.query(
      `INSERT INTO bookings (
         id, user_id, performer_id, performer_type, requester_type,
         event_type, event_title, event_description, event_date,
         venue_city, status, client_name, client_email, source,
         special_requests, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,'booking_page',$13, now(), now())`,
      [
        bookingId,
        userId,
        performerId,
        performer.performer_category === 'dj' ? 'dj' : 'artist',
        userId ? 'user' : 'guest',
        eventType,
        title,
        message,
        eventDate,
        city,
        clientName || null,
        clientEmail || null,
        // Телефон в схеме bookings отдельной колонки не имеет, а терять
        // его нельзя — это основной канал связи по таким заявкам.
        clientPhone ? `Телефон: ${clientPhone}` : null,
      ],
    );

    // Владельцу — письмо и дубль в Telegram: в лидовой модели скорость
    // ответа и есть продукт.
    notifyBookingRequest({
      venueName: clientName || 'Заявка с сайта',
      performerName: performer.name,
      eventTitle: title,
      eventDate: String(eventDate),
      clientEmail: clientEmail || undefined,
      clientPhone: clientPhone || undefined,
      city: city || undefined,
      message: message || undefined,
    }).catch((err: any) => log.warn({ err }, 'booking_notify_failed'));

    // Исполнителю — уведомление в кабинет.
    try {
      const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
      await notifyCrossCabinet({
        targetUserId: performerId,
        targetRole: performer.performer_category === 'dj' ? 'dj' : 'artist',
        sourceRole: 'system',
        type: 'booking_request',
        title: 'Новая заявка на выступление',
        message: `${title} — ${eventDate}`,
        link: performer.performer_category === 'dj' ? '/dj/bookings' : '/artist/booking',
      });
    } catch (err: any) {
      log.warn({ err, performerId }, 'booking_performer_notify_failed');
    }

    log.info({ bookingId, performerId, guest: !userId }, 'booking_request_created');
    return c.json({ success: true, data: { id: bookingId } });
  } catch (error: any) {
    log.error({ err: error }, 'booking_request_failed');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

export default app;
