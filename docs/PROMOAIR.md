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
