import { Hono } from 'hono';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';

const donationsRoutes = new Hono();

donationsRoutes.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const donations = await db.getDonationsByArtist(userId);
    return c.json({ success: true, data: donations || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

donationsRoutes.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const donationId = `donation-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    if (!body.amount || body.amount <= 0) {
      return c.json({ success: false, error: 'Amount must be > 0' }, 400);
    }
    if (!body.artistId) {
      return c.json({ success: false, error: 'artistId required' }, 400);
    }
    const { status: _s, ...safeBody } = body;
    const donation = {
      id: donationId,
      ...safeBody,
      status: 'pending',
      artistId: body.artistId,
      donorId: userId,
      createdAt: now,
    };
    await db.createDonation(donation.artistId, donationId, donation);
    return c.json({ success: true, data: donation }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default donationsRoutes;
