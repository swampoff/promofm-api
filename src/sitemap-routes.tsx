import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { listAllNewsPublic } from './db.tsx';
import { classifySpaPath } from './spa-routes.tsx';
import { PUBLIC_TRACK_SQL, PUBLIC_VIDEO_SQL, PUBLIC_CONCERT_SQL } from './public-content.tsx';
const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) {
    return next();
  }
  const { requireAuth, requireAdmin } = await import('./auth-middleware.tsx');
  return requireAuth(c, async () => { await requireAdmin(c, next); });
}


const sitemapRoutes = new Hono();
const DOMAIN = 'https://promo-music.ru';

// ─── All 39 static public routes ───
const STATIC_PAGES: { loc: string; changefreq: string; priority: string }[] = [
  // Homepage
  { loc: '/', changefreq: 'daily', priority: '1.0' },
  // Main sections (0.9)
  { loc: '/news', changefreq: 'hourly', priority: '0.9' },
  { loc: '/charts', changefreq: 'daily', priority: '0.9' },
  { loc: '/concerts', changefreq: 'daily', priority: '0.9' },
  // Core features (0.8)
  { loc: '/promo-air', changefreq: 'weekly', priority: '0.8' },
  // Посадочные семантического ядра Promo.Air (кластеры «Своё радио»,
  // «Легальная музыка», «Винные бары и винодельни»).
  { loc: '/promo-air/own-radio', changefreq: 'weekly', priority: '0.8' },
  { loc: '/promo-air/legal-music', changefreq: 'weekly', priority: '0.8' },
  { loc: '/music-for-business', changefreq: 'weekly', priority: '0.9' },
  { loc: '/promo-air/wine-bars', changefreq: 'monthly', priority: '0.7' },
  { loc: '/promo-air/audio-branding', changefreq: 'weekly', priority: '0.8' },
  { loc: '/promo-air/in-store-music', changefreq: 'weekly', priority: '0.8' },
  { loc: '/promo-air/network-radio', changefreq: 'weekly', priority: '0.7' },
  { loc: '/promo-lab', changefreq: 'weekly', priority: '0.8' },
  { loc: '/promo-guide', changefreq: 'weekly', priority: '0.8' },
  { loc: '/marketplace', changefreq: 'daily', priority: '0.8' },
  { loc: '/sell-music', changefreq: 'weekly', priority: '0.8' },
  { loc: '/radio', changefreq: 'daily', priority: '0.8' },
  { loc: '/tracks', changefreq: 'daily', priority: '0.8' },
  { loc: '/videos', changefreq: 'daily', priority: '0.8' },
  // Artist features (0.7)
  { loc: '/dashboard', changefreq: 'daily', priority: '0.7' },
  { loc: '/dashboard/tracks', changefreq: 'daily', priority: '0.7' },
  { loc: '/dashboard/videos', changefreq: 'daily', priority: '0.7' },
  { loc: '/dashboard/concerts', changefreq: 'daily', priority: '0.7' },
  { loc: '/dashboard/analytics', changefreq: 'daily', priority: '0.7' },
  { loc: '/dashboard/promotion', changefreq: 'weekly', priority: '0.7' },
  { loc: '/dashboard/settings', changefreq: 'monthly', priority: '0.5' },
  // DJ features (0.7)
  { loc: '/dj-studio', changefreq: 'weekly', priority: '0.7' },
  { loc: '/dj-marketplace', changefreq: 'daily', priority: '0.7' },
  // Producer features (0.7)
  { loc: '/producer-studio', changefreq: 'weekly', priority: '0.7' },
  // Public pages (0.6)
  { loc: '/help', changefreq: 'monthly', priority: '0.6' },
  { loc: '/about', changefreq: 'monthly', priority: '0.6' },
  { loc: '/contacts', changefreq: 'monthly', priority: '0.6' },
  { loc: '/terms', changefreq: 'yearly', priority: '0.4' },
  { loc: '/privacy', changefreq: 'yearly', priority: '0.4' },
  // Auth pages (0.3)
  { loc: '/login', changefreq: 'monthly', priority: '0.3' },
  { loc: '/register', changefreq: 'monthly', priority: '0.3' },
  { loc: '/forgot-password', changefreq: 'monthly', priority: '0.3' },
  // Content sections (0.6)
  { loc: '/donations', changefreq: 'weekly', priority: '0.6' },
  { loc: '/coins', changefreq: 'weekly', priority: '0.6' },
  { loc: '/booking', changefreq: 'daily', priority: '0.8' },
  // /curator и /music-gen убраны 20.09.2026: страниц не существует
  // (ни маршрута, ни компонента), sitemap вёл робота на 404.
  { loc: '/booking/cover-bands', changefreq: 'weekly', priority: '0.7' },
  { loc: '/booking/hosts', changefreq: 'weekly', priority: '0.7' },
  // Collaboration & messaging (0.5)
  { loc: '/collaboration', changefreq: 'weekly', priority: '0.5' },
  { loc: '/messages', changefreq: 'daily', priority: '0.5' },
  // Playgramm (0.6)
  { loc: '/pg/', changefreq: 'weekly', priority: '0.6' },
  // Feed / discover (0.7)
  { loc: '/publish', changefreq: 'daily', priority: '0.7' },
  { loc: '/checkout', changefreq: 'monthly', priority: '0.4' },
  // SEO Pillar Pages (long-form content for primary keywords)
  { loc: '/pesnya-na-radio', changefreq: 'weekly', priority: '0.9' },
  { loc: '/muzyka-dlya-zavedeniya', changefreq: 'weekly', priority: '0.9' },
  // SEO Landing Pages
  { loc: '/for-artists', changefreq: 'weekly', priority: '0.8' },
  { loc: '/for-djs', changefreq: 'weekly', priority: '0.7' },
  { loc: '/for-producers', changefreq: 'weekly', priority: '0.7' },
  { loc: '/for-engineers', changefreq: 'weekly', priority: '0.6' },
  { loc: '/for-venues', changefreq: 'weekly', priority: '0.8' },
  { loc: '/promotion', changefreq: 'weekly', priority: '0.8' },
  { loc: '/get-in-chart', changefreq: 'weekly', priority: '0.8' },
  { loc: '/tv-rotation', changefreq: 'weekly', priority: '0.8' },
  { loc: '/international-radio', changefreq: 'weekly', priority: '0.8' },
  { loc: '/how-to-grow-track', changefreq: 'monthly', priority: '0.8' },
  { loc: '/music-for-cafe', changefreq: 'monthly', priority: '0.7' },
  { loc: '/music-for-shop', changefreq: 'monthly', priority: '0.7' },
  { loc: '/music-for-gym', changefreq: 'monthly', priority: '0.7' },
  { loc: '/music-for-hotel', changefreq: 'monthly', priority: '0.7' },
  { loc: '/music-for-salon', changefreq: 'monthly', priority: '0.7' },
  { loc: '/for-tv', changefreq: 'monthly', priority: '0.6' },
  { loc: '/for-labels', changefreq: 'weekly', priority: '0.7' },
  { loc: '/for-media', changefreq: 'monthly', priority: '0.6' },
  { loc: '/for-bloggers', changefreq: 'monthly', priority: '0.6' },
  { loc: '/music-for-restaurants', changefreq: 'weekly', priority: '0.8' },
  { loc: '/audiobranding', changefreq: 'weekly', priority: '0.7' },
  { loc: '/radio-advertising', changefreq: 'weekly', priority: '0.7' },
  // /for-business — 301 на /radio-stations (дубль PROMO.FM), в карте не нужен.
  { loc: '/djs', changefreq: 'daily', priority: '0.7' },
  { loc: '/faq', changefreq: 'monthly', priority: '0.6' },
  { loc: '/pricing', changefreq: 'weekly', priority: '0.7' },
  { loc: '/contact', changefreq: 'monthly', priority: '0.5' },
  { loc: '/careers', changefreq: 'monthly', priority: '0.5' },
  { loc: '/partners', changefreq: 'monthly', priority: '0.6' },
  // SEO Pillar — Airplay Monitoring
  { loc: '/airplay-monitoring', changefreq: 'weekly', priority: '0.9' },
  // SEO Commercial Aliases — Promo / Distribution / Upload
  { loc: '/promo', changefreq: 'weekly', priority: '0.9' },
  { loc: '/promo/ads', changefreq: 'weekly', priority: '0.8' },
  { loc: '/distribution', changefreq: 'weekly', priority: '0.9' },
  { loc: '/upload', changefreq: 'weekly', priority: '0.8' },
  { loc: '/upload/track', changefreq: 'weekly', priority: '0.8' },
  { loc: '/upload/album', changefreq: 'weekly', priority: '0.7' },
  { loc: '/upload/video', changefreq: 'weekly', priority: '0.7' },
  // SEO Commercial Aliases — Charts / Analytics / Evaluate / Monetize
  { loc: '/chart/airplay', changefreq: 'daily', priority: '0.8' },
  { loc: '/chart/streaming', changefreq: 'daily', priority: '0.8' },
  { loc: '/analytics', changefreq: 'weekly', priority: '0.7' },
  { loc: '/analytics/airplay', changefreq: 'weekly', priority: '0.7' },
  { loc: '/evaluate', changefreq: 'weekly', priority: '0.7' },
  { loc: '/monetize', changefreq: 'weekly', priority: '0.7' },
  { loc: '/monetize/youtube', changefreq: 'weekly', priority: '0.6' },
  // SEO Commercial Aliases — Events / Concerts
  { loc: '/events', changefreq: 'daily', priority: '0.8' },
  { loc: '/events/add', changefreq: 'weekly', priority: '0.6' },
  // SEO Commercial Aliases — Radio
  { loc: '/radio/submit', changefreq: 'weekly', priority: '0.9' },
  { loc: '/radio/listen', changefreq: 'daily', priority: '0.8' },
  { loc: '/radio/new', changefreq: 'daily', priority: '0.7' },
  { loc: '/radio/electronic', changefreq: 'weekly', priority: '0.7' },
  { loc: '/radio/soul-fm', changefreq: 'weekly', priority: '0.7' },
  { loc: '/radio/soul-fm/playlist', changefreq: 'daily', priority: '0.6' },
  // SEO Commercial Aliases — Catalog / Press / Reviews
  { loc: '/new', changefreq: 'daily', priority: '0.8' },
  { loc: '/new/russian', changefreq: 'daily', priority: '0.7' },
  { loc: '/playpress', changefreq: 'weekly', priority: '0.7' },
  { loc: '/reviews', changefreq: 'weekly', priority: '0.7' },
  // SEO Genre Pages
  { loc: '/genres/electronic', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/deep-house', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/techno', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/dnb', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/ambient', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/chillout', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/trance', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/electro-house', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/rap', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/hiphop', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/beats', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/trap', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/pop', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/indie', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/alternative', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/lofi', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/soundscapes', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/meditation', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/sound-healing', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/ethnic', changefreq: 'weekly', priority: '0.7' },
  { loc: '/genres/world', changefreq: 'weekly', priority: '0.7' },
  // SEO Blog Pages
  { loc: '/blog/how-to-promote-music', changefreq: 'monthly', priority: '0.7' },
  { loc: '/blog/how-to-get-on-radio', changefreq: 'monthly', priority: '0.7' },
  { loc: '/blog/distribution-guide', changefreq: 'monthly', priority: '0.7' },
  { loc: '/blog/streaming-royalties', changefreq: 'monthly', priority: '0.7' },
  { loc: '/blog/press-kit-guide', changefreq: 'monthly', priority: '0.7' },
  { loc: '/blog/organize-concert', changefreq: 'monthly', priority: '0.7' },
  { loc: '/blog/how-to-record-track', changefreq: 'monthly', priority: '0.7' },
  { loc: '/blog/best-russian-2026', changefreq: 'weekly', priority: '0.7' },
  { loc: '/blog/how-we-review', changefreq: 'monthly', priority: '0.6' },
  { loc: '/blog/radio-formats', changefreq: 'monthly', priority: '0.6' },
];

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function toW3CDate(d: string | Date | undefined): string {
  if (!d) return new Date().toISOString().split('T')[0];
  try {
    return new Date(d).toISOString().split('T')[0];
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

// GET /sitemap.xml — comprehensive dynamic sitemap
sitemapRoutes.get('/sitemap.xml', async (c) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Fetch dynamic content in parallel
    const [newsResult, concertsResult, videosResult, tracksResult, profilesResult] = await Promise.all([
      listAllNewsPublic().catch(() => []),
      // Только то, что человек видит на странице концерта (PUBLIC_STATUSES в concerts-routes).
      pool.query(`SELECT c.id, c.title, c.updated_at, c.created_at FROM concerts c
                   WHERE ${PUBLIC_CONCERT_SQL} ORDER BY c.event_date ASC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT v.id, v.title, v.updated_at, v.created_at FROM videos v
                   WHERE ${PUBLIC_VIDEO_SQL} ORDER BY v.created_at DESC`).catch(() => ({ rows: [] })),
      // Живые треки (published), без архива promo.fm и демо-засева. Раньше
      // брались 500 последних approved — почти целиком архив, а 178 живых
      // треков в карту не попадали вовсе.
      pool.query(`SELECT t.id, t.title, t.artist_name, t.genre, t.updated_at, t.created_at FROM tracks t
                   WHERE ${PUBLIC_TRACK_SQL}
                     AND COALESCE(t.is_legacy, false) = false AND t.user_id IS NOT NULL
                     AND COALESCE(t.artist_name, '') NOT ILIKE 'demo artist%'
                   ORDER BY t.created_at DESC LIMIT 500`).catch(() => ({ rows: [] })),
      // Профили артистов с живыми треками — адрес как canonical на странице (slug, иначе id).
      pool.query(`SELECT COALESCE(ap.slug, ap.id::text) AS key, MAX(t.updated_at) AS updated_at
                    FROM artist_profiles ap JOIN tracks t ON t.artist_id = ap.id
                   WHERE ${PUBLIC_TRACK_SQL} AND COALESCE(t.is_legacy, false) = false
                   GROUP BY 1 ORDER BY 2 DESC LIMIT 1000`).catch(() => ({ rows: [] })),
    ]);

    // В карту — только адреса, которые у человека существуют (маршруты SPA).
    // До 24.09.2026 тут стояли /dashboard*, /login, /coins, /tracks/:id,
    // /videos/:id — у человека это «не найдено» или кабинет. Если маршруты
    // фронта прочитать не удалось (null), список не режем.
    const isPublic = (p: string) => { const k = classifySpaPath(p); return k === null || k === 'public'; };
    const staticPages = STATIC_PAGES.filter((p) => isPublic(p.loc));
    const withConcerts = isPublic('/concerts/x');
    const withVideos = isPublic('/videos/x');
    const withTracks = isPublic('/tracks/x');
    const profiles = isPublic('/profile/x') ? (profilesResult.rows || []) : [];

    const publishedNews = (newsResult || []).filter((n: any) => {
      const status = n?.status || n?.data?.status;
      return status === 'published' && n?.id;
    });
    const concerts = withConcerts ? (concertsResult.rows || []) : [];
    const videos = withVideos ? (videosResult.rows || []) : [];
    const tracks = withTracks ? (tracksResult.rows || []) : [];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n`;
    xml += `        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"\n`;
    xml += `        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n`;

    // ── Static pages ──
    for (const p of staticPages) {
      xml += `  <url>\n`;
      xml += `    <loc>${DOMAIN}${p.loc}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>${p.changefreq}</changefreq>\n`;
      xml += `    <priority>${p.priority}</priority>\n`;
      xml += `  </url>\n`;
    }

    // ── News articles ──
    for (const n of publishedNews) {
      const title = n.title || n.data?.title || '';
      const pubDate = n.publishedAt || n.data?.publishedAt || n.createdAt || n.created_at;
      const modDate = n.updatedAt || n.data?.updatedAt || n.updated_at || pubDate;
      const lastmod = toW3CDate(modDate);
      xml += `  <url>\n`;
      xml += `    <loc>${DOMAIN}/news/${escapeXml(String(n.id))}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.8</priority>\n`;
      if (title && pubDate) {
        xml += `    <news:news>\n`;
        xml += `      <news:publication>\n`;
        xml += `        <news:name>ПРОМО.МУЗЫКА</news:name>\n`;
        xml += `        <news:language>ru</news:language>\n`;
        xml += `      </news:publication>\n`;
        xml += `      <news:publication_date>${new Date(pubDate).toISOString()}</news:publication_date>\n`;
        xml += `      <news:title>${escapeXml(title)}</news:title>\n`;
        xml += `    </news:news>\n`;
      }
      xml += `  </url>\n`;
    }

    // ── Concerts ──
    for (const concert of concerts) {
      const lastmod = toW3CDate(concert.updated_at || concert.created_at);
      xml += `  <url>\n`;
      xml += `    <loc>${DOMAIN}/concerts/${escapeXml(String(concert.id))}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.6</priority>\n`;
      xml += `  </url>\n`;
    }

    // ── Videos ──
    for (const video of videos) {
      const lastmod = toW3CDate(video.updated_at || video.created_at);
      xml += `  <url>\n`;
      xml += `    <loc>${DOMAIN}/videos/${escapeXml(String(video.id))}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += `    <changefreq>monthly</changefreq>\n`;
      xml += `    <priority>0.6</priority>\n`;
      xml += `  </url>\n`;
    }


    // ── Tracks ──
    for (const track of tracks) {
      const lastmod = toW3CDate(track.updated_at || track.created_at);
      xml += `  <url>\n`;
      xml += `    <loc>${DOMAIN}/tracks/${escapeXml(String(track.id))}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += `    <changefreq>monthly</changefreq>\n`;
      xml += `    <priority>0.6</priority>\n`;
      xml += `  </url>\n`;
    }

    // ── Artist profiles ──
    for (const p of profiles) {
      xml += `  <url>\n`;
      xml += `    <loc>${DOMAIN}/profile/${escapeXml(encodeURIComponent(String(p.key)))}</loc>\n`;
      xml += `    <lastmod>${toW3CDate(p.updated_at)}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.6</priority>\n`;
      xml += `  </url>\n`;
    }

    xml += `</urlset>`;

    const urlCount = staticPages.length + publishedNews.length + concerts.length + videos.length + tracks.length + profiles.length;
    console.log(`[sitemap] Generated: ${staticPages.length} static + ${publishedNews.length} news + ${concerts.length} concerts + ${videos.length} videos + ${tracks.length} tracks = ${urlCount} URLs`);

    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=600'); // 10min cache
    c.header('X-Sitemap-URLs', String(urlCount));
    return c.body(xml);
  } catch (error) {
    console.error('[sitemap] Error:', error);
    return c.text('Error generating sitemap', 500);
  }
});

const INDEXNOW_KEY = 'be3b1945c60d606211ccb819caebe3fb';

// POST /sitemap/ping — ping search engines (Yandex ping + IndexNow for Bing/Yandex)
sitemapRoutes.post('/sitemap/ping', requireAdminOrKey, async (c) => {
  const sitemapUrl = `${DOMAIN}/sitemap.xml`;
  const results: Record<string, string> = {};

  // Yandex sitemap ping (still works)
  try {
    const yRes = await fetch(`https://webmaster.yandex.ru/ping?sitemap=${encodeURIComponent(sitemapUrl)}`);
    results.yandex_ping = yRes.ok ? 'ok' : `${yRes.status}`;
  } catch (e: any) {
    results.yandex_ping = `error: ${e.message}`;
  }

  // IndexNow — submit to Bing & Yandex
  const body = c.req.query('url');
  const urlList = body ? [body] : [`${DOMAIN}/sitemap.xml`];
  
  for (const engine of ['api.indexnow.org', 'yandex.com']) {
    try {
      const res = await fetch(`https://${engine}/indexnow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: 'promo-music.ru',
          key: INDEXNOW_KEY,
          keyLocation: `${DOMAIN}/${INDEXNOW_KEY}.txt`,
          urlList: urlList,
        }),
      });
      results[`indexnow_${engine.split('.')[0]}`] = res.ok ? 'ok' : `${res.status}`;
    } catch (e: any) {
      results[`indexnow_${engine.split('.')[0]}`] = `error: ${e.message}`;
    }
  }

  // Google: best practice is sitemap in robots.txt + regular crawl
  results.google = 'sitemap in robots.txt (auto-crawl)';

  console.log(`[sitemap] Ping results:`, results);
  return c.json({ success: true, results, sitemapUrl });
});

// POST /sitemap/indexnow — submit specific URL to IndexNow
sitemapRoutes.post('/sitemap/indexnow', requireAdminOrKey, async (c) => {
  const body = await c.req.json();
  const urls = body.urls || [body.url].filter(Boolean);
  if (!urls.length) return c.json({ success: false, error: 'No URLs provided' }, 400);

  const results: Record<string, string> = {};
  for (const engine of ['api.indexnow.org', 'yandex.com']) {
    try {
      const res = await fetch(`https://${engine}/indexnow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: 'promo-music.ru',
          key: INDEXNOW_KEY,
          keyLocation: `${DOMAIN}/${INDEXNOW_KEY}.txt`,
          urlList: urls,
        }),
      });
      results[engine] = res.ok ? 'ok' : `${res.status}`;
    } catch (e: any) {
      results[engine] = `error: ${e.message}`;
    }
  }
  return c.json({ success: true, results, urls });
});

export default sitemapRoutes;

