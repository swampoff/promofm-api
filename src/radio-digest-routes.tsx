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
import { existsSync } from 'node:fs';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { sendEmail, escapeHtml } from './email-helper.tsx';
import { smtpSendBatch } from './smtp-sender.tsx';
import { makeRadioDownloadKey, TEST_RECIPIENT_ID } from './radio-dl-token.tsx';

const radioDigest = new Hono();

const DIGEST_RECIPIENT = 'info@promofm.ru';
const PER_RUN = 2;                       // сколько треков уходит за один запуск (= в день)
const SITE_URL = 'https://promo-music.ru';

// Баннер шапки дайджеста. Лежит рядом с остальными баннерами сайта.
// Владелец 2026-08-14: постоянная обложка «Новинки недели». Квадратная,
// с нарисованной кнопкой «Скачать» — заменяет прежний сгенерированный
// баннер 1200×600.
const DIGEST_BANNER_FILE = 'novinki-nedeli-cover.jpg';
const DIGEST_BANNER_PATH = `/var/www/promofm/html/banners/${DIGEST_BANNER_FILE}`;
// Разовые шапки выпуска (владелец 24.10.2026: «поставь это фото», потом снова обычная).
// Действуют до момента until, дальше письмо само возвращается к DIGEST_BANNER_FILE.
// Файл кладём в репозиторий фронта (public/banners), иначе выкладка сайта его сотрёт.
const ONE_OFF_BANNERS: { file: string; until: string }[] = [
  { file: 'novinki-nedeli-2026-10-26.jpg', until: '2026-10-27T00:00:00+03:00' },
];
function currentBannerFile(): string {
  const now = Date.now();
  const special = ONE_OFF_BANNERS.find((b) => now < Date.parse(b.until)
    && existsSync(`/var/www/promofm/html/banners/${b.file}`));
  return special ? special.file : DIGEST_BANNER_FILE;
}
const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';
const DIGEST_LOCK = 720107;              // ключ advisory-lock, уникальный для daily info@-крона
const WEEKLY_LOCK = 720108;              // ОТДЕЛЬНЫЙ ключ для понедельничного weekly-крона
const WEEKLY_WINDOW_DAYS = 8;            // берём только свежий пятничный батч, не бэклог

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
        <b>${i + 1}) ${escapeHtml(t.artist_name || 'Unknown Artist')} – ${escapeHtml(t.title || 'Без названия')}</b><br>
        ${t.genre ? `Жанр: ${escapeHtml(String(t.genre))}<br>` : ''}
        Слушать: <a href="${SITE_URL}/novinki-nedeli">${SITE_URL}/novinki-nedeli</a>
      </p>`;
  }).join('');
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; color:#111;">
      <h2 style="color:#7C3AED;">Новинки недели – на ротацию партнёрам</h2>
      <p>Готово к пересылке радио-партнёрам (по договорённости – порционно, не всё сразу):</p>
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

// ════════════════════════════════════════════════════════════════════════
// WEEKLY — понедельничная прямая рассылка новинок всей базе радиостанций
// ════════════════════════════════════════════════════════════════════════
//
// Отличие от daily info@-дайджеста выше:
//   - шлёт НАПРЯМУЮ радиостанциям (зарегистрированным + партнёрам), не на info@;
//   - весь пятничный батч недели за один раз, не по 2/день;
//   - красивая карточная вёрстка с лого вместо плоского списка;
//   - свой курсор radio_weekly_digest_sent_at (не конфликтует с #264).
//
// Cron: 0 12 * * 1 (понедельник 12:00) дёргает POST /run-weekly с X-Internal-Key.

interface WeeklyTrack {
  id: string;
  title: string | null;
  artist_name: string | null;
  genre: string | null;
  audio_url: string | null;
  cover_url: string | null;
}

const COVER_GRADIENTS = [
  'linear-gradient(135deg,#FF577F,#7C3AED)',
  'linear-gradient(135deg,#7C3AED,#06B6D4)',
  'linear-gradient(135deg,#F59E0B,#EF4444)',
  'linear-gradient(135deg,#10B981,#06B6D4)',
];

function absUrl(path: string | null): string {
  if (!path) return '';
  return path.startsWith('http') ? path : `${SITE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

function weeklyTrackCard(t: WeeklyTrack, i: number): string {
  const cover = absUrl(t.cover_url);
  // Жалоба радиостанции 2026-08-11: «нажимаешь слушать, трек скачивается».
  // Ссылка вела прямо на mp3, браузер его качал. Теперь «Слушать» ведёт на
  // публичную страницу новинок с плеером (логин не нужен), а скачивание
  // вынесено отдельной кнопкой на защищённый эндпоинт с учётом выдач.
  const listen = `${SITE_URL}/novinki-nedeli`;
  // 01.10.2026: личная ссылка станции без входа (radio-get-routes.tsx).
  // {{dlkey}} подставляет smtpSendBatch на каждого получателя.
  const download = `${SITE_URL}/server/api/radio-get/${t.id}?k={{dlkey}}`;
  const coverCell = cover
    ? `<img src="${escapeHtml(cover)}" width="64" height="64" alt="" style="border-radius:10px;display:block;" />`
    : `<div style="width:64px;height:64px;border-radius:10px;background:${COVER_GRADIENTS[i % COVER_GRADIENTS.length]};text-align:center;line-height:64px;color:#fff;font-size:24px;font-weight:700;">&#9834;</div>`;
  const genreChip = t.genre
    ? `<span style="display:inline-block;padding:3px 10px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.4);border-radius:20px;color:#C4B5FD;font-size:11px;">${escapeHtml(String(t.genre))}</span>`
    : '';
  return `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0;background:#1d1d38;border:1px solid rgba(255,255,255,0.07);border-radius:14px;">
          <tr>
            <td width="76" style="padding:14px;vertical-align:middle;">${coverCell}</td>
            <td style="padding:14px 8px;vertical-align:middle;">
              <div style="color:#ffffff;font-size:16px;font-weight:700;margin-bottom:3px;">${escapeHtml(t.title || 'Без названия')}</div>
              <div style="color:#FF8FA8;font-size:14px;margin-bottom:6px;">${escapeHtml(t.artist_name || 'Unknown Artist')}</div>
              ${genreChip}
            </td>
            <td width="104" align="right" style="padding:14px;vertical-align:middle;">
              <a href="${escapeHtml(listen)}" style="display:inline-block;padding:9px 16px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;">&#9654; Слушать</a>
              <a href="${escapeHtml(download)}" style="display:inline-block;margin-top:6px;padding:9px 16px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.35);color:#6EE7B7;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;">&#8681; Скачать</a>
            </td>
          </tr>
        </table>`;
}

// Промо-клипы из video promo-pipeline (videos-routes.tsx /addToNewsletter,
// migration 122) — секция «Новые клипы для эфира» под треками.
interface WeeklyVideo {
  id: string;
  title: string | null;
  artist_name: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
}

function weeklyVideoCard(v: WeeklyVideo, i: number): string {
  const thumb = absUrl(v.thumbnail_url);
  const watch = v.video_url ? absUrl(v.video_url) : SITE_URL;
  const thumbCell = thumb
    ? `<img src="${escapeHtml(thumb)}" width="96" height="64" alt="" style="border-radius:10px;display:block;object-fit:cover;" />`
    : `<div style="width:96px;height:64px;border-radius:10px;background:${COVER_GRADIENTS[i % COVER_GRADIENTS.length]};text-align:center;line-height:64px;color:#fff;font-size:24px;font-weight:700;">&#9654;</div>`;
  return `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0;background:#1d1d38;border:1px solid rgba(255,255,255,0.07);border-radius:14px;">
          <tr>
            <td width="112" style="padding:14px;vertical-align:middle;">${thumbCell}</td>
            <td style="padding:14px 8px;vertical-align:middle;">
              <div style="color:#ffffff;font-size:16px;font-weight:700;margin-bottom:3px;">${escapeHtml(v.title || 'Без названия')}</div>
              <div style="color:#FF8FA8;font-size:14px;">${escapeHtml(v.artist_name || 'Артист')}</div>
            </td>
            <td width="112" align="right" style="padding:14px;vertical-align:middle;">
              <a href="${escapeHtml(watch)}" style="display:inline-block;padding:9px 18px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;">&#9654; Смотреть</a>
            </td>
          </tr>
        </table>`;
}

function weeklyDigestHtml(tracks: WeeklyTrack[], dateLabel: string, videos: WeeklyVideo[] = []): string {
  const cards = tracks.map((t, i) => weeklyTrackCard(t, i)).join('');
  const videoSection = videos.length
    ? `
    <tr><td style="padding:16px 40px 0;color:#e6e6f0;font-size:16px;">
      <h2 style="margin:0;color:#fff;font-size:20px;font-weight:800;">&#127916; Новые клипы для эфира</h2>
    </td></tr>
    <tr><td style="padding:8px 28px 4px;">${videos.map((v, i) => weeklyVideoCard(v, i)).join('')}</td></tr>`
    : '';
  // Публичная страница: станции жаловались, что из письма приходится заново
  // вводить логин и пароль. Слушать и смотреть подборку можно без входа,
  // вход нужен только для скачивания (учёт выдач по станциям).
  const releasesUrl = `${SITE_URL}/novinki-nedeli`;

  // Шапка-баннер. Жалоба владельца 2026-08-11: в письме станциям сверху висел
  // значок «?» — файл /banners/novinki-nedeli.jpg отдавал 404, его на сервере
  // не было никогда. Битая картинка в шапке письма хуже её отсутствия, поэтому
  // вставляем строку с баннером ТОЛЬКО если файл реально лежит на диске.
  // Ниже идёт градиентный заголовок, он рисуется стилями и виден всегда.
  let bannerRow = '';
  try {
    const bannerFile = currentBannerFile();
    if (existsSync(`/var/www/promofm/html/banners/${bannerFile}`)) {
      bannerRow = `<tr>
      <td style="padding:0;"><a href="${releasesUrl}" style="text-decoration:none;"><img src="${SITE_URL}/banners/${bannerFile}" alt="Новинки недели promo.music" style="width:100%;height:auto;display:block;border:0;" /></a></td>
    </tr>`;
    } else {
      console.warn(`[radio-digest] баннер отсутствует: ${bannerFile} – письмо уйдёт без шапки`);
    }
  } catch { /* без баннера письмо остаётся корректным */ }
  // {{name}} подставляет smtpSendBatch на каждого получателя (имя станции).
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#0a0a1a;padding:32px 16px;">
  <table align="center" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background:#14142a;border-radius:18px;overflow:hidden;">
    ${bannerRow}
    <tr>
      <td style="padding:30px 40px 26px;background:linear-gradient(135deg,#FF577F 0%,#7C3AED 100%);">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="left" style="vertical-align:middle;"><img src="${SITE_URL}/logo.png" alt="ПРОМО.МУЗЫКА" height="36" style="height:36px;display:block;border:0;" /></td>
          <td align="right" style="vertical-align:middle;color:rgba(255,255,255,0.85);font-size:12px;letter-spacing:2px;text-transform:uppercase;">Дайджест для эфира</td>
        </tr></table>
        <h1 style="margin:22px 0 4px;color:#fff;font-size:27px;line-height:1.2;font-weight:800;">&#127925; Новинки недели</h1>
        <p style="margin:0;color:rgba(255,255,255,0.9);font-size:15px;">Свежие треки для вашей ротации &middot; ${escapeHtml(dateLabel)}</p>
      </td>
    </tr>
    <tr>
      <td style="padding:28px 40px 6px;color:#e6e6f0;font-size:16px;line-height:1.6;">
        <p style="margin:0 0 14px;">Здравствуйте, <strong style="color:#fff;">{{name}}</strong>!</p>
        <p style="margin:0 0 8px;">Подобрали новые релизы артистов ПРОМО.МУЗЫКА за прошедшую неделю – послушайте и забирайте подходящие в эфир. Все треки готовы к ротации: лицензии, метаданные и джинглы – в порядке.</p>
      </td>
    </tr>
    <tr><td style="padding:12px 28px 4px;">${cards}</td></tr>${videoSection}
    <tr><td align="center" style="padding:18px 40px 8px;">
      <a href="${releasesUrl}" style="display:inline-block;padding:15px 38px;background:linear-gradient(135deg,#FF577F 0%,#7C3AED 100%);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px;">Открыть все новинки недели</a>
    </td></tr>
    <tr><td align="center" style="padding:4px 40px 24px;color:#8a8aa0;font-size:13px;">Слушать и скачивать можно сразу, без входа в кабинет: кнопки «Скачать» в этом письме личные, для вашей станции.</td></tr>
    <tr><td style="padding:24px 40px 30px;border-top:1px solid #2a2a45;text-align:center;">
      <img src="${SITE_URL}/logo.png" alt="ПРОМО.МУЗЫКА" height="30" style="height:30px;margin-bottom:12px;border:0;" />
      <p style="margin:0 0 6px;color:#c8c8d8;font-size:13px;font-weight:600;">Команда ПРОМО.МУЗЫКА</p>
      <p style="margin:0;color:#666;font-size:12px;">&copy; ${new Date().getFullYear()} ПРОМО.МУЗЫКА – платформа продвижения музыки</p>
      <p style="margin:6px 0 0;"><a href="${SITE_URL}" style="color:#FF577F;text-decoration:none;font-size:12px;">promo-music.ru</a></p>
    </td></tr>
  </table>
</div>`;
}

/**
 * Собрать получателей понедельничной рассылки:
 *   1) зарегистрированные радио-аккаунты (users.role='radio_station');
 *   2) внешние станции-партнёры (radio_partner_contacts, active, не отписаны);
 *   3) info@promofm.ru (копия оператору для ручной пересылки тем, кого нет в б/д).
 * Дедуп по lower(email). Глобально отписанные (email_unsubscribes) отсекаются.
 */
export async function getWeeklyRecipients(client: any): Promise<{ email: string; name: string; dlkey: string }[]> {
  const users = await client.query(
    `SELECT u.id::text AS id, u.email AS email,
            COALESCE(NULLIF(u.full_name, ''), split_part(u.email, '@', 1)) AS name
       FROM users u
      WHERE u.role = 'radio_station'
        AND u.email IS NOT NULL AND u.email <> ''`
  );
  const partners = await client.query(
    // source='curated_2026' — курированные РЕКЛАМНЫЕ контакты (сейлз-хаусы
    // ГПМ/ЕМГ/НРА и т.п.). Музыкальный дайджест «забирайте треки в ротацию» им
    // слать НЕЛЬЗЯ (не та аудитория) — исключаем из weekly. Они в базе для
    // рекламного аутрича + суппрессии, но не для music-рассылки.
    `SELECT id::text AS id, email, station_name AS name
       FROM radio_partner_contacts
      WHERE active = TRUE AND unsubscribed_at IS NULL
        AND email IS NOT NULL AND email <> ''
        AND COALESCE(source, '') <> 'curated_2026'`
  );
  const unsub = await client.query(`SELECT LOWER(email) AS email FROM email_unsubscribes`);
  const unsubSet = new Set<string>(unsub.rows.map((r: any) => r.email));

  const map = new Map<string, { email: string; name: string; dlkey: string }>();
  // dlkey — личный ключ ссылок «Скачать» (radio-dl-token.tsx): u — аккаунт станции,
  // p — партнёрский контакт, t — служебная копия (скачивания не учитываются).
  const push = (rawEmail: string, rawName: string, dlkey: string) => {
    const email = String(rawEmail || '').trim();
    const key = email.toLowerCase();
    if (!email || !key.includes('@') || unsubSet.has(key) || map.has(key)) return;
    map.set(key, { email, name: String(rawName || '').trim() || email.split('@')[0], dlkey });
  };
  for (const r of users.rows) push(r.email, r.name, makeRadioDownloadKey('u', r.id));
  for (const r of partners.rows) push(r.email, r.name, makeRadioDownloadKey('p', r.id));
  push(DIGEST_RECIPIENT, 'ПРОМО.ФМ', makeRadioDownloadKey('t', TEST_RECIPIENT_ID));
  return [...map.values()];
}

/**
 * POST /run-weekly — понедельничная прямая рассылка новинок недели всей базе.
 * Защита: X-Internal-Key (cron) ИЛИ admin-сессия.
 *
 * Идемпотентность: advisory-lock от параллельного запуска + курсор
 * radio_weekly_digest_sent_at. Отправка — В ФОНЕ (2026-07-02): раньше
 * ~1200 писем с троттлингом 2с/50 шли ИНЛАЙН до HTTP-ответа — cron'овский
 * curl -m 120 гарантированно обрывался каждый понедельник, а рестарт сервиса
 * посреди многоминутной отправки оставлял треки без штампа → полная
 * пере-рассылка всей базе на следующем прогоне. Теперь отвечаем сразу (202),
 * а lock и клиент держим до завершения фоновой отправки — конкурентный запуск
 * невозможен. Треки штампуются только если хоть одно письмо ушло; партнёры —
 * ТОЛЬКО успешно доставленные (F4: неудачные адреса не выпадают из «холодного
 * остатка» laptop'а).
 */
radioDigest.post('/run-weekly', requireAdminOrKey, async (c) => {
  const client = await pool.connect();
  let locked = false;
  let backgrounded = false;
  try {
    const lk = await client.query('SELECT pg_try_advisory_lock($1) AS got', [WEEKLY_LOCK]);
    locked = !!lk.rows[0]?.got;
    if (!locked) return c.json({ success: true, sent: 0, skipped: 'locked' });

    // FIX 2026-07-10: friday.js с 2026-06-13 даёт трекам уникальные user_id
    // (не 'system-friday') — старый фильтр не находил НИЧЕГО, дайджест был пуст.
    // Источник истины «Новинок недели» — свежий published weekly_release.
    const { rows: tracks } = await client.query(
      `SELECT t.id, t.title, t.artist_name, t.genre, t.audio_url, t.cover_url
         FROM (SELECT track_ids, release_date
                 FROM weekly_releases
                WHERE is_published
                ORDER BY release_date DESC
                LIMIT 1) w
        CROSS JOIN LATERAL unnest(w.track_ids) WITH ORDINALITY AS u(tid, ord)
         JOIN tracks t ON t.id = u.tid
        WHERE w.release_date >= NOW() - ($1 || ' days')::interval
          AND t.moderation_status = 'published'
          AND t.radio_weekly_digest_sent_at IS NULL
        ORDER BY u.ord ASC
        LIMIT 100`,
      [String(WEEKLY_WINDOW_DAYS)]
    );

    // Промо-клипы, поставленные админом в очередь (videos-routes
    // /addToNewsletter). Ошибка (миграция 120 ещё не применена) не
    // роняет трек-дайджест — просто без видео-секции.
    let promoVideos: WeeklyVideo[] = [];
    try {
      const { rows } = await client.query(
        `SELECT v.id, v.title, v.thumbnail_url, v.video_url,
                COALESCE(NULLIF(u.full_name, ''), NULLIF(u.display_name, ''), 'Артист') AS artist_name
           FROM videos v
           LEFT JOIN users u ON u.id::text = v.user_id::text
          WHERE v.newsletter_requested_at IS NOT NULL
            AND v.newsletter_sent_at IS NULL
            AND COALESCE(v.is_hidden, false) = FALSE
          ORDER BY v.newsletter_requested_at ASC
          LIMIT 20`
      );
      promoVideos = rows;
    } catch (e: any) {
      console.warn('[radio-weekly] promo videos query skipped:', e?.message || e);
    }

    if (tracks.length === 0 && promoVideos.length === 0) {
      return c.json({ success: true, sent: 0, message: 'no pending friday tracks this week' });
    }

    // ?test=<email> — превью одному получателю, БЕЗ штампов курсоров/last_sent_at
    const testEmail = (c.req.query('test') || '').trim() || null;
    const recipients = testEmail
      ? [{ email: testEmail, name: 'ТЕСТ-превью', dlkey: makeRadioDownloadKey('t', TEST_RECIPIENT_ID) }]
      : await getWeeklyRecipients(client);
    if (recipients.length === 0) {
      return c.json({ success: true, sent: 0, message: 'no radio recipients' });
    }

    const dateLabel = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });
    const html = weeklyDigestHtml(tracks as WeeklyTrack[], dateLabel, promoVideos);
    const subjectParts = [
      tracks.length ? `${tracks.length} трек(ов)` : '',
      promoVideos.length ? `${promoVideos.length} клип(ов)` : '',
    ].filter(Boolean).join(' + ');
    const subject = `🎵 Новинки недели для эфира – ${subjectParts} · ${dateLabel}`;

    // Фоновая отправка: lock + client переходят во владение фоновой задачи.
    backgrounded = true;
    const finishInBackground = async () => {
      try {
        const result = await smtpSendBatch(
          recipients.map(r => ({ email: r.email, vars: { name: r.name, dlkey: r.dlkey } })),
          subject,
          html,
          { batchSize: 50, delayMs: 2000, replyTo: DIGEST_RECIPIENT }
        );

        if (result.sent === 0) {
          // тотальный сбой транспорта — НЕ помечаем треки, следующий прогон повторит
          console.error('[radio-weekly] transport failed for all recipients, tracks left in queue');
          return;
        }

        if (!testEmail && tracks.length > 0) {
          const ids = tracks.map((t: any) => t.id);
          await client.query(
            `UPDATE tracks SET radio_weekly_digest_sent_at = NOW() WHERE id = ANY($1::uuid[])`,
            [ids]
          );
        }

        if (!testEmail && promoVideos.length > 0) {
          // videos.id — uuid; сравниваем по ::text (id пришли SELECT'ом выше)
          await client.query(
            `UPDATE videos SET newsletter_sent_at = NOW() WHERE id::text = ANY($1::text[])`,
            [promoVideos.map((v: any) => String(v.id))]
          ).catch((e: any) => console.warn('[radio-weekly] video stamp failed:', e?.message || e));
        }

        // Единая база рассылки: last_sent_at ТОЛЬКО успешно доставленным.
        // errors из smtpSendBatch имеют вид "email: причина" — адрес до ':'.
        try {
          const failedEmails = new Set(
            (result.errors || []).map(e => String(e).split(':')[0].trim().toLowerCase())
          );
          const okEmails = recipients
            .map(r => r.email.toLowerCase())
            .filter(e => !failedEmails.has(e));
          if (!testEmail && okEmails.length > 0) {
            await client.query(
              `UPDATE radio_partner_contacts
                  SET last_sent_at = NOW(), send_count = send_count + 1
                WHERE LOWER(email) = ANY($1::text[])`,
              [okEmails]
            );
          }
        } catch (e: any) {
          console.warn('[radio-weekly] last_sent_at stamp skipped:', e?.message || e);
        }

        console.log(`[radio-weekly] completed: ${tracks.length} track(s) to ${result.sent}/${recipients.length} recipients (${result.failed} failed)`);
      } catch (err: any) {
        console.error('[radio-weekly] background send failed:', err?.message || err);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [WEEKLY_LOCK]).catch(() => {});
        client.release();
      }
    };
    finishInBackground();

    return c.json({
      success: true,
      started: true,
      tracks: tracks.length,
      recipients: recipients.length,
      message: `Отправка начата в фоне: ${recipients.length} получателей, ${tracks.length} трек(ов). Итог – в логе [radio-weekly].`,
    }, 202);
  } catch (err: any) {
    console.error('[radio-weekly] run failed:', err?.message || err);
    return c.json({ success: false, error: 'internal error' }, 500);
  } finally {
    if (!backgrounded) {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock($1)', [WEEKLY_LOCK]).catch(() => {});
      }
      client.release();
    }
  }
});

export default radioDigest;
