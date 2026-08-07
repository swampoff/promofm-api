#!/usr/bin/env node
/**
 * ПРОМО.ФМ Podcast Engine — pre-render MP3 outputs + play queue.
 *
 * Двойной цикл в одном процессе:
 *   BUILDER — каждые BUILD_INTERVAL_SEC секунд:
 *     если в очереди (QUEUE_DIR) меньше QUEUE_TARGET готовых MP3 →
 *       1. nextTopic() (логика из podcast-live.mjs)
 *       2. Gemini 3 Flash → JSON-диалог
 *       3. Для каждой реплики: gemini-proxy /tts-stream → PCM L16 24kHz mono
 *       4. Конкатенация PCM с silence-gap 1.5s → один большой PCM
 *       5. ffmpeg → MP3 в QUEUE_DIR/episode_<ts>.mp3
 *       6. Сайдкар .json с topic+turns для пост-broadcast уборки
 *
 *   PLAYER — каждые PLAY_INTERVAL_SEC секунд:
 *     если очередь не пуста и AutoDJ не занят:
 *       1. Берём САМЫЙ старый MP3
 *       2. ffmpeg MP3 → PCM L16 24kHz mono
 *       3. POST /api/inject (AutoDJ overlay)
 *       4. На успех: удаляем MP3, удаляем .json, помечаем items used,
 *          удаляем news из БД
 *       5. На 423 busy: ждём, ретрай
 *
 * ЗАКОН: прозвучал → удалён, повтор невозможен.
 */

import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer as _httpCreate } from 'node:http';
import { join } from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const INTERNAL_KEY = process.env.INTERNAL_KEY || process.env.VPS_INTERNAL_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL || 'http://187.77.85.42:8088';
const GEMINI_PROXY_KEY = process.env.GEMINI_PROXY_KEY || 'promofm-gemini-2026';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3-flash-preview';
const AUTODJ_URL = process.env.AUTODJ_URL || 'http://127.0.0.1:8087';

const QUEUE_DIR = process.env.PODCAST_QUEUE_DIR || '/opt/promofm-podcast/queue';
const QUEUE_TARGET = parseInt(process.env.QUEUE_TARGET || '3', 10);
const BUILD_INTERVAL_SEC = parseInt(process.env.BUILD_INTERVAL_SEC || '600', 10);   // 10 min
const PLAY_INTERVAL_SEC = parseInt(process.env.PLAY_INTERVAL_SEC || '1800', 10);    // 30 min full episodes
const COMMENT_INTERVAL_SEC = parseInt(process.env.COMMENT_INTERVAL_SEC || '720', 10); // 12 min short track-aware comments
const PODCAST_MIN_TURNS = parseInt(process.env.PODCAST_MIN_TURNS || '5', 10);
const PODCAST_MAX_TURNS = parseInt(process.env.PODCAST_MAX_TURNS || '8', 10);
const TURN_GAP_MS = parseInt(process.env.TURN_GAP_MS || '3000', 10);
const SAMPLE_RATE = 24000; // Gemini Live TTS output

const USED_ITEMS_PATH = process.env.USED_ITEMS_PATH || '/opt/promofm-podcast/used-items.json';
const DISCOVERY_CACHE = process.env.DISCOVERY_CACHE || '/opt/promofm-podcast/discovery-cache.json';

if (!INTERNAL_KEY) { console.error('[engine] INTERNAL_KEY required'); process.exit(1); }

// ─── Helpers ─────────────────────────────────────────────────────────
async function ensureDir(d) { try { await mkdir(d, { recursive: true }); } catch {} }

async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(t); }
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }

// ─── Hosts / Topics / Prompt — imported from podcast-live ──────────
// Все нужные функции продублированы ниже

const HOST_PAIRS = [
  ['Лиана', 'Марк'], ['Стелла', 'DJ Den'], ['Сандра', 'Макс'],
  ['Нико', 'Пабло'], ['РадКат', 'Лиана'], ['Марк', 'Стелла'],
];
const HOST_DESC = {
  'DJ Den': 'ведущий ПРОМО.МУЗЫКА. Электронная сцена. Спокойный, аргументированный, образованный тон.',
  'Сандра': 'ведущая ПРОМО.МУЗЫКА. Поп-сцена и R&B. Тон серьёзного культурного издания.',
  'Лиана': 'ведущая ПРОМО.МУЗЫКА. Аналитик. Журнал \"Афиша\" / Радио Культура — этот регистр.',
  'Макс': 'ведущий ПРОМО.МУЗЫКА. Рок и инди. Стиль печатного критика.',
  'Марк': 'ведущий ПРОМО.МУЗЫКА. Хип-хоп и R&B. Подача как у репортёра большого издания. Без \"бро\", \"чувак\".',
  'Пабло': 'ведущий ПРОМО.МУЗЫКА. Мировая музыка. Литературный язык.',
  'Нико': 'ведущий ПРОМО.МУЗЫКА. Классика, академическая, джаз. Эрудированный.',
  'РадКат': 'ведущая ПРОМО.МУЗЫКА. Технологии и AI в музыке. Аналитическая.',
  'Стелла': 'ведущая ПРОМО.МУЗЫКА. Культурный комментатор. Душевная, но сдержанная.',
};

const TOPIC_KINDS = [
  'news', 'new_releases', 'concerts',
  'feature_artists', 'feature_djs', 'feature_producers',
  'feature_venues', 'feature_radio',
  'feature_check', 'feature_lab', 'feature_360', 'feature_air', 'feature_label',
  'feature_distribution', 'community', 'platform_pulse', 'roles_overview', 'coming_features',
];
let topicIndex = Math.floor(Math.random() * TOPIC_KINDS.length); // рандомный старт

// ─── Dedup helpers ───────────────────────────────────────────────────
async function loadUsedItems() {
  try { return JSON.parse(await readFile(USED_ITEMS_PATH, 'utf8')); }
  catch { return { news: {}, tracks: {}, concerts: {} }; }
}
async function saveUsedItems(u) {
  try { await writeFile(USED_ITEMS_PATH, JSON.stringify(u)); } catch (e) { console.warn(`[engine] save used: ${e.message}`); }
}
function dedupKeyNews(n) { return (n.id || (n.title || '').toLowerCase().trim()).slice(0, 80); }
function dedupKeyTrack(t) { return ((t.artist || '') + '|' + (t.title || '')).toLowerCase().trim(); }
function dedupKeyConcert(c) { return ((c.artist || '') + '|' + (c.city || '') + '|' + (c.date || c.event_date || '')).toLowerCase().trim(); }

async function markUsed(used, bucket, key) {
  used[bucket] = used[bucket] || {};
  used[bucket][key] = Date.now();
  await saveUsedItems(used);
}

// ─── News music-filter (как в podcast-live) ────────────────────────
const NEWS_REJECT = ['биржа','фондов','курс рубля','курс доллара','нефть','индекс','ввп','цб рф','центробанк','ставк','инфляц','санкци','минфин','налог','правительств','кремль','дума','минцифр','минздрав','выборы','футбол','хоккей','олимпиад','чемпионат мира','мчс','дтп','пожар','погода','циклон','наводнен','землетрясен'];
const NEWS_ALLOW = ['музык','трек','альбом','релиз','клип','песн','певец','певиц','артист','рэпер','рэп','хип-хоп','рок','поп','инди','электрон','концерт','тур ','фестиваль','дж','диджей','dj ','микс','сингл','лейбл','продюсер','композит','премьер','клипа','spotify','apple music','яндекс музык','вк музык','youtube music','shazam','грэмми','mtv','pitchfork','звукозапис'];

function isMusicNews(n) {
  const txt = ((n.title || '') + ' ' + (n.excerpt || '') + ' ' + (n.content || '')).toLowerCase();
  for (const k of NEWS_REJECT) if (txt.includes(k)) return false;
  const cat = (n.category || '').toLowerCase();
  if (cat.includes('music') || cat.includes('музык') || cat.includes('релиз') || cat.includes('концерт')) return true;
  for (const k of NEWS_ALLOW) if (txt.includes(k)) return true;
  return false;
}

