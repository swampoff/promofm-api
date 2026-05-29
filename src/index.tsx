import { Hono } from 'npm:hono@4';
import { cors } from 'npm:hono/cors';
import { logger } from 'npm:hono/logger';
import * as db from './db.tsx';
import { getPlatformStats, setPlatformStats, getSystemConfig } from './db.tsx';

import { getLLMStatus } from "./llm-router.tsx";

import { initializeStorage } from "./storage-setup.tsx";
import { seedDemoData } from "./demo-seed.tsx";

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
import production360Routes from './production-360-routes.tsx';
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
import concertAgentRoutes from './concert-agent-routes.tsx';
import releaseAgentRoutes from "./release-agent-routes.tsx";
import contentHealthRoutes from './content-health-routes.tsx';
import curatorRoutes from './curator-routes.tsx';
import agentsRoutes from './agents-routes.tsx';
import tracksRoutes from './tracks-routes.tsx';
import videosRoutes from './videos-routes.tsx';
import newsRoutes from './news-routes.tsx';
import donationsRoutes from './donations-routes.tsx';
import coinsRoutes from './coins-routes.tsx';
import profileRoutes from './profile-routes.tsx';
import statsRoutes from './stats-routes.tsx';
import analyticsRoutes from './analytics-routes.tsx';
import checkoutRoutes from './checkout-routes.tsx';
import pipelineApiRoutes from './pipeline-api-routes.tsx';
import weeklyReleasesRoutes from './weekly-releases-routes.tsx';
import { feedbackRoutes } from './feedback-routes.tsx';

// ── Global suppression of Deno HTTP runtime errors ──
// "Http: connection closed before message completed" fires as an unhandled
// promise rejection from `respondWith` when a ReadableStream body (SSE) is
// being written but the client has already disconnected.  Neither Hono's
// onError nor Deno.serve's onError can catch these because they originate
// AFTER the handler returned the Response object – during the response body
// streaming phase inside the Deno runtime.
globalThis.addEventListener('unhandledrejection', (e) => {
  const msg = String(e.reason);
  if (
    msg.includes('connection closed') ||
    msg.includes('connection reset') ||
    msg.includes('broken pipe') ||
    msg.includes('Http') ||
    msg.includes('respondWith') ||
    msg.includes('error sending request')
  ) {
    e.preventDefault();
    return;
  }
});

const app = new Hono();

// Initialize Storage and Demo Data on server start
console.log('Starting ПРОМО.МУЗЫКА Server...');

// 1. Initialize Storage
initializeStorage().then(result => {
  if (result.success) {
    console.log('Storage initialized successfully');
    if (result.bucketsCreated.length > 0) {
      console.log('Buckets created:', result.bucketsCreated.join(', '));
    } else {
      console.log('Storage ready (buckets exist or deferred)');
    }
  } else {
    if (result.errors.length > 0) {
      console.warn('Storage initialization had issues:', result.errors);
    } else {
      console.log('Storage initialized (all buckets already exist)');
    }
  }
}).catch(error => {
  console.warn('Storage initialization deferred:', error?.message || 'Unknown error');
});

