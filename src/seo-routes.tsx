import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { getChartSource } from './db.tsx';
import { PILLAR_PAGES, type PillarMeta } from './seo-content.tsx';
import { ALL_ALIASES, type SeoAlias } from './seo-aliases.tsx';
import { getPublicationPrice } from './pricing.tsx';
import { classifySpaPath, seoRegistryEntry } from './spa-routes.tsx';
import { getPublicTrack, getPublicVideo, getPublicArtist, fmtDuration, PUBLIC_CONCERT_SQL } from './public-content.tsx';

const seoRoutes = new Hono();
const DOMAIN = 'https://promo-music.ru';
const SITE_NAME = 'ПРОМО.МУЗЫКА';
const SITE_DESC = 'Платформа продвижения для артистов: питчинг на {{STATIONS_ACC}}, попадание в плейлисты Яндекс.Музыки и VK Музыки, чарты, дистрибуция.';
// Разговорные написания бренда. Боту нужно видеть их в тексте и в Organization-разметке:
// «ПРОМО.МУЗЫКА» с точкой поисковик за фразу «промо музыка» не засчитывает.
const SITE_ALT_NAMES = ['Промо Музыка', 'Promo Music', 'PROMO.MUSIC', 'promo-music.ru'];
const HOME_KEYWORDS = 'промо музыка, promo music, продвижение музыки, питчинг на радио, попасть на радио, чарты, дистрибуция музыки, promo-music.ru';
const LOGO = `${DOMAIN}/logo.png`;

