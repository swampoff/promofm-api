// СТУДИЯ ЭФИРА ЗАВЕДЕНИЯ ПРОМО.ЭИР (27.09.2026)
//
// Решение владельца для «радио полного цикла»: ведущие выходят в эфир с
// повесткой заведения (меню, события, акции), подкасты о заведении, управление
// через Telegram. Всё собирается здесь, AutoDJ заведения не меняется:
//   • ведущий — раз в N минут (анкета: ai_host_config.intervalMinutes) на потоке
//     с устройством на связи: Gemini пишет 2–4 фразы по пункту повестки, прокси
//     озвучивает (/tts-stream), звук уходит в AutoDJ заведения POST /api/inject
//     (накладывается на музыку с приглушением, как у основного эфира);
//   • подкаст — диалог двух ведущих о заведении по повестке → MP3 в папку
//     podcasts потока; AutoDJ сам ставит свежий подкаст раз в час с 10 до 22 МСК;
//     автоматически раз в день и по запросу (кабинет, /podcast), до 3 в день;
//   • Telegram — @Promomusicalbot (его читает voice-bot.mjs и пересылает сюда
//     сообщения не из админских чатов): привязка кодом из кабинета, текст →
//     пункт повестки (и в канал заведения, если привязан), голосовое → в эфир.

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { venueDjPort, venueNameFor, VENUE_MOUNT_RE } from './venue-station-routes.tsx';

const app = new Hono();

const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL || 'http://187.77.85.42:8088';
const GEMINI_PROXY_KEY = process.env.GEMINI_PROXY_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3-flash-preview';
const INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// С RU-сервера Telegram API отвечает не всегда — имя бота на случай, если getMe не прошёл.
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'Promomusicalbot';
const DATA_ROOT = '/var/lib/promo-air';
const SAMPLE_RATE = 24000;
const DEVICE_ONLINE_SEC = 180;
const PODCASTS_PER_DAY = 3;
const HOST_DEFAULT_MIN = 30;
const AGENDA_MAX_ACTIVE = 30;
const AGENDA_MAX_LEN = 500;
// Формула ведущих — по регламенту Soul FM (владелец, 27.09.2026: «формулу ведущих бери
// с soul fm, там всё уже настроено»). Голоса: тёплые; низкий Charon (Марк) из
// приветствий исключён, как в регламенте Soul FM (G1).
const FEMALE_HOSTS = ['Сандра', 'Лиана', 'Стелла'];
const MALE_HOSTS = ['Макс', 'Пабло'];
const ALL_HOSTS = [...FEMALE_HOSTS, ...MALE_HOSTS, 'Марк', 'Нико', 'DJ Den', 'Ден'];
const STYLE_TEXT: Record<string, string> = {
  casual: 'непринуждённо и дружелюбно',
  business: 'сдержанно и чётко',
  relaxed: 'спокойно и тепло',
  energetic: 'бодро, с энергией',
};
// Повтор хуже тишины (регламент Soul FM 3.3): пункт повестки — не чаще раза в 2 часа,
// приветствие без пункта — тоже не чаще раза в 2 часа.
const ITEM_COOLDOWN_MIN = 120;
const GREETING_COOLDOWN_MIN = 120;
const BANNED_RE = /нейросет|искусственн[а-яё]* интеллект|(^|[^а-яё])ИИ([^а-яё]|$)|голосов[а-яё]* модел|сгенерир|политик|выбор[ыа]|санкци|войн[аыу]|доллар|курс валют/i;
// Рекламные эпитеты режем постобработкой (как _scrub_hype у Soul FM): только прилагательные.
const HYPE_RE = /(^|[\s(«"])(?:уникальн|потрясающ|невероятн|легендарн|культов|волшебн|магическ|фантастическ|феноменальн|грандиозн|восхитительн)[а-яё]*(?=[\s,.!?…»")]|$)/gi;

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const iso = (d: any) => (d instanceof Date ? d.toISOString() : d ?? null);
const isFemale = (host: string) => FEMALE_HOSTS.includes(host);
const timesRu = (n: number) => `${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'раза' : 'раз'}`;

// Латиница в озвучке запрещена (регламент Soul FM NP5): название заведения — по-русски.
const TRANSLIT: [string, string][] = [
  ['shch', 'щ'], ['sch', 'щ'], ['sh', 'ш'], ['ch', 'ч'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['tz', 'ц'],
  ['ya', 'я'], ['yu', 'ю'], ['yo', 'ё'], ['ye', 'е'], ['ph', 'ф'], ['th', 'т'], ['ck', 'к'], ['qu', 'кв'], ['ee', 'и'], ['oo', 'у'],
  ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'е'], ['f', 'ф'], ['g', 'г'], ['h', 'х'], ['i', 'и'], ['j', 'дж'], ['k', 'к'],
  ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['v', 'в'],
  ['w', 'в'], ['x', 'кс'], ['y', 'и'], ['z', 'з'],
];
function spokenName(name: string): string {
  return String(name || '').split(/(\s+)/).map((w) => {
    if (!/[a-z]/i.test(w)) return w;
    let s = w.toLowerCase();
    let out = '';
    while (s.length) {
      const hit = TRANSLIT.find(([lat]) => s.startsWith(lat));
      if (hit) { out += hit[1]; s = s.slice(hit[0].length); } else { out += s[0]; s = s.slice(1); }
    }
    return out.charAt(0).toUpperCase() + out.slice(1);
  }).join('');
}

