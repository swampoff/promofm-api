# Product Facts — promofm-api (backend)

**The verified, sourced-from-code reality of what the platform does.**

Use this file as **ground truth** when answering customer questions,
debugging "is the feature implemented?" doubts, or writing marketing
copy. Do NOT rely on memory or paraphrase from this session — open
this file, find the section, cite the file:line.

**Updating this file** is part of every PR that changes a fact below.
If a price changes / feature ships / mechanic gets redesigned —
update the entry in the SAME commit. Stale entries here are worse
than no entries because they look authoritative.

When in doubt, cross-reference against the code at the cited
file:line.

---

## Subscriptions — artist tiers

**Source of truth:** `src/subscriptions-routes.tsx:31` `SUBSCRIPTION_PLANS`

| Tier  | Price/mo  | Price/yr   | Mailings/mo | Extra mailing | donation_fee | coins_bonus |
|-------|-----------|------------|-------------|---------------|--------------|-------------|
| spark | 0         | 0          | 0           | 7 000         | 10%          | 0           |
| start | 8 990     | 89 900     | 1           | 5 000         | 7%           | +5%         |
| pro   | 39 990    | 399 900    | 3           | 4 000         | 5%           | +15%        |
| elite | 149 990   | 1 499 900  | 10          | 3 000         | 3%           | +25%        |

Activation: `POST /server/subscriptions/subscribe` → YooKassa session
→ webhook `checkout-routes.tsx:115` writes the subscription row.
Cancellation: `POST /:userId/cancel` → status='cancelled', SSE +
cross-cabinet notification.
Recurring: `POST /server/subscriptions/charge-recurring` (CRON_SECRET)
— scans subscriptions ≤3d before expiry, charges saved card OR
downgrades to spark.

### Tier discounts on one-off charges

**Source:** `src/subscription-pricing.tsx` — `applySubscriptionDiscount(userId, category, basePrice)`.

Wired callsites:
- **pitching:** `pitching-routes.tsx` `/submit` (per-row inside the batch loop)
- **track_test:** `track-test-routes.tsx` `/submit` (single charge)
- **banners:** `banner-routes.tsx` `/:id/activate` (coin deduction)
- **marketing:** declared in SUBSCRIPTION_PLANS but **NOT wired** — no canonical "marketing" endpoint exists yet (mailings, autoposts and banners all live in different routes). When a unified marketing surface lands, wire it here.

| Tier  | pitching | marketing | track_test | banners |
|-------|----------|-----------|------------|---------|
| spark | 0%       | 0%        | 0%         | 0%      |
| start | 5%       | 5%        | 0%         | 5%      |
| pro   | 10%      | 15%       | 10%        | 10%     |
| elite | 15%      | 25%       | 20%        | 15%     |

Defensive default: any failure (no user_id, no active subscription,
expired sub, DB hiccup, unknown tier) → discount=0, basePrice unchanged.
**Never undercharges by accident.**

### Donation withdrawal commission

**Source:** `src/donations-routes.tsx` — `resolveDonationCommissionRate(userId)`.

| Tier  | Commission |
|-------|------------|
| spark | 10%        |
| start | 7%         |
| pro   | 5%         |
| elite | 3%         |

Defensive default on any failure → **0.10 (spark rate)** — revenue-safe
direction (opposite of the discount default above; here we never
undercharge a freeloader by accident).

`GET /donations/list` and `/donations/withdrawals` now return
`{ commission: { rate, tier } }` so cabinet can preview before
submit.

---

## Tracks

### Publication price flow

**Source:** `src/track-moderation-routes.tsx`.

- `PUBLICATION_PRICE = 5000` ₽ (line 26)
- "Первый трек бесплатно" — `resolveTrackPublicationPrice(userId, trackId)`:
  if the artist has zero paid publications AND no prior
  first-track-free usage → returns 0 → track auto-promotes
  `moderation_status: 'upcoming'`, `is_hidden: false`,
  `data.first_track_free_applied: true`. Effectively skips the
  payment gate.
- **AI-flagged tracks ignore the first-free quota** — they always
  pay full PUBLICATION_PRICE (the AI-catalog flow is a separate
  product). Their first non-AI submission still gets the free slot.

### Track lifecycle states (moderation_status)

```
pending → approved → paid → upcoming → published
         ↓        ↓
       rejected revision (loops back to pending)
```

