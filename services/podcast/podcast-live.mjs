#!/usr/bin/env node
/**
 * ПРОМО.ФМ Podcast Live v2 — авто-генератор лайв-подкастов в эфир.
 *
 * Цикл: каждые PODCAST_INTERVAL_SEC сек:
 *   1. picks topic (news / new-releases / concerts / 8 platform-фич)
 *   2. собирает source data из своего же бэка
 *   3. Gemini 3 Flash → диалог 8-14 turns между 2 ведущими-диджеями платформы
 *   4. каждый turn → POST /server/api/broadcast/text → Gemini 3.1 Flash Live TTS → overlay поверх музыки
 *   5. Обязательные фразы:
 *      - финал: "оставайтесь с нами на ПРОМО.ФМ и ПРОМО.МУЗЫКА"
 *      - CTA: "регистрируйтесь на ПРОМО.МУЗЫКА" хотя бы 1 раз по ходу
 *
 * Ведущие — официальные диджеи платформы ПРОМО.МУЗЫКА, рекламируют её всегда.
 */

import { readFile, writeFile } from 'node:fs/promises';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const DISCOVERY_CACHE = process.env.DISCOVERY_CACHE || '/opt/promofm-podcast/discovery-cache.json';
const INTERNAL_KEY = process.env.INTERNAL_KEY || process.env.VPS_INTERNAL_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL || 'http://187.77.85.42:8088';
const GEMINI_PROXY_KEY = process.env.GEMINI_PROXY_KEY || 'promofm-gemini-2026';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3-flash-preview';
const PODCAST_INTERVAL_SEC = parseInt(process.env.PODCAST_INTERVAL_SEC || '14400', 10); // 4ч
const PODCAST_MIN_TURNS = parseInt(process.env.PODCAST_MIN_TURNS || '8', 10);
const PODCAST_MAX_TURNS = parseInt(process.env.PODCAST_MAX_TURNS || '14', 10);
const TURN_PAUSE_MS = parseInt(process.env.TURN_PAUSE_MS || '600', 10);
const SPEAK_TIMEOUT_MS = parseInt(process.env.SPEAK_TIMEOUT_MS || '120000', 10);

if (!INTERNAL_KEY) {
  console.error('[podcast-live] INTERNAL_KEY required'); process.exit(1);
}

// ─── Ведущие — официальные диджеи платформы ПРОМО.МУЗЫКА ──────────────
const HOST_PAIRS = [
  ['Лиана', 'Марк'],
  ['Стелла', 'DJ Den'],
  ['Сандра', 'Макс'],
  ['Нико', 'Пабло'],
  ['РадКат', 'Лиана'],
  ['Марк', 'Стелла'],
];

const HOST_DESC = {
  'DJ Den': 'ведущий ПРОМО.МУЗЫКА. Электронная сцена. Говорит как профессиональный музыкальный журналист — спокойно, аргументированно, образованно. Никакого клубного жаргона.',
  'Сандра': 'ведущая ПРОМО.МУЗЫКА. Современная поп-сцена и R&B. Тон серьёзного культурного издания, тёплая интонация, литературный русский.',
  'Лиана': 'ведущая ПРОМО.МУЗЫКА. Музыкальный обозреватель и аналитик. Сдержанная, академичная, точная. Журнал "Афиша" / "Сноб" / Радио Культура — этот регистр.',
  'Макс': 'ведущий ПРОМО.МУЗЫКА. Рок и инди-музыка. Размеренная, серьёзная подача с лёгкой иронией. Стиль печатного критика, не FM-морнинга.',
  'Марк': 'ведущий ПРОМО.МУЗЫКА. Хип-хоп и R&B. Подача как у репортёра большого музыкального издания: уважительно, по фактуре, литературный русский. Категорически без "бро", "чувак", "тема", уличного сленга и подростковых междометий.',
  'Пабло': 'ведущий ПРОМО.МУЗЫКА. Мировая и этническая музыка. Образный, литературный язык; речь как у писателя-эссеиста.',
  'Нико': 'ведущий ПРОМО.МУЗЫКА. Классика, академическая и джазовая сцена. Эрудированный, спокойный, литературный регистр.',
  'РадКат': 'ведущая ПРОМО.МУЗЫКА. Технологии в музыке, AI-музыка, новая индустрия. Аналитическая, спокойная подача без техно-жаргона.',
  'Стелла': 'ведущая ПРОМО.МУЗЫКА. Культурный комментарий, контекст и эмоция. Душевная, но сдержанная. Литературный язык, как у обозревателя серьёзного журнала.',
};

// ─── Topic rotation ───────────────────────────────────────────────────
const TOPIC_KINDS = [
  'news', 'new_releases', 'concerts',
  'feature_artists', 'feature_djs', 'feature_producers',
  'feature_venues', 'feature_radio',
  'feature_check', 'feature_lab', 'feature_360', 'feature_air',
  'feature_distribution', 'community', 'platform_pulse',
  'coming_features',
];
let topicIndex = 0;

// ─── Helpers ─────────────────────────────────────────────────────────

// ─── Dedup cache (предотвращает повтор news/tracks/concerts) ─────────
const USED_ITEMS_PATH = process.env.USED_ITEMS_PATH || '/opt/promofm-podcast/used-items.json';
const USED_ITEM_TTL_DAYS = parseInt(process.env.USED_ITEM_TTL_DAYS || '7', 10);

// (readFile imported above; writeFile added there too)