// Постобработка реплики: эпитеты, латиница (предложение с ней выкидываем), имена ведущих
// в обращениях (в подкастах имён нет — регламент Soul FM 15.07), пробелы.
function polish(text: string, venueName: string, spoken: string, opts: { keepQuestions?: boolean; stripNames?: boolean } = {}): string {
  let t = String(text || '').replace(/[«»"“”]/g, '').replace(/\([^)]*\)/g, '');
  if (venueName && venueName !== spoken) t = t.split(venueName).join(spoken).replace(new RegExp(venueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), spoken);
  t = t.replace(HYPE_RE, '$1');
  if (opts.stripNames) {
    const names = ALL_HOSTS.join('|');
    t = t.replace(new RegExp(`^\\s*(?:${names})\\s*[,!]\\s*`, 'i'), '').replace(new RegExp(`,\\s*(?:${names})(?=\\s*[?!.…])`, 'gi'), '');
  }
  if (!opts.keepQuestions) t = t.replace(/\?+/g, '.');
  if (/[a-z]/i.test(t)) t = t.split(/(?<=[.!?…])\s+/).filter((s) => !/[a-z]/i.test(s)).join(' ');
  t = t.replace(/\s+([,.!?…])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

// ─── Данные заведения ─────────────────────────────────────────────────────

interface VenueStream { id: string; slug: string; pointName: string | null; online: boolean; hostEnabled: boolean | null; status: string }

async function venueStreams(venueUserId: string): Promise<VenueStream[]> {
  const { rows } = await pool.query(
    `SELECT id, stream_url, point_name, status, host_enabled,
            (device_token_hash IS NOT NULL AND last_seen_at > now() - make_interval(secs => $2)) AS online
       FROM venue_station_streams
      WHERE user_id = $1 AND stream_url ~ '/air/live/venue-' AND status <> 'dead'
      ORDER BY created_at`,
    [venueUserId, DEVICE_ONLINE_SEC],
  );
  const out: VenueStream[] = [];
  for (const r of rows) {
    const m = String(r.stream_url || '').match(VENUE_MOUNT_RE);
    if (m) out.push({ id: String(r.id), slug: m[1], pointName: r.point_name || null, online: !!r.online, hostEnabled: r.host_enabled, status: r.status });
  }
  return out;
}

interface HostCfg { voice?: string; style?: string; intervalMinutes?: number; topics?: string[]; notes?: string; airType?: string }

async function hostConfigFor(venueUserId: string): Promise<HostCfg> {
  const { rows } = await pool.query(
    `SELECT ai_host_config, format FROM venue_station_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [venueUserId],
  );
  const cfg = (rows[0]?.ai_host_config || {}) as HostCfg;
  return { ...cfg, airType: rows[0]?.format?.airType };
}

// Ведущий у заведения постоянный: выбираем по голосу из анкеты и id заведения.
function hostNames(venueUserId: string, voice?: string): [string, string] {
  let h = 0;
  for (const ch of venueUserId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const female = FEMALE_HOSTS[h % FEMALE_HOSTS.length];
  const male = MALE_HOSTS[h % MALE_HOSTS.length];
  return voice === 'male' ? [male, female] : [female, male];
}

async function activeAgenda(venueUserId: string) {
  const { rows } = await pool.query(
    `SELECT id, text, source, expires_at, aired_count, last_aired_at, created_at
       FROM venue_air_agenda
      WHERE venue_user_id = $1 AND active = true AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC`,
    [venueUserId],
  );
  return rows;
}

function mskContext() {
  const now = new Date(Date.now() + 3 * 3600_000);
  const h = now.getUTCHours();
  const period = h < 5 ? 'ночь' : h < 12 ? 'утро' : h < 17 ? 'день' : h < 22 ? 'вечер' : 'поздний вечер';
  const weekday = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][now.getUTCDay()];
  const time = `${String(h).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return { h, period, weekday, time, date: now.toISOString().slice(0, 10) };
}

// ─── Gemini: текст и озвучка ──────────────────────────────────────────────

// Бесплатный ключ Gemini иногда отвечает 503/429 — повторяем с паузой, последней
// попыткой берём запасную модель.
async function geminiJson(prompt: string): Promise<any> {
  const models = [GEMINI_TEXT_MODEL, GEMINI_TEXT_MODEL, 'gemini-2.5-flash'];
  let lastErr: Error | null = null;
  for (let i = 0; i < models.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, i * 5000));
    const url = `${GEMINI_PROXY_URL}/v1beta/models/${models[i]}:generateContent?key=${GEMINI_API_KEY}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 4096, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const d: any = await r.json().catch(() => null);
      if (!r.ok) { lastErr = new Error(`gemini ${r.status}`); if (r.status === 429 || r.status >= 500) continue; throw lastErr; }
      const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return JSON.parse(text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, ''));
    } catch (e: any) {
      lastErr = e;
      if (!/gemini (429|5\d\d)|abort|timeout|fetch failed/i.test(String(e?.message || e?.name))) throw e;
    }
  }
  throw lastErr || new Error('gemini failed');
}

async function tts(text: string, author: string): Promise<Buffer> {
  const r = await fetch(`${GEMINI_PROXY_URL}/tts-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
    body: JSON.stringify({ text, author }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1000) throw new Error('tts too short');
  return buf;
}

const silence = (ms: number) => Buffer.alloc(Math.floor((ms / 1000) * SAMPLE_RATE) * 2);

async function ffmpeg(args: string[], input?: Buffer): Promise<void> {
  const { spawn } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-200)}`))));
    if (input && p.stdin) p.stdin.end(input);
  });
}

// Кладём готовый MP3 в папку подкастов каждого потока заведения.
async function putToPodcastDirs(streams: VenueStream[], srcPath: string, name: string): Promise<number> {
  const fs = await import('fs/promises');
  let n = 0;
  for (const s of streams) {
    const dir = `${DATA_ROOT}/${s.slug}/podcasts`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(srcPath, `${dir}/${name}`);
      n++;
    } catch (e: any) {
      console.warn('[venue-air] podcast copy', s.slug, e?.message);
    }
  }
  return n;
}

async function injectPcm(port: number, pcm: Buffer): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/api/inject`, {
    method: 'POST',
    headers: { 'X-Internal-Key': INTERNAL_KEY, 'Content-Type': 'application/octet-stream' },
    body: pcm,
    signal: AbortSignal.timeout(30_000),
  });
  return r.status;
}

// ─── Telegram ─────────────────────────────────────────────────────────────

async function tgApi(method: string, body: any): Promise<any> {
  if (!TG_TOKEN) return { ok: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    return await r.json();
  } catch { return { ok: false }; }
}
const tgSend = (chatId: string, text: string) => tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });

let botInfo: { id: number; username: string } | null = null;
async function getBot() {
  if (botInfo) return botInfo;
  const d = await tgApi('getMe', {});
  if (d?.ok) botInfo = { id: d.result.id, username: d.result.username };
  return botInfo;
}

async function postToChannel(venueUserId: string, text: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT channel_id, channel_title FROM venue_air_telegram WHERE venue_user_id = $1`, [venueUserId]);
  const ch = rows[0];
  if (!ch?.channel_id) return null;
  const d = await tgApi('sendMessage', { chat_id: ch.channel_id, text });
  return d?.ok ? (ch.channel_title || 'канал') : null;
}

// ─── Повестка ─────────────────────────────────────────────────────────────

async function addAgenda(venueUserId: string, text: string, source: string, expiresAt?: string | null) {
  const t = String(text || '').trim().slice(0, AGENDA_MAX_LEN);
  if (t.length < 3) return { error: 'Слишком короткий текст' };
  const { rows: cnt } = await pool.query(
    `SELECT count(*)::int AS n FROM venue_air_agenda WHERE venue_user_id = $1 AND active = true AND (expires_at IS NULL OR expires_at > now())`,
    [venueUserId],
  );
  if ((cnt[0]?.n || 0) >= AGENDA_MAX_ACTIVE) return { error: `В повестке уже ${AGENDA_MAX_ACTIVE} пунктов, уберите устаревшие` };
  const exp = expiresAt && !Number.isNaN(Date.parse(expiresAt)) ? new Date(expiresAt).toISOString() : null;
  const { rows } = await pool.query(
    `INSERT INTO venue_air_agenda (venue_user_id, text, source, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [venueUserId, t, source, exp],
  );
  const channel = await postToChannel(venueUserId, t).catch(() => null);
  return { id: String(rows[0].id), text: t, channel };
}

// ─── Ведущий ──────────────────────────────────────────────────────────────

const pendingHost = new Map<string, { pcm: Buffer; text: string; host: string; itemId: string | null; at: number }>();

// Соло-выход ведущего по формуле Soul FM: приветствие по времени суток и имя
// ведущего, одна новость заведения (или тёплое приветствие), подпись станции.
async function composeHost(venueUserId: string, cfg: HostCfg, streamId: string, force = false) {
  const venueName = await venueNameFor(venueUserId).catch(() => 'Заведение');
  const spoken = spokenName(venueName);
  const cutoff = Date.now() - ITEM_COOLDOWN_MIN * 60_000;
  const items = (await activeAgenda(venueUserId))
    .filter((it: any) => force || !it.last_aired_at || new Date(it.last_aired_at).getTime() < cutoff)
    .sort((a: any, b: any) => (a.last_aired_at ? new Date(a.last_aired_at).getTime() : 0) - (b.last_aired_at ? new Date(b.last_aired_at).getTime() : 0));
  const item = items[0] || null;
  if (!item && !force) {
    const { rows } = await pool.query(
      `SELECT max(created_at) AS at FROM venue_air_log WHERE stream_id = $1 AND kind = 'host' AND title LIKE '%· приветствие'`,
      [streamId],
    );
    if (rows[0]?.at && Date.now() - new Date(rows[0].at).getTime() < GREETING_COOLDOWN_MIN * 60_000) return null; // лучше тишина, чем повтор
  }
  const [host] = hostNames(venueUserId, cfg.voice);
  const female = isFemale(host);
  const style = STYLE_TEXT[cfg.style || ''] || STYLE_TEXT.relaxed;
  const t = mskContext();
  const task = item
    ? `Коротко расскажи гостям новость заведения, только факты из неё: «${item.text}».`
    : `Тепло поприветствуй гостей и пожелай им хорошего ${t.period === 'утро' ? 'утра' : t.period === 'день' ? 'дня' : 'вечера'}.`;
  const prompt = `Ты — ${host}, ${female ? 'ведущая' : 'ведущий'} радио заведения «${spoken}». Эфир звучит в зале для гостей.
Манера: ${style}, тёплым, спокойным, дружелюбным тоном, без драматизации.
Сейчас ${t.weekday}, ${t.time} по Москве, ${t.period}.
${cfg.notes ? `Пожелания заведения к ведущему: ${String(cfg.notes).slice(0, 300)}\n` : ''}Задача: ${task}
Формула выхода:
1) приветствие по времени суток и представься: «С вами ${host}»;
2) ${item ? 'новость своими словами, 1–2 предложения' : 'одна тёплая фраза о том, что вы рады гостям'};
3) подпись: «Это радио ${spoken}, оставайтесь с нами».
Правила:
- 3–5 коротких предложений, 15–30 секунд речи. Только русские буквы, никакой латиницы, название заведения пиши так: ${spoken}.
- Ни одного вопроса. Никаких «срочно», «внимание», «шок».
- Не выдумывай блюда, цены, даты, время, имена и события, которых нет в новости. Числа и время — словами по-русски.
- Без рекламных эпитетов (уникальный, потрясающий, невероятный, легендарный, волшебный).
- О себе говори в ${female ? 'женском' : 'мужском'} роде.
- Не упоминай нейросети, ИИ, голосовые модели и то, что текст написан программой. Без политики, экономики, медицины.
Верни JSON: {"text": "текст выхода"}`;
  const res = await geminiJson(prompt);
  let text = polish(res?.text, venueName, spoken);
  if (text && !/оставайтесь с нами/i.test(text)) text = `${text} Это радио ${spoken}, оставайтесь с нами.`;
  if (!text || text.length < 30 || text.length > 700 || BANNED_RE.test(text)) throw new Error('host text rejected');
  const pcm = await tts(text, host);
  return { pcm, text, host, itemId: item ? String(item.id) : null };
}

