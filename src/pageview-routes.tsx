import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import geoip from 'geoip-lite';
import { knownHostFromRequest } from './site-origin.tsx';

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) {
    return next();
  }
  // Fall back to requireAuth + requireAdmin
  const { requireAuth, requireAdmin } = await import('./auth-middleware.tsx');
  return requireAuth(c, async () => { await requireAdmin(c, next); });
}


const app = new Hono();

// page_views.host (миграция 160): с какого из наших сайтов просмотр, чтобы
// promoair.ru не смешивался со статистикой promo-music.ru. Пока колонки нет
// (42703 undefined_column), пишем как раньше и больше не пробуем.
let pageViewsHostColumn = true;

// Статистика админки promo-music.ru (/live, /stats) без просмотров promoair.ru.
// Без колонки host (миграция 160 не применена) фильтра нет, как раньше.
const NOT_AIR_SQL = `coalesce(host, '') NOT IN ('promoair.ru', 'www.promoair.ru')`;
async function withSiteFilter<T>(run: (siteFilter: string) => Promise<T>): Promise<T> {
  if (!pageViewsHostColumn) return run('TRUE');
  try {
    return await run(NOT_AIR_SQL);
  } catch (err: any) {
    if (err?.code !== '42703') throw err;
    pageViewsHostColumn = false;
    console.warn('[pageview] page_views.host missing (migration 160 not applied), stats without site filter');
    return run('TRUE');
  }
}

// Секреты из ссылок писем не храним в page_views.path: токен сброса пароля,
// автовход после подтверждения почты, ключ гостевого чата (?chat=&t=).
const SECRET_QUERY_KEYS = ['token', 'auto_login_token'];
function scrubPath(raw: unknown): string {
  const p = String(raw || '/').substring(0, 500);
  const q = p.indexOf('?');
  if (q < 0) return p;
  try {
    const params = new URLSearchParams(p.slice(q + 1));
    let changed = false;
    for (const k of SECRET_QUERY_KEYS) if (params.has(k)) { params.delete(k); changed = true; }
    if (params.has('chat')) { params.delete('chat'); params.delete('t'); changed = true; }
    if (!changed) return p;
    const rest = params.toString();
    return rest ? `${p.slice(0, q)}?${rest}` : p.slice(0, q);
  } catch {
    return p.slice(0, q);
  }
}

// is_bot detection at insert time. Extended 2026-07: +prerender (крон prerender.py
// UA "PromoFM-Prerender" раньше считался человеком) + headless/monitor/curl и т.п.
const BOT_RE = /bot|crawl|spider|slurp|bingbot|googlebot|yandex|baidu|facebook|twitter|telegram|whatsapp|semrush|ahrefs|gptbot|claudebot|bytespider|petalbot|prerender|headless|monitor|uptime|pingdom|dataprovider|externalagent|python-requests|curl\/|wget/i;

function parseUA(ua: string) {
  let device = 'desktop';
  if (/Mobile|Android.*Mobile|iPhone|iPod/.test(ua)) device = 'mobile';
  else if (/iPad|Android(?!.*Mobile)|Tablet/.test(ua)) device = 'tablet';

  let browser = 'other';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/YaBrowser/.test(ua)) browser = 'Yandex';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';

  let os = 'other';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  return { device, browser, os };
}

// POST /pv — record page view
app.post('/pv', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const ua = c.req.header('user-agent') || '';
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || '0.0.0.0';

    const { device, browser, os } = parseUA(ua);
    const isBot = BOT_RE.test(ua);
    const geo = ip && ip !== '0.0.0.0' ? geoip.lookup(ip) : null;
    const country = geo?.country || null;

    const values = [
      scrubPath(body.p),
      (body.r || '').substring(0, 1000) || null,
      ua.substring(0, 500),
      ip,
      device,
      browser,
      os,
      body.sw || null,
      body.sh || null,
      (body.l || '').substring(0, 10) || null,
      (body.sid || '').substring(0, 64) || null,
      body.uid || null,
      isBot,
      body.lt || null,
      country,
    ];
    const insertWithoutHost = () => pool.query(
      `INSERT INTO page_views (path, referrer, user_agent, ip, device, browser, os, screen_w, screen_h, language, session_id, user_id, is_bot, load_time, country)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      values
    );
    if (pageViewsHostColumn) {
      try {
        await pool.query(
          `INSERT INTO page_views (path, referrer, user_agent, ip, device, browser, os, screen_w, screen_h, language, session_id, user_id, is_bot, load_time, country, host)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [...values, knownHostFromRequest(c)]
        );
      } catch (err: any) {
        if (err?.code !== '42703') throw err;
        pageViewsHostColumn = false;
        console.warn('[pageview] page_views.host missing (migration 160 not applied), writing without host');
        await insertWithoutHost();
      }
    } else {
      await insertWithoutHost();
    }

    return c.json({ ok: true });
  } catch (e: any) {
    console.error('[pageview]', e.message);
    return c.json({ ok: false }, 500);
  }
});

