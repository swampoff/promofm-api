/**
 * PromoFM API Server — Node.js + Hono
 * Entry point for the VPS-hosted backend.
 */
import 'dotenv/config';
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import path from 'node:path';
// Security: validate critical env vars at startup
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  // eslint-disable-next-line no-console
  console.error('FATAL: JWT_SECRET is missing or too short (min 32 chars). Refusing to start.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.error('FATAL: DATABASE_URL is missing. Refusing to start.');
  process.exit(1);
}

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import * as db from './db.tsx';

import { initializeStorage } from './storage-setup.tsx';

import authRoutes from './auth-routes.tsx';
import concertsRoutes from './concerts-routes.tsx';
import notificationsRoutes from './notifications-routes.tsx';
import ticketingRoutes from './ticketing-routes.tsx';
import storageRoutes from './storage-routes.tsx';
import migrationRoutes from './migration-routes.tsx';
import marketingCampaignsRoutes from './marketing-campaigns-routes.tsx';
import subscriptionsRoutes from './subscriptions-routes.tsx';
import promotionRoutes from './promotion-routes-sql.tsx';
import bannerRoutes from './banner-routes.tsx';
import notificationsMessengerRoutes from './notifications-messenger-routes.tsx';
import emailRoutes from './email-routes.tsx';
import ticketsSystemRoutes from './tickets-system-routes.tsx';
import chatSupportRoutes from './chat-support-routes.tsx';
import distributionRoutes from './distribution-routes.tsx';
import paymentsRoutes from './payments-routes.tsx';
import settingsRoutes from './settings-routes.tsx';
import trackTestRoutes from './track-test-routes.tsx';
import trackModerationRoutes from './track-moderation-routes.tsx';
import djMixModerationRoutes from './dj-mix-moderation-routes.tsx';
import pitchingRoutes from './pitching-routes.tsx';
import labelRoutes from './label-routes.tsx';
import bookingRoutes from './booking-routes.tsx';
import bookingPublicRoutes from './booking-public-routes.tsx';
import contentOrdersRoutes from './content-orders-routes.tsx';
import venueRadioApp from './venue-radio-routes.tsx';
import elevenlabsRoutes from './elevenlabs-integration.tsx';
import radioRoutes from './radio-routes.tsx';
import venueRoutes from './venue-routes.tsx';
import venueZonesRoutes from './venue-zones-routes.tsx';
import venueBillingRoutes from './venue-billing-routes.tsx';
import venueLocationsRoutes from './venue-locations-routes.tsx';
import venueBrandingRoutes from './venue-branding-routes.tsx';
import streamPlayerRoutes from './stream-player-routes.tsx';
import venueStationRoutes from './venue-station-routes.tsx';
import venueApkRoutes from './venue-apk-routes.tsx';
import venueScheduleRoutes from './venue-schedule-routes.tsx';
import { venueApiTokensApp, venueApiPublicApp } from './venue-api-routes.tsx';
import promoGuideRoutes from './promo-guide-routes.tsx';
import aiAgent from './ai-agent.ts';
import djMarketplaceRoutes from './dj-marketplace-routes.tsx';
import artistProfileRoutes from './artist-profile-routes.tsx';
import radioProfileRoutes from './radio-profile-routes.tsx';
import landingDataRoutes from './landing-data-routes.tsx';
import producerStudioRoutes from './producer-studio-routes.tsx';
import djStudioRoutes from './dj-studio-routes.tsx';
import engineerRoutes from './engineer-routes.tsx';
import publishRoutes from './publish-routes.tsx';
import sseRoutes from './sse-routes.tsx';
import collaborationRoutes from './collaboration-routes.tsx';
import chatRoutes from './chat-routes.tsx';
import artistAnalyticsRoutes from './artist-analytics-routes.tsx';
import ogImageRoutes from './og-image-routes.tsx';
import messagingRoutes from './messaging-routes.tsx';
import waitlistRoutes from './waitlist-routes.tsx';
import marketplaceRoutes from './marketplace-routes.tsx';
import chartsRoutes from './charts-routes.tsx';
import aiChartsRoutes from './ai-charts-routes.tsx';
import production360App from './production-360-routes.tsx';
import emailCampaignsApp from './email-campaigns-routes.tsx';
import spotifyCuratorApp from './spotify-curator-routes.tsx';
import newsAgentRoutes from './news-agent-routes.tsx';
import releaseAgentRoutes from "./release-agent-routes.tsx";
import radioDigestRoutes from './radio-digest-routes.tsx';
import venueCampaignRoutes from './venue-campaign-routes.tsx';
import aiScoreRoutes from './ai-score-routes.tsx';
import catalogRoutes from './catalog-routes.tsx';
import accountDeletionRoutes from './account-deletion-routes.tsx';
import contentHealthRoutes from './content-health-routes.tsx';
import healthRoutes from './health-routes.tsx';
import adminOpsRoutes from './admin-ops-routes.tsx';
import agentsRoutes from './agents-routes.tsx';
import tracksRoutes from './tracks-routes.tsx';
import videosRoutes from './videos-routes.tsx';
import newsRoutes from './news-routes.tsx';
import donationsRoutes from './donations-routes.tsx';
import sitemapRoutes from './sitemap-routes.tsx';
import seoRoutes from './seo-routes.tsx';
import coinsRoutes from './coins-routes.tsx';
import profileRoutes from './profile-routes.tsx';
import statsRoutes from './stats-routes.tsx';
import pageviewRoutes from "./pageview-routes.tsx";
import checkoutRoutes from './checkout-routes.tsx';
import crossCabinetRoutes from "./cross-cabinet-routes.tsx";
import concertModerationRoutes from './concert-moderation-routes.tsx';
import concertAgentRoutes from "./concert-agent-routes.tsx";
import curatorRoutes from './curator-routes.tsx';
import securityMonitorRoutes from './security-monitor-routes.tsx';
import musicGenRoutes from './music-gen-routes.tsx';
import promoAirDjRoutes from "./promo-air-dj-routes.tsx";
import newsVoiceRoutes from "./news-voice-routes.tsx";
import newsBroadcastRoutes from "./news-broadcast.tsx";
import helpRoutes from "./help-routes.tsx";
import ecosystemRoutes from "./ecosystem-routes.tsx";
import { memoryRoutes } from "./memory-routes.tsx";
import { feedbackRoutes } from "./feedback-routes.tsx";
import apiDocs from "./api-docs-routes.tsx";
import { promoPipelineRoutes } from "./promo-pipeline-routes.tsx";
import { promoCheckRoutes } from "./promo-check-routes.tsx";
import consentRoutes from "./consent-routes.tsx";
import cabinetAiRoutes from "./cabinet-ai-routes.tsx";
import { classifyAndLog } from "./error-classifier.ts";
import { createLogger } from './logger.tsx';
import { requestIdMiddleware } from './request-id.tsx';