async function loadUsedItems() {
  // ЗАКОН: новость прозвучала → больше никогда не повторится. Никакого TTL.
  // Tracks/concerts тоже постоянно — раз озвучили, больше не берём.
  try {
    const raw = await readFile(USED_ITEMS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { news: {}, tracks: {}, concerts: {} };
  }
}

async function saveUsedItems(used) {
  try {
    await writeFile(USED_ITEMS_PATH, JSON.stringify(used));
  } catch (e) {
    console.warn(`[podcast-live] save used-items failed: ${e.message}`);
  }
}

function dedupKeyNews(n) { return (n.id || (n.title || '').toLowerCase().trim()).slice(0, 80); }
function dedupKeyTrack(t) { return ((t.artist || '') + '|' + (t.title || '')).toLowerCase().trim(); }
function dedupKeyConcert(c) { return ((c.artist || c.artist_name || c.title || '') + '|' + (c.city || '') + '|' + (c.event_date || '')).toLowerCase().trim(); }

let _usedCache = null;
async function getUsed() { if (!_usedCache) _usedCache = await loadUsedItems(); return _usedCache; }
async function markUsed(bucket, key) {
  const used = await getUsed();
  used[bucket] = used[bucket] || {};
  used[bucket][key] = Date.now();
  await saveUsedItems(used);
}

async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const data = await r.json();
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(t); }
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }

// ─── Source: news ────────────────────────────────────────────────────

// ─── News topic filter (только музыкальные новости) ─────────────────
const NEWS_REJECT_KEYWORDS = [
  // финансы/политика/экономика
  'биржа', 'фондов', 'курс рубля', 'курс доллара', 'нефть', 'индекс', 'ввп',
  'цб рф', 'центробанк', 'ставк', 'инфляц', 'санкци', 'минфин', 'налог',
  'правительств', 'кремль', 'дума', 'минцифр', 'минздрав', 'выборы',
  // спорт/общее
  'футбол', 'хоккей', 'олимпиад', 'чемпионат мира', 'мчс', 'дтп', 'пожар',
  // погода/происшествия
  'погода', 'циклон', 'наводнен', 'землетрясен',
];

const NEWS_ALLOW_KEYWORDS = [
  'музык', 'трек', 'альбом', 'релиз', 'клип', 'песн', 'певец', 'певиц',
  'артист', 'рэпер', 'рэп', 'хип-хоп', 'рок', 'поп', 'инди', 'электрон',
  'концерт', 'тур ', 'фестиваль', 'дж', 'диджей', 'dj ', 'микс', 'сингл',
  'лейбл', 'продюсер', 'композит', 'премьер', 'клипа', 'spotify', 'apple music',
  'yandex музыка', 'яндекс музык', 'вк музык', 'youtube music', 'shazam',
  'грэмми', 'mtv', 'bbc', 'pitchfork', 'звукозапис',
];

function isMusicNews(n) {
  const txt = ((n.title || '') + ' ' + (n.excerpt || '') + ' ' + (n.content || '')).toLowerCase();
  // если есть запрещённое — выбрасываем
  for (const k of NEWS_REJECT_KEYWORDS) if (txt.includes(k)) return false;
  // если category music / музыка — пропускаем сразу
  const cat = (n.category || '').toLowerCase();
  if (cat.includes('music') || cat.includes('музык') || cat.includes('релиз') || cat.includes('концерт')) return true;
  // иначе требуем хотя бы одно музыкальное keyword
  for (const k of NEWS_ALLOW_KEYWORDS) if (txt.includes(k)) return true;
  return false;
}

async function topicNews() {
  // ЗАКОН: одна новость на выпуск (каждые 30 мин — другая, никаких "в кучу").
  const r = await fetchJSON(`${API_BASE}/server/api/news?limit=20`);
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return null;
  const used = await getUsed();
  const all = r.data
    .filter(n => isMusicNews(n))
    .filter(n => !used.news[dedupKeyNews(n)]);
  if (all.length < 1) {
    console.log('[podcast-live] topicNews: no fresh MUSIC news (filtered), skip');
    return null;
  }
  // Берём САМУЮ свежую (первая в сортировке), одну.
  const picked = fresh.slice(0, 1);
  const items = picked.map(n => ({
    id: n.id, title: n.title || '',
    excerpt: clamp((n.excerpt || n.summary || '').replace(/\s+/g, ' '), 600),
    content: clamp((n.content || '').replace(/\s+/g, ' '), 1200),
    category: n.category || '',
    source: n.source || '',
  }));
  // mark/delete deferred to runOnce after broadcast succeeds
  return {
    kind: 'Новости музыки',
    intro: `Одна история целиком. Обсудим её детально, по фактуре, без вбрасывания списка.`,
    items, items_kind: 'news',
  };
}

// ─── Source: new releases ────────────────────────────────────────────
async function topicNewReleases() {
  const r = await fetchJSON(`${API_BASE}/server/api/landing-data/new-releases?limit=15`);
  if (!r.ok || !r.data?.data?.tracks?.length) return null;
  const used = await getUsed();
  const fresh = r.data.data.tracks.filter(t => !used.tracks[dedupKeyTrack(t)]);
  if (fresh.length < 2) {
    console.log(`[podcast-live] topicNewReleases: only ${fresh.length} fresh tracks, skip`);
    return null;
  }
  const picked = fresh.slice(0, 5);
  const items = picked.map(t => ({
    title: t.title, artist: t.artist,
    isOurArtist: !!t.isOurArtist, source: t.sourceLabel || t.source || '',
  }));
  // mark deferred to runOnce after broadcast succeeds
  return {
    kind: 'Новинки недели',
    intro: 'обзор свежих треков из раздела «Новинки недели» на ПРОМО.МУЗЫКА — что звучит, кто выстрелил',
    items, items_kind: 'tracks',
  };
}

