/**
 * RADIO DIGEST ROUTES — ежедневная рассылка новинок недели на info@promofm.ru
 *
 * Cron (radio-digest-cron.sh, 10:00 Europe/Berlin) дёргает POST /run.
 * Эндпоинт берёт до PER_RUN ещё не разосланных треков ротации (Новинки
 * недели, user_id='system-friday'), формирует письмо со списком и шлёт его
 * на info@promofm.ru — оттуда оператор ВРУЧНУЮ пересылает партнёрам-радио.
 *
 * Почему «по 2 в день», а не всё сразу: партнёры получают новинки порционно
 * (реальная договорённость с ними), охват в эфире набегает постепенно.
 *
 * Почему на info@promofm.ru, а не партнёрам напрямую: это ЛОКАЛЬНАЯ доставка
 * на собственный домен — не холодная массовая рассылка на чужие адреса, так
 * что репутация/доставляемость домена не страдает. Оператор сам решает, кому
 * переслать. Эфирные детекты (promo_check_detections) тут НЕ пишутся — это
 * только уведомление; реальный pickup фиксируется отдельным механизмом.
 *
 * Источник истины «что уже разослано»: tracks.radio_digest_sent_at
 * (migration 107). NULL = в очереди, timestamptz = отправлено.
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { sendEmail, escapeHtml } from './email-helper.tsx';

const radioDigest = new Hono();

const DIGEST_RECIPIENT = 'info@promofm.ru';
const PER_RUN = 2;                       // сколько треков уходит за один запуск (= в день)
const SITE_URL = 'https://promo-music.ru';
const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';
const DIGEST_LOCK = 720107;              // ключ advisory-lock, уникальный для этого крона

// Cron шлёт X-Internal-Key; из админ-сессии тоже можно дёрнуть вручную.
async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) {
    return next();
  }
  return requireAuth(c, async () => { await requireAdmin(c, next); });
}

interface DigestTrack {
  id: string;
  title: string | null;
  artist_name: string | null;
  genre: string | null;
  audio_url: string | null;
}

function digestHtml(tracks: DigestTrack[]): string {
  const blocks = tracks.map((t, i) => {
    const listen = t.audio_url ? `${SITE_URL}${t.audio_url}` : '';
    return `
      <p style="margin:0 0 16px;">
        <b>${i + 1}) ${escapeHtml(t.artist_name || 'Unknown Artist')} — ${escapeHtml(t.title || 'Без названия')}</b><br>
        ${t.genre ? `Жанр: ${escapeHtml(String(t.genre))}<br>` : ''}
        ${listen ? `Слушать/скачать: <a href="${escapeHtml(listen)}">${escapeHtml(listen)}</a>` : ''}
      </p>`;
  }).join('');
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; color:#111;">
      <h2 style="color:#7C3AED;">Новинки недели — на ротацию партнёрам</h2>
      <p>Готово к пересылке радио-партнёрам (по договорённости — порционно, не всё сразу):</p>
      ${blocks}
      <p style="color:#666; font-size:13px; margin-top:18px;">
        Внутреннее письмо ПРОМО.FM для ручной пересылки партнёрам.
        Джингл/отбивку предоставим по запросу.
      </p>
    </div>`;
}

/**
 * POST /run — отправить очередную порцию новинок (до PER_RUN) на info@.
 * Защита: X-Internal-Key (cron) ИЛИ admin-сессия.
 *
 * Advisory-lock берётся на ВЫДЕЛЕННОМ client'е (lock+select+update+unlock на
 * одном соединении) — иначе в pool'е unlock уйдёт на другое соединение и
 * лок зависнет. Письмо помечает треки отправленными ТОЛЬКО при успехе SMTP —
 * при сбое транспорта вернём их в очередь на следующий запуск.
 */
radioDigest.post('/run', requireAdminOrKey, async (c) => {
  const client = await pool.connect();
  let locked = false;
  try {
    const lk = await client.query('SELECT pg_try_advisory_lock($1) AS got', [DIGEST_LOCK]);
    locked = !!lk.rows[0]?.got;
    if (!locked) {
      return c.json({ success: true, sent: 0, skipped: 'locked' });
    }

    const { rows } = await client.query(
      `SELECT id, title, artist_name, genre, audio_url
         FROM tracks
        WHERE moderation_status = 'published'
          AND user_id = 'system-friday'
          AND radio_digest_sent_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1`,
      [PER_RUN]
    );

    if (rows.length === 0) {
      return c.json({ success: true, sent: 0, message: 'no pending tracks' });
    }

    const dateLabel = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    const ok = await sendEmail({
      to: DIGEST_RECIPIENT,
      subject: `ПРОМО.FM · новинки на ротацию · ${rows.length} трек(а) · ${dateLabel}`,
      html: digestHtml(rows as DigestTrack[]),
    });

    if (!ok) {
      // транспорт упал — НЕ помечаем отправленными, попробуем в следующий запуск
      console.error('[radio-digest] SMTP transport failed, tracks left in queue');
      return c.json({ success: false, sent: 0, error: 'email transport failed' }, 502);
    }

    const ids = rows.map((r: any) => r.id);
    await client.query(
      `UPDATE tracks SET radio_digest_sent_at = NOW() WHERE id = ANY($1::uuid[])`,
      [ids]
    );

    console.log(`[radio-digest] sent ${rows.length} track(s) to ${DIGEST_RECIPIENT}`);
    return c.json({
      success: true,
      sent: rows.length,
      tracks: rows.map((r: any) => ({ id: r.id, title: r.title, artist: r.artist_name })),
    });
  } catch (err: any) {
    console.error('[radio-digest] run failed:', err?.message || err);
    return c.json({ success: false, error: 'internal error' }, 500);
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [DIGEST_LOCK]).catch(() => {});
    }
    client.release();
  }
});

export default radioDigest;
