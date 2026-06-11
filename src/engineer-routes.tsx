/**
 * ENGINEER STUDIO ROUTES — кабинет звукоинженера.
 *
 * MVP-scope: профиль + загрузки (avatar/cover/portfolio audio).
 * Сервисы, заказы, календарь, отзывы — отдельной итерацией.
 *
 * Тon же паттерн что DJ / producer / label studio:
 *   GET    /profile                  — собственный профиль (jsonb)
 *   PUT    /profile                  — обновить
 *   POST   /profile/avatar           — multipart, пишет engineer_profiles.avatar_url
 *   POST   /profile/cover            — то же для cover_url
 *   POST   /portfolio/upload         — multipart audio (mix sample / mastering before/after)
 *   GET    /public/:userId           — публичный профиль (без auth) для маркетплейса
 *
 * Аватары / обложки / портфолио используют shared
 * `src/cabinet-uploads.tsx` (миграция 023 era). Бакет
 * `engineer-avatars` / `engineer-covers` / `engineer-portfolio`
 * nginx раздаёт через общий `/server/uploads/` alias — без
 * переконфига.
 *
 * Гейт: `requireEngineerRole` пропускает только пользователей с
 * `userRole === 'engineer'`. Cross-cabinet админ-доступ —
 * через `requireAdmin` (применяется на отдельных будущих
 * админ-эндпоинтах, не здесь).
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';
import * as db from './db.tsx';
import { saveUpload, IMAGE_EXTS, MAX_IMAGE_BYTES } from './cabinet-uploads.tsx';
import { createLogger } from './logger.tsx';

const log = createLogger('engineer');

const app = new Hono();

// Audio uploads — engineer portfolio (mix samples, before/after мастера).
// Тот же allowlist что DJ uses, перенесён сюда чтобы не тянуть
// DJ-specific module. Поднимем в cabinet-uploads.tsx если ещё
// один кабинет начнёт грузить аудио.
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);
const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200 MB

async function requireEngineerRole(c: any): Promise<Response | { userId: string }> {
  const userId = c.get('userId') as string | undefined;
  const role = c.get('userRole') as string | undefined;
  if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (role !== 'engineer') {
    return c.json({
      success: false,
      error: 'Доступ только для роли «engineer»',
      code: 'WRONG_ROLE',
    }, 403);
  }
  return { userId };
}

// ── GET /profile ────────────────────────────────────────────────

app.get('/profile', requireAuth, async (c) => {
  try {
    const gate = await requireEngineerRole(c);
    if (gate instanceof Response) return gate;

    const data = await db.getEngineerProfile(gate.userId);
    if (!data) {
      // Пустой профиль → FE подставит дефолты + onboarding.
      return c.json({ success: true, data: null });
    }
    return c.json({ success: true, data });
  } catch (error) {
    console.error('Engineer profile load failed:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PUT /profile ────────────────────────────────────────────────

app.put('/profile', requireAuth, async (c) => {
  try {
    const gate = await requireEngineerRole(c);
    if (gate instanceof Response) return gate;

    const body = await c.req.json();
    // Admin-only фолбэк-защита: обычный engineer не должен сам себя
    // «верифицировать» через PUT.
    const role = c.get('userRole');
    if (role !== 'admin' && role !== 'superadmin') {
      if (body && typeof body === 'object') {
        delete body.verified;
        delete body.is_verified;
        if (body.profile && typeof body.profile === 'object') {
          delete body.profile.verified;
        }
      }
    }
    await db.upsertEngineerProfile(gate.userId, body);
    return c.json({ success: true, data: body });
  } catch (error) {
    console.error('Engineer profile save failed:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /profile/avatar ────────────────────────────────────────

app.post('/profile/avatar', requireAuth, async (c) => {
  try {
    const gate = await requireEngineerRole(c);
    if (gate instanceof Response) return gate;

    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);

    const uploaded = await saveUpload(file, 'engineer-avatars', `avatar-${gate.userId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);

    // Денормализованная колонка + nested data.profile.avatarUrl.
    const data: any = (await db.getEngineerProfile(gate.userId)) || {};
    if (!data.profile) data.profile = {};
    data.profile.avatarUrl = uploaded.url;
    await db.upsertEngineerProfile(gate.userId, data);

    log.info({ userId: gate.userId, url: uploaded.url }, 'engineer_avatar_uploaded');
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Engineer avatar upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

// ── POST /profile/cover ─────────────────────────────────────────

app.post('/profile/cover', requireAuth, async (c) => {
  try {
    const gate = await requireEngineerRole(c);
    if (gate instanceof Response) return gate;

    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);

    const uploaded = await saveUpload(file, 'engineer-covers', `cover-${gate.userId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);

    const data: any = (await db.getEngineerProfile(gate.userId)) || {};
    if (!data.profile) data.profile = {};
    data.profile.coverUrl = uploaded.url;
    await db.upsertEngineerProfile(gate.userId, data);

    log.info({ userId: gate.userId, url: uploaded.url }, 'engineer_cover_uploaded');
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Engineer cover upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

// ── POST /portfolio/upload ──────────────────────────────────────
//
// Аудио-сэмпл портфолио. Body: multipart `file`, optional `title` и
// `kind` ('mix_sample'|'mastering_before'|'mastering_after'|'production').
// Возвращаем URL для рендера в редакторе профиля. Persist метаданных
// в `data.portfolio` (массив) — следующая итерация (CRUD endpoint).

app.post('/portfolio/upload', requireAuth, async (c) => {
  try {
    const gate = await requireEngineerRole(c);
    if (gate instanceof Response) return gate;

    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);
    const title = String(body.title || file.name || 'Файл').slice(0, 200);
    const kind = String(body.kind || 'mix_sample').slice(0, 40);

    const uploaded = await saveUpload(
      file,
      'engineer-portfolio',
      `pf-${gate.userId}`,
      AUDIO_EXTS,
      MAX_AUDIO_BYTES,
    );

    log.info(
      { userId: gate.userId, kind, bytes: uploaded.size, ext: uploaded.ext },
      'engineer_portfolio_uploaded',
    );
    return c.json({
      success: true,
      data: {
        url: uploaded.url,
        name: title,
        size: uploaded.size,
        ext: uploaded.ext,
        kind,
      },
    });
  } catch (error: any) {
    console.error('Engineer portfolio upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

// ── Portfolio CRUD (migration 028) ──────────────────────────────
//
// Полноценное портфолио с persist-ом метаданных. Старый
// `/portfolio/upload` остаётся для backward-compat (только файл,
// без записи в таблицу), но новые UI-флоу должны использовать
// POST /portfolio который делает обе вещи атомарно.

// GET /portfolio — список своих работ (включая is_public=false).
app.get('/portfolio', requireAuth, async (c) => {
  try {
    const gate = await requireEngineerRole(c);
    if (gate instanceof Response) return gate;
    const r = await pool.query(
      `SELECT id, title, artist_name, category, description, audio_url, cover_url,
              duration_sec, bpm, partner_id, sort_order, is_public, created_at, updated_at
         FROM engineer_portfolio
        WHERE user_id = $1
        ORDER BY sort_order ASC, created_at DESC`,
      [gate.userId],
    );
    return c.json({
      success: true,
      data: r.rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        artistName: row.artist_name,
        category: row.category,
        description: row.description,
        audioUrl: row.audio_url,
        coverUrl: row.cover_url,
        durationSec: row.duration_sec,
        bpm: row.bpm,
        partnerId: row.partner_id,
        sortOrder: row.sort_order,
        isPublic: row.is_public,
        createdAt: row.created_at?.toISOString?.() || row.created_at,
        updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
      })),
    });
  } catch (error: any) {
    console.error('Engineer portfolio list failed:', error);
    return c.json({ success: false, error: error?.message || 'Server error' }, 500);
  }
});

// POST /portfolio — атомарно: upload файла + INSERT в engineer_portfolio.
// Multipart: file (audio), title, category, description?, artistName?,
// durationSec?
app.post('/portfolio', requireAuth, async (c) => {
  try {
    const gate = await requireEngineerRole(c);
    if (gate instanceof Response) return gate;

    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);

    const title = String(body.title || file.name || 'Без названия').slice(0, 200);
    const category = String(body.category || 'mix_sample').slice(0, 40);
    const description = String(body.description || '').slice(0, 2000) || null;
    const artistName = String(body.artistName || '').slice(0, 200) || null;
    const durationSec = Number(body.durationSec) || null;
    // BPM — опциональный, клиент валидирует диапазон 40-220, бэк
    // принимает любое целое число (или null). См. миграцию 029.
    const bpmRaw = Number(body.bpm);
    const bpm = Number.isFinite(bpmRaw) && bpmRaw > 0 ? Math.round(bpmRaw) : null;

    const uploaded = await saveUpload(
      file,
      'engineer-portfolio',
      `pf-${gate.userId}`,
      AUDIO_EXTS,
      MAX_AUDIO_BYTES,
    );

    const ins = await pool.query(
      `INSERT INTO engineer_portfolio
         (user_id, title, artist_name, category, description, audio_url, duration_sec, bpm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [gate.userId, title, artistName, category, description, uploaded.url, durationSec, bpm],
    );

    log.info(
      { userId: gate.userId, category, bytes: uploaded.size, itemId: ins.rows[0].id },
      'engineer_portfolio_created',
    );

    return c.json({
      success: true,
      data: {
        id: ins.rows[0].id,
        title,
        artistName,
        category,
        description,
        audioUrl: uploaded.url,
        coverUrl: null,
        durationSec,
        bpm,
        sortOrder: 0,
        isPublic: true,
        createdAt: ins.rows[0].created_at?.toISOString?.() || ins.rows[0].created_at,
      },
    });
  } catch (error: any) {
    console.error('Engineer portfolio create failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

// PUT /portfolio/:id — обновить метаданные. Файл/url не меняется,
// для смены файла — DELETE + POST (или отдельный endpoint в будущем).
app.put('/portfolio/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  try {
    const gate = await requireEngineerRole(c);
    if (gate instanceof Response) return gate;
    const body = await c.req.json();
    const setFields: string[] = [];
    const args: any[] = [];
    let i = 1;
    const allowed: Record<string, string> = {
      title: 'title',
      artistName: 'artist_name',
      category: 'category',
      description: 'description',
      durationSec: 'duration_sec',
      bpm: 'bpm',
      sortOrder: 'sort_order',
      isPublic: 'is_public',
      partnerId: 'partner_id',
    };
    for (const [key, column] of Object.entries(allowed)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        setFields.push(`${column} = $${i++}`);
        args.push((body as any)[key]);
      }
    }
    if (setFields.length === 0) {
      return c.json({ success: false, error: 'No fields to update' }, 400);
    }
    setFields.push(`updated_at = NOW()`);
    args.push(id, gate.userId);
    const r = await pool.query(
      `UPDATE engineer_portfolio SET ${setFields.join(', ')}
        WHERE id = $${i++} AND user_id = $${i}
        RETURNING id`,
      args,
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Not found or not yours' }, 404);
    }
    return c.json({ success: true });
  } catch (error: any) {
    console.error('Engineer portfolio update failed:', error);
    return c.json({ success: false, error: error?.message || 'Server error' }, 500);
  }
});

// DELETE /portfolio/:id — удалить запись. Файл на диске не
// удаляется (orphan), периодический GC по `engineer-portfolio/`
// subdir с проверкой по БД — отдельная задача.
app.delete('/portfolio/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  try {
    const gate = await requireEngineerRole(c);
    if (gate instanceof Response) return gate;
    const r = await pool.query(
      `DELETE FROM engineer_portfolio WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, gate.userId],
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Not found or not yours' }, 404);
    }
    return c.json({ success: true });
  } catch (error: any) {
    console.error('Engineer portfolio delete failed:', error);
    return c.json({ success: false, error: error?.message || 'Server error' }, 500);
  }
});

// GET /portfolio/public/:userId — публичный листинг для
// маркетплейс-карточки / public profile page (no auth).
app.get('/portfolio/public/:userId', async (c) => {
  const targetUserId = c.req.param('userId');
  try {
    const r = await pool.query(
      `SELECT id, title, artist_name, category, description, audio_url, cover_url,
              duration_sec, bpm, partner_id, sort_order, created_at
         FROM engineer_portfolio
        WHERE user_id = $1 AND is_public = true
        ORDER BY sort_order ASC, created_at DESC
        LIMIT 100`,
      [targetUserId],
    );
    return c.json({
      success: true,
      data: r.rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        artistName: row.artist_name,
        category: row.category,
        description: row.description,
        audioUrl: row.audio_url,
        coverUrl: row.cover_url,
        durationSec: row.duration_sec,
        bpm: row.bpm,
        partnerId: row.partner_id,
        sortOrder: row.sort_order,
        createdAt: row.created_at?.toISOString?.() || row.created_at,
      })),
    });
  } catch (error: any) {
    console.error('Engineer public portfolio failed:', error);
    return c.json({ success: false, error: error?.message || 'Server error' }, 500);
  }
});

// ── GET /public/:userId — публичный профиль для маркетплейса ────

app.get('/public/:userId', async (c) => {
  const targetUserId = c.req.param('userId');
  try {
    const r = await pool.query(
      `SELECT user_id, full_name, city, country, avatar_url, cover_url,
              bio, specializations, hourly_rate, rating, total_reviews,
              completed_orders, is_verified, is_available, data
         FROM engineer_profiles
        WHERE user_id = $1
        LIMIT 1`,
      [targetUserId],
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Engineer not found' }, 404);
    }
    const row = r.rows[0];
    // Возвращаем только то что подходит для публичной карточки —
    // никаких внутренних полей, никаких editor-only blobs.
    return c.json({
      success: true,
      data: {
        userId: row.user_id,
        fullName: row.full_name,
        city: row.city,
        country: row.country,
        avatarUrl: row.avatar_url,
        coverUrl: row.cover_url,
        bio: row.bio,
        specializations: row.specializations || [],
        hourlyRate: row.hourly_rate,
        rating: Number(row.rating || 0),
        totalReviews: row.total_reviews || 0,
        completedOrders: row.completed_orders || 0,
        isVerified: row.is_verified,
        isAvailable: row.is_available,
        // Selective public data из data jsonb — например socials,
        // certifications. Не отдаём весь блоб целиком чтобы случайно
        // не выкатить editor-only поля.
        socials: row.data?.profile?.socials || row.data?.socials || {},
        certifications: row.data?.profile?.certifications || [],
      },
    });
  } catch (error: any) {
    console.error('Engineer public profile failed:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════
// ENGINEER SERVICES — каталог услуг (сведение/мастеринг/запись/реставрация).
// Маркетплейс заказов (engineer_orders + оплаты) строится поверх — след. слой.
// Inline ensureSchema (memoized): таблица создаётся на первом обращении,
// .sql не нужен (см. backend-migrations-mechanism — CREATE ... IF NOT EXISTS).
// ═══════════════════════════════════════════════════════════════════
let _engServicesReady = false;
async function ensureEngineerServicesSchema() {
  if (_engServicesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engineer_services (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       text NOT NULL,
      title         text NOT NULL,
      service_type  text NOT NULL DEFAULT 'mixing',
      base_price    numeric NOT NULL DEFAULT 0,
      description   text,
      delivery_days integer NOT NULL DEFAULT 3,
      is_active     boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_engineer_services_user ON engineer_services(user_id);`);
  _engServicesReady = true;
}

// Engineer = post-production only (NOT producer's beats/arrangements).
const ENGINEER_SERVICE_TYPES = new Set(['mixing', 'mastering', 'recording', 'restoration', 'dolby_atmos', 'vocal_tuning']);
const ENG_SVC_COLS = `id, user_id, title, service_type, base_price, description, delivery_days, is_active, created_at`;
function mapEngService(r: any) {
  return {
    id: r.id, title: r.title, type: r.service_type,
    basePrice: Number(r.base_price) || 0, description: r.description || '',
    deliveryDays: Number(r.delivery_days) || 0, isActive: r.is_active !== false,
    createdAt: r.created_at,
  };
}

// GET /services — own catalog
app.get('/services', requireAuth, async (c) => {
  const g = await requireEngineerRole(c); if (g instanceof Response) return g;
  try {
    await ensureEngineerServicesSchema();
    const { rows } = await pool.query(
      `SELECT ${ENG_SVC_COLS} FROM engineer_services WHERE user_id = $1 ORDER BY created_at DESC`,
      [g.userId],
    );
    return c.json({ success: true, services: rows.map(mapEngService) });
  } catch (error) { log.error({ error }, 'eng services list'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// POST /services — create
app.post('/services', requireAuth, async (c) => {
  const g = await requireEngineerRole(c); if (g instanceof Response) return g;
  try {
    await ensureEngineerServicesSchema();
    const body = await c.req.json();
    const title = String(body.title || '').trim().slice(0, 200);
    const type = ENGINEER_SERVICE_TYPES.has(body.type) ? body.type : 'mixing';
    const basePrice = Math.max(0, Number(body.basePrice) || 0);
    const description = String(body.description || '').slice(0, 2000);
    const deliveryDays = Math.max(1, Math.min(365, Number(body.deliveryDays) || 3));
    if (!title) return c.json({ success: false, error: 'Название обязательно' }, 400);
    const { rows } = await pool.query(
      `INSERT INTO engineer_services (user_id, title, service_type, base_price, description, delivery_days)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${ENG_SVC_COLS}`,
      [g.userId, title, type, basePrice, description, deliveryDays],
    );
    return c.json({ success: true, service: mapEngService(rows[0]) });
  } catch (error) { log.error({ error }, 'eng service create'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// PUT /services/:id — update own
app.put('/services/:id', requireAuth, async (c) => {
  const g = await requireEngineerRole(c); if (g instanceof Response) return g;
  try {
    await ensureEngineerServicesSchema();
    const id = c.req.param('id');
    const body = await c.req.json();
    const sets: string[] = []; const vals: any[] = []; let i = 1;
    if (typeof body.title === 'string')       { sets.push(`title=$${i++}`); vals.push(body.title.trim().slice(0, 200)); }
    if (typeof body.type === 'string' && ENGINEER_SERVICE_TYPES.has(body.type)) { sets.push(`service_type=$${i++}`); vals.push(body.type); }
    if (body.basePrice != null)               { sets.push(`base_price=$${i++}`); vals.push(Math.max(0, Number(body.basePrice) || 0)); }
    if (typeof body.description === 'string')  { sets.push(`description=$${i++}`); vals.push(body.description.slice(0, 2000)); }
    if (body.deliveryDays != null)            { sets.push(`delivery_days=$${i++}`); vals.push(Math.max(1, Math.min(365, Number(body.deliveryDays) || 3))); }
    if (typeof body.isActive === 'boolean')   { sets.push(`is_active=$${i++}`); vals.push(body.isActive); }
    if (!sets.length) return c.json({ success: false, error: 'Нет полей для обновления' }, 400);
    sets.push(`updated_at=now()`);
    vals.push(id, g.userId);
    const { rows } = await pool.query(
      `UPDATE engineer_services SET ${sets.join(', ')} WHERE id=$${i++} AND user_id=$${i} RETURNING ${ENG_SVC_COLS}`,
      vals,
    );
    if (!rows.length) return c.json({ success: false, error: 'Услуга не найдена' }, 404);
    return c.json({ success: true, service: mapEngService(rows[0]) });
  } catch (error) { log.error({ error }, 'eng service update'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// DELETE /services/:id — delete own
app.delete('/services/:id', requireAuth, async (c) => {
  const g = await requireEngineerRole(c); if (g instanceof Response) return g;
  try {
    await ensureEngineerServicesSchema();
    const { rowCount } = await pool.query(
      `DELETE FROM engineer_services WHERE id=$1 AND user_id=$2`, [c.req.param('id'), g.userId],
    );
    return c.json({ success: (rowCount || 0) > 0 });
  } catch (error) { log.error({ error }, 'eng service delete'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// GET /public/:userId/services — active catalog for the marketplace (no auth)
app.get('/public/:userId/services', async (c) => {
  try {
    await ensureEngineerServicesSchema();
    const { rows } = await pool.query(
      `SELECT ${ENG_SVC_COLS} FROM engineer_services WHERE user_id = $1 AND is_active = true ORDER BY base_price ASC`,
      [c.req.param('userId')],
    );
    return c.json({ success: true, services: rows.map(mapEngService) });
  } catch { return c.json({ success: false, services: [] }); }
});

// ═══════════════════════════════════════════════════════════════════
// ENGINEER ORDERS — маркетплейс заказов (слой 2).
// Жизненный цикл (accept-first: деньги ТОЛЬКО после согласия инженера,
// поэтому авто-возвраты не нужны — деньги не зависают):
//   pending     — клиент оставил заявку, ждёт ответа инженера
//   accepted    — инженер принял (цена подтверждена), ждёт оплаты клиента
//   declined    — инженер отклонил (терминальный)
//   cancelled   — клиент отменил до оплаты (терминальный)
//   in_progress — клиент оплатил, инженер в работе
//   delivered   — инженер сдал результат
//   completed   — клиент подтвердил приём (терминальный)
// Оплата — через общий /server/api/checkout/create-session
// (type=purchase, metadata.type='engineer_order'); вебхук
// (checkout-routes → processPaymentSuccess) переводит accepted→in_progress.
// ═══════════════════════════════════════════════════════════════════
let _engOrdersReady = false;
async function ensureEngineerOrdersSchema() {
  if (_engOrdersReady) return;
  await ensureEngineerServicesSchema();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engineer_orders (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_id       uuid,
      engineer_id      text NOT NULL,
      client_id        text NOT NULL,
      title            text NOT NULL,
      service_type     text NOT NULL DEFAULT 'mixing',
      price            numeric NOT NULL DEFAULT 0,
      brief            text,
      status           text NOT NULL DEFAULT 'pending',
      delivery_url     text,
      delivery_note    text,
      payment_order_id text,
      paid_at          timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_engineer_orders_engineer ON engineer_orders(engineer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_engineer_orders_client ON engineer_orders(client_id);`);
  _engOrdersReady = true;
}

const ENG_ORDER_COLS = `id, service_id, engineer_id, client_id, title, service_type, price, brief, status, delivery_url, delivery_note, payment_order_id, paid_at, created_at, updated_at`;
function mapEngOrder(r: any) {
  return {
    id: r.id, serviceId: r.service_id, engineerId: r.engineer_id, clientId: r.client_id,
    title: r.title, type: r.service_type, price: Number(r.price) || 0,
    brief: r.brief || '', status: r.status,
    deliveryUrl: r.delivery_url || '', deliveryNote: r.delivery_note || '',
    paymentOrderId: r.payment_order_id || '', paidAt: r.paid_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// POST /orders — клиент оставляет заявку на услугу инженера.
// Цена и engineer_id берутся из engineer_services по serviceId (с сервера,
// не из тела) — клиент не может ни занизить цену, ни подменить инженера.
app.post('/orders', requireAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
  try {
    await ensureEngineerOrdersSchema();
    const body = await c.req.json();
    const serviceId = String(body.serviceId || '');
    const brief = String(body.brief || '').slice(0, 4000);
    if (!serviceId) return c.json({ success: false, error: 'serviceId обязателен' }, 400);
    const svc = await pool.query(
      `SELECT id, user_id, title, service_type, base_price, is_active FROM engineer_services WHERE id = $1`,
      [serviceId],
    );
    if (!svc.rows.length || svc.rows[0].is_active === false) {
      return c.json({ success: false, error: 'Услуга недоступна' }, 404);
    }
    const s = svc.rows[0];
    if (s.user_id === userId) return c.json({ success: false, error: 'Нельзя заказать собственную услугу' }, 400);
    const { rows } = await pool.query(
      `INSERT INTO engineer_orders (service_id, engineer_id, client_id, title, service_type, price, brief, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING ${ENG_ORDER_COLS}`,
      [s.id, s.user_id, userId, s.title, s.service_type, Math.max(0, Number(s.base_price) || 0), brief],
    );
    try {
      const { emitSSE } = await import('./sse-routes.tsx');
      emitSSE(s.user_id, { type: 'engineer_order_new', data: { title: s.title } });
    } catch {}
    return c.json({ success: true, order: mapEngOrder(rows[0]) });
  } catch (error) { log.error({ error }, 'eng order create'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// GET /orders/incoming — входящие заказы инженера (ВАЖНО: до /orders/:id)
app.get('/orders/incoming', requireAuth, async (c) => {
  const g = await requireEngineerRole(c); if (g instanceof Response) return g;
  try {
    await ensureEngineerOrdersSchema();
    const { rows } = await pool.query(
      `SELECT ${ENG_ORDER_COLS} FROM engineer_orders WHERE engineer_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [g.userId],
    );
    return c.json({ success: true, orders: rows.map(mapEngOrder) });
  } catch (error) { log.error({ error }, 'eng orders incoming'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// GET /orders/my — заказы, которые разместил клиент (до /orders/:id)
app.get('/orders/my', requireAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
  try {
    await ensureEngineerOrdersSchema();
    const { rows } = await pool.query(
      `SELECT ${ENG_ORDER_COLS} FROM engineer_orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [userId],
    );
    return c.json({ success: true, orders: rows.map(mapEngOrder) });
  } catch (error) { log.error({ error }, 'eng orders my'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// GET /orders/:id — одна карточка (доступна любой из двух сторон сделки)
app.get('/orders/:id', requireAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
  try {
    await ensureEngineerOrdersSchema();
    const { rows } = await pool.query(`SELECT ${ENG_ORDER_COLS} FROM engineer_orders WHERE id = $1`, [c.req.param('id')]);
    if (!rows.length) return c.json({ success: false, error: 'Заказ не найден' }, 404);
    const o = rows[0];
    if (o.engineer_id !== userId && o.client_id !== userId) {
      return c.json({ success: false, error: 'Нет доступа к заказу' }, 403);
    }
    return c.json({ success: true, order: mapEngOrder(o) });
  } catch (error) { log.error({ error }, 'eng order get'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// PUT /orders/:id/accept — инженер принимает (pending → accepted), может уточнить цену
app.put('/orders/:id/accept', requireAuth, async (c) => {
  const g = await requireEngineerRole(c); if (g instanceof Response) return g;
  try {
    await ensureEngineerOrdersSchema();
    const body = await c.req.json().catch(() => ({}));
    const id = c.req.param('id');
    const hasPrice = body.price != null && Number.isFinite(Number(body.price)) && Number(body.price) >= 0;
    const { rows } = await pool.query(
      `UPDATE engineer_orders
         SET status='accepted'${hasPrice ? ', price=$3' : ''}, updated_at=now()
       WHERE id=$1 AND engineer_id=$2 AND status='pending'
       RETURNING ${ENG_ORDER_COLS}`,
      hasPrice ? [id, g.userId, Math.max(0, Number(body.price))] : [id, g.userId],
    );
    if (!rows.length) return c.json({ success: false, error: 'Заказ не в статусе «ожидает ответа» или не ваш' }, 409);
    return c.json({ success: true, order: mapEngOrder(rows[0]) });
  } catch (error) { log.error({ error }, 'eng order accept'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// PUT /orders/:id/decline — инженер отклоняет (pending → declined)
app.put('/orders/:id/decline', requireAuth, async (c) => {
  const g = await requireEngineerRole(c); if (g instanceof Response) return g;
  try {
    await ensureEngineerOrdersSchema();
    const { rows } = await pool.query(
      `UPDATE engineer_orders SET status='declined', updated_at=now()
       WHERE id=$1 AND engineer_id=$2 AND status='pending' RETURNING ${ENG_ORDER_COLS}`,
      [c.req.param('id'), g.userId],
    );
    if (!rows.length) return c.json({ success: false, error: 'Заказ нельзя отклонить' }, 409);
    return c.json({ success: true, order: mapEngOrder(rows[0]) });
  } catch (error) { log.error({ error }, 'eng order decline'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// PUT /orders/:id/deliver — инженер сдаёт результат (in_progress → delivered)
app.put('/orders/:id/deliver', requireAuth, async (c) => {
  const g = await requireEngineerRole(c); if (g instanceof Response) return g;
  try {
    await ensureEngineerOrdersSchema();
    const body = await c.req.json().catch(() => ({}));
    const deliveryUrl = String(body.deliveryUrl || '').slice(0, 2000);
    const note = String(body.note || '').slice(0, 2000);
    const { rows } = await pool.query(
      `UPDATE engineer_orders SET status='delivered', delivery_url=$3, delivery_note=$4, updated_at=now()
       WHERE id=$1 AND engineer_id=$2 AND status='in_progress' RETURNING ${ENG_ORDER_COLS}`,
      [c.req.param('id'), g.userId, deliveryUrl, note],
    );
    if (!rows.length) return c.json({ success: false, error: 'Заказ не в работе или не ваш' }, 409);
    try {
      const { emitSSE } = await import('./sse-routes.tsx');
      emitSSE(rows[0].client_id, { type: 'engineer_order_delivered', data: { title: rows[0].title } });
    } catch {}
    return c.json({ success: true, order: mapEngOrder(rows[0]) });
  } catch (error) { log.error({ error }, 'eng order deliver'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// PUT /orders/:id/complete — клиент подтверждает приём (delivered → completed)
app.put('/orders/:id/complete', requireAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
  try {
    await ensureEngineerOrdersSchema();
    const { rows } = await pool.query(
      `UPDATE engineer_orders SET status='completed', updated_at=now()
       WHERE id=$1 AND client_id=$2 AND status='delivered' RETURNING ${ENG_ORDER_COLS}`,
      [c.req.param('id'), userId],
    );
    if (!rows.length) return c.json({ success: false, error: 'Заказ не сдан или не ваш' }, 409);
    try {
      await pool.query(
        `UPDATE engineer_profiles SET completed_orders = COALESCE(completed_orders,0)+1 WHERE user_id=$1`,
        [rows[0].engineer_id],
      );
    } catch (e) { log.warn({ e }, 'completed_orders bump skipped'); }
    return c.json({ success: true, order: mapEngOrder(rows[0]) });
  } catch (error) { log.error({ error }, 'eng order complete'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// PUT /orders/:id/cancel — клиент отменяет до оплаты (pending/accepted → cancelled)
app.put('/orders/:id/cancel', requireAuth, async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
  try {
    await ensureEngineerOrdersSchema();
    const { rows } = await pool.query(
      `UPDATE engineer_orders SET status='cancelled', updated_at=now()
       WHERE id=$1 AND client_id=$2 AND status IN ('pending','accepted') RETURNING ${ENG_ORDER_COLS}`,
      [c.req.param('id'), userId],
    );
    if (!rows.length) return c.json({ success: false, error: 'Заказ нельзя отменить (уже оплачен или завершён)' }, 409);
    return c.json({ success: true, order: mapEngOrder(rows[0]) });
  } catch (error) { log.error({ error }, 'eng order cancel'); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

/**
 * POST /admin/orders/:id/refund — admin-инициированный возврат денег
 * клиенту за оплаченный engineer_order.
 *
 * Зачем: после оплаты (status='in_progress') у клиента нет
 * self-cancel пути. Если инженер пропал — единственный выход через
 * support-тикет → этот endpoint отрабатывает решение админа.
 *
 * Сценарий:
 *   1. Клиент пишет в support → /ctrl-pm7k2f/inbox?tab=tickets
 *   2. Админ принимает решение «вернуть» (engineer пропал /
 *      результат не принят / claim легитимный)
 *   3. Админ дёргает POST /server/api/engineer/admin/orders/:id/refund
 *      { reason } из любого admin-tool'а (curl / cabinet / Postman)
 *
 * Что делает:
 *   1. Loads engineer_orders by id (must be in_progress|delivered)
 *   2. Loads payment_session by payment_order_id → gatewayPaymentId
 *   3. yk.refund() с idempotenceKey = refund-eng-{orderId} — повторный
 *      вызов не списывает второй раз
 *   4. UPDATE engineer_orders SET status='refunded'
 *   5. UPDATE platform_revenue_log SET status='refunded' WHERE
 *      channel='engineer_order' AND metadata->>orderId = payment_order_id
 *      — чтобы /engineer/earnings (status='completed' filter)
 *      перестал считать эту сумму как заработанную
 *   6. SSE engineer ('engineer_order_refunded') + client
 *      ('engineer_order_refund_credited')
 *
 * Зеркало marketplace-routes.tsx:1782 (/admin/purchases/refund) — тот же
 * паттерн: idempotenceKey + yookassa-only + UPDATE + SSE.
 *
 * Auth: requireAdmin (только superadmin email — см. roles.tsx).
 *
 * Body: { reason?: string } — для audit log'а и refund description.
 *
 * Errors:
 *   - 404 если заказ не найден
 *   - 409 если status не in_progress/delivered (refund невозможен)
 *   - 422 если payment_order_id NULL (старый заказ до атрибуции)
 *   - 501 если gateway не yookassa (Stripe/TBank refund — отдельно)
 *   - 502 если YooKassa отказала
 */