// ─── Source: concerts ────────────────────────────────────────────────
async function topicConcerts() {
  const r = await fetchJSON(`${API_BASE}/server/api/concerts/public?limit=20`);
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return null;
  const used = await getUsed();
  const norm = c => ({
    artist: c.artist_name || c.title || '',
    city: c.city || '',
    venue: c.venue_name || '',
    date: c.event_date || '',
  });
  const fresh = r.data.map(norm).filter(c => !used.concerts[dedupKeyConcert(c)]);
  if (fresh.length < 2) {
    console.log(`[podcast-live] topicConcerts: only ${fresh.length} fresh concerts, skip`);
    return null;
  }
  const picked = fresh.slice(0, 5);
  // mark deferred to runOnce after broadcast succeeds
  return {
    kind: 'Концерты и афиша',
    intro: 'афиша концертов из раздела «Концерты» на ПРОМО.МУЗЫКА — куда сходить в ближайшее время',
    items: picked, items_kind: 'concerts',
  };
}

// ─── Sources: platform features ───────────────────────────────────────
const FEATURE_TOPICS = {
  feature_artists: {
    kind: 'Возможности для артистов',
    intro: 'обзор возможностей платформы ПРОМО.МУЗЫКА для исполнителей — кабинет артиста, релизы, статистика, поддержка через донаты, продвижение на радио ПРОМО.ФМ',
    items: [
      { topic: 'Личный кабинет артиста — релизы, обложки, теги, ISRC' },
      { topic: 'Размещение треков на ПРОМО.ФМ радио и в Новинках недели' },
      { topic: 'Донаты от слушателей — прямые выплаты на карту, без посредников' },
      { topic: 'Скоро — дистрибуция в Яндекс.Музыку, VK, Spotify прямо из кабинета' },
    ],
    items_kind: 'features',
  },
  feature_djs: {
    kind: 'Возможности для диджеев',
    intro: 'кабинет диджея на ПРОМО.МУЗЫКА — миксы, профиль, бронирование, маркетплейс',
    items: [
      { topic: 'Маркетплейс диджеев — клиенты находят и бронируют напрямую' },
      { topic: 'Загрузка миксов и сетов с прослушиваниями и статистикой' },
      { topic: 'Календарь бронирований и приватные сообщения с заказчиками' },
      { topic: 'Эфир на ПРОМО.ФМ через коллабы с радио-кабинетами' },
    ],
    items_kind: 'features',
  },
  feature_producers: {
    kind: 'Возможности для продюсеров и саунд-инженеров',
    intro: 'кабинет продюсера на ПРОМО.МУЗЫКА — битстор, заказы микса/мастеринга, кошелёк',
    items: [
      { topic: 'Битстор — продажа битов с лицензиями (lease/exclusive)' },
      { topic: 'Заказы микса и мастеринга от артистов' },
      { topic: 'Финансовый кабинет — прозрачные роялти и выплаты' },
      { topic: 'Портфолио и отзывы клиентов на странице продюсера' },
    ],
    items_kind: 'features',
  },
  feature_venues: {
    kind: 'Возможности для заведений',
    intro: 'кабинет заведения на ПРОМО.МУЗЫКА — фоновая музыка, лицензии, события, бронирование диджеев',
    items: [
      { topic: 'Фоновая музыка с лицензиями для бизнеса — без претензий от РАО' },
      { topic: 'Бронирование диджеев и живых выступлений в один клик' },
      { topic: 'Анонсы событий на ПРОМО.МУЗЫКА и в эфире ПРОМО.ФМ' },
      { topic: 'Брендированные плейлисты и аудио-айдентика заведения' },
    ],
    items_kind: 'features',
  },
  feature_radio: {
    kind: 'Возможности для радиостанций',
    intro: 'кабинет радиостанции на ПРОМО.МУЗЫКА — заявки от артистов, аналитика эфира, монетизация',
    items: [
      { topic: 'Заявки от артистов — упорядоченная очередь, не хаос в почте' },
      { topic: 'Аналитика эфира — кто что играл, сколько раз, в каких городах' },
      { topic: 'Монетизация — рекламные слоты и брендированные программы' },
      { topic: 'Интеграция с ПРОМО.ФМ для расширения аудитории станции' },
    ],
    items_kind: 'features',
  },
  feature_check: {
    kind: 'ПРОМО.CHECK — мониторинг радио-эфира с AI-детекцией',
    intro: 'ПРОМО.CHECK — это слух платформы. Fingerprint-ит весь радио-эфир каждые 30 секунд, фиксирует ротации, плюс определяет AI-музыку с точностью до 80%. Ротации артистов ПРОМО.МУЗЫКА учитываются автоматически через встроенный watermark в их треках — никакой ручной работы',
    items: [
      { topic: 'Мониторинг сотен радиостанций 24/7 — Shazam-уровень, но для всего эфира' },
      { topic: 'AI-детектор: распознаёт треки, сделанные нейросетями, с точностью до 80%' },
      { topic: 'Watermark в каждом треке артиста ПРОМО.МУЗЫКА — ротации считаются автоматически' },
      { topic: 'Отдельный AI-чарт для авторов, работающих с нейросетями (Suno, Udio, Mubert) — честно и прозрачно' },
      { topic: 'Дашборд: где, когда и сколько раз твой трек звучал, по каким городам' },
      { topic: 'Доказательная база для роялти, лейблов и переговоров с радиостанциями' },
      { topic: 'Бесплатно для всех зарегистрированных артистов на promo-music.ru' },
    ],
    items_kind: 'features',
  },
  feature_lab: {
    kind: 'ПРОМО.LAB — экспертная оценка трека перед релизом',
    intro: 'ПРОМО.LAB разбирает твой трек по 10 критериям до релиза — фидбек от экспертов индустрии плюс AI-анализ, итог за 2-72 часа',
    items: [
      { topic: '10 критериев оценки: продюсирование, мелодия, вокал, текст, микс, коммерческий потенциал, уникальность, хитовость, радио-пригодность, мастеринг' },
      { topic: 'Эксперты индустрии: продюсеры, музыкальные журналисты, A&R лейблов' },
      { topic: 'AI-анализ: гармония, темп, динамика, сравнение с трендами рынка' },
      { topic: 'Конкретный отчёт что улучшить и как — не "норм/не норм"' },
      { topic: 'Запускается в кабинете артиста на ПРОМО.МУЗЫКА' },
    ],
    items_kind: 'features',
  },
  feature_360: {
    kind: 'ПРОМО 360 — видео, монтаж, дизайн для артистов',
    intro: 'ПРОМО 360 — полный production-цех на платформе: видеоклипы, обложки, монтаж, лирик-видео, оформление соцсетей',
    items: [
      { topic: 'Видеоклипы и лирик-видео под ключ' },
      { topic: 'Дизайн обложек альбомов, EP, синглов в один клик' },
      { topic: 'Монтаж выступлений, бэкстейджей, тизеров' },
      { topic: 'Брендинг страницы артиста на ПРОМО.МУЗЫКА — баннеры, шапка, мерч' },
      { topic: 'Заказ прямо из кабинета, прозрачные цены, кейсы в портфолио' },
    ],
    items_kind: 'features',
  },
  feature_air: {
    kind: 'ПРОМО.ФМ — радио платформы ПРОМО.МУЗЫКА',
    intro: 'ПРОМО.ФМ — авто-DJ радио, на котором играют артисты ПРОМО.МУЗЫКА; ведущие — AI-диджеи, эфир 24/7',
    items: [
      { topic: 'Эфир 24/7 — авто-DJ ставит треки артистов платформы' },
      { topic: 'AI-ведущие представляют артистов, ставят треки в контекст' },
      { topic: 'Аналитика для артистов: сколько раз твой трек играл, кто слушал' },
      { topic: 'Подкасты-выпуски: новости, новинки, концерты, фичи платформы' },
      { topic: 'Слушать: promo-music.ru/air, доступно бесплатно' },
    ],
    items_kind: 'features',
  },
  feature_distribution: {
    kind: 'Скоро — дистрибуция в стриминги',
    intro: 'ПРОМО.МУЗЫКА скоро запускает дистрибуцию в Яндекс.Музыку, VK Музыку, Spotify, Apple Music, СберЗвук и ещё 30+ сервисов прямо из кабинета артиста',
    items: [
      { topic: 'Один upload — везде. Яндекс.Музыка, VK, Spotify, Apple Music, YouTube Music, СберЗвук, Deezer, TikTok' },
      { topic: 'Аналитика прослушиваний по всем платформам в одном дашборде' },
      { topic: 'Прозрачные роялти, выплаты на карту без минимального порога' },
      { topic: 'ISRC и UPC коды автоматически, ничего вручную' },
      { topic: 'Early access — оставь email на promo-music.ru, первые получат -50% на первый год' },
    ],
    items_kind: 'features',
  },
  community: {
    kind: 'Что такое ПРОМО.МУЗЫКА — комьюнити, а не B2B',
    intro: 'ПРОМО.МУЗЫКА — это не платформа "бизнес для бизнеса". Это музыкальное комьюнити нового времени, где артист — главная единица, а заведения, радио, продюсеры и диджеи — это среда, которая помогает артисту расти',
    items: [
      { topic: 'Артист — центр экосистемы, всё остальное служит ему: радио играет, заведения нанимают, продюсеры делают биты, мониторинг считает' },
      { topic: 'Не маркетплейс с агентами и комиссиями — прямые связи между участниками' },
      { topic: 'Цель — развитие музыкальной культуры и индустрии в России, а не извлечение ренты' },
      { topic: 'Каждый участник — артист, диджей, продюсер, заведение, радио — равноправный голос в комьюнити' },
      { topic: 'Музыкальная платформа нового времени: AI там, где помогает, человек там, где решает' },
      { topic: 'Регистрация бесплатна для всех ролей, кабинет открыт сразу' },
    ],
    items_kind: 'features',
  },
  coming_features: {
    kind: 'Что планируется в эфире ПРОМО.ФМ',
    intro: 'обзор того, что мы готовим для слушателей: миксы диджеев, лайв-сеты, интервью с артистами, тематические программы',
    items: [
      { topic: 'Авторские миксы диджеев ПРОМО.МУЗЫКА — техно, хаус, хип-хоп, чилл' },
      { topic: 'Лайв-сеты с виртуальных и реальных вечеринок — будем включать прямо в эфир' },
      { topic: 'Интервью с артистами платформы — кто что выпускает, о чём пишет, куда движется' },
      { topic: 'Гостевые включения продюсеров и саунд-инженеров с разборами треков' },
      { topic: 'Подкаст-выпуски про индустрию: чарты, релизы, тренды' },
      { topic: 'Тематические программы: новинки русского рэпа, инди, электроника, классика' },
      { topic: 'AutoDJ работает 24/7, сводит треки без перерывов' },
    ],
    items_kind: 'features',
  },
  platform_pulse: {
    kind: 'Пульс ПРОМО.МУЗЫКА — что происходит на платформе прямо сейчас',
    intro: 'обзор того, что произошло на платформе за последние дни: новые артисты, миксы, концерты, заказы продюсерам, ротации',
    items: [
      { topic: 'Новые артисты, которые зарегистрировались за неделю' },
      { topic: 'Самые крутящиеся треки в эфире ПРОМО.ФМ' },
      { topic: 'Активность диджеев — кто залил миксы, кого забронировали' },
      { topic: 'Концерты, которые ближайшие выходные' },
      { topic: 'Заказы продюсерам — биты, миксы, мастеринги' },
    ],
    items_kind: 'features',
  },
};



