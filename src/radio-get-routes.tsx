/**
 * Скачивание треков станциями по личной ссылке из письма «Новинки недели»,
 * без входа в кабинет (01.10.2026). Монтируется на /server/api/radio-get.
 *
 * Почему: кнопка «Скачать» в письме вела на GET /tracks/:id/download, который
 * требует вход + is_verified профиля. За 14 дней ~15 живых станций нажали
 * кнопку, скачало 0. Владелец: «чтобы они могли качать».
 *
 *   GET  /:trackId?k=<ключ>          — страница трека: плеер, кнопка «Скачать»,
 *                                       анкета «для какой станции», остальные новинки недели;
 *   GET  /:trackId/file?k=..&go=1     — сам файл + запись в track_downloads_by_radio;
 *   POST /station   {k, station_name, city, format, stream_url} — анкета;
 *   POST /rotation  {k, track_id} — «Отметить, что трек в эфире» (отчёт станции о ротации).
 *
 * Ключ — radio-dl-token.tsx (HMAC получателя письма). Учёт выдач сохраняется:
 * скачивание пишется за конкретной станцией (аккаунт или партнёрский контакт).
 *
 * Почему промежуточная страница, а не сразу файл: Mail.ru проверяет все ссылки
 * письма в первые минуты после отправки (79.137.*). Прямая ссылка на файл дала бы
 * «скачивание» за каждую станцию с ящиком на mail.ru. На странице прямой ссылки
 * на файл нет: адрес собирает скрипт по нажатию кнопки, проверялки скрипты не
 * выполняют.
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { escapeHtml } from './email-helper.tsx';
import { parseRadioDownloadKey, type RadioRecipientKind } from './radio-dl-token.tsx';
import { sendTrackFile } from './track-file.tsx';

const app = new Hono();

const SITE_URL = 'https://promo-music.ru';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT_UA = /bot|crawl|spider|preview|scan|python|curl|wget|go-http|java|okhttp|headless/i;
const DEDUP_MINUTES = 30;

export const RADIO_FORMATS = [
  'Поп-музыка', 'Русская поп-музыка', 'Танцевальная', 'Рок', 'Альтернатива', 'Хип-хоп и R&B',
  'Шансон', 'Ретро', 'Джаз, лаунж, чилаут', 'Электронная', 'Кантри и фолк', 'Классика',
  'Разговорное радио с музыкой', 'Другое',
];

interface Recipient {
  kind: RadioRecipientKind;
  id: string;
  userId: string | null;
  partnerId: string | null;
  stationName: string;
  city: string;
  formats: string[];
  streamUrl: string;
  /** Название станции нам неизвестно (пусто или это просто имя почтового ящика). */
  nameUnknown: boolean;
}

function looksLikeMailbox(name: string, email: string | null): boolean {
  const n = String(name || '').trim();
  if (!n) return true;
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local && n.toLowerCase() === local) return true;
  return !/[a-zа-яё]/i.test(n);
}

