/**
 * VENUE-BRANDING ROUTES — custom palette / logo / chrome for Бизнес+.
 *
 * One row per venue (PK = venue_id). The venue player + future
 * embed widget read this to override default colors / logo / copy.
 *
 * Endpoints mounted at /server/api/venue-branding:
 *
 *   GET    /                  — fetch branding for the auth'd venue
 *                                (returns defaults if no row exists).
 *                                Always returns 200, never 404.
 *   PUT    /                  — upsert (gated by limits.customBranding)
 *   DELETE /                  — reset to defaults (gated)
 *   GET    /public/:venueId   — anonymous read for the embed player
 *                                (no auth, no gating — by design;
 *                                only public-safe fields exposed)
 *
 * Gating: free/start = 403 featureBlocked('customBranding') on
 * write/reset. Public read is always allowed.
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { getVenueProfile as dbGetVenueProfile } from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import {
  getEffectiveVenueLimits,
  featureBlocked,
} from './venue-plan-limits.tsx';

const app = new Hono();

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const DEFAULTS = {
  primaryColor:    '#6366f1',
  accentColor:     '#a855f7',
  backgroundColor: '#0a0a14',
  textColor:       '#ffffff',
  logoUrl:         null as string | null,
  faviconUrl:      null as string | null,
  playerTitle:     null as string | null,
  playerSubtitle:  null as string | null,
  hidePromoCredit: false,
  customCss:       null as string | null,
};

async function getUserId(c: any): Promise<string> {
  return (c as any).get('userId') || 'anonymous';
}

function parse(data: any): any {
  if (!data) return null;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data;
}

async function loadVenueProfile(userId: string): Promise<any | null> {
  const data = await dbGetVenueProfile(userId);
  return parse(data);
}

function rowToBranding(r: any, venueId: string) {
  if (!r) {
    return { venueId, ...DEFAULTS, isCustomized: false };
  }
  return {
    venueId: r.venue_id,
    userId: r.user_id,
    primaryColor:    r.primary_color,
    accentColor:     r.accent_color,
    backgroundColor: r.background_color,
    textColor:       r.text_color,
    logoUrl:         r.logo_url,
    faviconUrl:      r.favicon_url,
    playerTitle:     r.player_title,
    playerSubtitle:  r.player_subtitle,
    hidePromoCredit: r.hide_promo_credit,
    customCss:       r.custom_css,
    updatedAt:       r.updated_at,
    createdAt:       r.created_at,
    isCustomized:    true,
  };
}

function publicFields(b: any) {
  // Only colour / logo / title / favicon are exposed publicly.
  // user_id, timestamps, custom_css stay internal.
  return {
    venueId:         b.venueId,
    primaryColor:    b.primaryColor,
    accentColor:     b.accentColor,
    backgroundColor: b.backgroundColor,
    textColor:       b.textColor,
    logoUrl:         b.logoUrl,
    faviconUrl:      b.faviconUrl,
    playerTitle:     b.playerTitle,
    playerSubtitle:  b.playerSubtitle,
    hidePromoCredit: b.hidePromoCredit,
  };
}

// Validate hex + URL fields before INSERT/UPDATE so we surface
// useful error messages instead of bare CHECK-violation strings.
function validatePayload(body: any): { ok: boolean; error?: string } {
  for (const field of ['primaryColor', 'accentColor', 'backgroundColor', 'textColor']) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !HEX_RE.test(v)) {
      return { ok: false, error: `${field} must be a hex color like #6366f1 or #f00` };
    }
  }
  for (const field of ['logoUrl', 'faviconUrl']) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') return { ok: false, error: `${field} must be a string URL` };
    if (v.length > 2048) return { ok: false, error: `${field} too long (max 2048 chars)` };
    // Require http(s) or data: — block javascript: / file: schemes.
    if (!/^(https?:\/\/|data:image\/)/i.test(v)) {
      return { ok: false, error: `${field} must start with https:// or data:image/` };
    }
  }
  for (const field of ['playerTitle', 'playerSubtitle']) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') return { ok: false, error: `${field} must be a string` };
    if (v.length > 200) return { ok: false, error: `${field} too long (max 200 chars)` };
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────
// GET / — fetch branding for the auth'd venue
// ──────────────────────────────────────────────────────────────────
app.get('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, branding: { venueId: '', ...DEFAULTS, isCustomized: false }, customBrandingEnabled: false });
    }

    const limits = getEffectiveVenueLimits(profile);
    const r = await pool.query(
      `SELECT * FROM venue_branding WHERE venue_id = $1`,
      [profile.id]
    );

    return c.json({
      success: true,
      branding: rowToBranding(r.rows[0] || null, profile.id),
      customBrandingEnabled: limits.customBranding === true,
    });
  } catch (error: any) {
    console.error('GET /venue-branding:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// PUT / — upsert branding (gated by customBranding)
// ──────────────────────────────────────────────────────────────────
app.put('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);
    if (!limits.customBranding) {
      return c.json(featureBlocked('customBranding', profile), 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const v = validatePayload(body);
    if (!v.ok) return c.json({ success: false, error: v.error }, 400);

    // Resolve values: explicit field → body value, else DEFAULTS / null.
    const primaryColor    = (typeof body.primaryColor    === 'string' && body.primaryColor)    ? body.primaryColor    : DEFAULTS.primaryColor;
    const accentColor     = (typeof body.accentColor     === 'string' && body.accentColor)     ? body.accentColor     : DEFAULTS.accentColor;
    const backgroundColor = (typeof body.backgroundColor === 'string' && body.backgroundColor) ? body.backgroundColor : DEFAULTS.backgroundColor;
    const textColor       = (typeof body.textColor       === 'string' && body.textColor)       ? body.textColor       : DEFAULTS.textColor;
    const logoUrl         = body.logoUrl         === '' ? null : (body.logoUrl         ?? null);
    const faviconUrl      = body.faviconUrl      === '' ? null : (body.faviconUrl      ?? null);
    const playerTitle     = body.playerTitle     === '' ? null : (body.playerTitle     ?? null);
    const playerSubtitle  = body.playerSubtitle  === '' ? null : (body.playerSubtitle  ?? null);
    const hidePromoCredit = body.hidePromoCredit === true;

    const r = await pool.query(
      `INSERT INTO venue_branding
         (venue_id, user_id, primary_color, accent_color, background_color,
          text_color, logo_url, favicon_url, player_title, player_subtitle,
          hide_promo_credit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (venue_id) DO UPDATE
          SET primary_color     = EXCLUDED.primary_color,
              accent_color      = EXCLUDED.accent_color,
              background_color  = EXCLUDED.background_color,
              text_color        = EXCLUDED.text_color,
              logo_url          = EXCLUDED.logo_url,
              favicon_url       = EXCLUDED.favicon_url,
              player_title      = EXCLUDED.player_title,
              player_subtitle   = EXCLUDED.player_subtitle,
              hide_promo_credit = EXCLUDED.hide_promo_credit,
              updated_at        = NOW()
       RETURNING *`,
      [
        profile.id, userId, primaryColor, accentColor, backgroundColor,
        textColor, logoUrl, faviconUrl, playerTitle, playerSubtitle,
        hidePromoCredit,
      ]
    );

    return c.json({ success: true, branding: rowToBranding(r.rows[0], profile.id) });
  } catch (error: any) {
    console.error('PUT /venue-branding:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// DELETE / — reset to defaults (drop the row)
// ──────────────────────────────────────────────────────────────────
app.delete('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);
    if (!limits.customBranding) {
      return c.json(featureBlocked('customBranding', profile), 403);
    }

    await pool.query(
      `DELETE FROM venue_branding WHERE venue_id = $1 AND user_id = $2`,
      [profile.id, userId]
    );
    return c.json({
      success: true,
      branding: { venueId: profile.id, ...DEFAULTS, isCustomized: false },
    });
  } catch (error: any) {
    console.error('DELETE /venue-branding:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /public/:venueId — anonymous read for the embed player
// ──────────────────────────────────────────────────────────────────
app.get('/public/:venueId', async (c) => {
  try {
    const venueId = c.req.param('venueId');
    const r = await pool.query(
      `SELECT * FROM venue_branding WHERE venue_id = $1`,
      [venueId]
    );
    if (r.rowCount === 0) {
      // Defaults are public too — frontend can render the player
      // with sane defaults instead of failing.
      return c.json({
        success: true,
        branding: publicFields({ venueId, ...DEFAULTS, isCustomized: false }),
      });
    }
    return c.json({
      success: true,
      branding: publicFields(rowToBranding(r.rows[0], venueId)),
    });
  } catch (error: any) {
    console.error('GET /venue-branding/public/:venueId:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