async function airHost(streamId: string, venueUserId: string, port: number, cfg: HostCfg, force = false): Promise<'done' | 'busy' | 'skip'> {
  let seg = pendingHost.get(streamId);
  if (seg && Date.now() - seg.at > 10 * 60_000) { pendingHost.delete(streamId); seg = undefined; }
  if (!seg) {
    const fresh = await composeHost(venueUserId, cfg, streamId, force);
    if (!fresh) return 'skip';
    seg = { ...fresh, at: Date.now() };
  }
  const status = await injectPcm(port, seg.pcm);
  if (status === 423) { pendingHost.set(streamId, seg); return 'busy'; }
  pendingHost.delete(streamId);
  if (status < 200 || status >= 300) throw new Error(`inject ${status}`);
  await pool.query(
    `INSERT INTO venue_air_log (venue_user_id, stream_id, kind, title, text) VALUES ($1, $2, 'host', $3, $4)`,
    [venueUserId, streamId, `${seg.host} · ${seg.itemId ? 'повестка' : 'приветствие'}`, seg.text],
  );
  if (seg.itemId) await pool.query(`UPDATE venue_air_agenda SET aired_count = aired_count + 1, last_aired_at = now() WHERE id = $1`, [seg.itemId]);
  return 'done';
}

// ─── Подкаст ──────────────────────────────────────────────────────────────

const podcastRunning = new Set<string>();

