/**
 * WAITLIST ROUTES — Сбор заявок на ранний доступ к будущим фичам.
 *  POST /api/waitlist/distribution  — анонс дистрибуции в стриминги (Я.Музыка, Spotify, ...)
 *  GET  /api/waitlist/distribution  — admin: список заявок
 */
import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { notifyAdminTelegram, sendEmail } from './email-helper.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const app = new Hono();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/distribution', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ success: false, error: 'Invalid JSON' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  const source = String(body.source || 'landing').slice(0, 64);
  if (!EMAIL_RE.test(email) || email.length > 200) {
    return c.json({ success: false, error: 'Некорректный email' }, 400);
  }

  try {
    // Ensure table exists (idempotent)
    await pool.query(`CREATE TABLE IF NOT EXISTS waitlist_distribution (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      source TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for') || '';
    const ua = c.req.header('user-agent') || '';

    const r = await pool.query(
      `INSERT INTO waitlist_distribution (email, source, ip, user_agent)
       VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email, source, ip.slice(0, 64), ua.slice(0, 256)]
    );
    const isNew = r.rows.length > 0;

    // Best-effort admin alerts
    if (isNew) {
      notifyAdminTelegram(
        `🟣 <b>Новая заявка на дистрибуцию</b>\n\nEmail: <code>${email}</code>\nИсточник: ${source}\nIP: ${ip || '?'}`
      ).catch(() => {});

      sendEmail({
        to: email,
        subject: 'Вы в списке ранних – дистрибуция ПРОМО.МУЗЫКА',
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;padding:24px;background:#0a0a14;color:#e0e0e0;border-radius:12px">
          <h2 style="color:#FF577F;margin:0 0 16px">Спасибо! Вы в списке ранних 🎉</h2>
          <p>Скоро мы запустим дистрибуцию ваших треков в Яндекс.Музыку, VK Music, Spotify, Apple Music, СберЗвук, YouTube Music и ещё 30+ сервисов.</p>
          <p><strong>Что получите как early access:</strong></p>
          <ul style="line-height:1.6">
            <li>−50% на первый год дистрибуции</li>
            <li>Приоритет в очереди подключения</li>
            <li>Личный куратор на первый релиз</li>
          </ul>
          <p style="margin-top:24px">Просто оставайтесь на платформе – пришлём приглашение когда сервис будет готов.</p>
          <p style="color:#888;font-size:12px;margin-top:32px">ПРОМО.МУЗЫКА · <a href="https://promo-music.ru" style="color:#FF577F">promo-music.ru</a></p>
        </div>`,
      }).catch(() => {});
    }

    return c.json({ success: true, isNew });
  } catch (err: any) {
    console.error('[waitlist/distribution]', err.message);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.get('/distribution', requireAuth, requireAdmin, async (c) => {
  const r = await pool.query(
    `SELECT id, email, source, created_at FROM waitlist_distribution ORDER BY created_at DESC LIMIT 500`
  );
  return c.json({ success: true, data: r.rows, total: r.rowCount });
});

export default app;
