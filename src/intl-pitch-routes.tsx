/**
 * МЕЖДУНАРОДНЫЙ ПИТЧИНГ (бета, 14.10.2026) — бесплатный бонус к оплаченному размещению трека.
 *
 * Владелец: «представить новую услугу на сайте как тестовый бонус к обычному размещению».
 * База — intl_radio_contacts (таблица v33: 950 адресов, 94 страны, миграция 159).
 * Решения владельца: вся база по жанру, бессрочно на время беты, письма готовит сайт,
 * отправку подтверждает админ.
 *
 * Как устроено:
 *  - артист с оплаченным треком ставит галочку согласия → intl_pitch_requests (queued);
 *  - админ собирает подборку из заявок (intl_digests: draft), смотрит письмо RU/EN,
 *    шлёт тест себе и утверждает → по одной строке intl_digest_sends на станцию;
 *  - одна станция получает ОДНО письмо на подборку со всеми треками под её формат
 *    (не письмо на каждый трек — иначе жалобы на спам и блок ящика noreply@,
 *    через который идёт вся почта сайта);
 *  - крон дёргает POST /tick: не больше INTL_DAILY_CAP писем за 24 часа (по умолчанию 300);
 *  - ссылка в письме личная (ключ i.<contact>.<hmac>): скачивание пишется в
 *    track_downloads_by_radio с intl_contact_id — артист видит станцию и страну
 *    в кабинете, а главная — «Скачали».
 *
 * Тексты писем станциям — только после утверждения владельцем (правило: внешние
 * сообщения не уходят без его «да»); до этого шлём лишь тесты на info@promofm.ru.
 */
import { Hono } from 'hono';
import crypto from 'crypto';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { escapeHtml, unsubscribeLink, notifyAdminTelegram } from './email-helper.tsx';
import { smtpSendEmail } from './smtp-sender.tsx';
import { sendTrackFile } from './track-file.tsx';

const app = new Hono();

const SITE_URL = 'https://promo-music.ru';
const API_URL = `${SITE_URL}/server/api/intl-pitch`;
const DAILY_CAP = Number(process.env.INTL_DAILY_CAP || 300);
const TICK_MAX = Number(process.env.INTL_TICK_MAX || 25);
const TICK_GAP_MS = Number(process.env.INTL_TICK_GAP_MS || 4000);
const REPLY_TO = 'info@promofm.ru';
const TEST_EMAIL = 'info@promofm.ru';
const INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';
const TEST_CONTACT = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT_UA = /bot|crawl|spider|preview|scan|python|curl|wget|go-http|java|okhttp|headless/i;
const DEDUP_MINUTES = 30;
const TICK_LOCK = 915014;  // pg_advisory_lock: одна отправка за раз

// ── жанры ─────────────────────────────────────────────────────────────────────
export const GENRE_GROUPS: Record<string, { ru: string; en: string }> = {
  pop: { ru: 'Поп', en: 'Pop' },
  dance: { ru: 'Танцевальная / электронная', en: 'Dance / Electronic' },
  hiphop: { ru: 'Хип-хоп / R&B', en: 'Hip-hop / R&B' },
  rock: { ru: 'Рок / альтернатива', en: 'Rock / Alternative' },
  jazz: { ru: 'Джаз / соул / лаунж', en: 'Jazz / Soul / Lounge' },
  classical: { ru: 'Классика / инструментальная', en: 'Classical / Instrumental' },
  world: { ru: 'Музыка мира / фолк', en: 'World / Folk' },
  reggae: { ru: 'Регги', en: 'Reggae' },
  chanson: { ru: 'Шансон', en: 'Chanson' },
  kids: { ru: 'Детская', en: 'Kids' },
};

/** Свободный текст жанра трека → группа станций. */
export function genreGroup(genre: string | null | undefined): string {
  const s = String(genre || '').toLowerCase();
  if (/kids|детск/.test(s)) return 'kids';
  if (/hip.?hop|\brap\b|trap|r&b|rnb|хип|рэп/.test(s)) return 'hiphop';
  if (/rock|metal|punk|grunge|alternative|рок|альтернатив/.test(s)) return 'rock';
  if (/reggae|dancehall|регги/.test(s)) return 'reggae';
  if (/jazz|blues|soul|lounge|джаз|блюз|соул/.test(s)) return 'jazz';
  if (/classical|instrumental|piano|классик/.test(s)) return 'classical';
  if (/chanson|шансон/.test(s)) return 'chanson';
  if (/electro|dance|house|edm|techno|trance|dubstep|drum|dnb|танц|электрон/.test(s)) return 'dance';
  if (/world|folk|ethno|фолк|этно/.test(s)) return 'world';
  return 'pop';
}

/** Берёт ли станция трек: общие станции — любой трек (кроме детского), нишевые — только свой жанр. */
function accepts(formats: string[], group: string): boolean {
  const f = formats || [];
  if (f.includes('kids')) return group === 'kids';
  if (group === 'kids') return false;
  if (f.length === 0) return true;
  return f.includes(group);
}

