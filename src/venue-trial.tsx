/**
 * VENUE TRIAL — 14-day free-trial expiration mechanic.
 *
 * Closes the gap between the landing promise («14 дней бесплатно» on
 * ForVenuesPage:86,262) and the product reality discovered in the
 * audit pass: until now, when a venue created a profile, the backend
 * stamped `subscriptionStatus: 'trial'` (venue-routes.tsx:88) but
 * NOTHING ever expired it. No trial_expires_at field, no cron, no
 * gating. Trial venues kept their «Бизнес»-tier access forever, the
 * Старт/Бизнес/Сеть tariffs were effectively unreachable until a
 * venue voluntarily upgraded.
 *
 * This module owns the trial-state lifecycle:
 *
 *   1. State derivation. `getTrialState(profile)` reads
 *      `data.trial_expires_at` if set, otherwise falls back to
 *      `createdAt + 14 days` for grandfathered venues created before
 *      this PR. Returns { isTrialing, isExpired, daysRemaining,
 *      expiresAtIso, startedAtIso } — UI surfaces these in the
 *      cabinet countdown.
 *
 *   2. Expiry cron. `expireTrialsOnce()` is invoked by
 *      `POST /venue/cron/expire-trials` (auth via CRON_SECRET, same
 *      pattern as src/subscriptions-routes.tsx:819 /charge-recurring
 *      which is the canonical billing cron). For each venue profile:
 *        - status='trial' AND expires_at < now() → mark 'expired',
 *          send expiry email, fire SSE.
 *        - status='trial' AND daysRemaining ∈ (0, 3] AND no prior
 *          warning sent → send warning email, mark
 *          `data.trial_warning_sent_at`.
 *
 *   3. New profile init. `applyInitialTrial(profile)` is called from
 *      venue-routes.tsx when a fresh profile is being upserted. Sets
 *      `data.trial_expires_at` to createdAt + 14 days so we can later
 *      surface a precise countdown to the venue owner rather than
 *      reverse-deriving from createdAt every read.
 *
 * No schema migration is required: `venue_profiles.data jsonb` is
 * the existing column. Two new keys live inside `data`:
 * `trial_expires_at` and `trial_warning_sent_at`.
 */

import { pool } from './db-client.tsx';
import { emitSSE } from './sse-routes.tsx';
import { sendVenueTrialEndingEmail, sendVenueTrialExpiredEmail, sendVenueTrialLastDayEmail } from './email-helper.tsx';

export const TRIAL_PERIOD_DAYS = 14;
export const TRIAL_WARNING_DAYS = 3;
// T-1 reminder fires when daysRemaining === 1 (the last full day
// before expiry). Guarded by data.trial_last_day_sent_at so a
// re-run of the cron same day is a no-op.
export const TRIAL_LAST_DAY_DAYS = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TrialState {
  isTrialing: boolean;
  isExpired: boolean;
  daysRemaining: number;       // negative = past expiry; 0 = expires today
  expiresAtIso: string | null;
  startedAtIso: string | null;
}

/**
 * Read trial state from a venue profile.
 *
 * Prefer the explicit `data.trial_expires_at` when present (set by
 * applyInitialTrial on fresh profile creation or by backfill). For
 * grandfathered venues without that field — derive from
 * `createdAt + 14d`. If `subscriptionStatus !== 'trial'` we still
 * return computed expiry but `isTrialing=false`, so callers can
 * distinguish «not trialing» from «trialing & expired».
 */
export function getTrialState(profile: any): TrialState {
  const status = String(profile?.subscriptionStatus || '');
  const isTrialing = status === 'trial';

  const data = profile?.data || {};
  const explicitExpires = data.trial_expires_at || profile?.trial_expires_at;

  let expiresAt: Date | null = null;
  if (explicitExpires) {
    const d = new Date(explicitExpires);
    if (!Number.isNaN(d.getTime())) expiresAt = d;
  } else if (profile?.createdAt) {
    const created = new Date(profile.createdAt);
    if (!Number.isNaN(created.getTime())) {
      expiresAt = new Date(created.getTime() + TRIAL_PERIOD_DAYS * MS_PER_DAY);
    }
  }

  const now = Date.now();
  const expiresMs = expiresAt ? expiresAt.getTime() : null;
  const daysRemaining = expiresMs !== null ? Math.ceil((expiresMs - now) / MS_PER_DAY) : 0;
  const isExpired = isTrialing && expiresMs !== null && expiresMs <= now;

  return {
    isTrialing,
    isExpired,
    daysRemaining,
    expiresAtIso: expiresAt ? expiresAt.toISOString() : null,
    startedAtIso: profile?.createdAt || null,
  };
}

/**
 * Stamp the trial expiry timestamp onto a new venue profile.
 * Idempotent — won't overwrite an existing trial_expires_at, so
 * calling it repeatedly during profile upserts is safe.
 *
 * Used by venue-routes.tsx in both default-profile creation paths
 * (GET /profile fallback + PUT /profile fallback).
 */
export function applyInitialTrial<P extends Record<string, any>>(profile: P): P {
  if (!profile) return profile;
  const data = profile.data || {};
  if (data.trial_expires_at) return profile;

  const start = profile.createdAt ? new Date(profile.createdAt) : new Date();
  const validStart = !Number.isNaN(start.getTime()) ? start : new Date();
  const expiresAt = new Date(validStart.getTime() + TRIAL_PERIOD_DAYS * MS_PER_DAY);

  return {
    ...profile,
    data: {
      ...data,
      trial_expires_at: expiresAt.toISOString(),
      trial_warning_sent_at: null,
    },
  };
}