// ─── Topic sources ──────────────────────────────────────────────────
async function topicNews(used) {
  const r = await fetchJSON(`${API_BASE}/server/api/news?limit=20`);
  if (!r.ok || !Array.isArray(r.data)) return null;
  const all = r.data.filter(isMusicNews).filter(n => !used.news[dedupKeyNews(n)]);
  if (!all.length) return null;
  const picked = all.slice(0, 1);
  const items = picked.map(n => ({
    id: n.id, title: n.title || '',
    excerpt: clamp((n.excerpt || '').replace(/\s+/g, ' '), 600),
    content: clamp((n.content || '').replace(/\s+/g, ' '), 1200),
    category: n.category || '', source: n.source || '',
  }));
  return { kind: 'Новости музыки', intro: 'одна свежая музыкальная история целиком, без списков', items, items_kind: 'news' };
}

async function topicNewReleases(used) {
  const r = await fetchJSON(`${API_BASE}/server/api/landing-data/new-releases?limit=20`);
  if (!r.ok || !r.data?.data?.tracks?.length) return null;
  const fresh = r.data.data.tracks.filter(t => !used.tracks[dedupKeyTrack(t)]);
  if (fresh.length < 1) return null;
  // ОДИН ТРЕК — глубокий разговор. Не перечисление.
  const picked = fresh.slice(0, 1);
  const items = picked.map(t => ({
    title: t.title, artist: t.artist,
    isOurArtist: !!t.isOurArtist, source: t.sourceLabel || t.source || '',
  }));
  return {
    kind: 'Свежий релиз',
    intro: 'один свежий трек — полноценное обсуждение: артист, звучание, контекст. Не перечисление списка.',
    items, items_kind: 'tracks',
  };
}

async function topicConcerts(used) {
  const r = await fetchJSON(`${API_BASE}/server/api/concerts/public?limit=30`);
  if (!r.ok || !Array.isArray(r.data)) return null;
  const norm = c => ({
    artist: c.artist_name || c.title || '', city: c.city || '',
    venue: c.venue_name || '', date: c.event_date || '',
    description: (c.description || '').slice(0, 300),
  });
  const fresh = r.data.map(norm).filter(c => !used.concerts[dedupKeyConcert(c)]);
  if (fresh.length < 1) return null;
  // ОДИН концерт — детальный анонс.
  return {
    kind: 'Анонс концерта',
    intro: 'один ближайший концерт — детальный анонс: артист, площадка, ожидания. Не общий список афиши.',
    items: fresh.slice(0, 1), items_kind: 'concerts',
  };
}

const FEATURE_TOPICS = {
  feature_artists: { kind: 'Возможности для артистов', intro: 'кабинет артиста на ПРОМО.МУЗЫКА', items: [
    { topic: 'Личный кабинет артиста — релизы, обложки, теги, ISRC' },
    { topic: 'Размещение треков на ПРОМО.ФМ и в Новинках недели' },
    { topic: 'Донаты от слушателей — прямые выплаты' },
    { topic: 'Скоро — дистрибуция в Яндекс.Музыку, VK, Spotify' },
  ], items_kind: 'features' },
  feature_djs: { kind: 'Возможности для диджеев', intro: 'кабинет диджея', items: [
    { topic: 'Маркетплейс — клиенты бронируют напрямую' },
    { topic: 'Загрузка миксов с прослушиваниями' },
    { topic: 'Календарь и приватные сообщения' },
  ], items_kind: 'features' },
  feature_producers: { kind: 'Возможности для продюсеров', intro: 'битстор + заказы', items: [
    { topic: 'Битстор с lease/exclusive лицензиями' },
    { topic: 'Заказы микса и мастеринга' },
    { topic: 'Прозрачные роялти и портфолио' },
  ], items_kind: 'features' },
  feature_venues: { kind: 'Возможности для заведений', intro: 'фоновая музыка + лицензии', items: [
    { topic: 'Лицензированная фоновая музыка для бизнеса' },
    { topic: 'Бронирование диджеев' },
    { topic: 'Анонсы событий на ПРОМО.МУЗЫКА и ПРОМО.ФМ' },
  ], items_kind: 'features' },
  feature_radio: { kind: 'Возможности для радиостанций', intro: 'кабинет радиостанции: заявки от артистов, аналитика эфира, монетизация рекламными слотами, интеграция с ПРОМО.ФМ для расширения аудитории', items: [
    { topic: 'Заявки от артистов — упорядоченная очередь, не хаос в почте' },
    { topic: 'Аналитика эфира — кто/что/сколько раз/в каких городах' },
    { topic: 'Монетизация — рекламные слоты и брендированные программы' },
    { topic: 'Интеграция с ПРОМО.ФМ для расширения аудитории станции' },
  ], items_kind: 'features' },

  feature_label: { kind: 'НОВОЕ: Кабинет лейбла на ПРОМО.МУЗЫКА',
    intro: 'свежий запуск 22 мая 2026 — кабинет лейбла. Это переворот для независимых российских лейблов: централизованное управление ростером артистов, релизами от их имени и агрегированной аналитикой',
    items: [
      { topic: 'Ростер артистов: приглашение → артист подтверждает участие из своего кабинета (обоюдное согласие)' },
      { topic: 'Публикация релизов от имени артистов — pay-on-approval (лейбл платит, артист публикуется бесплатно)' },
      { topic: 'Агрегированная аналитика по всему ростеру: прослушивания, ротации, доходы' },
      { topic: 'Прямой выход в "Новинки недели" платформы и эфир ПРОМО.ФМ' },
      { topic: 'Публичная страница лейбла /labels/<slug> — витрина артистов, биография, каталог' },
      { topic: 'Real-time уведомления о новых релизах артистов ростера через SSE' },
      { topic: 'Регистрация: выбор роли "Лейбл" в форме входа на promo-music.ru, кабинет открывается сразу' },
    ], items_kind: 'features' },

  roles_overview: { kind: 'Структура ПРОМО.МУЗЫКА — все 6 ролей в одном выпуске',
    intro: 'детальный разбор ролей платформы: артист, диджей, продюсер, заведение, радиостанция, лейбл. Что каждый получает, как роли взаимодействуют, почему это комьюнити, а не B2B',
    items: [
      { topic: 'Артист — главная единица: треки, донаты прямо на карту, аналитика ротаций, эфир ПРОМО.ФМ, скоро дистрибуция в стриминги' },
      { topic: 'Диджей — миксы, сеты, бронирование от заведений, эфирные программы через коллаб с радио' },
      { topic: 'Продюсер / саунд-инженер — битстор, заказы микса и мастеринга, портфолио, прозрачные роялти' },
      { topic: 'Заведение — лицензированная фоновая музыка (без претензий РАО), бронирование диджеев, брендированные плейлисты' },
      { topic: 'Радиостанция — структурированная очередь заявок, аналитика эфира, монетизация рекламы' },
      { topic: 'Лейбл (НОВОЕ) — ростер артистов, релизы от их имени, агрегированная аналитика по каталогу' },
      { topic: 'Главный принцип — каждый помогает артисту расти, не извлекает ренту' },
      { topic: 'Все кабинеты бесплатны, регистрация на promo-music.ru с выбором роли' },
    ], items_kind: 'features' },
  feature_check: { kind: 'ПРОМО.CHECK — мониторинг радио + AI-детекция', intro: 'ПРОМО.CHECK слушает эфир, fingerprint каждые 30с, AI-детектор 80%, watermark в треках артистов = автоматический учёт ротаций', items: [
    { topic: 'Мониторинг сотен радиостанций 24/7' },
    { topic: 'AI-детектор: распознаёт нейросетевые треки на 80%' },
    { topic: 'Watermark в треках артистов ПРОМО.МУЗЫКА — авто-учёт ротаций' },
    { topic: 'Отдельный AI-чарт для нейро-авторов (Suno, Udio, Mubert)' },
    { topic: 'Бесплатно для всех зарегистрированных артистов' },
  ], items_kind: 'features' },
  feature_lab: { kind: 'ПРОМО.LAB — экспертная оценка трека', intro: '10 критериев, эксперты индустрии + AI-анализ, 2-72 часа', items: [
    { topic: '10 критериев: продюсирование, мелодия, вокал, текст, микс, потенциал и пр.' },
    { topic: 'Эксперты: продюсеры, журналисты, A&R лейблов' },
    { topic: 'AI-анализ + конкретный отчёт что улучшить' },
  ], items_kind: 'features' },
  feature_360: { kind: 'ПРОМО 360 — видео и дизайн', intro: 'клипы, обложки, монтаж, оформление соцсетей', items: [
    { topic: 'Видеоклипы и лирик-видео под ключ' },
    { topic: 'Дизайн обложек альбомов и синглов' },
    { topic: 'Монтаж выступлений и тизеров' },
  ], items_kind: 'features' },
  feature_air: { kind: 'ПРОМО.ФМ — радио платформы', intro: 'радио ПРОМО.МУЗЫКА', items: [
    { topic: 'Эфир 24/7 — автоDJ + AI-ведущие' },
    { topic: 'Аналитика для артистов — сколько раз сыграл трек' },
    { topic: 'Слушать: promo-music.ru/air' },
  ], items_kind: 'features' },
  feature_distribution: { kind: 'Скоро — дистрибуция в стриминги', intro: 'дистрибуция в стриминги из кабинета', items: [
    { topic: 'Один upload — везде: Яндекс.Музыка, VK, Spotify, Apple Music, YouTube Music, СберЗвук' },
    { topic: 'Аналитика по всем платформам в одном дашборде' },
    { topic: 'Прозрачные роялти, выплаты без минимального порога' },
    { topic: 'Early access — оставь email на promo-music.ru, -50% первый год' },
  ], items_kind: 'features' },
  community: { kind: 'Что такое ПРОМО.МУЗЫКА — комьюнити, не B2B', intro: 'не платформа \"бизнес для бизнеса\", а музыкальное комьюнити нового времени', items: [
    { topic: 'Артист — центр экосистемы, остальные участники помогают ему расти' },
    { topic: 'Не маркетплейс с агентами, а прямые связи между участниками' },
    { topic: 'Цель — развитие музыкальной культуры, а не извлечение ренты' },
    { topic: 'Регистрация бесплатна для всех ролей' },
  ], items_kind: 'features' },
  coming_features: { kind: 'Что планируется в эфире ПРОМО.ФМ', intro: 'миксы, лайвы, интервью', items: [
    { topic: 'Авторские миксы диджеев ПРОМО.МУЗЫКА' },
    { topic: 'Лайв-сеты с вечеринок' },
    { topic: 'Интервью с артистами платформы' },
    { topic: 'Гостевые включения продюсеров с разборами треков' },
    { topic: 'Тематические программы по жанрам' },
  ], items_kind: 'features' },
};