// ── личные ссылки станций ─────────────────────────────────────────────────────
const SECRET = process.env.EMAIL_TRACK_SECRET || process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || '';
function sig(id: string): string {
  return crypto.createHmac('sha256', SECRET).update(`intl-dl|${id.toLowerCase()}`).digest('hex').slice(0, 32);
}
export function intlKey(contactId: string): string {
  return `i.${contactId.toLowerCase()}.${sig(contactId)}`;
}
function parseKey(key: unknown): string | null {
  if (typeof key !== 'string' || key.length > 120) return null;
  const [kind, id, s] = key.split('.');
  if (kind !== 'i' || !id || !s || !UUID_RE.test(id) || !/^[0-9a-f]{32}$/i.test(s)) return null;
  const a = Buffer.from(sig(id), 'hex'), b = Buffer.from(s.toLowerCase(), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id.toLowerCase() : null;
}

// ── общие запросы ─────────────────────────────────────────────────────────────
const RECEIVING_SQL = `c.active AND NOT c.excluded AND NOT c.in_ru_base
  AND c.unsubscribed_at IS NULL AND c.bounced_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM email_unsubscribes u WHERE u.email = lower(c.email))`;
const PAID_SQL = `(COALESCE(t.payment_completed, false) OR COALESCE(t.is_paid, false))`;

type Contact = { id: string; email: string; lang: string; formats: string[]; station_name: string; country: string; city: string | null };
type Track = { id: string; title: string; artist_name: string; genre: string | null; cover_url: string | null; duration: number | null; audio_url?: string | null };

async function receivingContacts(): Promise<Contact[]> {
  const r = await pool.query(`SELECT c.id::text, c.email, c.lang, c.formats, c.station_name, c.country, c.city
                                FROM intl_radio_contacts c WHERE ${RECEIVING_SQL}`);
  return r.rows;
}

let _stats: { at: number; data: any } | null = null;
async function baseStats() {
  if (_stats && Date.now() - _stats.at < 10 * 60 * 1000) return _stats.data;
  const r = await pool.query(`
    SELECT count(*)::int AS contacts,
           count(DISTINCT country)::int AS countries,
           count(*) FILTER (WHERE ${RECEIVING_SQL})::int AS receiving,
           count(*) FILTER (WHERE segment = 'ru')::int AS ru,
           count(*) FILTER (WHERE segment = 'cis')::int AS cis,
           count(*) FILTER (WHERE segment = 'world_ru')::int AS world_ru,
           count(*) FILTER (WHERE segment = 'world')::int AS world,
           count(DISTINCT country) FILTER (WHERE segment IN ('world', 'world_ru'))::int AS world_countries
      FROM intl_radio_contacts c`);
  _stats = { at: Date.now(), data: r.rows[0] };
  return r.rows[0];
}

function abs(path: string | null | undefined): string {
  if (!path) return '';
  return path.startsWith('http') ? path : `${SITE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}
function fmtDur(sec: number | null): string {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h',
};
/** Латиница для зарубежных станций: «Пока мы отдыхаем» → «Poka my otdykhaem». */
export function translit(s: string): string {
  return String(s || '').split('').map((ch) => {
    const lo = ch.toLowerCase();
    const t = TRANSLIT[lo];
    if (t === undefined) return ch;
    return ch === lo ? t : (t.charAt(0).toUpperCase() + t.slice(1));
  }).join('');
}
const HAS_CYR = /[а-яёіїєґәғқңөұүһ]/i;

function trackCount(n: number, lang: string): string {
  if (lang === 'en') return `${n} track${n === 1 ? '' : 's'}`;
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'трек' : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) ? 'трека' : 'треков';
  return `${n} ${w}`;
}

// ── письмо станции ────────────────────────────────────────────────────────────
export function digestEmail(contact: { email: string; lang: string; id: string }, tracks: Track[], groups: Record<string, string>) {
  const en = contact.lang === 'en';
  const key = intlKey(contact.id);
  const brand = en ? 'Promo.Music' : 'ПРОМО.МУЗЫКА';
  const subject = en
    ? `New music for your airplay: ${trackCount(tracks.length, 'en')} from Russia & CIS · Promo.Music`
    : `Новинки для эфира: ${trackCount(tracks.length, 'ru')} · ПРОМО.МУЗЫКА`;
  const intro = en
    ? `Hello! We are Promo.Music, a platform where independent artists from Russia and the CIS release their music for radio. Here are this week's new releases picked for your format. Every artist has cleared their track for airplay: you can listen and download it in one click, no sign-up needed.`
    : `Здравствуйте! Мы — ПРОМО.МУЗЫКА, платформа, где независимые артисты выпускают музыку для радио. Ниже — новинки этой недели под ваш формат. Каждый артист разрешил ставить свой трек в эфир: послушать и скачать можно в один клик, без регистрации.`;
  const rows = tracks.map((t) => {
    const url = `${API_URL}/get/${t.id}?k=${encodeURIComponent(key)}`;
    const cover = abs(t.cover_url);
    const g = GENRE_GROUPS[groups[t.id] || 'pop'];
    const meta = [t.genre || (g ? (en ? g.en : g.ru) : ''), fmtDur(t.duration)].filter(Boolean).map((x) => escapeHtml(String(x))).join(' · ');
    return `<tr><td style="padding:14px 0;border-top:1px solid #2a2a3e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="88" valign="top">${cover ? `<img src="${escapeHtml(cover)}" width="76" height="76" alt="" style="display:block;border-radius:10px;object-fit:cover">` : `<div style="width:76px;height:76px;border-radius:10px;background:#FF577F"></div>`}</td>
<td valign="top" style="font-family:Arial,sans-serif">
<div style="font-size:17px;font-weight:700;color:#ffffff">${escapeHtml(t.title || (en ? 'Untitled' : 'Без названия'))}</div>
<div style="font-size:15px;color:#FF8FA8;margin:2px 0 4px">${escapeHtml(t.artist_name || '')}</div>
${en && HAS_CYR.test(`${t.title} ${t.artist_name}`) ? `<div style="font-size:12px;color:#b9b9cc;margin:0 0 4px">${escapeHtml(translit(t.title || ''))} — ${escapeHtml(translit(t.artist_name || ''))}</div>` : ''}
<div style="font-size:13px;color:#9a9ab0;margin-bottom:10px">${meta}</div>
<a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:linear-gradient(135deg,#FF577F,#7C3AED);background-color:#FF577F;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700">${en ? 'Listen &amp; download' : 'Слушать и скачать'}</a>
</td></tr></table></td></tr>`;
  }).join('');
  const footer = en
    ? `You are receiving this because your station publishes this address for music submissions. We send at most one selection a week. <a href="${escapeHtml(unsubscribeLink(contact.email))}" style="color:#FF8FA8">Unsubscribe</a> — one click. Questions or feedback: just reply to this email.<br>Promo.Music (OOO «Promo FM», Russia) · <a href="${SITE_URL}" style="color:#FF8FA8">promo-music.ru</a>`
    : `Вы получили это письмо, потому что станция публикует этот адрес для присылки музыки. Мы присылаем не больше одной подборки в неделю. <a href="${escapeHtml(unsubscribeLink(contact.email))}" style="color:#FF8FA8">Отписаться</a> — в один клик. Вопросы и обратная связь — просто ответьте на это письмо.<br>ПРОМО.МУЗЫКА (ООО «Промо Фм») · <a href="${SITE_URL}" style="color:#FF8FA8">promo-music.ru</a>`;
  const html = `<!DOCTYPE html><html lang="${en ? 'en' : 'ru'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a1a;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#14142a;border-radius:16px;overflow:hidden">
<tr><td style="padding:26px 30px;background:linear-gradient(135deg,#FF577F,#7C3AED);background-color:#FF577F;font-family:Arial,sans-serif">
<div style="font-size:22px;font-weight:800;color:#ffffff">${brand}</div>
<div style="font-size:14px;color:#ffe3ea;margin-top:4px">${en ? 'New releases for radio' : 'Новинки для эфира'}</div></td></tr>
<tr><td style="padding:24px 30px 6px;font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#dcdcea">${intro}</td></tr>
<tr><td style="padding:6px 30px 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
<tr><td style="padding:16px 30px 26px;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#8a8aa0;border-top:1px solid #2a2a3e">${footer}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, from: en ? '"Promo.Music" <noreply@promo-music.ru>' : '"ПРОМО.МУЗЫКА" <noreply@promo-music.ru>' };
}

async function loadTracks(ids: string[]): Promise<Track[]> {
  if (!ids.length) return [];
  const r = await pool.query(
    `SELECT id::text, title, artist_name, genre, cover_url, duration FROM tracks WHERE id = ANY($1::uuid[])`, [ids]);
  const by = new Map(r.rows.map((x: any) => [x.id, x]));
  return ids.map((i) => by.get(i)).filter(Boolean) as Track[];
}

// ── публично: цифры базы для страницы услуги ──────────────────────────────────
app.get('/public/stats', async (c) => {
  try {
    const s = await baseStats();
    c.header('Cache-Control', 'public, max-age=600');
    return c.json({ success: true, data: s });
  } catch (e: any) {
    return c.json({ success: false, error: 'stats failed' }, 500);
  }
});

// ── кабинет артиста ───────────────────────────────────────────────────────────
app.get('/my', requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId'));
    const [tr, stats, contacts] = await Promise.all([
      pool.query(
        `SELECT t.id::text, t.title, t.artist_name, t.genre, t.cover_url, t.moderation_status, t.created_at,
                ${PAID_SQL} AS paid, r.id::text AS request_id, r.status, r.created_at AS requested_at, r.genre_group,
                d.approved_at, d.finished_at
           FROM tracks t
           LEFT JOIN intl_pitch_requests r ON r.track_id = t.id
           LEFT JOIN intl_digests d ON d.id = r.digest_id
          WHERE t.user_id = $1 AND NOT COALESCE(t.is_legacy, false)
            AND COALESCE(t.moderation_status, '') NOT IN ('rejected', 'deleted')
          ORDER BY t.created_at DESC LIMIT 100`, [userId]),
      baseStats(),
      receivingContacts(),
    ]);
    const ids = tr.rows.map((t: any) => t.id);
    const [sent, dl] = ids.length ? await Promise.all([
      pool.query(
        `SELECT tid::text AS track_id, count(*)::int AS stations, count(DISTINCT c.country)::int AS countries, max(s.sent_at) AS last_sent
           FROM intl_digest_sends s JOIN intl_radio_contacts c ON c.id = s.contact_id
           CROSS JOIN LATERAL unnest(s.track_ids) AS tid
          WHERE s.status = 'sent' AND tid = ANY($1::uuid[]) GROUP BY tid`, [ids]),
      pool.query(
        `SELECT d.track_id::text, d.station_name, c.country, max(d.downloaded_at) AS at
           FROM track_downloads_by_radio d JOIN intl_radio_contacts c ON c.id = d.intl_contact_id
          WHERE d.track_id = ANY($1::uuid[]) GROUP BY 1, 2, 3 ORDER BY at DESC`, [ids]),
    ]) : [{ rows: [] }, { rows: [] }] as any;
    const sentBy = new Map(sent.rows.map((x: any) => [x.track_id, x]));
    const dlBy = new Map<string, any[]>();
    for (const x of dl.rows) { if (!dlBy.has(x.track_id)) dlBy.set(x.track_id, []); dlBy.get(x.track_id)!.push(x); }
    const tracks = tr.rows.map((t: any) => {
      const g = t.genre_group || genreGroup(t.genre);
      const s: any = sentBy.get(t.id);
      const eligible = t.paid && ['published', 'upcoming', 'approved'].includes(t.moderation_status);
      return {
        id: t.id, title: t.title, artist: t.artist_name, genre: t.genre, cover: t.cover_url,
        paid: !!t.paid, eligible, status: t.status || null, requestedAt: t.requested_at,
        genreGroup: g, genreLabel: GENRE_GROUPS[g]?.ru || 'Поп',
        matchStations: contacts.filter((ct) => accepts(ct.formats, g)).length,
        sentStations: s?.stations || 0, sentCountries: s?.countries || 0, sentAt: s?.last_sent || null,
        downloads: (dlBy.get(t.id) || []).map((d) => ({ station: d.station_name, country: d.country, at: d.at })),
      };
    });
    return c.json({ success: true, data: { stats, tracks } });
  } catch (e: any) {
    console.error('[intl-pitch] my:', e?.message);
    return c.json({ success: false, error: 'Не удалось загрузить данные' }, 500);
  }
});

app.post('/my/:trackId/request', requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId'));
    const trackId = c.req.param('trackId');
    if (!UUID_RE.test(trackId)) return c.json({ success: false, error: 'Неверный трек' }, 400);
    const body = await c.req.json().catch(() => ({} as any));
    if (body?.consent !== true) {
      return c.json({ success: false, error: 'Нужно согласие на отправку трека радиостанциям' }, 400);
    }
    const t = (await pool.query(
      `SELECT t.id, t.title, t.artist_name, t.genre, t.moderation_status, ${PAID_SQL} AS paid, COALESCE(t.is_legacy, false) AS legacy
         FROM tracks t WHERE t.id = $1 AND t.user_id = $2`, [trackId, userId])).rows[0];
    if (!t) return c.json({ success: false, error: 'Трек не найден' }, 404);
    if (t.legacy) return c.json({ success: false, error: 'Архивные треки не участвуют' }, 400);
    if (!t.paid) return c.json({ success: false, error: 'Бонус доступен после оплаты размещения трека' }, 400);
    if (!['published', 'upcoming', 'approved'].includes(t.moderation_status)) {
      return c.json({ success: false, error: 'Трек ещё на модерации' }, 400);
    }
    const g = genreGroup(t.genre);
    const r = await pool.query(
      `INSERT INTO intl_pitch_requests (track_id, user_id, genre_group, consent_at, status)
       VALUES ($1, $2, $3, NOW(), 'queued')
       ON CONFLICT (track_id) DO UPDATE SET status = CASE WHEN intl_pitch_requests.status IN ('withdrawn') THEN 'queued' ELSE intl_pitch_requests.status END,
                                            consent_at = NOW(), updated_at = NOW()
       RETURNING id::text, status`, [trackId, userId, g]);
    notifyAdminTelegram(`🌍 <b>Международный питчинг: новая заявка</b>\n${escapeHtml(t.artist_name || '')} — «${escapeHtml(t.title || '')}» (${GENRE_GROUPS[g]?.ru})\n\n→ <a href="${SITE_URL}/ctrl-pm7k2f/intl_pitching">Подборка в админке</a>`).catch(() => {});
    return c.json({ success: true, data: r.rows[0] });
  } catch (e: any) {
    console.error('[intl-pitch] request:', e?.message);
    return c.json({ success: false, error: 'Не получилось подать заявку' }, 500);
  }
});

app.post('/my/:trackId/withdraw', requireAuth, async (c) => {
  const userId = String(c.get('userId'));
  const trackId = c.req.param('trackId');
  if (!UUID_RE.test(trackId)) return c.json({ success: false, error: 'Неверный трек' }, 400);
  const r = await pool.query(
    `UPDATE intl_pitch_requests SET status = 'withdrawn', digest_id = NULL, updated_at = NOW()
      WHERE track_id = $1 AND user_id = $2 AND status = 'queued' RETURNING id`, [trackId, userId]);
  if (!r.rowCount) return c.json({ success: false, error: 'Заявку уже нельзя отозвать: подборка отправляется' }, 400);
  return c.json({ success: true });
});

// ── страница скачивания для станции ───────────────────────────────────────────
async function contactByKey(key: string): Promise<(Contact & { test?: boolean }) | null> {
  const id = parseKey(key);
  if (!id) return null;
  if (id === TEST_CONTACT) return { id, email: TEST_EMAIL, lang: 'en', formats: [], station_name: 'Test', country: '', city: null, test: true };
  const r = await pool.query(`SELECT id::text, email, lang, formats, station_name, country, city FROM intl_radio_contacts WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

const PAGE_STYLE = `*{box-sizing:border-box}body{margin:0;background:#0a0a1a;color:#e6e6f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;padding:24px 16px}
.wrap{max-width:560px;margin:0 auto}.brand{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#a5a5c0;margin:0 0 16px}.brand b{color:#fff}
.card{background:#14142a;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:24px;margin-bottom:16px}
.track{display:flex;gap:16px;align-items:center}.cover{width:96px;height:96px;border-radius:12px;object-fit:cover;flex:none;background:linear-gradient(135deg,#FF577F,#7C3AED)}
h1{font-size:21px;line-height:1.25;margin:0 0 4px;color:#fff}h2{font-size:17px;margin:0 0 8px;color:#fff}.artist{color:#FF8FA8;font-size:16px;margin:0 0 8px}.meta{color:#8a8aa0;font-size:13px}
audio{width:100%;margin:18px 0 6px}.btn{display:block;width:100%;padding:15px 20px;border:0;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none}
.primary{background:linear-gradient(135deg,#FF577F,#7C3AED);color:#fff}.ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:#e6e6f0;font-weight:600;font-size:13px;padding:9px 14px;width:auto}
.note{font-size:13px;color:#a5a5c0;line-height:1.55;margin:12px 0 0}.row{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid rgba(255,255,255,.07)}
.row:first-of-type{border-top:0}.row img,.row .ph{width:44px;height:44px;border-radius:8px;object-fit:cover;flex:none;background:linear-gradient(135deg,#7C3AED,#06B6D4)}
.row .t{flex:1;min-width:0}.row .t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row .a{color:#FF8FA8;font-size:13px}
.muted{color:#8a8aa0;font-size:12px;text-align:center;margin-top:20px}.muted a{color:#FF8FA8;text-decoration:none}`;

function stationPage(c: any, en: boolean, title: string, body: string, status = 200) {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  return c.html(`<!doctype html><html lang="${en ? 'en' : 'ru'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · ${en ? 'Promo.Music for radio' : 'ПРОМО.МУЗЫКА для эфира'}</title>
<style>${PAGE_STYLE}</style></head><body><div class="wrap"><p class="brand"><b>${en ? 'Promo.Music' : 'ПРОМО.МУЗЫКА'}</b> · ${en ? 'new music for radio' : 'новинки для эфира'}</p>
${body}<p class="muted"><a href="${SITE_URL}">promo-music.ru</a> · ${en ? 'reply to our email to get in touch' : 'ответьте на наше письмо, чтобы связаться с нами'}</p></div></body></html>`, status);
}

app.get('/get/:trackId', async (c) => {
  const key = c.req.query('k') || '';
  const ct = await contactByKey(key);
  const en = ct ? ct.lang === 'en' : c.req.query('lang') !== 'ru';
  if (!ct) return stationPage(c, en, en ? 'Link is not valid' : 'Ссылка не подходит', `<div class="card"><h1>${en ? 'Link is not valid' : 'Ссылка не подходит'}</h1><p class="note">${en ? 'Please open the link from our email again.' : 'Откройте ссылку из письма ещё раз.'}</p></div>`, 403);
  const trackId = c.req.param('trackId');
  const t = UUID_RE.test(trackId) ? (await pool.query(
    `SELECT id::text, title, artist_name, genre, cover_url, duration, audio_url FROM tracks
      WHERE id = $1 AND moderation_status IN ('published', 'upcoming') AND audio_url IS NOT NULL`, [trackId])).rows[0] : null;
  if (!t) return stationPage(c, en, en ? 'Track unavailable' : 'Трек недоступен', `<div class="card"><h1>${en ? 'Track unavailable' : 'Трек недоступен'}</h1><p class="note">${en ? 'This track is no longer available for download.' : 'Этот трек сейчас нельзя скачать.'}</p></div>`, 404);
  // остальные треки последней подборки этой станции
  let others: Track[] = [];
  if (!ct.test) {
    const s = await pool.query(`SELECT track_ids::text[] AS ids FROM intl_digest_sends WHERE contact_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`, [ct.id]);
    others = (await loadTracks((s.rows[0]?.ids || []).filter((i: string) => i !== t.id)));
  }
  const cover = abs(t.cover_url);
  const meta = [t.genre, fmtDur(t.duration)].filter(Boolean).map((x: string) => escapeHtml(String(x))).join(' · ');
  const otherRows = others.map((o) => `<div class="row">${abs(o.cover_url) ? `<img src="${escapeHtml(abs(o.cover_url))}" alt="">` : '<div class="ph"></div>'}
<div class="t"><div>${escapeHtml(o.title || '')}</div><div class="a">${escapeHtml(o.artist_name || '')}</div></div>
<a class="btn ghost" href="${API_URL}/get/${o.id}?k=${encodeURIComponent(key)}">${en ? 'Open' : 'Открыть'}</a></div>`).join('');
  const dl = `${API_URL}/get/${t.id}/file?k=${encodeURIComponent(key)}&go=1`;
  return stationPage(c, en, `${t.artist_name || ''} — ${t.title || ''}`, `
<div class="card"><div class="track">${cover ? `<img class="cover" src="${escapeHtml(cover)}" alt="">` : '<div class="cover"></div>'}
<div><h1>${escapeHtml(t.title || '')}</h1><p class="artist">${escapeHtml(t.artist_name || '')}</p>${en && HAS_CYR.test(`${t.title} ${t.artist_name}`) ? `<div class="meta" style="margin-bottom:4px">${escapeHtml(translit(t.title || ''))} — ${escapeHtml(translit(t.artist_name || ''))}</div>` : ''}<div class="meta">${meta}</div></div></div>
<audio controls preload="none" src="${escapeHtml(abs(t.audio_url))}"></audio>
<a class="btn primary" href="${escapeHtml(dl)}" rel="nofollow">&#8681; ${en ? 'Download for airplay' : 'Скачать для эфира'}</a>
<p class="note">${en
    ? 'The artist released this track on Promo.Music and cleared it for radio airplay. Full-quality file, free of charge. If you play it, just reply to our email — the artist will be happy to know.'
    : 'Артист выпустил трек на ПРОМО.МУЗЫКЕ и разрешил ставить его в эфир. Файл в полном качестве, бесплатно. Если поставите трек в эфир — ответьте на наше письмо, артисту будет важно это знать.'}</p></div>
${otherRows ? `<div class="card"><h2>${en ? 'More from this selection' : 'Ещё в этой подборке'}</h2>${otherRows}</div>` : ''}`);
});

app.get('/get/:trackId/file', async (c) => {
  const trackId = c.req.param('trackId');
  const key = c.req.query('k') || '';
  if (c.req.query('go') !== '1') return c.redirect(`${API_URL}/get/${encodeURIComponent(trackId)}?k=${encodeURIComponent(key)}`, 302);
  const ct = await contactByKey(key);
  if (!ct || !UUID_RE.test(trackId)) return c.text('Link is not valid', 403);
  const t = (await pool.query(
    `SELECT id, title, artist_name, audio_url FROM tracks WHERE id = $1 AND moderation_status IN ('published', 'upcoming') AND audio_url IS NOT NULL`,
    [trackId])).rows[0];
  if (!t) return c.text('Track unavailable', 404);
  const ua = c.req.header('user-agent') || '';
  if (!ct.test && !BOT_UA.test(ua)) {
    try {
      const dup = await pool.query(
        `SELECT 1 FROM track_downloads_by_radio WHERE track_id = $1 AND intl_contact_id = $2
            AND downloaded_at > NOW() - ($3 || ' minutes')::interval LIMIT 1`, [t.id, ct.id, String(DEDUP_MINUTES)]);
      if (!dup.rows.length) {
        const ip = (c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '').split(',')[0].trim();
        await pool.query(
          `INSERT INTO track_downloads_by_radio (station_name, city, track_id, ip_addr, user_agent, via, intl_contact_id)
           VALUES ($1, $2, $3, $4, $5, 'intl_link', $6)`,
          [ct.station_name, [ct.city, ct.country].filter(Boolean).join(', ') || null, t.id, ip, ua.slice(0, 500), ct.id]);
      }
    } catch (e: any) {
      console.error('[intl-pitch] download log:', e?.message);
    }
  }
  const sent = await sendTrackFile(c, t);
  return sent || c.redirect(abs(t.audio_url), 302);
});

// ── админка ───────────────────────────────────────────────────────────────────
async function digestPlan(trackIds: string[]) {
  const tracks = await loadTracks(trackIds);
  const groups: Record<string, string> = {};
  const rq = await pool.query(`SELECT track_id::text, genre_group FROM intl_pitch_requests WHERE track_id = ANY($1::uuid[])`, [trackIds]);
  for (const r of rq.rows) groups[r.track_id] = r.genre_group;
  for (const t of tracks) if (!groups[t.id]) groups[t.id] = genreGroup(t.genre);
  const contacts = await receivingContacts();
  const plan: { contact: Contact; tracks: string[] }[] = [];
  for (const ct of contacts) {
    const ids = tracks.filter((t) => accepts(ct.formats, groups[t.id])).map((t) => t.id);
    if (ids.length) plan.push({ contact: ct, tracks: ids });
  }
  return { tracks, groups, plan };
}

app.get('/admin/overview', requireAuth, requireAdmin, async (c) => {
  try {
    const [stats, queued, digests, today] = await Promise.all([
      baseStats(),
      pool.query(`SELECT r.id::text, r.track_id::text, r.status, r.genre_group, r.created_at, r.digest_id::text, r.admin_note,
                         t.title, t.artist_name, t.genre, t.cover_url, u.email AS user_email
                    FROM intl_pitch_requests r JOIN tracks t ON t.id = r.track_id
                    LEFT JOIN users u ON u.id::text = r.user_id
                   WHERE r.status IN ('queued', 'in_digest', 'excluded') ORDER BY r.created_at`),
      pool.query(`SELECT d.id::text, d.status, d.track_ids::text[] AS track_ids, d.recipients, d.created_at, d.approved_at, d.finished_at,
                         count(s.*) FILTER (WHERE s.status = 'sent')::int AS sent,
                         count(s.*) FILTER (WHERE s.status = 'failed')::int AS failed,
                         count(s.*) FILTER (WHERE s.status = 'queued')::int AS queued
                    FROM intl_digests d LEFT JOIN intl_digest_sends s ON s.digest_id = d.id
                   GROUP BY d.id ORDER BY d.created_at DESC LIMIT 12`),
      pool.query(`SELECT count(*)::int AS n FROM intl_digest_sends WHERE status = 'sent' AND sent_at > NOW() - interval '24 hours'`),
    ]);
    const contacts = await receivingContacts();
    const requests = queued.rows.map((r: any) => ({ ...r, match: contacts.filter((ct) => accepts(ct.formats, r.genre_group)).length, genre_label: GENRE_GROUPS[r.genre_group]?.ru }));
    return c.json({ success: true, data: { stats, requests, digests: digests.rows, sentLast24h: today.rows[0].n, dailyCap: DAILY_CAP } });
  } catch (e: any) {
    console.error('[intl-pitch] overview:', e?.message);
    return c.json({ success: false, error: e?.message }, 500);
  }
});

app.post('/admin/digest', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const ids: string[] = Array.isArray(body?.requestIds) && body.requestIds.length
    ? (await pool.query(`SELECT track_id::text FROM intl_pitch_requests WHERE id = ANY($1::uuid[]) AND status = 'queued' AND digest_id IS NULL`, [body.requestIds])).rows.map((r: any) => r.track_id)
    : (await pool.query(`SELECT track_id::text FROM intl_pitch_requests WHERE status = 'queued' AND digest_id IS NULL ORDER BY created_at`)).rows.map((r: any) => r.track_id);
  if (!ids.length) return c.json({ success: false, error: 'Нет заявок для подборки' }, 400);
  const { plan } = await digestPlan(ids);
  const d = await pool.query(`INSERT INTO intl_digests (status, track_ids, recipients, created_by) VALUES ('draft', $1::uuid[], $2, $3) RETURNING id::text`,
    [ids, plan.length, String(c.get('userEmail') || '')]);
  await pool.query(`UPDATE intl_pitch_requests SET digest_id = $1, updated_at = NOW() WHERE track_id = ANY($2::uuid[]) AND status = 'queued'`, [d.rows[0].id, ids]);
  return c.json({ success: true, data: { id: d.rows[0].id, tracks: ids.length, recipients: plan.length } });
});

app.get('/admin/digest/:id/preview', requireAuth, requireAdmin, async (c) => {
  const d = (await pool.query(`SELECT track_ids::text[] AS ids FROM intl_digests WHERE id = $1`, [c.req.param('id')])).rows[0];
  if (!d) return c.text('not found', 404);
  const lang = c.req.query('lang') === 'ru' ? 'ru' : 'en';
  const { tracks, groups } = await digestPlan(d.ids);
  const { subject, html } = digestEmail({ id: TEST_CONTACT, email: TEST_EMAIL, lang }, tracks, groups);
  return c.json({ success: true, data: { subject, html } });
});

app.post('/admin/digest/:id/test', requireAuth, requireAdmin, async (c) => {
  const d = (await pool.query(`SELECT track_ids::text[] AS ids FROM intl_digests WHERE id = $1`, [c.req.param('id')])).rows[0];
  if (!d) return c.json({ success: false, error: 'Подборка не найдена' }, 404);
  const { tracks, groups } = await digestPlan(d.ids);
  const out: any[] = [];
  for (const lang of ['ru', 'en']) {
    const m = digestEmail({ id: TEST_CONTACT, email: TEST_EMAIL, lang }, tracks, groups);
    const r = await smtpSendEmail({ to: TEST_EMAIL, subject: `[ТЕСТ] ${m.subject}`, html: m.html, from: m.from, replyTo: REPLY_TO, listUnsubscribe: false });
    out.push({ lang, ok: r.success, error: r.error });
  }
  return c.json({ success: true, data: out });
});

app.post('/admin/digest/:id/approve', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  const d = (await pool.query(`SELECT id, status, track_ids::text[] AS ids FROM intl_digests WHERE id = $1`, [id])).rows[0];
  if (!d) return c.json({ success: false, error: 'Подборка не найдена' }, 404);
  if (d.status !== 'draft') return c.json({ success: false, error: 'Подборка уже утверждена или отменена' }, 400);
  const { plan } = await digestPlan(d.ids);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of plan) {
      await client.query(`INSERT INTO intl_digest_sends (digest_id, contact_id, track_ids) VALUES ($1, $2, $3::uuid[]) ON CONFLICT DO NOTHING`, [id, p.contact.id, p.tracks]);
    }
    await client.query(`UPDATE intl_digests SET status = 'sending', recipients = $2, approved_by = $3, approved_at = NOW() WHERE id = $1`, [id, plan.length, String(c.get('userEmail') || '')]);
    await client.query(`UPDATE intl_pitch_requests SET status = 'in_digest', updated_at = NOW() WHERE digest_id = $1 AND status = 'queued'`, [id]);
    await client.query('COMMIT');
  } catch (e: any) {
    await client.query('ROLLBACK');
    return c.json({ success: false, error: e?.message }, 500);
  } finally {
    client.release();
  }
  return c.json({ success: true, data: { recipients: plan.length, dailyCap: DAILY_CAP } });
});

