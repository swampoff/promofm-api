# PROMO.AIR on promoair.ru: backend changes

promoair.ru runs on the same API, database, sessions and YooKassa shop as promo-music.ru. Each backend agent in the chain appends its own section below. The binding spec is `~/Projects/promoair/notes/PLAN.md`.

---

## 1. DOMAIN: host-aware origins (16.10.2026)

**Goal.** Emails, redirects and YooKassa return URLs lead to the site the request came from (or the site the user registered on), and nothing changes until `PROMOAIR_ORIGIN` is set.

### New env var

| Var | Value | Effect |
|---|---|---|
| `PROMOAIR_ORIGIN` | `https://promoair.ru` (or `https://www.promoair.ru`) | Turns PROMO.AIR on: promoair.ru joins CORS, return-URL, VK and redirect allowlists; links and emails can point to promoair.ru. **Empty/unset = today's behaviour.** Any other value (http, a foreign host, a port) is rejected with a warning in the log and the gate stays off. Set it only after promoair.ru answers over HTTPS (DNS + certificate). |

### What changed

- **`src/site-origin.tsx` (new).** The single source of truth.
  - `SiteKey = 'music' | 'air'`.
  - Allowlist: promo-music.ru, www, admin, promofm.org (+www), promofm.ru (+www); promoair.ru and www join only while the gate is on. Lookups go through a `Map`, so header values like `constructor` match nothing.
  - Exports: `ALLOWED_ORIGINS`, `ALLOWED_HOSTS`, `SITE_ORIGIN`, `SITE_BRAND`, `PATH`, `isAirEnabled()`.
  - `isAllowedUrl(url)`: true only for https, an allowlisted host, and no port or userinfo.
  - `siteFromRequest(c)` / `originFromRequest(c)`: checks Host, then X-Forwarded-Host, then Origin, and the first allowlisted value wins. Header spoofing can only pick between our own origins.
  - `knownHostFromRequest(c)` / `signupSiteFromRequest(c)`: these record facts. They recognise promoair.ru even while the gate is off. Never use them to build links.
  - `siteForUser({role, signup_site})`: `signup_site` first, then `role='venue'` → air (only while the gate is on).
  - `siteForUserId(id)`: async, with a DB read. While the gate is off it makes no query at all. It reads `signup_site` through `to_jsonb(u)->>'signup_site'`, which works before migration 160 is applied.
- **`src/email-helper.tsx`.**
  - `emailWrapper(content, site='music')` (:199). The `'air'` variant (:227) carries the PROMO.AIR header, the logo `https://promoair.ru/promoair/email-logo.png`, a footer link to promoair.ru and an orange button style (`btn(site)`, :255).
  - Sender and Reply-To are unchanged (`"ПРОМО.МУЗЫКА" <noreply@promo-music.ru>`, the only address with SPF/DKIM).
  - These senders gained a `site` parameter (default `'music'`):
    - `sendPasswordResetEmail` (:259)
    - `sendVerificationEmail` (:292; on air the link is `https://promoair.ru/server/auth/verify-email-page`)
    - `sendAccountApprovedEmail` / `sendAccountRejectedEmail` (:438, :451)
    - `sendProfileVerifiedEmail` / `sendProfileVerificationRejectedEmail` (:485; on air the cabinet link is `/venue`)
    - `notifyPaymentExpired` (:704)
    - `sendChatGuestReplyEmail` (:779)
    - all 7 venue emails (:807-:979). On air these say «PROMO.AIR» instead of «ПРОМО.ЭИР» and link to `SITE_ORIGIN[site]` + `PATH.*`.
  - `sendVenueRadioWelcomeEmail` takes `pendingApproval`. On air it adds the line «Сначала мы проверим аккаунт…»: the account stays pending until an admin approves it.
  - `notifyNewUser` takes `site` and shows «Сайт: promoair.ru» only for air signups. `notifyBugReport` takes `host`.
  - **The `'music'` output is byte-identical to the original** (verified, see below).
- **`src/index.ts:217`.** The CORS `origin` is now `ALLOWED_ORIGINS`.
- **SSE and chat CORS.** `src/sse-routes.tsx:21` and `src/chat-support-routes.tsx:56` use the same list.
- **`src/auth-routes.tsx`:**
  - `storeSignupSite()` (:63): a separate best-effort `UPDATE users SET signup_site`, in a try/catch. The signup cannot fail because of it.
  - Signup (:280-:305): writes `signup_site`. The verification and welcome emails use the request's site. `notifyNewUser` gets the site.
  - VK (:494): the allowlist is `ALLOWED_ORIGINS × /login|/register|/auth/vk/callback`, and the default is `originFromRequest + /login`. New VK users get `signup_site` (:618).
  - `request-reset` (:820), `set-email` (:945), `resend-verification` (:999) and `resend-verification-by-email` (:1115) send the email for the request's site.
  - `verify-email-page` / `verify-email-confirm` redirects (:1013, :1038-:1064) go to `${originFromRequest}/login?...`.
  - Admin `verify-profile` (:1308), `approve-user` (:1339) and `reject-user` (:1359) send the email for the user's site via `siteForUserId`, not the admin's.
- **Return-URL allowlists use `isAllowedUrl`:**
  - `checkout-routes.tsx:2869`. The error texts are kept.
  - `coins-routes.tsx:81`. The default return URL comes from `originFromRequest`.
  - `venue-radio-routes.tsx:126`. The default is `originFromRequest + /venue/promo-air`.
- **`venue-billing-routes.tsx`.**
  - `/subscribe` (:131) and `/attach-card` (:223) return to `originFromRequest + /venue/subscription?...`.
  - The expiry email in `markVenueExpired` (:619) goes via `siteForUserId`.
  - Billing logic itself is untouched.
- **`checkout-routes.tsx:1940`, the «оплата не завершена» email.** It has a new venue branch for `venue_*` session or metadata types: retryUrl = `${site origin}/venue/subscription`, plus PROMO.AIR branding. Before, venue reminders fell through to `/artist/finances`. **This changes promo-music.ru too: it is a bug fix.**
- **`venue-trial.tsx:307,337,369` and `venue-station-routes.tsx:546,586,698`.** The trial-cron emails and the admin moderation/provision emails use the venue's site via `siteForUserId`.
- **`chat-support-routes.tsx`.**
  - A guest chat opened on promoair.ru stores `source='widget:air'` (:144).
  - If the CHECK constraint still rejects that value (error 23514, migration not applied), it falls back to `'widget'`.
  - The reply email links back to the session's site (:566, :883).
- **`feedback-routes.tsx:176`.** The bug report records the host. It appears in Telegram as «Сайт:», in the admin email and in `feedback_reports.context.host`, for both sites.
- **`pageview-routes.tsx`.**
  - Writes `page_views.host`, the allowlisted request host, null if the host is unknown (:24, :95).
  - On error 42703 (column missing) it falls back to the old INSERT and stops trying until the next restart.
  - The `/stats` source split treats `promoair.ru` referrers as internal (:172).
- **`track-url-token.tsx:62`.** `OWN_REDIRECT_HOSTS = ALLOWED_HOSTS`.

### Migration `src/migrations/160_promoair_site.sql`

- `users.signup_site TEXT CHECK (IN ('music','air'))`: NULL means the user registered before 160.
- `page_views.host TEXT`, plus `idx_page_views_host`. The table has about 81k rows, so the index builds in well under a second.
- `chat_sessions_source_chk` is extended with `'widget:air'` and `'cabinet:air'`. The old values stay valid.
- All statements are idempotent and the file contains no BEGIN/COMMIT. Tables are owned by `postgres`, and `promofm_app` has table-level arwd, so the new columns are writable without extra GRANTs.
- **Not dry-run against prod:** my read-only check was blocked by the auto-mode classifier. The lead must run the dry-run first:

```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
BEGIN;
SET LOCAL lock_timeout = '5s';   -- ALTER TABLE users must not queue behind a long transaction (review §5)
\i /opt/promofm-api/src/migrations/160_promoair_site.sql
ROLLBACK;
EOF
# then the same with COMMIT, BEFORE restarting promofm-api with the new code
# "canceling statement due to lock timeout" = nothing applied; retry at a quiet moment
```

Rollback (only if needed):

```sql
UPDATE chat_sessions SET source = split_part(source, ':', 1) WHERE source LIKE '%:air';
ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_source_chk;
ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_source_chk CHECK (source = ANY (ARRAY['widget','cabinet','telegram']));
DROP INDEX IF EXISTS idx_page_views_host;
ALTER TABLE page_views DROP COLUMN IF EXISTS host;
ALTER TABLE users DROP COLUMN IF EXISTS signup_site;
```

### Deploy order

1. Apply migration 160 (dry-run first, see above).
2. Deploy the code and restart `promofm-api` with `PROMOAIR_ORIGIN` **empty**. promo-music.ru behaves as today. The only intended differences:
   - venue «оплата не завершена» emails link to `/venue/subscription`;
   - bug reports show «Сайт:»;
   - `signup_site` and `page_views.host` start filling.
3. promoair.ru nginx vhost: every `/server/` block (including `/server/api/sse/` and `/server/auth/`) must send these headers:
   - `proxy_set_header Host $host;`
   - `proxy_set_header X-Forwarded-Host $host;`
   - `proxy_set_header X-Real-IP $remote_addr;`
   - `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`

   Without `X-Real-IP` the WAF is skipped (IP 0.0.0.0, see notes/be-domain.md B8).
4. Once `https://promoair.ru/server/health` answers: add `PROMOAIR_ORIGIN=https://promoair.ru` to `/opt/promofm-api/.env` and restart `promofm-api`.
5. Outside the code:
   - YooKassa: tell the shop about promoair.ru (site registration).
   - VK ID app 54426299: add `https://promoair.ru/login` only if VK login is needed on promoair. Venues sign up by email only.
   - The frontend ships `fe/public/promoair/email-logo.png`. Make it readable on a light pill (`#f9fcff`), about 60 px tall (shown at 30 px).

### Verification

Local (done, see below):

```bash
~/Projects/promoair/bin/tsc-api.sh                       # 10 errors = baseline set (only line shifts)
cd ~/Projects/promoair/api && npx tsx ../tools/be-site-origin.test.mts            # 14 checks
cd ~/Projects/promoair/api && mkdir -p .tmp-email-check \
  && cp ../api-orig/src/email-helper.tsx .tmp-email-check/email-helper-orig.tsx \
  && npx tsx ../tools/be-email-site.test.mts .tmp-email-check/email-helper-orig.tsx; rm -rf .tmp-email-check   # 34 checks
```

- `be-site-origin.test.mts` covers:
  - host mapping and header priority;
  - spoofed hosts (`evil.com`, `promoair.ru.evil.com`, `constructor`, …);
  - `isAllowedUrl`: http, port, userinfo, protocol-relative and trailing-dot URLs are all rejected;
  - gate off, and invalid env values (gate stays off).
- `be-email-site.test.mts`:
  - mocks nodemailer;
  - compares From, Reply-To, To, subject and HTML of 17 senders against the original `email-helper.tsx`, byte for byte;
  - checks that the air variants have promoair links, logo and brand, no promo-music cabinet links, the same sender and no «—».
- Screenshot of the air welcome email: `~/Projects/promoair/shots/be-domain/air-welcome-email.png`.

On prod, after step 2 and again after step 4:

```bash
curl -s -o /dev/null -D - -H 'Origin: https://promoair.ru' https://promo-music.ru/server/health | grep -i access-control-allow-origin   # absent before step 4, present after
sudo -u postgres psql -d promofm -c "SELECT signup_site, count(*) FROM users WHERE created_at > now() - interval '1 day' GROUP BY 1"
sudo -u postgres psql -d promofm -c "SELECT host, count(*) FROM page_views WHERE created_at > now() - interval '1 hour' GROUP BY 1"
journalctl -u promofm-api --since '10 min ago' | grep -E 'site-origin|signup_site_store_failed|page_views.host missing'   # should be empty
```

After step 4:
- Sign up as a venue on promoair.ru. The verification and welcome emails must link to `https://promoair.ru/...`, and the verify link must land on `https://promoair.ru/login?verified=true...`.
- Start attach-card on promoair.ru. YooKassa must return to `https://promoair.ru/venue/subscription?card=attached`.

### Open risks / not done

- **Old venues go to promoair.ru.** `siteForUser` sends venues with `signup_site IS NULL` to promoair.ru once the gate is on (spec: «role venue → air»). That covers the 5 existing venues, which registered on promo-music.ru. Their session there does not carry over to promoair.ru, so they log in again. If the owner wants them kept on promo-music.ru, run `UPDATE users SET signup_site='music' WHERE role='venue' AND signup_site IS NULL` before step 4. This is a decision, and I have not run it.
- **Deliverability.** promoair.ru links are sent from `noreply@promo-music.ru` (Yandex spam history 11.10). The From display name stays «ПРОМО.МУЗЫКА». The air footer says «PROMO.AIR – музыка для заведений от ПРОМО.МУЗЫКА». A separate `noreply@promoair.ru` needs a mailbox and DKIM/DMARC first.
- **Frontend contracts (promoair SPA):**
  - `/login` must handle `?verified=true`, `?auto_login_token=`, `?error=missing_token|invalid_token`;
  - `/reset-password?token=`;
  - `/venue`, `/venue/subscription`, `/venue/onboarding`, `/venue/apk`, `/venue/promo-air`;
  - `/?chat=<id>&t=<token>` must restore the support chat. The guest reply email links there. If the promoair home page does not mount the chat widget, the link lands on the home page.
- **Venue email copy, music variant.** It still says «зайдите в кабинет» in the welcome email for pending accounts, and the trial-expired texts promise a «бесплатный режим: 1 зона, 5 плейлистов» with prices in the text. I kept the music output byte-identical. The billing agent should align the texts with the real expiry and trial semantics.
- **Allowlists merged.** The lists used to differ by place: checkout allowed promofm.org, the venue-radio route allowed only promo-music.ru, and so on. Now there is one list everywhere: promo-music.ru, www, admin, promofm.org (+www), promofm.ru (+www). All are our domains.
- **Error text.** The 400 message `returnUrl must be on promo-music.ru` is unchanged for compatibility, even though promoair.ru is also allowed once the gate is on.
- **Not touched, owned by other agents or needing decisions:**
  - marketplace returnUrl open redirect (SECURITY agent: use `isAllowedUrl`);
  - `venue-billing-helpers.tsx:104` and `venue-billing-routes.tsx:458` (server-side recurring charges, no redirect happens);
  - venue-campaign CTA (`venue-campaign-routes.tsx:23`);
  - SEO, sitemap and prerender (`seo-routes.tsx`, `sitemap-routes.tsx`);
  - stream and now-playing URLs;
  - admin links in emails (the admin stays on promo-music.ru).
- **Analytics.** `/server/api/analytics/stats` has no per-site filter yet. Rows can be split by `page_views.host`.
- **page_views.host retry.** If the API ever starts before migration 160, it stops trying to write `host` until the next restart.

---

## 2. BILLING: trial, card, subscription (16.10.2026)

**Goal.** Card binding really starts the 7-day trial on the plan the venue chose, the card is saved, the trial ends with an autocharge of exactly that plan, renewals and expiry run on a schedule, cancel keeps access to the end of the period. Fixes notes/critic.md A2 (a)-(f) and A4. Nothing here depends on `PROMOAIR_ORIGIN`.

### What changed

- **`src/venue-plans-constants.tsx`** (leaf module, no imports). Money helpers, all pure and unit-tested:
  - `VENUE_YEAR_MONTHS = 10` (:37); `FULL_RADIO_PLAN` 20 000 / 200 000, not purchasable (:51); `RENEWAL_LEAD_DAYS = 3` (:56).
  - `isVenuePaidTier` (:61, own keys only, so `constructor` is rejected), `venuePlanPrice` (:65), `parseVenuePlanChoice(body)` (:75, optional `{tier, interval}`, 400 on unknown values).
  - `resolveVenueChargePlan(data)` (:100): the plan the trial-end charge bills. Chosen tier/interval, else «Старт» monthly (was `'business'`, A2 d).
  - `getVenueNextCharge(data, hasCard)` (:122): trial → trial end; active → 3 days before the period ends; otherwise null.
- **`src/venue-plan-limits.tsx:129` `getEffectiveVenuePlan`.**
  - trial → the chosen tier (start/business/network, else start). It used to be a flat `business`.
  - cancelled → kept until `subscriptionExpiresAt`: a trial keeps the chosen tier, a paid plan keeps its tier; after that, `free` (A2 e).
  - no status / `pending_card` / expired → `free`. A missing status used to read as active «Старт» (A2 f). For limits nothing is lost: `free` has the same caps as `start`.
