/**
 * PromoFM API Server — Node.js + Hono
 * Entry point for the VPS-hosted backend.
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
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
import { platformStatsStore, systemConfigStore } from './db.tsx';

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
import pitchingRoutes from './pitching-routes.tsx';
import labelRoutes from './label-routes.tsx';
import bookingRoutes from './booking-routes.tsx';
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
import promoGuideRoutes from './promo-guide-routes.tsx';
import aiAgent from './ai-agent.ts';
import djMarketplaceRoutes from './dj-marketplace-routes.tsx';
import artistProfileRoutes from './artist-profile-routes.tsx';
import radioProfileRoutes from './radio-profile-routes.tsx';
import landingDataRoutes from './landing-data-routes.tsx';
import producerStudioRoutes from './producer-studio-routes.tsx';
import djStudioRoutes from './dj-studio-routes.tsx';
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
import newsAgentRoutes from './news-agent-routes.tsx';
import releaseAgentRoutes from "./release-agent-routes.tsx";
import contentHealthRoutes from './content-health-routes.tsx';
import healthRoutes from './health-routes.tsx';
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
import analyticsRoutes from './analytics-routes.tsx';
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
app.use('/*', cors({
  origin: ['https://promo-music.ru', 'https://www.promo-music.ru', 'https://admin.promo-music.ru', 'https://promofm.org', 'https://www.promofm.org'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'X-Internal-Key', 'Cache-Control', 'Accept'],
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
app.get('/server/uploads/tracks/*', async (c) => {
  const filename = decodeURIComponent(c.req.path.replace('/server/uploads/tracks/', ''));
  const filePath = '/opt/promofm-api/uploads/tracks/' + filename;
  try {
    if (!existsSync(filePath)) return c.text('Not found', 404);
    const file = readFileSync(filePath);
    c.header('Content-Type', 'audio/mpeg');
    c.header('Accept-Ranges', 'bytes');
    c.header('Cache-Control', 'public, max-age=31536000');
    c.header('Access-Control-Allow-Origin', '*');
    return c.body(file);
  } catch { return c.text('Not found', 404); }
});

app.get('/server/uploads/covers/*', async (c) => {
  const filename = decodeURIComponent(c.req.path.replace('/server/uploads/covers/', ''));
  const filePath = '/opt/promofm-api/uploads/covers/' + filename;
  try {
    if (!existsSync(filePath)) return c.text('Not found', 404);
    const file = readFileSync(filePath);
    c.header('Content-Type', 'image/jpeg');
    c.header('Cache-Control', 'public, max-age=31536000');
    c.header('Access-Control-Allow-Origin', '*');
    return c.body(file);
  } catch { return c.text('Not found', 404); }
});

app.get('/server/uploads/venue-content/*', async (c) => {
  const filename = decodeURIComponent(c.req.path.replace('/server/uploads/venue-content/', ''));
  const filePath = '/opt/promofm-api/uploads/venue-content/' + filename;
  const fs = await import('node:fs');
  if (!fs.existsSync(filePath)) return c.json({ error: 'not found' }, 404);
  const data = fs.readFileSync(filePath);
  const ext = filename.split('.').pop()?.toLowerCase() || 'mp3';
  const types: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };
  return new Response(data, { headers: { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' } });
});

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
app.route('/server/api/pitching', pitchingRoutes);
app.route('/server/api/label', labelRoutes);
app.route('/server/api/booking', bookingRoutes);
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
app.route('/server', promoGuideRoutes);
app.route('/server/api/ai-agent', aiAgent);
app.route('/server/api/dj-marketplace', djMarketplaceRoutes);
app.route('/server/api/artist-profile', artistProfileRoutes);
app.route('/server/api/radio-profile', radioProfileRoutes);
app.route('/server/api/landing-data', landingDataRoutes);
app.route('/server/api/producer-studio', producerStudioRoutes);
app.route('/server/api/dj-studio', djStudioRoutes);
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
app.route('/server/api/news-agent', newsAgentRoutes);
app.route("/server/api/news-voice", newsVoiceRoutes);
app.route("/server/api/broadcast", newsBroadcastRoutes);
app.route("/server/api/release-agent", releaseAgentRoutes);
app.route('/server/api/content-health', contentHealthRoutes);
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
app.route('/server/api/analytics', analyticsRoutes);
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
