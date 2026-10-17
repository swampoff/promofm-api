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
\i /opt/promofm-api/src/migrations/160_promoair_site.sql
ROLLBACK;
EOF
# then the same with COMMIT, BEFORE restarting promofm-api with the new code
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
sudo -u promofm sh -c 'grep -q "^CRON_SECRET=" /opt/promofm-api/.env || echo "CRON_SECRET=$(openssl rand -hex 32)" >> /opt/promofm-api/.env'
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
  - The renewal cron keeps its old day-stamped orderId: a renewal still `pending` the next day may be charged again (existing behaviour, not changed).
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
- `subscription.status` defaults to `pending_card` (no profile or no status); `plan` is the stored tier (`null` if none); `hasCard` = a saved card with a gateway token (the one autocharge would use).
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

Any of `active | pending | rejected | inactive` → `banned`. In one transaction: `token_version + 1` (live sessions get 401), all refresh tokens revoked, streams `provisioned|live → paused`, venue API keys revoked. Sign-in with the password then returns 403. No e-mail to the venue.

```json
{ "success": true, "row": { "...": "VenueRow, accountStatus 'banned'" }, "pausedStreamIds": ["55555555-5555-4555-8555-555555555555"], "revokedApiTokens": 1 }
```

Already blocked: `409 {"success":false,"error":"conflict","status":"banned","kind":"account"}`.

#### `POST /venues/:userId/restore` `{reason?}`

`banned | blocked | suspended → active`. Streams stay paused and API keys stay revoked: resume streams with `/api/venue-station/admin/streams/:id/resume` (or a plan assignment, below); the venue issues new keys itself.

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
- **After `until` the usual crons apply:** with a saved card the plan is charged (renewal 3 days before the end, or the trial-end charge); without a card the venue expires. The admin UI should say so (`row.subscription.hasCard`).

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
- **Plan after `until` may charge the card.** An admin-assigned plan follows the normal billing rules: a venue with a saved card is charged the assigned tier at the end. There is no «don't renew» flag; changing the crons is out of scope. If a comp should not renew, assign it to a venue without a card, or cancel it in the cabinet.
- **Sign-in gate now refuses `'banned'`** (behaviour change on promo-music.ru, fixes the UsersManagement ban). Other entry points are SECURITY's: VK login (`auth-routes.tsx` VK callback) and `/auth/refresh` do not check `users.status`. VK sessions of a blocked user are still rejected right away by `token_version`, because VK tokens are signed with `tv=1`. `exchange-auto-login` is in SECURITY's list.
- **`/auth/admin/reject-user` stays broken until 162** (pre-existing). It has no status guard either; SECURITY owns the approve/reject guards in `auth-routes.tsx`.
- **`mark-live` sets `last_seen_at = NOW()`** without a device (`venue-station-routes.tsx` `setStreamStatus`). That is why «online» here also requires `paired_at`.
- **`ensureVenueProfile` on plan assignment** e-mails the admin «новое заведение» (stage `registered`) when the venue had no profile (4 of the 5 real venues today).
- **Restore leaves streams paused and API keys revoked.** Resume streams per point, or assign a plan (which un-pauses them).
- **Not done:** refunds, venue finance report, an «owner message» action (the existing AdminChat is a stub), station-request moderation (stays on `/api/venue-station/admin/*`), offline alerts.
- **Station `reject` has no status guard** (`/api/venue-station/admin/:id/reject`, pre-existing). I added audit logging only.