- **`src/db.tsx` payment methods** (:1818-:1897), written against the real prod schema (`id uuid DEFAULT uuid_generate_v4()`, no `updated_at`):
  - `upsertPaymentMethod`: the DB generates the uuid. The app id (`pm-…`) lives in `data.id`. Upsert key is `(user_id, data.gatewayMethodId)` for gateway cards, else `(user_id, data.id)`. It returns the row uuid and **throws on error** (it used to only log).
  - `getChargeablePaymentMethod(userId)` (new): the newest row that has a gateway token, read with a direct query that throws. A DB error is never taken for «no card».
  - `deletePaymentMethod(id, userId?)`: matches the uuid or `data.id`, scoped to the owner. Before, deleting a `pm-…` id was a silent no-op on the uuid column. Callers now pass the user: `checkout-routes.tsx:3123`, `settings-routes.tsx:243`.
  - `getPaymentMethods`: same shape as before; rows without `data.id` expose the row uuid as `id`.
  - Before this fix every write failed on prod, so no card was ever saved, for artists or venues (A2 b). Artist callers checked:
    - the artist renewal cron (`subscriptions-routes.tsx:890`) reads `methods[0].gatewayMethodId`, and that is unchanged;
    - `payments-routes.tsx:72` and `settings-routes.tsx:220` now really persist; the frontend never calls their POST.
- **`src/payment-gateway.tsx` / `src/gateway-yookassa.tsx`.**
  - The webhook payload carries `paymentMethodSaved` and card data (last4, brand) from the verified payment (`gateway-yookassa.tsx:262`).
  - `chargeRecurring` adds a 54-FZ `receipt` when `receiptEmail` is passed (`:366`). Without it the request is byte-identical, so artist renewals are unchanged.
- **`src/checkout-routes.tsx` (webhook).**
  - `saveCardFromWebhook` (:53) runs at the start of `processPaymentSuccess` (:123), before the per-type branches. It logs `payment_method_saved`, `payment_method_save_failed` or `payment_method_not_saved_by_gateway` and does not throw.
  - The `venue_card_attach` branch is rewritten (:409):
    - `pending_card` → `trial`, with `trial_expires_at` = now + `trialPeriodDaysFor` (7 days) and the chosen `subscriptionPlan`/`subscriptionInterval` from `metadata.trialPlan`/`trialInterval`. These are deliberately not `planKey`: with `planKey` the paid branch would activate a tier for 1 ₽.
    - `trial` (or a cancelled trial that still has days left) → card and plan change. The trial end stays the same and the cancel is undone.
    - `active` / `expired` / cancelled paid plan → the card is saved, the status is untouched.
    - The target user is the payer (`session.userId`). A mismatching `metadata.userId` is only logged.
  - **The 1 ₽ refund now actually happens.** The old code read `webhook.sessionId`, which does not exist (2 of the 10 baseline TS errors). It now uses `webhook.paymentId`, is awaited, has idempotence key `refund-attach-<orderId>` and logs `venue_card_attach_refunded` / `..._refund_failed`.
  - The 1 ₽ check is no longer recorded as platform revenue (:1937).
  - Paying via `/subscribe` after a cancel clears the cancel marks (:292).
  - `venue_radio_subscription` activation (:538) runs in one transaction with two steps:
    1. it closes the venue's other active row (`status='superseded'`), because `uq_vr_active_sub_per_venue` allows only one;
    2. it starts the paid 30 days from the end of that row.

    Without this, paying `efir` during the provisioning trial would hit the unique index.
- **`src/venue-billing-routes.tsx`.**
  - `GET /plans` (:130): public, no auth, no secrets. Response: `{ currency, trialDays: 7, yearMonths: 10, plans: [{ id, name, monthly, yearly, purchasable, limits }] }`. It lists start, business and network, plus `full_radio` (`purchasable: false`, `limits: null`). `Cache-Control: max-age=300`.
  - `POST /subscribe` (:156): the tier is validated by `parseVenuePlanChoice`, and the receipt goes to the venue's e-mail (`loadVenueReceiptEmail`, `venue-billing-helpers.tsx:23`).
  - `POST /attach-card` (:266), body optional: `{tier, interval}`.
    - It stores the payment session (A2 a) and sends the receipt to the venue's e-mail.
    - Error responses: 400 for an unknown tier or interval; 409 `{code:'trial_used'}` when the status is `expired` (one trial per venue).
    - The response adds `mode`: `trial_start`, `trial_card_change` or `card_change`, plus `tier` and `interval`.
  - `POST /cancel` (:360):
    - only from `trial` or `active`; any other status gets 409 `nothing_to_cancel`, and a repeat cancel is idempotent;
    - it stores `cancelledFromStatus` and `subscriptionCancelledAt`, and keeps the period end (for a trial, `trial_expires_at`);
    - the message names the date.
  - `POST /resume` (new, :431): undoes a cancel while the period runs. It needs a saved card, otherwise 409 `card_required`; it also returns 409 `nothing_to_resume`.
  - `GET /me` (:475):
    - the default status is `pending_card` and the default plan `start` (was `trial`/`business`);
    - it adds `effectivePlan`, `trialDays`, `trialExpiresAt`, `cancelledFromStatus`, `cancelledAt`, `cardRequired`;
    - it adds `nextChargeAt`, `nextChargeRub`, `nextChargePlan`, `nextChargeInterval`;
    - `savedCard` is the chargeable gateway card only.
  - `/cron/charge-recurring` (:546):
    - it uses `RENEWAL_LEAD_DAYS` and the chargeable card, and a card lookup error skips the row instead of expiring it;
    - the receipt goes to the venue's e-mail (:645);
    - the expiry email names the reason (`markVenueExpired`, :775).
- **`src/venue-billing-helpers.tsx` `tryAutoChargeAtTrialEnd`** (:63). It returns `'charged' | 'no_card' | 'declined' | 'pending' | 'error' | 'not_trial'` (was a boolean).
  - It re-reads the profile first, so a cancel made just before is honoured.
  - It charges the chosen plan with the receipt e-mail.
  - The orderId is deterministic, `venue-first-<user>-<trialEndMs>`, and is also the YooKassa idempotence key, so there is no double charge. If a prior session for that orderId already succeeded, it activates without charging again.
- **`src/venue-trial.tsx` `expireTrialsOnce`.**
  - `charged` → counted in the new `charged` field.
  - `pending` / `not_trial` → skipped.
  - `error` → retried hourly for 24 h (`TRIAL_CHARGE_RETRY_MS`, :99), then expired.
  - `no_card` / `declined` → expired, with `subscriptionExpiredReason` and a reason email.
  - The T-3 and T-1 emails get the amount, plan and date of the charge (`charge`, :346).
- **`src/email-helper.tsx`.** New optional parameters, `TrialChargeNotice` (:806) and `VenueExpiredReason` (:815). With them the trial emails tell the truth: what will be charged, when, how to cancel, and why access stopped. Without them the old text is byte-identical, so DOMAIN's `be-email-site.test.mts` still passes 34/34. Screenshots: `~/Projects/promoair/shots/be-billing/*.png`.
- **A4, `src/venue-station-routes.tsx:672-688`.**
  - The provisioning trial row in `venue_radio_subscriptions` is keyed by `req.user_id` (was `venue_profiles.id`, invisible to every reader).
  - It is inserted only if the venue has no active row and never had a `trial` row, so a second point gives no second trial and there is no unique-index clash.
- **`src/venue-radio-routes.tsx`.**
  - Readers (`/subscription`, `/cancel`, `/stream-token`) also accept rows keyed by the profile id (`OWN_SUB`, :23); prod has 0 such rows.
  - `/subscription` prefers the active row over a newer `pending_payment`.
  - The `efir` price is looked up by `venue_station_requests.user_id` (:110). Before it was always 409.

### Migration `src/migrations/161_venue_radio_service_plans.sql`

- It inserts the service plans `trial` and `efir` into `venue_radio_plans`, with `is_active=false` and price 0. `ON CONFLICT DO NOTHING`, no BEGIN/COMMIT.
- Why it is needed: `venue_radio_subscriptions.plan_id` has a FK to `venue_radio_plans`, and prod has only basic, pro and business. The provisioning trial insert has failed on the FK every time, and an `efir` subscribe would fail the same way.
- `is_active=false` keeps both rows out of the public `/venue-radio/plans` list and out of `/checkout/create-session`.
- Independent of 160. Code without 161 behaves as today: the trial insert is logged and skipped.

```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF2'
BEGIN;
\i /opt/promofm-api/src/migrations/161_venue_radio_service_plans.sql
ROLLBACK;
EOF2
# then the same with COMMIT
```

### New env var

| Var | Value | Effect |
|---|---|---|
| `CRON_SECRET` | random, e.g. `openssl rand -hex 32` | Required by `/venue/cron/expire-trials`, `/venue-billing/cron/charge-recurring`, `/stream-player/cron/tick` (and the artist `/subscriptions/charge-recurring`). Missing on prod today, so all of them answer 500 (A2 c). The API reads it from `.env` at start (systemd `EnvironmentFile`), so restart `promofm-api` after adding it. No timer exists for the artist cron; setting the secret does not start it. |

### Crons: runner and systemd units (in the repo, NOT installed)

- `scripts/venue-cron.sh <expire-trials|charge-recurring|stream-player-tick>`:
  - reads only the `CRON_SECRET=` line of `/opt/promofm-api/.env` (the file is not sourced, quotes are stripped) and sends it to curl on stdin, so the secret is not visible in `ps`;
  - takes `flock -n /run/lock/promofm-venue-cron-<job>.lock`, so a second run exits at once;
  - POSTs to `127.0.0.1:3000` with `--fail-with-body` and prints one line to the journal; an HTTP error gives a non-zero exit, so the unit shows as failed.
- `systemd/promofm-venue-cron@.service` is a template, runs as `User=promofm` (the same user as the API; `.env` is 0600 promofm), in `Slice=sites-promofm.slice`, with `TimeoutStartSec=600`.
- `systemd/promofm-venue-expire-trials.timer`:
  - hourly at :05, `Persistent=true`;
  - handles trial end (charge or expire) and the T-3 / T-1 reminders. The flags and the per-trial orderId make reruns no-ops.
- `systemd/promofm-venue-charge-recurring.timer`:
  - 00:35, 06:35, 12:35 and 18:35, `Persistent=true`;
  - renewals 3 days before the end; a declined card is retried once a day (day-stamped orderId); cancelled or unpaid plans expire.
- **stream-player tick: deliberately not scheduled.**
  - Nothing reads `stream_player_state`: AutoDJ ignores it, and the module itself says «future ffmpeg worker».
  - Prod has 0 schedules and 0 zones.
  - Every minute it would only add 1440 requests a day.
  - The runner supports the job, and the old `systemd/promofm-stream-player.*` files stay as they are for when a playout consumer exists.

Install (lead, after the cleanup below):

```bash
# 0. secret (do not echo it to the terminal)
sudo -u promofm sh -c 'grep -q "^CRON_SECRET=" /opt/promofm-api/.env || printf "\nCRON_SECRET=%s\n" "$(openssl rand -hex 32)" >> /opt/promofm-api/.env'   # printf: safe if .env has no trailing newline (review §5)
sudo systemctl restart promofm-api
# 1. units
sudo cp /opt/promofm-api/systemd/promofm-venue-cron@.service /etc/systemd/system/
sudo cp /opt/promofm-api/systemd/promofm-venue-expire-trials.timer /opt/promofm-api/systemd/promofm-venue-charge-recurring.timer /etc/systemd/system/
sudo systemctl daemon-reload
# 2. one manual run of each, read the result
sudo systemctl start promofm-venue-cron@expire-trials.service;    journalctl -u promofm-venue-cron@expire-trials -n 5 --no-pager
sudo systemctl start promofm-venue-cron@charge-recurring.service; journalctl -u promofm-venue-cron@charge-recurring -n 5 --no-pager
# expected after the cleanup: "scanned":0 in both
# 3. arm the timers
sudo systemctl enable --now promofm-venue-expire-trials.timer promofm-venue-charge-recurring.timer
systemctl list-timers 'promofm-venue-*'
# disable: sudo systemctl disable --now promofm-venue-expire-trials.timer promofm-venue-charge-recurring.timer
```

### Junk venue_profiles cleanup (prepared, NOT executed)

`scripts/sql/promoair-cleanup-venue-profiles.sql`:
- runs one transaction: preview of what goes and why, preview of what stays, preview of linked demo rows in other tables (not deleted), a guard, then the DELETE;
- ROLLBACK by default; it commits only with `-v apply=1`;
- the guard aborts if the set differs from the 11 ids checked on prod today; `-v allow_diff=1` overrides it.

| Criterion (checked with SELECT on prod 16.10) | ids |
|---|---|
| `user_id` NULL or empty | `venue-1`, `venue-2`, `venue-3` (demo «Bar Decor», «Lounge 21», «Sky Rooftop», status active, no expiry) |
| `user_id = 'anonymous'` | `anonymous` |
| test ids (`^test`) | `test-venue-001` |
| `user_id` not in `users` | `fa1d5dd7…` («Curator Test Venue»), `3ad323fe…`, `f13827aa…`, `b86e0e74…`, `3a683a87…` |
| admin profile with a fake trial (status trial, no `trial_expires_at`, no card, no requests or streams) | `6b54fb8b-05f5-4e55-8bf3-2b1a8aceed99` (role admin) |

- 11 rows go. The one that stays is `10c0e848…` (user `d6b6ffa8…`, role venue).
- A profile of a `role='venue'` user is excluded by every criterion.
- There are no FKs to `venue_profiles`.
- The guard and the preview queries were run read-only on prod as CTE SELECTs: the guard passes, and the demo rows are radio_venue_requests 11, venue_ad_campaigns 5, venue_playlists 12, venue_orders_index 1.

```bash
sudo mkdir -p /root/backups
sudo -u postgres pg_dump -d promofm -t public.venue_profiles --data-only --column-inserts > /root/backups/venue_profiles_$(date +%F_%H%M).sql
sudo -u postgres pg_dump -d promofm -t public.venue_profiles -Fc -f /root/backups/venue_profiles_$(date +%F_%H%M).dump   # with schema
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -f /opt/promofm-api/scripts/sql/promoair-cleanup-venue-profiles.sql            # dry-run
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -v apply=1 -f /opt/promofm-api/scripts/sql/promoair-cleanup-venue-profiles.sql # apply
# restore single rows: pick the INSERT lines for the ids from the .sql backup and run them
```

### What the first cron run does (checked on prod 16.10)

The 5 real venue users:

| User | `venue_profiles` | expire-trials | charge-recurring |
|---|---|---|---|
| `e78a62db…` | none | not touched | not touched |
| `d6b6ffa8…` | `10c0e848…`, `data = {}` (no status) | not scanned (status ≠ trial) | not scanned (status ∉ active/cancelled) |
| `f05d3c9a…` | none | not touched | not touched |
| `5ffb6522…` | none | not touched | not touched |
| `ca4cd711…` | none | not touched | not touched |

- **No charge, no email and no state change** for any of them.
- In the cabinet `d6b6ffa8…` now reads as `pending_card` / `free` (was active «Старт» for free) and gets the «привяжите карту» banner.
- 0 `payment_methods`, 0 `venue_station_streams` and 0 `venue_api_tokens` exist for venues, so there is nothing to revoke.

**If the cleanup is skipped:**
- expire-trials scans the 7 `trial` rows (6 junk plus the admin). Their trial dates come from `createdAt` (March) + 14 days, so all count as expired.
- Each has no card → `no_card` → status `expired`, plan `free`. The token and stream updates hit 0 rows.
- One email goes to the admin (`6b54fb8b…`, the only row with a user e-mail), «Подписка ПРОМО.ЭИР не активна». Junk rows have no e-mail.
- charge-recurring scans 0 rows: `venue-1..3` are `active` but have no `subscriptionExpiresAt`.
- So skipping the cleanup is harmless except for that admin email and 7 rewritten junk rows. Cleaning up first is still the plan.

### Verification (done locally)

```bash
~/Projects/promoair/bin/tsc-api.sh     # 8 errors, all from the baseline; the 2 checkout-routes 'sessionId' errors are gone (refund fix)
cd ~/Projects/promoair/api && npx tsx ../tools/be-billing.test.mts        # 6 check groups: prices, choice validation, charge plan, next charge, effective plan, emails
cd ~/Projects/promoair/api && npx tsx ../tools/be-site-origin.test.mts    # 14 (DOMAIN, still green)
# DOMAIN email identity test, still 34/34 (see section 1)
# E2E on a real Postgres (PGlite, prod schema from tools/fixtures/be-billing-prod-schema.sql, YooKassa/SMTP mocked):
D=$(mktemp -d); (cd $D && npm init -y >/dev/null && npm i --ignore-scripts @electric-sql/pglite-socket@0.2.11)
cd ~/Projects/promoair/api && npx tsx ../tools/be-billing-e2e.test.mts $D  # 19 checks
```

- **E2E covers:**
  - `/plans`;
  - `/me` for a new venue (pending_card);
  - attach-card validation, session, receipt e-mail, and no `planKey`;
  - the webhook: trial on the chosen plan, card saved with a uuid, 1 ₽ refunded with its key; a retry makes no second refund and no duplicate card;
  - `/me` and `/venue/profile` agree;
  - cron secret check, T-3 email sent once, and the trial-end charge of exactly 99 900 ₽ (Бизнес, year) with receipt and deterministic orderId;
  - cancel keeps access, resume, and renewal 3 days early, extended from the old end;
  - a cancelled trial is never charged, expires, and gets 409 `trial_used`;
  - a declined first charge → expired with an honest email;
  - a legacy profile without status;
  - an artist card saved by the same webhook, plus owner-scoped delete;
  - A4: the provisioning trial keyed by user id, a single trial per venue, the efir price by user_id, efir during the trial (trial superseded, +30 days after it), and readers accepting an old profile-id row.
