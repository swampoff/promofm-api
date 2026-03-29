/**
 * BANNER ROUTES v2 — Uses typed `banner_ads` table
 * Artist CRUD + PUBLIC active banners endpoint + moderation
 */

import { Hono } from 'hono';
import * as typed from './db-typed.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const app = new Hono();

// ═══════════════════════════════════════
// PUBLIC endpoints (no auth required)
// ═══════════════════════════════════════

// GET /active — Active banners for display on the site
app.get('/active', async (c) => {
  try {
    const placement = c.req.query('placement') || undefined;
    const banners = await typed.getActiveBanners(placement);

    // Record impressions (fire and forget)
    for (const b of banners) {
      typed.updateBanner(b.id, {
        impressions: (b.impressions || 0) + 1,
      }).catch(() => {});
    }

    return c.json({ success: true, data: banners });
  } catch (error) {
    console.error('Error in GET /banners/active:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /click/:id — Record banner click
app.post('/click/:id', async (c) => {
  try {
    const bannerId = c.req.param('id');
    const banner = await typed.getBannerById(bannerId);
    if (banner) {
      await typed.updateBanner(bannerId, {
        clicks: (banner.clicks || 0) + 1,
      });
    }
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: true }); // Don't fail on click tracking
  }
});

// ═══════════════════════════════════════
// ARTIST endpoints (auth required)
// ═══════════════════════════════════════

// GET / — Get all banners for current user
app.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const banners = await typed.getBannersByUser(userId);
    return c.json({ success: true, data: banners });
  } catch (error) {
    console.error('Error in GET /banners:', error);
    return c.json({ success: true, data: [] });
  }
});

// GET /:id — Get single banner
app.get('/:id', requireAuth, async (c) => {
  try {
    const bannerId = c.req.param('id');
    if (['active', 'moderation'].includes(bannerId)) return c.notFound();
    const banner = await typed.getBannerById(bannerId);
    if (!banner) {
      return c.json({ success: false, error: 'Banner not found' }, 404);
    }
    return c.json({ success: true, data: banner });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST / — Create new banner
app.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const banner = await typed.insertBanner({
      ...body,
      user_id: userId,
      moderation_status: 'pending',
    });

    if (!banner) {
      return c.json({ success: false, error: 'Failed to create banner' }, 500);
    }

    return c.json({ success: true, data: banner }, 201);
  } catch (error) {
    console.error('Error in POST /banners:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /:id — Update banner
app.put('/:id', requireAuth, async (c) => {
  try {
    const bannerId = c.req.param('id');
    const body = await c.req.json();

    const banner = await typed.updateBanner(bannerId, body);
    if (!banner) {
      return c.json({ success: false, error: 'Banner not found' }, 404);
    }

    return c.json({ success: true, data: banner });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /:id — Delete banner
app.delete('/:id', requireAuth, async (c) => {
  try {
    const bannerId = c.req.param('id');
    await typed.deleteBanner(bannerId);
    return c.json({ success: true, message: 'Banner deleted' });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /:id/activate — Activate banner (deduct coins)
app.post('/:id/activate', requireAuth, async (c) => {
  try {
    const bannerId = c.req.param('id');
    const userId = c.get('userId');
    const body = await c.req.json();

    const banner = await typed.getBannerById(bannerId);
    if (!banner) {
      return c.json({ success: false, error: 'Banner not found' }, 404);
    }

    if (banner.moderation_status !== 'approved') {
      return c.json({ success: false, error: 'Banner must be approved before activation' }, 400);
    }

    const cost = body.cost || banner.price || 100;
    const days = body.days || banner.duration_days || 7;

    // Deduct coins
    const result = await typed.deductCoins(userId, cost, `Баннер "${banner.title}" — ${days} дней`);
    if (result && 'error' in result) {
      return c.json({ success: false, error: result.error, balance: result.balance }, 400);
    }

    // Activate
    const now = new Date();
    const endDate = new Date(now.getTime() + days * 86400000);
    await typed.updateBanner(bannerId, {
      status: 'active',
      start_date: now.toISOString(),
      end_date: endDate.toISOString(),
      coins_spent: (banner.coins_spent || 0) + cost,
    });

    return c.json({ success: true, message: 'Banner activated', coinsSpent: cost });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ═══════════════════════════════════════
// MODERATION endpoints
// ═══════════════════════════════════════

// GET /moderation/pending — Get banners for moderation
app.get('/moderation/pending', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'pending';
    const banners = await typed.getAllBannersForModeration(status === 'all' ? undefined : status);
    return c.json({ success: true, data: banners });
  } catch (error) {
    console.error('Error in GET /banners/moderation/pending:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /moderation/manage — Approve or reject banner
app.post('/moderation/manage', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { bannerId, action, moderator_notes, rejection_reason } = body;

    const banner = await typed.getBannerById(bannerId);
    if (!banner) {
      return c.json({ success: false, error: 'Banner not found' }, 404);
    }

    const now = new Date().toISOString();

    if (action === 'approve') {
      await typed.updateBanner(bannerId, {
        moderation_status: 'approved',
        moderation_comment: moderator_notes || 'Баннер одобрен',
      });

      return c.json({
        success: true,
        message: 'Баннер одобрен. Рекламодатель может активировать размещение.',
      });

    } else if (action === 'reject') {
      await typed.updateBanner(bannerId, {
        moderation_status: 'rejected',
        rejection_reason: rejection_reason || '',
        moderation_comment: moderator_notes || null,
      });

      return c.json({ success: true, message: 'Баннер отклонён' });

    } else {
      return c.json({ success: false, error: 'Invalid action' }, 400);
    }
  } catch (error) {
    console.error('Error in banner moderation:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