// ─── Discovery cache loader ──────────────────────────────────────────
async function loadDiscovery() {
  try {
    const raw = await readFile(DISCOVERY_CACHE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[podcast-live] discovery cache unreadable: ${e.message}`);
    return null;
  }
}

async function topicPlatformPulse() {
  const d = await loadDiscovery();
  if (!d) return null;
  const items = [];
  if (d.stats) {
    items.push({ topic: `На платформе ${d.stats.totalArtists || 0} артистов, ${d.stats.publishedTracks || d.stats.totalTracks || 0} опубликованных треков, ${d.stats.totalUsers || 0} зарегистрированных участников` });
  }
  if (d.artists && d.artists.fresh && d.artists.fresh.length) {
    const names = d.artists.fresh.slice(0, 5).map(a => a.name).filter(Boolean).join(', ');
    if (names) items.push({ topic: `Свежие артисты на платформе: ${names}` });
  }
  if (d.tracks && d.tracks.composite_chart && d.tracks.composite_chart.length) {
    const top = d.tracks.composite_chart.slice(0, 4).map(t => `${t.artist} — «${t.title}»`).join('; ');
    items.push({ topic: `Композитный чарт сегодня: ${top}` });
  }
  if (d.tracks && d.tracks.ai_chart && d.tracks.ai_chart.length) {
    const ai = d.tracks.ai_chart.slice(0, 3).map(t => `${t.artist} — «${t.title}»`).join('; ');
    items.push({ topic: `AI-чарт (треки нейросетей): ${ai}` });
  }
  if (d.concerts && d.concerts.length) {
    const c = d.concerts.slice(0, 3).map(c => `${c.artist} в ${c.city}`).join(', ');
    items.push({ topic: `Ближайшие концерты: ${c}` });
  }
  if (d.producers && d.producers.profiles && d.producers.profiles.length) {
    const p = d.producers.profiles.slice(0, 3).map(p => p.name).filter(Boolean).join(', ');
    if (p) items.push({ topic: `Активные продюсеры: ${p}` });
  }
  if (d.beats && d.beats.length) {
    const minPrice = Math.min(...d.beats.map(b => b.price || 1000));
    items.push({ topic: `Битстор: ${d.beats.length} битов на маркетплейсе, от ${minPrice}₽` });
  }
  if (items.length < 3) return null;
  return {
    kind: 'Пульс ПРОМО.МУЗЫКА — что происходит на платформе сейчас',
    intro: `обзор живой статистики платформы по данным агента-разведчика (snapshot ${d.updatedAt})`,
    items, items_kind: 'features',
  };
}

async function nextTopic() {
  const tries = TOPIC_KINDS.length;
  for (let i = 0; i < tries; i++) {
    const kind = TOPIC_KINDS[topicIndex % TOPIC_KINDS.length];
    topicIndex++;
    let topic = null;
    try {
      if (kind === 'news') topic = await topicNews();
      else if (kind === 'new_releases') topic = await topicNewReleases();
      else if (kind === 'concerts') topic = await topicConcerts();
      else if (kind === 'platform_pulse') topic = await topicPlatformPulse();
      else topic = FEATURE_TOPICS[kind] || null;
    } catch (e) {
      console.warn(`[podcast-live] topic ${kind} failed: ${e.message}`);
    }
    if (topic) return topic;
  }
  return FEATURE_TOPICS.feature_artists;
}

// ─── Gemini script generation (Gemini 3 Flash через прокси) ──────────
async function geminiGenerate(prompt) {
  const url = `${GEMINI_PROXY_URL}/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const r = await fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.85, maxOutputTokens: 4096, responseMimeType: 'application/json' },
    }),
    timeout: 60000,
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text;
}