- `pending` — sat in moderation queue
- `approved` — awaits payment (5000 ₽ pending in
  data.payment_amount; data.requires_payment=true; is_hidden=true)
- `paid` — payment confirmed via YooKassa webhook
- `upcoming` — admin published manually, lives in "Скоро" section
- `published` — лежит в "Новинки", visible in каталоге 500+ radio
- `rejected` — terminal
- `revision` — artist must resubmit

### What "публикация 5 000 ₽" actually delivers

For honest customer support — this is what artists get for the
publication fee. Source: `tracks-page.tsx:775` (Promomusicfigma) +
`UserAgreementPage.tsx:3.x` + `ForBusinessPage.tsx:126`:

- Трек попадает в раздел «Скоро» на главной → через 2 дня
  «Новинки недели».
- Каталог для **радиостанций-партнёров** — музыкальные редакторы
  смотрят его и берут что хотят в ротацию (pull-модель).
  **НЕ гарантированная ротация на конкретной станции.**
- Доступ к питчингу — отдельный платный модуль, оплата
  внутренней валютой (коины).
- Статистика ротаций в кабинете (соглашение 3.3): прослушивания,
  гео, список вещателей.
- Шанс попасть в чарт ПРОМО.МУЗЫКА.
- **НЕ дистрибуция в стриминги** (Яндекс/VK Музыка — отдельный
  модуль `dsp_distribution`).

---

## Venue cabinet

### 14-day trial mechanic

**Source:** `src/venue-trial.tsx` + `src/venue-routes.tsx`.

- New profile: `applyInitialTrial(profile)` stamps
  `data.trial_expires_at = createdAt + 14d` automatically on first
  GET /profile.
- `getTrialState(profile)` → `{ isTrialing, isExpired,
  daysRemaining, expiresAtIso, startedAtIso }`. Returned in
  GET /profile as `profile.trial`.
- Cron: `POST /server/api/venue/cron/expire-trials` (CRON_SECRET).
  - Past expiry → status='expired', plan='free', `trial_ended_at`
    stamped, SSE `venue_trial_expired` event, email
    `sendVenueTrialExpiredEmail`.
  - `daysRemaining ∈ (0,3]` + no prior warning →
    `sendVenueTrialEndingEmail`, mark `trial_warning_sent_at`.
  - Idempotent: re-running won't double-warn or re-expire.

### Plan limits & gating

**Source:** `src/venue-plan-limits.tsx`.

Effective plan resolution from profile:
- `subscriptionStatus='trial'` → effectivePlan=**'business'** (per
  landing promise "полный функционал ПРОМО.ЭИР")
- `subscriptionStatus IN ('expired','cancelled','inactive')` →
  **'free'**
- `subscriptionStatus='active'` → use `subscriptionPlan` from row
- unrecognised → 'free' (safe default)

Plan limits table (mirrors frontend `src/venue/constants/subscription-plans.ts`):

| Plan       | zones | playlists | tracks | library | analytics | scheduling | multi | api | branding |
|------------|-------|-----------|--------|---------|-----------|------------|-------|-----|----------|
| free       | 1     | 5         | 500    | basic   | ✗         | ✗          | ✗     | ✗   | ✗        |
| start      | 1     | 5         | 500    | basic   | ✗         | ✗          | ✗     | ✗   | ✗        |
| business   | 4     | 20        | 2000   | full    | ✓         | ✓          | ✗     | ✗   | ✓        |
| network    | -1    | -1        | -1     | premium | ✓         | ✓          | ✓     | ✓   | ✓        |
| enterprise | -1    | -1        | -1     | premium | ✓         | ✓          | ✓     | ✓   | ✓        |

`-1` = unlimited.

Currently enforced endpoints (`venue-routes.tsx`):
- `POST /venue/playlists` — `maxPlaylists` quota
- `GET /venue/analytics/*` (5 endpoints) + `POST /venue/analytics/export` — `features.analytics` flag

Not yet enforced (helpers ready, endpoints don't exist or aren't
prioritized): `zones`, `scheduling`, `multiLocation`, `apiAccess`,
`customBranding`, `maxTracks`.

`GET /venue/profile` enriches the response with `effectivePlan` +
`planLimits` so the cabinet can grey out locked features without
hitting a 403 first.