app.post('/admin/digest/:id/cancel', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  await pool.query(`UPDATE intl_digest_sends SET status = 'skipped' WHERE digest_id = $1 AND status = 'queued'`, [id]);
  await pool.query(`UPDATE intl_digests SET status = 'cancelled', finished_at = NOW() WHERE id = $1 AND status IN ('draft', 'sending')`, [id]);
  await pool.query(`UPDATE intl_pitch_requests SET status = 'queued', digest_id = NULL, updated_at = NOW() WHERE digest_id = $1 AND status IN ('queued', 'in_digest')`, [id]);
  return c.json({ success: true });
});

app.post('/admin/requests/:id/:action', requireAuth, requireAdmin, async (c) => {
  const { id, action } = c.req.param();
  const body = await c.req.json().catch(() => ({} as any));
  if (action === 'exclude') {
    await pool.query(`UPDATE intl_pitch_requests SET status = 'excluded', digest_id = NULL, admin_note = $2, updated_at = NOW() WHERE id = $1 AND status = 'queued'`, [id, String(body?.note || '').slice(0, 300) || null]);
  } else if (action === 'include') {
    await pool.query(`UPDATE intl_pitch_requests SET status = 'queued', admin_note = NULL, updated_at = NOW() WHERE id = $1 AND status = 'excluded'`, [id]);
  } else {
    return c.json({ success: false, error: 'unknown action' }, 400);
  }
  return c.json({ success: true });
});