async function resolveRecipient(key: unknown): Promise<Recipient | null> {
  const parsed = parseRadioDownloadKey(key);
  if (!parsed) return null;
  const { kind, id } = parsed;
  if (kind === 't') {
    return { kind, id, userId: null, partnerId: null, stationName: 'Тестовое письмо', city: '', formats: [], streamUrl: '', nameUnknown: false };
  }
  if (kind === 'u') {
    const r = await pool.query(
      `SELECT u.email, rp.station_name, rp.city, rp.formats, rp.stream_url,
              p.id AS partner_id, p.station_name AS p_station, p.city AS p_city
         FROM users u
         LEFT JOIN radio_profiles rp ON rp.user_id = u.id::text
         LEFT JOIN radio_partner_contacts p ON LOWER(p.email) = LOWER(u.email)
        WHERE u.id = $1 AND u.role = 'radio_station' AND u.deleted_at IS NULL
        LIMIT 1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return null;
    // Профили из базы питчинга названы именем почтового ящика («dvjholodok»);
    // у партнёрского контакта с той же почтой название обычно настоящее.
    const ownUnknown = looksLikeMailbox(row.station_name, row.email);
    const stationName = !ownUnknown ? row.station_name
      : (!looksLikeMailbox(row.p_station, row.email) ? row.p_station : '');
    return {
      kind, id, userId: id, partnerId: null,
      stationName: stationName || '',
      city: row.city || row.p_city || '',
      formats: Array.isArray(row.formats) ? row.formats : [],
      streamUrl: row.stream_url || '',
      nameUnknown: !stationName,
    };
  }
  const r = await pool.query(
    `SELECT email, station_name, city, formats, stream_url FROM radio_partner_contacts WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const unknown = looksLikeMailbox(row.station_name, row.email);
  return {
    kind, id, userId: null, partnerId: id,
    stationName: unknown ? '' : row.station_name,
    city: row.city || '',
    formats: Array.isArray(row.formats) ? row.formats : [],
    streamUrl: row.stream_url || '',
    nameUnknown: unknown,
  };
}

async function loadTrack(trackId: string) {
  if (!UUID_RE.test(trackId)) return null;
  const r = await pool.query(
    `SELECT id, title, artist_name, genre, audio_url, cover_url, duration, moderation_status, user_id
       FROM tracks WHERE id = $1 LIMIT 1`,
    [trackId],
  );
  const t = r.rows[0];
  if (!t || !t.audio_url) return null;
  if (t.moderation_status !== 'published' && t.moderation_status !== 'upcoming') return null;
  return t;
}

/** Остальные треки свежей подборки «Новинки недели» (как в письме). */
async function weeklyTracks(excludeId: string) {
  const r = await pool.query(
    `SELECT t.id, t.title, t.artist_name, t.genre, t.cover_url
       FROM (SELECT track_ids FROM weekly_releases WHERE is_published ORDER BY release_date DESC LIMIT 1) w
      CROSS JOIN LATERAL unnest(w.track_ids) WITH ORDINALITY AS u(tid, ord)
       JOIN tracks t ON t.id = u.tid
      WHERE t.moderation_status = 'published' AND t.audio_url IS NOT NULL AND t.id <> $1
      ORDER BY u.ord
      LIMIT 12`,
    [excludeId],
  ).catch(() => ({ rows: [] as any[] }));
  return r.rows;
}

function abs(path: string | null): string {
  if (!path) return '';
  return path.startsWith('http') ? path : `${SITE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const STYLE = `
 *{box-sizing:border-box}
 body{margin:0;background:#0a0a1a;color:#e6e6f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;padding:24px 16px}
 .wrap{max-width:560px;margin:0 auto}
 .brand{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#a5a5c0;margin:0 0 16px}
 .brand b{color:#fff}
 .card{background:#14142a;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:24px;margin-bottom:16px}
 .track{display:flex;gap:16px;align-items:center}
 .cover{width:96px;height:96px;border-radius:12px;object-fit:cover;flex:none;background:linear-gradient(135deg,#FF577F,#7C3AED)}
 h1{font-size:21px;line-height:1.25;margin:0 0 4px;color:#fff}
 .artist{color:#FF8FA8;font-size:16px;margin:0 0 8px}
 .meta{color:#8a8aa0;font-size:13px}
 audio{width:100%;margin:18px 0 6px}
 .btn{display:block;width:100%;padding:15px 20px;border:0;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none}
 .primary{background:linear-gradient(135deg,#FF577F,#7C3AED);color:#fff}
 .ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:#e6e6f0;font-weight:600;font-size:14px;padding:11px 16px}
 .note{font-size:13px;color:#a5a5c0;line-height:1.55;margin:12px 0 0}
 h2{font-size:17px;margin:0 0 6px;color:#fff}
 label{display:block;font-size:13px;color:#a5a5c0;margin:12px 0 4px}
 input,select{width:100%;padding:11px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:#0f0f22;color:#fff;font-size:15px}
 .row{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid rgba(255,255,255,.07)}
 .row:first-of-type{border-top:0}
 .row img,.row .ph{width:44px;height:44px;border-radius:8px;object-fit:cover;flex:none;background:linear-gradient(135deg,#7C3AED,#06B6D4)}
 .row .t{flex:1;min-width:0}
 .row .t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .row .a{color:#FF8FA8;font-size:13px}
 .row button{width:auto;flex:none;padding:9px 14px;font-size:13px}
 .ok{color:#6EE7B7}
 .muted{color:#8a8aa0;font-size:12px;text-align:center;margin-top:20px}
 .muted a{color:#FF8FA8;text-decoration:none}
 .hidden{display:none}
 .air{margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.08)}
 button:disabled{opacity:.6;cursor:default}
`;

function page(title: string, body: string, status = 200, c?: any) {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · ПРОМО.МУЗЫКА для эфира</title>
<style>${STYLE}</style></head><body><div class="wrap">
<p class="brand"><b>ПРОМО.МУЗЫКА</b> · новинки для эфира</p>
${body}
<p class="muted"><a href="${SITE_URL}/new-releases">Все новинки недели</a> · <a href="${SITE_URL}">promo-music.ru</a></p>
</div></body></html>`;
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  return c.html(html, status);
}

function messagePage(c: any, status: number, title: string, text: string) {
  return page(title, `<div class="card"><h1>${escapeHtml(title)}</h1><p class="note">${text}</p>
<p style="margin:18px 0 0"><a class="btn ghost" href="${SITE_URL}/login">Войти в кабинет станции</a></p></div>`, status, c);
}

function stationForm(rcp: Recipient): string {
  const needsName = rcp.nameUnknown;
  const opts = RADIO_FORMATS.map(f =>
    `<option value="${escapeHtml(f)}"${rcp.formats[0] === f ? ' selected' : ''}>${escapeHtml(f)}</option>`).join('');
  const known = !needsName
    ? `<p class="note" style="margin-top:0">Скачивание учитывается за станцией <b style="color:#fff">«${escapeHtml(rcp.stationName)}»</b>${rcp.city ? `, ${escapeHtml(rcp.city)}` : ''}. Артист увидит, что ваша станция скачала его трек.</p>`
    : `<p class="note" style="margin-top:0">Подскажите один раз, для какой станции вы забираете треки. Артист увидит, какая станция скачала его трек, а мы будем присылать новинки под ваш формат. Заполнять не обязательно, скачивание работает и так.</p>`;
  const missingSomething = needsName || !rcp.city || rcp.formats.length === 0 || !rcp.streamUrl;
  return `<div class="card">
 <h2>${needsName ? 'Для какой станции скачиваете?' : 'Ваша станция'}</h2>
 ${known}
 <button type="button" class="btn ghost${needsName || missingSomething ? ' hidden' : ''}" id="editStation">Изменить данные станции</button>
 <form id="stationForm" class="${needsName || missingSomething ? '' : 'hidden'}">
  <label for="sn">Название станции</label>
  <input id="sn" name="station_name" maxlength="120" value="${escapeHtml(rcp.stationName)}" placeholder="Например, Радио Геленджик 95.7 FM">
  <label for="sc">Город вещания</label>
  <input id="sc" name="city" maxlength="80" value="${escapeHtml(rcp.city)}" placeholder="Например, Геленджик">
  <label for="sf">Формат</label>
  <select id="sf" name="format"><option value="">– выберите –</option>${opts}</select>
  <label for="ss">Ссылка на онлайн-эфир, если есть</label>
  <input id="ss" name="stream_url" maxlength="500" value="${escapeHtml(rcp.streamUrl)}" placeholder="https://…">
  <p class="note">По ссылке на эфир мы сможем подтверждать, что трек прозвучал у вас, и показывать вашу станцию на странице трека и на карте эфиров ПРОМО.МУЗЫКИ.</p>
  <button type="submit" class="btn ghost" style="margin-top:14px">Сохранить</button>
  <p class="note hidden ok" id="saved">Спасибо, сохранили.</p>
 </form>
</div>`;
}

// ── GET /:trackId — страница трека ──────────────────────────────────────────
app.get('/:trackId', async (c) => {
  try {
    const key = c.req.query('k') || '';
    const rcp = await resolveRecipient(key);
    if (!rcp) {
      return messagePage(c, 403, 'Ссылка не подходит',
        'Похоже, ссылка из письма повреждена или переслана не полностью. Откройте её из письма ещё раз или войдите в кабинет станции. Слушать новинки можно и без входа.');
    }
    const t = await loadTrack(c.req.param('trackId'));
    if (!t) return messagePage(c, 404, 'Трек недоступен', 'Этот трек сейчас нельзя скачать: он снят с публикации или ещё не вышел.');
    const others = await weeklyTracks(t.id);
    const cover = abs(t.cover_url);
    const dur = fmtDuration(t.duration);
    const otherRows = others.map((o: any) => {
      const oc = abs(o.cover_url);
      return `<div class="row">${oc ? `<img src="${escapeHtml(oc)}" alt="">` : '<div class="ph"></div>'}
  <div class="t"><div>${escapeHtml(o.title || 'Без названия')}</div><div class="a">${escapeHtml(o.artist_name || '')}</div></div>
  <button type="button" class="btn ghost" data-dl="${escapeHtml(o.id)}">Скачать</button></div>`;
    }).join('');
    const body = `
<div class="card">
 <div class="track">
  ${cover ? `<img class="cover" src="${escapeHtml(cover)}" alt="">` : '<div class="cover"></div>'}
  <div><h1>${escapeHtml(t.title || 'Без названия')}</h1>
   <p class="artist">${escapeHtml(t.artist_name || '')}</p>
   <div class="meta">${[t.genre, dur].filter(Boolean).map((x: string) => escapeHtml(String(x))).join(' · ')}</div></div>
 </div>
 <audio controls preload="none" src="${escapeHtml(abs(t.audio_url))}"></audio>
 <button type="button" class="btn primary" data-dl="${escapeHtml(t.id)}">&#8681; Скачать трек</button>
 <p class="note">Файл придёт с названием «${escapeHtml(t.artist_name || 'Артист')} - ${escapeHtml(t.title || 'Трек')}». Трек можно брать в эфир: артист разместил его на ПРОМО.МУЗЫКЕ для ротации на радио.</p>
 <div class="air">
  <button type="button" class="btn ghost" id="markAir" data-track="${escapeHtml(t.id)}">&#127908; Отметить, что трек в эфире</button>
  <p class="note" id="airHint">Нажмите, если трек уже звучит на вашей станции. Артист увидит отметку в своём кабинете.</p>
 </div>
</div>
${stationForm(rcp)}
${otherRows ? `<div class="card"><h2>Ещё в подборке этой недели</h2>${otherRows}</div>` : ''}
<script>
(function(){
 var K=${JSON.stringify(key)};
 var NEED_NAME=${rcp.nameUnknown ? 'true' : 'false'};
 document.querySelectorAll('[data-dl]').forEach(function(b){
  b.addEventListener('click',function(){
   location.href='/server/api/radio-get/'+b.getAttribute('data-dl')+'/file?k='+encodeURIComponent(K)+'&go=1';
  });
 });
 var e=document.getElementById('editStation'), f=document.getElementById('stationForm');
 if(e){e.addEventListener('click',function(){f.classList.remove('hidden');e.classList.add('hidden');});}
 if(f){f.addEventListener('submit',function(ev){
  ev.preventDefault();
  var d={k:K};
  ['station_name','city','format','stream_url'].forEach(function(n){d[n]=f.elements[n].value;});
  fetch('/server/api/radio-get/station',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})
   .then(function(r){return r.json();})
   .then(function(j){var s=document.getElementById('saved');s.textContent=j.success?'Спасибо, сохранили.':(j.error||'Не получилось сохранить');s.classList.remove('hidden');
    if(j.success&&f.elements['station_name'].value.trim()){NEED_NAME=false;}})
   .catch(function(){var s=document.getElementById('saved');s.textContent='Не получилось сохранить';s.classList.remove('hidden');});
 });}
 var m=document.getElementById('markAir'), h=document.getElementById('airHint');
 if(m){m.addEventListener('click',function(){
  if(NEED_NAME){
   if(f){f.classList.remove('hidden');if(e){e.classList.add('hidden');}f.elements['station_name'].focus();}
   h.textContent='Сначала укажите ниже название станции и нажмите «Сохранить», потом отметьте эфир.';
   return;
  }
  m.disabled=true;
  fetch('/server/api/radio-get/rotation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k:K,track_id:m.getAttribute('data-track')})})
   .then(function(r){return r.json();})
   .then(function(j){h.textContent=j.message||j.error||'Готово';if(!j.success){m.disabled=false;}})
   .catch(function(){h.textContent='Не получилось отправить, попробуйте ещё раз';m.disabled=false;});
 });}
})();
</script>`;
    return page(`${t.artist_name || ''} – ${t.title || ''}`, body, 200, c);
  } catch (err: any) {
    console.error('[radio-get] page failed:', err?.message || err);
    return messagePage(c, 500, 'Что-то пошло не так', 'Попробуйте открыть ссылку ещё раз через минуту.');
  }
});

// ── GET /:trackId/file — сам файл + учёт выдачи ─────────────────────────────
app.get('/:trackId/file', async (c) => {
  const trackId = c.req.param('trackId');
  const key = c.req.query('k') || '';
  // Без go=1 (его добавляет скрипт по нажатию) — на страницу трека: так
  // проверялки ссылок не «скачивают» за станцию.
  if (c.req.query('go') !== '1') {
    return c.redirect(`/server/api/radio-get/${encodeURIComponent(trackId)}?k=${encodeURIComponent(key)}`, 302);
  }
  try {
    const rcp = await resolveRecipient(key);
    if (!rcp) {
      return messagePage(c, 403, 'Ссылка не подходит',
        'Откройте ссылку из письма ещё раз или войдите в кабинет станции.');
    }
    const t = await loadTrack(trackId);
    if (!t) return messagePage(c, 404, 'Трек недоступен', 'Этот трек сейчас нельзя скачать.');

    const ua = c.req.header('user-agent') || '';
    const ip = (c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '').split(',')[0].trim();
    if (rcp.kind !== 't' && !BOT_UA.test(ua)) {
      const dup = await pool.query(
        `SELECT 1 FROM track_downloads_by_radio
          WHERE track_id = $1
            AND (($2::uuid IS NOT NULL AND user_id = $2::uuid) OR ($3::uuid IS NOT NULL AND partner_contact_id = $3::uuid))
            AND downloaded_at > NOW() - ($4 || ' minutes')::interval
          LIMIT 1`,
        [t.id, rcp.userId, rcp.partnerId, String(DEDUP_MINUTES)],
      );
      if (!dup.rows.length) {
        await pool.query(
          `INSERT INTO track_downloads_by_radio
             (user_id, partner_contact_id, station_name, track_id, city, weekly_release_id, ip_addr, user_agent, via)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, 'email_link')`,
          [rcp.userId, rcp.partnerId, rcp.stationName || null, t.id, rcp.city || null, ip, ua.slice(0, 500)],
        );
      }
    }
    console.log(`[radio-get] ${rcp.kind}:${rcp.id} station="${rcp.stationName || '?'}" track=${t.id}`);

    const sent = await sendTrackFile(c, t);
    if (sent) return sent;
    return c.redirect(abs(t.audio_url), 302);
  } catch (err: any) {
    console.error('[radio-get] file failed:', err?.message || err);
    return messagePage(c, 500, 'Не получилось отдать файл', 'Попробуйте ещё раз через минуту.');
  }
});

// ── POST /station — анкета «для какой станции скачиваете» ───────────────────
app.post('/station', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const rcp = await resolveRecipient(body?.k);
    if (!rcp) return c.json({ success: false, error: 'Ссылка не подходит' }, 403);
    if (rcp.kind === 't') return c.json({ success: true, test: true });

    const clean = (v: unknown, max: number) =>
      String(v ?? '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
    const name = clean(body?.station_name, 120);
    const city = clean(body?.city, 80);
    const format = clean(body?.format, 60);
    let stream = clean(body?.stream_url, 500);
    if (stream && !/^https?:\/\/[^\s]+$/i.test(stream)) {
      return c.json({ success: false, error: 'Ссылка на эфир должна начинаться с http:// или https://' }, 400);
    }
    if (format && !RADIO_FORMATS.includes(format)) {
      return c.json({ success: false, error: 'Неизвестный формат' }, 400);
    }
    const formats = format ? [format] : null;

    if (rcp.kind === 'u') {
      const r = await pool.query(
        `UPDATE radio_profiles
            SET station_name = COALESCE(NULLIF($2, ''), station_name),
                city         = COALESCE(NULLIF($3, ''), city),
                formats      = COALESCE($4::text[], formats),
                stream_url   = COALESCE(NULLIF($5, ''), stream_url),
                data         = COALESCE(data, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
                                 'stationName', NULLIF($2, ''), 'city', NULLIF($3, ''), 'streamUrl', NULLIF($5, ''))),
                details_updated_at = NOW(),
                updated_at   = NOW()
          WHERE user_id = $1`,
        [rcp.id, name, city, formats, stream],
      );
      if (!r.rowCount) return c.json({ success: false, error: 'Профиль станции не найден' }, 404);
    } else {
      await pool.query(
        `UPDATE radio_partner_contacts
            SET station_name = COALESCE(NULLIF($2, ''), station_name),
                city         = COALESCE(NULLIF($3, ''), city),
                formats      = COALESCE($4::text[], formats),
                stream_url   = COALESCE(NULLIF($5, ''), stream_url),
                details_updated_at = NOW()
          WHERE id = $1`,
        [rcp.id, name, city, formats, stream],
      );
    }
    console.log(`[radio-get] station details ${rcp.kind}:${rcp.id} name="${name}" city="${city}" format="${format}" stream=${stream ? 'yes' : 'no'}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error('[radio-get] station save failed:', err?.message || err);
    return c.json({ success: false, error: 'Не получилось сохранить' }, 500);
  }
});

// ── POST /rotation — «Отметить, что трек в эфире» ───────────────────────────
//
// Отчёт станции о ротации — те же правила, что у кабинета (radio-routes.tsx
// POST /rotations/report): source='radio_self_report'; станция скачивала трек →
// confirmed (виден артисту сразу), не скачивала → pending (модерация).
// Отличия:
//   - работает по личному ключу из письма, в т.ч. для партнёрского контакта
//     без аккаунта (submitted_by_partner_contact_id);
//   - не чаще раза в 20 ч на трек+станцию: повторное нажатие не накручивает
//     rotation_count (условие в ON CONFLICT … WHERE, атомарно — двойной клик тоже);
//   - строка-декор source='auto' не делает отчёт подтверждённым и не даёт
//     ему свой rotation_count.
// В публичных текстах это «заявлено станцией», не «звучит»: эфир подтверждает
// только PROMO.CHECK (promo_check_detections).
app.post('/rotation', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const rcp = await resolveRecipient(body?.k);
    if (!rcp) return c.json({ success: false, error: 'Ссылка не подходит' }, 403);
    const t = await loadTrack(String(body?.track_id || ''));
    if (!t) return c.json({ success: false, error: 'Трек недоступен' }, 404);
    if (rcp.kind === 't') {
      return c.json({ success: true, test: true, message: 'Тестовое письмо: отметка не сохраняется.' });
    }
    if (rcp.nameUnknown || !rcp.stationName) {
      return c.json({ success: false, code: 'station_required', error: 'Сначала укажите название станции' }, 400);
    }

    // Раз в сутки на трек от этого получателя письма — даже если он переименовал
    // станцию в анкете (тогда ON CONFLICT попал бы в новую строку).
    const recent = await pool.query(
      `SELECT 1 FROM track_radio_pickups
        WHERE track_id = $1 AND submitted_via = 'email_link'
          AND (($2::uuid IS NOT NULL AND submitted_by_user_id = $2::uuid)
               OR ($3::uuid IS NOT NULL AND submitted_by_partner_contact_id = $3::uuid))
          AND aired_at > NOW() - INTERVAL '20 hours'
        LIMIT 1`,
      [t.id, rcp.userId, rcp.partnerId],
    );
    if (recent.rows.length) {
      return c.json({ success: true, already: true, message: 'Сегодня вы уже отмечали этот трек. Спасибо!' });
    }

    const dl = await pool.query(
      `SELECT 1 FROM track_downloads_by_radio
        WHERE track_id = $1
          AND (($2::uuid IS NOT NULL AND user_id = $2::uuid) OR ($3::uuid IS NOT NULL AND partner_contact_id = $3::uuid))
        LIMIT 1`,
      [t.id, rcp.userId, rcp.partnerId],
    );
    const status = dl.rows.length ? 'confirmed' : 'pending';
    const stationName = rcp.stationName.slice(0, 255);
    const city = rcp.city ? rcp.city.slice(0, 255) : null;

    const r = await pool.query(
      `INSERT INTO track_radio_pickups
         (track_id, station_name, city, country, picked_up_at, source, rotation_count, aired_at,
          report_status, submitted_by_user_id, submitted_by_partner_contact_id, submitted_via)
       VALUES ($1, $2, $3, NULL, NOW(), 'radio_self_report', 1, NOW(), $4, $5, $6, 'email_link')
       ON CONFLICT (track_id, station_name, city) DO UPDATE SET
         rotation_count = CASE WHEN track_radio_pickups.source = 'auto' THEN 1
                               ELSE COALESCE(track_radio_pickups.rotation_count, 0) + 1 END,
         aired_at = NOW(),
         report_status = CASE
           WHEN track_radio_pickups.source <> 'auto' AND track_radio_pickups.report_status = 'confirmed' THEN 'confirmed'
           ELSE EXCLUDED.report_status END,
         source = 'radio_self_report',
         submitted_by_user_id = COALESCE(EXCLUDED.submitted_by_user_id, track_radio_pickups.submitted_by_user_id),
         submitted_by_partner_contact_id = COALESCE(EXCLUDED.submitted_by_partner_contact_id, track_radio_pickups.submitted_by_partner_contact_id),
         submitted_via = 'email_link'
       WHERE track_radio_pickups.aired_at IS NULL OR track_radio_pickups.aired_at < NOW() - INTERVAL '20 hours'
       RETURNING report_status`,
      [t.id, stationName, city, status, rcp.userId, rcp.partnerId],
    );
    if (!r.rows.length) {
      return c.json({ success: true, already: true, message: 'Сегодня вы уже отмечали этот трек. Спасибо!' });
    }
    const finalStatus = r.rows[0].report_status as string;
    console.log(`[radio-get] rotation ${rcp.kind}:${rcp.id} station="${stationName}" track=${t.id} status=${finalStatus}`);

    if (finalStatus === 'confirmed' && t.user_id) {
      try {
        const { emitSSE } = await import('./sse-routes.tsx');
        emitSSE(String(t.user_id), {
          type: 'radio_rotation_confirmed',
          data: {
            title: 'Станция отметила ваш трек в эфире',
            message: `«${t.title}»: ${stationName}${city ? ', ' + city : ''}`,
            trackId: t.id,
            link: '/artist',
          },
        });
      } catch { /* уведомление best-effort */ }
    }

    return c.json({
      success: true,
      status: finalStatus,
      message: finalStatus === 'confirmed'
        ? `Спасибо! Отметили: трек в эфире у «${stationName}». Артист увидит это в своём кабинете.`
        : 'Спасибо! Отметку проверит модератор, после этого её увидит артист. Скачайте трек кнопкой выше: тогда следующие отметки засчитываются сразу.',
    });
  } catch (err: any) {
    console.error('[radio-get] rotation failed:', err?.message || err);
    return c.json({ success: false, error: 'Не получилось сохранить отметку' }, 500);
  }
});

export default app;