---

## DJ cabinet

**Source:** `src/dj-studio-routes.tsx` `DJ_PLANS`.

| Plan      | mixes | events | analytics |
|-----------|-------|--------|-----------|
| starter   | 5     | 5      | basic     |
| pro       | -1    | -1     | extended  |
| premium   | -1    | -1     | full      |

Resolver: `getDjPlanLimits(djId)` — reads `djSubscriptionsStore`,
default to starter when no record.

Enforced endpoints:
- `POST /dj-studio/mixes` — `limits.mixes` (count vs cap)
- `POST /booking/create` — `limits.events` (only when
  `performerType === 'dj'`); counts non-rejected non-cancelled
  bookings in the same calendar month as eventDate

---

## Live chat (support)

**Source:** `src/chat-support-routes.tsx` + `src/sse-routes.tsx`.

Tables (`migrations/012_chat_support.sql`):
- `chat_sessions` — one per visitor; guest_token (48-hex cookie),
  status ∈ (open, assigned, closed)
- `chat_messages` — bubble-per-row, sender_type ∈ (guest, admin,
  system, bot)

Public endpoints (no auth, identified by `chat_guest_token` cookie):
- `POST /server/api/chat-support/init`
- `POST /server/api/chat-support/:sessionId/messages`
- `GET  /server/api/chat-support/:sessionId/messages`
- `POST /server/api/chat-support/:sessionId/identify`
- `POST /server/api/chat-support/:sessionId/read`
- `GET  /server/api/chat-support/:sessionId/stream` (SSE)

Admin endpoints (requireAuth + requireAdmin):
- `GET  /admin/sessions` (status filter)
- `GET  /admin/sessions/:id`
- `POST /admin/sessions/:id/reply`
- `POST /admin/sessions/:id/assign`
- `POST /admin/sessions/:id/close`
- `POST /admin/sessions/:id/read`
- `GET  /admin/stream` (broadcast SSE — see Phase 4 note)

Notifications:
- New session → `notifyChatNewSession()` (admin email + @Promomusicalbot)
- Admin reply when guest SSE not connected →
  `sendChatGuestReplyEmail()` with email return-link
  `${SITE_URL}/?chat=<id>&t=<token>`

---

## Channels — Telegram / email / SSE

### Telegram bot @Promomusicalbot

Env: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_LEAD_CHAT_ID`.
Used by: `notifyAdminTelegram()` in `email-helper.tsx` —
`notifyChatNewSession`, `notifySupportTicket`,
`notifyTrackUpload`, `notifyPaymentReceived`, etc.

### Email transport

`email-helper.tsx`:
- Primary: SMTP via `127.0.0.1:25` Postfix relay (no auth)
- Fallback: Resend HTTP API (env `RESEND_API_KEY`)
- `FROM_EMAIL = '"ПРОМО.МУЗЫКА" <noreply@promo-music.ru>'`
- `ADMIN_EMAIL = 'info@promofm.ru'`

### SSE (real-time)

`sse-routes.tsx` `connections` Map keyed by various identifiers:
- `<userId>` — main cabinet stream (auth+owner-checked)
- `guest:<token>` — chat-support guest stream
- `admin:chat-support` — admin dashboard broadcast

Frontend connects via EventSource (cookies + query token only —
EventSource doesn't carry Authorization header).

---

## Critical column-type cheat sheet (echoed from CLAUDE.md)

Verified columns / types — DO NOT INVENT:

| Table | Column | Type | Notes |
|-------|--------|------|-------|
| users | id | uuid | Comparisons with text param: cast `id::text = $1` |
| users | status | enum user_status | Cast with `::text` when used in COALESCE |
| artist_profiles | id | uuid | |
| artist_profiles | user_id | text | (FK is text, not uuid) |
| `*_profiles.user_id` (dj/radio/venue/producer/label) | text | |
| tracks | id | uuid | |
| tracks | artist_id | uuid | FK to artist_profiles.id; **don't** add `$1::text` cast — breaks pg-node binding |
| tracks | user_id | text | |
| notifications | id | text | legacy composite ids |
| notifications | user_id | uuid | pg-node implicit-casts string→uuid here |
| All `:userId` / `:artistId` URL params | arrive as | text |

See CLAUDE.md "SQL writing pitfalls" for the full discussion.