async function topicPlatformPulse(used) {
  try {
    const d = JSON.parse(await readFile(DISCOVERY_CACHE, 'utf8'));
    const items = [];
    if (d.stats) items.push({ topic: `На платформе ${d.stats.totalArtists || 0} артистов, ${d.stats.publishedTracks || 0} треков, ${d.stats.totalUsers || 0} участников` });
    if (d.artists?.fresh?.length) {
      const names = d.artists.fresh.slice(0, 4).map(a => a.name).filter(Boolean).join(', ');
      if (names) items.push({ topic: `Свежие артисты на платформе: ${names}` });
    }
    if (d.tracks?.composite_chart?.length) {
      const top = d.tracks.composite_chart.slice(0, 4).map(t => `${t.artist} — «${t.title}»`).join('; ');
      items.push({ topic: `Композитный чарт сегодня: ${top}` });
    }
    if (items.length < 3) return null;
    return { kind: 'Пульс ПРОМО.МУЗЫКА', intro: `живая статистика платформы (${d.updatedAt})`, items, items_kind: 'features' };
  } catch { return null; }
}

async function nextTopic(used) {
  for (let i = 0; i < TOPIC_KINDS.length; i++) {
    const kind = TOPIC_KINDS[topicIndex % TOPIC_KINDS.length];
    topicIndex++;
    let topic = null;
    try {
      if (kind === 'news') topic = await topicNews(used);
      else if (kind === 'new_releases') topic = await topicNewReleases(used);
      else if (kind === 'concerts') topic = await topicConcerts(used);
      else if (kind === 'platform_pulse') topic = await topicPlatformPulse(used);
      else topic = FEATURE_TOPICS[kind] || null;
    } catch (e) { console.warn(`[engine] topic ${kind} failed: ${e.message}`); }
    if (topic) return { topic, kind };
  }
  return { topic: FEATURE_TOPICS.feature_artists, kind: 'feature_artists' };
}