const log = createLogger('server');
import { authLimiter, uploadLimiter, apiLimiter } from './rate-limiter.tsx';
import { safeErrorMessage, scanForSqlInjection } from './security.tsx';
import { wafMiddleware, honeypotMiddleware } from './threat-detector.tsx';
import { rlsMiddleware } from './db-client.tsx';
import { startSecurityWarden } from './security-warden.tsx';
import { initSentry, sentryErrorHandler, captureError } from './sentry.tsx';
import { metricsRegistry, metricsMiddleware } from './metrics.tsx';
import weeklyReleasesRoutes from './weekly-releases-routes.tsx';
import airRoutes from "./air-routes.tsx";

// Global unhandled rejection handler (replaces Deno version)
process.on('unhandledRejection', (reason) => {
  const msg = String(reason);
  if (
    msg.includes('connection closed') ||
    msg.includes('connection reset') ||
    msg.includes('broken pipe') ||
    msg.includes('ECONNRESET')
  ) {
    return; // Suppress client disconnect errors
  }
  log.error({ err: reason }, 'unhandled_rejection');
});

// Initialize Sentry error tracking
initSentry();

const app = new Hono();

log.info('server_starting');

// Initialize Storage (creates upload directories)
initializeStorage().then(result => {
  if (result.success) {
    log.info('storage_initialized');
  }
}).catch(error => {
  log.warn({ err: error?.message }, 'storage_init_deferred');
});