// 2. Seed demo data (idempotent - only runs once per seed version)
const seedWithRetry = async (attempt = 1, maxAttempts = 8): Promise<void> => {
  try {
    const result = await seedDemoData();
    if (result.seeded) {
      console.log(`Seed: ${result.message}`);
    } else if (result.message && (result.message.includes('Connection reset') || result.message.includes('connection') || result.message.includes('sending request') || result.message.includes('fetch failed') || result.message.includes('client error') || result.message.includes('SendRequest'))) {
      // seedDemoData catches errors internally and returns them as messages - retry on transient network errors
      if (attempt < maxAttempts) {
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
        console.warn(`Seed attempt ${attempt}/${maxAttempts} failed (transient network error), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        return seedWithRetry(attempt + 1, maxAttempts);
      }
      console.warn('Demo seed deferred after max retries:', result.message);
    } else {
      console.log(`Seed: ${result.message}`);
    }
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (attempt < maxAttempts && (msg.includes('Connection reset') || msg.includes('connection') || msg.includes('fetch') || msg.includes('sending request') || msg.includes('client error') || msg.includes('SendRequest'))) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
      console.warn(`Seed attempt ${attempt}/${maxAttempts} threw (${msg.slice(0, 80)}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return seedWithRetry(attempt + 1, maxAttempts);
    }
    console.warn('Demo seed deferred:', msg);
  }
};

// Delay initial seed by 3s to let connections warm up
setTimeout(() => { seedWithRetry(); }, 3000);

// Enable logger
app.use('*', logger(console.log));

// Enable CORS for all routes and methods
app.use(
  "/*",
  cors({
    origin: ["https://promofm.org", "https://www.promofm.org", "http://localhost:3000", "http://localhost:5173"],
    allowHeaders: ["Content-Type", "Authorization", "X-User-Id", "X-Internal-Key", "Cache-Control", "Accept"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  }),
);

// Health check endpoint
app.get("/server/health", async (c) => {
  try {
    const seedStatus = await getSystemConfig('system:demo_seed_v20');
    const platformStats = await getPlatformStats('platform');

    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: "2.4.0",
      services: {
        kv: seedStatus ? 'connected' : 'empty',
        demoData: seedStatus ? 'seeded' : 'pending',
        platformStats: platformStats ? 'available' : 'unavailable',
        llm: getLLMStatus(),
      },
    });
  } catch (error) {
    return c.json({
      status: "degraded",
      timestamp: new Date().toISOString(),
      error: String(error),
    });
  }
});

// Mount auth routes
app.route("/server/auth", authRoutes);

// Mount concerts routes
app.route("/server/api/concerts", concertsRoutes);

// Mount notifications routes
app.route("/server/notifications", notificationsRoutes);

// Mount ticketing routes
app.route("/server/ticketing", ticketingRoutes);

// Mount storage routes
app.route("/server/storage", storageRoutes);

// Mount migration routes
app.route("/server/migration", migrationRoutes);

// Mount marketing campaigns routes
app.route("/server/marketing-campaigns", marketingCampaignsRoutes);

// Mount subscriptions routes
app.route("/server/subscriptions", subscriptionsRoutes);

// Mount promotion routes
app.route("/server/api/promotion", promotionRoutes);

// Mount banner routes
app.route("/server/api/banners", bannerRoutes);

// Mount notifications & messenger routes
app.route("/server/notifications-messenger", notificationsMessengerRoutes);

// Mount email routes
app.route("/server/email", emailRoutes);

// Mount tickets system routes
app.route("/server/tickets-system", ticketsSystemRoutes);

// Mount payments routes
app.route("/server/api/payments", paymentsRoutes);

// Mount settings routes
app.route("/server/api/settings", settingsRoutes);

// Mount track test routes
app.route("/server/api/track-test", trackTestRoutes);

// Mount track moderation routes
app.route("/server/api/track-moderation", trackModerationRoutes);

// Mount pitching routes
app.route("/server/api/pitching", pitchingRoutes);

// Mount booking routes
app.route("/server/api/booking", bookingRoutes);

// Mount content orders routes
app.route("/server/api/content-orders", contentOrdersRoutes);

// Mount audio branding routes

// Mount 360° production routes
app.route("/server/api/production360", production360Routes);

// Mount elevenlabs routes
app.route("/server/api/elevenlabs", elevenlabsRoutes);

// Mount radio routes
app.route("/server/api/radio", radioRoutes);

// Mount venue routes
app.route("/server/api/venue", venueRoutes);

// Mount promo guide PUBLIC routes
app.route("/server", promoGuideRoutes);

// Mount News Pipeline (formerly AI agent)
app.route("/server/api/ai-agent", aiAgent);

// Mount DJ Marketplace
app.route("/server/api/dj-marketplace", djMarketplaceRoutes);
app.route("/server/api/feedback", feedbackRoutes);

// Mount Artist Profile
app.route("/server/api/artist-profile", artistProfileRoutes);

// Mount Radio Profile
app.route("/server/api/radio-profile", radioProfileRoutes);

// Mount Landing Data
app.route("/server/api/landing-data", landingDataRoutes);

// Mount Producer Studio
app.route("/server/api/producer-studio", producerStudioRoutes);

// Mount DJ Studio
app.route("/server/api/dj-studio", djStudioRoutes);

// Mount Publish Routes
app.route("/server/api/publish", publishRoutes);

// Mount SSE Routes
app.route("/server/api/sse", sseRoutes);

// Mount Collaboration Routes
app.route("/server/api/collaboration", collaborationRoutes);

// Mount Chat Routes
app.route("/server/api/chat", chatRoutes);

// Mount Artist Analytics Routes
app.route("/server/api/artist-analytics", artistAnalyticsRoutes);

// Mount OG Image Routes
app.route("/server/api/og-image", ogImageRoutes);

// Mount Messaging Routes (before catch-all /api)
app.route("/server/api/messaging", messagingRoutes);
app.route("/server/api/waitlist", waitlistRoutes);

// Mount Marketplace Routes (beats & services)
app.route("/server/api/marketplace", marketplaceRoutes);

// Mount Charts Aggregation Routes
app.route("/server/api/charts", chartsRoutes);

// Mount News Agent Routes
app.route("/server/api/news-agent", newsAgentRoutes);

// Mount Concert Agent Routes
app.route("/server/api/concert-agent", concertAgentRoutes);
app.route("/server/api/release-agent", releaseAgentRoutes);

// Mount Content Health Routes
app.route("/server/api/content-health", contentHealthRoutes);

// Mount Curator Agents Routes
app.route("/server/api/curator", curatorRoutes);

// Mount Agents Routes
app.route("/server/api/agents", agentsRoutes);

// Mount basic artist CRUD routes (from api.ts frontend)
app.route("/server/api/tracks", tracksRoutes);
app.route("/server/api/videos", videosRoutes);
app.route("/server/api/news", newsRoutes);
app.route("/server/api/donations", donationsRoutes);
app.route("/server/api/coins", coinsRoutes);
app.route("/server/api/profile", profileRoutes);
app.route("/server/api/stats", statsRoutes);
app.route("/server/api/analytics", analyticsRoutes);

// Mount Checkout / Payment gateway routes
app.route("/server/api/checkout", checkoutRoutes);

// Pipeline engine — audit, analytics, SLA, transitions
app.route("/server/api/pipeline", pipelineApiRoutes);
app.route("/server/api/weekly-releases", weeklyReleasesRoutes);

// 404 handler
app.notFound((c) => {
  const path = c.req.path;
  const method = c.req.method;
  console.warn(`Route not found: ${method} ${path}`);
  return c.json({ 
    success: false, 
    error: "Route not found",
    path,
    method,
  }, 404);
});

// Error handler
app.onError((err, c) => {
  const msg = String(err);
  // Suppress SSE / client disconnect errors — connection is already dead,
  // attempting c.json() would throw again.
  if (
    msg.includes('connection closed') ||
    msg.includes('connection reset') ||
    msg.includes('broken pipe') ||
    msg.includes('Http')
  ) {
    // Return a minimal response; Deno may not be able to deliver it, and that's fine.
    return new Response(null, { status: 499 });
  }
  console.error('Server error:', err);
  try {
    return c.json({
      success: false,
      error: err.message || "Internal server error"
    }, 500);
  } catch {
    // If c.json itself fails (closed connection), return a plain response
    return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

// Wrap app.fetch so Deno-level "connection closed" errors are silenced
// instead of crashing the process. This is the ONLY reliable catch point
// for errors thrown by the HTTP runtime after the client disconnects.
Deno.serve({
  // onError handles BOTH handler-thrown errors AND respondWith (response
  // streaming) errors.  When the client disconnects while a ReadableStream
  // body (e.g. SSE) is being written, the Deno runtime calls onError with
  // the "Http: connection closed before message completed" error.  Returning
  // a simple Response here suppresses the noisy console stacktrace.
  onError(err: unknown): Response {
    const msg = String(err);
    // Client-disconnect / SSE abort — suppress silently
    if (
      msg.includes('connection closed') ||
      msg.includes('connection reset') ||
      msg.includes('broken pipe') ||
      msg.includes('Http') ||
      msg.includes('respondWith')
    ) {
      return new Response(null, { status: 499 });
    }
    console.error('Deno.serve onError:', msg);
    return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  },
}, async (req: Request, info: Deno.ServeHandlerInfo) => {
  try {
    return await app.fetch(req, info);
  } catch (err: unknown) {
    const msg = String(err);
    // Normal SSE / navigation disconnect — suppress silently
    if (
      msg.includes('connection closed') ||
      msg.includes('connection reset') ||
      msg.includes('broken pipe') ||
      msg.includes('Http') ||
      msg.includes('respondWith')
    ) {
      return new Response(null, { status: 499 });
    }
    console.error('Unhandled request error:', msg);
    return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});