- Every new SQL statement was also planned with `EXPLAIN` / `PREPARE` against the prod schema, read-only.
- The runner script was tested against a local stub server: secret passed, lock, 401/500 → non-zero exit, missing secret.

### Checks on prod after deploy

1. One real 1 ₽ card binding with a test venue account, then check:
   - `payment_sessions` for that order: status `succeeded`, then `refunded` after the refund webhook;
   - a `payment_methods` row with `data->>'gatewayMethodId'`;
   - `venue_profiles.data` with status `trial` and `trial_expires_at` about 7 days ahead;
   - the money is back on the card;
   - `GET /server/api/venue-billing/me` shows `nextChargeAt` and `nextChargeRub`.
2. Read the journal:

```bash
journalctl -u promofm-api --since '15 min ago' | grep -E 'payment_method_(saved|save_failed|not_saved_by_gateway)|venue_trial_started_after_card|venue_card_attach_(refunded|refund_failed|card_not_saved)'
sudo -u postgres psql -d promofm -c "SELECT order_id, status, updated_at FROM payment_sessions WHERE data->'metadata'->>'type'='venue_card_attach' AND status='succeeded' AND updated_at < now() - interval '15 minutes'"   # attach payments whose 1 ₽ was not refunded
```

3. `curl -s https://promo-music.ru/server/api/venue-billing/plans` returns 4 plans and `trialDays: 7`.
4. The autocharge can only be tested with a real charge of the plan price (refund it afterwards in the YooKassa dashboard). It is optional, and the lead decides.

### Open risks / not done

- **YooKassa autopayments.**
  - Saving cards (`save_payment_method`) must be enabled for the shop. Not verifiable from here.
  - If the gateway returns `saved:false`, the trial still starts, but `cardSaveFailed: true` is set, the log says `payment_method_not_saved_by_gateway`, `/me` has `cardRequired: true`, the reminders ask for a subscription, and at trial end the venue expires with an honest email.
  - If the shop rejects `save_payment_method` outright, attach-card and subscribe answer 500. The first real 1 ₽ test (above) settles this.
- **Artist renewals** still send no receipt (unchanged, out of scope). If the shop enforces receipts on every payment, they fail. The artist cron is not scheduled anyway.
- **Behaviour changes on promo-music.ru** (old `/venue` cabinet):
  - the one real profile now reads as `pending_card` / `free`; its limits are the same as Старт;
  - a trial started from the old cabinet (no plan choice) runs on Старт and is charged 4 990 ₽. The old UI may still say «Бизнес» in places (`fe/src/venue/components/subscription-section.tsx:48` fallback); that is frontend, not touched;
  - `/cancel` now answers 409 outside trial/active (the old UI only offers cancel when active);
  - card writes and deletes now actually work for all roles;
  - an abandoned 1 ₽ binding can trigger the existing «оплата не завершена» email (1 ₽, link to `/venue/subscription`);
  - the admin gets the usual «payment received» email for each 1 ₽ check.
- **Pending gateway charge at trial end.**
  - The venue keeps trial access until the webhook settles; the log shows `first charge still pending` every hour.
  - ~~The renewal cron keeps its old day-stamped orderId: a renewal still `pending` the next day may be charged again.~~ Fixed in §5 (attempts tagged with `renewFor`).
- **Two subscription systems remain.**
  - `venue_profiles.data` (tiers) and `venue_radio_subscriptions` (provisioning trial, efir) are separate.
  - `/venue-radio/subscription` shows `priceMonth: 0` for `efir` rows (the real price sits in the request).
  - Nothing renews `venue_radio_subscriptions` automatically.
- **Expiry enforcement.** `markVenueExpired` and trial expiry pause streams and revoke tokens in the DB. Whether playback really stops depends on the APK honouring `/device/config` (be-venue §2).
- **Night emails.** Reminders come from an hourly cron, so a T-3 email can go out at night.
- **Not done:** an admin UI for refunds or plan changes (ADMIN agent), renewal reminder emails before a paid period ends (the code has none), and linking venue-billing tiers to stream entitlement.

---

## 3. ADMIN: PROMO.AIR section of the admin API (17.10.2026)

**Goal.** The PROMO.AIR section of the admin on promo-music.ru (`/ctrl-pm7k2f/promo-air`) works from real data: venue list and card, account moderation, plan without payment, trial extension, devices, venue payments and an audit trail. Contract: `notes/PLAN.md` §3.6. Nothing here depends on `PROMOAIR_ORIGIN`; with the gate off, e-mails simply go out with promo-music.ru branding.

### What changed

- **`src/promo-air-admin-routes.tsx` (new).** The routes, mounted at `/server/api/promo-air-admin` (`src/index.ts:458`, import :70).
  - `app.use('*', requireAuth, requireAdmin)` (:45): one gate for the whole section, so no route can be added without it. It is scoped to the prefix; checked that other routes are not affected.
  - SQL: `VENUE_ROW_SQL` (:59) starts from `users WHERE role='venue' AND deleted_at IS NULL`, LEFT JOIN `venue_profiles`, the latest `venue_station_requests` row and stream counts (LATERAL). `PAYMENT_SQL` (:109), `AUDIT_SQL` / `AUDIT_SCOPE` (:131, :146).
  - Keyset pagination `keysetPage` (:189): `(COALESCE(created_at,'epoch'), id) DESC`, `limit+1` rows. The cursor time is formatted by Postgres in UTC with microseconds (`to_char(... 'US')`), so rows inside one millisecond are neither skipped nor repeated, and DateStyle/TimeZone do not matter.
  - Account transitions `transitionAccount` (:386): one statement, `WITH prev AS (SELECT ... FOR UPDATE) UPDATE users ... WHERE prev.prev_status = ANY(allowed) RETURNING prev.prev_status`. 0 rows → 404 (not a venue) or 409 with the current status.
  - Block `cutVenueAccess` (:419), in the same transaction: `revokeUserSessions` (token_version + refresh tokens), streams `provisioned|live → paused` (as `markVenueExpired`), `venue_api_tokens` revoked (the Bearer API does not check the account status).
  - Plan and trial: `lockVenueForBilling` (:510) locks the `users` row and the `venue_profiles` row (`FOR UPDATE`) inside a transaction.
  - Approve/reject e-mails (`notifyAccountDecision`, :445): existing `sendAccountApprovedEmail` / `sendAccountRejectedEmail` with `siteForUser({role:'venue', signup_site})` (DOMAIN), plus the same in-app notification as `/auth/admin/approve-user`. Fire-and-forget.
  - Every mutation calls `logAdminAction` (`audit`, :174): `actor_id` = admin, `target_id` = venue user, `resource_type='venue'`, `details = {actorEmail, reason, before, after, ...}`.
- **`src/promo-air-admin-helpers.tsx` (new, pure, no DB).** Cursor encode/decode, `parseLimit`, `buildVenueFilters` (escaped ILIKE), `ACCOUNT_TRANSITIONS` / `canTransition`, input parsing (`parseReason`, `parsePlanAssignment`, `parseTrialDays`, `untilEndOfDayMsk`), data patches (`planAssignmentData`, `trialExtensionData`), row builders (`toVenueRow`, `toStreamItem`, `toDevice`, `toPaymentItem`, `toAuditItem`). `EFFECTIVE_PLAN_SQL` (:102) is a SQL copy of `getEffectiveVenuePlan` for the `?plan=` filter; the e2e test compares both on 1352 profile shapes.
- **`src/venue-station-routes.tsx`.**
  - `rowToRequest` exported (:84), used by the venue card.
  - `reissuePairingCode(streamId)` (:156) extracted from the owner route `POST /me/regenerate-pairing` (now :429, same SQL, same response). The admin route reuses it.
  - Admin actions now audited (`auditStationAction`, :443): `venue_station_take` (:538), `venue_station_reject` (:568), `venue_station_request_changes` (:606), `venue_station_provision` (:724, the pairing code is not logged), `venue_stream_pause|resume|mark_live` (:785). Target = the venue user.
- **`src/venue-apk-routes.tsx`.** Admin actions audited (`auditApk`, :80): `venue_apk_release_upload` (:188), `venue_apk_release_update` (:214), `venue_apk_release_delete` (:237), `venue_apk_build_upload` (:449, target = venue).
- **`src/auth-security.tsx:359` `revokeUserSessions(userId, db = pool)` (new).** `token_version + 1` and revoke all refresh tokens; takes a transaction client. The UsersManagement ban `landing-data-routes.tsx:2713` now calls it instead of its own two queries (same SQL).
- **`src/auth-routes.tsx:425` sign-in gate.** `'banned'` is refused like `'blocked'` (403, `accountStatus:'blocked'`). Before, `/signin` checked only `'blocked'`, so a user banned from UsersManagement (`'banned'`) could log in again with the password. Prod has 0 banned users, so nobody is affected today.
- **`src/migrations/162_user_status_rejected.sql` (new).** See below.
- **Docs:** `docs/PRODUCT_FACTS.md` «PROMO.AIR admin section» and the corrected ban note.

### New env vars

None.

### Migration 162: `user_status` gets `'rejected'`

Checked on prod 17.10: `enum_range(NULL::user_status) = {active,inactive,suspended,pending,banned,blocked}`. There is no `'rejected'`, so:
- the existing `POST /auth/admin/reject-user` («Заявки партнёров») has always failed with 500 (22P02);
- the sign-in gate «Ваша заявка отклонена» never fired;
- `POST /promo-air-admin/venues/:id/reject` cannot store the status. Until 162 is applied it answers 500 `{error:'migration_required', message:'Отказ пока не сохраняется: ...'}`, the transaction is rolled back and nothing is logged.

`ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'rejected'`: idempotent, no BEGIN/COMMIT in the file, allowed inside the usual transaction because the value is not used there (same as 122). An enum value cannot be removed without recreating the type; it is harmless while nothing writes it.

```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF3'
BEGIN;
\i /opt/promofm-api/src/migrations/162_user_status_rejected.sql
ROLLBACK;
EOF3
# then the same with COMMIT; check:
sudo -u postgres psql -d promofm -c "SELECT enum_range(NULL::user_status)"
```

### API contract

Base `/server/api/promo-air-admin`. All routes: session cookie of an admin (role admin/superadmin **and** e-mail in `ADMIN_EMAILS`); no session → 401 `{success:false, error:'Authorization required'}`, not admin → 403 `{success:false, error:'Admin access required'}`.

Errors (`success:false`):

| HTTP | `error` | Extra fields | When |
|---|---|---|---|
| 400 | `reason_required` | `message` | reject / block / plan / trial-extend without a non-empty `reason` |
| 400 | `invalid_input` | `field`, `message` (Russian) | plan or trial-extend body invalid |
| 400 | `invalid_filter` | `field`, `message` | unknown `status` / `plan` / `sub`, `q` or `city` longer than 100 |
| 400 | `invalid_cursor` | | cursor not issued by this endpoint |
| 404 | `not_found` | | not a uuid, no such user, not `role='venue'`, deleted |
| 409 | `conflict` | `status`, `kind: 'account' \| 'subscription'` | stale state: `status` is the current account status (or subscription status for trial-extend) |
| 500 | `migration_required` | `message` | reject before migration 162 |

Pagination (`/venues`, `/payments`, `/audit`): `limit` 1..100 (default 50; out-of-range values are clamped, not rejected), `cursor` = `nextCursor` of the previous page (opaque base64url), `nextCursor: null` on the last page. Order: newest first.

Dates are ISO strings in UTC. Money is rubles (`amountRub`, may carry kopecks). Fields marked «extra» are additions to PLAN §3.6; the frontend may ignore them.

#### `GET /overview`

```json
{
  "success": true,
  "counts": {
    "venues": 7, "accountsPending": 2, "accountsActive": 5, "accountsBlocked": 0,
    "requestsPending": 1, "requestsInWork": 0,
    "streams": 3, "streamsOnline": 1,
    "subsPendingCard": 3, "subsTrial": 1, "subsActive": 2, "subsCancelled": 0, "subsExpired": 1
  },
  "generatedAt": "2026-10-17T07:18:10.821Z"
}
```

- `venues`: users with role venue (not deleted). `accountsBlocked` = `banned` + `blocked` + `suspended`.
- `requestsPending` = station requests in `pending_admin`; `requestsInWork` = `in_setup` + `changes_requested`.
- `streams` = streams not `dead`; `streamsOnline` = paired device that sent a heartbeat in the last 3 minutes (the app sends one per minute).
- `subs*`: `venue_profiles.data.subscriptionStatus` of venue users; a venue without a profile counts as `pending_card`. `subsCancelled` is extra.

#### `GET /venues?q=&status=&plan=&city=&sub=&cursor=&limit=`