app.post('/admin/orders/:id/refund', requireAuth, requireAdmin, async (c) => {
  // `'userId' as never` — обход Hono TS-gap'а (c.get без context
  // augmentation выводит ключ как never). Тот же pattern что в
  // venue-routes.tsx:182. Существующие 6 хэндлеров файла этот gap
  // не обходят (pre-existing TS2769'ы), но новые добавлять не плодим.
  const adminId = c.get('userId' as never) as string;
  const orderId = c.req.param('id');
  try {
    await ensureEngineerOrdersSchema();
    const body = await c.req.json().catch(() => ({}));
    const reason = String(body?.reason || '').slice(0, 250);

    const ord = await pool.query(
      `SELECT id, engineer_id, client_id, title, price, status, payment_order_id
         FROM engineer_orders WHERE id=$1 LIMIT 1`,
      [orderId],
    );
    if (!ord.rows.length) {
      return c.json({ success: false, error: 'Заказ не найден' }, 404);
    }
    const o = ord.rows[0];
    if (o.status === 'refunded') {
      return c.json({ success: false, error: 'Заказ уже возвращён' }, 409);
    }
    if (!['in_progress', 'delivered'].includes(o.status)) {
      return c.json({
        success: false,
        error: `Refund возможен только для оплаченных заказов (status=${o.status})`,
      }, 409);
    }
    if (!o.payment_order_id) {
      return c.json({
        success: false,
        error: 'payment_order_id NULL — refund через YooKassa-дашборд вручную',
      }, 422);
    }

    const { getPaymentSession } = await import('./db.tsx');
    const session = await getPaymentSession(o.payment_order_id) as any;
    if (!session?.gatewayPaymentId) {
      return c.json({ success: false, error: 'payment_session не найден' }, 404);
    }
    if (session.gateway !== 'yookassa') {
      return c.json({
        success: false,
        error: `Gateway ${session.gateway} не поддерживается auto-refund'ом`,
      }, 501);
    }

    const { YooKassaGateway } = await import('./gateway-yookassa.tsx');
    const yk = new YooKassaGateway();
    let refund: any;
    try {
      refund = await yk.refund(session.gatewayPaymentId, Number(o.price), {
        description: `Возврат engineer_order #${orderId}${reason ? ': ' + reason : ''}`.slice(0, 250),
        idempotenceKey: `refund-eng-${orderId}`,
        metadata: { engineerOrderId: orderId, reason, refundedBy: adminId },
        shopId: session.shopId,
      });
    } catch (refundErr: any) {
      log.error({ err: refundErr, orderId }, 'eng admin refund yk fail');
      return c.json({
        success: false,
        error: 'YooKassa отклонила refund: ' + (refundErr?.message || 'unknown'),
      }, 502);
    }

    const refundedAt = new Date().toISOString();
    await pool.query(
      `UPDATE engineer_orders SET status='refunded', updated_at=now() WHERE id=$1`,
      [orderId],
    );
    // Снимаем сумму с /engineer/earnings: тот фильтрует на
    // status='completed', поэтому 'refunded' автоматически исключит её
    // из total/month. UPDATE по metadata.orderId — JSONB-фильтр, без
    // индекса; для admin-1-off refund приемлемо (объёмы ~единицы строк
    // на адресный поиск, не hot path).
    await pool.query(
      `UPDATE platform_revenue_log SET status='refunded', updated_at=NOW()
        WHERE channel='engineer_order' AND metadata->>'orderId' = $1`,
      [o.payment_order_id],
    );

    try {
      const { emitSSE } = await import('./sse-routes.tsx');
      emitSSE(o.engineer_id, {
        type: 'engineer_order_refunded',
        data: { orderId, title: o.title, amount: Number(o.price), reason },
      });
      emitSSE(o.client_id, {
        type: 'engineer_order_refund_credited',
        data: { orderId, title: o.title, amount: Number(o.price), refundId: refund.id },
      });
    } catch {}

    log.info({ orderId, engineerId: o.engineer_id, clientId: o.client_id,
               amount: Number(o.price), refundId: refund.id, adminId, reason },
             'engineer_order_refunded');

    return c.json({
      success: true,
      refund: {
        orderId,
        refundId: refund.id,
        amount: Number(o.price),
        status: refund.status,
        refundedAt,
      },
    });
  } catch (error) {
    log.error({ error, orderId }, 'eng admin refund');
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