// ─── Gemini script ──────────────────────────────────────────────────
async function geminiGenerate(prompt) {
  const url = `${GEMINI_PROXY_URL}/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const r = await fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.85, maxOutputTokens: 4096, responseMimeType: 'application/json' },
    }),
    timeout: 90000,
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}


// ─── Time-of-day awareness для ведущих ────────────────────────────
function getTimeContext() {
  const now = new Date();
  const mskHour = (now.getUTCHours() + 3) % 24; // MSK = UTC+3
  let period, greeting;
  if (mskHour >= 5 && mskHour < 11) {
    period = 'утро';
    greeting = 'Доброе утро';
  } else if (mskHour >= 11 && mskHour < 17) {
    period = 'день';
    greeting = 'Добрый день';
  } else if (mskHour >= 17 && mskHour < 23) {
    period = 'вечер';
    greeting = 'Добрый вечер';
  } else {
    period = 'ночь';
    greeting = 'Доброй ночи';
  }
  const weekdays = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  return {
    period,
    greeting,
    mskHour,
    weekday: weekdays[now.getUTCDay()],
    day: now.getUTCDate(),
    month: months[now.getUTCMonth()],
    time_str: `${mskHour.toString().padStart(2,'0')}:${now.getUTCMinutes().toString().padStart(2,'0')} по Москве`,
  };
}

function buildPrompt(topic, hostA, hostB) {
  const itemsBlock = (topic.items || []).map((it, i) => {
    if (topic.items_kind === 'news')
      return `ЗАГОЛОВОК: ${it.title}\nОПИСАНИЕ: ${it.excerpt}\nТЕКСТ: ${it.content || ''}\nКатегория: ${it.category || ''} | Источник: ${it.source || ''}`;
    if (topic.items_kind === 'tracks')
      return `${i+1}. ${it.artist} — «${it.title}»${it.isOurArtist ? ' (артист Promo Music)' : ` [${it.source}]`}`;
    if (topic.items_kind === 'concerts')
      return `${i+1}. ${it.artist}, ${it.city}, ${it.venue}, ${it.date}`;
    return `${i+1}. ${it.topic}`;
  }).join('\n');

  return `Ты — сценарист эфира Promo Music (https://promo-music.ru/air) — медиа и радио о современной музыкальной сцене и независимых артистах.

═══════════════════════════════════════════
ОСНОВНЫЕ ЦЕЛИ ЭФИРА:
• Продвигать платформу Promo Music
• Рассказывать о новых артистах и релизах
• Формировать доверие к платформе
• Показывать возможности продвижения музыки
• Освещать конкурсы, эфиры, плейлисты, новости и интервью
• Поддерживать постоянную активность вокруг бренда
• Создавать ощущение живой музыкальной экосистемы

ЧТО ТАКОЕ Promo Music:
Современная музыкальная экосистема нового времени. Не «бизнес для бизнеса». Главная единица — артист. Радио, заведения, продюсеры, диджеи, мониторинг — это среда, помогающая артисту расти. Каждый — равноправный голос.
Состав: кабинеты артистов/диджеев/продюсеров/заведений/радиостанций (бесплатно), радио ПРОМО.ФМ 24/7, ПРОМО.CHECK (мониторинг радио + AI-детектор 80% + watermark-ротации + AI-чарт), ПРОМО.LAB (экспертная оценка трека по 10 критериям), ПРОМО 360 (видео/обложки/монтаж). Скоро — дистрибуция в Яндекс.Музыку, VK, Spotify, Apple Music, СберЗвук.

═══════════════════════════════════════════
ПОЗИЦИИ И ПРЕИМУЩЕСТВА (скрипт ведущих v1.0 — держи в голове весь эфир, отсюда бери аргументы и подводки):
• Легальность. Вся музыка лицензирована, РАО и ВОИС закрыты. Заведениям — ноль рисков и штрафов, авторам — честные роялти.
• Офлайн-ротация. Трек звучит не только в стримингах, а в реальных заведениях — кафе, бары, рестораны, фитнес, барбершопы, отели (Москва, Санкт-Петербург, Сочи и дальше).
• Роялти. Авторы, исполнители и лейблы получают выплаты за публичное исполнение. Мы не просто «крутим» — мы платим за эфир.
• Открытость независимым. Вход проще, чем в Epidemic Sound или к редакторам Spotify. Берём инструменталы, фоновую музыку, вокальные треки — даже без большой фан-базы.
• Свежесть. Новая подборка «Новинки недели» — каждую неделю, отобранная и готовая к эфиру.
• Полная легальная цепочка: создатель → лейбл → заведение → слушатель. Все в плюсе, всё по закону.
• Прозрачность. Отчётность по проигрываниям — артисту видно, где и сколько звучал его трек.

ПРАВИЛО ВЫПУСКА: минимум 3 преимущества из списка выше должны прозвучать за выпуск — естественно, в подводках и переходах, РАЗНЫМИ словами, не подряд и не рекламным блоком.

ПОДАЧА ТРЕКОВ (если в фактуре есть треки): артист и название, одна фраза о жанре и настроении, затем крючок — где трек особенно уместен (утренняя кофейня, вечерний бар, зал ресторана). После трека уместно напомнить: он в легальной ротации, автор получает роялти за каждое публичное проигрывание.

ПРОМО-ВСТАВКА ПО АУДИТОРИИ (одна за выпуск, выбирай по теме):
• Артистам и авторам: ротация в реальных заведениях — живая аудитория, которую не купишь накруткой, плюс роялти с прозрачной отчётностью; вход открыт даже без фан-базы.
• Заведениям: музыка в зале должна быть легальной — иначе претензии РАО и ВОИС со штрафами до полумиллиона рублей; Promo Music — готовое легальное радио: все права закрыты, ноль рисков.
• Лейблам и продюсерам: один договор — и каталог звучит в сотнях заведений, принося роялти; канал дохода, которого не дают стриминги.

═══════════════════════════════════════════
ВРЕМЯ ЭФИРА:
${(() => { const t = getTimeContext(); return `Сейчас ${t.weekday}, ${t.day} ${t.month}, ${t.time_str}. Время суток: ${t.period}. Приветствие — в духе "${t.greeting}". Никаких "добрый день" вечером, "вечер" утром. Используй соответствующую интонацию (утром бодрая, ночью спокойнее).`; })()}

═══════════════════════════════════════════
СТИЛЬ ПОДАЧИ:
• современный
• уверенный
• атмосферный
• музыкальный
• дружелюбный
• без сухого официоза, но спокойный
• без токсичности
• с ощущением индустрии и движения

Подача — как у ведущих современной музыкальной радиостанции + медиа о музыке и цифровой культуре одновременно.

═══════════════════════════════════════════
ТЕМА ВЫПУСКА: ${topic.kind}
КОНТЕКСТ: ${topic.intro}

ФАКТУРА (используй ТОЛЬКО это, не выдумывай):
${itemsBlock}

ВЕДУЩИЕ:
• ${hostA}: ${HOST_DESC[hostA]}
• ${hostB}: ${HOST_DESC[hostB]}

═══════════════════════════════════════════
ФОРМАТ ДИАЛОГА:

Этот выпуск — ПОЛНОЦЕННЫЙ РАДИО-ВЫПУСК НА 3 МИНУТЫ (~180 секунд устной речи, 10–14 реплик).
Глубокий разговор на ОДНУ тему, как у ведущих качественной музыкальной радиостанции (Радио Культура, BBC Radio 6 Music).
Каждая реплика — ЗАВЕРШЁННАЯ МЫСЛЬ из 2–4 предложений. Доводи до точки, потом передавай. Соведущий ПРОДОЛЖАЕТ, развивает, добавляет КОНТЕКСТ — не повторяет, не подтверждает односложно.

ГЛУБИНА (важно!):
- Не просто перескажи факт — раскрой контекст: чем релиз необычен, как звучит, на что похоже, какое место занимает в творчестве артиста и в музыкальной сцене.
- Если в фактуре указан жанр/город/площадка — увяжи с шире (например: "клубная атмосфера Москвы в 2020-х...", "русский рэп последних лет...", "электронная сцена Петербурга..."). НИКАКОЙ ПОЛИТИКИ.
- Если есть имена коллабораций — упомяни предыдущие работы участников (только то что точно известно, никаких выдумок).
- Цитируй конкретное: год релиза, лейбл, продюсер, длительность, если есть.
- Привязывай к актуальной музыкальной индустрии: тренды, дистрибуция, AI, независимая сцена.

СТРУКТУРА ВЫПУСКА:
1. Захват внимания — эмоциональное или интригующее открытие. Никаких «Привет, чё-как», «Эй, йоу», «Ребят». Открывай атмосферно: «В эфире Promo Music...», «На платформе Promo Music происходит интересное...», «Сегодня в эфире — ${topic.kind.toLowerCase()}».
2. Основная мысль — что происходит на платформе / на сцене / с этим артистом-релизом-концертом.
3. Польза — почему слушателям и артистам это важно/интересно.
4. Призыв — перейти на promo-music.ru, отправить трек, следить за обновлениями, послушать эфир.

═══════════════════════════════════════════
ОБЯЗАТЕЛЬНЫЕ УПОМИНАНИЯ (распредели по диалогу естественно, не списком):
• Promo Music — как новое музыкальное пространство, экосистема, не B2B
• Независимая музыка, поддержка молодых артистов
• 1–2 раза призвать зарегистрироваться: «бесплатно на promo-music.ru», «загружай релизы»
• Финальная реплика ОБЯЗАТЕЛЬНО содержит «оставайтесь с нами на ПРОМО.ФМ и ПРОМО.МУЗЫКА» или «следи за обновлениями на promo-music.ru»
• Если тема — feature (CHECK/LAB/360) — раскрой детально: как работает, для кого, что даёт
• Минимум один раз — про скорую дистрибуцию в стриминги
• Минимум 3 позиции из блока «ПОЗИЦИИ И ПРЕИМУЩЕСТВА» — врассыпную по диалогу, разными словами
• Закрытие выпуска хорошо завершить слоганом «Слушай новое. Слушай легально.» перед финальной фразой (не обязательно, но желательно)

═══════════════════════════════════════════
ВАЖНЫЕ ПРАВИЛА — БЕЗ НИХ ВЫПУСК НЕ ВЫХОДИТ:

ГЛАВНОЕ: ты — ЖИВОЙ радио-ведущ${'${ }'}ий, не AI-помощник. Слушатель НЕ должен догадаться что это AI.

КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО:
• ЛЮБЫЕ упоминания политики, войны, Украины, России в политическом контексте, государств, президентов, выборов, санкций, конфликтов, СВО. Платформа — про музыку и артистов, а не про геополитику. Никогда. Ни в каком ключе.
• Упоминания других стран в негативном/спорном контексте.
• Имена политиков, военных деятелей. Только музыкантов.
• meta-вопросы и AI-маркеры: «ну как?», «получилось передать?», «как тебе мой заход?», «как вышло?», «я нейросеть», «мы AI-ассистенты»
• вопросы коллеге: «как тебе?», «что думаешь?», «а ты бы как сформулировал?»
• вопросы слушателям: «как вам?», «согласны?», «что скажете?»
• уличные приветствия: «эй, йоу», «йоу», «хай», «приветики», «дратути», «чё как»
• уличный/подростковый сленг: «бро», «чувак», «пацаны», «ребят», «тема», «огонь», «топчик», «кайф», «респект», «вайб», «мощно», «крутой», «чёткий», «зашло», «погнали», «го», «кек», «жесть»
• ремарки про сам выпуск: «в этом выпуске», «в следующей рубрике», «мы подготовили», «давайте разберём»
• канцелярит: «осуществляем», «производим», «в рамках чего», «по результатам»

• РАЗРЕШЕНО для артистов платформы: «артисты Promo Music», «артисты, звучащие на ПРОМО.ФМ», «исполнители платформы»

РАЗРЕШЕНО:
• профессиональная лексика (релиз, ротация, лейбл, продакшн, мастеринг, аранжировка)
• развитие мысли коллеги: «И ещё важное:», «Добавлю:», «Совершенно точно — и плюс к этому:»
• атмосферные обороты: «На сцене сейчас интересно», «Это история о...», «Звучит уверенно», «Заметная работа»
• эмоция через точные слова: «сильная работа», «уверенный релиз», «работа, которая удерживает внимание»

═══════════════════════════════════════════
ПРИМЕРЫ ПЛОХО → ХОРОШО:

ПЛОХО: «Эй, йоу, в эфире Лиана, чё, погнали разбирать новинки!»
ХОРОШО: «В эфире Promo Music. Сегодня в фокусе — свежий релиз, и о нём стоит сказать подробно.»

ПЛОХО: «Бро, тут такой огонь вышел, прям зашло!»
ХОРОШО: «Это сильная работа. Не каждый релиз так уверенно занимает место в ротации.»

ПЛОХО: «Ну как тебе, Марк? Получилось передать?»
ХОРОШО: (просто продолжаешь следующей мыслью, не ища одобрения)

ПЛОХО: «Загружайте на ПРОМО.МУЗЫКА, го регаться!»
ХОРОШО: «Зарегистрироваться можно бесплатно на promo-music.ru — кабинет артиста открывается сразу, можно загружать релизы и слушать аналитику.»

═══════════════════════════════════════════
ВЕРНИ СТРОГО JSON МАССИВ (без обёрток, без markdown, без комментариев):
[{"author": "${hostA}", "text": "..."}, {"author": "${hostB}", "text": "..."}, ...]`;
}

// ─── Banned patterns + slang scrubber ──────────────────────────────
// Если в тексте есть политические маркеры — реплику дропаем целиком (см. dropLineIfPolitical)
const POLITICAL_KEYWORDS = [
  'украин', 'российск', 'россияне', 'россии ', 'путин', 'зеленск', 'трамп', 'байден',
  'санкци', 'свo', ' сво ', ' свом ', 'войн', 'военн', 'конфликт',
  'политик', 'президент', 'правительств', 'кремль', 'нато', 'дума', 'минобороны',
  'мобилизац', 'оккупац', 'дрон', 'ракет', 'обстрел',
];

const BANNED_PATTERNS = [
  // AI-маска и meta-вопросы — категорически. Слушатель не должен догадаться что это AI.
  /\b(эй\s+)?йоу\b[,!.]?/gi,
  /\bхай[,!.\s]/gi,
  /\bпривет(ики)?\b[,!.]?/gi,
  /\bдратути\b/gi,
  /\bкуку\b/gi,
  /\bну\s+как\s*\??/gi,
  /\bполучилось\s+(передать|сказать|выразить|сформулировать|объяснить)\s*\??/gi,
  /\b(хорошо|неплохо)\s+получилось\??/gi,
  /\bкак\s+тебе\s+мо(й|я|ё)\s+\S+\??/gi,
  /\bу\s+меня\s+получилось\s+\??/gi,
  /\bмне\s+(удалось|кажется)\s+передать/gi,
  /\bкак\s+(звучит|вышло|получилось)\??/gi,
  /\b(я|мы)\s+(нейросет|помощник|бот|искусственный|AI|ай-ай|ассистент)/gi,

  /как вам(\s+(такое|это|вариант))?\s*\??/gi,
  /что (скажете|думаете)\??/gi,
  /согласны\??/gi,
  /как тебе (такой\s+)?вариант\??/gi,
  /что думаешь о (моём|твоём|этом)\s+\S+\??/gi,
  /а ты бы как (сформулировал|сказал|подал)\??/gi,
  /в (этом|нашем)\s+выпуске/gi,
  /в следующей\s+рубрике/gi,
  /мы подготовили\s+\S+/gi,
  /давайте\s+(разберём|погружаемся|поговорим)/gi,
  /безусловно[, ]/gi,
];

const SLANG_REPLACEMENTS = [
  // STRIP "резидент(ы)" + "наши артисты" — НЕ используем \b (не работает для кириллицы в JS regex)
  [/(?<![а-яА-ЯёЁa-zA-Z])(резидент(ом|ами|ах|ы|ам|ов|у|а|е)?)\s+(нашей|вашей|этой)\s+(платформы|промо\.?\s*музыка|promo\s*music)?/giu, 'артисты Promo Music'],
  [/(?<![а-яА-ЯёЁa-zA-Z])(резидент(ом|ами|ах|ы|ам|ов|у|а|е)?)(?![а-яА-ЯёЁa-zA-Z])/giu, 'артисты Promo Music'],
  [/(?<![а-яА-ЯёЁa-zA-Z])(наш(и|их|им|ими))\s+(артист(ы|ов|ам|ами|ах)|исполнител(и|ей|ям|ями|ях))/giu, 'артисты Promo Music'],
  [/(?<![а-яА-ЯёЁa-zA-Z])(наши|свои)\s+резидент(ы|ов|ам|ами|ах)?/giu, 'артисты Promo Music'],

  [/\bпогнали\s+(разбирать|слушать|обсуждать)\b/gi, 'обратимся к'],
  [/\bпогнали\b/gi, 'переходим'],
  [/\bго (регаться|регистрироваться|слушать|на)\b/gi, 'регистрируйтесь на'],
  [/\bжесть[, !.]?/gi, ''],
  [/\bпрям(\s+(огонь|пожар|топ|кайф))?\b/gi, ''],
  [/\bтема\s+(огонь|кайф|топ|шикарная)\b/gi, 'сильная работа'],
  [/\bвот это тема\b/gi, 'это серьёзная работа'],
  [/\bже[ёе]стко\b/gi, 'мощно'],
  [/\bкек\b/gi, ''],
  [/\bчё\s+как\b/gi, ''],
  [/\bдратути\b/gi, 'здравствуйте'],
  [/\bхай[, !.]?\s/gi, 'Здравствуйте, '],
  [/\b(приветики|превед)(\s+(всем|братва|друзья|чуваки|пацаны))?/gi, 'Здравствуйте'],
  [/\bорнул(а)?\b/gi, 'удивился'],
  [/\bпушка\b/gi, 'сильно'],
  [/\bвзлетел(а|о)?\b/gi, 'набрал популярность'],
  [/\bзалетел(а|о)?\b/gi, 'вышел'],
  [/\bэто (огонь|пожар|бомба|кайф|топ|топчик)\b/gi, 'это сильно'],
  [/\bкрутой\s+(трек|релиз|альбом|сингл|бит)\b/gi, 'уверенный $1'],
  [/\bкрутая\s+(работа|штука|тема|песня)\b/gi, 'сильная $1'],
  [/\bмощно\s+зашло\b/gi, 'произвело впечатление'],
  [/\bзашло\b/gi, 'понравилось'],
  [/\bне зашло\b/gi, 'не убедило'],
  [/\bвайб\b/gi, 'атмосфера'],
  [/\bкринж(\b|евый)/gi, 'неловко'],
  [/\bреспект\b/gi, 'уважение'],
  [/\bчёткий\s+(трек|релиз|бит|звук)\b/gi, 'точный $1'],
  [/\b(чувак|чуваки|бро|пацаны|ребят[аы]?)\b/gi, 'слушатели'],
  [/\bтопчик\b/gi, 'лидер'],
  [/\bмощно\b/gi, 'сильно'],
  [/\bтреки-(новинки|конфетки|шедевры)\b/gi, 'новые работы'],
];


// ─── Stress hints (комбинирующий акут U+0301 после ударной гласной) ─
// Gemini Live Russian TTS уважает Unicode acute → правильное ударение
const STRESS_HINTS = [
  // Артисты/группы где TTS ошибается
  [/\bМо(я|Я)\s+Мишель\b/g, 'Мо\u0301я Мише\u0301ль'],
  [/\bмо(я|Я)\s+мишель\b/g, 'мо\u0301я мише\u0301ль'],
  [/\bГрэмми\b/g, 'Грэ\u0301мми'],
  [/\bШаман\b/g, 'Шама\u0301н'],
  [/\bЛеша\s+Свик\b/g, 'Лёша Сви\u0301к'],
  [/\bЗвонкий\b/gi, 'Зво\u0301нкий'],
  [/\bГуф\b/g, 'Гу\u0301ф'],
  [/\bБаста\b/g, 'Ба\u0301ста'],
  [/\bМакан\b/g, 'Мака\u0301н'],
  [/\bMacan\b/g, 'Мака\u0301н'],
  [/\bТатарка\b/g, 'Тата\u0301рка'],
  // Платформа
  [/\bПРОМО\.МУЗЫКА\b/g, 'промо-му\u0301зыка'],
  [/\bПРОМО\.ФМ\b/g, 'промо-эф-эм'],
  [/\bПРОМО\.CHECK\b/g, 'промо-чек'],
  [/\bПРОМО\.LAB\b/g, 'промо-лэб'],
  [/\bПРОМО\.AIR\b/g, 'промо-эфир'],
  [/\bпромо-music\.ru\b/gi, 'промо-му\u0301зыка точка ру'],
];

function applyStress(text) {
  let out = String(text || '');
  for (const [re, rep] of STRESS_HINTS) {
    out = out.replace(re, rep);
  }
  return out;
}

function scrubBanned(text) {
  let cleaned = String(text || '');
  for (const re of BANNED_PATTERNS) cleaned = cleaned.replace(re, '');
  for (const [re, rep] of SLANG_REPLACEMENTS) cleaned = cleaned.replace(re, rep);
  // вопросы → утверждения (кроме первого приветствия)
  if (!/привет|здравствуйте|добр(ый|ого)\s+(день|вечер|утро)/i.test(cleaned)) {
    cleaned = cleaned.replace(/\?+/g, '.');
  }
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  cleaned = cleaned.replace(/[,;:]\s*$/, '.').replace(/\s+(и|а|но|или)\s*\.?$/i, '.');
  cleaned = applyStress(cleaned);
  return cleaned;
}


// ─── Rotation: don't repeat same host pair consecutively ─────────
let _lastHostPairIdx = -1;
function pickHostPair() {
  let idx;
  // Try up to 5 times to get different pair than last
  for (let i = 0; i < 5; i++) {
    idx = Math.floor(Math.random() * HOST_PAIRS.length);
    if (idx !== _lastHostPairIdx) break;
  }
  _lastHostPairIdx = idx;
  return HOST_PAIRS[idx];
}

async function makeDialogue(topic) {
  const [hostA, hostB] = pickHostPair();
  const prompt = buildPrompt(topic, hostA, hostB);
  let text;
  try { text = await geminiGenerate(prompt); } catch (e) { console.error(`[engine] Gemini failed: ${e.message}`); return null; }
  let dialogue;
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    dialogue = JSON.parse(cleaned);
  } catch (e) { console.error(`[engine] JSON parse: ${e.message}`); return null; }
  if (!Array.isArray(dialogue) || dialogue.length < 4) return null;

  // Drop turns that mention politics (full-line censor)
  dialogue = dialogue.filter(turn => {
    const txt = (turn.text || '').toString().toLowerCase();
    for (const kw of POLITICAL_KEYWORDS) {
      if (txt.includes(kw)) {
        console.warn();
        return false;
      }
    }
    return true;
  });
  if (dialogue.length < 4) {
    console.warn('[political-filter] too many drops, dialogue rejected');
    return null;
  }
  const fullTxt = dialogue.map(t => (t.text || '').toLowerCase()).join(' ');
  const last = (dialogue[dialogue.length-1]?.text || '').toLowerCase();
  if (!last.includes('промо.фм') || !last.includes('промо.музыка')) {
    dialogue.push({ author: hostA, text: 'Оставайтесь с нами на ПРОМО.ФМ и ПРОМО.МУЗЫКА.' });
  }
  if (!/регистр/i.test(fullTxt)) {
    const mid = Math.floor(dialogue.length / 2);
    dialogue.splice(mid, 0, { author: hostB, text: 'Регистрация бесплатна на promo-music.ru, кабинет открывается сразу.' });
  }
  return { hostA, hostB, turns: dialogue.slice(0, PODCAST_MAX_TURNS + 4) };
}

// ─── TTS to PCM ──────────────────────────────────────────────────────
async function ttsToPcm(text, author) {
  const r = await fetch(`${GEMINI_PROXY_URL}/tts-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
    body: JSON.stringify({ text, author }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok || !r.body) throw new Error(`tts ${r.status}`);
  const chunks = [];
  let total = 0;
  const reader = r.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) { chunks.push(value); total += value.length; }
  }
  if (total < 1000) throw new Error('tts too short');
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return Buffer.from(out);
}

