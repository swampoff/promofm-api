import { Hono } from 'hono';
import { newsPublicStore } from './db.tsx';
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

// ─── Page meta configs ───
const PAGE_META: Record<string, { title: string; desc: string; type: string; image?: string }> = {
  '/': { title: `${SITE_NAME} — музыкальная платформа для артистов`, desc: SITE_DESC, type: 'website' },
  '/news': { title: `Новости музыки — ${SITE_NAME}`, desc: 'Свежие новости музыкальной индустрии: релизы, фестивали, интервью, аналитика', type: 'website' },
  '/charts': { title: `Музыкальные чарты TOP 50 — ${SITE_NAME}`, desc: 'Еженедельный чарт из Spotify, Apple Music, Яндекс Музыки, радиостанций и ВКонтакте', type: 'website' },
  '/concerts': { title: `Концерты и фестивали — ${SITE_NAME}`, desc: 'Афиша концертов и музыкальных событий', type: 'website' },
  '/airplay-monitoring': { title: `Мониторинг эфира радиостанций — ${SITE_NAME}`, desc: 'Узнайте, когда ваш трек звучит на радио. Автоматический мониторинг 500+ радиостанций России с детальной статистикой ротаций', type: 'website' },
  '/promo-air': { title: `ПРОМО.ЭИР — радиоротации — ${SITE_NAME}`, desc: 'Попади в ротацию радиостанций с ПРОМО.ЭИР', type: 'website' },
  '/promo-lab': { title: `ПРОМО.ЛАБ — оценка треков — ${SITE_NAME}`, desc: 'Профессиональная оценка треков от экспертов индустрии', type: 'website' },
  '/promo-guide': { title: `ПРОМО.ГИД — руководства — ${SITE_NAME}`, desc: 'Гайды по продвижению музыки и развитию карьеры артиста', type: 'website' },
  '/marketplace': { title: `Маркетплейс — ${SITE_NAME}`, desc: 'Маркетплейс музыкальных услуг: биты, мастеринг, дизайн, продвижение', type: 'website' },
  '/tracks': { title: `Треки — ${SITE_NAME}`, desc: 'Слушайте и открывайте новую музыку: треки артистов платформы ПРОМО.МУЗЫКА', type: 'website' },
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
};

