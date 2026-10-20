/**
 * VENUE TRIAL: free-trial expiration mechanic.
 *
 * Trial length: 7 days for trials started on/after 2026-10-16 (owner
 * decision 2026-10-16, was 14). Trials started before that date keep
 * their 14 days: an explicit `trial_expires_at` is never recomputed, and
 * the createdAt-fallback below picks the length by the start date
 * (see `trialPeriodDaysFor`). Since 2026-08-07 the trial itself starts
 * only after the venue attaches a card (checkout-routes.tsx,
 * `venue_card_attach` webhook), which stamps `trial_expires_at`.
 *
 * Closes the gap between the landing promise («N дней бесплатно» on
 * ForVenuesPage) and the product reality discovered in the
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
 *      `createdAt + trialPeriodDaysFor(createdAt)` days (14 for
 *      grandfathered venues created before 2026-10-16, 7 after).
 *      Returns { isTrialing, isExpired, daysRemaining,
 *      expiresAtIso, startedAtIso } — UI surfaces these in the
 *      cabinet countdown.
 *
 *   2. Expiry cron. `expireTrialsOnce()` is invoked by
 *      `POST /venue/cron/expire-trials` (auth via CRON_SECRET, same
 *      pattern as src/subscriptions-routes.tsx:819 /charge-recurring
 *      which is the canonical billing cron). For each venue profile:
 *        - status='trial' AND expires_at < now() → charge the chosen
 *          tier from the saved card (tryAutoChargeAtTrialEnd). Charged →
 *          'active'. No card / declined → mark 'expired', send expiry
 *          email, fire SSE. Gateway pending or a transient error → retry
 *          next run (errors for up to TRIAL_CHARGE_RETRY_MS). A trial the
 *          admin assigned (autoRenew:false) or an account that is not
 *          active (blocked, rejected, deleted, no user) is never charged:
 *          it expires (the closed account without an email).
 *        - status='trial' AND daysRemaining ∈ (0, 3] AND no prior
 *          warning sent → send warning email (with the amount and date
 *          of the first charge), mark `data.trial_warning_sent_at`.
 *      A trial cancelled in the cabinet has status 'cancelled': it is
 *      not scanned here, never charged, and expires via the
 *      charge-recurring cron once trial_expires_at passes.
 *
 *   3. New profile init. `applyInitialTrial(profile)` is called from
 *      venue-routes.tsx when a fresh profile is being upserted. Sets
 *      `data.trial_expires_at` to createdAt + trialPeriodDaysFor(createdAt)
 *      days so we can later surface a precise countdown to the venue
 *      owner rather than reverse-deriving from createdAt every read.
 *
 * No schema migration is required: `venue_profiles.data jsonb` is
 * the existing column. Two new keys live inside `data`:
 * `trial_expires_at` and `trial_warning_sent_at`.
 */

import { pool } from './db-client.tsx';
import { emitSSE } from './sse-routes.tsx';
import { sendVenueTrialEndingEmail, sendVenueTrialExpiredEmail, sendVenueTrialLastDayEmail, type TrialChargeNotice } from './email-helper.tsx';
import { siteForUserId } from './site-origin.tsx';
import { getChargeablePaymentMethod } from './db.tsx';
import { resolveVenueChargePlan, isVenueAutoRenewOff } from './venue-plans-constants.tsx';
import { isChargeableAccount, pauseVenueStreams, type TrialChargeOutcome } from './venue-billing-helpers.tsx';

// Пробный период для заведений. Владелец 2026-10-16: сокращён с 14 до 7 дней.
// 7 дней действуют только для пробных, начатых с TRIAL_7D_START_ISO; тем, кто
// начал раньше, срок не сокращаем (LEGACY_TRIAL_PERIOD_DAYS = 14).
export const TRIAL_PERIOD_DAYS = 7;
export const LEGACY_TRIAL_PERIOD_DAYS = 14;
export const TRIAL_7D_START_ISO = '2026-10-16T00:00:00+03:00';
const TRIAL_7D_START_MS = Date.parse(TRIAL_7D_START_ISO);

