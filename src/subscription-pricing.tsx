/**
 * SUBSCRIPTION-PRICING — applies subscriber-tier discounts to one-off
 * charges (pitching submissions, track-test orders, banner purchases).
 *
 * Why this exists: SUBSCRIPTION_PLANS in subscriptions-routes.tsx has
 * declared per-tier discount percentages — 5/10/15% on pitching,
 * 5/15/25% on marketing, 0/10/20% on track_test, 5/10/15% on banners
 * — since the subscription tiers were first published on the landing.
 * The discounts were displayed in the pricing matrix as a key reason
 * to upgrade from Spark to Start/Pro/Elite. But none of the charging
 * routes ever read `SUBSCRIPTION_PLANS[tier].discounts` — every site
 * pulled `price_rub` / `payment_amount` / `banner.price` directly,
 * so an Elite subscriber paying 149 990 ₽/month was charged the same
 * pitching/test/banner prices as a free Spark user.
 *
 * Honeymoon for that mismatch: this helper. Every paid service site
 * calls applySubscriptionDiscount(userId, category, basePrice) before
 * creating the payment session, gets back the discounted amount, and
 * passes that to the gateway + persists both basePrice and finalPrice
 * on the submission record for accounting/audit.
 *
 * Failure mode: any error (missing user_id, no active subscription,
 * DB hiccup, unknown tier, unknown category) returns the base price
 * with discount=0. We never accidentally GIVE a discount that the
 * subscription doesn't entitle to — undercharging silently is worse
 * than charging full price and letting the customer raise a ticket.
 */

import { pool } from './db-client.tsx';
import { SUBSCRIPTION_PLANS } from './subscriptions-routes.tsx';

export type DiscountCategory = 'pitching' | 'marketing' | 'track_test' | 'banners';

export interface PricingResult {
  basePrice: number;
  finalPrice: number;
  discount: number;         // 0..1 (e.g. 0.10 for a 10% discount)
  tier: string | null;       // 'spark' | 'start' | 'pro' | 'elite' | null
  discountApplied: boolean;
}

/**
 * Look up the active subscription for `userId` and return the price
 * for `category` after applying that tier's declared discount.
 */
export async function applySubscriptionDiscount(
  userId: string | null | undefined,
  category: DiscountCategory,
  basePrice: number,
): Promise<PricingResult> {
  const fallback: PricingResult = {
    basePrice,
    finalPrice: basePrice,
    discount: 0,
    tier: null,
    discountApplied: false,
  };
  if (!userId) return fallback;
  if (!Number.isFinite(basePrice) || basePrice <= 0) return fallback;

  try {
    const r = await pool.query(
      `SELECT data FROM subscriptions WHERE user_id = $1
       ORDER BY (data->>'updated_at') DESC NULLS LAST, (data->>'created_at') DESC NULLS LAST
       LIMIT 1`,
      [userId],
    );
    if (r.rows.length === 0) return fallback;
    const raw = r.rows[0].data;
    const sub: any = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!sub) return fallback;

    // Active = ('active' or 'trial') AND (no expires_at, or not yet expired)
    if (sub.status !== 'active' && sub.status !== 'trial') return fallback;
    if (sub.expires_at) {
      const expires = new Date(sub.expires_at).getTime();
      if (Number.isFinite(expires) && expires < Date.now()) return fallback;
    }

    const tier = String(sub.tier || sub.planId || '').toLowerCase();
    const plan = (SUBSCRIPTION_PLANS as any)[tier];
    if (!plan?.discounts) return { ...fallback, tier: tier || null };

    const discount = Number(plan.discounts[category]) || 0;
    if (discount <= 0) {
      return { ...fallback, tier };
    }

    const finalPrice = Math.max(0, Math.round(basePrice * (1 - discount)));
    return {
      basePrice,
      finalPrice,
      discount,
      tier,
      discountApplied: true,
    };
  } catch (err: any) {
    console.warn('[subscription-pricing] applySubscriptionDiscount failed:', err?.message);
    return fallback;
  }
}