function esc(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Товары маркетплейса для робота — то же, что человек видит на /marketplace.
async function renderMarketItemsHtml(): Promise<string> {
  const KIND: Record<string, string> = { beat: 'Бит', minus: 'Минус', song: 'Песня' };
  const { rows } = await pool.query(
    `SELECT kind, title, seller_name, genre, bpm, music_key, price_lease, price_exclusive
       FROM market_items WHERE status = 'active' ORDER BY created_at DESC LIMIT 60`,
  );
  if (!rows.length) {
    return '<p>Витрина только открылась: первые продавцы выставляют свои биты, минусы и песни. Выставить свою работу можно уже сейчас.</p>';
  }
  const rub = (n: unknown) => `${Math.round(Number(n)).toLocaleString('ru-RU')} ₽`;
  return `<ul>${rows.map((r: any) => {
    const meta = [r.genre, r.bpm ? `${r.bpm} BPM` : '', r.music_key].filter(Boolean).join(', ');
    const prices = [r.price_lease ? `лицензия ${rub(r.price_lease)}` : '', r.price_exclusive ? `эксклюзив ${rub(r.price_exclusive)}` : ''].filter(Boolean).join(', ');
    return `<li>${KIND[r.kind] || ''} «${esc(r.title)}» — ${esc(r.seller_name || '')}${meta ? ` (${esc(meta)})` : ''}: ${prices}</li>`;
  }).join('')}</ul>`;
}

function escJson(s: string): string {
  return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function stripHtml(s: string): string {
  return (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<base[^>]*>/gi, '')
    .replace(/\s*on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/href\s*=\s*"\s*javascript:/gi, 'href="')
    .replace(/src\s*=\s*"\s*javascript:/gi, 'src="')
    .replace(/src\s*=\s*"\s*data:/gi, 'src="');
}

function fmtDate(d: string | undefined): string {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; }
}

// ─── Stations count (real COUNT from pitching_radio_stations VIEW) ───
//
// Was hardcoded literal "742" in 13 places (this file + seo-aliases.tsx).
// Now it comes from SELECT COUNT(*) FROM pitching_radio_stations (created
// in migration 009 as a VIEW over pitching_radio). Cached 5 min to avoid
// DB round-trip per SSR request. На сбое — последнее известное или 742
// (legacy fallback) — раньше юзер видел именно 742, не регрессия.
let stationsCountCache: { value: number; fetchedAt: number } | null = null;
const STATIONS_COUNT_TTL_MS = 5 * 60_000;
const STATIONS_COUNT_FALLBACK = 742;

async function getStationsCount(): Promise<number> {
  const now = Date.now();
  if (stationsCountCache && now - stationsCountCache.fetchedAt < STATIONS_COUNT_TTL_MS) {
    return stationsCountCache.value;
  }
  try {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pitching_radio_stations`,
    );
    const count = Number(rows[0]?.count || 0);
    if (count > 0) {
      stationsCountCache = { value: count, fetchedAt: now };
      return count;
    }
  } catch (err) {
    console.warn('[seo] getStationsCount query failed, falling back:', err);
  }
  return stationsCountCache?.value ?? STATIONS_COUNT_FALLBACK;
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

// Число станций базы питчинга с существительным в нужном падеже:
// «на 970 радиостанций», «из 742 радиостанций», «на 971 радиостанцию».
// Раньше шаблоны писали «на {{STATIONS_COUNT}} радиостанции» — при 970 это ошибка.
function stationsPhrase(n: number, kase: 'acc' | 'gen' | 'dat' | 'prep'): string {
  const one = n % 10 === 1 && n % 100 !== 11;
  switch (kase) {
    case 'acc': return `${n} ${ruPlural(n, 'радиостанцию', 'радиостанции', 'радиостанций')}`;
    case 'gen': return `${n} ${one ? 'радиостанции' : 'радиостанций'}`;
    case 'dat': return `${n} ${one ? 'радиостанции' : 'радиостанциям'}`;
    case 'prep': return `${n} ${one ? 'радиостанции' : 'радиостанциях'}`;
  }
}

function replaceTokens(html: string, ctx: { stationsCount: number }): string {
  const n = ctx.stationsCount;
  // Цена публикации — из того же pricing.tsx, что и оплата (7 000 → 10 000 ₽ с 01.09.2026).
  const price = `${getPublicationPrice().toLocaleString('ru-RU').replace(/\u00a0/g, ' ')} ₽`;
  return html
    .replace(/\{\{STATIONS_ACC\}\}/g, stationsPhrase(n, 'acc'))
    .replace(/\{\{STATIONS_GEN\}\}/g, stationsPhrase(n, 'gen'))
    .replace(/\{\{STATIONS_DAT\}\}/g, stationsPhrase(n, 'dat'))
    .replace(/\{\{STATIONS_PREP\}\}/g, stationsPhrase(n, 'prep'))
    .replace(/\{\{STATIONS_COUNT\}\}/g, String(n))
    .replace(/\{\{PUBLICATION_PRICE\}\}/g, price);
}

// Async wrappers: подставляют реальный COUNT(*) из pitching_radio_stations
// в HTML перед отдачей боту. Sync renderPage/renderPillar оставлены для
// единичных мест где токены не нужны (если такие появятся).
async function renderPageWithTokens(opts: Parameters<typeof renderPage>[0]): Promise<string> {
  const stationsCount = await getStationsCount();
  return replaceTokens(renderPage(opts), { stationsCount });
}

async function renderPillarWithTokens(p: PillarMeta): Promise<string> {
  const stationsCount = await getStationsCount();
  return replaceTokens(renderPillar(p), { stationsCount });
}

// ─── Page meta configs ───
const PAGE_META: Record<string, { title: string; desc: string; type: string; image?: string }> = {
  '/': { title: `${SITE_NAME} — продвижение музыки, питчинг на радио и в плейлисты`, desc: SITE_DESC, type: 'website' },
  '/news': { title: `Новости музыки — ${SITE_NAME}`, desc: 'Свежие новости музыкальной индустрии: релизы, фестивали, интервью, аналитика', type: 'website' },
  '/charts': { title: `Музыкальные чарты TOP 50 — ${SITE_NAME}`, desc: 'Еженедельный чарт из Spotify, Apple Music, Яндекс Музыки, радиостанций и ВКонтакте', type: 'website' },
  '/concerts': { title: `Концерты и фестивали — ${SITE_NAME}`, desc: 'Афиша концертов и музыкальных событий', type: 'website' },
  '/airplay-monitoring': { title: `Мониторинг эфира радиостанций: когда ваша песня звучит на радио — ${SITE_NAME}`, desc: 'Автоматический мониторинг эфира радиостанций по аудиоотпечатку. Точное время эфира песни на радио, отчёт по дням и станциям, подсчёт фактических ротаций трека.', type: 'website' },
  '/promo-air': { title: `ПРОМО.ЭИР: песня на радио и музыка для заведения от одного оператора — ${SITE_NAME}`, desc: 'ПРОМО.ЭИР доводит песню до плейлист-комитетов радиостанций из базы в {{STATIONS_ACC}} и поставляет лицензированную музыку для кафе, ресторанов, баров, фитнес-клубов и магазинов. Радиоротации артистам и фоновое аудио бизнесу из одной системы.', type: 'website' },
  '/pesnya-na-radio': { title: 'Песня на радио: как попасть в ротацию — ПРОМО.МУЗЫКА', desc: 'Подробное руководство, как разместить песню на радио: подача в базу из {{STATIONS_GEN}}, решение редакторов о ротации и отчёт о реальных эфирах. ПРОМО.ЭИР доводит трек до плейлист-комитета без посредников.', type: 'article' },
  '/muzyka-dlya-zavedeniya': { title: 'Музыка для заведения: кафе, ресторан, магазин — ПРОМО.ЭИР', desc: 'Лицензионная музыка для заведений: кафе, рестораны, бары, фитнес-клубы, магазины и салоны. Готовые плейлисты под формат места, каталог без договоров с РАО и ВОИС, брендированные джинглы и звуковая идентичность от ПРОМО.ЭИР.', type: 'article' },
  '/for-venues': { title: 'Радио для заведений и музыка в зал — ПРОМО.ЭИР', desc: 'Лицензионная музыка для заведений общепита, ритейла и услуг. Подбор плейлистов под аудиторию, каталог без договоров с РАО и ВОИС, фирменные джинглы и звуковое оформление зала от ПРОМО.ЭИР.', type: 'website' },
  '/music-for-restaurants': { title: 'Музыка для ресторанов без РАО и ВОИС — ПРОМО.ЭИР', desc: 'Музыка для ресторана под завтрак, обед и ужин: легально, без договоров с РАО и ВОИС. Анонсы меню и событий в эфире, от 4 990 ₽ в месяц, 14 дней бесплатно.', type: 'website' },
  '/audio-branding': { title: `Звуковой брендинг: джинглы, аудиоидентичность и звук бренда — ${SITE_NAME}`, desc: 'Создание звукового бренда: фирменные джинглы, музыкальная тема, аудио-логотип и звуковая идентичность для бизнеса. Внедряется в плейлисты заведений, рекламу и точки контакта.', type: 'website' },
  '/audiobranding': { title: `Звуковой брендинг для бизнеса: джинглы и музыкальная идентичность — ${SITE_NAME}`, desc: 'Звуковой брендинг для заведений и компаний: фирменные джинглы, аудио-логотип, музыкальная тема. ПРОМО.ЭИР собирает плейлист и звуковые элементы под бренд.', type: 'website' },
  '/radio-advertising': { title: `Реклама на радио: размещение роликов на радиостанциях России — ${SITE_NAME}`, desc: 'Размещение рекламы на радио: подбор станций под аудиторию, расчёт охвата, производство ролика и эфирная сетка. Работаем по всей России через операторскую систему ПРОМО.ЭИР.', type: 'website' },
  '/airplay-monitoring-': { title: `Мониторинг ротаций песни на радио — ${SITE_NAME}`, desc: 'Сервис мониторинга эфира радиостанций. Узнайте, когда и сколько раз песня прозвучала на радио.', type: 'website' },
  '/promo-lab': { title: `ПРОМО.ЛАБ — оценка треков — ${SITE_NAME}`, desc: 'Профессиональная оценка треков от экспертов индустрии', type: 'website' },
  '/promo-guide': { title: `ПРОМО.ГИД — руководства — ${SITE_NAME}`, desc: 'Гайды по продвижению музыки и развитию карьеры артиста', type: 'website' },
  '/marketplace': { title: `Маркетплейс битов, минусов и песен — ${SITE_NAME}`, desc: 'Купить или продать бит, минус или песню: лицензия или эксклюзив, оплата через ЮKassa', type: 'website' },
  '/tracks': { title: `Треки — ${SITE_NAME}`, desc: 'Слушайте и открывайте новую музыку: треки артистов платформы', type: 'website' },
  '/radio': { title: `Радиостанции — ${SITE_NAME}`, desc: 'Каталог радиостанций-партнёров: ротации, эфиры, сотрудничество', type: 'website' },
  '/videos': { title: `Видео — ${SITE_NAME}`, desc: 'Музыкальные видео, клипы и live-выступления артистов', type: 'website' },
  '/booking': { title: `Букинг — ${SITE_NAME}`, desc: 'Забронируйте артиста, DJ или площадку для мероприятия', type: 'website' },
  '/curator': { title: `Кураторы — ${SITE_NAME}`, desc: 'Кураторы музыки: слушайте, оценивайте, продвигайте артистов', type: 'website' },
  '/donations': { title: `Донаты — ${SITE_NAME}`, desc: 'Поддержите любимых артистов донатами', type: 'website' },
  '/coins': { title: `Коины — ${SITE_NAME}`, desc: 'Внутренняя валюта платформы: покупайте услуги, продвигайте треки', type: 'website' },
  '/collaboration': { title: `Коллаборации — ${SITE_NAME}`, desc: 'Найдите партнёров для совместных музыкальных проектов', type: 'website' },
  '/dj-studio': { title: `DJ Студия — ${SITE_NAME}`, desc: 'Инструменты для диджеев: миксы, плейлисты, аналитика', type: 'website' },
  '/dj-marketplace': { title: `DJ Маркетплейс — ${SITE_NAME}`, desc: 'Биржа диджеев: найдите DJ для мероприятия', type: 'website' },
  '/producer-studio': { title: `Продюсерская студия — ${SITE_NAME}`, desc: 'Продакшн-инструменты: биты, аранжировки, мастеринг', type: 'website' },
  '/about': { title: `О платформе — ${SITE_NAME}`, desc: 'ПРОМО.МУЗЫКА — платформа для артистов, DJ, продюсеров и музыкальной индустрии', type: 'website' },
  '/help': { title: `Помощь — ${SITE_NAME}`, desc: 'Ответы на частые вопросы и руководства по работе с платформой', type: 'website' },
  '/contacts': { title: `Контакты — ${SITE_NAME}`, desc: 'Свяжитесь с командой ПРОМО.МУЗЫКА', type: 'website' },
  '/for-artists': { title: `Для артистов — ${SITE_NAME}`, desc: 'Все возможности платформы для музыкантов: загрузка треков, аналитика, продвижение', type: 'website' },
  '/radio-stations': { title: `Радиостанции — ${SITE_NAME}`, desc: 'Каталог радиостанций-партнёров', type: 'website' },
};

// ─── Build FAQPage JSON-LD from Q&A pairs ───
function buildFaqLd(faq: { q: string; a: string }[]): string {
  if (!faq || faq.length === 0) return '';
  const items = faq.map(({ q, a }) =>
    `{"@type":"Question","name":"${escJson(q)}","acceptedAnswer":{"@type":"Answer","text":"${escJson(a)}"}}`
  ).join(',');
  return `<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[${items}]}</script>`;
}

// ─── Build Article JSON-LD for pillar pages ───
function buildArticleLd(opts: { title: string; desc: string; canonical: string; image?: string }): string {
  return `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${escJson(opts.title)}","description":"${escJson(opts.desc)}","image":"${escJson(opts.image || LOGO)}","author":{"@type":"Organization","name":"${SITE_NAME}","url":"${DOMAIN}"},"publisher":{"@type":"Organization","name":"${SITE_NAME}","logo":{"@type":"ImageObject","url":"${LOGO}"}},"mainEntityOfPage":{"@type":"WebPage","@id":"${escJson(opts.canonical)}"},"inLanguage":"ru-RU"}</script>`;
}

// ─── Render full HTML page ───
function renderPage(opts: {
  title: string; desc: string; canonical: string; type: string;
  image?: string; jsonLd?: string; body: string;
  keywords?: string;
  /** например 'noindex, follow' — для служебных страниц и 404 */
  robots?: string;
}): string {
  const orgLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"${SITE_NAME}","alternateName":[${SITE_ALT_NAMES.map((n) => `"${escJson(n)}"`).join(',')}],"url":"${DOMAIN}","logo":"${LOGO}","sameAs":["https://vk.com/promofm","https://t.me/promofm","https://www.youtube.com/@promo_muzik"]}</script>`;
  const breadcrumbs = opts.canonical === `${DOMAIN}/` ? '' :
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Главная","item":"${DOMAIN}/"},{"@type":"ListItem","position":2,"name":"${escJson(opts.title.split(' — ')[0].split(' | ')[0])}","item":"${escJson(opts.canonical)}"}]}</script>`;
  const kw = opts.keywords ? `\n<meta name="keywords" content="${esc(opts.keywords)}">` : '';
  const robots = opts.robots ? `\n<meta name="robots" content="${esc(opts.robots)}">` : '';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.desc)}">${kw}${robots}
<link rel="canonical" href="${esc(opts.canonical)}">
<meta property="og:type" content="${opts.type}">
<meta property="og:url" content="${esc(opts.canonical)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.desc)}">
<meta property="og:image" content="${esc(opts.image || LOGO)}">
<meta property="og:locale" content="ru_RU">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(opts.desc)}">
<meta name="twitter:image" content="${esc(opts.image || LOGO)}">
${orgLd}${breadcrumbs}${opts.jsonLd || ''}
</head>
<body>
<header><nav>
<a href="${DOMAIN}/">${SITE_NAME}</a>
<a href="${DOMAIN}/news">Новости</a>
<a href="${DOMAIN}/charts">Чарты</a>
<a href="${DOMAIN}/concerts">Концерты</a>
<a href="${DOMAIN}/new">Новинки</a>
<a href="${DOMAIN}/promo-air">ПРОМО.ЭИР</a>
<a href="${DOMAIN}/for-artists">Для артистов</a>
<a href="${DOMAIN}/for-venues">Для заведений</a>
</nav></header>
<main>${opts.body}</main>
<footer>
<p>&copy; 2026 ${SITE_NAME} (<a href="${DOMAIN}/">Промо Музыка</a>) — платформа продвижения музыки для артистов, DJ, продюсеров и заведений.</p>
<nav aria-label="Артистам"><strong>Артистам:</strong>
<a href="${DOMAIN}/pesnya-na-radio">Песня на радио</a> ·
<a href="${DOMAIN}/tv-rotation">Клип на ТВ</a> ·
<a href="${DOMAIN}/get-in-chart">Песня в чартах</a> ·
<a href="${DOMAIN}/promotion">Продвижение трека</a> ·
<a href="${DOMAIN}/how-to-grow-track">Как раскрутить трек</a> ·
<a href="${DOMAIN}/distribution">Дистрибуция музыки</a> ·
<a href="${DOMAIN}/airplay-monitoring">Мониторинг эфира</a> ·
<a href="${DOMAIN}/promo-lab">Оценка трека</a> ·
<a href="${DOMAIN}/sell-music">Продать бит или песню</a> ·
<a href="${DOMAIN}/pricing">Тарифы</a>
</nav>
<nav aria-label="Заведениям"><strong>Заведениям:</strong>
<a href="${DOMAIN}/for-venues">Радио для заведений</a> ·
<a href="${DOMAIN}/music-for-business">Музыка для бизнеса</a> ·
<a href="${DOMAIN}/muzyka-dlya-zavedeniya">Музыка для заведения</a> ·
<a href="${DOMAIN}/music-for-restaurants">Музыка для ресторанов</a> ·
<a href="${DOMAIN}/music-for-cafe">Музыка для кафе</a> ·
<a href="${DOMAIN}/promo-air/legal-music">Музыка без РАО и ВОИС</a> ·
<a href="${DOMAIN}/radio-advertising">Реклама на радио</a> ·
<a href="${DOMAIN}/audio-branding">Звуковой брендинг</a>
</nav>
<nav aria-label="Платформа">
<a href="${DOMAIN}/promo-air">ПРОМО.ЭИР</a> ·
<a href="${DOMAIN}/promo-guide">ПРОМО.ГИД</a> ·
<a href="${DOMAIN}/charts">Чарты</a> ·
<a href="${DOMAIN}/concerts">Концерты</a> ·
<a href="${DOMAIN}/booking">Букинг артистов</a>
</nav>
</footer>
</body></html>`;
}

// ─── Render pillar page (long-form SEO content) ───
function renderPillar(p: PillarMeta): string {
  const articleLd = buildArticleLd({ title: p.title, desc: p.desc, canonical: p.canonical });
  const faqLd = buildFaqLd(p.faq);
  // Build FAQ HTML block from structured array (so the visible page matches the schema)
  const faqHtml = p.faq.length > 0
    ? `<section class="faq-block"><h2>Частые вопросы</h2><dl class="faq">${p.faq.map(({ q, a }) =>
        `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl></section>`
    : '';
  // Body is already authored HTML; append FAQ if not present in body
  const bodyHtml = p.body.includes('class="faq"') ? p.body : `${p.body}\n${faqHtml}`;
  return renderPage({
    title: p.title,
    desc: p.desc,
    canonical: p.canonical,
    type: 'article',
    keywords: p.keywords,
    jsonLd: `${articleLd}${faqLd}`,
    body: bodyHtml,
  });
}

// ─── Long-form static landing pages (product pages with rich content for bots) ───
const PRODUCT_PAGES: Record<string, { meta: { title: string; desc: string; type: string }; body: string; keywords?: string }> = {
  '/promo-air': {
    meta: PAGE_META['/promo-air']!,
    keywords: 'промо эир, промо радио, песня на радио, ротация на радио, музыка для заведений, фоновое аудио, лицензионная музыка',
    body: `
<article class="product">
<h1>ПРОМО.ЭИР: от подачи песни на радио до фоновой музыки в кафе</h1>
<p class="lead">ПРОМО.ЭИР это операторская система ПРОМО.МУЗЫКА, которая решает две задачи одновременно. Артистам она помогает попасть с песней на радио и удерживать ротацию неделя за неделей. Бизнесу она поставляет лицензионную фоновую музыку для кафе, ресторанов, баров, магазинов, фитнес-клубов и салонов.</p>

<nav class="toc"><strong>Что внутри</strong>
<ol>
<li><a href="#artists">Для артистов: песня на радио</a></li>
<li><a href="#venues">Для заведений: лицензионная музыка</a></li>
<li><a href="#how">Как это работает</a></li>
<li><a href="#faq">Частые вопросы</a></li>
</ol>
</nav>

<section id="artists">
<h2>Для артистов: попасть в ротацию радиостанций</h2>
<p>Внутри ПРОМО.ЭИР — база из {{STATIONS_GEN}} России: от федеральных Европа Плюс, Русское Радио, DFM и Авторадио до региональных FM по областным центрам и нишевых форматов вроде джаза, рока, шансона и танцевальных каналов. Мы доставляем мастер песни и питч-карточку напрямую в плейлист-комитет станции, а не через анонимную почту, которую никто не открывает.</p>
<p>Артист видит в личном кабинете, какие станции взяли трек в light, medium или heavy rotation, и сколько раз песня уже прозвучала в эфире. Цифры подтверждаются сервисом <a href="${DOMAIN}/airplay-monitoring">мониторинга эфира</a>: система слушает живой поток FM-станций и распознаёт трек по аудиоотпечатку.</p>
<p>Подробное руководство по подаче и форматам ротаций мы собрали в отдельной статье: <a href="${DOMAIN}/pesnya-na-radio">как попасть с песней на радио</a>.</p>
</section>

<section id="venues">
<h2>Для заведений: лицензионная музыка для бизнеса</h2>
<p>Если у вас кафе, ресторан, бар, фитнес-зал, магазин одежды, парикмахерская, отель или коворкинг, в вашем зале по закону должна играть только лицензионная музыка. Иначе РАО и ВОИС начислят вам штраф и обяжут заплатить за все месяцы, когда фон шёл нелегально. Стриминги вроде Яндекс Музыки и Spotify эту лицензию не закрывают: их условия запрещают использование в коммерческих помещениях.</p>
<p>ПРОМО.ЭИР собирает плейлист под формат заведения, время суток и аудиторию. Кафе утром получает спокойный нейтральный фон, бар вечером переходит на ритм и громкость, фитнес-клуб гоняет высокий BPM в зале и спокойную инструменталку в зоне отдыха. Музыка обновляется без участия персонала, а договоры с РАО и ВОИС заведению не нужны: каталог лицензирован напрямую у правообладателей.</p>
<p>Подробности по форматам и подключению заведения собраны на странице <a href="${DOMAIN}/muzyka-dlya-zavedeniya">музыка для заведения</a> и в <a href="${DOMAIN}/for-venues">кабинете для бизнеса</a>.</p>
</section>

<section id="how">
<h2>Как это работает</h2>
<ol>
<li>Артист или владелец заведения регистрируется и описывает задачу: трек на радио или фоновая музыка в зале.</li>
<li>Менеджер ПРОМО.ЭИР подбирает решение: список станций под формат трека или плейлист под формат заведения.</li>
<li>Трек уходит в эфир или плейлист запускается в зале. Артист видит ротации, заведение получает фон и закрывающие документы.</li>
<li>Раз в неделю приходит отчёт: какие станции крутят трек или какие категории треков чаще всего звучат в зале и как реагирует аудитория.</li>
</ol>
</section>

<section id="related">
<h2>Связанные сервисы</h2>
<ul>
<li><a href="${DOMAIN}/airplay-monitoring">Мониторинг эфира радиостанций</a></li>
<li><a href="${DOMAIN}/radio-advertising">Реклама на радио: размещение роликов</a></li>
<li><a href="${DOMAIN}/audio-branding">Звуковой брендинг и фирменные джинглы</a></li>
<li><a href="${DOMAIN}/promo-lab">ПРОМО.ЛАБ: профессиональная оценка трека</a></li>
<li><a href="${DOMAIN}/promo-guide">ПРОМО.ГИД: руководства по продвижению</a></li>
<li><a href="${DOMAIN}/charts">Музыкальные чарты ТОП-50</a></li>
</ul>
</section>
</article>`,
  },
  '/airplay-monitoring': {
    meta: PAGE_META['/airplay-monitoring']!,
    keywords: 'мониторинг эфира, мониторинг радио, ротация на радио, отчёт по эфиру, песня на радио, аналитика радиоэфира',
    body: `
<article class="product">
<h1>Мониторинг эфира: когда ваша песня звучит на радио</h1>
<p class="lead">Раньше артист узнавал об эфире своей песни случайно: позвонила тётка из соседнего города и сказала, что слышала трек в маршрутке. Сейчас работает автоматический мониторинг радио: система слушает прямой поток радиостанции и распознаёт каждый трек по аудиоотпечатку. Сейчас к мониторингу подключены федеральные и региональные станции — DFM, Europa Plus, Русское Радио, Наше Радио и другие, список расширяется. Найденные эфиры попадают в отчёт в личном кабинете.</p>

<section>
<h2>Что вы получаете</h2>
<ul>
<li>Точную дату, время и длительность каждого выхода песни в эфир.</li>
<li>Название станции, регион вещания и формат (CHR, AC, Hot AC, Rock и так далее).</li>
<li>Сводку по неделе: суммарное количество эфиров, динамика по категориям ротации (light, medium, heavy).</li>
<li>Сравнение с недельными чартами и оценкой охвата аудитории конкретной станции.</li>
</ul>
</section>

<section>
<h2>Зачем это артисту</h2>
<p>Во-первых, чтобы понимать, работает ли промо. Если песня ушла в подачу через <a href="${DOMAIN}/promo-air">ПРОМО.ЭИР</a>, мониторинг показывает, какие станции реально взяли трек в плейлист, а какие просто отписались формально. Во-вторых, чтобы получать отчисления от РАО и ВОИС: для выплат нужны подтверждённые эфиры, и мониторинг закрывает этот вопрос документами.</p>
<p>В-третьих, мониторинг помогает планировать следующие релизы. Если вы видите, что трек идёт в Hot AC формате на 20 региональных станциях, значит следующий сингл стоит делать в близкой стилистике, а не уходить в эксперименты.</p>
</section>

<section>
<h2>Как это связано с попаданием на радио</h2>
<p>Мониторинг и подача это две стороны одного процесса. Сначала ПРОМО.ЭИР доставляет трек в плейлист-комитет, затем мониторинг подтверждает каждый эфир. Без подачи нет ротации, без мониторинга нет доказательств и аналитики. Подробная инструкция по подаче собрана в материале <a href="${DOMAIN}/pesnya-na-radio">песня на радио: как попасть в ротацию</a>.</p>
</section>

<section>
<h2>Связанные материалы</h2>
<ul>
<li><a href="${DOMAIN}/promo-air">ПРОМО.ЭИР: подача трека на радио</a></li>
<li><a href="${DOMAIN}/charts">Чарты российских радиостанций</a></li>
<li><a href="${DOMAIN}/promo-guide">Гайд по продвижению трека</a></li>
<li><a href="${DOMAIN}/for-artists">Все возможности для артистов</a></li>
</ul>
</section>
</article>`,
  },
  '/for-venues': {
    meta: PAGE_META['/for-venues']!,
    keywords: 'музыка для заведений, фоновая музыка, лицензионная музыка для бизнеса, музыка для кафе, музыка для ресторана, плейлист для заведения',
    body: `
<article class="product">
<h1>Музыка для заведений: лицензионное аудио для общепита, ритейла и услуг</h1>
<p class="lead">Любому заведению, где есть посетители и играет фон, нужна лицензия на музыку. РАО собирает плату за авторские права, ВОИС за смежные права исполнителей и студий. Стриминги, бытовые колонки и плейлисты с YouTube эту лицензию не закрывают. ПРОМО.МУЗЫКА через систему ПРОМО.ЭИР подключает заведение к легальному фоновому аудио и берёт на себя отчётность.</p>

<section>
<h2>Кому подходит</h2>
<ul>
<li>Кафе, кофейни, рестораны и бары.</li>
<li>Магазины одежды, обуви, косметики и продуктов.</li>
<li>Фитнес-клубы, йога-студии и танцевальные залы.</li>
<li>Парикмахерские, барбершопы, салоны красоты и spa.</li>
<li>Отели, апарт-отели, хостелы и коворкинги.</li>
<li>Автомойки, шиномонтажки и сервисные станции с зоной ожидания.</li>
</ul>
</section>

<section>
<h2>Как мы подбираем плейлист</h2>
<p>Менеджер уточняет три вещи: формат заведения, целевую аудиторию и время работы. Дальше система собирает плейлист под утренний поток, дневной обед, вечерний пик и поздний период, если зал работает до ночи. Для барбершопа это будет одна звуковая дорожка, для семейного кафе совершенно другая, для гастробара третья. Музыка обновляется автоматически, персонал не тратит время на ручное переключение.</p>
</section>

<section>
<h2>Что закрывается отчётностью</h2>
<p>ПРОМО.ЭИР работает как оператор музыки: договор с заведением, каталог, лицензированный напрямую у правообладателей, ежемесячные акты. Отдельные договоры с РАО и ВОИС заведению не нужны. Если к вам приходит проверка, у заведения на руках лежит пакет документов на легальное использование фоновой музыки. Полное руководство по лицензиям и форматам мы вынесли в материал <a href="${DOMAIN}/muzyka-dlya-zavedeniya">музыка для заведения</a>.</p>
</section>

<section>
<h2>Дополнительно</h2>
<ul>
<li><a href="${DOMAIN}/audio-branding">Звуковой брендинг и фирменные джинглы</a></li>
<li><a href="${DOMAIN}/music-for-restaurants">Музыка для ресторанов и кафе</a></li>
<li><a href="${DOMAIN}/promo-air">ПРОМО.ЭИР для бизнеса</a></li>
<li><a href="${DOMAIN}/radio-advertising">Реклама на радио</a></li>
</ul>
</section>
</article>`,
  },
  '/music-for-restaurants': {
    meta: PAGE_META['/music-for-restaurants']!,
    keywords: 'музыка для ресторана, музыка для ресторанов, фоновая музыка для ресторана, музыкальное оформление ресторана, музыка в ресторан без рао, лицензионная музыка для ресторана, плейлист для ресторана, русская музыка для ресторана, радио для ресторана',
    body: `
<article class="product">
<h1>Музыка для ресторанов</h1>
<p class="lead">Музыка в ресторане — часть сервиса, как свет и посуда. ПРОМО.ЭИР даёт ресторану готовый эфир под завтрак, обед и ужин, анонсы меню и событий между треками и права на музыку без договоров с РАО и ВОИС. Подключение бесплатное, первые 14 дней — без оплаты.</p>

<section>
<h2>Эфир под время суток</h2>
<p>Утром гостю нужна тишина с мягким фоном, в обед — ровный темп, чтобы зал не засыпал, вечером — атмосфера, ради которой приходят на ужин. Эфир сам меняется по часам, официантам не нужно ничего переключать.</p>
<ul>
<li><strong>Завтрак:</strong> спокойная инструментальная музыка, лаунж, мягкий джаз.</li>
<li><strong>Обед:</strong> умеренный темп, акустика, поп без резких треков.</li>
<li><strong>Ужин:</strong> атмосферные треки, soul, лаунж-электроника.</li>
<li><strong>Вечер и выходные:</strong> живее и ритмичнее, если формат ресторана это позволяет.</li>
</ul>
<p>Формат задаёте вы: в анкете отмечаете жанры, настроение, язык песен и то, что играть нельзя. Русская музыка для ресторана, зарубежная или смешанный эфир — решается там же.</p>
</section>

<section>
<h2>Зал, веранда, бар</h2>
<p>Каждое помещение со своим звуком — отдельная точка: основной зал, летняя веранда, бар. Для каждой точки в кабинете свой код подключения и своё устройство. Два зала и больше подключаются по тарифу «Сеть», все точки под одним аккаунтом.</p>
</section>

<section>
<h2>Анонсы меню, событий и фирменные джинглы</h2>
<p>Между треками эфир может рассказывать гостям о сезонном меню, бизнес-ланче, живой музыке по пятницам или банкетном зале. Это работает лучше таблички у входа: гость слышит предложение, пока сидит за столом.</p>
<p>В радио полного цикла это входит: ведущие, освещение ваших событий, анонсы меню и акций, фирменные джинглы ресторана. При обычной подписке отдельные ролики заказываются в кабинете, от 2 000 ₽ за ролик.</p>
</section>

<section>
<h2>Легально, без договоров с РАО и ВОИС</h2>
<p>Музыка из личной подписки на стриминг или с радио в зале — это публичное исполнение без прав: проверка начинается с претензии, а в суде компенсация доходит до 5 000 000 ₽. В эфире ПРОМО.ЭИР звучит собственный каталог платформы без сторонних правообладателей и треки артистов по прямым соглашениям — договоры с РАО и ВОИС ресторану не нужны. Подробно — на странице <a href="${DOMAIN}/promo-air/legal-music">лицензионная музыка без РАО и ВОИС</a>.</p>
</section>

<section>
<h2>Сколько стоит музыка для ресторана</h2>
<p>Одна точка — от 4 990 ₽ в месяц. Если залов или адресов два и больше, подойдёт тариф «Сеть»: 14 990 ₽ в месяц, все точки под одним аккаунтом. Радио полного цикла с ведущими, освещением ваших событий, анонсами меню и фирменными джинглами — 20 000 ₽ в месяц. При оплате за год скидка около 17 %. Подключение бесплатное, первые 14 дней — без оплаты.</p>
</section>

<section>
<h2>Как подключить</h2>
<ol>
<li>Зарегистрируйтесь как заведение и заполните анкету: формат эфира, залы и веранда, какую музыку играть, нужны ли джинглы и ведущие.</li>
<li>Редактор соберёт эфир ресторана. Для каждой точки в кабинете появится код подключения.</li>
<li>Включите эфир на Android-устройстве в приложении PROMO.AIR или в браузере и подключите к акустике зала.</li>
</ol>
</section>

<section>
<h2>Связанные страницы</h2>
<ul>
<li><a href="${DOMAIN}/music-for-business">Музыка для бизнеса</a></li>
<li><a href="${DOMAIN}/music-for-cafe">Музыка для кафе</a></li>
<li><a href="${DOMAIN}/promo-air/legal-music">Лицензионная музыка без РАО и ВОИС</a></li>
<li><a href="${DOMAIN}/for-venues">Радио для заведений</a></li>
</ul>
</section>

</article>`,
  },
};

// ─── Ответы для адресов без своей страницы ───
// До 24.09.2026 любой неизвестный путь получал копию главной с кодом 200
// (мягкий 404): Яндекс видел тысячи дублей главной, а 29 адресов из sitemap
// были такими заглушками. Теперь: нет у человека — 404; кабинет — noindex.
async function renderNotFound(path: string): Promise<string> {
  return renderPageWithTokens({
    title: `Страница не найдена — ${SITE_NAME}`,
    desc: 'Такой страницы на ПРОМО.МУЗЫКЕ нет. Перейдите на главную или в нужный раздел.',
    canonical: `${DOMAIN}${path}`, type: 'website', robots: 'noindex, follow',
    body: `<h1>Страница не найдена</h1><p>Такой страницы нет. Начните с <a href="${DOMAIN}/">главной</a>, <a href="${DOMAIN}/news">новостей</a> или <a href="${DOMAIN}/charts">чартов</a>.</p>`,
  });
}

async function renderServicePage(path: string, title: string, robots: string): Promise<string> {
  return renderPageWithTokens({
    title, desc: `${SITE_NAME} — платформа продвижения музыки.`,
    canonical: `${DOMAIN}${path}`, type: 'website', robots,
    body: `<h1>${esc(title.split(' — ')[0])}</h1><p><a href="${DOMAIN}/">На главную ${SITE_NAME}</a></p>`,
  });
}

// ─── GET /prerender/* — SSR for bots ───
seoRoutes.get('/prerender/*', async (c) => {
  const rawParam = c.req.path.replace(/\/server\/prerender/, '') || '/';
  const path = rawParam.startsWith('/') ? rawParam : '/' + rawParam;

  try {
    // ─── Individual news article ───
    if (path.startsWith('/news/') && path.length > 6) {
      const newsId = decodeURIComponent(path.slice(6));
      // ОСНОВНОЙ источник статей — news_public (лента, 2000+ URL в
      // sitemap). До 2026-07-08 ветка читала только legacy-таблицу news →
      // боты получали пустую SPA-оболочку по КАЖДОМУ sitemap-URL статьи
      // (подтверждено curl'ом с YandexBot-UA). news — фолбэк для старых id.
      // ⚠️ news_public — НАТИВНЫЕ колонки с миграции 077 (без data jsonb!)
      // — поэтому строго через typed-хелпер db.tsx, не сырой SELECT.
      let a: any = null;
      const { getNewsPublic } = await import('./db.tsx');
      const pubRow = await getNewsPublic(newsId).catch(() => null);
      if (pubRow && pubRow.status === 'published') {
        a = {
          title: pubRow.title,
          summary: pubRow.excerpt,
          content: pubRow.content,
          author_name: pubRow.authorName,
          published_at: pubRow.publishedAt || pubRow.createdAt,
          created_at: pubRow.createdAt,
          image_url: pubRow.imageUrl,
        };
      }
      if (!a) {
        const { rows } = await pool.query(
          `SELECT * FROM news WHERE id = $1 AND status = 'published'`, [newsId]
        );
        a = rows[0] || null;
      }
      if (a) {
        const title = a.title || 'Новость';
        const desc = stripHtml(a.summary || a.content || '').slice(0, 300);
        const author = a.author_name || 'Редакция';
        const pubDate = a.published_at || a.created_at || new Date().toISOString();
        const img = a.image_url || LOGO;
        const content = sanitizeHtml((a.content || '')
          .replace(/^\s*```html\s*\n?/i, '').replace(/\n?```\s*$/i, '')
          .replace(/^\s*<code>\s*/i, '').replace(/\s*<\/code>\s*$/i, ''));

        const jsonLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"${escJson(title)}","description":"${escJson(desc)}","image":"${escJson(img.startsWith('/') ? DOMAIN + img : img)}","datePublished":"${pubDate}","author":{"@type":"Person","name":"${escJson(author)}"},"publisher":{"@type":"Organization","name":"${SITE_NAME}","logo":{"@type":"ImageObject","url":"${LOGO}"}},"mainEntityOfPage":{"@type":"WebPage","@id":"${DOMAIN}/news/${escJson(newsId)}"}}</script>`;

        c.header('Content-Type', 'text/html; charset=utf-8');
        return c.body(await renderPageWithTokens({
          title: `${title} — ${SITE_NAME}`, desc, canonical: `${DOMAIN}/news/${newsId}`,
          type: 'article', image: img.startsWith('/') ? `${DOMAIN}${img}` : img, jsonLd,
          body: `<article><h1>${esc(title)}</h1><p><time datetime="${pubDate}">${fmtDate(pubDate)}</time> · ${esc(author)}</p>${content}</article>`,
        }));
      }
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderNotFound(path), 404);
    }

    // ─── News listing ───
    if (path === '/news') {
      // Тот же фикс, что у статьи: лента живёт в news_public (нативные
      // колонки, typed-хелпер), не в legacy news.
      const { listNewsPublic } = await import('./db.tsx');
      const items = await listNewsPublic({ status: 'published', limit: 30 }).catch(() => []);
      let body = `<h1>Новости музыки</h1><p>${esc(PAGE_META['/news'].desc)}</p>`;
      if (items.length > 0) {
        body += '<ul>';
        for (const n of items) {
          const pub = n.publishedAt || n.createdAt || '';
          body += `<li><a href="${DOMAIN}/news/${esc(n.id)}">${esc(n.title || 'Новость')}</a> — <time datetime="${pub}">${fmtDate(pub)}</time>${n.authorName ? ` · ${esc(n.authorName)}` : ''}</li>`;
        }
        body += '</ul>';
      }
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPageWithTokens({ title: PAGE_META['/news'].title, desc: PAGE_META['/news'].desc, canonical: `${DOMAIN}/news`, type: 'website', body }));
    }

    // ─── Charts ───
    if (path === '/charts') {
      // Aggregate chart data from the chart_sources SQL table (via getChartSource)
      const sourceIds = ['russkoe', 'nashe', 'dfm', 'europa', 'hitfm', 'retro'];
      const allTracks: { title: string; artist: string; source: string; pos: number }[] = [];
      // Native getChartSource — chart_sources data column was DROPPED in
      // migration 076 (это endpoint молча return'ил empty список с тех пор).
      for (const sid of sourceIds) {
        const src = await getChartSource(sid);
        if (src?.tracks?.length) {
          for (const t of src.tracks.slice(0, 10)) {
            allTracks.push({
              title: t.title || '',
              artist: t.artist || '',
              source: src.sourceName || sid,
              pos: t.position || 0,
            });
          }
        }
      }
      let body = `<h1>Музыкальные чарты TOP 50</h1><p>${esc(PAGE_META['/charts'].desc)}</p>`;
      if (allTracks.length > 0) {
        // Group by source
        const bySource: Record<string, typeof allTracks> = {};
        for (const t of allTracks) {
          if (!bySource[t.source]) bySource[t.source] = [];
          bySource[t.source].push(t);
        }
        for (const [source, tracks] of Object.entries(bySource)) {
          body += `<section><h2>${esc(source)}</h2><ol>`;
          for (const t of tracks) {
            body += `<li>${esc(t.artist)} — ${esc(t.title)}</li>`;
          }
          body += '</ol></section>';
        }
      }
      // ItemList JSON-LD — ранжированный список треков как machine-readable
      // chart. tophit.ru на чартах НЕ отдаёт structured data вообще, поэтому
      // это прямой обгон в rich-результатах Яндекса/Google на их территории.
      const chartItems = allTracks.slice(0, 50);
      const chartLd = chartItems.length > 0
        ? `<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","name":"${escJson(PAGE_META['/charts'].title)}","numberOfItems":${chartItems.length},"itemListElement":[${chartItems.map((t, i) => `{"@type":"ListItem","position":${i + 1},"item":{"@type":"MusicRecording","name":"${escJson(t.title)}","byArtist":{"@type":"MusicGroup","name":"${escJson(t.artist)}"}}}`).join(',')}]}</script>`
        : '';
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPageWithTokens({ title: PAGE_META['/charts'].title, desc: PAGE_META['/charts'].desc, canonical: `${DOMAIN}/charts`, type: 'website', jsonLd: chartLd, body }));
    }

    // ─── Concerts ───
    if (path === '/concerts') {
      const { rows } = await pool.query(
        `SELECT id, title, venue_name, city, event_date FROM concerts WHERE is_hidden = false AND is_cancelled = false ORDER BY event_date DESC LIMIT 30`
      );
      let body = `<h1>Концерты и фестивали</h1><p>${esc(PAGE_META['/concerts'].desc)}</p>`;
      if (rows.length > 0) {
        body += '<ul>';
        for (const e of rows) {
          body += `<li><strong>${esc(e.title)}</strong>${e.venue ? ` — ${esc(e.venue)}` : ''}${e.city ? `, ${esc(e.city)}` : ''} · <time datetime="${e.event_date || ''}">${fmtDate(e.event_date)}</time></li>`;
        }
        body += '</ul>';
      }
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPageWithTokens({ title: PAGE_META['/concerts'].title, desc: PAGE_META['/concerts'].desc, canonical: `${DOMAIN}/concerts`, type: 'website', body }));
    }

    // ─── Tracks listing ───
    if (path === '/tracks') {
      const { rows } = await pool.query(
        `SELECT title, artist_name, genre FROM tracks WHERE moderation_status = 'approved' AND is_hidden = false ORDER BY created_at DESC LIMIT 30`
      );
      let body = `<h1>Треки</h1><p>${esc(PAGE_META['/tracks'].desc)}</p>`;
      if (rows.length > 0) {
        body += '<ul>';
        for (const t of rows) {
          body += `<li><strong>${esc(t.title)}</strong> — ${esc(t.artist_name || 'Артист')}${t.genre ? ` (${esc(t.genre)})` : ''}</li>`;
        }
        body += '</ul>';
      }
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPageWithTokens({ title: PAGE_META['/tracks'].title, desc: PAGE_META['/tracks'].desc, canonical: `${DOMAIN}/tracks`, type: 'website', body }));
    }

    // ─── Individual track ───
    // Текст = страница трека у человека (фронт TrackPublicPage.tsx), данные —
    // getPublicTrack (public-content.tsx). Не публичный или нет — 404.
    if (path.startsWith('/tracks/') && path.length > 8) {
      const t = await getPublicTrack(decodeURIComponent(path.slice(8))).catch(() => null);
      c.header('Content-Type', 'text/html; charset=utf-8');
      if (!t) return c.body(await renderNotFound(path), 404);
      const dur = fmtDuration(t.durationSec);
      const img = t.cover ? (t.cover.startsWith('/') ? `${DOMAIN}${t.cover}` : t.cover) : LOGO;
      const facts = [t.genre, dur, t.releaseDate ? `релиз ${fmtDate(t.releaseDate)}` : ''].filter(Boolean).join(' · ');
      const desc = `Слушать «${t.title}» — ${t.artist} на ПРОМО.МУЗЫКЕ${t.genre ? `. Жанр: ${t.genre}` : ''}${dur ? `, ${dur}` : ''}.${t.links.length ? ' Ссылки на стриминги.' : ''}${t.airplayStations.length ? ' Эфиры на радио, подтверждённые мониторингом.' : ''}`.slice(0, 300);
      const iso = t.durationSec ? `PT${Math.floor(t.durationSec / 60)}M${Math.floor(t.durationSec % 60)}S` : '';
      const jsonLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicRecording","name":"${escJson(t.title)}","byArtist":{"@type":"MusicGroup","name":"${escJson(t.artist)}"${t.artistProfile ? `,"url":"${DOMAIN}/profile/${escJson(t.artistProfile)}"` : ''}}${t.genre ? `,"genre":"${escJson(t.genre)}"` : ''}${iso ? `,"duration":"${iso}"` : ''}${t.releaseDate ? `,"datePublished":"${escJson(t.releaseDate)}"` : ''},"url":"${DOMAIN}/tracks/${escJson(t.id)}","image":"${escJson(img)}"}</script>`;
      const body = `<article>
<h1>${esc(t.artist)} — ${esc(t.title)}</h1>
${facts ? `<p>${esc(facts)}</p>` : ''}
${t.isAi ? '<p>Трек создан с использованием ИИ.</p>' : ''}${t.isArchive ? '<p>Архив promo.fm.</p>' : ''}
${t.composer || t.lyricist ? `<p>${t.composer ? `Музыка: ${esc(t.composer)}. ` : ''}${t.lyricist ? `Слова: ${esc(t.lyricist)}.` : ''}</p>` : ''}
${t.description ? `<p>${esc(t.description.slice(0, 2000))}</p>` : ''}
${t.links.length ? `<section><h2>Слушать на площадках</h2><ul>${t.links.map((l) => `<li><a href="${esc(l.url)}" rel="nofollow noopener">${esc(l.platform)}</a></li>`).join('')}</ul></section>` : ''}
${t.airplayStations.length ? `<section><h2>Звучит в эфире</h2><p>Эфиры подтверждены мониторингом ПРОМО.CHECK: ${esc(t.airplayStations.join(', '))}.</p></section>` : ''}
${t.artistProfile ? `<p><a href="${DOMAIN}/profile/${esc(t.artistProfile)}">Все треки: ${esc(t.artist)}</a></p>` : ''}
<section><h2>Хотите так же со своей песней?</h2><p><a href="${DOMAIN}/pesnya-na-radio">Песня на радио</a> · <a href="${DOMAIN}/promotion">Продвижение трека</a> · <a href="${DOMAIN}/get-in-chart">Песня в чартах</a></p></section>
</article>`;
      return c.body(await renderPageWithTokens({
        title: `${t.artist} — ${t.title}: слушать онлайн — ${SITE_NAME}`, desc,
        canonical: `${DOMAIN}/tracks/${t.id}`, type: 'music.song', image: img, jsonLd, body,
      }));
    }

    // ─── Artist profile ───
    // Зеркало ArtistPublicProfile.tsx: тот же заголовок, canonical (/profile/slug)
    // и список треков — теперь со ссылками на страницы треков. После правки
    // мягких 404 профиль без своей ветки получал бы noindex.
    if (path.startsWith('/profile/') && path.length > 9) {
      const a = await getPublicArtist(decodeURIComponent(path.slice(9))).catch(() => null);
      c.header('Content-Type', 'text/html; charset=utf-8');
      if (!a) return c.body(await renderNotFound(path), 404);
      const canonical = `${DOMAIN}/profile/${a.key}`;
      const desc = (a.bio || `${a.name} на ПРОМО.МУЗЫКЕ: треки, ротации на радио, контакты для связи.`).slice(0, 300);
      const img = a.avatar ? (a.avatar.startsWith('/') ? `${DOMAIN}${a.avatar}` : a.avatar) : LOGO;
      const ld = {
        '@context': 'https://schema.org', '@type': 'MusicGroup', name: a.name, url: canonical,
        ...(a.bio ? { description: a.bio } : {}), ...(a.avatar ? { image: img } : {}),
        ...(a.genre ? { genre: a.genre } : {}), ...(a.city ? { location: { '@type': 'Place', name: a.city } } : {}),
        ...(a.tracks.length ? { track: a.tracks.slice(0, 25).map((t) => ({ '@type': 'MusicRecording', name: t.title, url: `${DOMAIN}/tracks/${t.id}` })) } : {}),
      };
      const jsonLd = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
      const body = `<article>
<h1>${esc(a.name)}</h1>
${[a.city, a.genre].filter(Boolean).length ? `<p>${esc([a.city, a.genre].filter(Boolean).join(' · '))}</p>` : ''}
${a.bio ? `<p>${esc(a.bio.slice(0, 3000))}</p>` : ''}
${a.tracks.length ? `<section><h2>Треки</h2><ol>${a.tracks.map((t) => `<li><a href="${DOMAIN}/tracks/${esc(t.id)}">${esc(t.title)}</a>${t.genre ? ` — ${esc(t.genre)}` : ''}${t.durationSec ? `, ${fmtDuration(t.durationSec)}` : ''}</li>`).join('')}</ol></section>` : '<p>Релизы пока не добавлены.</p>'}
${a.videos.length ? `<section><h2>Клипы</h2><ul>${a.videos.map((v) => `<li><a href="${DOMAIN}/videos/${esc(v.id)}">${esc(v.title)}</a></li>`).join('')}</ul></section>` : ''}
</article>`;
      // Пустой профиль (нет ни треков, ни био) — не мусорим в индексе, ссылки робот пройдёт.
      const thin = a.tracks.length === 0 && !a.bio;
      if (thin) c.header('X-Robots-Tag', 'noindex, follow');
      return c.body(await renderPageWithTokens({
        title: `${a.name} — треки и ротации · ${SITE_NAME}`, desc, canonical, type: 'profile', image: img, jsonLd, body,
        ...(thin ? { robots: 'noindex, follow' } : {}),
      }));
    }

    // ─── Individual video ───
    // Текст = VideoPublicPage.tsx на фронте; данные — getPublicVideo.
    if (path.startsWith('/videos/') && path.length > 8) {
      const v = await getPublicVideo(decodeURIComponent(path.slice(8))).catch(() => null);
      c.header('Content-Type', 'text/html; charset=utf-8');
      if (!v) return c.body(await renderNotFound(path), 404);
      const img = v.thumbnail || LOGO;
      const desc = (v.description || `Смотреть клип «${v.title}» на ПРОМО.МУЗЫКЕ.`).slice(0, 300);
      const jsonLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"${escJson(v.title)}","description":"${escJson(desc)}","thumbnailUrl":"${escJson(img)}"${v.uploadDate ? `,"uploadDate":"${escJson(v.uploadDate)}"` : ''}${v.youtubeId ? `,"embedUrl":"https://www.youtube.com/embed/${escJson(v.youtubeId)}"` : ''},"contentUrl":"${escJson(v.videoUrl)}","url":"${DOMAIN}/videos/${escJson(v.id)}"}</script>`;
      const body = `<article>
<h1>${esc(v.title)}</h1>
<p><img src="${esc(img)}" alt="${esc(v.title)}"></p>
<p><a href="${esc(v.videoUrl)}" rel="nofollow noopener">Смотреть клип на YouTube</a></p>
${v.description ? `<p>${esc(v.description.slice(0, 2000))}</p>` : ''}
${v.artistProfile && v.artist ? `<p><a href="${DOMAIN}/profile/${esc(v.artistProfile)}">Артист: ${esc(v.artist)}</a></p>` : ''}
${v.trackId ? `<p><a href="${DOMAIN}/tracks/${esc(v.trackId)}">Слушать трек</a></p>` : ''}
<section><h2>Свой клип на ТВ?</h2><p><a href="${DOMAIN}/tv-rotation">Клип и песня на ТВ</a> · <a href="${DOMAIN}/promotion">Продвижение трека</a></p></section>
</article>`;
      return c.body(await renderPageWithTokens({
        title: `${v.title}: смотреть клип — ${SITE_NAME}`, desc,
        canonical: `${DOMAIN}/videos/${v.id}`, type: 'website', image: img, jsonLd, body,
      }));
    }

    // ─── Individual concert ───
    // 147 адресов /concerts/:id стояли в sitemap, а робот получал копию главной.
    // Фильтр = афиша у человека (PUBLIC_CONCERT_SQL): прошедший концерт у него
    // «не найден», значит и роботу 404.
    if (path.startsWith('/concerts/') && path.length > 10) {
      const concertId = decodeURIComponent(path.slice(10));
      const { rows } = await pool.query(
        `SELECT id, title, artist_name, description, city, venue_name, venue_address,
                event_date, event_time, event_type, banner_image_url, ticket_link,
                ticket_price_min, ticket_price_max
           FROM concerts c
          WHERE c.id::text = $1 AND ${PUBLIC_CONCERT_SQL}`, [concertId]
      ).catch(() => ({ rows: [] as any[] }));
      const k = rows[0];
      if (k) {
        const date = k.event_date instanceof Date ? k.event_date.toISOString().slice(0, 10) : String(k.event_date || '').slice(0, 10);
        const time = String(k.event_time || '').slice(0, 5);
        const artist = k.artist_name || '';
        const title = k.title || 'Концерт';
        const where = [k.city, k.venue_name].filter(Boolean).join(', ');
        const price = k.ticket_price_min ? ` Билеты от ${Number(k.ticket_price_min).toLocaleString('ru-RU')} ₽.` : '';
        const desc = `${artist ? artist + ' — ' : ''}${title}: ${fmtDate(date)}${time ? ' в ' + time : ''}, ${where}.${price}`.slice(0, 300);
        const img = k.banner_image_url ? (k.banner_image_url.startsWith('/') ? `${DOMAIN}${k.banner_image_url}` : k.banner_image_url) : LOGO;
        const jsonLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicEvent","name":"${escJson(title)}","startDate":"${escJson(date)}${time ? 'T' + escJson(time) : ''}","eventStatus":"https://schema.org/EventScheduled","location":{"@type":"Place","name":"${escJson(k.venue_name || '')}","address":"${escJson([k.city, k.venue_address].filter(Boolean).join(', '))}"}${artist ? `,"performer":{"@type":"MusicGroup","name":"${escJson(artist)}"}` : ''},"image":"${escJson(img)}","url":"${DOMAIN}/concerts/${escJson(String(k.id))}"}</script>`;
        c.header('Content-Type', 'text/html; charset=utf-8');
        return c.body(await renderPageWithTokens({
          title: `${artist ? artist + ' — ' : ''}${title}, ${k.city || ''} — ${SITE_NAME}`,
          desc, canonical: `${DOMAIN}/concerts/${k.id}`, type: 'website', image: img, jsonLd,
          body: `<article><h1>${esc(artist ? `${artist}: ${title}` : title)}</h1>
<p><time datetime="${esc(date)}">${fmtDate(date)}</time>${time ? ` в ${esc(time)}` : ''} · ${esc(where)}${k.venue_address ? `, ${esc(k.venue_address)}` : ''}</p>
${k.description ? `<p>${esc(String(k.description).slice(0, 2000))}</p>` : ''}
${k.ticket_link ? `<p><a href="${esc(k.ticket_link)}" rel="nofollow noopener">Купить билеты</a>${price}</p>` : ''}
<p>Другие события — в <a href="${DOMAIN}/concerts">афише концертов</a>.</p></article>`,
        }));
      }
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderNotFound(path), 404);
    }

    // ─── Homepage with featured content ───
    if (path === '/' || path === '') {
      const [statsRes, weeklyRes, newsRes] = await Promise.all([
        // Публичный трек — тот же фильтр, что в a5ee088: живые треки имеют статус 'published',
        // поэтому прежний фильтр по одному 'approved' оставлял подборку пустой.
        pool.query(`SELECT COUNT(*)::int AS tracks FROM tracks
            WHERE moderation_status IN ('approved','upcoming','published') AND is_hidden = false`).catch(() => ({ rows: [] as any[] })),
        // Витрина — редакционная подборка «Новинок недели», а не сортировка по plays_count:
        // ненулевой счётчик остался только у демо-засева (3201 прослушивание при нуле строк
        // в track_plays), и бот получал список несуществующих артистов вида DeepFlow/SynthMind.
        pool.query(`WITH latest AS (
            SELECT title, track_ids FROM weekly_releases
            WHERE is_published = true ORDER BY release_date DESC LIMIT 1
          )
          SELECT l.title AS issue_title, t.id, t.title, t.artist_name
          FROM latest l
          CROSS JOIN LATERAL unnest(l.track_ids) WITH ORDINALITY AS u(track_id, ord)
          JOIN tracks t ON t.id = u.track_id
          WHERE t.moderation_status IN ('approved','upcoming','published') AND t.is_hidden = false
          ORDER BY u.ord LIMIT 10`).catch(() => ({ rows: [] as any[] })),
        // Лента живёт в news_public — в legacy news осталось 9 строк с NULL published_at,
        // и бот показывал их как «последние новости». published_at <= now() отсекает
        // будущие даты агрегатора.
        pool.query(`(SELECT id, title, published_at FROM news_public
            WHERE status = 'published' AND published_at <= now() AND source = 'admin'
            ORDER BY published_at DESC LIMIT 3)
          UNION ALL
          (SELECT id, title, published_at FROM news_public
            WHERE status = 'published' AND published_at <= now() AND source <> 'admin'
            ORDER BY published_at DESC LIMIT 3)`).catch(() => ({ rows: [] as any[] })),
      ]);

      const tracksTotal = Number(statsRes.rows[0]?.tracks) || 0;
      const issueTitle = weeklyRes.rows[0]?.issue_title || 'Новинки недели';

      let body = `<h1>${SITE_NAME} — платформа продвижения музыки</h1>
<p class="lead">${SITE_NAME} (Promo Music) — российская платформа продвижения музыки. Артист загружает трек, питчит его на {{STATIONS_ACC}} и в плейлисты стримингов, видит реальные эфиры в отчётах и попадает в чарты.${tracksTotal > 0 ? ` Сейчас в каталоге ${tracksTotal} треков.` : ''}</p>
<section><h2>Что такое Промо Музыка</h2>
<p>Промо Музыка (promo-music.ru) — это единое окно продвижения: питчинг песни на радио через ПРОМО.ЭИР, мониторинг эфира по аудиоотпечатку, экспертная оценка трека в ПРОМО.ЛАБ, маркетплейс услуг и битов, афиша концертов и букинг артистов. Платформа рассчитана на артистов, лейблы, DJ, продюсеров и звукорежиссёров, а также на заведения, которым нужна лицензированная фоновая музыка.</p></section>`;

      if (weeklyRes.rows.length > 0) {
        body += `<section><h2>${esc(issueTitle)}</h2><p>Свежая подборка треков, опубликованных на платформе.</p><ol>`;
        for (const t of weeklyRes.rows) {
          body += `<li><a href="${DOMAIN}/tracks/${esc(t.id)}">${esc(t.title)}</a> — ${esc(t.artist_name || 'Артист')}</li>`;
        }
        body += '</ol></section>';
      }

      if (newsRes.rows.length > 0) {
        body += '<section><h2>Новости платформы и индустрии</h2><ul>';
        for (const n of newsRes.rows) {
          const pub = n.published_at || '';
          body += `<li><a href="${DOMAIN}/news/${esc(n.id)}">${esc(n.title)}</a>${pub ? ` — <time datetime="${esc(String(pub))}">${fmtDate(String(pub))}</time>` : ''}</li>`;
        }
        body += '</ul></section>';
      }

      body += `<section><h2>Возможности платформы</h2><ul>
<li><a href="${DOMAIN}/pesnya-na-radio">Питчинг песни на {{STATIONS_ACC}}</a></li>
<li><a href="${DOMAIN}/promotion">Продвижение трека: плейлисты, радио, посевы</a></li>
<li><a href="${DOMAIN}/tv-rotation">Клип и песня на ТВ</a></li>
<li><a href="${DOMAIN}/get-in-chart">Как попасть с песней в чарты</a></li>
<li><a href="${DOMAIN}/airplay-monitoring">Мониторинг эфира и отчёт о ротациях</a></li>
<li><a href="${DOMAIN}/charts">Музыкальные чарты TOP 50</a></li>
<li><a href="${DOMAIN}/promo-lab">Профессиональная оценка треков</a></li>
<li><a href="${DOMAIN}/for-venues">Радио для заведений: ПРОМО.ЭИР</a></li>
<li><a href="${DOMAIN}/music-for-business">Музыка для бизнеса без РАО и ВОИС</a></li>
<li><a href="${DOMAIN}/distribution">Дистрибуция музыки на стриминги</a></li>
<li><a href="${DOMAIN}/pricing">Тарифы и цены</a></li>
<li><a href="${DOMAIN}/marketplace">Маркетплейс битов, минусов и песен</a></li>
<li><a href="${DOMAIN}/sell-music">Продать бит, минус или песню</a></li>
<li><a href="${DOMAIN}/concerts">Афиша концертов</a></li>
<li><a href="${DOMAIN}/booking">Букинг артистов на мероприятия</a></li>
</ul></section>`;

      // FAQPage на главной — копия Q&A из фронт-реестра seo-pages.ts (синхрон).
      // FAQ-schema нет ни у tophit, ни у конкурентов обоих кластеров → rich-сниппет.
      const homeFaq = [
        { q: 'ПРОМО.МУЗЫКА, Промо Музыка и Promo Music — это одно и то же?', a: 'Да. Это одно название в разных написаниях: платформа работает на домене promo-music.ru и в текстах встречается как ПРОМО.МУЗЫКА, Промо Музыка и Promo Music.' },
        { q: 'Что такое ПРОМО.МУЗЫКА?', a: 'Российская платформа продвижения музыки для артистов, лейблов, DJ, продюсеров и звукорежиссёров. Объединяет питчинг на {{STATIONS_ACC}}, попадание в плейлисты стримингов, чарты, дистрибуцию и маркетплейс битов и услуг.' },
        { q: 'Как попасть на радио со своей песней?', a: 'Зарегистрируйтесь как артист, загрузите трек, отметьте радиостанции для питчинга. Заявка приходит в кабинет радио, редактор принимает решение о ротации напрямую.' },
        { q: 'Сколько стоит продвижение трека?', a: 'Публикация трека — {{PUBLICATION_PRICE}} с пожизненным доступом к питчингу, аналитике и попаданию в «Новинки недели». Подробнее на странице тарифов.' },
        { q: 'Чем ПРОМО.МУЗЫКА отличается от обычного дистрибьютора?', a: 'Дистрибьютор только загружает треки в стриминги. ПРОМО.МУЗЫКА дополнительно даёт прямой канал на радиостанции (питчинг с реальным редактором), экспертную оценку перед релизом (ПРОМО.ЛАБ) и маркетплейс услуг для подготовки трека.' },
      ];
      body += `<section class="faq-block"><h2>Частые вопросы</h2><dl class="faq">${homeFaq.map(({ q, a }) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl></section>`;

      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPageWithTokens({ title: PAGE_META['/'].title, desc: PAGE_META['/'].desc, canonical: `${DOMAIN}/`, type: 'website', keywords: HOME_KEYWORDS, jsonLd: buildFaqLd(homeFaq), body }));
    }

    // ─── Pillar pages (rich SEO landing pages with FAQ schema) ───
    if (PILLAR_PAGES[path]) {
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPillarWithTokens(PILLAR_PAGES[path]));
    }

    // ─── Product pages with rich body content ───
    if (PRODUCT_PAGES[path]) {
      const p = PRODUCT_PAGES[path];
      // FAQ — из реестра фронта (seo-pages.ts), то есть то же, что видит человек;
      // если в теле страницы свой FAQ-блок уже есть, не дублируем.
      const regFaqs = p.body.includes('class="faq') ? [] : (seoRegistryEntry(path)?.faqs ?? []);
      const faqHtml = regFaqs.length
        ? `<section class="faq-block"><h2>Частые вопросы</h2><dl class="faq">${regFaqs.map(({ q, a }) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl></section>`
        : '';
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPageWithTokens({
        title: p.meta.title, desc: p.meta.desc, canonical: `${DOMAIN}${path}`, type: p.meta.type,
        keywords: p.keywords,
        jsonLd: regFaqs.length ? buildFaqLd(regFaqs) : '',
        body: faqHtml ? p.body.replace(/<\/article>\s*$/, `${faqHtml}\n</article>`) : p.body,
      }));
    }

    // ─── SEO alias pages (commercial, genres, blog) ───
    if (ALL_ALIASES[path]) {
      const a = ALL_ALIASES[path];
      const articleLd = buildArticleLd({ title: a.title, desc: a.desc, canonical: `${DOMAIN}${path}` });
      const faqLd = a.faq && a.faq.length > 0 ? buildFaqLd(a.faq) : '';
      const faqHtml = a.faq && a.faq.length > 0
        ? `<section class="faq-block"><h2>Частые вопросы</h2><dl class="faq">${a.faq.map(({ q, a: ans }) =>
            `<dt>${esc(q)}</dt><dd>${esc(ans)}</dd>`).join('')}</dl></section>`
        : '';
      let bodyHtml = a.body.includes('class="faq"') ? a.body : `${a.body}\n${faqHtml}`;
      // Витрина маркетплейса: метка в тексте → живой список товаров в продаже.
      if (bodyHtml.includes('<!--market-items-->')) bodyHtml = bodyHtml.replace('<!--market-items-->', await renderMarketItemsHtml());
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPageWithTokens({
        title: a.title,
        desc: a.desc,
        canonical: `${DOMAIN}${path}`,
        type: a.type || 'website',
        keywords: a.keywords,
        jsonLd: `${articleLd}${faqLd}`,
        body: bodyHtml,
      }));
    }

    // ─── Generic static pages ───
    c.header('Content-Type', 'text/html; charset=utf-8');
    // Сначала — есть ли адрес у человека. В PAGE_META остались записи на
    // страницы, которых в SPA нет (/coins, /donations, /help, /dj-studio…),
    // и кабинет /radio — им не 200, а 404 и noindex соответственно.
    const kind = classifySpaPath(path);
    if (kind === 'unknown') {
      return c.body(await renderNotFound(path), 404);
    }
    if (kind === 'private') {
      c.header('X-Robots-Tag', 'noindex, nofollow');
      return c.body(await renderServicePage(path, `Личный кабинет — ${SITE_NAME}`, 'noindex, nofollow'));
    }

    const meta = PAGE_META[path];
    if (meta) {
      return c.body(await renderPageWithTokens({
        title: meta.title, desc: meta.desc, canonical: `${DOMAIN}${path}`, type: meta.type,
        body: `<h1>${esc(meta.title)}</h1><p>${esc(meta.desc)}</p>`,
      }));
    }
    // Публичная страница SPA без своей ветки: заголовок, описание и FAQ —
    // из реестра фронта seo-pages.ts, то есть то же, что видит человек.
    const reg = seoRegistryEntry(path);
    if (reg) {
      const faqHtml = reg.faqs.length
        ? `<section class="faq-block"><h2>Частые вопросы</h2><dl class="faq">${reg.faqs.map(({ q, a }) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl></section>`
        : '';
      return c.body(await renderPageWithTokens({
        title: reg.title, desc: reg.description, canonical: `${DOMAIN}${path}`, type: 'website',
        jsonLd: reg.faqs.length ? buildFaqLd(reg.faqs) : '',
        body: `<article><h1>${esc(reg.title.split(/ — | · | \| /)[0])}</h1><p class="lead">${esc(reg.description)}</p>${faqHtml}</article>`,
      }));
    }
    // Страница у человека есть, но текста для робота нет: не выдаём её за
    // главную — noindex, follow (ссылки со страницы робот пройдёт).
    c.header('X-Robots-Tag', 'noindex, follow');
    return c.body(await renderServicePage(path, SITE_NAME, 'noindex, follow'));
  } catch (err) {
    console.error('[seo] prerender error:', err);
    // Временная ошибка: 503, чтобы робот пришёл позже, а не проиндексировал заглушку.
    c.header('Retry-After', '120');
    return c.text('Temporarily unavailable', 503);
  }
});

