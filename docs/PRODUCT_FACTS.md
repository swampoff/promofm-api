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

| Tier  | Price/mo  | Price/yr   | Mailings/mo | Tests/mo | Extra mailing | donation_fee | coins_bonus |
|-------|-----------|------------|-------------|----------|---------------|--------------|-------------|
| spark | 0         | 0          | 0           | 0        | 7 000         | 10%          | 0           |
| start | 8 990     | 89 900     | 1           | 1        | 5 000         | 7%           | +5%         |
| pro   | 39 990    | 399 900    | 3           | 3        | 4 000         | 5%           | +15%        |
| elite | 149 990   | 1 499 900  | 10          | 10       | 3 000         | 3%           | +25%        |

**Tests/mo (PromoLab quota)** added 2026-05-25 — was a separate
paid product (3 fake tiers Express ₽990 / Pro ₽2990 / Premium
₽7990 that backend silently flattened to ₽3000). Now: included
in the main subscription. Quota resets on the 1st of each
calendar month. Over-quota submissions = flat ₽3000 (no further
tier discount; the tier benefit IS the quota). Guests
(no user_id) always pay full ₽3000.

Activation: `POST /server/subscriptions/subscribe` → YooKassa session
→ webhook `checkout-routes.tsx:115` writes the subscription row.
Cancellation: `POST /:userId/cancel` → status='cancelled', SSE +
cross-cabinet notification.
Recurring: `POST /server/subscriptions/charge-recurring` (CRON_SECRET)
— scans subscriptions ≤3d before expiry, charges saved card OR
downgrades to spark.

### Tier discounts on one-off charges

**Source:** `src/subscription-pricing.tsx` — `applySubscriptionDiscount(userId, category, basePrice)`.

Categories (merged 2026-05-25 — was 4, now 3):
- **promotion** — питчинг (плейлисты/радио/инфлюенсеры/медиа) +
  marketing-кампания + дистрибуция в стриминги. Single bucket per
  product decision; legacy `pitching` / `marketing` accepted as
  aliases by `normalizeCategory()` so older call sites work without
  rename.
- **track_test** — PromoLab оценка треков экспертами.
- **banners** — рекламные баннеры на платформе (оплата коинами).

Wired callsites:
- **promotion (via 'pitching' alias):** `pitching-routes.tsx` `/submit` (per-row inside the batch loop)
- **track_test:** `track-test-routes.tsx` `/submit` (single charge)
- **banners:** `banner-routes.tsx` `/:id/activate` (coin deduction)
- **promotion (distribution & marketing):** to be wired in
  `checkout-routes.tsx` when `metadata.itemType IN ('marketing',
  'distribution')` — currently pending the distribution flow PR.

| Tier  | promotion | track_test | banners |
|-------|-----------|------------|---------|
| spark | 0%        | 0%         | 0%      |
| start | 5%        | 0%         | 5%      |
| pro   | 10%       | 10%        | 10%     |
| elite | 15%       | 20%        | 15%     |

Backwards compat: existing subscription rows in DB still carry
`discounts.pitching` / `discounts.marketing` legacy keys until the
next renewal/upgrade overwrites them via the checkout webhook
PLANS table (also updated 2026-05-25). The helper reads
`plan.discounts.promotion` first, then falls back to MAX(stored
.pitching, stored.marketing) for old rows. Net effect: every
existing subscriber gets at least the higher of the two old
discounts on every charge — no one is downgraded by the merge.

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

## Distribution (DSP — Yandex Music / VK / Spotify / Apple Music)

**Source:** `src/distribution-routes.tsx` + `src/migrations/013_distribution_orders.sql`.

Manual fulfilment today (admin uploads track to DSP and pastes
URL/ID back). Schema explicitly carries `dsp_track_id`,
`submitted_at`, `live_at`, `stats_last_fetched_at` — all columns
a future API-integration worker will write directly, so the
endpoints serve both manual and automated modes without UI
changes when integrations land.

### Base prices (per-DSP, before subscription discount)

`distribution-routes.tsx` `DISTRIBUTION_BASE_PRICES`:

| DSP          | Base price |
|--------------|------------|
| yandex_music | 2 000 ₽    |
| vk_music     | 1 500 ₽    |
| spotify      | 5 000 ₽    |
| apple_music  | 4 000 ₽    |
| soundcloud   | 1 500 ₽    |
| other        | 3 000 ₽    |

Subscription discount: **'promotion' category** (5/10/15% by
tier). Applied at order creation, stored in `discount_pct` for audit.

### Order lifecycle

```
pending → paid → submitted → live
         ↓                ↓
      cancelled         rejected
```