/**
 * Длительность пробного периода по дате его начала: до 16.10.2026 (МСК)
 * 14 дней, с 16.10.2026 7 дней. Невалидная/пустая дата = новый пробный (7).
 */
export function trialPeriodDaysFor(start: Date | string | number | null | undefined): number {
  if (start === null || start === undefined || start === '') return TRIAL_PERIOD_DAYS;
  const ms = start instanceof Date ? start.getTime() : new Date(start).getTime();
  if (Number.isNaN(ms)) return TRIAL_PERIOD_DAYS;
  return ms < TRIAL_7D_START_MS ? LEGACY_TRIAL_PERIOD_DAYS : TRIAL_PERIOD_DAYS;
}

// T-3 warning: fires once daysRemaining is in (0, 3], i.e. on the 4th-5th
// day of a 7-day trial. T-1 (below) fires at daysRemaining === 1. Each has
// its own data.*_sent_at flag, so the shorter trial needs no extra logic.
export const TRIAL_WARNING_DAYS = 3;
// T-1 reminder fires when daysRemaining === 1 (the last full day
// before expiry). Guarded by data.trial_last_day_sent_at so a
// re-run of the cron same day is a no-op.
export const TRIAL_LAST_DAY_DAYS = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Сбой при первом списании (сеть, шлюз, БД) не отключает заведение сразу:
// крон (раз в час) повторяет попытку до суток после конца пробного периода.
// Отказ карты или отсутствие карты отключают сразу.
export const TRIAL_CHARGE_RETRY_MS = MS_PER_DAY;

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
 * applyInitialTrial on fresh profile creation, by the card-attach
 * webhook or by backfill). For grandfathered venues without that field,
 * derive from `createdAt + trialPeriodDaysFor(createdAt)` (14 days for
 * venues created before 2026-10-16, 7 after). If `subscriptionStatus !== 'trial'` we still
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
      expiresAt = new Date(created.getTime() + trialPeriodDaysFor(created) * MS_PER_DAY);
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
  const expiresAt = new Date(validStart.getTime() + trialPeriodDaysFor(validStart) * MS_PER_DAY);

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
  charged: number;
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
  const result: CronResult = { scanned: 0, charged: 0, expired: 0, warned: 0, skipped: 0, errors: [] };

  // Audit 2026-06-03: cron-secret endpoint /venue/cron/expire-trials может
  // быть позван дважды конкурентно (manual + systemd-timer overlap, или
  // оператор case'ит CRON_SECRET в curl и refresh'нул). Без локa оба
  // вызова читают одинаковые row'ы → шлют дубликат writing+T-1 email'а
  // venue, плюс могут оба пытаться tryAutoChargeAtTrialEnd (двойное
  // списание с карты). Postgres advisory lock — лучший lightweight guard:
  // session-scoped, освобождается на pool client release / disconnect,
  // не требует таблиц/чистки. Конкурент видит got=false, выходит чисто.
  // Key 770451 произвольный, уникален в рамках проекта (см. friday.js
  // 924173 для другого cron'а).
  const lockClient = await pool.connect();
  try {
    const lockRes = await lockClient.query('SELECT pg_try_advisory_lock(770451) AS got');
    if (!lockRes.rows[0].got) {
      console.log('[venue-trial] cron: another instance is running, skipping tick.');
      lockClient.release();
      return result;
    }
  } catch (err) {
    lockClient.release();
    throw err;
  }

  let trialRows: Array<{ user_id: string; data: any; email: string | null; venue_name: string; created_at: string | null; account_status: string | null; user_deleted: boolean | null }>;
  try {
    const q = await pool.query(
      `SELECT vp.user_id,
              vp.data,
              u.email                                AS email,
              COALESCE(vp.data->>'venueName', '')    AS venue_name,
              vp.data->>'createdAt'                   AS created_at,
              u.status::text                          AS account_status,
              (u.deleted_at IS NOT NULL)              AS user_deleted
         FROM venue_profiles vp
         LEFT JOIN users u ON u.id::text = vp.user_id
        WHERE vp.data->>'subscriptionStatus' = 'trial'
        LIMIT 500`
    );
    trialRows = q.rows as any[];
  } catch (err: any) {
    console.error('[venue-trial] cron: failed to load trial profiles:', err?.message);
    await lockClient.query('SELECT pg_advisory_unlock(770451)').catch(() => {});
    lockClient.release();
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

      // Заблокированный, отклонённый, удалённый аккаунт или строка без
      // пользователя: не списываем и не пишем, срок просто истекает.
      const chargeable = isChargeableAccount(row);

      if (state.isExpired) {
        // Первое списание выбранного тарифа с карты, привязанной при старте
        // пробного (POST /venue-billing/attach-card). Вся цепочка списание →
        // активация → выручка в venue-billing-helpers.tsx.
        let outcome: TrialChargeOutcome = 'error';
        if (chargeable) {
          try {
            const { tryAutoChargeAtTrialEnd } = await import('./venue-billing-helpers.tsx');
            outcome = await tryAutoChargeAtTrialEnd(row.user_id, row.data, { email: row.email, trialEndIso: state.expiresAtIso });
          } catch (e: any) {
            console.warn('[venue-trial] auto-charge attempt failed for', row.user_id, ':', e?.message);
          }
        }

        if (outcome === 'charged') {
          // venue-billing-helpers already wrote the new state
          // (subscriptionStatus='active', new period, SSE).
          result.charged++;
          continue;
        }
        if (outcome === 'not_trial' || outcome === 'pending') {
          // Отменили / оплатили за это время, или платёж ждёт вебхук шлюза.
          result.skipped++;
          continue;
        }
        if (outcome === 'error' && chargeable) {
          const endedMs = state.expiresAtIso ? Date.parse(state.expiresAtIso) : now;
          if (now - endedMs < TRIAL_CHARGE_RETRY_MS) {
            result.skipped++;
            continue;
          }
        }

        // No card, card declined, admin trial without autorenew, account
        // closed, or still failing a day after the trial ended → mark
        // expired, revoke bearer tokens, pause streams, email.
        const reason = !chargeable ? 'account_closed'
          : outcome === 'no_card' ? 'no_card'
          : outcome === 'not_renewing' ? 'not_renewed'
          : 'charge_failed';
        // Только поля истечения поверх текущей строки и только пока она ещё
        // trial: отмена или оплата, сделанные во время прогона (письма, запросы
        // к шлюзу по другим строкам), не затираются копией из начала прогона.
        const upd = await pool.query(
          `UPDATE venue_profiles
              SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
                  updated_at = NOW()
            WHERE user_id = $2 AND data->>'subscriptionStatus' = 'trial'`,
          [JSON.stringify({
            subscriptionStatus: 'expired',
            subscriptionPlan: 'free',
            subscriptionExpiredReason: reason,
            trial_ended_at: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          }), row.user_id]
        );
        if (!upd.rowCount) {
          result.skipped++;
          continue;
        }

        // Revoke bearer tokens — APK gets 401 on next poll, stops
        // playing. Pause streams so admin UI shows the right state
        // (not while a station subscription is paid, pauseVenueStreams).
        await pool.query(
          `UPDATE venue_api_tokens SET revoked_at = NOW()
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [row.user_id]
        ).catch((e) => console.warn('[venue-trial] token revoke failed:', e?.message));
        await pauseVenueStreams(row.user_id)
          .catch((e) => console.warn('[venue-trial] stream pause failed:', e?.message));

        emitSSE(row.user_id, {
          type: 'venue_trial_expired',
          data: { status: 'expired', plan: 'free', reason },
        });
        // Закрытому аккаунту письмо «оформите подписку» не шлём: войти он не может.
        if (row.email && reason !== 'account_closed') {
          await sendVenueTrialExpiredEmail({
            toEmail: row.email,
            venueName: row.venue_name || 'ваше заведение',
            site: await siteForUserId(row.user_id),
            reason,
          }).catch((e) => console.warn('[venue-trial] expiry email failed:', e?.message));
        }
        result.expired++;
        continue;
      }

      // Закрытому аккаунту напоминания о списании не шлём.
      if (!chargeable) {
        result.skipped++;
        continue;
      }

      // Сумма и дата первого списания для напоминаний T-3 / T-1. Карта может
      // не сохраниться (cardSaveFailed): тогда письмо просит оформить подписку.
      // (Тот же отбор, что у веток ниже: T-1 в последний день, T-3 если ещё не уходило.)
      const remindersDone = state.daysRemaining === TRIAL_LAST_DAY_DAYS
        ? !!(row.data?.trial_last_day_sent_at && row.data?.trial_warning_sent_at)
        : !!row.data?.trial_warning_sent_at;
      const remindNow = state.isTrialing && !!state.expiresAtIso && !remindersDone
        && state.daysRemaining > 0 && state.daysRemaining <= TRIAL_WARNING_DAYS;
      // Пробный от админа без автопродления: обещать списание нельзя, письмо
      // уходит в прежнем общем виде (без суммы и даты).
      let charge: TrialChargeNotice | undefined;
      // Без автопродления письмо говорит правду: списания не будет, по окончании
      // эфир приостановится (раньше уходил старый текст про бесплатный режим).
      const noAutoRenew = isVenueAutoRenewOff(row.data);
      if (remindNow && !noAutoRenew) {
        const plan = resolveVenueChargePlan(row.data);
        const hasCard = !!(await getChargeablePaymentMethod(row.user_id));
        charge = { amountRub: plan.amount, planName: plan.name, interval: plan.interval, atIso: state.expiresAtIso as string, hasCard };
      }

      // T-1 last-day reminder. Fires when daysRemaining === 1, with
       // its own idempotency flag so it doesn't conflict with the
       // earlier T-3 warning that may have already sent.
      if (state.isTrialing && state.daysRemaining === TRIAL_LAST_DAY_DAYS) {
        const alreadySent = !!row.data?.trial_last_day_sent_at;
        if (!alreadySent) {
          await pool.query(
            `UPDATE venue_profiles
                SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
                    updated_at = NOW()
              WHERE user_id = $2`,
            [JSON.stringify({ trial_last_day_sent_at: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }), row.user_id]
          );
          if (row.email && state.expiresAtIso) {
            await sendVenueTrialLastDayEmail({
              toEmail: row.email,
              venueName: row.venue_name || 'ваше заведение',
              expiresAtIso: state.expiresAtIso,
              site: await siteForUserId(row.user_id),
              charge,
              noAutoRenew,
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
        await pool.query(
          `UPDATE venue_profiles
              SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
                  updated_at = NOW()
            WHERE user_id = $2`,
          [JSON.stringify({ trial_warning_sent_at: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }), row.user_id]
        );
        if (row.email && state.expiresAtIso) {
          await sendVenueTrialEndingEmail({
            toEmail: row.email,
            venueName: row.venue_name || 'ваше заведение',
            daysRemaining: state.daysRemaining,
            expiresAtIso: state.expiresAtIso,
            site: await siteForUserId(row.user_id),
            charge,
            noAutoRenew,
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

  console.log(`[venue-trial] cron tick: scanned=${result.scanned} charged=${result.charged} expired=${result.expired} warned=${result.warned} skipped=${result.skipped} errors=${result.errors.length}`);
  await lockClient.query('SELECT pg_advisory_unlock(770451)').catch(() => {});
  lockClient.release();
  return result;
}