// ─── GET /rss.xml ───
seoRoutes.get('/rss.xml', async (c) => {
  const { rows } = await pool.query(
    `SELECT id, title, summary, content, author_name, published_at FROM news WHERE status = 'published' ORDER BY published_at DESC LIMIT 50`
  );

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>${SITE_NAME} — Новости музыки</title>
  <link>${DOMAIN}/news</link>
  <description>Свежие новости музыкальной индустрии от ${SITE_NAME}</description>
  <language>ru</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <atom:link href="${DOMAIN}/rss.xml" rel="self" type="application/rss+xml"/>
  <image><url>${LOGO}</url><title>${SITE_NAME}</title><link>${DOMAIN}</link></image>\n`;

  for (const n of rows) {
    const title = esc(n.title || '');
    const desc = esc(stripHtml(n.summary || n.content || '').slice(0, 500));
    const link = `${DOMAIN}/news/${n.id}`;
    const pubDate = n.published_at ? new Date(n.published_at).toUTCString() : new Date().toUTCString();
    xml += `  <item>
    <title>${title}</title><link>${link}</link>
    <guid isPermaLink="true">${link}</guid>
    <pubDate>${pubDate}</pubDate>
    <dc:creator>${esc(n.author_name || SITE_NAME)}</dc:creator>
    <description>${desc}</description>
  </item>\n`;
  }

  xml += `</channel>\n</rss>`;
  c.header('Content-Type', 'application/rss+xml; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=600');
  return c.body(xml);
});

// ─── GET /turbo-rss.xml — Yandex Turbo Pages ───
seoRoutes.get('/turbo-rss.xml', async (c) => {
  const { rows } = await pool.query(
    `SELECT id, title, content, summary, author_name, image_url, published_at FROM news WHERE status = 'published' ORDER BY published_at DESC LIMIT 50`
  );

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:yandex="http://news.yandex.ru" xmlns:media="http://search.yahoo.com/mrss/" xmlns:turbo="http://turbo.yandex.ru" version="2.0">
<channel>
  <title>${SITE_NAME} — Новости музыки</title>
  <link>${DOMAIN}/news</link>
  <description>Свежие новости музыкальной индустрии</description>
  <language>ru</language>\n`;

  for (const n of rows) {
    const title = esc(n.title || '');
    const link = `${DOMAIN}/news/${n.id}`;
    const pubDate = n.published_at ? new Date(n.published_at).toUTCString() : new Date().toUTCString();
    const author = esc(n.author_name || SITE_NAME);
    const img = (n.image_url || '').startsWith('/') ? `${DOMAIN}${n.image_url}` : (n.image_url || '');
    let turboContent = sanitizeHtml((n.content || n.summary || '')
      .replace(/^\s*```html\s*\n?/i, '').replace(/\n?```\s*$/i, '')
      .replace(/^\s*<code>\s*/i, '').replace(/\s*<\/code>\s*$/i, ''));

    xml += `  <item turbo="true">
    <title>${title}</title><link>${link}</link>
    <pubDate>${pubDate}</pubDate><author>${author}</author>
    <turbo:content><![CDATA[
      <header><h1>${title}</h1><p>${author}</p>${img ? `<figure><img src="${esc(img)}" /></figure>` : ''}</header>
      ${turboContent}
    ]]></turbo:content>
  </item>\n`;
  }

  xml += `</channel>\n</rss>`;
  c.header('Content-Type', 'application/rss+xml; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=600');
  return c.body(xml);
});

