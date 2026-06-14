import { Hono } from 'hono';
import { pool } from './db-client.tsx';

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

const BOT_RE = /bot|crawl|spider|slurp|bingbot|googlebot|yandex|baidu|facebook|twitter|telegram|whatsapp|semrush|ahrefs|gptbot|claudebot|bytespider|petalbot/i;

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

    await pool.query(
      `INSERT INTO page_views (path, referrer, user_agent, ip, device, browser, os, screen_w, screen_h, language, session_id, user_id, is_bot, load_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        (body.p || '/').substring(0, 500),
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
      ]
    );

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

    const [visitors, views, topPages, topRefs, devices, browsers] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT session_id) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false`, [since]),
      pool.query(`SELECT COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false`, [since]),
      pool.query(`SELECT path, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false GROUP BY path ORDER BY cnt DESC LIMIT 10`, [since]),
      pool.query(`SELECT referrer, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false AND referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY cnt DESC LIMIT 10`, [since]),
      pool.query(`SELECT device, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false GROUP BY device ORDER BY cnt DESC`, [since]),
      pool.query(`SELECT browser, COUNT(*) as cnt FROM page_views WHERE created_at >= $1 AND is_bot = false GROUP BY browser ORDER BY cnt DESC LIMIT 8`, [since]),
    ]);

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

export default app;