function silencePcm(ms) {
  // PCM L16 mono 24000Hz: 2 bytes/sample * 24000 samples/s
  return Buffer.alloc(Math.floor(ms / 1000 * SAMPLE_RATE * 2));
}

async function pcmToMp3(pcmBuf, outPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
      '-i', 'pipe:0',
      '-codec:a', 'libmp3lame', '-b:a', '64k', '-ar', '24000', '-ac', '1',
      outPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => err += d.toString());
    ff.on('error', reject);
    ff.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-200)}`)));
    ff.stdin.end(pcmBuf);
  });
}

async function mp3ToPcm(inPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inPath,
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    ff.stdout.on('data', d => chunks.push(d));
    ff.stderr.on('data', d => err += d.toString());
    ff.on('error', reject);
    ff.on('exit', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}: ${err.slice(-200)}`)));
  });
}

// ─── BUILDER: render one episode to MP3 ─────────────────────────────
async function listQueue() {
  try {
    const files = await readdir(QUEUE_DIR);
    return files.filter(f => f.endsWith('.mp3')).sort();
  } catch { return []; }
}

async function buildOne() {
  const used = await loadUsedItems();
  const { topic, kind } = await nextTopic(used);
  console.log(`[builder] topic: ${kind} (${topic.items?.length || 0} items)`);

  const dialogue = await makeDialogue(topic);
  if (!dialogue) { console.warn('[builder] no dialogue, skip'); return null; }
  console.log(`[builder] hosts: ${dialogue.hostA} + ${dialogue.hostB}, turns: ${dialogue.turns.length}`);

  // Render each turn → PCM
  const pcms = [];
  const gap = silencePcm(TURN_GAP_MS);
  for (const turn of dialogue.turns) {
    const raw = (turn.text || '').toString().trim();
    const text = scrubBanned(raw);
    if (!text || text.length < 5) continue;
    if (text !== raw) console.log(`[builder] scrubbed: "${raw.slice(0,60)}" -> "${text.slice(0,60)}"`);
    const author = turn.author || dialogue.hostA;
    try {
      const pcm = await ttsToPcm(text, author);
      pcms.push(pcm);
      pcms.push(gap);
      console.log(`[builder]   + ${author}: ${pcm.length}b (${(pcm.length/(SAMPLE_RATE*2)).toFixed(1)}s)`);
    } catch (e) {
      console.warn(`[builder]   ! ${author} tts fail: ${e.message}`);
    }
  }
  if (!pcms.length) return null;

  const combined = Buffer.concat(pcms);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const mp3path = join(QUEUE_DIR, `episode_${ts}_${kind}.mp3`);
  await pcmToMp3(combined, mp3path);

  // Sidecar metadata for post-broadcast cleanup
  const sidecar = mp3path + '.json';
  await writeFile(sidecar, JSON.stringify({
    topic_kind: kind, topic_items_kind: topic.items_kind, items: topic.items || [],
    hostA: dialogue.hostA, hostB: dialogue.hostB,
    turns_count: dialogue.turns.length,
    duration_sec: combined.length / (SAMPLE_RATE * 2),
    created_at: new Date().toISOString(),
  }, null, 2));

  const sizeKB = Math.round(combined.length / 1024);
  console.log(`[builder] ✅ ${mp3path} (${sizeKB}KB raw → MP3)`);
  return mp3path;
}