// ─── GET /prerender/* — SSR for bots ───
seoRoutes.get('/prerender/*', async (c) => {
  const rawParam = c.req.param('*') || c.req.path.replace('/server/prerender', '') || '';
  const path = rawParam.startsWith('/') ? rawParam : '/' + rawParam;
  let meta = PAGE_META[path];
  let jsonLd = '';
  let articleHtml = '';

  // News article page
  if (path.startsWith('/news/') && path.length > 6) {
    const newsId = path.slice(6);
    const article = await newsPublicStore.get(newsId);
    if (article) {
      const title = article.title || 'Новость';
      const desc = stripHtml(article.excerpt || article.content || '').slice(0, 300);
      const img = article.imageUrl || article.coverImage || LOGO;
      const author = article.authorName || SITE_NAME;
      const pubDate = article.publishedAt || article.createdAt || new Date().toISOString();
      
      meta = { title: `${title} — ${SITE_NAME}`, desc, type: 'article', image: img.startsWith('/') ? `${DOMAIN}${img}` : img };
      
      jsonLd = `
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "${escJson(title)}",
      "description": "${escJson(desc)}",
      "image": "${escJson(img)}",
      "datePublished": "${pubDate}",
      "dateModified": "${article.updatedAt || pubDate}",
      "author": {"@type": "Person", "name": "${escJson(author)}"},
      "publisher": {
        "@type": "Organization",
        "name": "${SITE_NAME}",
        "logo": {"@type": "ImageObject", "url": "${LOGO}"}
      },
      "mainEntityOfPage": {"@type": "WebPage", "@id": "${DOMAIN}${path}"}
    }
    </script>`;

      // Render article content for bots
      const content = (article.content || article.excerpt || '')
        .replace(/^\s*```html\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      articleHtml = `
    <article>
      <h1>${esc(title)}</h1>
      <p><time datetime="${pubDate}">${new Date(pubDate).toLocaleDateString('ru-RU')}</time> · ${esc(author)}</p>
      ${content}
    </article>`;
    }
  }


  // Track page
  if (path.startsWith('/tracks/') && path.length > 8) {
    const trackId = path.slice(8);
    try {
      const { rows } = await pool.query(
        'SELECT t.*, p.artist_name as artist_display FROM tracks t LEFT JOIN profiles p ON t.user_id::text = p.user_id WHERE t.id = $1',
        [trackId]
      );
      if (rows[0]) {
        const track = rows[0];
        const title = track.title || 'Трек';
        const artist = track.artist_name || track.artist_display || 'Артист';
        const desc = (track.description || `${title} — ${artist}`).slice(0, 300);
        const img = track.cover_url ? (track.cover_url.startsWith('/') ? `${DOMAIN}${track.cover_url}` : track.cover_url) : LOGO;
        const genre = track.genre || '';
        const duration = track.duration ? `PT${Math.floor(track.duration / 60)}M${Math.floor(track.duration % 60)}S` : '';

        meta = { title: `${title} — ${artist} — ${SITE_NAME}`, desc, type: 'music.song', image: img };

        jsonLd = `
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "MusicRecording",
      "name": "${escJson(title)}",
      "description": "${escJson(desc)}",
      "image": "${escJson(img)}",
      "byArtist": {"@type": "MusicGroup", "name": "${escJson(artist)}"},
      ${genre ? `"genre": "${escJson(genre)}",` : ''}
      ${duration ? `"duration": "${duration}",` : ''}
      "url": "${DOMAIN}${path}",
      "datePublished": "${track.created_at || new Date().toISOString()}",
      "publisher": {
        "@type": "Organization",
        "name": "${SITE_NAME}",
        "logo": {"@type": "ImageObject", "url": "${LOGO}"}
      }
    }
    </script>`;

        articleHtml = `
    <article>
      <h1>${esc(title)}</h1>
      <p>${esc(artist)}${genre ? ' · ' + esc(genre) : ''}</p>
      <p>${esc(desc)}</p>
    </article>`;
      }
    } catch (e) {
      console.error('[seo] Track lookup error:', e);
    }
  }

  if (!meta) meta = PAGE_META['/']!;

  // Organization JSON-LD (always)
  const orgLd = `
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "${SITE_NAME}",
      "url": "${DOMAIN}",
      "logo": "${LOGO}",
      "sameAs": ["https://vk.com/promomusic"]
    }
    </script>`;

  // BreadcrumbList
  const crumbs = path === '/' ? '' : `
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Главная", "item": "${DOMAIN}/"},
        {"@type": "ListItem", "position": 2, "name": "${escJson(meta.title.split(' — ')[0])}", "item": "${DOMAIN}${path}"}
      ]
    }
    </script>`;

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(meta.title)}</title>
  <meta name="description" content="${esc(meta.desc)}">
  <link rel="canonical" href="${DOMAIN}${path}">
  
  <!-- Open Graph -->
  <meta property="og:type" content="${meta.type}">
  <meta property="og:url" content="${DOMAIN}${path}">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${esc(meta.title)}">
  <meta property="og:description" content="${esc(meta.desc)}">
  <meta property="og:image" content="${meta.image || LOGO}">
  <meta property="og:locale" content="ru_RU">
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(meta.title)}">
  <meta name="twitter:description" content="${esc(meta.desc)}">
  <meta name="twitter:image" content="${meta.image || LOGO}">
  
  ${orgLd}
  ${crumbs}
  ${jsonLd}
</head>
<body>
  <header>
    <nav>
      <a href="${DOMAIN}/">${SITE_NAME}</a>
      <a href="${DOMAIN}/news">Новости</a>
      <a href="${DOMAIN}/charts">Чарты</a>
      <a href="${DOMAIN}/concerts">Концерты</a>
    </nav>
  </header>
  <main>
    ${articleHtml || `<h1>${esc(meta.title)}</h1><p>${esc(meta.desc)}</p>`}
  </main>
  <footer><p>&copy; 2026 ${SITE_NAME}</p></footer>
</body>
</html>`;

  c.header('Content-Type', 'text/html; charset=utf-8');
  return c.body(html);
});

