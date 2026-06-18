/**
 * DJ MARKETPLACE ROUTES
 * Public endpoints for DJ Marketplace catalog
 * Reads directly from dj_profiles PostgreSQL table (no KV seed data)
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { upsertNotification } from './db.tsx';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const app = new Hono();

// ── Helpers ──

function nowIso(): string {
  return new Date().toISOString();
}

function formatExperience(years: number): string {
  if (!years || years <= 0) return '';
  const last = years % 10;
  const tens = years % 100;
  if (tens >= 11 && tens <= 14) return `${years} лет`;
  if (last === 1) return `${years} год`;
  if (last >= 2 && last <= 4) return `${years} года`;
  return `${years} лет`;
}

function mapRow(row: any) {
  const d = row.data || {};
  // Editor stores nested under `profile`. Older rows may have fields on data root.
  const p = d.profile || d;
  const b = d.booking || d;
  return {
    id: row.id,
    name: row.dj_name || p.djName || d.djName || '',
    photo: row.photo_url || row.avatar_url || p.avatarUrl || d.avatarUrl || '',
    coverUrl: p.coverUrl || d.coverUrl || '',
    // Social/streaming links — stored in the jsonb profile. Public page
    // renders only the platforms that are actually set (camelCase keys,
    // same shape as artist/label). Was previously dropped here entirely.
    socials: p.socials || p.socialLinks || d.socials || d.socialLinks || row.social_links || {},
    city: row.location || p.city || d.city || '',
    genres: row.genres || p.genres || d.genres || [],
    rating: parseFloat(row.rating) || 0,
    reviewsCount: parseInt(row.total_reviews) || 0,
    priceFrom: parseInt(row.price_from) || parseInt(row.hourly_rate) || b.ratePerHour || b.ratePerEvent || 0,
    experience: formatExperience(parseInt(row.experience_years) || 0),
    verified: row.is_verified || p.verified || d.verified || false,
    available: row.is_available !== false && (b.openForBookings !== false),
    topGenre: (row.genres && row.genres[0]) || (p.genres && p.genres[0]) || '',
    completedGigs: parseInt(row.completed_gigs) || 0,
    bio: row.bio || p.bio || p.bioShort || d.bio || d.bioShort || '',
    tags: row.tags || p.specializations || d.specializations || [],
    // Портфолио — массив категорий с файлами (audio/video/image).
    // Лежит в data.portfolioCategories (см. dj-studio-routes.tsx
    // POST /portfolio/upload). Чистим неполные записи + только
    // категории с непустым files[] чтобы фронт не рендерил пустые
    // карточки на публичной странице.
    portfolioCategories: Array.isArray(d.portfolioCategories)
      ? d.portfolioCategories
          .map((cat: any) => ({
            id: String(cat?.id || ''),
            label: String(cat?.label || cat?.id || ''),
            files: Array.isArray(cat?.files)
              ? cat.files
                  .filter((f: any) => f && f.url)
                  .map((f: any) => ({
                    id: String(f.id || ''),
                    name: String(f.name || 'Файл'),
                    url: String(f.url),
                    kind: f.kind === 'video' ? 'video' : f.kind === 'image' ? 'image' : 'audio',
                    size: String(f.size || ''),
                    date: String(f.date || ''),
                    duration: f.duration ? String(f.duration) : undefined,
                  }))
              : [],
          }))
          .filter((cat: any) => cat.id && cat.files.length > 0)
      : [],
  };
}

// ═══════ GET /djs — List all DJs (public) ═══════

app.get('/djs', async (c) => {
  try {
    const query = c.req.query();
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // Only show profiles with a name set (real registrations)
    conditions.push(`(dj_name IS NOT NULL AND dj_name != ''
                      OR data->>'djName' IS NOT NULL AND data->>'djName' != '')`);

    if (query.city) {
      conditions.push(`(location = $${paramIdx} OR data->>'city' = $${paramIdx})`);
      params.push(query.city);
      paramIdx++;
    }
    if (query.genre) {
      conditions.push(`$${paramIdx} = ANY(genres)`);
      params.push(query.genre);
      paramIdx++;
    }
    if (query.verified === 'true') {
      conditions.push(`(is_verified = true OR (data->>'verified')::boolean = true)`);
    }
    if (query.available === 'true') {
      conditions.push(`is_available = true`);
    }
    if (query.price_min) {
      conditions.push(`COALESCE(NULLIF(price_from, 0), hourly_rate, (data->>'ratePerHour')::numeric, 0) >= $${paramIdx}`);
      params.push(Number(query.price_min));
      paramIdx++;
    }
    if (query.price_max && query.price_max !== 'Infinity') {
      conditions.push(`COALESCE(NULLIF(price_from, 0), hourly_rate, (data->>'ratePerHour')::numeric, 0) <= $${paramIdx}`);
      params.push(Number(query.price_max));
      paramIdx++;
    }
    if (query.search) {
      const searchParam = `%${query.search.toLowerCase()}%`;
      conditions.push(`(
        LOWER(COALESCE(dj_name, data->>'djName', '')) LIKE $${paramIdx}
        OR LOWER(COALESCE(location, data->>'city', '')) LIKE $${paramIdx}
        OR EXISTS (SELECT 1 FROM unnest(genres) g WHERE LOWER(g) LIKE $${paramIdx})
      )`);
      params.push(searchParam);
      paramIdx++;
    }

    // Sort
    let orderBy = 'rating DESC NULLS LAST';
    switch (query.sort) {
      case 'price_asc': orderBy = 'COALESCE(NULLIF(price_from, 0), hourly_rate, 0) ASC'; break;
      case 'price_desc': orderBy = 'COALESCE(NULLIF(price_from, 0), hourly_rate, 0) DESC'; break;
      case 'popularity': orderBy = 'completed_gigs DESC NULLS LAST'; break;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM dj_profiles ${whereClause} ORDER BY ${orderBy} LIMIT 50`;

    const { rows } = await pool.query(sql, params);
    const result = rows.map(mapRow);

    return c.json({ success: true, data: result, total: result.length });
  } catch (err: any) {
    console.error('Error fetching DJ list:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════ GET /djs/:id — Single DJ profile (public) ═══════

app.get('/djs/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { rows } = await pool.query('SELECT * FROM dj_profiles WHERE id = $1 OR user_id = $1', [id]);
    if (rows.length === 0) {
      return c.json({ success: false, error: 'DJ not found' }, 404);
    }
    return c.json({ success: true, data: mapRow(rows[0]) });
  } catch (err: any) {
    console.error('Error fetching DJ profile:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════ GET /djs/:id/mixes — DJ mixes (public) ═══════

app.get('/djs/:id/mixes', async (c) => {
  try {
    const id = c.req.param('id');
    // dj_mixes.dj_id хранится как user_id, но публичный URL может содержать
    // dj_profiles.id (uuid). Резолвим через подзапрос — принимаем оба варианта.
    // Публичный фид DJ — только одобренные миксы (moderation_status IN
    // ('upcoming','published') + is_hidden=FALSE). Зеркало того что
    // tracks-routes делает для треков артистов после модерации. Старая
    // колонка status='published' оставлена как доп. фильтр для миксов
    // что были опубликованы ДО миграции 030 — они уже backfill'нуты в
    // moderation_status='published', is_hidden=FALSE.
    // Native cols (migration 046): is_premium/price/likes_count напрямую.
    const { rows } = await pool.query(
      `SELECT m.id, m.title, m.genre, m.duration, m.plays_count AS plays,
              m.audio_url, m.cover_url, m.description, m.bpm_range, m.status,
              m.is_premium, m.price, m.likes_count
         FROM dj_mixes m
         WHERE (m.dj_id = $1 OR m.dj_id = (
                SELECT user_id FROM dj_profiles
                 WHERE id::text = $1 OR user_id = $1 LIMIT 1))
           AND m.moderation_status IN ('upcoming', 'published')
           AND m.is_hidden = FALSE
         ORDER BY m.created_at DESC`,
      [id]
    );
    const mixes = rows.map((r: any) => ({
      id: r.id,
      title: r.title || '',
      genre: r.genre || '',
      duration: r.duration ? `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}` : '',
      durationSec: r.duration || 0,
      plays: r.plays || 0,
      likes: r.likes_count || 0,
      audioUrl: r.audio_url || '',
      coverUrl: r.cover_url || '',
      description: r.description || '',
      bpmRange: r.bpm_range || '',
      isPremium: !!r.is_premium,
      price: Number(r.price) || 0,
    }));
    return c.json({ success: true, data: mixes });
  } catch (err: any) {
    console.error('Error fetching DJ mixes:', err);
    return c.json({ success: true, data: [] });
  }
});

// ═══════ GET /djs/:id/reviews — DJ reviews (public) ═══════

app.get('/djs/:id/reviews', async (c) => {
  try {
    const id = c.req.param('id');
    const { rows } = await pool.query(
      `SELECT r.id, r.reviewer_name, r.rating, r.comment, r.created_at, r.data
         FROM dj_reviews r
         WHERE r.dj_id = $1 OR r.dj_id = (
                SELECT user_id FROM dj_profiles
                 WHERE id::text = $1 OR user_id = $1 LIMIT 1)
         ORDER BY r.created_at DESC`,
      [id]
    );
    const reviews = rows.map((r: any) => ({
      id: r.id,
      author: r.reviewer_name || 'Аноним',
      date: new Date(r.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }),
      rating: r.rating || 5,
      text: r.comment || '',
      eventType: r.data?.eventType || '',
    }));
    return c.json({ success: true, data: reviews });
  } catch (err: any) {
    console.error('Error fetching DJ reviews:', err);
    return c.json({ success: true, data: [] });
  }
});

// ═══════ GET /djs/:id/calendar — DJ availability (public) ═══════

app.get('/djs/:id/calendar', async (c) => {
  try {
    const id = c.req.param('id');
    // Check for booked dates from bookings table
    const { rows: bookings } = await pool.query(
      `SELECT event_date FROM bookings
        WHERE (performer_id = $1 OR performer_id = (
               SELECT user_id FROM dj_profiles
                WHERE id::text = $1 OR user_id = $1 LIMIT 1))
          AND status IN ('confirmed', 'deposit_paid', 'completed')
          AND event_date >= CURRENT_DATE`,
      [id]
    ).catch(() => ({ rows: [] }));

    const bookedDates = new Set(bookings.map((b: any) =>
      new Date(b.event_date).toISOString().split('T')[0]
    ));

    // Generate 21-day calendar with real booking data
    const days = [];
    const now = new Date();
    for (let i = 0; i < 21; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      days.push({
        date: dateStr,
        dayOfWeek: d.toLocaleDateString('ru-RU', { weekday: 'short' }),
        dayNum: d.getDate(),
        month: d.toLocaleDateString('ru-RU', { month: 'short' }),
        available: !bookedDates.has(dateStr),
      });
    }
    return c.json({ success: true, data: days });
  } catch (err: any) {
    console.error('Error fetching DJ calendar:', err);
    return c.json({ success: true, data: [] });
  }
});

// ═══════ POST /djs/:id/book — Request booking ═══════
//
// Public-facing endpoint: гость с лендинга или авторизованный пользователь
// могут отправить заявку на букинг DJ. Если пользователь залогинен —
// берём userId из JWT (заполняем requester_id), если гость — пишем
// clientName/clientEmail в data jsonb.
//
// Полный venue→dj booking flow (с прайсингом, комиссией, квотами,
// расписанием) живёт в booking-routes.tsx POST /create. Этот эндпоинт
// — лёгкая заявка «свяжитесь со мной», без денежных расчётов.

app.post('/djs/:id/book', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    // Опциональный auth: если есть валидный JWT — заполняем requesterId.
    // Иначе считаем заявителя гостем и валидируем contact-fields.
    let requesterId: string | null = null;
    let requesterEmail: string | null = null;
    const authHeader = c.req.header('Authorization');
    if (authHeader) {
      try {
        const token = authHeader.replace('Bearer ', '');
        const decoded = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as any;
        requesterId = decoded.sub || null;
        requesterEmail = decoded.email || null;
      } catch {
        // битый/просроченный токен — продолжаем как гость
      }
    }

    // Валидация: должны быть либо userId (auth), либо имя+email (гость)
    const clientName = String(body.clientName || '').trim().slice(0, 200);
    const clientEmail = String(body.clientEmail || requesterEmail || '').trim().slice(0, 200);
    const message = String(body.message || '').trim().slice(0, 2000);
    const eventDate = body.eventDate || null;
    const eventType = String(body.eventType || 'event').trim().slice(0, 50);

    if (!requesterId && (!clientName || !clientEmail)) {
      return c.json({
        success: false,
        error: 'Укажите имя и email для связи',
        code: 'CONTACT_REQUIRED',
      }, 400);
    }
    if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      return c.json({
        success: false,
        error: 'Email указан некорректно',
        code: 'EMAIL_INVALID',
      }, 400);
    }
    if (!eventDate) {
      return c.json({
        success: false,
        error: 'Укажите дату мероприятия',
        code: 'DATE_REQUIRED',
      }, 400);
    }

    // Resolve DJ — принимаем как dj_profiles.id (uuid), так и user_id (text).
    // user_id — text по схеме (см. CLAUDE.md cheat-sheet), поэтому
    // cast id::text для второго условия.
    const { rows } = await pool.query(
      `SELECT id, user_id, dj_name, data
         FROM dj_profiles
        WHERE id::text = $1 OR user_id = $1
        LIMIT 1`,
      [id]
    );
    if (rows.length === 0) {
      return c.json({ success: false, error: 'DJ not found' }, 404);
    }

    const djRow = rows[0];
    const djName = djRow.dj_name || djRow.data?.djName || 'DJ';
    const djUserId = String(djRow.user_id || '');

    // Bookings row-per-booking (migration 047): native cols only,
    // никакого data jsonb. Используем `user_id` (не legacy `requester_id`).
    // `message` фактически eventDescription для marketplace lightweight-flow.
    const bookingId = `bk-${crypto.randomUUID()}`;
    const eventTitle = `Заявка на букинг DJ ${djName}`;

    await pool.query(
      `INSERT INTO bookings
         (id, performer_id, performer_type, user_id,
          requester_type, client_name, client_email,
          event_title, event_type, event_date,
          event_description, status, source, created_at)
       VALUES ($1, $2, 'dj', $3,
               $4, $5, $6,
               $7, $8, $9,
               $10, 'pending', 'marketplace', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        bookingId,
        djUserId || id,
        requesterId || clientEmail || 'anonymous',
        requesterId ? 'authenticated' : 'guest',
        clientName || null,
        clientEmail || null,
        eventTitle,
        eventType,
        eventDate,
        message,
      ]
    );

    // Cross-cabinet notification — DJ видит баннер в кабинете /dj/bookings
    // + админ-bell получает SSE. Не fail'имся, если упало — заявка важнее.
    if (djUserId) {
      notifyCrossCabinet({
        targetUserId: djUserId,
        targetRole: 'dj',
        sourceRole: requesterId ? 'venue' : 'admin', // гость идёт как admin-сорс чтобы DJ не путался
        type: 'booking_update',
        title: 'Новая заявка на букинг',
        message: `${clientName || 'Гость'} интересуется датой ${eventDate} (${eventType})`,
        link: '/dj/bookings',
      }).catch((err: any) => console.warn('[dj/book] notifyCrossCabinet failed:', err?.message));

      // Persistent inbox для DJ-bell. Без этой записи cross-cabinet
      // покажет SSE-баннер, но в /dj/bookings → «Колокольчик» заявка не
      // отобразится (bell читает notifications, не cross_cabinet_*).
      const notifId = `bn-${crypto.randomUUID()}`;
      upsertNotification(djUserId, notifId, {
        id: notifId,
        type: 'booking_request_new',
        title: 'Новая заявка на букинг',
        message: `${clientName || 'Гость'} интересуется датой ${eventDate} (${eventType})${message ? '. ' + message.slice(0, 120) : ''}`,
        bookingId,
        djName,
        clientName,
        clientEmail,
        eventDate,
        eventType,
        link: '/dj/bookings',
        read: false,
        createdAt: new Date().toISOString(),
      }).catch((err: any) => console.warn('[dj/book] inbox notif failed:', err?.message));
    }

    console.log(`[dj-marketplace] Booking ${bookingId} for DJ ${djName} (${djUserId || id}) from ${clientEmail || requesterId}`);

    return c.json({
      success: true,
      data: {
        id: bookingId,
        djId: id,
        djName,
        clientName,
        clientEmail,
        eventDate,
        eventType,
        message,
        status: 'pending',
        createdAt: nowIso(),
      },
    });
  } catch (err: any) {
    console.error('Booking error:', err);
    return c.json({ success: false, error: err?.message || 'Internal server error' }, 500);
  }
});

export default app;
