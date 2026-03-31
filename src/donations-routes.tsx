import { Hono } from 'hono';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';

const donationsRoutes = new Hono();

// GET /donations — list donations received by this artist
donationsRoutes.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const donations = await db.getDonationsByArtist(userId);
    return c.json({ success: true, data: donations || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// POST /donations — create a pending donation and route to payment gateway
donationsRoutes.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const donationId = `donation-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    if (!body.amount || body.amount <= 0) {
      return c.json({ success: false, error: 'Amount must be > 0' }, 400);
    }
    if (body.amount > 100000) {
      return c.json({ success: false, error: 'Max donation amount is 100000 RUB' }, 400);
    }
    if (!body.artistId) {
      return c.json({ success: false, error: 'artistId required' }, 400);
    }

    // Strip any client-sent status
    const { status: _s, ...safeBody } = body;

    const donation = {
      id: donationId,
      ...safeBody,
      status: 'pending_payment',
      artistId: body.artistId,
      donorId: userId,
      createdAt: now,
    };

    // Save donation record in pending state
    await db.createDonation(donation.artistId, donationId, donation);

    // Create checkout session for real payment
    try {
      const { getGateway } = await import('./payment-gateway.tsx');
      const { upsertPaymentSession } = await import('./db.tsx');
      const gateway = body.paymentMethod === 'sbp' ? 'tbank' : 'yookassa';
      const gw = getGateway(gateway);
      const orderId = crypto.randomUUID();
      const returnUrl = `https://promo-music.ru/cabinet/donations?payment=success&donationId=${donationId}`;
      const donorLabel = body.isAnonymous ? 'Anonymous' : (body.donorName || 'Listener');

      const result = await gw.createPayment({
        orderId,
        amount: body.amount,
        currency: 'RUB',
        description: `Donation for artist from ${donorLabel}`,
        returnUrl,
        metadata: {
          type: 'donation',
          donationId,
          artistId: body.artistId,
          donorName: donorLabel,
          isAnonymous: String(body.isAnonymous || false),
        },
      });

      await upsertPaymentSession(orderId, {
        orderId,
        userId,
        gateway,
        gatewayPaymentId: result.paymentId || result.sessionId,
        amount: body.amount,
        currency: 'RUB',
        status: 'pending',
        type: 'donation',
        description: `Donation for artist from ${donorLabel}`,
        metadata: {
          donationId,
          artistId: body.artistId,
          donorName: donorLabel,
          isAnonymous: String(body.isAnonymous || false),
        },
        savePaymentMethod: false,
        confirmationUrl: result.confirmationUrl,
        returnUrl,
        createdAt: now,
      });

      // Update donation with payment link
      donation.paymentOrderId = orderId;
      donation.status = 'pending_payment';
      await db.createDonation(donation.artistId, donationId, donation);

      return c.json({
        success: true,
        data: {
          ...donation,
          orderId,
          confirmationUrl: result.confirmationUrl,
        },
      }, 201);
    } catch (payErr: any) {
      console.error('[donations] Payment session error:', payErr);
      // If payment gateway fails, still return the pending donation
      return c.json({
        success: true,
        data: donation,
        paymentError: 'Payment gateway unavailable, donation saved as pending',
      }, 201);
    }
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default donationsRoutes;
