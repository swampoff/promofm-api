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
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const log = createLogger('booking-public');
const app = new Hono();

/** Категории исполнителей. Новый тип — строка здесь, а не новая роль. */
const CATEGORIES = ['artist', 'dj', 'cover_band', 'host'] as const;

/**
 * Защита публичной формы. Лимит по IP и дедупликация одинаковых заявок:
 * без них форма без авторизации превращается в поток мусора в очереди
 * владельца и в его Telegram. Память процесса, а не БД: при рестарте
 * счётчик обнуляется — для антиспама этого достаточно, а лишней записи
 * в базу не создаёт.
 */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_IP = 5;
const recentByIp = new Map<string, number[]>();
const recentFingerprints = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, stamps] of recentByIp) {
    const live = stamps.filter((t) => t > cutoff);
    if (live.length) recentByIp.set(ip, live);
    else recentByIp.delete(ip);
  }
  for (const [key, t] of recentFingerprints) {
    if (t < cutoff) recentFingerprints.delete(key);
  }
}, RATE_WINDOW_MS).unref?.();

function tooManyRequests(ip: string): boolean {
  const now = Date.now();
  const stamps = (recentByIp.get(ip) || []).filter((t) => t > now - RATE_WINDOW_MS);
  stamps.push(now);
  recentByIp.set(ip, stamps);
  return stamps.length > RATE_MAX_PER_IP;
}

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
              ap.slug,
              (u.email IS NOT NULL
               AND u.email NOT ILIKE '%@promofm.ru'
               AND u.email NOT ILIKE '%@promo-music.ru')
              OR u.last_login_at IS NOT NULL                                    AS contactable
         FROM booking_profiles bp
         LEFT JOIN artist_profiles ap ON ap.user_id = bp.user_id
         LEFT JOIN dj_profiles dp     ON dp.user_id = bp.user_id
         LEFT JOIN users u            ON u.id::text = bp.user_id
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
          // false = аккаунт из импорта, связи с артистом у нас нет.
          // Карточка предлагает «уточнить возможность», а не заявку.
          contactable: !!r.contactable,
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
              ap.slug, ap.bio,
              (u.email IS NOT NULL
               AND u.email NOT ILIKE '%@promofm.ru'
               AND u.email NOT ILIKE '%@promo-music.ru')
              OR u.last_login_at IS NOT NULL                                    AS contactable
         FROM booking_profiles bp
         LEFT JOIN artist_profiles ap ON ap.user_id = bp.user_id
         LEFT JOIN dj_profiles dp     ON dp.user_id = bp.user_id
         LEFT JOIN users u            ON u.id::text = bp.user_id
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
        contactable: !!r.contactable,
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

    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip') || 'unknown';
    if (tooManyRequests(ip)) {
      log.warn({ ip }, 'booking_request_rate_limited');
      return c.json({
        success: false,
        error: 'Слишком много заявок подряд. Попробуйте через несколько минут.',
        code: 'RATE_LIMITED',
      }, 429);
    }

    const performerId = String(body.performerId || '').trim();
    const clientName = String(body.clientName || '').trim().slice(0, 200);
    const clientEmail = String(body.clientEmail || tokenEmail || '').trim().slice(0, 200);
    const clientPhone = String(body.clientPhone || '').trim().slice(0, 50);
    const eventType = String(body.eventType || 'event').trim().slice(0, 50);
    const eventTitle = String(body.eventTitle || '').trim().slice(0, 300);
    const eventDate = body.eventDate || null;
    const city = String(body.city || '').trim().slice(0, 120);
    const message = String(body.message || '').trim().slice(0, 2000);
    // Сумму предлагает заказчик (заведение в кабинете). Отрицательные и
    // абсурдные значения отсекаем здесь: цифра уедет исполнителю как
    // предложение, и мусор в ней недопустим.
    const rawFee = Number(body.offeredFee);
    const offeredFee = Number.isFinite(rawFee) && rawFee > 0 && rawFee < 100_000_000
      ? Math.round(rawFee)
      : null;

    // Без исполнителя это заявка на подбор (кнопка «Оставить заявку» в шапке
    // каталога и на пустых страницах кавер-групп и ведущих). Раньше API
    // отвечал 400 «Не указан исполнитель», и эти лиды терялись (15.10.2026).
    const PICK_LABELS: Record<string, string> = { artist: 'артист', dj: 'диджей', cover_band: 'кавер-группа', host: 'ведущий' };
    const wanted = PICK_LABELS[String(body.category || '').trim()] ? String(body.category).trim() : '';
    const pickLabel = PICK_LABELS[wanted] || 'любой исполнитель';
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
    // 152-ФЗ: форма публичная и собирает персональные данные физлица.
    // Согласие фиксируем меткой времени, а не «мелким шрифтом под кнопкой».
    if (body.consent !== true) {
      return c.json({
        success: false,
        error: 'Нужно согласие на обработку персональных данных',
        code: 'CONSENT_REQUIRED',
      }, 400);
    }

    // Дедупликация: та же почта + тот же исполнитель + та же дата в
    // пределах окна — это двойной клик или бот, а не второй заказ.
    const fingerprint = `${clientEmail}|${performerId}|${eventDate}`;
    if (recentFingerprints.has(fingerprint)) {
      return c.json({ success: true, data: { duplicate: true } });
    }
    recentFingerprints.set(fingerprint, Date.now());

    // Исполнитель должен быть реально открыт для букинга. Проверяем здесь,
    // а не полагаемся на то, что фронт показал только открытых.
    const perf: { rows: any[] } = !performerId
      ? { rows: [{ user_id: null, performer_category: wanted || null, name: `Подбор: ${pickLabel}`, contactable: false, pick: true }] }
      : await pool.query(
      `SELECT bp.user_id, bp.performer_category,
              COALESCE(NULLIF(bp.display_name, ''), ap.artist_name, dp.dj_name, 'Исполнитель') AS name,
              (u.email IS NOT NULL
               AND u.email NOT ILIKE '%@promofm.ru'
               AND u.email NOT ILIKE '%@promo-music.ru')
              OR u.last_login_at IS NOT NULL AS contactable
         FROM booking_profiles bp
         LEFT JOIN artist_profiles ap ON ap.user_id = bp.user_id
         LEFT JOIN dj_profiles dp     ON dp.user_id = bp.user_id
         LEFT JOIN users u            ON u.id::text = bp.user_id
        WHERE bp.user_id = $1 AND bp.is_open = true AND bp.moderation_status = 'approved'
        LIMIT 1`,
      [performerId],
    );
    if (perf.rows.length === 0) {
      return c.json({ success: false, error: 'Исполнитель не принимает заявки', code: 'BOOKING_DISABLED' }, 400);
    }
    const performer = perf.rows[0];

    const bookingId = `bk-${crypto.randomUUID()}`;
    const baseTitle = eventTitle || `${eventType} — ${city || 'город не указан'}`;
    // С артистом из импорта связи нет — это запрос на подбор, а не бронь.
    // Пишем это прямо в заголовке, чтобы в очереди было видно без
    // дополнительных проверок.
    const title = performer.pick
      ? `Подбор исполнителя (${pickLabel}): ${baseTitle}`
      : performer.contactable ? baseTitle : `Уточнить возможность: ${baseTitle}`;

    await pool.query(
      `INSERT INTO bookings (
         id, user_id, performer_id, performer_type, requester_type,
         event_type, event_title, event_description, event_date,
         venue_city, status, client_name, client_email, client_phone,
         source, consent_at, client_ip, admin_status, total_price, performer_fee,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,
                 'booking_page', now(), $14, 'new', $15, $15, now(), now())`,
      [
        bookingId,
        userId,
        performerId || null,
        performer.pick ? (wanted || 'any') : performer.performer_category === 'dj' ? 'dj' : 'artist',
        userId ? 'user' : 'guest',
        eventType,
        title,
        message,
        eventDate,
        city,
        clientName || null,
        clientEmail || null,
        clientPhone || null,
        ip,
        // Комиссии здесь нет: платформа деньги по этому потоку не
        // проводит, поэтому предложенная сумма и есть гонорар.
        offeredFee,
      ],
    );

    // Владельцу — письмо и дубль в Telegram: в лидовой модели скорость
    // ответа и есть продукт.
    notifyBookingRequest({
      venueName: clientName || 'Заявка с сайта',
      performerName: performer.name,
      eventTitle: title,
      eventDate: String(eventDate),
      offeredPrice: offeredFee || undefined,
      clientEmail: clientEmail || undefined,
      clientPhone: clientPhone || undefined,
      city: city || undefined,
      message: message || undefined,
    }).catch((err: any) => log.warn({ err }, 'booking_notify_failed'));

    // Исполнителю — уведомление в кабинет (у заявки на подбор исполнителя нет).
    if (!performer.pick) try {
      // Импортированному аккаунту уведомление слать некуда: в кабинет
      // никто не заходит, почты не существует. Заявку разбирает площадка.
      if (!performer.contactable) throw new Error('performer_not_contactable');
      const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
      await notifyCrossCabinet({
        targetUserId: performerId,
        targetRole: performer.performer_category === 'dj' ? 'dj' : 'artist',
        sourceRole: 'system',
        type: 'booking_request',
        title: 'Новая заявка на выступление',
        message: offeredFee
          ? `${title} — ${eventDate} · предложено ${offeredFee.toLocaleString('ru-RU')} \u20bd`
          : `${title} — ${eventDate}`,
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

// ─────────────────────────────────────────────────────────────
// АДМИНКА: очередь заявок
// ─────────────────────────────────────────────────────────────

/** Воронка владельца. Не путать со status — тот принадлежит исполнителю. */
const ADMIN_STATUSES = ['new', 'contacted', 'qualified', 'deal', 'lost', 'spam'];

app.get('/admin/requests', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('adminStatus') || '';
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '100', 10) || 100));

    const where: string[] = ["b.source = 'booking_page'"];
    const params: any[] = [];
    if (status && ADMIN_STATUSES.includes(status)) {
      params.push(status);
      where.push(`b.admin_status = $${params.length}`);
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT b.id, b.client_name, b.client_email, b.client_phone,
              b.event_type, b.event_title, b.event_description, b.event_date,
              b.venue_city, b.status, b.admin_status, b.admin_note,
              b.consent_at, b.created_at, b.performer_id,
              COALESCE(NULLIF(bp.display_name, ''), ap.artist_name, dp.dj_name) AS performer_name,
              bp.performer_category
         FROM bookings b
         LEFT JOIN booking_profiles bp ON bp.user_id = b.performer_id
         LEFT JOIN artist_profiles ap  ON ap.user_id = b.performer_id
         LEFT JOIN dj_profiles dp      ON dp.user_id = b.performer_id
        WHERE ${where.join(' AND ')}
        ORDER BY b.created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    const counts = await pool.query(
      `SELECT admin_status, COUNT(*)::int AS cnt
         FROM bookings WHERE source = 'booking_page'
        GROUP BY admin_status`,
    );

    return c.json({
      success: true,
      data: {
        requests: rows.map((r: any) => ({
          id: r.id,
          clientName: r.client_name,
          clientEmail: r.client_email,
          clientPhone: r.client_phone,
          eventType: r.event_type,
          eventTitle: r.event_title,
          eventDescription: r.event_description,
          eventDate: r.event_date,
          city: r.venue_city,
          status: r.status,
          adminStatus: r.admin_status,
          adminNote: r.admin_note,
          hasConsent: !!r.consent_at,
          createdAt: r.created_at,
          performerId: r.performer_id,
          performerName: r.performer_name,
          performerCategory: r.performer_category,
        })),
        counts: Object.fromEntries(counts.rows.map((r: any) => [r.admin_status, r.cnt])),
      },
    });
  } catch (error) {
    log.error({ err: error }, 'admin_requests_failed');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

app.put('/admin/requests/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    const adminStatus = ADMIN_STATUSES.includes(body.adminStatus) ? body.adminStatus : null;
    if (!adminStatus && body.adminNote === undefined) {
      return c.json({ success: false, error: 'Нечего обновлять' }, 400);
    }

    const { rows } = await pool.query(
      `UPDATE bookings
          SET admin_status = COALESCE($2, admin_status),
              admin_note   = COALESCE($3, admin_note),
              updated_at   = now()
        WHERE id = $1 AND source = 'booking_page'
        RETURNING id, admin_status, admin_note`,
      [id, adminStatus, body.adminNote === undefined ? null : String(body.adminNote).slice(0, 4000)],
    );
    if (rows.length === 0) {
      return c.json({ success: false, error: 'Заявка не найдена' }, 404);
    }

    log.info({ id, adminStatus }, 'booking_lead_updated');
    return c.json({ success: true, data: rows[0] });
  } catch (error) {
    log.error({ err: error }, 'admin_request_update_failed');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

export default app;