// Start Security Warden (FIM, process monitor, beacon detection, kill chain correlation)
startSecurityWarden();

// Sentry error handler (captures unhandled errors)
app.use('*', sentryErrorHandler());

// WAF — threat detection (first middleware — blocks before anything else)
app.use('*', honeypotMiddleware());
app.use('*', wafMiddleware());

// Request ID
app.use('*', requestIdMiddleware());

// Logger (Hono built-in — HTTP access log)
app.use('*', honoLogger());

// RLS context — propagate JWT userId/role to database layer
app.use('*', rlsMiddleware());

// CORS
// Кодировка в JSON-ответах. Инцидент 2026-08-11: владелец нажал «Скачать» в
// письме и увидел «Р РЋР С"Р В°Р РЋ...» — Hono отдавал application/json без
// charset, и браузер читал UTF-8 как Windows-1251. Русские тексты ошибок
// превращались в мусор. Проставляем charset для всех JSON-ответов.
app.use('/*', async (c, next) => {
  await next();
  const ct = c.res.headers.get('content-type');
  if (ct && ct.startsWith('application/json') && !/charset/i.test(ct)) {
    c.res.headers.set('content-type', 'application/json; charset=utf-8');
  }
});

app.use('/*', cors({
  origin: ['https://promo-music.ru', 'https://www.promo-music.ru', 'https://admin.promo-music.ru', 'https://promofm.org', 'https://www.promofm.org'],
  // Audit B-6 (2026-05-31): X-Internal-Key убран из allowHeaders. Cron
  // вызывает endpoints server-side (localhost), browser CORS preflight
  // никогда не должен пропускать этот header — иначе XSS на allowed origin
  // мог бы trigger'ить admin-protected endpoints если получил key.
  allowHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'Cache-Control', 'Accept'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

// Prometheus metrics collection
app.use('*', metricsMiddleware());

// Body size limit (200MB for audio uploads)
app.use('*', async (c, next) => {
  const contentLength = c.req.header('content-length');
  if (contentLength && parseInt(contentLength) > 200 * 1024 * 1024) {
    return c.json({ success: false, error: 'Request body too large (max 200MB)' }, 413);
  }
  await next();
});

// Security headers (Hono-level fallback, nginx also sets these)
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
});

// Rate limiting: auth endpoints (10 req/min per IP)
app.use('/server/auth/*', authLimiter);

// Rate limiting: upload endpoints (15 req/min per IP)
app.use('/server/storage/*', uploadLimiter);

// Rate limiting: general API (200 req/min per IP)
app.use('/server/api/*', apiLimiter);

// SQL injection detection — now handled by WAF (threat-detector.tsx)


// Health check
app.get('/server/health', async (c) => {
  try {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '3.0.0-vps',
      runtime: 'node.js',
    });
  } catch (error) {
    return c.json({ status: 'degraded', timestamp: new Date().toISOString(), error: String(error) });
  }
});

// Also respond on /api/health (nginx proxied path)
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString(), version: '3.0.0-vps' }));