export interface CronResult {
  scanned: number;
  expired: number;
  warned: number;
  skipped: number;
  errors: Array<{ userId: string; error: string }>;
}

/**
 * One cron tick. Idempotent — `trial_warning_sent_at` guards repeat
 * warnings, `status='expired'` guards repeat expiry processing.
 *
 * Returns a counts envelope for observability — the cron-secret
 * caller (systemd timer / external scheduler) can log it.
 *
 * SQL contract (per CLAUDE.md cheat-sheet):
 *   - venue_profiles.user_id is text → no cast in WHERE/UPDATE
 *   - venue_profiles.data is jsonb; status read via data->>'subscriptionStatus'
 *   - users.id is uuid; the LEFT JOIN uses u.id::text = vp.user_id
 *     because vp.user_id is text — Postgres won't implicit-cast uuid
 *     to text on the equality predicate, must be explicit.
 */
export async function expireTrialsOnce(): Promise<CronResult> {
  const result: CronResult = { scanned: 0, expired: 0, warned: 0, skipped: 0, errors: [] };

  let trialRows: Array<{ user_id: string; data: any; email: string | null; venue_name: string; created_at: string | null }>;
  try {
    const q = await pool.query(
      `SELECT vp.user_id,
              vp.data,
              u.email                                AS email,
              COALESCE(vp.data->>'venueName', '')    AS venue_name,
              vp.data->>'createdAt'                   AS created_at
         FROM venue_profiles vp
         LEFT JOIN users u ON u.id::text = vp.user_id
        WHERE vp.data->>'subscriptionStatus' = 'trial'
        LIMIT 500`
    );
    trialRows = q.rows as any[];
  } catch (err: any) {
    console.error('[venue-trial] cron: failed to load trial profiles:', err?.message);
    throw err;
  }

  result.scanned = trialRows.length;
  const now = Date.now();

  for (const row of trialRows) {
    try {
      const state = getTrialState({
        subscriptionStatus: 'trial',
        createdAt: row.created_at,
        data: row.data,
      });

      if (state.isExpired) {
        const nextData = {
          ...row.data,
          subscriptionStatus: 'expired',
          subscriptionPlan: 'free',
          trial_ended_at: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
        await pool.query(
          `UPDATE venue_profiles
              SET data = $1::jsonb,
                  updated_at = NOW()
            WHERE user_id = $2`,
          [JSON.stringify(nextData), row.user_id]
        );
        emitSSE(row.user_id, {
          type: 'venue_trial_expired',
          data: { status: 'expired', plan: 'free' },
        });
        if (row.email) {
          await sendVenueTrialExpiredEmail({
            toEmail: row.email,
            venueName: row.venue_name || 'ваше заведение',
          }).catch((e) => console.warn('[venue-trial] expiry email failed:', e?.message));
        }
        result.expired++;
        continue;
      }

      // T-1 last-day reminder. Fires when daysRemaining === 1, with
       // its own idempotency flag so it doesn't conflict with the
       // earlier T-3 warning that may have already sent.
      if (state.isTrialing && state.daysRemaining === TRIAL_LAST_DAY_DAYS) {
        const alreadySent = !!row.data?.trial_last_day_sent_at;
        if (!alreadySent) {
          const nextData = {
            ...row.data,
            trial_last_day_sent_at: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          };
          await pool.query(
            `UPDATE venue_profiles
                SET data = $1::jsonb,
                    updated_at = NOW()
              WHERE user_id = $2`,
            [JSON.stringify(nextData), row.user_id]
          );
          if (row.email && state.expiresAtIso) {
            await sendVenueTrialLastDayEmail({
              toEmail: row.email,
              venueName: row.venue_name || 'ваше заведение',
              expiresAtIso: state.expiresAtIso,
            }).catch((e) => console.warn('[venue-trial] last-day email failed:', e?.message));
          }
          result.warned++;
          continue;
        }
      }

      if (state.isTrialing && state.daysRemaining > 0 && state.daysRemaining <= TRIAL_WARNING_DAYS) {
        const alreadyWarned = !!row.data?.trial_warning_sent_at;
        if (alreadyWarned) {
          result.skipped++;
          continue;
        }
        const nextData = {
          ...row.data,
          trial_warning_sent_at: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
        await pool.query(
          `UPDATE venue_profiles
              SET data = $1::jsonb,
                  updated_at = NOW()
            WHERE user_id = $2`,
          [JSON.stringify(nextData), row.user_id]
        );
        if (row.email && state.expiresAtIso) {
          await sendVenueTrialEndingEmail({
            toEmail: row.email,
            venueName: row.venue_name || 'ваше заведение',
            daysRemaining: state.daysRemaining,
            expiresAtIso: state.expiresAtIso,
          }).catch((e) => console.warn('[venue-trial] warning email failed:', e?.message));
        }
        result.warned++;
        continue;
      }

      result.skipped++;
    } catch (err: any) {
      console.error('[venue-trial] processing row failed for user', row.user_id, ':', err?.message);
      result.errors.push({ userId: row.user_id, error: err?.message || String(err) });
    }
  }

  console.log(`[venue-trial] cron tick: scanned=${result.scanned} expired=${result.expired} warned=${result.warned} skipped=${result.skipped} errors=${result.errors.length}`);
  return result;
}