// ─── GET /rss.xml — RSS feed ───
seoRoutes.get('/rss.xml', async (c) => {
  const allNews = await newsPublicStore.getAll();
  const published = (allNews || [])
    .filter((n: any) => n?.status === 'published' && n?.id)
    .sort((a: any, b: any) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
    .slice(0, 50);

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>${SITE_NAME} — Новости музыки</title>
  <link>${DOMAIN}/news</link>
  <description>Свежие новости музыкальной индустрии от ${SITE_NAME}</description>
  <language>ru</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <atom:link href="${DOMAIN}/rss.xml" rel="self" type="application/rss+xml"/>
  <image>
    <url>${LOGO}</url>
    <title>${SITE_NAME}</title>
    <link>${DOMAIN}</link>
  </image>
`;

  for (const n of published) {
    const title = esc(n.title || '');
    const desc = esc(stripHtml(n.excerpt || n.content || '').slice(0, 500));
    const link = `${DOMAIN}/news/${n.id}`;
    const pubDate = n.publishedAt ? new Date(n.publishedAt).toUTCString() : new Date().toUTCString();
    const author = esc(n.authorName || SITE_NAME);
    
    xml += `  <item>
    <title>${title}</title>
    <link>${link}</link>
    <guid isPermaLink="true">${link}</guid>
    <pubDate>${pubDate}</pubDate>
    <dc:creator>${author}</dc:creator>
    <description>${desc}</description>
  </item>
`;
  }

  xml += `</channel>\n</rss>`;

  c.header('Content-Type', 'application/rss+xml; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=600');
  return c.body(xml);
});

// ─── GET /meta/:path — JSON meta for SPA client-side injection ───
seoRoutes.get('/meta/*', async (c) => {
  const rawParam = c.req.param('*') || c.req.path.replace('/server/prerender', '') || '';
  const path = rawParam.startsWith('/') ? rawParam : '/' + rawParam;
  let meta = PAGE_META[path];

  if (path.startsWith('/news/') && path.length > 6) {
    const newsId = path.slice(6);
    const article = await newsPublicStore.get(newsId);
    if (article) {
      meta = {
        title: `${article.title} — ${SITE_NAME}`,
        desc: stripHtml(article.excerpt || article.content || '').slice(0, 300),
        type: 'article',
      };
    }
  }


  // Track page
  if (path.startsWith('/tracks/') && path.length > 8) {
    const trackId = path.slice(8);
    try {
      const { rows } = await pool.query(
        'SELECT t.*, p.artist_name as artist_display FROM tracks t LEFT JOIN profiles p ON t.user_id::text = p.user_id WHERE t.id = $1',
        [trackId]
      );
      if (rows[0]) {
        const track = rows[0];
        const title = track.title || 'Трек';
        const artist = track.artist_name || track.artist_display || 'Артист';
        const desc = (track.description || `${title} — ${artist}`).slice(0, 300);
        const img = track.cover_url ? (track.cover_url.startsWith('/') ? `${DOMAIN}${track.cover_url}` : track.cover_url) : LOGO;
        const genre = track.genre || '';
        const duration = track.duration ? `PT${Math.floor(track.duration / 60)}M${Math.floor(track.duration % 60)}S` : '';

        meta = { title: `${title} — ${artist} — ${SITE_NAME}`, desc, type: 'music.song', image: img };

        jsonLd = `
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "MusicRecording",
      "name": "${escJson(title)}",
      "description": "${escJson(desc)}",
      "image": "${escJson(img)}",
      "byArtist": {"@type": "MusicGroup", "name": "${escJson(artist)}"},
      ${genre ? `"genre": "${escJson(genre)}",` : ''}
      ${duration ? `"duration": "${duration}",` : ''}
      "url": "${DOMAIN}${path}",
      "datePublished": "${track.created_at || new Date().toISOString()}",
      "publisher": {
        "@type": "Organization",
        "name": "${SITE_NAME}",
        "logo": {"@type": "ImageObject", "url": "${LOGO}"}
      }
    }
    </script>`;

        articleHtml = `
    <article>
      <h1>${esc(title)}</h1>
      <p>${esc(artist)}${genre ? ' · ' + esc(genre) : ''}</p>
      <p>${esc(desc)}</p>
    </article>`;
      }
    } catch (e) {
      console.error('[seo] Track lookup error:', e);
    }
  }

  if (!meta) meta = PAGE_META['/']!;
  return c.json({ title: meta.title, description: meta.desc, type: meta.type, url: `${DOMAIN}${path}` });
});


// ─── GET /turbo-rss.xml — Yandex Turbo Pages RSS ───
seoRoutes.get('/turbo-rss.xml', async (c) => {
  const allNews = await newsPublicStore.getAll();
  const published = (allNews || [])
    .filter((n: any) => n?.status === 'published' && n?.id)
    .sort((a: any, b: any) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
    .slice(0, 50);

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:yandex="http://news.yandex.ru" xmlns:media="http://search.yahoo.com/mrss/" xmlns:turbo="http://turbo.yandex.ru" version="2.0">
<channel>
  <title>${SITE_NAME} — Новости музыки</title>
  <link>${DOMAIN}/news</link>
  <description>Свежие новости музыкальной индустрии</description>
  <language>ru</language>
`;

  for (const n of published) {
    const title = esc(n.title || '');
    const link = `${DOMAIN}/news/${n.id}`;
    const pubDate = n.publishedAt ? new Date(n.publishedAt).toUTCString() : new Date().toUTCString();
    const author = esc(n.authorName || SITE_NAME);
    const img = n.imageUrl || n.coverImage || n.banner || '';
    const imgFull = img.startsWith('/') ? `${DOMAIN}${img}` : img;
    let turboContent = (n.content || n.excerpt || '').replace(/^\s*```html\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    turboContent = turboContent.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    xml += `  <item turbo="true">
    <title>${title}</title>
    <link>${link}</link>
    <pubDate>${pubDate}</pubDate>
    <author>${author}</author>
    <turbo:content><![CDATA[
      <header>
        <h1>${title}</h1>
        <p>${author}</p>
        ${imgFull ? `<figure><img src="${esc(imgFull)}" /></figure>` : ''}
      </header>
      ${turboContent}
    ]]></turbo:content>
  </item>
`;
  }

  xml += `</channel>\n</rss>`;
  c.header('Content-Type', 'application/rss+xml; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=600');
  return c.body(xml);
});

export default seoRoutes;
