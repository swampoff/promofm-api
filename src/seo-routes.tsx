import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { getChartSource } from './db.tsx';
import { PILLAR_PAGES, type PillarMeta } from './seo-content.tsx';
import { ALL_ALIASES, type SeoAlias } from './seo-aliases.tsx';

const seoRoutes = new Hono();
const DOMAIN = 'https://promo-music.ru';
const SITE_NAME = 'ПРОМО.МУЗЫКА';
const SITE_DESC = 'Музыкальная платформа для артистов: чарты, аналитика, продвижение треков, новости индустрии, радиоротации';
const LOGO = `${DOMAIN}/logo.png`;

function esc(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

function replaceTokens(html: string, ctx: { stationsCount: number }): string {
  return html.replace(/\{\{STATIONS_COUNT\}\}/g, String(ctx.stationsCount));
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
  '/': { title: `${SITE_NAME} — музыкальная платформа для артистов`, desc: SITE_DESC, type: 'website' },
  '/news': { title: `Новости музыки — ${SITE_NAME}`, desc: 'Свежие новости музыкальной индустрии: релизы, фестивали, интервью, аналитика', type: 'website' },
  '/charts': { title: `Музыкальные чарты TOP 50 — ${SITE_NAME}`, desc: 'Еженедельный чарт из Spotify, Apple Music, Яндекс Музыки, радиостанций и ВКонтакте', type: 'website' },
  '/concerts': { title: `Концерты и фестивали — ${SITE_NAME}`, desc: 'Афиша концертов и музыкальных событий', type: 'website' },
  '/airplay-monitoring': { title: `Мониторинг эфира радиостанций: когда ваша песня звучит на радио — ${SITE_NAME}`, desc: 'Автоматический мониторинг {{STATIONS_COUNT}} радиостанций России. Точное время эфира песни на радио, отчёт по дням и станциям, подсчёт фактических ротаций трека.', type: 'website' },
  '/promo-air': { title: `ПРОМО.ЭИР: песня на радио и музыка для заведения от одного оператора — ${SITE_NAME}`, desc: 'ПРОМО.ЭИР доводит песню до плейлист-комитетов {{STATIONS_COUNT}} радиостанций и поставляет лицензированную музыку для кафе, ресторанов, баров, фитнес-клубов и магазинов. Радиоротации артистам и фоновое аудио бизнесу из одной системы.', type: 'website' },
  '/pesnya-na-radio': { title: 'Песня на радио: как попасть в ротацию радиостанций | ПРОМО.МУЗЫКА', desc: 'Подробное руководство, как разместить песню на радио, попасть в ротацию {{STATIONS_COUNT}} российских радиостанций и получить отчёт о реальных эфирах. ПРОМО.ЭИР доводит трек до плейлист-комитета без посредников.', type: 'article' },
  '/muzyka-dlya-zavedeniya': { title: 'Музыка для заведения: лицензионное аудио для кафе, ресторанов и магазинов | ПРОМО.МУЗЫКА', desc: 'Лицензионная музыка для заведений: кафе, рестораны, бары, фитнес-клубы, магазины и салоны. Готовые плейлисты под формат места, отчётность для РАО и ВОИС, брендированные джинглы и звуковая идентичность от ПРОМО.ЭИР.', type: 'article' },
  '/for-venues': { title: `Музыка для заведений: подключение фонового аудио для бизнеса — ${SITE_NAME}`, desc: 'Лицензионная музыка для заведений общепита, ритейла и услуг. Подбор плейлистов под аудиторию, отчётность для РАО и ВОИС, фирменные джинглы и звуковое оформление зала от ПРОМО.ЭИР.', type: 'website' },
  '/music-for-restaurants': { title: `Музыка для ресторанов и кафе: фоновое аудио и плейлисты под формат заведения — ${SITE_NAME}`, desc: 'Готовые плейлисты для ресторана, кафе, кофейни и бара под целевую аудиторию и время суток. Лицензионная музыка с отчётностью для РАО и ВОИС, обновление треков без участия персонала.', type: 'website' },
  '/audio-branding': { title: `Звуковой брендинг: джинглы, аудиоидентичность и звук бренда — ${SITE_NAME}`, desc: 'Создание звукового бренда: фирменные джинглы, музыкальная тема, аудио-логотип и звуковая идентичность для бизнеса. Внедряется в плейлисты заведений, рекламу и точки контакта.', type: 'website' },
  '/audiobranding': { title: `Звуковой брендинг для бизнеса: джинглы и музыкальная идентичность — ${SITE_NAME}`, desc: 'Звуковой брендинг для заведений и компаний: фирменные джинглы, аудио-логотип, музыкальная тема. ПРОМО.ЭИР собирает плейлист и звуковые элементы под бренд.', type: 'website' },
  '/radio-advertising': { title: `Реклама на радио: размещение роликов на {{STATIONS_COUNT}} радиостанциях России — ${SITE_NAME}`, desc: 'Размещение рекламы на радио: подбор станций под аудиторию, расчёт охвата, производство ролика и эфирная сетка. Работаем по всей России через операторскую систему ПРОМО.ЭИР.', type: 'website' },
  '/airplay-monitoring-': { title: `Мониторинг ротаций песни на радио — ${SITE_NAME}`, desc: 'Сервис мониторинга {{STATIONS_COUNT}} радиостанций. Узнайте, когда и сколько раз песня прозвучала на радио.', type: 'website' },
  '/promo-lab': { title: `ПРОМО.ЛАБ — оценка треков — ${SITE_NAME}`, desc: 'Профессиональная оценка треков от экспертов индустрии', type: 'website' },
  '/promo-guide': { title: `ПРОМО.ГИД — руководства — ${SITE_NAME}`, desc: 'Гайды по продвижению музыки и развитию карьеры артиста', type: 'website' },
  '/marketplace': { title: `Маркетплейс — ${SITE_NAME}`, desc: 'Маркетплейс музыкальных услуг: биты, мастеринг, дизайн, продвижение', type: 'website' },
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
}): string {
  const orgLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"${SITE_NAME}","url":"${DOMAIN}","logo":"${LOGO}","sameAs":["https://vk.com/promomusic"]}</script>`;
  const breadcrumbs = opts.canonical === `${DOMAIN}/` ? '' :
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Главная","item":"${DOMAIN}/"},{"@type":"ListItem","position":2,"name":"${escJson(opts.title.split(' — ')[0].split(' | ')[0])}","item":"${escJson(opts.canonical)}"}]}</script>`;
  const kw = opts.keywords ? `\n<meta name="keywords" content="${esc(opts.keywords)}">` : '';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.desc)}">${kw}
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
<a href="${DOMAIN}/tracks">Треки</a>
<a href="${DOMAIN}/promo-air">ПРОМО.ЭИР</a>
<a href="${DOMAIN}/for-artists">Для артистов</a>
<a href="${DOMAIN}/for-venues">Для заведений</a>
</nav></header>
<main>${opts.body}</main>
<footer>
<p>&copy; 2026 ${SITE_NAME}. Музыкальная платформа для артистов, DJ и продюсеров.</p>
<nav aria-label="Карта сайта">
<a href="${DOMAIN}/pesnya-na-radio">Песня на радио</a> ·
<a href="${DOMAIN}/muzyka-dlya-zavedeniya">Музыка для заведения</a> ·
<a href="${DOMAIN}/promo-air">ПРОМО.ЭИР</a> ·
<a href="${DOMAIN}/airplay-monitoring">Мониторинг эфира</a> ·
<a href="${DOMAIN}/radio-advertising">Реклама на радио</a> ·
<a href="${DOMAIN}/audio-branding">Звуковой брендинг</a> ·
<a href="${DOMAIN}/charts">Чарты</a> ·
<a href="${DOMAIN}/promo-guide">Гид по продвижению</a>
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
<p>Внутри ПРОМО.ЭИР сидит сеть из {{STATIONS_COUNT}} российских радиостанций: от федеральных Европа Плюс, Русское Радио, DFM и Авторадио до региональных FM по областным центрам и нишевых форматов вроде джаза, рока, шансона и танцевальных каналов. Мы доставляем мастер песни и питч-карточку напрямую в плейлист-комитет станции, а не через анонимную почту, которую никто не открывает.</p>
<p>Артист видит в личном кабинете, какие станции взяли трек в light, medium или heavy rotation, и сколько раз песня уже прозвучала в эфире. Цифры подтверждаются сервисом <a href="${DOMAIN}/airplay-monitoring">мониторинга эфира</a>: система слушает живой поток FM-станций и распознаёт трек по аудиоотпечатку.</p>
<p>Подробное руководство по подаче и форматам ротаций мы собрали в отдельной статье: <a href="${DOMAIN}/pesnya-na-radio">как попасть с песней на радио</a>.</p>
</section>

