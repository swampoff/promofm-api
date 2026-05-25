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
import { requireAuth } from './auth-middleware.tsx';
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
              duration_sec, partner_id, sort_order, is_public, created_at, updated_at
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

    const uploaded = await saveUpload(
      file,
      'engineer-portfolio',
      `pf-${gate.userId}`,
      AUDIO_EXTS,
      MAX_AUDIO_BYTES,
    );

    const ins = await pool.query(
      `INSERT INTO engineer_portfolio
         (user_id, title, artist_name, category, description, audio_url, duration_sec)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [gate.userId, title, artistName, category, description, uploaded.url, durationSec],
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
              duration_sec, partner_id, sort_order, created_at
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

export default app;
