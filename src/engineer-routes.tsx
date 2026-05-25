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
