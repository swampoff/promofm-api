/**
 * PromoFM API Server — Node.js + Hono
 * Entry point: replaces Supabase Edge Functions handler
 */
import 'dotenv/config';
// Security: validate critical env vars at startup
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET is missing or too short (min 32 chars). Refusing to start.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is missing. Refusing to start.');
  process.exit(1);
}

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import * as db from './db.tsx';
import { platformStatsStore, systemConfigStore } from './db.tsx';

import { initializeStorage } from './storage-setup.tsx';
import { seedDemoData } from './demo-seed.tsx';

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
import paymentsRoutes from './payments-routes.tsx';
import settingsRoutes from './settings-routes.tsx';
import trackTestRoutes from './track-test-routes.tsx';
import trackModerationRoutes from './track-moderation-routes.tsx';
import pitchingRoutes from './pitching-routes.tsx';
import bookingRoutes from './booking-routes.tsx';
import contentOrdersRoutes from './content-orders-routes.tsx';
import elevenlabsRoutes from './elevenlabs-integration.tsx';
import radioRoutes from './radio-routes.tsx';
import venueRoutes from './venue-routes.tsx';
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
import marketplaceRoutes from './marketplace-routes.tsx';
import chartsRoutes from './charts-routes.tsx';
import newsAgentRoutes from './news-agent-routes.tsx';
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
import concertModerationRoutes from './concert-moderation-routes.tsx';
import curatorRoutes from './curator-routes.tsx';
import securityMonitorRoutes from './security-monitor-routes.tsx';
import musicGenRoutes from './music-gen-routes.tsx';
import helpRoutes from "./help-routes.tsx";
import ecosystemRoutes from "./ecosystem-routes.tsx";
import { memoryRoutes } from "./memory-routes.tsx";
import { feedbackRoutes } from "./feedback-routes.tsx";
import { promoPipelineRoutes } from "./promo-pipeline-routes.tsx";
import { promoCheckRoutes } from "./promo-check-routes.tsx";
import { classifyAndLog } from "./error-classifier.ts";
import { authLimiter, uploadLimiter, apiLimiter } from './rate-limiter.tsx';
import { safeErrorMessage, scanForSqlInjection } from './security.tsx';
import { wafMiddleware, honeypotMiddleware } from './threat-detector.tsx';
import { startSecurityWarden } from './security-warden.tsx';

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
  console.error('Unhandled rejection:', reason);
});

const app = new Hono();

console.log('Starting ПРОМО.МУЗЫКА Server (Node.js)...');

// Initialize Storage (creates upload directories)
initializeStorage().then(result => {
  if (result.success) {
    console.log('Storage initialized successfully');
  }
}).catch(error => {
  console.warn('Storage initialization deferred:', error?.message);
});

// Seed demo data with retry
const seedWithRetry = async (attempt = 1, maxAttempts = 3): Promise<void> => {
  try {
    const result = await seedDemoData();
    if (result.seeded) {
      console.log(`Seed: ${result.message}`);
    } else {
      console.log(`Seed: ${result.message}`);
    }
  } catch (error: any) {
    if (attempt < maxAttempts) {
      const delay = 2000 * attempt;
      console.warn(`Seed attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return seedWithRetry(attempt + 1, maxAttempts);
    }
    console.warn('Demo seed deferred:', error?.message);
  }
};
setTimeout(() => { seedWithRetry(); }, 2000);

// Start Security Warden (FIM, process monitor, beacon detection, kill chain correlation)
startSecurityWarden();

// WAF — threat detection (first middleware — blocks before anything else)
app.use('*', honeypotMiddleware());
app.use('*', wafMiddleware());

// Logger
app.use('*', logger());

// CORS
app.use('/*', cors({
  origin: ['https://promo-music.ru', 'https://www.promo-music.ru', 'https://admin.promo-music.ru', 'http://localhost:3000', 'http://localhost:5173'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'X-Internal-Key', 'Cache-Control', 'Accept'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

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

// Mount routes — same paths as Supabase Edge Functions
app.route('/server/auth', authRoutes);
app.route('/server/api/concerts', concertsRoutes);
app.route('/server/api/concert-moderation', concertModerationRoutes);
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
app.route('/server/api/payments', paymentsRoutes);
app.route('/server/api/settings', settingsRoutes);
app.route('/server/api/track-test', trackTestRoutes);
app.route('/server/api/track-moderation', trackModerationRoutes);
app.route('/server/api/pitching', pitchingRoutes);
app.route('/server/api/booking', bookingRoutes);
app.route('/server/api/content-orders', contentOrdersRoutes);
app.route('/server/api/elevenlabs', elevenlabsRoutes);
app.route('/server/api/radio', radioRoutes);
app.route('/server/api/venue', venueRoutes);
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
app.route('/server/api/marketplace', marketplaceRoutes);
app.route('/server/api/charts', chartsRoutes);
app.route('/server/api/news-agent', newsAgentRoutes);
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
app.route('/server/api/curator', curatorRoutes);
app.route('/server/api/security', securityMonitorRoutes);
app.route('/server/api/music-gen', musicGenRoutes);
app.route("/server/api/ecosystem", ecosystemRoutes);
app.route("/server/api/memory", memoryRoutes);
app.route("/server/api/feedback", feedbackRoutes);
app.route("/server/api/promo-pipeline", promoPipelineRoutes);
app.route("/server/api/promo-check", promoCheckRoutes);

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
  console.error('Server error:', err);
  // Classify and log error asynchronously (don't block response)
  const userId = c.req.header('X-User-Id') || undefined;
  classifyAndLog(err instanceof Error ? err : String(err), c.req.path, userId).catch(() => {});
  return c.json({ success: false, error: safeErrorMessage(err) }, 500);
});

// Start server
const port = parseInt(process.env.PORT || '3000');

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`PromoFM API running on http://localhost:${info.port}`);
});

export default app;