- `pending` — created by artist, awaiting payment
- `paid` — checkout webhook flipped on payment.succeeded (TODO
  wire: checkout-routes.tsx needs `itemType='distribution'` branch)
- `submitted` — admin pushed to DSP, `submitted_at` stamped
- `live` — DSP confirmed public, `live_at` stamped + `dsp_track_url`
- `rejected` — DSP refused; `rejected_reason` populated
- `cancelled` — artist cancelled before payment

### Stats

`stats_plays`, `stats_saves`, `stats_playlist_adds` — last-known
snapshot. Admin updates via `POST /admin/:orderId/update`. Each
update also writes a row to `distribution_stats_history` (time-series
for future charts).

### Endpoints

Artist:
- `POST   /server/api/distribution/`               — create order
- `GET    /server/api/distribution/user/:userId`   — list own orders
- `GET    /server/api/distribution/track/:trackId` — per-track
- `POST   /server/api/distribution/:orderId/cancel`— cancel pending

Admin (requireAdmin):
- `GET    /server/api/distribution/admin/queue`            — pending/paid/submitted
- `POST   /server/api/distribution/admin/:orderId/update`  — status + stats
- `POST   /server/api/distribution/admin/:orderId/note`    — append admin note

Public:
- `GET    /server/api/distribution/pricing`        — base-price list

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

Enforced in `venue-zones-routes.tsx` (mounted at `/server/api/venue-zones`):
- `POST /` (create zone) — `limits.zones` cap via `quotaExceeded(...)`.
  free/start = 1, business = 4, network/enterprise = -1 (unlimited).
- `GET /` — auto-seeds «Основная зона» on first call so every venue
  starts with ≥1 zone. Returns `maxZones` + `canAddMore` for the UI.
- `PUT /:id`, `PUT /:id/playlist`, `DELETE /:id` — owner-scoped CRUD.
  DELETE refuses when only one zone remains.

Zone schema (`src/migrations/015_venue_zones.sql`):
`(id uuid, user_id text, venue_id text, name text, description text,
current_playlist_id text, is_active boolean, sort_order int,
created_at, updated_at)`. `current_playlist_id` references items
inside the `venue_playlists.data` jsonb (no FK — jsonb store).

Enforced in `venue-api-routes.tsx` — two surfaces:
- `/server/api/venue-api/tokens` (JWT auth) — issue/list/update/
  revoke/delete API tokens. `POST /` gated by `limits.apiAccess`
  (network/enterprise = true). Returns plaintext token ONCE in
  response body — never again. Stores SHA-256 hash + first-12-char
  prefix for display.
- `/server/api/venue-public/*` (Bearer-token auth) — third-party
  read/write surface scoped to the token's venue. Endpoints:
  `GET /me`, `GET /zones`, `GET /zones/:id`, `GET /zones/:id/current`,
  `PUT /zones/:id/playlist`, `GET /playlists`, `GET /playlists/:id`,
  `GET /now-playing`. Each endpoint requires a scope from
  `read:zones | write:zones | read:locations | read:playlists | read:now`.
  Expired (`expires_at < NOW()`) and revoked (`revoked_at NOT NULL`)
  tokens hit 401. `last_used_at` touched fire-and-forget on every
  authenticated request.

Token schema (`src/migrations/017_venue_api_tokens.sql`):
`(id uuid, user_id text, venue_id text, name text, token_hash text
UNIQUE, token_prefix text, scopes jsonb, last_used_at, expires_at,
revoked_at, created_at)`. Format: `vpfm_` + 64 hex chars (32 random
bytes). `vpfm_` prefix is intentional — log scrubbers / GitHub
secret-scanning can detect leaks.

Enforced in `venue-branding-routes.tsx` (mounted at
`/server/api/venue-branding`):
- `GET /` — fetch with sensible defaults if no row exists (returns
  200, never 404). Surfaces `customBrandingEnabled` for the UI.
- `PUT /` — upsert; gated by `limits.customBranding` (business+).
- `DELETE /` — drop the row → defaults restored; gated.
- `GET /public/:venueId` — anonymous read for embed players /
  third-party widgets. Only public-safe fields exposed (colors,
  logo, title, favicon, hide_promo_credit). No user_id, no
  timestamps, no custom_css.

Branding schema (`src/migrations/018_venue_branding.sql`):
`(venue_id text PK, user_id text, primary_color text, accent_color
text, background_color text, text_color text, logo_url text,
favicon_url text, player_title text, player_subtitle text,
hide_promo_credit boolean, custom_css text, created_at, updated_at)`.
Hex CHECK constraints on the four color columns (`#RGB` or
`#RRGGBB`, case-insensitive). URLs validated app-side: must start
with `https://` or `data:image/`, max 2048 chars (blocks
`javascript:` / `file:` schemes).

