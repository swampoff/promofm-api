import { Hono } from 'hono';
import * as db from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { safeErrorMessage } from './security.tsx';

const donationsRoutes = new Hono();
const FALLBACK_USER = 'anonymous';

donationsRoutes.get('/', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const donations = await db.getDonationsByArtist(userId);
    return c.json({ success: true, data: donations || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

donationsRoutes.post('/', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const body = await c.req.json();
    const donationId = `donation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const donation = {
      id: donationId, status: 'completed',
      ...body,
      artistId: body.artistId || userId,
      createdAt: now,
    };
    await db.createDonation(donation.artistId, donationId, donation);
    return c.json({ success: true, data: donation }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default donationsRoutes;