// ── отправка по расписанию ────────────────────────────────────────────────────
async function isUnsub(email: string): Promise<boolean> {
  try {
    const { getPublishEmailPrefs } = await import('./db.tsx');
    if (await getPublishEmailPrefs(`unsub:${email.toLowerCase()}`)) return true;
  } catch { /* второй стор проверен в SQL */ }
  return false;
}

async function finishDigests() {
  const done = await pool.query(
    `UPDATE intl_digests d SET status = 'sent', finished_at = NOW(),
            sent_count = (SELECT count(*) FROM intl_digest_sends s WHERE s.digest_id = d.id AND s.status = 'sent'),
            failed_count = (SELECT count(*) FROM intl_digest_sends s WHERE s.digest_id = d.id AND s.status = 'failed')
      WHERE d.status = 'sending' AND NOT EXISTS (SELECT 1 FROM intl_digest_sends s WHERE s.digest_id = d.id AND s.status = 'queued')
      RETURNING d.id::text`);
  for (const { id } of done.rows) {
    const rq = await pool.query(
      `UPDATE intl_pitch_requests r SET status = 'sent', updated_at = NOW() FROM tracks t
        WHERE r.digest_id = $1 AND r.status = 'in_digest' AND t.id = r.track_id
        RETURNING r.user_id, r.track_id::text, t.title`, [id]);
    for (const r of rq.rows) {
      const s = await pool.query(
        `SELECT count(*)::int AS n, count(DISTINCT c.country)::int AS k FROM intl_digest_sends s JOIN intl_radio_contacts c ON c.id = s.contact_id
          WHERE s.digest_id = $1 AND s.status = 'sent' AND $2::uuid = ANY(s.track_ids)`, [id, r.track_id]);
      try {
        const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
        await notifyCrossCabinet({
          targetUserId: r.user_id, targetRole: 'artist', sourceRole: 'system', type: 'pitching_update',
          title: `Трек «${String(r.title || '').slice(0, 80)}» отправлен радиостанциям`,
          message: `Международный питчинг (бета): трек ушёл на ${s.rows[0].n} радиостанций в ${s.rows[0].k} странах. Кто скачал — увидите в кабинете.`,
          link: '/artist/pitching?tab=world', metadata: { trackId: r.track_id, digestId: id },
        });
      } catch (e: any) {
        console.error('[intl-pitch] notify:', e?.message);
      }
    }
  }
}