// GET /live — live stats (last 24h)
app.get('/live', requireAdminOrKey, async (c) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [visitors, views, topPages, topRefs, devices, browsers] = await withSiteFilter((SITE) => Promise.all([
      pool.query(`SELECT COUNT(DISTINCT session_id) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false AND ${SITE}`, [since]),
      pool.query(`SELECT COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false AND ${SITE}`, [since]),
      pool.query(`SELECT path, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false AND ${SITE} GROUP BY path ORDER BY cnt DESC LIMIT 10`, [since]),
      pool.query(`SELECT referrer, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false AND ${SITE} AND referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY cnt DESC LIMIT 10`, [since]),
      pool.query(`SELECT device, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false AND ${SITE} GROUP BY device ORDER BY cnt DESC`, [since]),
      pool.query(`SELECT browser, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false AND ${SITE} GROUP BY browser ORDER BY cnt DESC LIMIT 8`, [since]),
    ]));

    return c.json({
      success: true,
      data: {
        visitors24h: parseInt(visitors.rows[0]?.cnt || '0'),
        pageViews24h: parseInt(views.rows[0]?.cnt || '0'),
        topPages: topPages.rows,
        topReferrers: topRefs.rows,
        devices: devices.rows,
        browsers: browsers.rows,
      }
    });
  } catch (e: any) {
    console.error('[analytics/live]', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

// GET /stats?days=N — многодневная аналитика реальных посетителей (admin).
// Надёжный фильтр людей (is_bot + UA): page_views.is_bot НЕ ловит prerender-крон
// на исторических строках, поэтому фильтруем и по user_agent.
app.get('/stats', requireAdminOrKey, async (c) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(c.req.query('days') || '30')));
    const BASE_HUMAN = `NOT is_bot AND coalesce(user_agent,'') !~* '(prerender|bot|crawl|spider|slurp|externalagent|headless|phantom|python|curl|wget|monitor|uptime|pingdom|facebookexternalhit|semrush|ahrefs|bytespider|gptbot|claudebot|dataprovider|petalbot)'`;
    const MSK = `(created_at AT TIME ZONE 'Europe/Moscow')::date`;
    const SINCE = `created_at > (now() - ($1 * interval '1 day'))`;
    const pr = [days];

    const [daily, sum, pages, sources, devices, browsers, geo] = await withSiteFilter((SITE) => {
      const HUMAN = `${BASE_HUMAN} AND ${SITE}`;
      return Promise.all([
      pool.query(`WITH fs AS (SELECT session_id, min(${MSK}) fd FROM page_views WHERE ${HUMAN} GROUP BY 1)
        SELECT to_char(${MSK},'YYYY-MM-DD') AS date, count(DISTINCT pv.session_id)::int AS visitors,
          count(DISTINCT pv.ip)::int AS ips, count(*)::int AS views,
          count(DISTINCT pv.session_id) FILTER (WHERE fs.fd = ${MSK})::int AS new_visitors
        FROM page_views pv JOIN fs USING (session_id)
        WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 1`, pr),
      pool.query(`SELECT count(DISTINCT session_id) FILTER (WHERE ${HUMAN})::int AS visitors,
          count(DISTINCT ip) FILTER (WHERE ${HUMAN})::int AS ips,
          count(*) FILTER (WHERE ${HUMAN})::int AS views,
          count(*) FILTER (WHERE NOT (${BASE_HUMAN}) AND ${SITE})::int AS bots_excluded
        FROM page_views WHERE ${SINCE}`, pr),
      pool.query(`SELECT path, count(DISTINCT session_id)::int AS visitors, count(*)::int AS views
        FROM page_views WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, pr),
      pool.query(`SELECT CASE
          WHEN referrer IS NULL OR referrer = '' THEN 'Прямые/закладки'
          WHEN referrer ~* '(promo-music|promoair)\\.ru' THEN 'Внутренние'
          WHEN referrer ~* '(google|yandex|bing|duckduck|search)' THEN 'Поиск'
          WHEN referrer ~* '(vk\\.com|t\\.me|telegram|instagram|facebook|youtube|tiktok|ok\\.ru|dzen)' THEN 'Соцсети'
          ELSE 'Другие сайты' END AS source, count(DISTINCT session_id)::int AS visitors
        FROM page_views WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC`, pr),
      pool.query(`SELECT coalesce(nullif(device,''),'?') AS device, count(DISTINCT session_id)::int AS visitors
        FROM page_views WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC`, pr),
      pool.query(`SELECT coalesce(nullif(browser,''),'?') AS browser, count(DISTINCT session_id)::int AS visitors
        FROM page_views WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, pr),
      pool.query(`SELECT coalesce(nullif(country,''),'??') AS country, count(DISTINCT session_id)::int AS visitors
        FROM page_views WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, pr),
      ]);
    });

    const s0 = sum.rows[0] || {};
    return c.json({ success: true, data: {
      days,
      summary: { ...s0, perDayVisitors: Math.round((s0.visitors || 0) / days), perDayViews: Math.round((s0.views || 0) / days) },
      daily: daily.rows, topPages: pages.rows, sources: sources.rows,
      devices: devices.rows, browsers: browsers.rows, geo: geo.rows,
    }});
  } catch (e: any) {
    console.error('[analytics/stats]', e.message);
    return c.json({ success: false, error: e.message }, 500);
  }
});

export default app;