// ─── PLAYER: pick oldest, inject, delete ────────────────────────────
async function deleteNewsFromDB(id) {
  if (!id) return;
  try {
    const r = await fetch(`${API_BASE}/server/api/landing-data/admin/news/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'X-Internal-Key': INTERNAL_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) console.log(`[player] deleted news ${id} from DB`);
  } catch (e) { console.warn(`[player] del news ${id} failed: ${e.message}`); }
}

async function playOne() {
  const queue = await listQueue();
  if (!queue.length) { console.log('[player] queue empty'); return false; }

  const mp3file = queue[0];
  const mp3path = join(QUEUE_DIR, mp3file);
  console.log(`[player] picking: ${mp3file}`);

  // Read metadata sidecar
  let meta = null;
  try { meta = JSON.parse(await readFile(mp3path + '.json', 'utf8')); } catch {}

  // Decode MP3 → PCM for AutoDJ inject
  let pcm;
  try { pcm = await mp3ToPcm(mp3path); }
  catch (e) { console.error(`[player] decode fail: ${e.message}`); return false; }

  // POST to AutoDJ /api/inject — anti-overlap returns 423
  const injectResp = await fetch(`${AUTODJ_URL}/api/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Internal-Key': INTERNAL_KEY },
    body: pcm,
    signal: AbortSignal.timeout(60000),
  }).catch(e => ({ ok: false, status: 0, error: e.message }));

  if (injectResp.status === 423) {
    const data = await injectResp.json().catch(() => ({}));
    console.log(`[player] AutoDJ busy (${data.remaining_sec}s left), will retry next cycle`);
    return false;
  }

  if (!injectResp.ok) {
    console.warn(`[player] inject failed: ${injectResp.status}`);
    return false;
  }

  const injectData = await injectResp.json();
  console.log(`[player] ✓ injected ${(injectData.duration || 0).toFixed(1)}s into stream`);

  // Cleanup: mark items used + delete news + remove MP3 + sidecar
  if (meta) {
    const used = await loadUsedItems();
    if (meta.topic_items_kind === 'news') {
      for (const item of meta.items || []) {
        if (item.id) {
          await deleteNewsFromDB(item.id);
          await markUsed(used, 'news', dedupKeyNews(item));
        }
      }
    } else if (meta.topic_items_kind === 'tracks') {
      for (const item of meta.items || []) await markUsed(used, 'tracks', dedupKeyTrack(item));
    } else if (meta.topic_items_kind === 'concerts') {
      for (const item of meta.items || []) await markUsed(used, 'concerts', dedupKeyConcert(item));
    }
  }

  try { await unlink(mp3path); console.log(`[player] 🗑  removed ${mp3file}`); } catch {}
  try { await unlink(mp3path + '.json'); } catch {}

  return true;
}