<section id="venues">
<h2>Для заведений: лицензионная музыка для бизнеса</h2>
<p>Если у вас кафе, ресторан, бар, фитнес-зал, магазин одежды, парикмахерская, отель или коворкинг, в вашем зале по закону должна играть только лицензионная музыка. Иначе РАО и ВОИС начислят вам штраф и обяжут заплатить за все месяцы, когда фон шёл нелегально. Стриминги вроде Яндекс Музыки и Spotify эту лицензию не закрывают: их условия запрещают использование в коммерческих помещениях.</p>
<p>ПРОМО.ЭИР собирает плейлист под формат заведения, время суток и аудиторию. Кафе утром получает спокойный нейтральный фон, бар вечером переходит на ритм и громкость, фитнес-клуб гоняет высокий BPM в зале и спокойную инструменталку в зоне отдыха. Музыка обновляется без участия персонала, а отчётность для РАО и ВОИС закрывается оператором.</p>
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
<li><a href="${DOMAIN}/airplay-monitoring">Мониторинг эфира {{STATIONS_COUNT}} радиостанций</a></li>
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
<h1>Мониторинг эфира {{STATIONS_COUNT}} радиостанций России</h1>
<p class="lead">Раньше артист узнавал об эфире своей песни случайно: позвонила тётка из соседнего города и сказала, что слышала трек в маршрутке. Сейчас работает автоматический мониторинг радио: система слушает прямой поток радиостанции и распознаёт каждый трек по аудиоотпечатку. ПРОМО.МУЗЫКА покрывает {{STATIONS_COUNT}} станции по всей России и отдаёт отчёт в личный кабинет в день выхода эфира.</p>

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
<p>ПРОМО.ЭИР работает как оператор музыки: договор с заведением, отчёт перед РАО и ВОИС, ежемесячные акты. Если к вам приходит проверка, у заведения на руках лежит пакет документов на легальное использование фоновой музыки. Полное руководство по лицензиям и форматам мы вынесли в материал <a href="${DOMAIN}/muzyka-dlya-zavedeniya">музыка для заведения</a>.</p>
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
    keywords: 'музыка для ресторанов, музыка для кафе, плейлист ресторана, фоновая музыка для кафе, лицензионная музыка ресторана',
    body: `
<article class="product">
<h1>Музыка для ресторанов и кафе: как звучит правильное заведение</h1>
<p class="lead">Звук в ресторане это не фон. Это инструмент атмосферы и экономики. Гость, которому нравится звук в зале, остаётся дольше, заказывает больше, охотнее возвращается. Гость, которого раздражает фон, уходит после первого блюда. ПРОМО.МУЗЫКА собирает плейлисты ресторанам, кафе и кофейням так, чтобы зал звучал ровно, легально и под аудиторию.</p>

<section>
<h2>Как звук влияет на средний чек</h2>
<p>Исследования по поведению посетителей в общепите показывают одну простую вещь: темп музыки задаёт темп еды. Медленные треки 60-80 BPM удлиняют ужин, гость берёт второе блюдо и десерт. Быстрые треки 120+ BPM ускоряют ритм, оборот столов растёт. Стилистика тоже важна: классика и джаз поднимают восприятие цены, поп-музыка делает заведение более демократичным.</p>
</section>

<section>
<h2>Форматы плейлистов</h2>
<ul>
<li><strong>Завтрак</strong>: спокойная инструментальная музыка, lo-fi, лаунж, мягкий джаз.</li>
<li><strong>Обед</strong>: умеренный темп, поп, акустика, аккуратный фьюжн.</li>
<li><strong>Ужин</strong>: атмосферные треки, лаунж-электроника, soul, neo-soul, классические инструменталки.</li>
<li><strong>Ночной режим</strong>: ритм, deep house, nu-disco, гэрл-вокал, всё что держит вечер.</li>
</ul>
</section>

<section>
<h2>Что входит в подключение</h2>
<ol>
<li>Лицензионная музыка с закрытием РАО и ВОИС.</li>
<li>Плейлисты под утро, день и вечер.</li>
<li>Автоматическое обновление треков.</li>
<li>Отчётность для проверок и закрывающие документы ежемесячно.</li>
<li>Опционально фирменные джинглы или анонсы для оформления зала.</li>
</ol>
</section>

<section>
<p>Полное руководство по лицензиям, штрафам и юридическим тонкостям читайте в материале <a href="${DOMAIN}/muzyka-dlya-zavedeniya">музыка для заведения</a>. Подключение через <a href="${DOMAIN}/promo-air">ПРОМО.ЭИР</a>, заказ звукового бренда через <a href="${DOMAIN}/audio-branding">аудио-брендинг</a>.</p>
</section>
</article>`,
  },
};

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
      // (подтверждено curl'ом с YandexBot-UA), новости не индексировались.
      // news остаётся фолбэком для старых id.
      let a: any = null;
      const pub = await pool.query(
        `SELECT id, data, created_at FROM news_public WHERE id = $1`, [newsId]
      );
      if (pub.rows[0]) {
        const d = pub.rows[0].data || {};
        if (!d.status || d.status === 'published') {
          a = {
            title: d.title,
            summary: d.excerpt || d.summary,
            content: d.content,
            author_name: d.authorName || d.author_name,
            published_at: d.publishedAt || d.published_at || pub.rows[0].created_at,
            created_at: pub.rows[0].created_at,
            image_url: d.imageUrl || d.image_url,
          };
        }
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
    }

    // ─── News listing ───
    if (path === '/news') {
      // Тот же фикс, что у статьи: лента живёт в news_public, не в news.
      const { rows: pubRows } = await pool.query(
        `SELECT id, data, created_at FROM news_public ORDER BY created_at DESC LIMIT 60`
      );
      const items = pubRows
        .map((r: any) => ({ id: r.id, d: r.data || {}, created_at: r.created_at }))
        .filter((x: any) => !x.d.status || x.d.status === 'published')
        .slice(0, 30);
      let body = `<h1>Новости музыки</h1><p>${esc(PAGE_META['/news'].desc)}</p>`;
      if (items.length > 0) {
        body += '<ul>';
        for (const n of items) {
          const pub = n.d.publishedAt || n.d.published_at || n.created_at || '';
          const author = n.d.authorName || n.d.author_name || '';
          body += `<li><a href="${DOMAIN}/news/${esc(n.id)}">${esc(n.d.title || 'Новость')}</a> — <time datetime="${pub}">${fmtDate(pub)}</time>${author ? ` · ${esc(author)}` : ''}</li>`;
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
    if (path.startsWith('/tracks/') && path.length > 8) {
      const trackId = decodeURIComponent(path.slice(8));
      const { rows } = await pool.query(
        `SELECT t.*, p.artist_name as display_name FROM tracks t LEFT JOIN profiles p ON t.user_id::text = p.user_id WHERE t.id = $1`, [trackId]
      );
      if (rows[0]) {
        const t = rows[0];
        const title = t.title || 'Трек';
        const artist = t.artist_name || t.display_name || 'Артист';
        const desc = (t.description || `${title} — ${artist}`).slice(0, 300);
        const img = t.cover_url ? (t.cover_url.startsWith('/') ? `${DOMAIN}${t.cover_url}` : t.cover_url) : LOGO;
        const duration = t.duration ? `PT${Math.floor(t.duration / 60)}M${Math.floor(t.duration % 60)}S` : '';

        const jsonLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicRecording","name":"${escJson(title)}","byArtist":{"@type":"MusicGroup","name":"${escJson(artist)}"}${t.genre ? `,"genre":"${escJson(t.genre)}"` : ''}${duration ? `,"duration":"${duration}"` : ''},"url":"${DOMAIN}/tracks/${escJson(trackId)}","image":"${escJson(img)}"}</script>`;

        c.header('Content-Type', 'text/html; charset=utf-8');
        return c.body(await renderPageWithTokens({
          title: `${title} — ${artist} — ${SITE_NAME}`, desc, canonical: `${DOMAIN}/tracks/${trackId}`,
          type: 'music.song', image: img, jsonLd,
          body: `<article><h1>${esc(title)}</h1><p>${esc(artist)}${t.genre ? ` · ${esc(t.genre)}` : ''}</p>${desc ? `<p>${esc(desc)}</p>` : ''}</article>`,
        }));
      }
    }

    // ─── Homepage with featured content ───
    if (path === '/' || path === '') {
      const [newsRes, tracksRes] = await Promise.all([
        pool.query(`SELECT id, title, published_at FROM news WHERE status = 'published' ORDER BY published_at DESC LIMIT 5`).catch(() => ({ rows: [] })),
        pool.query(`SELECT title, artist_name FROM tracks WHERE moderation_status = 'approved' AND is_hidden = false ORDER BY plays_count DESC NULLS LAST LIMIT 10`).catch(() => ({ rows: [] })),
      ]);

      let body = `<h1>${SITE_NAME}</h1><p>${esc(SITE_DESC)}</p>`;
      if (newsRes.rows.length > 0) {
        body += '<section><h2>Последние новости</h2><ul>';
        for (const n of newsRes.rows) {
          body += `<li><a href="${DOMAIN}/news/${esc(n.id)}">${esc(n.title)}</a></li>`;
        }
        body += '</ul></section>';
      }
      if (tracksRes.rows.length > 0) {
        body += '<section><h2>Популярные треки</h2><ol>';
        for (const t of tracksRes.rows) {
          body += `<li>${esc(t.title)} — ${esc(t.artist_name || 'Артист')}</li>`;
        }
        body += '</ol></section>';
      }
      body += `<section><h2>Возможности платформы</h2><ul>
<li><a href="${DOMAIN}/charts">Музыкальные чарты TOP 50</a></li>
<li><a href="${DOMAIN}/promo-lab">Профессиональная оценка треков</a></li>
<li><a href="${DOMAIN}/promo-air">Радиоротации для артистов</a></li>
<li><a href="${DOMAIN}/marketplace">Маркетплейс музыкальных услуг</a></li>
<li><a href="${DOMAIN}/concerts">Афиша концертов</a></li>
</ul></section>`;

      // FAQPage на главной — копия 4 Q&A из фронт-реестра seo-pages.ts (синхрон).
      // FAQ-schema нет ни у tophit, ни у конкурентов обоих кластеров → rich-сниппет.
      const homeFaq = [
        { q: 'Что такое ПРОМО.МУЗЫКА?', a: 'Российская платформа продвижения музыки для артистов, лейблов, DJ, продюсеров и звукорежиссёров. Объединяет питчинг на {{STATIONS_COUNT}} радиостанции, попадание в плейлисты стримингов, чарты, дистрибуцию и маркетплейс битов и услуг.' },
        { q: 'Как попасть на радио со своей песней?', a: 'Зарегистрируйтесь как артист, загрузите трек, отметьте радиостанции для питчинга. Заявка приходит в кабинет радио, редактор принимает решение о ротации напрямую.' },
        { q: 'Сколько стоит продвижение трека?', a: 'Публикация трека — 7 000 ₽ с пожизненным доступом к питчингу, аналитике и попаданию в «Новинки недели». Подробнее на странице тарифов.' },
        { q: 'Чем ПРОМО.МУЗЫКА отличается от обычного дистрибьютора?', a: 'Дистрибьютор только загружает треки в стриминги. ПРОМО.МУЗЫКА дополнительно даёт прямой канал на радиостанции (питчинг с реальным редактором), экспертную оценку перед релизом (ПРОМО.ЛАБ) и маркетплейс услуг для подготовки трека.' },
      ];
      body += `<section class="faq-block"><h2>Частые вопросы</h2><dl class="faq">${homeFaq.map(({ q, a }) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl></section>`;

      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPageWithTokens({ title: PAGE_META['/'].title, desc: PAGE_META['/'].desc, canonical: `${DOMAIN}/`, type: 'website', jsonLd: buildFaqLd(homeFaq), body }));
    }

    // ─── Pillar pages (rich SEO landing pages with FAQ schema) ───
    if (PILLAR_PAGES[path]) {
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPillarWithTokens(PILLAR_PAGES[path]));
    }

    // ─── Product pages with rich body content ───
    if (PRODUCT_PAGES[path]) {
      const p = PRODUCT_PAGES[path];
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(await renderPageWithTokens({
        title: p.meta.title, desc: p.meta.desc, canonical: `${DOMAIN}${path}`, type: p.meta.type,
        keywords: p.keywords, body: p.body,
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
      const bodyHtml = a.body.includes('class="faq"') ? a.body : `${a.body}\n${faqHtml}`;
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
    const meta = PAGE_META[path] || PAGE_META['/']!;
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(await renderPageWithTokens({
      title: meta.title, desc: meta.desc, canonical: `${DOMAIN}${path}`, type: meta.type,
      body: `<h1>${esc(meta.title)}</h1><p>${esc(meta.desc)}</p>`,
    }));
  } catch (err) {
    console.error('[seo] prerender error:', err);
    const meta = PAGE_META[path] || PAGE_META['/']!;
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(await renderPageWithTokens({
      title: meta.title, desc: meta.desc, canonical: `${DOMAIN}${path}`, type: meta.type,
      body: `<h1>${esc(meta.title)}</h1><p>${esc(meta.desc)}</p>`,
    }));
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
    return c.json({ title: p.title, description: p.desc, keywords: p.keywords, type: 'article', url: p.canonical });
  }

  // Alias pages (commercial, genres, blog) override
  if (ALL_ALIASES[path]) {
    const a = ALL_ALIASES[path];
    return c.json({ title: a.title, description: a.desc, keywords: a.keywords, type: a.type || 'website', url: `${DOMAIN}${path}` });
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
  return c.json({ title: meta.title, description: meta.desc, type: meta.type, url: `${DOMAIN}${path}` });
});

export default seoRoutes;