Numbered 018 because 017_venue_api_tokens.sql ships in parallel.

Not yet enforced (helpers ready, endpoints don't exist or aren't
prioritized): `maxTracks`. apiAccess + customBranding shipped
2026-05-25 (see sections above).

`GET /venue/profile` enriches the response with `effectivePlan` +
`planLimits` so the cabinet can grey out locked features without
hitting a 403 first.

### Stream-player state (cron poller)

**Source:** `src/stream-player-routes.tsx` + `src/migrations/020_stream_player_state.sql` + `systemd/promofm-stream-player.{service,timer}`.

MVP playout-oracle that resolves "what should be playing right now"
for every venue + zone every 60 seconds and writes the result to
`stream_player_state`. A future ffmpeg playout worker will read
this table to push audio; for now the value is observability —
operators can verify scheduling actually fires.

Tick:
- systemd timer `promofm-stream-player.timer` fires every 60s.
- Service unit calls `POST /server/api/stream-player/cron/tick`
  with `X-Cron-Secret: ${CRON_SECRET}` (same secret as venue-trial cron).
- Tick iterates venues that have ≥1 schedule OR ≥1 zone, resolves
  per-zone (zone-specific override → venue-wide fallback) + a
  synthetic «venue-wide» row (zone_id NULL).
- UPSERT semantics: `last_tick_at` bumped every tick (liveness),
  `last_change_at` bumped only when `current_playlist_id` flipped.

Schema (`stream_player_state`):
`(id uuid PK, venue_id text, user_id text, zone_id text NULL,
current_schedule_id text, current_playlist_id text, status
'idle'|'playing'|'error', error_text, last_tick_at, last_change_at,
created_at)`. Partial unique indexes enforce one row per
(venue, zone) and one venue-wide row per venue.

Pre-019 compatibility: if `venue_schedules.zone_id` column doesn't
exist yet (migration 019 not deployed), the resolver falls back to
the pre-zone-link query and serves the same venue-wide row for
every zone target. Column presence is detected once and cached.

Endpoints:
- `POST /server/api/stream-player/cron/tick` — CRON_SECRET-protected
- `GET  /server/api/stream-player/me` — auth'd venue reads its own state

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
- New session → `notifyChatNewSession()` (admin email + @Promomusicalbot).
  TG-сообщение содержит `[session:<UUID>]` маркер для bridge ниже.
- Admin reply when guest SSE not connected →
  `sendChatGuestReplyEmail()` with email return-link
  `${SITE_URL}/?chat=<id>&t=<token>`

### Telegram-мост (admin replies в TG → chat_messages)

**Endpoint:** `POST /server/api/chat-support/webhook/telegram/:secret`
(secret = `process.env.TELEGRAM_WEBHOOK_SECRET`).

**Flow:**
1. Гость пишет → `notifyChatNewSession` шлёт TG-сообщение админу
   с маркером `[session:UUID]` и инструкцией «нажмите Reply».
2. Админ делает Reply в Telegram + пишет ответ → Telegram POSTит
   update на webhook.
3. Handler:
   - Парсит `update.message.reply_to_message.text` через
     `/\[session:([0-9a-f-]{36})\]/`
   - Валидирует что сессия существует и не `closed`
   - INSERT chat_messages (sender_type='admin', sender_name = TG
     user's first+last name)
   - На `status='open'` → auto-flip to `'assigned'`
   - `emitSSE(guest:<token>, ...)` — мгновенная доставка в виджет
   - Если гость оффлайн + есть guest_email → `sendChatGuestReplyEmail`
   - ACK админу в TG: «✅ Ответ доставлен»
4. Спец-команда `/start` → bot отвечает приветствием.

**Deploy steps (manual, runs ONCE per bot):**
```bash
# 1. Set env vars
TELEGRAM_BOT_TOKEN=<from-BotFather>
TELEGRAM_WEBHOOK_SECRET=<random-string>

# 2. Register webhook URL with Telegram
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://promo-music.ru/server/api/chat-support/webhook/telegram/'"$TELEGRAM_WEBHOOK_SECRET"'",
    "allowed_updates": ["message"]
  }'

# 3. Smoke-test: open bot in TG, send /start → expect "Bot моста активен"
```

**Limitations:**
- Каждый TG-Reply создаёт ровно одно сообщение в чате. Media
  (фото/файлы) игнорируется — только текст.
- `sender_id` всегда NULL (не маппим TG user_id → platform admin
  user_id). `sender_name` = first_name + last_name из TG.
- Если админ ответит на старое уведомление с давно закрытой
  сессией — бот вернёт `⚠️ Чат завершён, ответ не доставлен`.

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
