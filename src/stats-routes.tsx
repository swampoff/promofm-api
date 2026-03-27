import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import * as db from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';

const statsRoutes = new Hono();
const FALLBACK_USER = 'anonymous';

// GET /stats/dashboard
statsRoutes.get('/dashboard', requireAuth, requireAdmin, async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);

    // Aggregate from DB
    const tracks = await db.getTracksByUser(userId);
    const donations = await db.getDonationsByArtist(userId);
    const coinsBalance = await db.getCoinBalance(userId);

    const totalPlays = tracks.reduce((s: number, t: any) => s + (t.plays || 0), 0);
    const totalLikes = tracks.reduce((s: number, t: any) => s + (t.likes || 0), 0);
    const totalDownloads = tracks.reduce((s: number, t: any) => s + (t.downloads || 0), 0);
    const totalDonations = donations.reduce((s: number, d: any) => s + (d.amount || 0), 0);

    return c.json({
      success: true,
      data: {
        totalPlays,
        totalLikes,
        totalDownloads,
        tracksCount: tracks.length,
        coinsBalance: coinsBalance?.balance || 0,
        donationsCount: donations.length,
        totalDonations,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return c.json({
      success: true,
      data: {
        totalPlays: 0, totalLikes: 0, totalDownloads: 0,
        tracksCount: 0, coinsBalance: 0, donationsCount: 0, totalDonations: 0,
        updatedAt: new Date().toISOString(),
      },
    });
  }
});

export default statsRoutes;