// Mount routes
// ── Static files: tracks & covers ──
//
// Audit 2026-06-03 (CRITICAL path traversal):
// Раньше эти три handler'а делали `'/opt/promofm-api/uploads/X/' + decodeURIComponent(rest)`
// без проверки `..`/`/` и без path.resolve+startsWith. Запрос
// `/server/uploads/tracks/..%2F..%2F..%2Fetc%2Fpasswd` → readFileSync
// возвращал /etc/passwd как audio/mpeg. Любой неавторизованный
// клиент мог прочитать любой файл, доступный пользователю node.
//
// Прим: цикл ниже (STATIC_UPLOAD_SUBDIRS, line ~300) уже имел этот
// guard для dj/venue/apk subdirs, а tracks/covers/venue-content были
// пропущены — несовместимый паттерн.
//
// Защита: один helper, тот же allowlist-стиль что и в track-download-
// helper.tsx (после PR 4ff6eb4 review-blockers).
function serveStaticFromUploads(
  c: any,
  subdir: string,
  defaultMime: string,
  mimeByExt?: Record<string, string>,
): Response | Promise<Response> {
  const prefix = `/server/uploads/${subdir}/`;
  const raw = c.req.path.replace(prefix, '');
  // Reject path-traversal markers BEFORE decode (foils %2e%2e tricks).
  if (/%2e%2e|%2f|%5c|%00/i.test(raw)) return c.text('Forbidden', 403);
  const filename = decodeURIComponent(raw);
  // Post-decode guard: ни `..` сегментов, ни абсолютных путей, ни
  // backslash (Windows-paths), ни NUL.
  if (!filename
    || filename.includes('..')
    || filename.includes('/')
    || filename.includes('\\')
    || filename.includes('\0')
    || filename.startsWith('.')) {
    return c.text('Forbidden', 403);
  }
  const root = `/opt/promofm-api/uploads/${subdir}`;
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(root, filename);
  // Belt-and-suspenders: resolved path обязан быть внутри resolvedRoot.
  if (!filePath.startsWith(resolvedRoot + path.sep)) {
    return c.text('Forbidden', 403);
  }
  if (!existsSync(filePath)) return c.text('Not found', 404);
  let mime = defaultMime;
  if (mimeByExt) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    mime = mimeByExt[ext] || defaultMime;
  }
  c.header('Content-Type', mime);
  c.header('Accept-Ranges', 'bytes');
  c.header('Cache-Control', 'public, max-age=31536000');
  c.header('Access-Control-Allow-Origin', '*');

  // HTTP Range (перемотка аудио в плеере): раньше заголовок Accept-Ranges
  // объявлялся, но Range игнорировался — браузер не мог сикнуть, админ
  // не перематывал треки на модерации. Отдаём честные 206/416 и читаем
  // с диска только запрошенный срез (не весь файл в память).
  const size = statSync(filePath).size;
  const range = c.req.header('range');
  if (range) {
    const rm = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (rm && (rm[1] !== '' || rm[2] !== '')) {
      const start = rm[1] !== '' ? parseInt(rm[1], 10) : Math.max(0, size - parseInt(rm[2], 10));
      const end = rm[1] !== '' && rm[2] !== '' ? Math.min(parseInt(rm[2], 10), size - 1) : size - 1;
      if (start >= size || start > end) {
        c.header('Content-Range', `bytes */${size}`);
        return c.body(null, 416);
      }
      const len = end - start + 1;
      const fd = openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, start);
        c.header('Content-Range', `bytes ${start}-${end}/${size}`);
        c.header('Content-Length', String(len));
        return c.body(buf, 206);
      } finally {
        closeSync(fd);
      }
    }
  }
  c.header('Content-Length', String(size));
  return c.body(readFileSync(filePath));
}

app.get('/server/uploads/tracks/*', async (c) =>
  serveStaticFromUploads(c, 'tracks', 'audio/mpeg'),
);

app.get('/server/uploads/covers/*', async (c) =>
  serveStaticFromUploads(c, 'covers', 'image/jpeg'),
);

app.get('/server/uploads/venue-content/*', async (c) =>
  serveStaticFromUploads(c, 'venue-content', 'application/octet-stream', {
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  }),
);