app.post('/tick', async (c) => {
  const k = c.req.header('X-Internal-Key') || c.req.header('x-internal-key');
  if (!INTERNAL_KEY || k !== INTERNAL_KEY) {
    // вручную — только из админ-сессии
    let ok = false;
    await requireAuth(c, async () => { await requireAdmin(c, async () => { ok = true; }); });
    if (!ok) return c.json({ success: false, error: 'forbidden' }, 403);
  }
  // блокировка держится на одном выделенном соединении — снимаем на нём же
  const lockClient = await pool.connect();
  const lock = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [TICK_LOCK]);
  if (!lock.rows[0].ok) { lockClient.release(); return c.json({ success: true, data: { busy: true } }); }
  let sent = 0, failed = 0, skipped = 0;
  try {
    const used = (await pool.query(`SELECT count(*)::int AS n FROM intl_digest_sends WHERE status = 'sent' AND sent_at > NOW() - interval '24 hours'`)).rows[0].n;
    const budget = Math.max(0, Math.min(TICK_MAX, DAILY_CAP - used));
    if (budget > 0) {
      const q = await pool.query(
        `SELECT s.id::text, s.track_ids::text[] AS ids, c.id::text AS cid, c.email, c.lang, c.unsubscribed_at, c.bounced_at, c.excluded, c.active,
                EXISTS (SELECT 1 FROM email_unsubscribes u WHERE u.email = lower(c.email)) AS unsub
           FROM intl_digest_sends s JOIN intl_radio_contacts c ON c.id = s.contact_id
           JOIN intl_digests d ON d.id = s.digest_id AND d.status = 'sending'
          WHERE s.status = 'queued' ORDER BY s.created_at LIMIT $1`, [budget]);
      for (const row of q.rows) {
        if (row.unsub || row.unsubscribed_at || row.bounced_at || row.excluded || !row.active || await isUnsub(row.email)) {
          await pool.query(`UPDATE intl_digest_sends SET status = 'skipped', error = 'unsubscribed or inactive' WHERE id = $1`, [row.id]);
          skipped++; continue;
        }
        const tracks = await loadTracks(row.ids);
        const groups: Record<string, string> = {};
        for (const t of tracks) groups[t.id] = genreGroup(t.genre);
        const m = digestEmail({ id: row.cid, email: row.email, lang: row.lang }, tracks, groups);
        const r = await smtpSendEmail({ to: row.email, subject: m.subject, html: m.html, from: m.from, replyTo: REPLY_TO, listUnsubscribe: true });
        if (r.success) {
          sent++;
          await pool.query(`UPDATE intl_digest_sends SET status = 'sent', sent_at = NOW(), error = NULL WHERE id = $1`, [row.id]);
          await pool.query(`UPDATE intl_radio_contacts SET last_sent_at = NOW(), send_count = send_count + 1 WHERE id = $1`, [row.cid]);
        } else {
          failed++;
          await pool.query(`UPDATE intl_digest_sends SET status = 'failed', error = $2 WHERE id = $1`, [row.id, String(r.error || '').slice(0, 300)]);
        }
        await new Promise((res) => setTimeout(res, TICK_GAP_MS));
      }
    }
    await finishDigests();
    return c.json({ success: true, data: { sent, failed, skipped, usedLast24h: used + sent, dailyCap: DAILY_CAP } });
  } catch (e: any) {
    console.error('[intl-pitch] tick:', e?.message);
    return c.json({ success: false, error: e?.message }, 500);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [TICK_LOCK]).catch(() => {});
    lockClient.release();
  }
});

export default app;