function buildPrompt(topic, hostA, hostB, minTurns, maxTurns) {
  const itemsBlock = (topic.items || []).map((it, i) => {
    if (topic.items_kind === 'news')
      return `${i+1}. ${it.title}\n   ${it.excerpt}`;
    if (topic.items_kind === 'tracks')
      return `${i+1}. ${it.artist} — «${it.title}»${it.isOurArtist ? ' (артист ПРОМО.МУЗЫКА)' : ` [${it.source}]`}`;
    if (topic.items_kind === 'concerts')
      return `${i+1}. ${it.artist}, ${it.city}, ${it.venue}, ${it.date}`;
    return `${i+1}. ${it.topic}`;
  }).join('\n');

  return `Ты — сценарист радио-подкаста ПРОМО.ФМ. Это лайв-радио платформы ПРОМО.МУЗЫКА (https://promo-music.ru/air).

КОНТЕКСТ ПЛАТФОРМЫ (это база, помни всегда):
ПРОМО.МУЗЫКА — это НЕ "бизнес для бизнеса". Это музыкальное комьюнити нового времени для развития культуры и индустрии в России. Главная единица — артист. Всё остальное (радио, заведения, продюсеры, диджеи) — среда, которая помогает артисту расти. Каждый участник — равноправный голос.

Состав платформы:
- Кабинеты артистов, диджеев, продюсеров, заведений, радиостанций — все бесплатно
- ПРОМО.ФМ — лайв-радио 24/7 с AI-диджеями (ты сейчас в эфире одного из них)
- ПРОМО.CHECK — слух платформы: fingerprint-инг радио-эфира + AI-детектор (80% точность) + watermark-ротации артистов считаются автоматически + отдельный AI-чарт для нейро-авторов
- ПРОМО.LAB — экспертная оценка трека до релиза по 10 критериям, 2-72 часа
- ПРОМО 360 — видеоклипы, обложки, монтаж, дизайн (всё под ключ)
- Скоро — дистрибуция в Яндекс.Музыку, VK, Spotify, Apple Music, СберЗвук и ещё 30+ сервисов прямо из кабинета. Early access на promo-music.ru, ранние получат -50%
- В эфире ПРОМО.ФМ скоро: авторские миксы диджеев, лайв-сеты, интервью с артистами платформы, гостевые включения продюсеров и тематические программы. Сейчас идёт авто-DJ 24/7 + AI-ведущие.

Тема выпуска: ${topic.kind}
Контекст: ${topic.intro}

Источники (используй ТОЛЬКО эту фактуру, не выдумывай):
${itemsBlock}

Ведущие — официальные диджеи ПРОМО.МУЗЫКА, ВСЕГДА рекламируют платформу как родную:
- ${hostA}: ${HOST_DESC[hostA]}
- ${hostB}: ${HOST_DESC[hostB]}

Сгенерируй живой диалог между двумя ведущими, ${minTurns}-${maxTurns} реплик.

ОБЯЗАТЕЛЬНЫЕ требования (без них выпуск не выйдет в эфир):
1. Первая реплика — короткое приветствие "Привет, вы на ПРОМО.ФМ" (или вариация) с упоминанием платформы ПРОМО.МУЗЫКА.
2. Хотя бы один раз по ходу выпуска подчеркнуть что ПРОМО.МУЗЫКА — это комьюнити для развития музыкальной культуры, а не "бизнес для бизнеса". Артист — главная единица. (Не подряд с другими промо, размажь по диалогу естественно.)
3. По ходу диалога 1-2 раза ОБЯЗАТЕЛЬНО призыв зарегистрироваться: "Если ты артист, диджей, продюсер или у тебя заведение — регистрируйся на promo-music.ru". Можно вариативно, но смысл сохраняй.
4. Если тема — feature (про CHECK, LAB, 360 и т.д.) — раскрой детально, как работает, для кого, что даёт. Не общие фразы.
5. Один раз упомянуть что скоро запускается дистрибуция в стриминги (Яндекс.Музыка, VK, Spotify, Apple Music) — если тема не противоречит контексту.
6. Предпоследняя или последняя реплика — упомянуть конкретный URL: promo-music.ru или promo-music.ru/air для эфира.
7. ПОСЛЕДНЯЯ реплика ОБЯЗАТЕЛЬНО содержит фразу "оставайтесь с нами на ПРОМО.ФМ и ПРОМО.МУЗЫКА".

СТИЛЬ:
- Реплики разговорные, 1-3 предложения каждая. Без markdown, скобок, сценических ремарок.
- Натуральный русский. Никаких "давайте разберём", "погружаемся", "безусловно" — это AI-фразочки, запрещены.
- Никаких выдумок про артистов/факты — только из источников выше.
- Главная задача ведущих — максимально подробно и красиво представить платформу и осветить события. Они её любят и знают изнутри.
- Промо — органично, через эмоцию и живое объяснение. Они реально работают на ПРОМО.МУЗЫКА, это их дом, а не рекламный текст.
- Они РАДИО-ВЕДУЩИЕ в эфире, не сценаристы и не соавторы. ЗАПРЕЩЕНО: спрашивать друг у друга "как тебе такой вариант?", "что думаешь о моём заходе?", "а ты бы как сформулировал?". Это разрушает иллюзию эфира.
- ТАКЖЕ ЗАПРЕЩЕНО спрашивать у слушателей: "как вам?", "что скажете?", "как вам такое?", "согласны?". Слушатели не отвечают в эфире, такие вопросы звучат фальшиво.
- Можно: реакции "точно", "да, и ещё", "добавлю", прямые перебивки и развитие мысли коллеги. Они РАЗГОВАРИВАЮТ, не СВЕРЯЮТСЯ.
- Никаких ремарок про сам подкаст: "в этом выпуске", "в следующей рубрике", "мы подготовили". Просто говори.

РЕГИСТР:
- Это серьёзное профессиональное радио, не молодёжная FM-морнингка. Тон — как у ведущего качественного музыкального издания: уверенный, заинтересованный, литературный.
- ЗАПРЕЩЕНО: уличный/разговорный сленг ("кайф", "топчик", "огонь", "кринж", "вайб" в значении настроения, "чувак", "бро", "пацаны", "ребят", "чёткий", "крутой трек", "мощно", "респект", "зашло/не зашло").
- ЗАПРЕЩЕНО: уменьшительно-ласкательные ("треки-новинки", "новинки-конфетки").
- Эмоции — через точные слова, не через сленг. Вместо "это огонь" — "это сильная работа", вместо "крутой релиз" — "уверенный релиз", вместо "мощно зашло" — "работа произвела впечатление".
- Можно: профессиональная лексика (релиз, ротация, лейбл, продакшн, мастеринг, аранжировка), сравнения, конкретика.

ПРИМЕРЫ ПЛОХО vs ХОРОШО:
- ПЛОХО: "Ребят, тут такой огонь вышел, прям зашёл!"
  ХОРОШО: "Этот релиз заметно выделяется на сцене последних недель."
- ПЛОХО: "Привет, че как, погнали разбирать треки."
  ХОРОШО: "Здравствуйте, вы на ПРОМО.ФМ. Сегодня речь пойдёт о свежем релизе."
- ПЛОХО: "Жесть, как круто! Бро, ты слышал?"
  ХОРОШО: "Работа сделана уверенно и звучит зрело."
- ПЛОХО: "Тут такая тема, прям топчик."
  ХОРОШО: "Это одна из заметных работ этой недели."
- ПЛОХО: "Все на ПРОМО.МУЗЫКА, го регаться, бесплатно же!"
  ХОРОШО: "Зарегистрироваться можно бесплатно на promo-music.ru — кабинет открывается сразу."

ВАЖНО: Это серьёзная музыкальная радиостанция. Слушатели — взрослые люди со вкусом. Молодёжный сленг неуместен. Если сомневаешься в слове — представь, что фразу читают на Радио Культура или в эфире BBC Radio 3.

Верни СТРОГО JSON массив (без обёрток, без markdown):
[
  {"author": "${hostA}", "text": "..."},
  {"author": "${hostB}", "text": "..."},
  ...
]`;
}