// DJ cabinet uploads: avatars, covers, mixes, mix covers, videos, portfolio
// Subdirs served as static files at /server/uploads/<subdir>/<filename>.
// Originally DJ-only; venue-logos joined the list when the branding
// upload endpoint shipped. Each subdir's writer is in its own routes
// module — this block is only the read/serve side.
const STATIC_UPLOAD_SUBDIRS = ['dj-avatars', 'dj-covers', 'dj-mixes', 'dj-mix-covers', 'dj-videos', 'dj-portfolio', 'venue-logos', 'apk'];
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  apk: 'application/vnd.android.package-archive',
};
for (const subdir of STATIC_UPLOAD_SUBDIRS) {
  app.get(`/server/uploads/${subdir}/*`, async (c) => {
    const filename = decodeURIComponent(c.req.path.replace(`/server/uploads/${subdir}/`, ''));
    if (filename.includes('..') || filename.includes('/')) return c.text('Forbidden', 403);
    const filePath = `/opt/promofm-api/uploads/${subdir}/${filename}`;
    if (!existsSync(filePath)) return c.text('Not found', 404);
    const file = readFileSync(filePath);
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    c.header('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
    c.header('Accept-Ranges', 'bytes');
    c.header('Cache-Control', 'public, max-age=31536000');
    c.header('Access-Control-Allow-Origin', '*');
    return c.body(file);
  });
}

app.route('/server/auth', authRoutes);
app.route("/server/api/auth", authRoutes);  // compat alias
app.route('/server/api/concerts', concertsRoutes);
app.route('/server/api/concert-moderation', concertModerationRoutes);
app.route("/server/api/concert-agent", concertAgentRoutes);
app.route('/server/notifications', notificationsRoutes);
app.route('/server/ticketing', ticketingRoutes);
app.route('/server/storage', storageRoutes);
app.route('/server/migration', migrationRoutes);
app.route('/server/marketing-campaigns', marketingCampaignsRoutes);
app.route('/server/subscriptions', subscriptionsRoutes);
app.route('/server/api/promotion', promotionRoutes);
app.route('/server/api/banners', bannerRoutes);
app.route('/server/notifications-messenger', notificationsMessengerRoutes);
app.route('/server/email', emailRoutes);
app.route('/server/tickets-system', ticketsSystemRoutes);
app.route('/server/api/chat-support', chatSupportRoutes);
app.route('/server/api/distribution', distributionRoutes);
app.route('/server/api/payments', paymentsRoutes);
app.route('/server/api/settings', settingsRoutes);
app.route('/server/api/track-test', trackTestRoutes);
app.route('/server/api/track-moderation', trackModerationRoutes);
app.route('/server/api/dj-mix-moderation', djMixModerationRoutes);
app.route('/server/api/pitching', pitchingRoutes);
app.route('/server/api/label', labelRoutes);
app.route('/server/api/booking', bookingRoutes);
app.route('/server/api/booking-public', bookingPublicRoutes);
app.route('/server/api/content-orders', contentOrdersRoutes);
app.route('/server/api/venue-radio', venueRadioApp);
app.route('/server/api/elevenlabs', elevenlabsRoutes);
app.route('/server/api/radio', radioRoutes);
app.route('/server/api/venue', venueRoutes);
app.route('/server/api/venue-zones', venueZonesRoutes);
app.route('/server/api/venue-locations', venueLocationsRoutes);
app.route('/server/api/venue-branding', venueBrandingRoutes);
app.route('/server/api/stream-player', streamPlayerRoutes);
app.route('/server/api/venue-station', venueStationRoutes);
app.route('/server/api/venue-apk', venueApkRoutes);
app.route('/server/api/venue-billing', venueBillingRoutes);
// Раньше не были смонтированы → playout-цепочка расписаний и API-токены
// заведений отдавали 404. Префиксы сверены с фронтом (venue-schedule.ts,
// venue-api-tokens.ts) и шапками самих модулей.
app.route('/server/api/venue-schedule', venueScheduleRoutes);
app.route('/server/api/venue-api/tokens', venueApiTokensApp);
app.route('/server/api/venue-public', venueApiPublicApp);
app.route('/server', promoGuideRoutes);
app.route('/server/api/ai-agent', aiAgent);
app.route('/server/api/dj-marketplace', djMarketplaceRoutes);
app.route('/server/api/artist-profile', artistProfileRoutes);
app.route('/server/api/radio-profile', radioProfileRoutes);
app.route('/server/api/landing-data', landingDataRoutes);
app.route('/server/api/producer-studio', producerStudioRoutes);
app.route('/server/api/dj-studio', djStudioRoutes);
app.route('/server/api/engineer', engineerRoutes);
app.route('/server/api/publish', publishRoutes);
app.route('/server/api/sse', sseRoutes);
app.route('/server/api/collaboration', collaborationRoutes);
app.route('/server/api/chat', chatRoutes);
app.route('/server/api/artist-analytics', artistAnalyticsRoutes);
app.route('/server/api/og-image', ogImageRoutes);
app.route('/server/api/messaging', messagingRoutes);
app.route('/server/api/waitlist', waitlistRoutes);
app.route('/server/api/marketplace', marketplaceRoutes);
app.route('/server/api/charts', chartsRoutes);
app.route('/server/api/ai-charts', aiChartsRoutes);
app.route('/server/api/production360', production360App);
app.route('/server/api/email-campaigns', emailCampaignsApp);
app.route('/server/api/spotify-curators', spotifyCuratorApp);
app.route('/server/api/news-agent', newsAgentRoutes);
app.route("/server/api/news-voice", newsVoiceRoutes);
app.route("/server/api/broadcast", newsBroadcastRoutes);
app.route("/server/api/release-agent", releaseAgentRoutes);
app.route('/server/api/radio-digest', radioDigestRoutes);
app.route('/server/api/venue-campaign', venueCampaignRoutes);
app.route('/server/api/ai-score', aiScoreRoutes);
app.route('/server/api/catalog', catalogRoutes);
app.route('/server/api/account', accountDeletionRoutes);
app.route('/server/api/content-health', contentHealthRoutes);
app.route('/server/api/admin/ops', adminOpsRoutes);
app.route('/server/api/health', healthRoutes);
app.route("/server/api/help", helpRoutes);
app.route('/server/api/agents', agentsRoutes);
app.route('/server/api/tracks', tracksRoutes);
app.route('/server/api/videos', videosRoutes);
app.route('/server/api/news', newsRoutes);
app.route('/server/api/donations', donationsRoutes);
app.route('/server/api/coins', coinsRoutes);
app.route('/server/api/profile', profileRoutes);
app.route('/server', sitemapRoutes);
app.route('/server', seoRoutes);
app.route('/server/api/stats', statsRoutes);
app.route('/server/api/analytics', pageviewRoutes);
app.route('/server/api/checkout', checkoutRoutes);
app.route("/server/api/cross-cabinet", crossCabinetRoutes);
app.route('/server/api/curator', curatorRoutes);
app.route('/server/api/security', securityMonitorRoutes);
app.route('/server/api/music-gen', musicGenRoutes);
app.route("/server/api/promo-air-dj", promoAirDjRoutes);
app.route("/server/api/ecosystem", ecosystemRoutes);
app.route("/server/api/memory", memoryRoutes);
app.route("/server/api/feedback", feedbackRoutes);
app.route("/server/api/promo-pipeline", promoPipelineRoutes);
app.route("/server/api/promo-check", promoCheckRoutes);
app.route("/server/api/consent", consentRoutes);
app.route("/server/api/cabinet-ai", cabinetAiRoutes);
app.route("/server/api/weekly-releases", weeklyReleasesRoutes);

app.route("/server/api/docs", apiDocs);
app.route("/server/api/air", airRoutes);
// Prometheus metrics endpoint (internal only)
app.get('/server/metrics', async (c) => {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey !== process.env.VPS_INTERNAL_KEY) {
    return c.text('Unauthorized', 401);
  }
  const metrics = await metricsRegistry.metrics();
  return c.text(metrics, 200, { 'Content-Type': metricsRegistry.contentType });
});