async function podcastsToday(venueUserId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM venue_air_log
      WHERE venue_user_id = $1 AND kind = 'podcast' AND status <> 'failed'
        AND (created_at AT TIME ZONE 'Europe/Moscow')::date = (now() AT TIME ZONE 'Europe/Moscow')::date`,
    [venueUserId],
  );
  return rows[0]?.n || 0;
}

export async function startVenuePodcast(venueUserId: string, topic: string | null, notifyChat: string | null): Promise<{ ok: boolean; error?: string }> {
  const streams = await venueStreams(venueUserId);
  if (!streams.length) return { ok: false, error: 'Эфир заведения ещё не запущен' };
  if (podcastRunning.has(venueUserId)) return { ok: false, error: 'Подкаст уже собирается' };
  if ((await podcastsToday(venueUserId)) >= PODCASTS_PER_DAY) return { ok: false, error: `Сегодня уже ${PODCASTS_PER_DAY} подкаста, это предел на день` };
  const items = await activeAgenda(venueUserId);
  const extra = topic ? String(topic).trim().slice(0, 300) : '';
  if (!items.length && !extra) return { ok: false, error: 'Повестка пуста: добавьте новости заведения или укажите тему подкаста' };
  podcastRunning.add(venueUserId);
  buildPodcast(venueUserId, streams, items, extra)
    .then(async (r) => { if (notifyChat) await tgSend(notifyChat, r.ok ? `🎙 Подкаст готов (${r.turns} реплик). Он прозвучит в эфире в ближайший час с 10:00 до 22:00.` : `Не получилось собрать подкаст: ${esc(r.error || 'ошибка')}. Попробуйте позже.`); })
    .catch((e) => console.warn('[venue-air] podcast', e?.message))
    .finally(() => podcastRunning.delete(venueUserId));
  return { ok: true };
}

// Диалог двух ведущих по формуле Soul FM (связность, приветствие, прощание,
// без имён в речи, ≤2 фактов, без эпитетов), озвучка каждой реплики своим голосом.
async function buildPodcast(venueUserId: string, streams: VenueStream[], items: any[], topic: string): Promise<{ ok: boolean; error?: string; turns?: number }> {
  const venueName = await venueNameFor(venueUserId).catch(() => 'Заведение');
  const spoken = spokenName(venueName);
  const cfg = await hostConfigFor(venueUserId);
  const [a, b] = hostNames(venueUserId, cfg.voice);
  const g = (h: string) => (isFemale(h) ? 'женщина, о себе в женском роде' : 'мужчина, о себе в мужском роде');
  const facts = items.slice(0, 2).map((it: any) => `- ${it.text}`).join('\n');
  const t = mskContext();
  const prompt = `Ты — сценарист живой радиопередачи для радио заведения «${spoken}». Передача звучит в зале для гостей.
Ведущие: ${a} (${g(a)}) и ${b} (${g(b)}). Манера: ${STYLE_TEXT[cfg.style || ''] || STYLE_TEXT.relaxed}, тёплым дружелюбным тоном.
Сейчас ${t.weekday}, ${t.period}.
МАТЕРИАЛ ВЫПУСКА (только это, ничего не добавляй от себя):
${facts || '- (повестки нет, говорим только о теме ниже)'}
${topic ? `Тема от заведения: ${topic}\n` : ''}
ФОРМАТ:
- 12–16 реплик по 20–45 слов, строго чередуются: ${a}, ${b}, ${a}… Длинные абзацы запрещены.
- Метки авторов нужны только для озвучки. ИМЕНА ВЕДУЩИХ В РЕЧИ НЕ ПРОИЗНОСЯТСЯ: друг к другу обращаются «друзья», «коллега».
- Первая реплика: живое приветствие гостей по времени суток — «Вы на волнах радио ${spoken}…», своими словами, без имени, и подводка к теме.
СВЯЗНОСТЬ:
- каждая реплика начинается с подхвата конкретного слова или мысли предыдущей; менять тему нельзя;
- если прозвучал вопрос, следующая реплика — ответ на него («Хм… я думаю, что…»); никто не вступает внезапно.
ЖИВАЯ ПОДАЧА: паузы многоточием, междометия «хм», «ах»; смех только словами «ха-ха», редко. Никаких ремарок в скобках.
ФИНАЛ: последняя реплика собирает мысль, тепло прощается своими словами и называет радио ${spoken}.
ЗАПРЕТЫ:
- не выдумывать блюда, цены, даты, время, имена, артистов и события, которых нет в материале; не вводить новых людей и мест;
- без рекламных эпитетов (уникальный, потрясающий, невероятный, легендарный, волшебный);
- без политики, экономики, медицины; не упоминать нейросети, ИИ, голосовые модели;
- числа и время словами по-русски; только русские буквы, никакой латиницы, название пиши так: ${spoken}.
Верни JSON-массив: [{"author": "${a}", "text": "..."}, {"author": "${b}", "text": "..."}]`;
  let turns: { author: string; text: string }[] = [];
  try {
    const res = await geminiJson(prompt);
    turns = (Array.isArray(res) ? res : [])
      .filter((x: any) => x?.author === a || x?.author === b) // чужую метку не переприсваиваем другому голосу
      .map((x: any) => ({ author: String(x.author), text: polish(x?.text, venueName, spoken, { keepQuestions: true, stripNames: true }) }))
      .filter((x) => x.text.length > 5 && !BANNED_RE.test(x.text))
      .slice(0, 18);
  } catch (e: any) {
    return logFailed(venueUserId, `script: ${e?.message}`);
  }
  if (turns.length < 8) return logFailed(venueUserId, 'сценарий слишком короткий');
  const parts: Buffer[] = [];
  for (const tr of turns) {
    try { parts.push(await tts(tr.text, tr.author), silence(500)); } catch (e: any) { console.warn('[venue-air] tts', e?.message); }
  }
  if (parts.length < 16) return logFailed(venueUserId, 'озвучка не удалась');
  const stamp = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const tmp = `/tmp/venue-podcast-${venueUserId.slice(0, 8)}-${stamp}.mp3`;
  try {
    await ffmpeg(['-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-ac', '2', '-b:a', '128k', tmp], Buffer.concat(parts));
    const n = await putToPodcastDirs(streams, tmp, `podcast_${stamp}.mp3`);
    if (!n) return logFailed(venueUserId, 'не удалось положить файл в эфир');
  } finally {
    (await import('fs/promises')).unlink(tmp).catch(() => {});
  }
  await pool.query(
    `INSERT INTO venue_air_log (venue_user_id, kind, title, text) VALUES ($1, 'podcast', $2, $3)`,
    [venueUserId, topic || 'Подкаст о заведении', turns.map((x) => `${x.author}: ${x.text}`).join('\n')],
  );
  return { ok: true, turns: turns.length };
}

async function logFailed(venueUserId: string, why: string) {
  await pool.query(`INSERT INTO venue_air_log (venue_user_id, kind, title, status) VALUES ($1, 'podcast', $2, 'failed')`, [venueUserId, why.slice(0, 200)]).catch(() => {});
  return { ok: false, error: why };
}

// ─── Запись заведения из Telegram → эфир ──────────────────────────────────

async function telegramAudioToAir(venueUserId: string, fileId: string, chatId: string) {
  const streams = await venueStreams(venueUserId);
  if (!streams.length) { await tgSend(chatId, 'Эфир заведения ещё не запущен, запись поставить некуда.'); return; }
  const f = await tgApi('getFile', { file_id: fileId });
  const path = f?.result?.file_path;
  if (!path) { await tgSend(chatId, 'Не удалось получить файл. Если он больше 20 МБ, пришлите короче.'); return; }
  const res = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) { await tgSend(chatId, 'Не удалось скачать запись, попробуйте ещё раз.'); return; }
  const fs = await import('fs/promises');
  const stamp = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const src = `/tmp/venue-voice-${venueUserId.slice(0, 8)}-${stamp}`;
  const out = `${src}.mp3`;
  try {
    await fs.writeFile(src, Buffer.from(await res.arrayBuffer()));
    await ffmpeg(['-y', '-i', src, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-ac', '2', '-b:a', '128k', out]);
    const n = await putToPodcastDirs(streams, out, `voice_${stamp}.mp3`);
    if (!n) throw new Error('copy failed');
    await pool.query(`INSERT INTO venue_air_log (venue_user_id, kind, title) VALUES ($1, 'voice', 'Запись из Telegram')`, [venueUserId]);
    await tgSend(chatId, '🎙 Запись в эфире: прозвучит в ближайший час с 10:00 до 22:00.');
  } catch (e: any) {
    console.warn('[venue-air] voice', e?.message);
    await tgSend(chatId, 'Не получилось обработать запись. Пришлите голосовое или аудиофайл ещё раз.');
  } finally {
    fs.unlink(src).catch(() => {});
    fs.unlink(out).catch(() => {});
  }
}

// ─── Планировщик: ведущие и дневной подкаст ───────────────────────────────

let tickRunning = false;
const autoPodcastTried = new Map<string, string>(); // venue → дата МСК

async function studioTick() {
  if (tickRunning || !INTERNAL_KEY) return;
  tickRunning = true;
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, s.stream_url, s.host_enabled, r.ai_host_config, r.format,
              (SELECT max(created_at) FROM venue_air_log l WHERE l.stream_id = s.id AND l.kind = 'host') AS last_host
         FROM venue_station_streams s
         LEFT JOIN LATERAL (
           SELECT ai_host_config, format FROM venue_station_requests q
            WHERE q.id = s.request_id OR q.user_id = s.user_id
            ORDER BY (q.id = s.request_id) DESC NULLS LAST, q.created_at DESC LIMIT 1
         ) r ON true
        WHERE s.status IN ('live', 'provisioned') AND s.device_token_hash IS NOT NULL
          AND s.last_seen_at > now() - make_interval(secs => $1)
          AND s.stream_url ~ '/air/live/venue-'`,
      [DEVICE_ONLINE_SEC],
    );
    const t = mskContext();
    for (const s of rows) {
      const cfg: HostCfg = { ...(s.ai_host_config || {}), airType: s.format?.airType };
      const enabled = s.host_enabled === true || (s.host_enabled !== false && cfg.airType === 'full_radio');
      if (!enabled) continue;
      const venueUserId = String(s.user_id);
      // Раз в день подкаст о заведении, если есть повестка (с 12 до 20 МСК).
      if (t.h >= 12 && t.h < 20 && autoPodcastTried.get(venueUserId) !== t.date) {
        autoPodcastTried.set(venueUserId, t.date);
        if ((await podcastsToday(venueUserId)) === 0 && (await activeAgenda(venueUserId)).length) {
          await startVenuePodcast(venueUserId, null, null).catch(() => {});
        }
      }
      const everyMin = clamp(Number(s.ai_host_config?.intervalMinutes) || HOST_DEFAULT_MIN, 15, 180);
      if (s.last_host && Date.now() - new Date(s.last_host).getTime() < everyMin * 60_000) continue;
      const m = String(s.stream_url).match(VENUE_MOUNT_RE);
      const port = m ? await venueDjPort(m[1]) : null;
      if (!port) continue;
      await airHost(String(s.id), venueUserId, port, cfg).catch((e) => console.warn('[venue-air] host', e?.message));
    }
  } catch (e: any) {
    console.warn('[venue-air] tick', e?.message);
  } finally {
    tickRunning = false;
  }
}

