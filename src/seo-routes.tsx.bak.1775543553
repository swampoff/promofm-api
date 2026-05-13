import { Hono } from 'hono';
import { pool } from './db-client.tsx';

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

// ─── Page meta configs ───
const PAGE_META: Record<string, { title: string; desc: string; type: string; image?: string }> = {
  '/': { title: `${SITE_NAME} — музыкальная платформа для артистов`, desc: SITE_DESC, type: 'website' },
  '/news': { title: `Новости музыки — ${SITE_NAME}`, desc: 'Свежие новости музыкальной индустрии: релизы, фестивали, интервью, аналитика', type: 'website' },
  '/charts': { title: `Музыкальные чарты TOP 50 — ${SITE_NAME}`, desc: 'Еженедельный чарт из Spotify, Apple Music, Яндекс Музыки, радиостанций и ВКонтакте', type: 'website' },
  '/concerts': { title: `Концерты и фестивали — ${SITE_NAME}`, desc: 'Афиша концертов и музыкальных событий', type: 'website' },
  '/airplay-monitoring': { title: `Мониторинг эфира радиостанций — ${SITE_NAME}`, desc: 'Узнайте, когда ваш трек звучит на радио. Автоматический мониторинг 500+ радиостанций России', type: 'website' },
  '/promo-air': { title: `ПРОМО.ЭИР — радиоротации — ${SITE_NAME}`, desc: 'Попади в ротацию радиостанций с ПРОМО.ЭИР', type: 'website' },
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

// ─── Render full HTML page ───
function renderPage(opts: {
  title: string; desc: string; canonical: string; type: string;
  image?: string; jsonLd?: string; body: string;
}): string {
  const orgLd = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"${SITE_NAME}","url":"${DOMAIN}","logo":"${LOGO}","sameAs":["https://vk.com/promomusic"]}</script>`;
  const breadcrumbs = opts.canonical === `${DOMAIN}/` ? '' :
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Главная","item":"${DOMAIN}/"},{"@type":"ListItem","position":2,"name":"${escJson(opts.title.split(' — ')[0])}","item":"${escJson(opts.canonical)}"}]}</script>`;
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.desc)}">
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
<a href="${DOMAIN}/for-artists">Для артистов</a>
</nav></header>
<main>${opts.body}</main>
<footer><p>&copy; 2026 ${SITE_NAME}. Музыкальная платформа для артистов, DJ и продюсеров.</p></footer>
</body></html>`;
}

// ─── GET /prerender/* — SSR for bots ───
seoRoutes.get('/prerender/*', async (c) => {
  const rawParam = c.req.path.replace(/\/server\/prerender/, '') || '/';
  const path = rawParam.startsWith('/') ? rawParam : '/' + rawParam;

  try {
    // ─── Individual news article ───
    if (path.startsWith('/news/') && path.length > 6) {
      const newsId = decodeURIComponent(path.slice(6));
      const { rows } = await pool.query(
        `SELECT * FROM news WHERE id = $1 AND status = 'published'`, [newsId]
      );
      if (rows[0]) {
        const a = rows[0];
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
        return c.body(renderPage({
          title: `${title} — ${SITE_NAME}`, desc, canonical: `${DOMAIN}/news/${newsId}`,
          type: 'article', image: img.startsWith('/') ? `${DOMAIN}${img}` : img, jsonLd,
          body: `<article><h1>${esc(title)}</h1><p><time datetime="${pubDate}">${fmtDate(pubDate)}</time> · ${esc(author)}</p>${content}</article>`,
        }));
      }
    }

    // ─── News listing ───
    if (path === '/news') {
      const { rows } = await pool.query(
        `SELECT id, title, summary, author_name, published_at, category FROM news WHERE status = 'published' ORDER BY published_at DESC LIMIT 30`
      );
      let body = `<h1>Новости музыки</h1><p>${esc(PAGE_META['/news'].desc)}</p>`;
      if (rows.length > 0) {
        body += '<ul>';
        for (const n of rows) {
          body += `<li><a href="${DOMAIN}/news/${esc(n.id)}">${esc(n.title)}</a> — <time datetime="${n.published_at || ''}">${fmtDate(n.published_at)}</time>${n.author_name ? ` · ${esc(n.author_name)}` : ''}</li>`;
        }
        body += '</ul>';
      }
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(renderPage({ title: PAGE_META['/news'].title, desc: PAGE_META['/news'].desc, canonical: `${DOMAIN}/news`, type: 'website', body }));
    }

    // ─── Charts ───
    if (path === '/charts') {
      // Aggregate chart data from chart_sources KV store
      const sourceIds = ['russkoe', 'nashe', 'dfm', 'europa', 'hitfm', 'retro'];
      const allTracks: { title: string; artist: string; source: string; pos: number }[] = [];
      for (const sid of sourceIds) {
        const { rows } = await pool.query(`SELECT data FROM chart_sources WHERE id = $1`, [sid]);
        if (rows[0]?.data?.tracks) {
          for (const t of rows[0].data.tracks.slice(0, 10)) {
            allTracks.push({ title: t.title || '', artist: t.artist || '', source: rows[0].data.sourceName || sid, pos: t.position || 0 });
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
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(renderPage({ title: PAGE_META['/charts'].title, desc: PAGE_META['/charts'].desc, canonical: `${DOMAIN}/charts`, type: 'website', body }));
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
      return c.body(renderPage({ title: PAGE_META['/concerts'].title, desc: PAGE_META['/concerts'].desc, canonical: `${DOMAIN}/concerts`, type: 'website', body }));
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
      return c.body(renderPage({ title: PAGE_META['/tracks'].title, desc: PAGE_META['/tracks'].desc, canonical: `${DOMAIN}/tracks`, type: 'website', body }));
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
        return c.body(renderPage({
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

      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(renderPage({ title: PAGE_META['/'].title, desc: PAGE_META['/'].desc, canonical: `${DOMAIN}/`, type: 'website', body }));
    }

    // ─── Generic static pages ───
    const meta = PAGE_META[path] || PAGE_META['/']!;
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(renderPage({
      title: meta.title, desc: meta.desc, canonical: `${DOMAIN}${path}`, type: meta.type,
      body: `<h1>${esc(meta.title)}</h1><p>${esc(meta.desc)}</p>`,
    }));
  } catch (err) {
    console.error('[seo] prerender error:', err);
    const meta = PAGE_META[path] || PAGE_META['/']!;
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(renderPage({
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
