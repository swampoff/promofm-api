/**
 * VENUE PLAN LIMITS — server-side feature-gating for venue cabinet.
 *
 * Until now venue subscription plans (Старт / Бизнес / Сеть / Enterprise)
 * declared per-tier limits on the frontend (src/venue/constants/
 * subscription-plans.ts: maxPlaylists, maxTracks, analytics,
 * scheduling, multiLocation, apiAccess, customBranding) — but no
 * backend endpoint ever checked them. A free-trial venue OR a
 * trial-expired venue OR even a venue on the cheapest Старт plan
 * could create unlimited playlists, hit /analytics, schedule across
 * unlimited zones. The tiers were nominally separated by price but
 * functionally identical.
 *
 * This module is the source of truth for what a given venue profile
 * is ALLOWED to do at any moment.
 *
 *   - getEffectiveVenuePlan(profile) — resolves the venue's current
 *     entitlement-tier from subscriptionStatus + subscriptionPlan.
 *     Trial → the tier chosen before the card was attached (fallback
 *     'start'): the same tier the trial-end autocharge bills (since
 *     16.10.2026; was a flat 'business'). Cancelled keeps the tier until
 *     the paid/trial period ends. Expired / pending_card / no status →
 *     'free' (same caps as 'start', but the UI surfaces a hard «оплатите
 *     тариф» CTA instead of a Старт upsell). Active → declared plan.
 *
 *   - getEffectiveVenueLimits(profile) — returns the resolved limits.
 *
 * Numbers mirror the frontend constants in venue/constants/
 * subscription-plans.ts. If those change, sync this file (and ideally
 * extract to a shared module later — for now duplication is simpler
 * than a cross-repo import).
 *
 * '-1' in a numeric limit means «unlimited». 'libraryAccess' is a
 * three-step ladder ('basic' < 'full' < 'premium') used by the
 * catalog endpoints (not enforced in this PR; helpers ready for the
 * next iteration).
 */

import { isVenuePaidTier } from './venue-plans-constants.tsx';

export type VenuePlanId = 'free' | 'start' | 'business' | 'network' | 'enterprise';

export interface VenuePlanLimits {
  zones: number;             // -1 = unlimited
  maxPlaylists: number;       // -1 = unlimited
  maxTracks: number;          // -1 = unlimited
  libraryAccess: 'basic' | 'full' | 'premium';
  analytics: boolean;
  scheduling: boolean;
  multiLocation: boolean;
  apiAccess: boolean;
  prioritySupport: boolean;
  customBranding: boolean;
}

export const VENUE_PLAN_LIMITS: Record<VenuePlanId, VenuePlanLimits> = {
  // 'free' — implicit tier for expired trials / cancelled subscriptions.
  // Mirrors 'start' caps but marks the venue as «not paying» so the UI
  // can show a hard upgrade CTA instead of upsell language.
  free: {
    zones: 1, maxPlaylists: 5, maxTracks: 500,
    libraryAccess: 'basic',
    analytics: false, scheduling: false, multiLocation: false,
    apiAccess: false, prioritySupport: false, customBranding: false,
  },
  // 'start' — paid Старт tariff (₽4 990/мес).
  start: {
    zones: 1, maxPlaylists: 5, maxTracks: 500,
    libraryAccess: 'basic',
    analytics: false, scheduling: false, multiLocation: false,
    apiAccess: false, prioritySupport: false, customBranding: false,
  },
  // 'business' — paid Бизнес tariff (₽9 990/мес). A trialing venue gets
  // the tier it chose (see getEffectiveVenuePlan), not always this one.
  business: {
    zones: 4, maxPlaylists: 20, maxTracks: 2000,
    libraryAccess: 'full',
    analytics: true, scheduling: true, multiLocation: false,
    apiAccess: false, prioritySupport: true, customBranding: true,
  },
  // 'network' — paid Сеть tariff (₽14 990/мес).
  network: {
    zones: -1, maxPlaylists: -1, maxTracks: -1,
    libraryAccess: 'premium',
    analytics: true, scheduling: true, multiLocation: true,
    apiAccess: true, prioritySupport: true, customBranding: true,
  },
  // 'enterprise' — custom-pricing tariff. Same caps as 'network'
  // unless overridden in a per-customer flag (not modeled here).
  enterprise: {
    zones: -1, maxPlaylists: -1, maxTracks: -1,
    libraryAccess: 'premium',
    analytics: true, scheduling: true, multiLocation: true,
    apiAccess: true, prioritySupport: true, customBranding: true,
  },
};

