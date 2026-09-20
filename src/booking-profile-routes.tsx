/**
 * Анкета букинга исполнителя — своя, редактируемая из кабинета.
 *
 * Ровно один источник правды на все типы исполнителей: артист, диджей,
 * кавер-группа, ведущий. Пока is_open = false, человека нет ни в
 * каталоге, ни в приёме заявок — это и есть «включаю сам», как решил
 * владелец.
 *
 * fee_hint — служебный ориентир гонорара для переговоров. Владельцу он
 * виден, наружу не отдаётся никогда: в карточке «по запросу».
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { createLogger } from './logger.tsx';

const log = createLogger('booking-profile');
const app = new Hono();

const CATEGORIES = ['artist', 'dj', 'cover_band', 'host'];

function mapRow(r: any) {
  return {
    userId: r.user_id,
    category: r.performer_category,
    isOpen: !!r.is_open,
    displayName: r.display_name || '',
    about: r.about || '',
    cities: r.cities || [],
    formats: r.formats || [],
    feeHint: r.fee_hint !== null && r.fee_hint !== undefined ? Number(r.fee_hint) : null,
    minDurationHours: r.min_duration_hours !== null ? Number(r.min_duration_hours) : null,
    rider: r.rider || {},
    contactName: r.contact_name || '',
    contactPhone: r.contact_phone || '',
    contactEmail: r.contact_email || '',
    moderationStatus: r.moderation_status,
    updatedAt: r.updated_at,
  };
}

// GET /me — анкета текущего пользователя (может ещё не существовать)
app.get('/me', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const { rows } = await pool.query('SELECT * FROM booking_profiles WHERE user_id = $1', [userId]);
    if (rows.length === 0) {
      // Пустая анкета, а не 404: кабинету нужно что-то показать в форме.
      return c.json({
        success: true,
        data: {
          userId,
          category: c.get('userRole') === 'dj' ? 'dj' : 'artist',
          isOpen: false,
          displayName: '',
          about: '',
          cities: [],
          formats: [],
          feeHint: null,
          minDurationHours: null,
          rider: {},
          contactName: '',
          contactPhone: '',
          contactEmail: '',
          moderationStatus: 'approved',
          exists: false,
        },
      });
    }
    return c.json({ success: true, data: { ...mapRow(rows[0]), exists: true } });
  } catch (error) {
    log.error({ err: error }, 'profile_get_failed');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

// PUT /me — сохранить анкету
app.put('/me', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({}));

    const category = CATEGORIES.includes(body.category) ? body.category : 'artist';
    const cities = Array.isArray(body.cities)
      ? body.cities.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 30)
      : [];
    const formats = Array.isArray(body.formats)
      ? body.formats.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 30)
      : [];

    // Включить букинг можно, только если есть чем ответить заказчику:
    // пустая анкета в каталоге — это обманутое ожидание с обеих сторон.
    const isOpen = body.isOpen === true;
    if (isOpen && cities.length === 0) {
      return c.json({
        success: false,
        error: 'Укажите хотя бы один город, где готовы выступать',
        code: 'CITIES_REQUIRED',
      }, 400);
    }

    const { rows } = await pool.query(
      `INSERT INTO booking_profiles (
         user_id, performer_category, is_open, display_name, about, cities, formats,
         fee_hint, min_duration_hours, rider, contact_name, contact_phone, contact_email, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (user_id) DO UPDATE SET
         performer_category = EXCLUDED.performer_category,
         is_open            = EXCLUDED.is_open,
         display_name       = EXCLUDED.display_name,
         about              = EXCLUDED.about,
         cities             = EXCLUDED.cities,
         formats            = EXCLUDED.formats,
         fee_hint           = EXCLUDED.fee_hint,
         min_duration_hours = EXCLUDED.min_duration_hours,
         rider              = EXCLUDED.rider,
         contact_name       = EXCLUDED.contact_name,
         contact_phone      = EXCLUDED.contact_phone,
         contact_email      = EXCLUDED.contact_email,
         updated_at         = now()
       RETURNING *`,
      [
        userId,
        category,
        isOpen,
        String(body.displayName || '').trim().slice(0, 200) || null,
        String(body.about || '').trim().slice(0, 2000) || null,
        cities,
        formats,
        body.feeHint === null || body.feeHint === undefined || body.feeHint === '' ? null : Number(body.feeHint),
        body.minDurationHours ? Number(body.minDurationHours) : null,
        body.rider && typeof body.rider === 'object' ? body.rider : {},
        String(body.contactName || '').trim().slice(0, 200) || null,
        String(body.contactPhone || '').trim().slice(0, 50) || null,
        String(body.contactEmail || '').trim().slice(0, 200) || null,
      ],
    );

    log.info({ userId, isOpen, category }, 'booking_profile_saved');
    return c.json({ success: true, data: mapRow(rows[0]) });
  } catch (error) {
    log.error({ err: error }, 'profile_save_failed');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

export default app;