async function makeDialogue(topic) {
  const [hostA, hostB] = pick(HOST_PAIRS);
  const prompt = buildPrompt(topic, hostA, hostB, PODCAST_MIN_TURNS, PODCAST_MAX_TURNS);

  let text;
  try {
    text = await geminiGenerate(prompt);
  } catch (e) {
    console.error(`[podcast-live] Gemini failed: ${e.message}`);
    return null;
  }

  let dialogue;
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    dialogue = JSON.parse(cleaned);
  } catch (e) {
    console.error(`[podcast-live] JSON parse failed: ${e.message}\nRaw: ${text.slice(0, 300)}`);
    return null;
  }

  if (!Array.isArray(dialogue) || dialogue.length < 4) {
    console.warn(`[podcast-live] dialogue too short: ${dialogue?.length}`);
    return null;
  }

  // Гарантия 1: финальная фраза
  const fullText = dialogue.map(t => (t.text || '').toLowerCase()).join(' ');
  const lastText = (dialogue[dialogue.length - 1]?.text || '').toLowerCase();
  if (!lastText.includes('промо.фм') || !lastText.includes('промо.музыка')) {
    dialogue.push({
      author: hostA,
      text: 'Оставайтесь с нами на ПРОМО.ФМ и ПРОМО.МУЗЫКА — здесь живая музыка и живой эфир.',
    });
  }

  // Гарантия 2: CTA на регистрацию (если Gemini забыл)
  if (!/регистр/i.test(fullText)) {
    // вставляем в середину
    const mid = Math.floor(dialogue.length / 2);
    dialogue.splice(mid, 0, {
      author: hostB,
      text: 'И напоминаем: если ты артист, диджей, продюсер или у тебя заведение — регистрируйся на promo-music.ru, кабинет бесплатный.',
    });
  }

  return { hostA, hostB, turns: dialogue.slice(0, PODCAST_MAX_TURNS + 4) };
}