// ─── Main: two parallel loops ────────────────────────────────────────
async function builderLoop() {
  while (true) {
    try {
      const queue = await listQueue();
      if (queue.length < QUEUE_TARGET) {
        console.log(`[builder] queue=${queue.length}/${QUEUE_TARGET}, building one...`);
        await buildOne();
      } else {
        console.log(`[builder] queue=${queue.length} full, sleep`);
      }
    } catch (e) { console.error(`[builder] error: ${e.message}`); }
    await new Promise(r => setTimeout(r, BUILD_INTERVAL_SEC * 1000));
  }
}

async function playerLoop() {
  // Initial delay to let builder warm up queue
  await new Promise(r => setTimeout(r, 60000));
  while (true) {
    try { await playOne(); }
    catch (e) { console.error(`[player] error: ${e.message}`); }
    await new Promise(r => setTimeout(r, PLAY_INTERVAL_SEC * 1000));
  }
}


// ─── Track-aware DJ comment (real-time, не из кеша) ────────────────
async function getNowPlaying() {
  try {
    const r = await fetch(`${AUTODJ_URL}/api/now-playing`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    const fn = data.track || data.info?.filename || '';
    let artist = '', title = '';
    const cleaned = fn.replace(/\.mp3$/i, '').replace(/\s*\[.*?\]\s*$/g, '').trim();
    const parts = cleaned.split(/\s+-\s+/);
    if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); }
    else title = cleaned;
    return { artist, title, filename: fn };
  } catch { return null; }
}

async function buildTrackCommentText(np) {
  const author = pick(['Лиана','Стелла','Сандра','Марк','DJ Den','Нико']);
  const gender = author.endsWith('а') ? 'ая' : 'ий';
  const prompt = `Ты — ${author}, ведущ${gender} Promo Music — современного музыкального медиа и радио.

${'Сейчас ' + getTimeContext().period + ' (' + getTimeContext().time_str + ').'}
Только что прозвучал трек:
АРТИСТ: ${np.artist || 'неизвестный артист'}
НАЗВАНИЕ: ${np.title || 'без названия'}

Сделай ОДНУ короткую радио-подводку (1–2 коротких предложения, 10–25 секунд устной речи) о только что прозвучавшем треке.

ФОРМАТ — атмосферная радио-подводка:
• Начало — эмоциональный или атмосферный заход. НЕ «Эй йоу», НЕ «Привет», НЕ «Ребят».
• Связь с треком — упомяни артиста и название хотя бы один раз.
• Опционально — короткое упоминание Promo Music / promo-music.ru как пространства независимой музыки.

ПРАВИЛА:
• Тон современный, уверенный, атмосферный, музыкальный, дружелюбный. Без официоза. Без токсичности.
• ТЫ — ЖИВОЙ ведущий, не AI. Слушатель не должен догадаться.
• ЗАПРЕЩЕНО: «эй йоу», «йоу», «хай», вопросы (никаких «как вам?», «ну как?», «получилось передать?»).
• ЗАПРЕЩЕНО: сленг («крутой», «огонь», «топ», «бро», «тема», «кайф», «мощно», «зашло», «вайб»).
• Если упоминаешь артистов платформы — говори «артисты Promo Music» или «исполнители платформы».
• Эмоции через точные слова: «сильная работа», «уверенный релиз», «звучит атмосферно».

Верни СТРОГО JSON: {"author": "${author}", "text": "..."}`;
  try {
    const raw = await geminiGenerate(prompt);
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    const obj = JSON.parse(cleaned);
    return { author: obj.author || author, text: scrubBanned(obj.text || '') };
  } catch (e) {
    console.warn(`[comment] gen fail: ${e.message}`);
    return null;
  }
}