if (process.env.VENUE_AIR_STUDIO !== '0') {
  setTimeout(() => { setInterval(() => { studioTick(); }, 60_000); }, 30_000);
}

// ─── Telegram: сообщения от voice-bot.mjs ─────────────────────────────────

const HELP = (venue: string) => `Бот радио «${esc(venue)}» в ПРОМО.ЭИР.

✍️ Напишите новость текстом: новое меню, событие, акция. Ведущие расскажут о ней гостям в ближайших выходах в эфир.
🎙 Пришлите голосовое или аудиофайл: запись прозвучит в эфире в ближайший час с 10:00 до 22:00.

/agenda — повестка ведущих
/del N — убрать пункт N
/clear — очистить повестку
/podcast [тема] — собрать подкаст о заведении (до ${PODCASTS_PER_DAY} в день)
/channel @канал — дублировать новости в ваш Telegram-канал (бот должен быть админом канала); /channel off — выключить
/stop — отключить этот чат`;

async function linkByChat(chatId: string) {
  const { rows } = await pool.query(`SELECT * FROM venue_air_telegram WHERE chat_id = $1`, [chatId]);
  return rows[0] || null;
}

app.post('/tg/update', async (c) => {
  if (!INTERNAL_KEY || c.req.header('X-Internal-Key') !== INTERNAL_KEY) return c.json({ error: 'Unauthorized' }, 401);
  const body: any = await c.req.json().catch(() => ({}));
  const msg = body?.message;
  if (!msg?.chat?.id) return c.json({ handled: false });
  const chatId = String(msg.chat.id);
  const text = String(msg.text || msg.caption || '').trim();
  try {
    // Бота читает и голосовой помощник владельца (voice-bot.mjs): чужой /start без кода
    // и сообщения непривязанных чатов не трогаем — handled:false, их обработает он.
    const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
    if (start && !start[1]) {
      const link = await linkByChat(chatId);
      if (link) return c.json({ handled: true, reply: HELP(await venueNameFor(link.venue_user_id).catch(() => 'заведения')) });
      return c.json({ handled: false });
    }
    if (start && /^[A-Z2-9]{8}$/i.test(start[1] || '')) {
      const code = String(start[1]).toUpperCase();
      const { rows } = await pool.query(
        `UPDATE venue_air_telegram
            SET chat_id = $2, chat_title = $3, linked_at = now(), link_code = NULL, link_code_expires = NULL, updated_at = now()
          WHERE link_code = $1 AND link_code_expires > now()
          RETURNING venue_user_id`,
        [code, chatId, String(msg.chat.title || [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.chat.username || 'чат')],
      ).catch(async (e: any) => {
        // Чат уже привязан к другому заведению (unique chat_id) — отвязываем старую привязку.
        if (String(e?.code) === '23505') {
          await pool.query(`UPDATE venue_air_telegram SET chat_id = NULL WHERE chat_id = $1`, [chatId]);
          return pool.query(
            `UPDATE venue_air_telegram SET chat_id = $2, linked_at = now(), link_code = NULL, link_code_expires = NULL, updated_at = now()
              WHERE link_code = $1 AND link_code_expires > now() RETURNING venue_user_id`, [code, chatId]);
        }
        throw e;
      });
      if (!rows[0]) return c.json({ handled: true, reply: 'Код не найден или истёк. Возьмите новый в кабинете заведения: «Студия эфира» → «Telegram».' });
      const venue = await venueNameFor(rows[0].venue_user_id).catch(() => 'заведения');
      return c.json({ handled: true, reply: `✅ Чат подключён к радио «${esc(venue)}».\n\n${HELP(venue)}` });
    }

    const link = await linkByChat(chatId);
    if (!link) return c.json({ handled: false });
    const venueUserId = String(link.venue_user_id);
    const venue = await venueNameFor(venueUserId).catch(() => 'заведения');

    const audio = msg.voice || msg.audio || (msg.document && /^audio\//.test(msg.document.mime_type || '') ? msg.document : null);
    if (audio?.file_id) {
      telegramAudioToAir(venueUserId, audio.file_id, chatId).catch(() => {});
      return c.json({ handled: true, reply: 'Принял запись, готовлю к эфиру…' });
    }
    if (!text) return c.json({ handled: true, reply: 'Пришлите новость текстом или голосовое сообщение. /help — что умеет бот.' });

    if (/^\/help/i.test(text)) return c.json({ handled: true, reply: HELP(venue) });
    if (/^\/agenda/i.test(text)) {
      const items = await activeAgenda(venueUserId);
      if (!items.length) return c.json({ handled: true, reply: 'Повестка пуста. Напишите новость заведения, и ведущие расскажут о ней в эфире.' });
      const list = items.map((it: any, i: number) => `${i + 1}. ${esc(it.text)}${it.aired_count ? ` <i>(в эфире ${timesRu(it.aired_count)})</i>` : ''}`).join('\n');
      return c.json({ handled: true, reply: `Повестка ведущих:\n\n${list}\n\n/del N — убрать пункт` });
    }
    const del = text.match(/^\/del(?:@\w+)?\s+(\d+)/i);
    if (del) {
      const items = await activeAgenda(venueUserId);
      const it = items[Number(del[1]) - 1];
      if (!it) return c.json({ handled: true, reply: 'Нет такого пункта. /agenda — список.' });
      await pool.query(`UPDATE venue_air_agenda SET active = false WHERE id = $1`, [it.id]);
      return c.json({ handled: true, reply: `Убрал: «${esc(it.text)}»` });
    }
    if (/^\/clear/i.test(text)) {
      await pool.query(`UPDATE venue_air_agenda SET active = false WHERE venue_user_id = $1 AND active = true`, [venueUserId]);
      return c.json({ handled: true, reply: 'Повестка очищена.' });
    }
    const pod = text.match(/^\/podcast(?:@\w+)?\s*(.*)$/is);
    if (pod) {
      const r = await startVenuePodcast(venueUserId, pod[1] || null, chatId);
      return c.json({ handled: true, reply: r.ok ? '🎙 Собираю подкаст о заведении, это займёт пару минут. Напишу, когда будет готов.' : esc(r.error || 'Не получилось') });
    }
    const chm = text.match(/^\/channel(?:@\w+)?\s*(\S*)/i);
    if (chm) {
      const arg = chm[1];
      if (!arg || /^off$/i.test(arg)) {
        await pool.query(`UPDATE venue_air_telegram SET channel_id = NULL, channel_title = NULL, updated_at = now() WHERE venue_user_id = $1`, [venueUserId]);
        return c.json({ handled: true, reply: arg ? 'Дублирование в канал выключено.' : 'Укажите канал: /channel @имя_канала. Бота нужно добавить администратором канала с правом публикации.' });
      }
      const chat = await tgApi('getChat', { chat_id: arg.startsWith('@') || arg.startsWith('-') ? arg : `@${arg}` });
      const bot = await getBot();
      if (!chat?.ok || !bot) return c.json({ handled: true, reply: 'Канал не найден. Проверьте имя: /channel @имя_канала' });
      const member = await tgApi('getChatMember', { chat_id: chat.result.id, user_id: bot.id });
      const st = member?.result?.status;
      if (!(st === 'administrator' || st === 'creator') || member?.result?.can_post_messages === false) {
        return c.json({ handled: true, reply: `Добавьте @${esc(bot.username || BOT_USERNAME)} администратором канала с правом публикации и повторите команду.` });
      }
      await pool.query(
        `UPDATE venue_air_telegram SET channel_id = $2, channel_title = $3, updated_at = now() WHERE venue_user_id = $1`,
        [venueUserId, String(chat.result.id), String(chat.result.title || arg)],
      );
      return c.json({ handled: true, reply: `✅ Новости будут дублироваться в канал «${esc(chat.result.title || arg)}».` });
    }
    if (/^\/stop/i.test(text)) {
      await pool.query(`UPDATE venue_air_telegram SET chat_id = NULL, updated_at = now() WHERE venue_user_id = $1`, [venueUserId]);
      return c.json({ handled: true, reply: 'Чат отключён от радио заведения. Подключить снова можно по ссылке из кабинета.' });
    }
    if (text.startsWith('/')) return c.json({ handled: true, reply: HELP(venue) });

    const r = await addAgenda(venueUserId, text, 'telegram');
    if ('error' in r) return c.json({ handled: true, reply: esc(String(r.error)) });
    return c.json({
      handled: true,
      reply: `✅ В повестке ведущих: «${esc(r.text)}».\nВедущие расскажут об этом гостям в ближайших выходах в эфир.${r.channel ? `\nПродублировал в канал «${esc(r.channel)}».` : ''}`,
    });
  } catch (e: any) {
    console.error('[venue-air] tg', e?.message);
    return c.json({ handled: true, reply: 'Что-то пошло не так, попробуйте ещё раз.' });
  }
});

// ─── Кабинет заведения ────────────────────────────────────────────────────

app.get('/my', requireAuth, async (c) => {
  try {
    const venueUserId = String(c.get('userId'));
    const [streams, cfg, agenda, tg, log, today, bot] = await Promise.all([
      venueStreams(venueUserId),
      hostConfigFor(venueUserId),
      activeAgenda(venueUserId),
      pool.query(`SELECT chat_id, chat_title, channel_title, linked_at FROM venue_air_telegram WHERE venue_user_id = $1`, [venueUserId]),
      pool.query(
        `SELECT kind, title, text, status, created_at FROM venue_air_log WHERE venue_user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [venueUserId],
      ),
      podcastsToday(venueUserId),
      getBot(),
    ]);
    const [host] = hostNames(venueUserId, cfg.voice);
    const hostOn = streams.some((s) => s.hostEnabled === true || (s.hostEnabled !== false && cfg.airType === 'full_radio'));
    const t = tg.rows[0];
    return c.json({
      success: true,
      data: {
        hasStream: streams.length > 0,
        streams: streams.map((s) => ({ id: s.id, pointName: s.pointName, online: s.online })),
        host: {
          name: host, enabled: hostOn, voice: cfg.voice || 'female', style: cfg.style || 'relaxed',
          intervalMinutes: clamp(Number(cfg.intervalMinutes) || HOST_DEFAULT_MIN, 15, 180),
        },
        agenda: agenda.map((it: any) => ({
          id: String(it.id), text: it.text, source: it.source, expiresAt: iso(it.expires_at),
          airedCount: it.aired_count || 0, lastAiredAt: iso(it.last_aired_at), createdAt: iso(it.created_at),
        })),
        telegram: {
          linked: !!t?.chat_id, chatTitle: t?.chat_title || null, channelTitle: t?.channel_title || null,
          botUsername: bot?.username || BOT_USERNAME,
        },
        podcasts: { today, limit: PODCASTS_PER_DAY, building: podcastRunning.has(venueUserId) },
        log: log.rows.map((r: any) => ({ kind: r.kind, title: r.title, text: r.text, status: r.status, createdAt: iso(r.created_at) })),
      },
    });
  } catch (e: any) {
    console.error('[venue-air] my', e?.message);
    return c.json({ success: false, error: 'Не удалось загрузить студию' }, 500);
  }
});

app.post('/my/agenda', requireAuth, async (c) => {
  const venueUserId = String(c.get('userId'));
  const body: any = await c.req.json().catch(() => ({}));
  const r = await addAgenda(venueUserId, body?.text, 'cabinet', body?.expiresAt || null);
  if ('error' in r) return c.json({ success: false, error: r.error }, 400);
  return c.json({ success: true, data: r });
});

app.delete('/my/agenda/:id', requireAuth, async (c) => {
  const venueUserId = String(c.get('userId'));
  const id = c.req.param('id');
  if (!/^\d+$/.test(id)) return c.json({ success: false, error: 'Неверный пункт' }, 400);
  await pool.query(`UPDATE venue_air_agenda SET active = false WHERE id = $1 AND venue_user_id = $2`, [id, venueUserId]);
  return c.json({ success: true });
});

app.post('/my/podcast', requireAuth, async (c) => {
  const venueUserId = String(c.get('userId'));
  const body: any = await c.req.json().catch(() => ({}));
  const r = await startVenuePodcast(venueUserId, body?.topic || null, null);
  if (!r.ok) return c.json({ success: false, error: r.error }, 400);
  return c.json({ success: true, data: { started: true } }, 202);
});

app.post('/my/telegram/code', requireAuth, async (c) => {
  const venueUserId = String(c.get('userId'));
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  await pool.query(
    `INSERT INTO venue_air_telegram (venue_user_id, link_code, link_code_expires, updated_at)
     VALUES ($1, $2, now() + interval '24 hours', now())
     ON CONFLICT (venue_user_id) DO UPDATE SET link_code = EXCLUDED.link_code, link_code_expires = EXCLUDED.link_code_expires, updated_at = now()`,
    [venueUserId, code],
  );
  const bot = await getBot();
  const username = bot?.username || BOT_USERNAME;
  return c.json({ success: true, data: { code, link: `https://t.me/${username}?start=${code}`, botUsername: username } });
});

app.post('/my/telegram/unlink', requireAuth, async (c) => {
  const venueUserId = String(c.get('userId'));
  await pool.query(`UPDATE venue_air_telegram SET chat_id = NULL, channel_id = NULL, channel_title = NULL, updated_at = now() WHERE venue_user_id = $1`, [venueUserId]);
  return c.json({ success: true });
});

// ─── Админ ────────────────────────────────────────────────────────────────

app.post('/admin/streams/:id/host', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  const body: any = await c.req.json().catch(() => ({}));
  const v = body?.enabled === true ? true : body?.enabled === false ? false : null;
  const { rowCount } = await pool.query(`UPDATE venue_station_streams SET host_enabled = $2 WHERE id::text = $1`, [id, v]);
  return c.json({ success: !!rowCount, data: { hostEnabled: v } });
});

// Выход ведущего прямо сейчас (проверка звучания).
app.post('/admin/streams/:id/host-now', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  const { rows } = await pool.query(`SELECT id, user_id, stream_url FROM venue_station_streams WHERE id::text = $1`, [id]);
  const s = rows[0];
  const m = s ? String(s.stream_url || '').match(VENUE_MOUNT_RE) : null;
  const port = m ? await venueDjPort(m[1]) : null;
  if (!s || !port) return c.json({ success: false, error: 'Поток не найден или не запущен' }, 404);
  try {
    const r = await airHost(String(s.id), String(s.user_id), port, await hostConfigFor(String(s.user_id)), true);
    return c.json({ success: true, data: { result: r } });
  } catch (e: any) {
    return c.json({ success: false, error: e?.message || 'ошибка' }, 500);
  }
});

export default app;