// ─── GET /meta/* — JSON meta for SPA ───
seoRoutes.get('/meta/*', async (c) => {
  const rawParam = c.req.path.replace(/\/server\/meta/, '') || '/';
  const path = rawParam.startsWith('/') ? rawParam : '/' + rawParam;
  let meta = PAGE_META[path];

  // Pillar pages override
  if (PILLAR_PAGES[path]) {
    const p = PILLAR_PAGES[path];
    const tk = { stationsCount: await getStationsCount() };
    return c.json({ title: replaceTokens(p.title, tk), description: replaceTokens(p.desc, tk), keywords: p.keywords, type: 'article', url: p.canonical });
  }

  // Alias pages (commercial, genres, blog) override
  if (ALL_ALIASES[path]) {
    const a = ALL_ALIASES[path];
    const tk = { stationsCount: await getStationsCount() };
    return c.json({ title: replaceTokens(a.title, tk), description: replaceTokens(a.desc, tk), keywords: a.keywords, type: a.type || 'website', url: `${DOMAIN}${path}` });
  }

  if (path.startsWith('/news/') && path.length > 6) {
    const { rows } = await pool.query(`SELECT title, summary, content FROM news WHERE id = $1 AND status = 'published'`, [path.slice(6)]);
    if (rows[0]) {
      meta = { title: `${rows[0].title} — ${SITE_NAME}`, desc: stripHtml(rows[0].summary || rows[0].content || '').slice(0, 300), type: 'article' };
    }
  }

  if (path.startsWith('/tracks/') && path.length > 8) {
    const { rows } = await pool.query(`SELECT title, artist_name, description FROM tracks WHERE id = $1`, [path.slice(8)]);
    if (rows[0]) {
      const t = rows[0];
      meta = { title: `${t.title} — ${t.artist_name || 'Артист'} — ${SITE_NAME}`, desc: (t.description || `${t.title} — ${t.artist_name}`).slice(0, 300), type: 'music.song' };
    }
  }

  if (!meta) meta = PAGE_META['/']!;
  const tk = { stationsCount: await getStationsCount() };
  return c.json({ title: replaceTokens(meta.title, tk), description: replaceTokens(meta.desc, tk), type: meta.type, url: `${DOMAIN}${path}` });
});

export default seoRoutes;
