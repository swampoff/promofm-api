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