// 404
app.notFound((c) => {
  return c.json({ success: false, error: 'Route not found', path: c.req.path.replace(/[<>"'&]/g, '') }, 404);
});

// Error handler with classification
app.onError(async (err, c) => {
  const msg = String(err);
  if (msg.includes('connection closed') || msg.includes('ECONNRESET') || msg.includes('broken pipe')) {
    return new Response(null, { status: 499 });
  }
  log.error({ err, path: c.req.path }, 'server_error');
  // Classify and log error asynchronously (don't block response)
  const userId = c.req.header('X-User-Id') || undefined;
  classifyAndLog(err instanceof Error ? err : String(err), c.req.path, userId).catch(() => {});
  // Report to Sentry
  if (err instanceof Error) captureError(err, { path: c.req.path, userId });
  return c.json({ success: false, error: safeErrorMessage(err) }, 500);
});

// Start server with graceful shutdown
const port = parseInt(process.env.PORT || '3000');

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  log.info({ port: info.port }, 'server_started');
});

// Graceful shutdown: finish in-flight requests before exit
let shuttingDown = false;

function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'graceful_shutdown_start');

  // Stop accepting new connections
  server.close(() => {
    log.info('graceful_shutdown_complete');
    process.exit(0);
  });

  // Force exit after 10s if connections hang
  setTimeout(() => {
    log.warn('graceful_shutdown_timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