// ─── Banned-phrase scrubber (защита если Gemini забыл prompt-инструкции) ─
const BANNED_PATTERNS = [
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

// Заменители для разговорного сленга — сохраняем фразу но в серьёзном регистре
const SLANG_REPLACEMENTS = [
  // подростковые/уличные обороты
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
  [/\bкрутой\s+(трек|релиз|альбом|сингл|бит)\b/gi, 'уверенный '],
  [/\bкрутая\s+(работа|штука|тема|песня)\b/gi, 'сильная '],
  [/\bмощно\s+зашло\b/gi, 'произвело впечатление'],
  [/\bзашло\b/gi, 'понравилось'],
  [/\bне зашло\b/gi, 'не убедило'],
  [/\bвайб\b/gi, 'атмосфера'],
  [/\bкринж(\b|евый)/gi, 'неловко'],
  [/\bреспект\b/gi, 'уважение'],
  [/\bчёткий\s+(трек|релиз|бит|звук)\b/gi, 'точный '],
  [/\b(чувак|чуваки|бро|пацаны|ребят[аы]?)\b/gi, 'слушатели'],
  [/\bтопчик\b/gi, 'лидер'],
  [/\bмощно\b/gi, 'сильно'],
  [/\bтреки-(новинки|конфетки|шедевры)\b/gi, 'новые работы'],
];

function scrubBanned(text) {
  let cleaned = String(text || '');
  for (const re of BANNED_PATTERNS) {
    cleaned = cleaned.replace(re, '');
  }
  for (const [re, rep] of SLANG_REPLACEMENTS) {
    cleaned = cleaned.replace(re, rep);
  }
  // Радио-ведущие говорят утверждениями, не задают вопросы (кроме первого приветствия).
  // Заменяем ? на . чтобы не было вопросительной интонации в TTS.
  // Кроме приветствия (если содержит "привет" / "добрый день" — оставляем как есть).
  if (!/привет|добр(ый|ого)\s+(день|вечер|утро)/i.test(cleaned)) {
    cleaned = cleaned.replace(/\?+/g, '.');
  }
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  cleaned = cleaned.replace(/[,;:]\s*$/, '.').replace(/\s+(и|а|но|или)\s*\.?$/i, '.');
  return cleaned;
}


// ─── Delete news from DB after successful broadcast (admin API) ─────
async function deleteNewsFromDB(newsId) {
  if (!newsId) return false;
  try {
    const r = await fetch(`${API_BASE}/server/api/landing-data/admin/news/${encodeURIComponent(newsId)}`, {
      method: 'DELETE',
      headers: { 'X-Internal-Key': INTERNAL_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      console.log(`[podcast-live] deleted news ${newsId} from DB (закон: один раз — навсегда)`);
      return true;
    } else {
      console.warn(`[podcast-live] delete news ${newsId} failed: ${r.status}`);
    }
  } catch (e) {
    console.warn(`[podcast-live] delete news ${newsId} error: ${e.message}`);
  }
  return false;
}

// ─── Broadcast via /text (no LLM re-script, Gemini диалог уже готов) ─
async function speak(text, author) {
  const r = await fetchJSON(`${API_BASE}/server/api/broadcast/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_KEY },
    body: JSON.stringify({ text, author }),
    timeout: SPEAK_TIMEOUT_MS,
  });
  return r;
}

// ─── Single podcast run ──────────────────────────────────────────────
let running = false;
async function runOnce() {
  if (running) { console.log('[podcast-live] still running, skip'); return; }
  running = true;
  const startedAt = Date.now();

  try {
    const topic = await nextTopic();
    console.log(`[podcast-live] topic: ${topic.kind} (${topic.items?.length || 0} items)`);

    const dialogue = await makeDialogue(topic);
    if (!dialogue) {
      console.warn('[podcast-live] no dialogue, skip');
      return;
    }

    console.log(`[podcast-live] hosts: ${dialogue.hostA} + ${dialogue.hostB}, turns: ${dialogue.turns.length}`);

    let okCount = 0;
    for (const turn of dialogue.turns) {
      const rawText = (turn.text || '').toString().trim();
      const text = scrubBanned(rawText);
      const author = turn.author || dialogue.hostA;
      if (!text || text.length < 5) continue;
      if (text !== rawText) {
        console.log('[podcast-live] scrubbed: ' + rawText.slice(0, 80) + ' -> ' + text.slice(0, 80));
      }

      // ANTI-OVERLAP loop: если AutoDJ busy (423) — ждём и повторяем
      let res, attempt = 0;
      while (true) {
        res = await speak(text, author);
        if (res.status === 423 && attempt < 5) {
          const wait = Math.max(2000, parseInt(res.data?.retry_after_ms || 5000, 10));
          console.log(`[podcast-live] AutoDJ busy, retry in ${wait}ms (attempt ${attempt + 1}/5)`);
          await new Promise(r => setTimeout(r, wait));
          attempt++;
          continue;
        }
        break;
      }

      if (res.ok && res.data?.ok) {
        okCount++;
        const dur = parseFloat(res.data.duration || 0);
        console.log(`[podcast-live] ✓ ${author} (${dur.toFixed(1)}s): ${text.slice(0, 60)}...`);
        // ЖДЁМ полную длительность аудио (TTS PCM ушёл в очередь, но играет в эфире сейчас)
        // + дополнительная music-breath пауза между репликами
        const playbackMs = Math.ceil(dur * 1000);
        await new Promise(r => setTimeout(r, playbackMs + TURN_PAUSE_MS));
      } else {
        console.warn(`[podcast-live] ✗ ${author}: ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
        // короткая пауза при ошибке чтобы не спамить
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[podcast-live] done: ${okCount}/${dialogue.turns.length} turns in ${elapsed}s`);

    // ЗАКОН: новость прозвучала → удалена из БД и из списка тем навсегда.
    // tracks/concerts → permanent dedup в used-items.json.
    // Применяется только если >= 50% реплик ушло в эфир (иначе считаем что выпуск не состоялся).
    if (okCount >= Math.ceil(dialogue.turns.length / 2) && topic.items && topic.items.length) {
      if (topic.items_kind === 'news') {
        for (const item of topic.items) {
          if (item.id) {
            await deleteNewsFromDB(item.id);
            await markUsed('news', dedupKeyNews(item));
          }
        }
      } else if (topic.items_kind === 'tracks') {
        for (const item of topic.items) await markUsed('tracks', dedupKeyTrack(item));
      } else if (topic.items_kind === 'concerts') {
        for (const item of topic.items) await markUsed('concerts', dedupKeyConcert(item));
      }
    } else {
      console.log(`[podcast-live] broadcast incomplete (${okCount}/${dialogue.turns.length}), items NOT marked as used`);
    }
  } catch (e) {
    console.error(`[podcast-live] runOnce failed: ${e.message}\n${e.stack}`);
  } finally {
    running = false;
  }
}

// ─── Main loop ───────────────────────────────────────────────────────
async function main() {
  console.log(`[podcast-live] start. interval=${PODCAST_INTERVAL_SEC}s turns=${PODCAST_MIN_TURNS}-${PODCAST_MAX_TURNS} model=${GEMINI_TEXT_MODEL}`);
  if (!process.argv.includes('--once')) await new Promise(r => setTimeout(r, 60000));
  while (true) {
    if (process.argv.includes('--once') && topicIndex > 0) break;
    await runOnce();
    await new Promise(r => setTimeout(r, PODCAST_INTERVAL_SEC * 1000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });

process.on('SIGTERM', () => { console.log('[podcast-live] SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { console.log('[podcast-live] SIGINT'); process.exit(0); });