/**
 * Resolve the venue's CURRENT entitlement-tier from its profile.
 *
 * Decision table:
 *   subscriptionStatus       subscriptionPlan         → effective plan
 *   ----------------------   ---------------------    -------------------
 *   'trial'                  start/business/network   → that plan
 *   'trial'                  anything else            → 'start'
 *   'cancelled', period end in the future             → trial: as 'trial',
 *                                                       paid: declared plan
 *   'cancelled', period over / no end date            → 'free'
 *   'active'                  business/network/etc.   → that plan
 *   'active'                  none                    → 'start'
 *   'expired'/'inactive'/'pending_card'               → 'free'
 *   undefined / unrecognised                          → 'free' (safe)
 *
 * Trial = the tier the venue picked before attaching the card (stored
 * in subscriptionPlan by the card-attach webhook, default 'start'), so
 * what the venue sees during the trial is exactly what it is charged for
 * when the trial ends (venue-billing-helpers.tsx tryAutoChargeAtTrialEnd).
 * Until 16.10.2026 trial was a flat 'business' while the autocharge
 * billed 'start' (critic A2 d).
 *
 * Cancel keeps access until the period ends (POST /venue-billing/cancel
 * keeps subscriptionExpiresAt; for a trial it equals trial_expires_at).
 * The charge-recurring cron flips it to 'expired' after that date.
 *
 * No status at all used to read as 'active' + 'start' (Старт for free,
 * no card banner) while /venue-billing/me said 'trial'. Both now say
 * pending_card / 'free' (critic A2 f).
 */
export function getEffectiveVenuePlan(profile: any, nowMs: number = Date.now()): VenuePlanId {
  if (!profile) return 'free';

  const status = String(profile.subscriptionStatus || 'pending_card').toLowerCase();
  const plan = String(profile.subscriptionPlan || '').toLowerCase();
  const trialPlan: VenuePlanId = isVenuePaidTier(plan) ? plan : 'start';

  if (status === 'trial') {
    return trialPlan;
  }

  if (status === 'cancelled') {
    const until = Date.parse(profile.subscriptionExpiresAt || profile.trial_expires_at || '');
    if (!(until > nowMs)) return 'free';
    if (profile.cancelledFromStatus === 'trial') return trialPlan;
    return plan in VENUE_PLAN_LIMITS && plan !== 'free' ? (plan as VenuePlanId) : 'free';
  }

  if (status === 'active') {
    const declared = plan || 'start';
    return declared in VENUE_PLAN_LIMITS ? (declared as VenuePlanId) : 'free';
  }

  // 'pending_card' — заведение зарегистрировалось, но карту ещё не привязало.
  // Доступа нет вовсе: пробный период (7 дней) начинается с момента привязки
  // (владелец 2026-08-07). То же для expired / inactive / неизвестных статусов.
  return 'free';
}

/**
 * Convenience — resolve the full limits object for a profile.
 */
export function getEffectiveVenueLimits(profile: any): VenuePlanLimits {
  return VENUE_PLAN_LIMITS[getEffectiveVenuePlan(profile)];
}

/**
 * Standard 403 envelope returned by any gated endpoint when a venue
 * lacks the required feature. The caller does:
 *
 *   const limits = getEffectiveVenueLimits(profile);
 *   if (!limits.analytics) return c.json(featureBlocked('analytics', profile), 403);
 *
 * The UI reads `featureRequired` and `currentPlan` to render an
 * upgrade CTA pointing at /venue/subscription.
 */
export function featureBlocked(featureRequired: string, profile: any): {
  success: false;
  error: string;
  featureRequired: string;
  currentPlan: VenuePlanId;
  upgradeRequired: true;
} {
  const currentPlan = getEffectiveVenuePlan(profile);
  return {
    success: false,
    error: `Эта функция доступна на тарифе Бизнес и выше. Текущий план: ${currentPlan}.`,
    featureRequired,
    currentPlan,
    upgradeRequired: true,
  };
}

/**
 * Standard 403 envelope for quota-exceeded (e.g. trying to create
 * the 6th playlist on a Старт plan capped at 5).
 */
export function quotaExceeded(
  resource: string,
  current: number,
  limit: number,
  profile: any,
): {
  success: false;
  error: string;
  resource: string;
  current: number;
  limit: number;
  currentPlan: VenuePlanId;
  upgradeRequired: true;
} {
  const currentPlan = getEffectiveVenuePlan(profile);
  return {
    success: false,
    error: `Достигнут лимит для тарифа ${currentPlan} (${current}/${limit}). Обновите подписку, чтобы добавить больше.`,
    resource,
    current,
    limit,
    currentPlan,
    upgradeRequired: true,
  };
}