- `q`: case-insensitive substring of e-mail, name (full_name / display_name / username), venue name or city. `%` `_` `\` are literal.
- `status`: account status `pending | active | blocked | rejected | inactive` (`blocked` = banned + blocked + suspended).
- `plan`: effective plan `free | start | business | network | enterprise` (same as `subscription.effectivePlan`).
- `city`: exact city, case-insensitive. `sub` (extra): `pending_card | trial | active | cancelled | expired`.

```json
{
  "success": true,
  "items": [
    {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "leo-bar@example.org",
      "name": "Лео",
      "accountStatus": "active",
      "emailVerified": true,
      "createdAt": "2026-10-11T07:18:10.646Z",
      "signupSite": "air",
      "profile": { "id": "22222222-2222-4222-8222-222222222222", "venueName": "Бар «Лео»", "venueType": "bar", "city": "Казань", "address": null },
      "subscription": {
        "status": "active", "plan": "network", "effectivePlan": "network", "interval": "month",
        "expiresAt": "2026-11-06T07:18:10.646Z", "trialExpiresAt": null, "hasCard": true
      },
      "request": { "id": "33333333-3333-4333-8333-333333333333", "status": "pending_admin", "airType": "full_radio", "points": 3, "createdAt": "2026-10-17T07:18:10.713Z" },
      "streams": { "total": 2, "online": 1, "lastSeenAt": "2026-10-17T07:17:10.715Z" }
    },
    {
      "userId": "44444444-4444-4444-8444-444444444444",
      "email": "coffee@example.org",
      "name": "Сандра",
      "accountStatus": "pending",
      "emailVerified": false,
      "createdAt": "2026-10-08T07:18:10.646Z",
      "signupSite": null,
      "profile": null,
      "subscription": { "status": "pending_card", "plan": null, "effectivePlan": "free", "interval": null, "expiresAt": null, "trialExpiresAt": null, "hasCard": false },
      "request": null,
      "streams": { "total": 0, "online": 0, "lastSeenAt": null }
    }
  ],
  "nextCursor": "WyIyMDI2LTEwLTEyVDA3OjE4OjEwLjY0NjAwMFoiLCI0OWRmNTIwNy1kOGYwLTRmZGYtOWEyYy00YWY4YmYzMmU1ZDMiXQ"
}
```

- `signupSite`: `users.signup_site` (`air` / `music`), `null` for users registered before migration 160 or while it is not applied.
- `subscription.status` defaults to `pending_card` (no profile or no status); `plan` is the stored tier (`null` if none); `hasCard` = a card saved by the gateway webhook (`data.source='gateway_webhook'`, the one autocharge would use; since §5 a token typed into the settings forms does not count).
- `request`: the latest station request (any status, including `rejected`); `points` = number of points in the questionnaire.

Bad filter: `400 {"success":false,"error":"invalid_filter","field":"status","message":"Неизвестный статус аккаунта."}`.

#### `GET /venues/:userId`

```json
{
  "success": true,
  "row": { "...": "VenueRow, same shape as in /venues" },
  "profile": {
    "id": "22222222-2222-4222-8222-222222222222", "user_id": "11111111-1111-4111-8111-111111111111",
    "venueName": "Бар «Лео»", "venueType": "bar", "city": "Казань", "address": null,
    "subscriptionStatus": "active", "subscriptionPlan": "network", "subscriptionInterval": "month",
    "subscriptionExpiresAt": "2026-11-06T07:18:10.646Z", "isVerified": false, "email": null, "phone": null
  },
  "request": {
    "id": "33333333-3333-4333-8333-333333333333", "userId": "11111111-1111-4111-8111-111111111111", "venueId": "22222222-2222-4222-8222-222222222222",
    "musicPreferences": {}, "jingles": {}, "aiHostConfig": {},
    "format": { "airType": "full_radio", "points": [{ "name": "Зал" }, { "name": "Терраса" }, { "name": "Бар" }] },
    "status": "pending_admin", "assignedAdminId": null, "adminNotes": null, "rejectedReason": null, "changesRequested": null,
    "submittedAt": "2026-10-17T07:18:10.713Z", "takenAt": null, "provisionedAt": null, "liveAt": null,
    "monthlyPrice": 0, "createdAt": "2026-10-17T07:18:10.713Z", "updatedAt": "2026-10-17T07:18:10.713Z"
  },
  "streams": [
    {
      "id": "55555555-5555-4555-8555-555555555555", "pointName": "Зал", "status": "live",
      "streamUrl": "https://promo-music.ru/air/live/venue-leo",
      "pairingCode": null, "pairingExpiresAt": null,
      "pairedAt": "2026-10-16T07:18:10.715Z", "lastSeenAt": "2026-10-17T07:17:10.715Z",
      "online": true,
      "device": { "model": "Xiaomi TV", "android": "11", "appVersion": "1.2.0" }
    },
    {
      "id": "66666666-6666-4666-8666-666666666666", "pointName": "Терраса", "status": "provisioned",
      "streamUrl": "https://promo-music.ru/air/live/venue-leo2",
      "pairingCode": "KQ7-M3P", "pairingExpiresAt": "2026-10-18T07:18:10.716Z",
      "pairedAt": null, "lastSeenAt": null, "online": false, "device": null
    }
  ],
  "payments": [
    { "id": "77777777-7777-4777-8777-777777777777", "userId": "11111111-1111-4111-8111-111111111111", "email": "leo-bar@example.org",
      "type": "subscription", "status": "succeeded", "amountRub": 14990, "createdAt": "2026-10-17T06:38:10.737Z",
      "description": "Сеть", "plan": "network", "interval": "month" }
  ],
  "audit": [
    { "id": "1507", "at": "2026-10-17T07:18:12.034Z", "actorEmail": "info@promofm.ru", "action": "venue_station_take", "reason": null,
      "details": { "requestId": "33333333-3333-4333-8333-333333333333", "after": { "requestStatus": "in_setup" }, "actorEmail": "info@promofm.ru" },
      "targetUserId": "11111111-1111-4111-8111-111111111111", "targetEmail": "leo-bar@example.org", "targetName": "Бар «Лео»" }
  ]
}
```

- `profile`: the full merged profile (`getVenueProfile`: `data` jsonb + native columns), `null` if the venue never opened the cabinet.
- `request`: the latest station request, same shape as `/api/venue-station/admin/:requestId` (`rowToRequest`).
- `streams` (all, oldest first): `pairingCode` only while no device is paired; `device` is `null` until a device is paired; `online` is extra.
- `payments`: the last 50 (see `/payments`); `audit`: the last 50 admin actions on this venue (see `/audit`).

#### `POST /venues/:userId/approve` `{reason?}`

`pending → active`. Sends «Аккаунт одобрен» to the venue's site (PROMO.AIR for venues once the gate is on) and an in-app notification. Does **not** mark the e-mail verified: `row.emailVerified` shows whether the venue has confirmed it.

```json
{ "success": true, "row": { "...": "VenueRow, accountStatus 'active'" } }
```

Repeat or wrong state: `409 {"success":false,"error":"conflict","status":"active","kind":"account"}`.

#### `POST /venues/:userId/reject` `{reason}`

`pending → rejected` (needs migration 162). Sends «Заявка отклонена» with the reason, plus an in-app notification. `reason` empty → `400 {"success":false,"error":"reason_required","message":"Укажите причину."}`. Not pending → 409 as above.

#### `POST /venues/:userId/block` `{reason}`

Any of `active | pending | rejected | inactive` → `banned`. In one transaction: `token_version + 1` (live sessions get 401), all refresh tokens revoked, streams `provisioned|live → paused`, venue API keys revoked, and (since §5) the subscription cancelled: `trial|active → cancelled` with `cancelledFromStatus`, so no cron charges the card; the response adds `cancelledSubscription` (the status before, or `null`). Sign-in with the password then returns 403. No e-mail to the venue.

```json
{ "success": true, "row": { "...": "VenueRow, accountStatus 'banned'" }, "pausedStreamIds": ["55555555-5555-4555-8555-555555555555"], "revokedApiTokens": 1 }
```

Already blocked: `409 {"success":false,"error":"conflict","status":"banned","kind":"account"}`.

#### `POST /venues/:userId/restore` `{reason?}`

`banned | blocked | suspended →` the status before the block (since §5: read from the latest `promoair_venue_block` audit row, so a blocked `pending` / `rejected` account goes back to `pending` / `rejected`, not `active`; no audit row → `active`). Streams stay paused, API keys stay revoked and the subscription stays cancelled: resume streams with `/api/venue-station/admin/streams/:id/resume` (or a plan assignment, below); the venue issues new keys itself and turns renewal on with `/venue-billing/resume`.

```json
{ "success": true, "row": { "...": "VenueRow, accountStatus 'active'" } }
```

#### `POST /venues/:userId/plan` `{plan, status, until, reason, interval?}`

```json
{ "plan": "business", "status": "active", "until": "2026-11-16", "reason": "Оплата по счёту №12" }
```

- `plan`: `start | business | network`; `status`: `active | trial`; `until`: `YYYY-MM-DD`, read as the end of that day, Moscow time (`2026-11-16T20:59:59.000Z`). Must be in the future; at most 60 days ahead for `trial`, 3 years for `active`. `interval` (extra, optional): `month | year`, default = the current one or `month`.
- Account must be `active` or `pending`, otherwise 409 `kind:'account'`.
- Writes `venue_profiles.data`: `subscriptionStatus`, `subscriptionPlan`, `subscriptionInterval`, `subscriptionExpiresAt = until`, `subscriptionPriceRub = 0`, `subscriptionAssignedByAdminAt`; clears `cancelledFromStatus`, `subscriptionCancelledAt`, `subscriptionExpiredReason`. For `trial` also `trial_expires_at = until` and the T-3 / T-1 reminder flags are reset. Creates the profile if the venue has none (`ensureVenueProfile`). No payment row.
- Paused streams go back to `provisioned` (as after a payment).
- **No charge after `until` (changed in §5):** the assignment writes `autoRenew:false`. The crons never charge such a plan or trial, even with a saved card; at `until` it expires with the «автопродление не было включено» e-mail. It renews only after the venue's own consent: a paid `/subscribe`, `/venue-billing/resume`, or a card binding during the trial.

```json
{
  "success": true,
  "row": { "...": "VenueRow", "subscription": { "status": "active", "plan": "business", "effectivePlan": "business", "interval": "month", "expiresAt": "2026-11-16T20:59:59.000Z", "trialExpiresAt": null, "hasCard": false } },
  "resumedStreamIds": []
}
```

Invalid: `400 {"success":false,"error":"invalid_input","field":"until","message":"Пробный период: не дальше 60 дней вперёд."}` (field is one of `plan`, `status`, `interval`, `until`).

#### `POST /venues/:userId/trial-extend` `{days, reason}`

`days` integer 1..60. Only while `subscriptionStatus = 'trial'` (otherwise `409 {"success":false,"error":"conflict","status":"active","kind":"subscription"}`; account not active/pending → `kind:'account'`). Adds the days to the current trial end (or to now if the end has passed but the cron has not closed the trial yet), sets `subscriptionExpiresAt` to the same date, re-arms the T-3 / T-1 reminders.

```json
{ "success": true, "row": { "...": "VenueRow, subscription.trialExpiresAt moved" } }
```

#### `GET /payments?cursor=&limit=`

Venue payments from `payment_sessions` (one row per payment): sessions of venue types (subscription, card check, station subscription) and any payment by a venue user (bookings, content orders). `payment_transactions` / `payment_txns` are ledger copies of the same money and are not listed.

```json
{
  "success": true,
  "items": [
    { "id": "88888888-8888-4888-8888-888888888888", "userId": "11111111-1111-4111-8111-111111111111", "email": "leo-bar@example.org",
      "type": "radio_subscription", "status": "succeeded", "amountRub": 15000, "createdAt": "2026-10-17T06:48:10.739Z",
      "description": "Абонемент эфира", "plan": "efir", "interval": null },
    { "id": "99999999-9999-4999-8999-999999999999", "userId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "email": "sea-cafe@example.org",
      "type": "card_check", "status": "succeeded", "amountRub": 1, "createdAt": "2026-10-17T06:28:10.735Z",
      "description": "Привязка карты для пробного периода – Кофейня у моря (1 ₽ вернётся автоматически)", "plan": "business", "interval": "year" }
  ],
  "nextCursor": null
}
```

`type`: `card_check` (1 ₽ check, refunded), `subscription` (paid via /subscribe), `trial_charge` (first charge after the trial), `renewal`, `radio_subscription` (station subscription, `efir` and old plans), otherwise the session purpose (`purchase`, ...). `status` is the raw session status (`pending`, `succeeded`, `canceled`, `refunded`, ...). `plan` / `interval` are extra.

#### `GET /devices`

All venue streams (up to 500), online first.

```json
{
  "success": true,
  "items": [
    { "streamId": "55555555-5555-4555-8555-555555555555", "userId": "11111111-1111-4111-8111-111111111111", "venueName": "Бар «Лео»", "pointName": "Зал",
      "status": "live", "pairedAt": "2026-10-16T07:18:10.715Z", "lastSeenAt": "2026-10-17T07:17:10.715Z", "online": true,
      "device": { "model": "Xiaomi TV", "android": "11", "appVersion": "1.2.0" } },
    { "streamId": "66666666-6666-4666-8666-666666666666", "userId": "11111111-1111-4111-8111-111111111111", "venueName": "Бар «Лео»", "pointName": "Терраса",
      "status": "provisioned", "pairedAt": null, "lastSeenAt": null, "online": false, "device": null }
  ]
}
```

`device` comes from the app (`{model, osVersion, appVersion}`, `~/Projects/promo-air-app/src/lib/api.ts`); the old keys `androidVer` / `appVer` are read too.

#### `POST /streams/:streamId/regenerate-pairing`

New 24-hour code; the old device is unpaired (its token gets 401, the app returns to the code screen). Valid in any stream status, so there is no 409. The code is not written to the audit log.

```json
{ "success": true, "streamId": "55555555-5555-4555-8555-555555555555", "pairingCode": "ZKD-3BX", "pairingExpiresAt": "2026-10-18T07:18:11.956Z" }
```

#### `GET /audit?cursor=&limit=`

Actions by admins (actor role admin/superadmin) with codes `promoair_*` / `venue_*`, or on venue users (including `user_approve` from «Заявки партнёров»). Newest first.

```json
{
  "success": true,
  "items": [
    { "id": "1504", "at": "2026-10-17T07:18:11.661Z", "actorEmail": "info@promofm.ru", "action": "promoair_venue_block",
      "reason": "Жалоба правообладателя",
      "details": { "reason": "Жалоба правообладателя", "before": { "accountStatus": "active" }, "after": { "accountStatus": "banned" },
                   "pausedStreamIds": ["55555555-5555-4555-8555-555555555555"], "revokedApiTokens": 1, "actorEmail": "info@promofm.ru" },
      "targetUserId": "11111111-1111-4111-8111-111111111111", "targetEmail": "leo-bar@example.org", "targetName": "Бар «Лео»" }
  ],
  "nextCursor": "WyIyMDI2LTEwLTE3VDA3OjE4OjExLjY2MTAwMFoiLCIxNTA0Il0"
}
```

Action codes: `promoair_venue_approve | promoair_venue_reject | promoair_venue_block | promoair_venue_restore | promoair_plan_assign | promoair_trial_extend | promoair_pairing_regenerate`, `venue_station_take | venue_station_reject | venue_station_request_changes | venue_station_provision`, `venue_stream_pause | venue_stream_resume | venue_stream_mark_live`, `venue_apk_release_upload | venue_apk_release_update | venue_apk_release_delete | venue_apk_build_upload`, plus the generic `user_approve`, `user_reject`, `user_block`, `user_unblock`, `profile_verify`, ... when the target is a venue. `reason` = `details.reason` (or `details.message` for request-changes).

### Deploy order

1. Migration 162 (dry-run, then COMMIT, see above). It is independent of 160 and 161, and it also repairs `/auth/admin/reject-user`.
2. Deploy the code and restart `promofm-api`. No env changes. The admin section works with `PROMOAIR_ORIGIN` empty; it then sends e-mails with promo-music.ru branding.
3. Frontend: the ADMIN-FE section (`fe/src/admin/promo-air/**`, `fe/src/utils/api/promo-air-admin.ts`) talks to these routes.

### Verification

Local (done):

```bash
~/Projects/promoair/bin/tsc-api.sh                                   # 8 errors, all baseline (same set as after BILLING)
cd ~/Projects/promoair/api && npx tsx ../tools/be-admin.test.mts     # 8 groups: cursor, limit, filters, transitions, input, data patches, rows, no em dash
D=<dir with @electric-sql/pglite-socket@0.2.11>                      # see section 2
cd ~/Projects/promoair/api && npx tsx ../tools/be-admin-e2e.test.mts $D   # 13 groups on PGlite with the prod schema
# E2E_DUMP=<file> writes the real response bodies used for the examples above
```

`be-admin-e2e.test.mts` loads `tools/fixtures/be-billing-prod-schema.sql` + `tools/fixtures/be-admin-extra-schema.sql` (prod `pg_dump --schema-only` of `audit_logs`, `refresh_tokens`, `notifications`, `login_attempts`, `user_mfa`) and checks:
- access: 401 / 403 for artist, venue, admin role with a non-allowlisted e-mail;
- overview counts (junk `venue_profiles` row and deleted user ignored, online = paired + < 3 min);
- list order, cursor pages without gaps or repeats, every filter, `%`/`_` literal, 400 on bad filter / cursor;
- `EFFECTIVE_PLAN_SQL` = `getEffectiveVenuePlan` on 1352 profile shapes, bad dates included;
- venue card; approve / reject (409 on repeat, e-mail to the PROMO.AIR or music site by `signup_site`, notification, audit); reject before 162 → 500 `migration_required`, rolled back, then 162 applied twice;
- block (banned, token_version, refresh tokens, stream paused, API key revoked, live session → 401, `/auth/signin` → 403), restore, plan for a blocked account → 409;
- plan (400s write nothing, profile created, billing fields, no payment row, streams un-paused, trial variant), trial-extend (409 kinds, +7 days from the current end, reminders reset);
- regenerate-pairing (device unpaired, code not logged), cabinet regenerate-pairing still works through the shared helper;
- `venue_station_take` / `mark-live` audited; payments (venue types + venue users, artist excluded, cursor); devices; audit scope (non-admin and non-venue rows excluded, cursor over bigint ids); the UsersManagement ban still revokes sessions.

Earlier suites still pass: `be-site-origin` 14, `be-email-site` 34, `be-billing` 6, `be-billing-e2e` 19.

On prod after deploy (read-only):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://promo-music.ru/server/api/promo-air-admin/overview   # 401 without a session
# logged in as admin in the browser: /ctrl-pm7k2f/promo-air shows 5 venues, 0 pending
sudo -u postgres psql -d promofm -c "SELECT action, target_id, details->>'actorEmail', created_at FROM audit_logs WHERE action LIKE 'promoair\_%' OR action LIKE 'venue\_%' ORDER BY id DESC LIMIT 10"
journalctl -u promofm-api --since '10 min ago' | grep 'promo-air-admin'   # should be empty
```

### Open risks / not done

- **Approve does not verify the e-mail.** Unlike `/auth/admin/approve-user`, which sets `is_email_verified=true`. A venue approved before it confirmed the address still gets 401 «Email не подтверждён» at sign-in and must use the link from the signup e-mail (or resend). This is deliberate: an admin click should not vouch for an address nobody confirmed. The UI should show `row.emailVerified`.
- ~~**Plan after `until` may charge the card.**~~ Fixed in §5: assignments carry `autoRenew:false` and are never charged.
- **Sign-in gate now refuses `'banned'`** (behaviour change on promo-music.ru, fixes the UsersManagement ban). Other entry points are SECURITY's: VK login (`auth-routes.tsx` VK callback) and `/auth/refresh` do not check `users.status`. VK sessions of a blocked user are still rejected right away by `token_version`, because VK tokens are signed with `tv=1`. `exchange-auto-login` is in SECURITY's list.
- **`/auth/admin/reject-user` stays broken until 162** (pre-existing). It has no status guard either; SECURITY owns the approve/reject guards in `auth-routes.tsx`.
- **`mark-live` sets `last_seen_at = NOW()`** without a device (`venue-station-routes.tsx` `setStreamStatus`). That is why «online» here also requires `paired_at`.
- **`ensureVenueProfile` on plan assignment** e-mails the admin «новое заведение» (stage `registered`) when the venue had no profile (4 of the 5 real venues today).
- **Restore leaves streams paused and API keys revoked.** Resume streams per point, or assign a plan (which un-pauses them).
- **Not done:** refunds, venue finance report, an «owner message» action (the existing AdminChat is a stub), station-request moderation (stays on `/api/venue-station/admin/*`), offline alerts.
- **Station `reject` has no status guard** (`/api/venue-station/admin/:id/reject`, pre-existing). I added audit logging only.

---

## 4. SECURITY: approval cannot be bypassed, AI-host IDOR, marketplace redirect (17.10.2026)

**Goal.** Owner decision (PLAN §1): venue (and other partner) accounts keep MANUAL approval. After this section no path gives a `pending` account a session, an admin click cannot silently reactivate a rejected or banned account, one venue cannot touch another venue's AI-host data, and the marketplace no longer redirects to arbitrary sites after payment. Nothing here depends on `PROMOAIR_ORIGIN`.

### Why `/reset-password` flipped `pending → active` (evidence)

- The line came with commit `6a5ddda` (28.05.2026, «fix(chat-visibility): legacy artists невидимы до активации пароля»; `git log -S` on `/opt/promofm-api`, read-only). Its message: legacy imports (2250 rows) were created with status **active** and no password; setting the password through the activation e-mail should verify the e-mail and make them visible in chat. `status pending → active` was added «идемпотентно» on top. It was never needed for the imports, and it opened a bypass for partners.
- Prod, 17.10.2026 (`SELECT status, role, password_hash IS NULL, is_email_verified, count(*) FROM users WHERE deleted_at IS NULL GROUP BY 1,2,3,4`): **0 `pending` users of any role**. All legacy accounts without a password are `active` (2244 artists, 859 radio_station). Venues: 5, all `active` and verified. `enum_range(NULL::user_status) = {active,inactive,suspended,pending,banned,blocked}` (no `rejected` until migration 162).
- Kept: password + `is_email_verified=TRUE` + the `pending → active` flip **only for non-partner roles** (the legacy-activation case, should a non-partner ever be `pending`). Partners (`PARTNER_ROLES` = radio_station, radio, venue) stay `pending`.

### What changed

- **`src/access-gates.tsx` (new, pure, no DB).**
  - `accountBlockOf(status)` (:34): `pending` → pending, `rejected` → rejected, `blocked|banned` → blocked, everything else (`active`, `inactive`, `suspended`) → null. Same set as the old `/signin` checks plus ADMIN's `banned`.
  - `accountBlockBody(block)` (:45): the exact `/signin` 403 bodies (`{success:false, error:'Ваш аккаунт на модерации.'|'Ваша заявка отклонена.'|'Аккаунт заблокирован администрацией.', accountStatus}`), byte-identical to before (tested).
  - `autoLoginBlockBody(block)` (:54): for pending `{success:false, error:'account_pending', accountStatus:'pending', message:'Почта подтверждена. Аккаунт на проверке: напишем, когда откроем доступ.'}`, otherwise as `/signin`.
  - `moderationConflictText(action, status)` (:73): readable 409 text for «Заявки партнёров».
  - `decideVenueAccess(caller, venueId, profileOwner)` (:109) + `venueNeedsOwnerLookup` (:90): who may use which venue's AI-host data (below).
- **`src/auth-routes.tsx`.**
  - `/signin` (:331, gate :426): the three status `if`s replaced by `accountBlockOf/accountBlockBody` at the same place. Order unchanged: no password → unverified 401 → wrong password 401 → status 403 → MFA. Same bodies.
  - `/vk-callback` (:490): existing VK user (:554) and the «link VK to an existing account by e-mail» path (:608) refuse blocked statuses with the `/signin` 403 **before** any write, so a pending venue is neither logged in nor linked. New VK users are unchanged (always `active`, partner roles cannot sign up via VK).
  - `/reset-password` (:845, SQL :881): `CASE WHEN status='pending' AND role <> ALL(PARTNER_ROLES) THEN 'active'`. The response adds `accountStatus` (`{success:true, message:'Пароль обновлён.', accountStatus:'pending'}` for a partner on moderation).
  - `/admin/approve-user` (:1362): `UPDATE ... WHERE id::text=$1 AND status='pending'`; `/admin/reject-user` (:1388): same guard (pending → rejected). Miss → `moderationMiss` (:1355): 404 `{error:'Не найден'}` or 409 `{success:false, error:'Одобрить можно только аккаунт на проверке. Сейчас: заблокирован.', code:'conflict', status:'banned'}`. The audit (`user_approve` / `user_reject`), e-mail and notification run only on success. `id::text` also turns a non-uuid id into 404 instead of 500.
  - `/exchange-auto-login` (:1465, gate :1489): also `deleted_at IS NULL`; non-active → 403 `autoLoginBlockBody` and no cookie. The token is still consumed before the check (single use).
  - `/refresh` (:1517, gate :1541): selects `status`; blocked statuses → 403 `/signin` body and both cookies cleared. Closes a pre-existing hole: `POST /auth/admin/users/:id/status` (block) bumps `token_version` but does not revoke refresh tokens, so `/refresh` used to mint a fresh session for a blocked user.
  - `/verify-email-confirm` unchanged: still redirects to `<site>/login?verified=true&auto_login_token=…` for every account, so the promoair.ru login page can show «почта подтверждена, аккаунт на проверке» (`fe/src/promoair/api/auth.ts:accountBlockFrom` maps the 403).
- **`src/promo-air-dj-routes.tsx`** (AI host, `/server/api/promo-air-dj`). `resolveVenue` (:87) builds the caller (`role`, `isAdmin` = admin/superadmin role **and** `ADMIN_EMAILS`, same as `requireAdmin`), looks up `venue_profiles.id → user_id` only when it matters, and calls `decideVenueAccess`. Every route uses it: `generate-script` (:193), `generate-audio` (:245, role check only), `generate-full` (:338), `GET /scripts/:venueId` (:459), `GET /queue/:venueId` (:473), `POST /settings` (:491), `GET /settings/:venueId` (:510).
  - venue: `'current'` (what the cabinet sends, `fe/src/venue/components/radio-brand.tsx:757`), own userId or own `venue_profiles.id` → data stored under **own userId**; anything else 403 `{error:'Нет доступа к данным этого заведения'}`.
  - admin: any venue; a profile id is mapped to its owner's userId.
  - other roles (artist, dj, label, admin role without allowlisted e-mail): 403 on every route, including `generate-audio` (paid TTS + file write). No LLM/TTS call happens on a refused request.
  - Storage key change is safe: the three `promo_air_dj_*` tables have 0 rows on prod (checked 17.10). Before, every venue that used the cabinet tab shared the literal key `'current'`.
- **`src/marketplace-routes.tsx`.** `marketplaceReturnUrl` (:86) used at :499 (beats) and :1527 (digital goods): the client `returnUrl` is kept only if `isAllowedUrl` (https, our host, no port/userinfo); otherwise `${originFromRequest(c)}/marketplace/beats|digital`. Silent fallback, not 400, so dev frontends (`http://localhost`) still get a working checkout. promo-music.ru clients send `https://promo-music.ru/...` and are unaffected.
- **Docs:** `docs/PRODUCT_FACTS.md` «Partner account moderation gate» (after the PROMO.AIR admin section) and the ban note.

### New env vars / migrations

None. `/auth/admin/reject-user` still needs migration 162 to store `rejected` (pre-existing, see section 3); with the new guard a non-pending target gets 409 before the enum is touched.

### API contract changes (for AUTH-FE / admin)

| Endpoint | Case | Before | Now |
|---|---|---|---|
| `POST /auth/exchange-auto-login` | pending | 200 + session | 403 `{error:'account_pending', accountStatus:'pending', message}` |
| | rejected / blocked / banned | 200 + session | 403 `/signin` body (`accountStatus` `rejected` / `blocked`) |
| `POST /auth/reset-password` | partner pending | 200, status → active | 200 `{..., accountStatus:'pending'}`, stays pending |
| | non-partner pending | 200, → active | 200 `{..., accountStatus:'active'}` (unchanged) |
| `POST /auth/admin/approve-user` | target not pending | 200, → active | 409 `{error:<text>, code:'conflict', status}` |
| `POST /auth/admin/reject-user` | target not pending | 200 (or 500 before 162) | 409 same shape |
| `POST /auth/refresh` | pending / rejected / blocked / banned | 200 + new session | 403 `/signin` body, cookies cleared |
| `POST /auth/vk-callback` | existing account pending / rejected / blocked / banned | 200 + session (+ VK linked by e-mail) | 403 `/signin` body, nothing written |
| `/api/promo-air-dj/*` | another venue / non-venue role | 200 | 403 `{error:'Нет доступа к данным этого заведения'}` |
| marketplace purchase | foreign / http `returnUrl` | passed to YooKassa | replaced by our default |

### Deploy order

1. No migration and no env change for this section. Deploy the code with the rest of the chain and restart `promofm-api`.
2. nginx for AutoDJ (below): independent of the code, can go first.

### nginx: `/air/dj-api/` (for the lead; I did not touch nginx or AutoDJ)

Today `promo-music.ru.includes:326-332` proxies every method of `/air/dj-api/` to AutoDJ `127.0.0.1:8087/api/`, whose write endpoints (`upload`, `queue`, `clear_queue`, `skip`, `metadata/scan`) have no auth (notes/critic.md A11). Public readers only need GET status (`fe/src/app/components/landing/RadioMiniPlayer.tsx:13`, `fe/src/venue/components/VenueAirPlayer.tsx:17`, `api/src/venue-station-routes.tsx:188` via the public URL) and, at most, now-playing. Internal callers go to `127.0.0.1:8087` directly, not through nginx (`api/src/air-routes.tsx:17`, `news-broadcast.tsx:23`, `track-moderation-routes.tsx:113`, `services/podcast/engine.mjs:39`, `services/autodj/watchdog.sh:10`); the Android app (`~/Projects/promo-air-app`) does not use it. Replace the block with:

```nginx
# AutoDJ API: наружу только чтение статуса; управление только с 127.0.0.1:8087 напрямую
location = /air/dj-api/status {
    limit_except GET { deny all; }          # GET (и HEAD); POST/PUT/DELETE → 403
    proxy_pass http://127.0.0.1:8087/api/status;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location = /air/dj-api/now-playing {
    limit_except GET { deny all; }
    proxy_pass http://127.0.0.1:8087/api/now-playing;
    proxy_http_version 1.1;
    proxy_set_header X-Real-IP $remote_addr;
}
location ^~ /air/dj-api/ { return 404; }    # ^~: не отдавать регуляркам панели (FastPanel)
```

The promoair.ru vhost must not get `/air/dj-api/` at all except these two exact locations (infra template already). Then `nginx -t && systemctl reload nginx` and check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://promo-music.ru/air/dj-api/status                  # 200 (today 200)
curl -s -o /dev/null -w '%{http_code}\n' https://promo-music.ru/air/dj-api/now-playing             # 200 (today 200)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://promo-music.ru/air/dj-api/status          # 403
curl -s -o /dev/null -w '%{http_code}\n' https://promo-music.ru/air/dj-api/queue                   # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://promo-music.ru/air/dj-api/skip            # 404 (do NOT run before the change: today it would skip the live track)
```

Also from critic.md C9, outside the code: rotate `X-Internal-Key` (a scout printed it).

### Review of the ADMIN and BILLING changes (task item 6)

No authz defects found.
- `promo-air-admin-routes.tsx`: one `app.use('*', requireAuth, requireAdmin)` (:45) covers all 13 routes (the e2e checks 401/403 on every route). All SQL is parameterized: filters (`buildVenueFilters`, escaped ILIKE, whitelisted status/plan/sub values), cursors (`decodeCursor` validates timestamp and uuid/bigint shapes), ids (`isUuid`). Mass assignment: plan/trial write only whitelisted fields (`parsePlanAssignment`, `planAssignmentData`, `trialExtensionData`).
- `venue-billing-routes.tsx`: `subscribe`, `attach-card`, `cancel`, `resume`, `me` take the user from the JWT; `tier`/`interval` validated (`parseVenuePlanChoice`); `GET /plans` returns only public data; `/cron/charge-recurring` and `/venue/cron/expire-trials` refuse without `CRON_SECRET` (500 when unset, 401 on mismatch). Card delete is owner-scoped (`deletePaymentMethod(methodId, userId)` in `checkout-routes.tsx` DELETE `/methods/:id` and `settings-routes.tsx`, both from the JWT/`requireOwner`).
- `venue-station-routes.tsx` / `venue-apk-routes.tsx`: admin routes keep `requireAuth, requireAdmin`; the owner `POST /me/regenerate-pairing` still checks `user_id` + `venue_id` before the shared `reissuePairingCode`.
- Minor, not changed: the cron secret is compared with `!==` (not constant-time; same pattern as the artist cron). The secret is long and the endpoints are not rate-sensitive, so I left it.

### Verification (done locally)

```bash
~/Projects/promoair/bin/tsc-api.sh            # 8 errors, all baseline (same set as after BILLING/ADMIN), 0 new
cd ~/Projects/promoair/api && npx tsx ../tools/be-security.test.mts      # 13 checks passed
D=<dir with @electric-sql/pglite-socket@0.2.11>                             # see section 2
cd ~/Projects/promoair/api && npx tsx ../tools/be-security-e2e.test.mts $D   # 17 groups passed (3 runs)
```

- `be-security.test.mts` (pure): every prod `user_status` value through `accountBlockOf`; `/signin` bodies byte-identical to the original literals; the promoair login page mapping (`accountBlockFrom`, copied) recognises every 403 body; 409 texts; the `decideVenueAccess` matrix (own / other venue by userId and profile id, artist, dj, role-only admin, real admin, 400 on empty/oversized id); `isAllowedUrl` against foreign, http, userinfo, port, `//host`, `javascript:`, `data:`, localhost and promoair while the gate is off; no em dash.
- `be-security-e2e.test.mts`: real `auth-routes`, `promo-air-dj-routes`, `marketplace-routes` on PGlite with the prod schema (`tools/fixtures/be-billing-prod-schema.sql`, `be-admin-extra-schema.sql`, new `be-security-extra-schema.sql`: `pg_dump --schema-only` of `verification_tokens`, `profiles`, `promo_air_dj_*`, `beats`, `digital_goods`, `artist_profiles`, no data); migration 162 applied, `PROMOAIR_ORIGIN` empty like prod. SMTP, YooKassa, VK ID and OpenRouter mocked. Covers: real `/signup` of a venue on promoair.ru → `/verify-email-confirm` redirect still has `verified=true&auto_login_token` → exchange 403 `account_pending`, no cookie, token single-use; `/signin` 403 and the unchanged check order; `/request-reset` + `/reset-password` keep a venue pending, legacy non-partner activation still works, radio pending stays, active/banned untouched; approve/reject guards, audit only on success, 404 for unknown/non-uuid ids; exchange after approval (200 + cookie) and for rejected/banned/blocked; `/refresh` after the old-style block; VK by vk_id and by e-mail (pending not linked), active VK user still 200; AI host matrix incl. «no LLM call on 403»; marketplace `return_url` sent to YooKassa and stored in the session for 7 cases (beats) + digital goods.
- Mutation check: on a scratch copy of `src/` I reverted each fix in turn (exchange gate, reset CASE, approve/reject guard, refresh gate, VK gates, DJ ownership, marketplace check); the e2e failed at the matching group every time.
- Earlier suites still pass: `be-site-origin` 14, `be-email-site` 34, `be-billing` 6, `be-billing-e2e` 19, `be-admin` 8, `be-admin-e2e` 13 (one of four runs failed once right after the intentional 22P02 rollback in its «reject before 162» step and passed 3/3 on rerun: a PGlite socket flake, not related to these changes).

### Checks on prod after deploy

```bash
# all read-only; expected values with today's data (0 pending users)
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"token":"x"}' https://promo-music.ru/server/auth/exchange-auto-login   # 400 (invalid token, unchanged)
curl -s -o /dev/null -w '%{http_code}\n' https://promo-music.ru/server/api/promo-air-dj/settings/current   # 401 without a session
# logged in as an artist in the browser: GET /server/api/promo-air-dj/settings/current → 403
# venue cabinet «AI-ведущий» tab (radio-brand.tsx) still generates a text
journalctl -u promofm-api --since '10 min ago' | grep -E 'auto_login_refused|reset_password_error|exchange_auto_login_error'   # empty or expected refusals only
sudo -u postgres psql -d promofm -c "SELECT status::text, count(*) FROM users GROUP BY 1"   # unchanged by the deploy
```

### Open risks / not done

- **Behaviour changes on promo-music.ru** (all on paths that only matter for non-active accounts; prod has 0 pending/banned/rejected users today): reset no longer activates partners; approve/reject refuse non-pending targets (409 toast in «Заявки партнёров» instead of a silent change); VK, exchange and refresh refuse blocked statuses; `promo-air-dj` is venue/admin only (the only caller is the venue «AI-ведущий» tab); marketplace return URL falls back for foreign URLs. The old promo-music login page ignores `auto_login_token`, so the exchange change is invisible there.
- **`requireAuth` / `/auth/me` still do not check `users.status`** (per-request cost and blast radius). Sessions can only be minted by the gated paths now, and blocks bump `token_version`; a session minted before a status change lives until it expires (max 24 h, `JWT_EXPIRES_IN`) only if `token_version` was not bumped. The PROMO.AIR block and the UsersManagement ban bump it; `reject-user` does not (a pending account has no session to kill).
- **VK link-by-e-mail** (`/vk-callback` 23505 path) still links a VK id to an existing account whose e-mail matches the VK e-mail (pre-existing policy). Now only for allowed statuses; whether the linking itself is wanted is a product decision.
- **Pre-existing, found by the e2e, not fixed:** migration `097_digital_goods_file_url.sql` is **not applied on prod** (`digital_goods` has `file_url` but no `file_bytes`/`file_mime`, checked 17.10). `getDigitalGood` selects `file_bytes`, so `POST /marketplace/digital-goods/:id/purchase` answers 500 on prod for the 13 digital goods. The migration is idempotent (`ADD COLUMN IF NOT EXISTS`); applying it is the lead's call (dry-run first).
- **Pre-existing, not fixed:** `GET /promo-air-dj/scripts/:id?limit=abc` → `LIMIT NaN` → 500; `/api/venue-station/admin/:id/reject` has no status guard (ADMIN's note); `/auth/resend-verification` reads only Bearer (dead, be-domain §6).
- **Not done here (out of code):** nginx `/air/dj-api/` restriction (snippet above), `X-Internal-Key` rotation.
- **Prod access during this work:** read-only `\d`/SELECT, `pg_dump --schema-only` of 8 tables, `git log -S`/`git show` in `/opt/promofm-api`, two public GETs on `/air/dj-api/status|now-playing`. One `journalctl` grep I started for the 097 question was too slow; I stopped it and killed my own two `journalctl` PIDs on the server. Nothing else was touched.

---

## 5. REVIEW FIXES: money and security review of the backend chain (20.10.2026)

**Goal.** Two adversarial reviews (money path, security) of sections 1-4 found 2 blockers, 9 majors and 15 minors. I verified each against the code and fixed every confirmed blocker and major plus the cheap minors. No new env vars, no new migrations. Nothing here depends on `PROMOAIR_ORIGIN`.

### Verdicts

| # | Finding | Verdict |
|---|---|---|
| money B1 | Renewal `Idempotence-Key` 73 chars, YooKassa max 64 → every renewal 400 → paying venues expired | **fixed**: `yookassaIdempotenceKey` = the key if ≤ 64, else sha256 hex (createPayment, chargeRecurring, refund) |
| security B1 | `/create-session` topup/donation labelled `metadata.type='venue_card_attach'` was credited and then refunded in full | **fixed**: card check = `type 'venue_subscription'` + label + amount 1 (only the server creates it), refund is the constant 1 ₽, create-session refuses client `metadata.type` `venue_*` |
| money M1 | `pending` renewal never extended, charged again the next day | **fixed**: attempts tagged `metadata.renewFor`; succeeded → extend without charge, in flight → wait; session written before the gateway call; result settled only from `pending` |
| money M2 | blocked/banned venues still charged | **fixed**: both crons charge only `users.status='active'` and not deleted; others expire at the end, without e-mail; admin block also cancels the subscription |
| money M3 / security M3 | admin plan «без списания» charged the saved card at `until` | **fixed**: assignment writes `autoRenew:false`; crons never charge it, it expires as `not_renewed`; consent (paid `/subscribe`, `/resume`, card binding in trial) clears it |
| money M4 | re-binding a card after an unprocessed trial end gave 7 new days and changed the charge key | **fixed**: the trial end is never moved when it exists; the plan is not switched under a due charge |
| money M5 / security M1 | user-posted `gatewayMethodId` became the chargeable card; tokens returned to clients | **fixed**: webhook cards carry `source:'gateway_webhook'`, only those are chargeable (and admin `hasCard`); POST routes drop `gatewayMethodId/gateway/source/id`; no client response carries the token |
| money M6 | venue-billing expiry paused streams paid via `venue_radio_subscriptions` (efir) | **fixed**: `pauseVenueStreams` skips venues with an active, unexpired station subscription |
| security M2 | any role (artist) could use venue-billing / questionnaire, get charged, invisible in admin | **fixed**: `requireVenueAccount` (DB role `venue` + `active`, or admin) on subscribe/attach-card/cancel/resume/me and `POST|PUT /venue-station` |
| money m1 / security m1 | trial cron wrote stale `{...row.data}` snapshots over concurrent cancel/subscribe | **fixed**: jsonb `||` patches; the expiry write only while still `trial`, side effects only if it wrote |
| money m2 | trial starts though the gateway did not save the card | **deferred**: the promoair cabinet polls for `status != pending_card` after the card return and shows the honest `cardRequired` banner; staying `pending_card` needs a frontend change. No charge happens without a card; the first real 1 ₽ test settles whether the shop saves cards at all |
| money m3 | early webhook for a pending first charge → «Session not in DB», venue stays on trial | **fixed** (session written before the gateway call, same settle logic as M1) |
| money m4 | efir payment without 54-FZ e-mail | **fixed** |
| money m5 | 1 ₽ check booked as income, admin «payment received» e-mail each time | **partly fixed**: no admin e-mail; the `payment_txns` income row stays on purpose (the promoair cabinet history shows «Проверка карты» from it, the session records the refund) |
| money m6 / security m5 | cleanup SQL committed on `-v apply=0` | **fixed**: `\if :apply` / `\if :allow_diff` with defaults (checked with the server's psql 16: unset/0 → rollback, 1/yes → commit, garbage → error + rollback) |
| money m7 | `/me` showed a trial date before any trial | **fixed** (null while `pending_card`) |
| money m8 | no lock on charge-recurring | **fixed**: `pg_try_advisory_lock(770452)`, same pattern as the trial cron |
| security m2 | block then restore approved an unreviewed account | **fixed**: restore returns the status before the block (audit row), `active` only if there is none |
| security m3 | 1 ₽ refund without receipt | **fixed**: refund sends a receipt to the same e-mail (same item shape as the payment). Still verify on the first real binding |
| security m4 | `echo >> .env` merges into the last line | **fixed** in §2 (printf) |
| security m6 | migration 160 without `lock_timeout` | **fixed** in §1 (`SET LOCAL lock_timeout='5s'`) |
| security m7 | `venue_radio_subscription` webhook activated any row for any payer | **fixed**: create-session refuses the label; the webhook also requires the row to belong to the payer (else log `venue_radio_subscription_owner_mismatch`, no change) |
| note | www.promoair.ru must 301 to the apex (host-only cookies) | deploy note below |

### What changed

- **`src/gateway-yookassa.tsx`**: `yookassaIdempotenceKey` (:27), `receiptFor` (:32), used by `createPayment`, `chargeRecurring`; `refund` takes optional `receiptEmail` / `receiptDescription` (:316). Without them every request body is unchanged.
- **`src/checkout-routes.tsx`**:
  - `isVenueCardCheck` (:56) gates the card-check branch (:429), the revenue skip (:1985) and the admin e-mail (:2048); refund = `VENUE_CARD_CHECK_RUB` with receipt.
  - `saveCardFromWebhook` stamps `source` (:87).
  - card change in a trial keeps an existing end, applies the plan only while the trial runs, clears `autoRenew` (:489); trial start clears it too.
  - paid `venue_subscription` clears `autoRenew` (:313).
  - `venue_radio_subscription` ownership check inside the transaction (:578).
  - create-session refuses `metadata.type` `venue_*` (:2161, 400).
  - `GET /methods` without tokens (:3160).
- **`src/db.tsx`**: `GATEWAY_CARD_SOURCE`, `userPaymentMethodInput`, `publicPaymentMethod` (:1822-:1831); `getChargeablePaymentMethod` requires the source.
- **`src/payment-gateway.tsx`**: `SavedPaymentMethod.source` (:114).
- **`src/payments-routes.tsx`** (:67, :73) and **`src/settings-routes.tsx`** (:194, :217): sanitized input, token-free output.
- **`src/venue-billing-helpers.tsx`**: `requireVenueAccount` (:32), `isChargeableAccount` (:59), `pauseVenueStreams` (:71), `settleChargeSession` (:93); `tryAutoChargeAtTrialEnd` returns `not_renewing` for `autoRenew:false` (:176), writes the session before the gateway (:227), re-calls with the same key only when a pending session has no gateway id, records money only if it settled the session; `activateAfterTrial` writes a jsonb patch.
- **`src/venue-billing-routes.tsx`**: gate on the five cabinet routes (:161-:485); `/resume` also for `autoRenew:false` (:448) and clears the flag; `/me` without token, `autoRenew`, no trial dates while `pending_card` (:513); `/cron/charge-recurring` rewritten around lock (:569), account check, `renewFor` attempts (:674-:701), pre-written session (:728), settle; `extendVenuePeriod` (:853); `markVenueExpired` (:874) jsonb patch, `pauseVenueStreams`, `not_renewed` e-mail, `email=null` for closed accounts.
- **`src/venue-trial.tsx`**: account status in the scan, `chargeable` (:267); closed → expire `account_closed` without e-mail or reminders; `not_renewing` → `not_renewed`; guarded jsonb writes; reminders without an amount for `autoRenew:false` (:375).
- **`src/venue-plans-constants.tsx`**: `isVenueAutoRenewOff` (:113), `getVenueNextCharge` null for it (:134).
- **`src/email-helper.tsx`**: reason `not_renewed` (:815, :887). Music output for the existing reasons unchanged (`be-email-site` 34/34).
- **`src/promo-air-admin-helpers.tsx`**: `planAssignmentData` writes `autoRenew:false` (:310); `restoreTarget` (:191).
- **`src/promo-air-admin-routes.tsx`**: `has_card` requires the source (:76); `cutVenueAccess` cancels trial/active (:430, response/audit field `cancelledSubscription`); restore target from `statusBeforeBlock` (:461, :508).
- **`src/venue-station-routes.tsx`**: `requireVenueAccount` on `POST /` and `PUT /` (:274, :334).
- **`src/venue-radio-routes.tsx`**: receipt e-mail on `/subscribe` (:154).
- **`scripts/sql/promoair-cleanup-venue-profiles.sql`**: value checks for `apply` / `allow_diff`.
- **Docs**: §1 migration heredoc, §2 `CRON_SECRET` line and pending-renewal note, §3 block / restore / plan / `hasCard` texts, `PRODUCT_FACTS.md` venue billing and admin sections.

### API contract changes (frontends)

| Endpoint | Change |
|---|---|
| `/venue-billing/{me,subscribe,attach-card,cancel,resume}`, `POST/PUT /venue-station` | 403 `{success:false, code:'venue_only'}` unless `users.role='venue'` and `status='active'`, or admin |
| `GET /venue-billing/me` | `savedCard.gatewayMethodId` removed; new `subscription.autoRenew`; `expiresAt` / `trialExpiresAt` null while `pending_card` |
| `POST /venue-billing/resume` | also 200 for `active`/`trial` with `autoRenew:false` (turns renewal on; card required) |
| `GET /checkout/methods`, `GET /payments/payment-methods`, `GET /settings/user/:id/payment-methods` | no `gatewayMethodId` / `source` |
| `POST /checkout/create-session` | 400 for `metadata.type` starting with `venue_` |
| `POST /promo-air-admin/venues/:id/block` | adds `cancelledSubscription`; the venue's trial/active subscription becomes `cancelled` |
| `POST /promo-air-admin/venues/:id/restore` | target = status before the block (`pending` / `rejected` / `inactive` / `active`) |
| `POST /promo-air-admin/venues/:id/plan` | writes `autoRenew:false`; never charged |

The frontend types `savedCard.gatewayMethodId` (`fe/src/utils/api/venue-billing.ts:33`, `fe/src/promoair/api/cabinet-core.ts:50`) are not read anywhere; the field is simply absent now.

### New env vars / migrations

None. Migrations 160/161/162 and the cleanup are unchanged in content (160's apply heredoc gained `lock_timeout`).

### Verification (done locally)

```bash
~/Projects/promoair/bin/tsc-api.sh        # 8 errors, all from the baseline (same set as before this section)
cd ~/Projects/promoair/api
npx tsx ../tools/be-site-origin.test.mts  # 14
npx tsx ../tools/be-billing.test.mts      # 7 (+ autoRenew next charge, Idempotence-Key ≤ 64)
npx tsx ../tools/be-admin.test.mts        # 8 groups (+ restoreTarget, autoRenew:false)
npx tsx ../tools/be-security.test.mts     # 13
mkdir -p .tmp-email-check && cp ../api-orig/src/email-helper.tsx .tmp-email-check/email-helper-orig.tsx \
  && npx tsx ../tools/be-email-site.test.mts .tmp-email-check/email-helper-orig.tsx; rm -rf .tmp-email-check   # 34
D=<dir with @electric-sql/pglite-socket@0.2.11>
npx tsx ../tools/be-billing-e2e.test.mts $D    # 29 (19 + 10 review sections)
npx tsx ../tools/be-admin-e2e.test.mts $D      # 13 (block cancels the subscription, exact restore, autoRenew)
npx tsx ../tools/be-security-e2e.test.mts $D   # 17 groups
```

- New e2e sections in `be-billing-e2e` (PGlite, prod schema, YooKassa mocked): crafted 500 ₽ card-check sessions are not refunded and start no trial, create-session refuses `venue_*`; posted tokens dropped, raw token rows not chargeable, no token in 4 client responses; artist/blocked venue 403 on 5 billing routes and the questionnaire, admin 200; pending renewal waited for across a day change, extended once after the webhook, money booked once; banned active/trial/cancelled venues never charged and get no e-mail; paid efir keeps streams on, unpaid ones paused; admin plan/trial never charged, `/resume` re-enables it; re-binding after the trial end keeps the end and the `venue-first-…` key; pending first charge settles through the webhook; another payer cannot activate a station row; no trial date before the card.
- Mutation check on a scratch copy of `src/`: reverting the card-check predicate, the `source` filter, the in-flight renewal check, the trial-cron account check or the M4 end-date rule each made the billing e2e fail at the matching section.
- Prod, read-only: `\d payment_sessions`, `\d venue_radio_subscriptions`, `audit_logs` columns, venue users by status (5 active, 1 pending), the cleanup junk set (unchanged, 11 ids), tokenised `payment_methods` (0). psql `\if` semantics checked with a meta-only script (no SQL); the script was written to `/tmp` on the server for that and removed right after.
- Not possible locally: the advisory lock (PGlite is one backend session, locks are re-entrant). The code is the trial cron's proven pattern with its own key.

### Deploy order (replaces the order spread over §1-§4; the lead runs it)

1. **Backups**: `sudo -u postgres pg_dump -d promofm -Fc -f /root/backups/promofm_$(date +%F_%H%M).dump` (full), plus the `venue_profiles` dumps from §2.
2. **Cleanup** (§2): dry-run (`-v apply=0` or no `-v`), read the previews and the guard, then `-v apply=1`. Re-checked read-only on 20.10: the junk set is still exactly the 11 guarded ids (12 rows in total), and `payment_methods` has 0 rows with a token.
3. **Migrations** in any order, each dry-run then COMMIT: 160 (with `SET LOCAL lock_timeout='5s'`), 161, 162.
4. **Code**: deploy, `systemctl restart promofm-api` with `PROMOAIR_ORIGIN` empty. Check `journalctl -u promofm-api --since '5 min ago' | grep -iE 'error|venue_only'`.
5. **CRON_SECRET** (§2, printf line), restart.
6. **One real 1 ₽ binding** with a test venue account (§2 «Checks on prod»): session `succeeded` → `refunded`, `payment_methods.data` has `gatewayMethodId` **and** `"source":"gateway_webhook"`, trial 7 days, money back, the refund log line is `venue_card_attach_refunded` (if it is `venue_card_attach_refund_failed` with a receipt error, the shop needs a different receipt setup: tell me).
7. **Timers** (§2): one manual run of each unit (expect `"scanned":0` or only the test venue), then enable. Safe now for `charge-recurring` (review B1/M1/M2 fixed).
8. **nginx promoair.ru**: headers from §1 on every `/server/` block; `www.promoair.ru` → `301 https://promoair.ru$request_uri` (cookies are host-only); `/air/dj-api/` restriction from §4 on promo-music.ru.
9. **`PROMOAIR_ORIGIN=https://promoair.ru`** once `https://promoair.ru/server/health` answers, restart.

Manual checks after deploy:
- As an artist: `GET /server/api/venue-billing/me` → 403 `venue_only`; as a venue → 200 without `gatewayMethodId`.
- `POST /server/api/checkout/create-session` with `metadata.type:'venue_card_attach'` → 400.
- Admin: block a test venue with a trial → its `subscriptionStatus` is `cancelled`; restore → previous account status.
- Admin: assign a plan to the test venue → `/venue-billing/me` shows `autoRenew:false`, `nextChargeAt:null`.
- After the first renewal day: `SELECT order_id, status, data->'metadata'->>'renewFor' FROM payment_sessions WHERE order_id LIKE 'venue-renew-%' ORDER BY created_at DESC LIMIT 5`.

### Open risks / not done

- **Card not saved by the gateway** (money m2, deferred): trial still starts with `cardSaveFailed` / `cardRequired`; no charge happens, the venue expires at the end with an honest e-mail. Making it stay `pending_card` needs the promoair cabinet to handle that state after the card return.
- **Refund receipt** (security m3): mirrors the payment receipt; only the first real binding proves the shop accepts it.
- **Pending charge of a venue that gets blocked meanwhile**: the cron stops waiting (account closed → expired); if the gateway later confirms the payment, it is recorded by the webhook but nothing is extended. Refund by hand (admin), as for other blocked payers.
- **Two entitlement sources remain** (`venue_profiles.data` tiers vs `venue_radio_subscriptions`): M6 only stops one from pausing the other. Pick one before taking efir payments at scale.
- **Admin in the venue cabinet**: an admin may still open `/venue-billing/me` (creates an admin `venue_profiles` row, as before) and could even bind a card; the crons would charge an admin who does that. Deliberate: PLAN §3.5 lets admins into the cabinet.
- **Not in code, still open from the reviews' PLAN §4 lists**: venue-campaign CTA switch (launch decision), migration 160 dry-run on prod, AutoDJ nginx restriction and `X-Internal-Key` rotation, `requireAuth` / `/auth/me` status check, station-request `reject` status guard (pre-existing), frontend items (`/?chat=&t=` restore, `email-logo.png`, `account_pending` handling, `cardSaveFailed` after the card return).

---

## 6. PHASE 3 FIXES: flows, regression, copy and visual reviews (20.10.2026)

**Goal.** Four phase-3 reviews (flows, promo-music regression, copy, visual) plus the known backend items. Each backend finding was checked against the code before it was fixed. There are no new env vars and no new migrations. Nothing here depends on `PROMOAIR_ORIGIN`. promo-music.ru behaves as before, except for the shared bug fixes marked **(both sites)**.

### Verdicts

| # | Finding | Verdict |
|---|---|---|
| flows M1 | Notifications could never be marked read: `getNotification` looked up `id = userId:id`, while every writer stores `id` | **fixed (both sites)**. `getNotification` matches `id` AND `user_id`, and falls back to the old composite id. It returns the same shape as the list (rich `data` plus columns), so get+upsert no longer blanks rows whose `data = {}`. The venue `PUT /notifications/:id/read` is a single UPDATE (`is_read`, `status='read'`, `read_at`, `data.read`) and answers 404 when the user has no such row. Every caller is now scoped to the session user: `notifications-routes` read/delete use `requireOwner`; `notifications-messenger` read/star/delete use the session user, and a different `user_id` gets 403 unless the caller is an admin. Before, those routes trusted the client's `user_id`, which would have become an IDOR once the lookup started working |
| flows M2 | Cabinet and admin showed «Мое заведение · bar · Москва»; up to 3 «new venue» e-mails per venue; junk rows for admins | **fixed**. `GET /api/venue/profile` returns 404 `{error:'not_a_venue'}` for any non-venue role, admins included, and uses `ensureVenueProfile`. `ensureVenueProfile` takes `venueName` from `users.full_name` (the venue name on promoair sign-ups), takes `contactName` from the application, and writes `venue_type`/`city`/`country`/`capacity` as NULL (the column DEFAULTs `club`/0 are overridden). It inserts with `ON CONFLICT DO NOTHING RETURNING`, so only the call that inserted the row sends the e-mail. Nothing on promo-music.ru reads the old defaults (checked: backend has no comparison with them; the old cabinet falls back on empty values client-side) |
| flows M3 | A cancelled YooKassa payment came back as «оплата прошла» | **fixed (backend side)**. Both return URLs carry `&order=<orderId>`. `GET /checkout/session/:orderId` (owner only, 403 for anyone else, admins included) maps venue orders as follows: `processing` → `pending`; the 1 ₽ check after its refund → `succeeded`; `canceled` and `succeeded` pass through; a refunded paid order → `refunded`. Non-venue payments are unchanged |
| flows M5 | «Оставить заявку» on «Радио полного цикла» switched hosts and podcasts on for free | **fixed**. `POST /venue-air/my/live-air {enabled:true}` now only records `format.liveAirRequestedAt` and sends the team one request e-mail plus Telegram; it does not change `airType` and does not touch `host_enabled`. A repeat call does not send a second e-mail. `GET /my` returns `liveAirRequested` and `liveAirRequestedAt`. Podcasts also require full radio: `startVenuePodcast` (cabinet, Telegram, scheduler) is gated like the hosts. The same hole through the questionnaire is closed too: `PUT /venue-station` on a request that is already provisioned or live turns a switch to `full_radio` into the same request. The team switches it on with the new `POST /venue-air/admin/live-air/:userId` (below). `enabled:false` from the cabinet still switches off (as before) and withdraws a pending request |
| flows m1 | Reset, auto-login and chat tokens were stored in `page_views.path` | **fixed server-side** (the frontend fix is separate): `/analytics/pv` strips `token` and `auto_login_token`, and strips `chat` + `t` when `chat` is present |
| flows m4 | `exchange-auto-login` set no refresh cookie | **fixed**: `createRefreshToken` + `setRefreshCookie`, same as `/signin`; a failure is logged and the login still succeeds |
| flows m6 | `cardRequired` was true for an admin-assigned trial without a card | **fixed**: `status==='trial' && !card && autoRenew !== false` |
| flows m7 | Autocharges stayed «В обработке» forever | **fixed**: the `payment_txns` row of the trial-end charge and of the renewal is written as `completed`; both are written only after the gateway reports `succeeded`. The `content_order` category filter is in the frontend |
| flows m9 | Venues got «Загрузите свой первый трек» as their welcome | **fixed**: venues get «Добро пожаловать в PROMO.AIR!» (or ПРОМО.МУЗЫКА for promo-music sign-ups) with a link to the questionnaire (`actionUrl /venue/onboarding`). Other roles keep the old text |
| regression m2 | promo-music admin visitor stats mixed in promoair.ru | **fixed**: `/analytics/live` and `/analytics/stats` exclude `host IN (promoair.ru, www.promoair.ru)`. Without the `host` column (160 not applied) they catch 42703, set the flag and run unfiltered as before |
| regression m4 | The artist renewal could charge a method without a gateway token | **fixed**: `subscriptions-routes` uses `getChargeablePaymentMethod` (gateway webhook card only). There is no timer for this cron |
| regression M1 / m1 / m3 / m5 | Deploy coupling, payload, admin label, remount | frontend / deploy (not in `api/`) |
| copy M2 | «приоритетная поддержка» was not implemented | **fixed**: `POST /tickets-system/create` from a venue whose effective plan has `prioritySupport` (Бизнес, Сеть, корпоративный, trial included) gets at least `high` (SLA 24 h), whatever the client sends. A venue's own `PUT` cannot change the priority. Other roles and plans are unchanged |
| copy M8 | The admin was told an assigned plan would be charged | **fixed (backend side)**: `VenueRow.subscription.autoRenew` (false = assigned by an admin, no charge) |
| copy M9 | Admin-trial venues got the old T-3 / T-1 e-mails about a «бесплатный режим» | **fixed**. New texts follow the review: «Автосписания по этому пробному периоду нет…», «эфир приостановится», no API or priority claims, prices in ₽. They are sent for every PROMO.AIR reminder without a charge amount, and on both sites when `autoRenew:false` (`venue-trial` passes `noAutoRenew`). Music reminders for the old flow are byte-identical |
| copy M10 | «Ответьте на это письмо» while Reply-To is noreply | **fixed for air** (payment expired → «напишите нам на info@promofm.ru»; chat reply → «Ответить можно там же, в чате»). Music wording unchanged (deferred, owner's call) |
| copy m3–m11 (api) | Welcome code wording, time promises, «дн.», playlists in the expiry e-mail, «сгенерируйте», `4990 RUB`, sender/footer brand, Telegram brand, English verify page | **fixed**. Air: «код подключения из 6 символов, приложение PROMO.AIR для Android скачивается в кабинете», «обычно за 1–2 рабочих дня» with an en dash; the «1 рабочий день» line is removed from the changes-requested e-mail; `daysRu()` replaces «дн.» (charge reminders on both sites, a new path); no playlists; «получите новый код»; `rub()` amounts and the subject «Оплата не завершена: 4 990 ₽»; sender `"PROMO.AIR" <noreply@promo-music.ru>` (same address, so SPF and DKIM are unchanged); footer «от PROMO.MUSIC»; Telegram help says «в PROMO.AIR». Verify interstitial: «Подтверждение почты» / «Подтверждаем почту…» (both sites, text only). The welcome line «обычно в течение рабочего дня» stays (the review gave no replacement) |
| copy m20 | The admin «Владелец» field showed the venue name | **fixed (backend side)**: `VenueRow.contactName` (+ `profile.contactName` in the detail). Sign-up stores `applicationDetails.contactName`. The `?q=` search also matches it |
| visual m8 | The demo manifest was cached for 30 days at an unhashed URL and sent without gzip | **nginx**: `notes/deploy/promoair.ru.includes` has `location = /server/uploads/air-demo/manifest.json` (no-cache + ETag + gzip). promo-music.ru needs the same block; see the RUNBOOK. Dropping `?t=` is a frontend change |
| KNOWN contactName | Not stored | **fixed**, as copy m20 |
| KNOWN change-password | Read the Bearer header only | **fixed (both sites)**: cookie session first, Bearer kept; `token_version` checked as in `requireAuth`. After a change: refresh tokens revoked and cookies cleared, so «все сессии завершены» is now true. promo-music's settings page and the DJ settings were getting 401 until now |
| KNOWN support replies | The venue bell did not show ticket replies | **fixed**: a team reply (not an internal note) to a venue's ticket also writes a `notifications` row (`type:'support'`, `actionUrl /venue/support?ticket=…`). The cross-cabinet row is still written, independently |
| KNOWN cron secret | Compared with `!==` | **fixed**: `security.tsx:secretMatches` (sha256 + `timingSafeEqual`) in all four cron endpoints (venue expire-trials, venue charge-recurring, stream-player tick, artist charge-recurring). The other shared secrets (publish webhook, Telegram webhook) are not cron secrets and are untouched |
| KNOWN internal notes | Returned to the ticket owner | **fixed**: `internal_note:true` messages are filtered for non-admins in `GET /user/:id`, `GET /:id`, `GET /:id/messages` and the `PUT` and `rate` responses. A non-admin cannot create one (forced false). A non-admin `PUT` cannot rewrite `messages`, `user_id` or `id` |
| KNOWN urgent | The flag changed the price only | **fixed (best effort)**: after the INSERT, `content_orders.data` gets `{urgent, styleTier}` in a separate UPDATE, and `order.urgent` is returned. If `data` is missing on prod the order is still created and a warning is logged (`content_orders.data` is used by the existing notes update but was not checked on prod) |

### What changed

- `src/security.tsx`: `secretMatches()`.
- `src/db.tsx`: `mapNotificationRow`, `getNotification` (id AND user_id), `markNotificationRead`, `ensureVenueProfile` (real name and contact, no invented fields, insert-only e-mail).
- `src/venue-routes.tsx`: `GET /profile` (venue role only, `ensureVenueProfile`), `PUT /notifications/:id/read` (UPDATE, 404), cron secret.
- `src/notifications-routes.tsx`, `src/notifications-messenger-routes.tsx`: owner checks (see M1).
- `src/tickets-system-routes.tsx`: `visibleMessages` / `ticketForViewer`, `ticketPriority`, non-admin `PUT` guard, venue bell row on a reply.
- `src/auth-routes.tsx`: `storeVenueApplication` (signup), venue welcome notification, verify page in Russian, `change-password` with the cookie, refresh cookie in `exchange-auto-login`.
- `src/venue-billing-routes.tsx`: `&order=` in both return URLs, `cardRequired`, renewal txn `completed`, cron secret. `src/venue-billing-helpers.tsx`: trial-end txn `completed`.
- `src/checkout-routes.tsx`: `publicSessionStatus()` for `GET /session/:orderId`.
- `src/venue-air-routes.tsx`: `liveAirOn`, `notifyLiveAirRequest`, `/my/live-air` as a request, `GET /my` fields, podcasts gated, `POST /admin/live-air/:userId`, Telegram brand.
- `src/venue-station-routes.tsx`: `PUT /` keeps `airType` and records the request after launch; it also keeps an earlier `liveAirRequestedAt` across edits.
- `src/promo-air-admin-helpers.tsx`, `src/promo-air-admin-routes.tsx`: `contactName`, `subscription.autoRenew`, `CONTACT_NAME_SQL` (row and `?q=`).
- `src/content-orders-routes.tsx`: urgent flag. `src/email-helper.tsx`: air copy, `senderFor`, `daysRu`, `noAutoRenew`. `src/venue-trial.tsx`: passes `noAutoRenew`.
- `src/pageview-routes.tsx`: `withSiteFilter`, `scrubPath`. `src/subscriptions-routes.tsx`: chargeable card, cron secret. `src/stream-player-routes.tsx`: cron secret.

### API contract changes (frontends)

| Endpoint | Change |
|---|---|
| `GET /api/venue/profile` | 404 `{success:false, error:'not_a_venue'}` for every role except `venue`. New profiles: `venueName` from sign-up or null; `venueType`/`city`/`country` null or absent; `contactName` when given at sign-up |
| `PUT /api/venue/notifications/:id/read` | persists; 404 `{error:'Notification not found'}` when the user has no such notification |
| `/notifications-messenger/:id/read\|star`, `DELETE /:id` | work with the session user (no `user_id` needed); a foreign `user_id` → 403 |
| `/notifications/:userId/:id(/read)` | `userId` must be the session user (403) |
| YooKassa return URLs | `/venue/subscription?payment=success&tier=<t>&order=<id>`, `?card=attached&order=<id>` |
| `GET /checkout/session/:orderId` | venue orders: `status` ∈ `pending \| succeeded \| canceled` (`refunded` only for a refunded paid order). Owner only |
| `POST /venue-air/my/live-air` | `{enabled:true}` → `{liveAir:false, liveAirRequested:true, liveAirRequestedAt}` (or `liveAir:true` if the team already switched it on); `{enabled:false}` → off + request withdrawn |
| `GET /venue-air/my` | `liveAirRequested: boolean`, `liveAirRequestedAt: string\|null` |
| `POST /venue-air/my/podcast` | 400 «Подкасты входят в «Радио полного цикла»…» unless full radio is on |
| `POST /venue-air/admin/live-air/:userId` **(new, admin)** | `{enabled: boolean, reason?}` → `{liveAir, requestId}`; 404 without a questionnaire; audit `venue_live_air_on/off` |
| `GET /promo-air-admin/venues(/:id)` | `row.contactName`, `row.subscription.autoRenew`; detail `profile.contactName` |
| `POST /tickets-system/create` | venue on Бизнес/Сеть: `priority` ≥ `high` |
| ticket reads | no `internal_note:true` messages for non-admins |
| `POST /auth/change-password` | cookie session; on success clears `pf_session`/`pf_refresh` |
| `POST /auth/exchange-auto-login` | also sets `pf_refresh` |
| `GET /venue-billing/me` | `cardRequired` false when `autoRenew:false` |
| content order JSON | `urgent: boolean` |

### Switching «Радио полного цикла» on (team)

No UI yet. The admin, logged in at promo-music.ru, runs this in the browser console on any `/ctrl-pm7k2f` page:

```js
await (await fetch('/server/api/venue-air/admin/live-air/<venue userId>', {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: true, reason: 'согласовано, 20 000 ₽/мес' }),
})).json()
```

`enabled:false` switches it off. The price is billed outside the cabinet (there is no online checkout for full radio, PLAN §1). Requests waiting for the team:

```sql
SELECT u.email, r.user_id, r.format->>'liveAirRequestedAt' AS requested_at, r.format->>'airType' AS air_type
  FROM venue_station_requests r JOIN users u ON u.id::text = r.user_id
 WHERE r.format ? 'liveAirRequestedAt' ORDER BY 3;
```

SQL fallback (same effect as the endpoint, without the audit row): `UPDATE venue_station_requests SET format = (jsonb_set(format, '{airType}', '"full_radio"') - 'liveAirRequestedAt') WHERE id = '<request id>'; UPDATE venue_station_streams SET host_enabled = NULL WHERE user_id = '<venue userId>';`

### Verification (done locally)

```bash
~/Projects/promoair/bin/tsc-api.sh        # 6 errors, all from the baseline; the 2 venue-routes ones are gone with the rewritten GET /profile
cd ~/Projects/promoair/api
npx tsx ../tools/be-site-origin.test.mts  # 14
npx tsx ../tools/be-billing.test.mts      # 7
npx tsx ../tools/be-admin.test.mts        # 8 groups (+ contactName, autoRenew, contact search)
npx tsx ../tools/be-security.test.mts     # 13
mkdir -p .tmp-email-check && cp ../api-orig/src/email-helper.tsx .tmp-email-check/email-helper-orig.tsx \
  && npx tsx ../tools/be-email-site.test.mts .tmp-email-check/email-helper-orig.tsx; rm -rf .tmp-email-check   # 35: music byte-identical, air sender/copy
D=<dir with @electric-sql/pglite-socket@0.2.11>
npx tsx ../tools/be-billing-e2e.test.mts $D    # 29
npx tsx ../tools/be-admin-e2e.test.mts $D      # 13
npx tsx ../tools/be-security-e2e.test.mts $D   # 17 groups
npx tsx ../tools/be-phase3-e2e.test.mts $D     # 9 groups (new, this section)
```

`be-phase3-e2e` (PGlite, prod schema plus the tables from 152/048/160 and content_orders) covers: the profile 404 for an artist or admin without a junk row, and 4 concurrent creators → 1 row and 1 e-mail; sign-up contact → admin; notification read (rich, data-less, legacy ids), the count dropping, 404 for unknown and foreign ids, the shared routes limited to the owner; the full-radio request, the questionnaire edit after launch, the admin switch with audit; the payment-status mapping and owner-only access; tickets (notes, priority, PUT guard, bell); change-password with the cookie; refresh after auto-login; page-view filter and fallback; urgent; `cardRequired`; cron secret.

### Deploy order

No new migration, env var or timer. The final order is in `notes/deploy/RUNBOOK.md` and `notes/phase3-fix-be.md` (backups → cleanup → 160/161/162 → code → `CRON_SECRET` → timers → nginx → `PROMOAIR_ORIGIN` → checks). Two nginx additions: the demo manifest block on both vhosts.

### Open risks / not done

- `content_orders.data` was not checked on prod. The flag is best effort; `\d content_orders` at deploy tells.
- `GET /api/venue/profile` now answers 404 to admins. The promoair cabinet handles a null profile («Ваше заведение»). `SystemTestSuite` («Профиль площадки») will show that call as a 404 for the admin.
- The music-site wording of the payment-expired and chat-reply e-mails still says «ответьте на это письмо» (owner's call; changing it breaks the byte-identical promo-music contract).
- The full-radio switch has no admin UI (console snippet above). The price for full radio is not billed online.

---

## 7. CONNECT: the venue sign-up is the application; PROMO.AIR on its own (21.10.2026)

**Goal.** Owner decision: one form. Registration on promoair.ru *is* the application for connecting a venue; the account stays `pending` until the team approves it by hand (unchanged, §3/§4). The team gets what it needs to call the venue before approving. Second owner decision: «система кабинетов и радио остается на promoair.ru, без перехода на promo-music.ru; внизу просто логотип, название фирмы, данные». No new migration; one new optional env var in §8.

### What changed (backend)

- **`src/venue-application.tsx` (new, pure).** `VENUE_TYPE_LABELS` (the cabinet profile's values: cafe, restaurant, bar, lounge, club, shop, hotel, spa, gym, other), `VENUE_POINTS_LABELS` (`1`, `2-4`, `5+`), `normalizeVenuePhone` (Russian numbers → `+7XXXXXXXXXX`: `8 900…`, `7 900…`, `+7 900…`, ten digits `900…`; others → `+<digits>`; 10 to 15 digits, letters refused), `parseVenueApplication(details, {required})`, `isPromoAirSignup(site, details)`.
- **`src/auth-routes.tsx` `/signup`, role `venue` only.** Before the INSERT (like the radio validation): when the sign-up comes from promoair.ru (`signupSiteFromRequest = 'air'`) or carries `applicationDetails.source = 'promoair'`, the application is required. 400 bodies, all `{success:false, error, field}`:

  | Field | When | `error` |
  |---|---|---|
  | `phone` | missing | `Укажите телефон для связи` |
  | `phone` | not 10–15 digits | `Проверьте номер телефона: нужно от 10 до 15 цифр` |
  | `city` | shorter than 2 | `Укажите город` |
  | `venueType` | missing | `Укажите тип заведения` |
  | `venueType` | not in the list | `Выберите тип заведения из списка` |
  | `points` | given but not `1`/`2-4`/`5+` | `Укажите, сколько у вас точек: 1, 2–4 или 5 и больше` |

  Stored in `users.settings.application` next to `contactName`: `{submittedAt, contactName, venueName, source, phone, city, venueType, points}` (trimmed, whitespace collapsed, contact 120, venue 200, city 120 chars; points default `1`). The old promo-music.ru form (venue without `applicationDetails`) is not validated and stores nothing, as before. Artist, radio, label and all other roles: same code path as before (tested byte for byte, below).
- **`src/email-helper.tsx` `notifyNewUser`.** For `role='venue'` with an application: rows Контактное лицо, Телефон (`<a href="tel:+7…">`, href digits and `+` only), Город, Тип (Russian label), Точек (`1`, `2–4`, `5 и больше`), everything escaped, instead of the JSON row. The Telegram copy adds `Контакт / Телефон / Город / Тип / Точек`. Recipients unchanged (`ADMIN_EMAILS`). Radio keeps its JSON row; every other admin e-mail is byte-identical.
- **`src/db.tsx` `ensureVenueProfile`.** A new profile takes `venue_type` (only a value from the list), `city` and `phone` from the application (native columns and `data`); no application → NULL as before.
- **Admin (`promo-air-admin-helpers.tsx`, `-routes.tsx`).** `VENUE_PHONE_SQL`, `VENUE_CITY_SQL`, `VENUE_TYPE_SQL`, `VENUE_POINTS_SQL` (profile first, then the application; a venue on review has no profile yet). `VenueRow` gains `phone`, `city`, `venueType`, `points` (`'1'|'2-4'|'5+'|null`; the questionnaire count stays `request.points`). `?city=` and `?q=` also match the application city.
- **PROMO.AIR e-mails.** Footer `© <year> PROMO.AIR · ООО «Промо Фм» · ИНН 5038195100 · info@promofm.ru` (was «… музыка для заведений от PROMO.MUSIC»). Checked: no PROMO.AIR e-mail (25 variants) mentions or links promo-music.ru / PROMO.MUSIC in its body; the sender address stays `noreply@promo-music.ru` (SPF/DKIM).
- **Venue streams.** `services/promo-air-venue/promo-air-venue`: `PUBLIC=https://promoair.ru/air/live` (new streams print `https://promoair.ru/air/live/venue-<slug>` for the provisioning form). promoair.ru proxies `/air/live/` to the same stream server (`notes/deploy/promoair.ru.includes`). Existing rows keep their promo-music.ru URL; `VENUE_MOUNT_RE` (API) and the cabinet regex accept both hosts. Use the script change only once promoair.ru answers over HTTPS.

### Frontend (for reference)

`fe/src/promoair/auth/AirAuthPage.tsx`: Телефон (`type=tel`, `autocomplete=tel`, `inputmode=tel`, shown as `+7…` after blur), Тип заведения (select, the cabinet list), Город, Сколько точек (1 / 2–4 / 5 и больше), two columns on desktop, one on phones, 16px inputs and 44px chips on phones; body `applicationDetails = {venueName, contactName, phone, city, venueType, points, source:'promoair'}`. A 400 with a field lands under that field. Admin: VenueDetailDialog («Позвонить», Телефон, Тип, Город, Точек при регистрации), ModerationTab cards, the table and the pending list use the new row fields. promo-music.ru: the PROMO.AIR landings (`/promo-air` and its `/promo-air/*` pages, demo, the alias routes of `PromoAirRoute`) send «Подключить» to `https://promoair.ru/login?mode=signup` (full page). New footer on the site, auth pages and cabinet (`ui/OperatorFooter.tsx`), logo subtitle «BY PROMO.MUSIC» removed, Profile «Открыть PROMO.MUSIC» and the Ads radio-integration link removed, legal pages say «Оператор сервиса PROMO.AIR: ООО «Промо Фм», ИНН 5038195100, ОГРН 1255000110661.», `promoair.html` Organization JSON-LD has `legalName`/`taxID`/ОГРН instead of `parentOrganization: PROMO.MUSIC`.

### Verification (done locally)

```bash
~/Projects/promoair/bin/tsc-api.sh     # 6 errors, all baseline
cd ~/Projects/promoair/api
D=<dir with @electric-sql/pglite-socket@0.2.11>
npx tsx ../tools/be-venue-signup.test.mts $D   # 8 groups (new)
mkdir -p .tmp-email-check && cp ../api-orig/src/email-helper.tsx .tmp-email-check/email-helper-orig.tsx \
  && npx tsx ../tools/be-email-site.test.mts .tmp-email-check/email-helper-orig.tsx; rm -rf .tmp-email-check   # 39
```

`be-venue-signup` (PGlite, prod schema, real auth/venue/admin routes): phone normalisation identical in backend and frontend; the stored application; 400 for missing/invalid phone, city, type and bad points with no user row and no e-mail; the admin e-mail rows and the Telegram text (escaped); the old promo-music.ru venue form, artist and label (real sign-ups): same response and an admin e-mail byte-identical to `api-orig`'s `notifyNewUser`; radio_station: the same 400 and the same admin e-mail (compared directly: a real radio sign-up trips a pglite-socket reply mix-up in this harness, about 2 runs in 5, while the radio code path itself is untouched); profile seeded with city/type/phone; admin rows before approval (from the application) and after a cabinet edit (profile wins); city filter and search. Updated for the intended change: `be-admin` (city filter SQL), `be-security-e2e` and `be-phase3-e2e` (their promoair.ru venue sign-ups now send the application), `be-email-site` (air footer, no promo-music.ru in any air body).

### Deploy

No migration, no env var for this section. Frontend and API go together (the promoair form sends fields the old API ignores; the new API refuses a promoair sign-up without them). **The promo-music.ru PROMO.AIR CTAs point to promoair.ru: deploy that frontend only when promoair.ru answers**, otherwise those buttons lead nowhere.

---

## 8. VK ID on promoair.ru: VK ID, Одноклассники, Mail.ru (21.10.2026)

**Goal.** Owner decision: venues can sign in and apply with VK ID and its alternatives (OK, Mail.ru). Separate VK ID app for promoair.ru: **54840499** (promo-music.ru keeps app 54426299 and its own `/auth/vk-callback`, unchanged). OK and Mail.ru come back through the same VK ID code, so it is one integration. The account still stays `pending` until approved.

### Flow

1. The auth page (`/login`, login and sign-up modes) loads `@vkid/sdk@2.6.8` UMD from `https://unpkg.com/@vkid/sdk@2.6.8/dist-sdk/umd/index.js` (SRI `sha384-h6nfHl7mxue2dpO+9z/y0r2nJDYXEr2P7VqkjeSje3deuALsUXtDqYK/MPNoKl+O`, `crossorigin=anonymous`), only when the block mounts. If it does not load, the block is not shown. `VKID.Config.init({ app: VITE_PROMOAIR_VK_APP_ID || 54840499, redirectUrl: window.location.origin, responseMode: Callback, source: LOWCODE, scope: 'email phone' })`, `new VKID.OAuthList().render({ container, oauthList: ['vkid','ok_ru','mail_ru'], styles:{height:48, borderRadius:12} })`.
2. On `OAuthListInternalEvents.LOGIN_SUCCESS` the browser calls `VKID.Auth.exchangeCode(code, device_id)` and sends `POST /server/auth/vk-air {access_token, mode}`.
3. **`POST /auth/vk-air`** (`src/auth-routes.tsx`): only when `siteFromRequest(c) === 'air'` (i.e. on promoair.ru with `PROMOAIR_ORIGIN` set), otherwise 404 and VK is not called. The token is checked with `POST https://id.vk.com/oauth2/user_info` (form `client_id=PROMOAIR_VK_APP_ID||54840499`, `access_token`; a token of another app is refused by VK). Identity comes only from that answer (`user_id`, name, e-mail lower-cased, phone via `normalizeVenuePhone`, https avatar). Then:
   - `users.vk_id` matches → `accountBlockOf` gate (403 with the `/signin` bodies) → `pf_session` (with the user's `token_version`) + `pf_refresh`, `last_login_at`. `{success:true, linked:false, data:{user:{id,email,name,role}}}`. Any role signs in; the promoair page shows its wrong-role screen for non-venues.
   - else the VK e-mail matches `users.email` (case-insensitive): pending/rejected/blocked → the 403 body and **no link**; linked to another VK ID → 409 `vk_other_linked`; active → `vk_id` set (avatar if empty) + session, `linked:true`.
   - else `200 {success:false, needsSignup:true, prefill:{name,email,phone}, emailVerified, vkTicket}`. No account is created here.
   - Bad token: 401 `Не получилось войти через VK ID. Попробуйте ещё раз.` Tokens are never logged.
4. **vkTicket** (`src/vk-air-ticket.tsx`): `base64url(JSON).base64url(HMAC-SHA256)` with `VK_AIR_TICKET_SECRET` or `JWT_SECRET`, payload `{v, n, vkUserId, email, emailFromVk, name, phone, avatar, exp}`, 30 minutes. The nonce is stored in `verification_tokens` (`token_type='vk_air_ticket'`, `user_id='vk:<id>'`) under an id derived with the secret (not usable as any other token).
5. The form switches to sign-up, fills Контактное лицо, Почта, Телефон, hides the password and shows «Вход через VK ID: <имя> · сменить». It sends the normal body plus `vkTicket`, without `password`.
6. **`/auth/signup` with `vkTicket`**, read only for `role='venue'` on site `air` (anywhere else the field is ignored and the sign-up behaves as before, e.g. 400 «Email и пароль обязательны»): bad, forged or expired ticket → 400 `{error:'Сессия VK ID истекла, войдите через VK ещё раз', code:'vk_ticket_expired'}`; the application is validated first (a 400 there does not burn the ticket); then the nonce is marked used atomically (reuse → the same 400); `vk_id` already linked → 409 `{code:'vk_id_taken'}`. Password optional (random bcrypt hash, as the VK branch). The user gets `vk_id` and `avatar_url`; `is_email_verified=true` and **no confirmation e-mail** when the submitted e-mail equals the VK e-mail (`emailVerificationRequired:false`, the page goes straight to «Аккаунт на проверке»); otherwise the normal confirmation e-mail. Status stays `pending`; the welcome e-mail and the admin notification (`via vk_oauth`, all application rows from §7) are sent.

### Env

| Var | Where | Default | Notes |
|---|---|---|---|
| `PROMOAIR_VK_APP_ID` | API `.env` | `54840499` | client_id for `user_info`; no secret needed for this flow |
| `VK_AIR_TICKET_SECRET` | API `.env` | `JWT_SECRET` | optional; rotating it invalidates open tickets (30 min) |
| `VITE_PROMOAIR_VK_APP_ID` | build (`fe/deploy.sh`, `.github/workflows/deploy.yml`) | `54840499` | next to `VITE_VK_APP_ID` |

If a Content-Security-Policy is ever added to promoair.ru, it must allow `https://unpkg.com` (script) and `https://id.vk.com`, `https://*.vk.com`, `https://*.mail.ru`, `https://*.ok.ru` (popup, stats).

### VK ID console (owner), app 54840499

- trusted redirect URL `https://promoair.ru` (exactly the page origin; the widget sends `window.location.origin`);
- base domain `promoair.ru`;
- scopes `email` and `phone` enabled (without `phone` the prefill has no phone; without `email` no e-mail match and no auto-confirmed e-mail);
- the OK and Mail.ru alternatives switched on.

### Verification (done locally)

```bash
cd ~/Projects/promoair/api && npx tsx ../tools/be-vk-air.test.mts $D   # 7 groups + the log check
```

`be-vk-air` (PGlite, prod schema, `id.vk.com` mocked): 404 from promo-music.ru with no VK call; 401 for a bad token and for a token of another app; `client_id` 54840499 (or `PROMOAIR_VK_APP_ID`) sent form-encoded; active venue by `vk_id` → session with the DB `token_version` and refresh cookie; pending and banned → the `/signin` 403 bodies, no cookie; e-mail match: pending 403 and not linked, active linked (case-insensitive), linked to another VK ID 409; unknown → needsSignup, prefill, 30-minute ticket, nonce row; sign-up with the ticket → pending venue with `vk_id`, avatar, verified e-mail, no confirmation link, welcome sent, admin `vk_oauth` with the application; forged / garbage / bad signature / expired / reused ticket → 400; ignored on promo-music.ru and for an artist; different e-mail → not verified, confirmation sent; VK ID taken → 409; plain sign-ups unchanged. The suite re-runs itself with `LOG_LEVEL=debug` and fails if any access token or ticket appears in the log output. Screens: `~/Projects/promoair/shots/connect/*_vk-*.png` (`tools/vk-shots.cjs`, the real 2.6.8 widget served from the same file, SRI checked).

### Manual check on prod (after `PROMOAIR_ORIGIN` and the console settings)

1. `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"access_token":"x"}' https://promo-music.ru/server/auth/vk-air` → 404; the same to `https://promoair.ru/server/auth/vk-air` → 401.
2. https://promoair.ru/login: three buttons under «Войти». VK ID with a test VK account that has no PROMO.AIR account → the sign-up form with name, e-mail and phone filled, no password field; send → «Аккаунт на проверке», no confirmation e-mail, admin e-mail «Через: vk_oauth» with the application.
3. `SELECT email, status, vk_id, is_email_verified FROM users WHERE vk_id IS NOT NULL AND signup_site='air' ORDER BY created_at DESC LIMIT 5`.
4. Approve it in the admin, press VK ID again → the cabinet opens. Try OK and Mail.ru once each.
5. `journalctl -u promofm-api --since '10 min ago' | grep vk_air` → `vk_air_needs_signup`, `vk_air_signin`, no tokens.