async function injectShort(text, author) {
  try {
    const pcm = await ttsToPcm(text, author);
    const r = await fetch(`${AUTODJ_URL}/api/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Internal-Key': INTERNAL_KEY },
      body: pcm,
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 423) { console.log('[comment] AutoDJ busy, will retry'); return false; }
    if (!r.ok) { console.warn(`[comment] inject fail ${r.status}`); return false; }
    const data = await r.json();
    console.log(`[comment] ✓ ${author} (${(data.duration||0).toFixed(1)}s): ${text.slice(0,80)}`);
    return true;
  } catch (e) { console.warn(`[comment] fail: ${e.message}`); return false; }
}

async function commentOnce() {
  const np = await getNowPlaying();
  if (!np || !(np.title || np.artist)) { console.log('[comment] no track info, skip'); return; }
  if (/jingle|voice_inject/i.test(np.filename || '')) { console.log('[comment] jingle/voice, skip'); return; }
  console.log(`[comment] track: ${np.artist} — ${np.title}`);
  const c = await buildTrackCommentText(np);
  if (!c || !c.text || c.text.length < 10) return;
  // Retry если AutoDJ занят — комментарий о треке КРИТИЧЕН (правило пользователя)
  for (let attempt = 0; attempt < 6; attempt++) {
    const ok = await injectShort(c.text, c.author);
    if (ok) return;
    // 423/busy → ждём 30с и пробуем снова (в течение 3 мин max)
    console.log(`[comment] retry in 30s (attempt ${attempt + 1}/6)`);
    await new Promise(r => setTimeout(r, 30000));
    // Перепроверим что трек ещё играет (если сменился — генерим новый comment)
    const np2 = await getNowPlaying();
    if (np2 && np2.filename !== np.filename) {
      console.log('[comment] track changed during retry, abort old comment');
      return;
    }
  }
  console.log('[comment] gave up after 6 retries');
}

async function commentLoop() {
  await new Promise(r => setTimeout(r, 180000)); // initial delay 3 min
  while (true) {
    try { await commentOnce(); } catch (e) { console.error('[comment] loop:', e.message); }
    await new Promise(r => setTimeout(r, COMMENT_INTERVAL_SEC * 1000));
  }
}



// ─── HTTP trigger server (autodj вызывает /trigger-comment после джингла) ─
function startTriggerServer() {
  const port = parseInt(process.env.TRIGGER_PORT || '7080', 10);
  const srv = _httpCreate(async (req, res) => {
    if (req.method === 'POST' && req.url === '/trigger-comment') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, kind: 'comment' }));
      try { await commentOnce(); } catch (e) { console.warn('[trigger comment] failed:', e.message); }
      return;
    }
    if (req.method === 'POST' && req.url === '/trigger-podcast') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, kind: 'podcast' }));
      try { await playOne(); } catch (e) { console.warn('[trigger podcast] failed:', e.message); }
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    res.writeHead(404); res.end();
  });
  srv.listen(port, '127.0.0.1', () => console.log(`[engine] trigger server on :${port}`));
}



// ─── DJ-MP3 QUEUE BUILDER ───────────────────────────────────────────
// Готовит короткие DJ-подводки заранее в /opt/promofm-podcast/dj-queue/dj_<ts>.mp3
// AutoDJ берёт оттуда между джинглами как обычный track.
const DJ_QUEUE_DIR = process.env.DJ_QUEUE_DIR || '/opt/promofm-podcast/dj-queue';
const DJ_QUEUE_TARGET = parseInt(process.env.DJ_QUEUE_TARGET || '5', 10);
const DJ_BUILD_INTERVAL_SEC = parseInt(process.env.DJ_BUILD_INTERVAL_SEC || '180', 10);

// Темы для коротких DJ-подводок (рандомная ротация)
const DJ_SHORT_TOPICS = [
  'Скажи короткую радио-подводку (2-3 предложения, 15-25 секунд устной речи) о том, что Promo Music — это музыкальное комьюнити нового времени для независимых артистов. Зови регистрироваться на promo-music.ru. Атмосферно, по-радийному. Без вопросов, без сленга.',
  'Скажи короткую радио-подводку (2-3 предложения, 15-25 секунд) о том что новинки недели обновились на promo-music.ru — свежие релизы артистов. Зови слушать. Атмосферно. Без вопросов.',
  'Скажи короткую радио-подводку (2-3 предложения, 15-25 секунд) о ПРОМО.LAB — экспертной оценке трека перед релизом. Расскажи кому это пригодится. Спокойно, по делу. Без вопросов.',
  'Скажи короткую радио-подводку (2-3 предложения, 15-25 секунд) о скорой дистрибуции в Яндекс.Музыку, VK, Spotify, Apple Music прямо из кабинета Promo Music. Зови оставить email на promo-music.ru. Без вопросов.',
  'Скажи короткую радио-подводку (2-3 предложения, 15-25 секунд) о том, что афиша концертов обновляется на promo-music.ru — кто и где играет. Атмосферно. Без вопросов.',
  'Скажи короткую радио-подводку (2-3 предложения, 15-25 секунд) о ПРОМО.CHECK — мониторинге радио-эфира с AI-детектором и watermark-учётом ротаций. Без вопросов.',
  'Скажи короткую радио-подводку (2-3 предложения, 15-25 секунд) о том что Promo Music — это поддержка молодых независимых артистов. Кто загружает релизы — попадает в эфир. Без вопросов.',
];

async function listDjQueue() {
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(DJ_QUEUE_DIR);
    return files.filter(f => f.startsWith('dj_') && f.endsWith('.mp3')).sort();
  } catch { return []; }
}

async function buildDjMp3() {
  const author = pick(['Лиана', 'Марк', 'Стелла', 'DJ Den', 'Сандра', 'Макс', 'Нико']);
  const gender = author.endsWith('а') ? 'ая' : 'ий';
  const topicText = pick(DJ_SHORT_TOPICS);
  const prompt = `Ты — ${author}, ведущ${gender} Promo Music. ${topicText}\n\nВерни СТРОГО JSON: {"author": "${author}", "text": "..."}`;
  let raw;
  try { raw = await geminiGenerate(prompt); }
  catch (e) { console.warn('[dj-builder] gemini fail:', e.message); return null; }
  let obj;
  try {
    const cleaned = raw.trim().replace(/^\\`\\`\\`json\s*/i, '').replace(/\\`\\`\\`\s*$/, '');
    obj = JSON.parse(cleaned);
  } catch { return null; }
  const text = scrubBanned(obj?.text || '');
  if (!text || text.length < 10) return null;

  // TTS → PCM
  let pcm;
  try { pcm = await ttsToPcm(text, obj.author || author); }
  catch (e) { console.warn('[dj-builder] tts fail:', e.message); return null; }

  // PCM → MP3
  const ts = Date.now();
  const out = `${DJ_QUEUE_DIR}/dj_${ts}_${(obj.author || author).replace(/\s/g, '_')}.mp3`;
  try { await pcmToMp3(pcm, out); }
  catch (e) { console.warn('[dj-builder] mp3 fail:', e.message); return null; }
  console.log(`[dj-builder] ✓ ${out.split('/').pop()} (${author}: "${text.slice(0, 60)}...")`);
  return out;
}

async function djBuilderLoop() {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(DJ_QUEUE_DIR, { recursive: true });
  while (true) {
    try {
      const q = await listDjQueue();
      if (q.length < DJ_QUEUE_TARGET) {
        await buildDjMp3();
      }
    } catch (e) { console.error('[dj-builder] error:', e.message); }
    await new Promise(r => setTimeout(r, DJ_BUILD_INTERVAL_SEC * 1000));
  }
}

async function main() {
  await ensureDir(QUEUE_DIR);
  startTriggerServer();
  console.log(`[engine] start. queue=${QUEUE_DIR} target=${QUEUE_TARGET} build=${BUILD_INTERVAL_SEC}s play=${PLAY_INTERVAL_SEC}s model=${GEMINI_TEXT_MODEL}`);

  if (process.argv.includes('--build-once')) {
    await buildOne();
    return;
  }
  if (process.argv.includes('--play-once')) {
    await playOne();
    return;
  }

  // Parallel loops
  builderLoop().catch(e => console.error('[builder fatal]', e));
  djBuilderLoop().catch(e => console.error('[dj-builder fatal]', e));
  // playerLoop disabled — теперь триггерится autodj через POST /trigger-podcast каждые N треков
  // playerLoop().catch(e => console.error('[player fatal]', e));
  // commentLoop disabled — теперь триггерится autodj через POST /trigger-comment после каждого 3-track-jingle блока
  // commentLoop().catch(e => console.error('[comment fatal]', e));
  // keep process alive
  await new Promise(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
process.on('SIGTERM', () => { console.log('[engine] SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { console.log('[engine] SIGINT'); process.exit(0); });
