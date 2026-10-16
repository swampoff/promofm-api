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
downgrades to spark. Подписка продлевается ТОЛЬКО при
`chargeResult.status === 'succeeded'` (2026-06-27 fix): YooKassa
off-session `capture:true` резолвится синхронно, gateway отдаёт реальный
статус (`gateway-yookassa.tsx`). До фикса хардкодили `'pending'` и
продлевали ВСЕГДА → отклонённая карта давала бесплатный период + фантом-
выручку. `canceled` → не продлеваем (downgrade при истёкшей), `pending`
(редкий 3DS) → следующий прогон через Idempotence-Key добивает.

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
- **promotion (distribution):** `distribution-routes.tsx` `POST /` —
  discount applied to `basePrice` at order creation. The checkout
  webhook (`checkout-routes.tsx:369`) flips the row pending→paid on
  `metadata.itemType='distribution' + metadata.orderId` and is
  idempotent (`WHERE status='pending'`).
- **marketing:** no canonical endpoint exists yet. When a unified
  marketing surface lands (campaigns / autoposts / mailings under
  one button), wire `applySubscriptionDiscount(userId, 'promotion', …)`
  there too.

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
- `paid` — checkout webhook (`checkout-routes.tsx:369`) flips
  pending→paid on `metadata.itemType='distribution' + orderId`.
  Idempotent (`WHERE status='pending'`).
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

## Distribution v2 — full Release model (DDEX-aware, in progress)

**Source:** `src/migrations/113_distribution_v2_releases.sql` +
`src/distribution-v2-types.ts`. Status as of 2026-06-18: **Phase 1
(data model) landed, no code consumers yet** — 6 additive tables, zero
changes to existing schema. v1 `distribution_orders` остаётся рабочим
(DistributionTab всё ещё на нём); миграция UI на v2 — позже.

### ⚠️ Реальность доставки в DSP (читать перед обещаниями)

**Spotify и Apple Music НЕ имеют публичного upload-API.** «Spotify for
Artists» = только аналитика (read-only). Доставка контента возможна
ТОЛЬКО через аккредитованного дистрибьютора: DDEX-ERN + зашифрованный
SFTP/Ingrid-канал + юридический договор (процесс на месяцы). Yandex/VK
имеют RU-партнёрские программы, тоже через договор.

Поэтому архитектура: **богатая Release-модель + DDEX-ready метаданные +
pluggable delivery worker**. Сегодня delivery-адаптер = ручная
админ-доставка; завтра подключается аккредитованный канал/агрегатор
БЕЗ изменения модели данных. `release_deliveries.ddex_message_id` +
`dsp_release_id` готовы под оба режима.

### Модель (6 таблиц, миграция 113)

```
releases (single/EP/album: upc, cover 3000×3000, ℗/©, release_date, genre)
  ├─ release_tracks (isrc, version, explicit, audio WAV master, is_dj_mix, rights_attested)
  │    └─ release_contributors (composer/lyricist/producer + split_pct + payee_user_id)
  └─ release_deliveries (per-DSP: status, ddex_message_id, dsp_url) UNIQUE(release_id, target_dsp)

royalty_statements (импорт DSP-отчёта за период: target_dsp, period, total)
  └─ royalty_lines (по isrc → matched release_track → user_id earner → net → payout_status)
```

### Что несёт каждое поле (для будущих фаз)

- **releases.status** машина: `draft → pending_payment → paid → in_review
  → approved → delivering → live` (+ `rejected`/`taken_down`/`cancelled`)
- **release_tracks.is_dj_mix + rights_attested** — DJ-flow: миксы требуют
  явного подтверждения прав на содержимое (clearance gate) перед submit
- **release_contributors.split_pct + payee_user_id** — основа роялти-
  сплита: сумма split_pct внутри role-группы = 100 (enforce на app-уровне,
  не CHECK)
- **royalty_lines.payout_status + payout_withdrawal_id** — связка с
  существующим `payment_withdrawals` для выплат (реюз withdrawal infra)

### Решения owner'а (2026-06-18, для контекста следующих фаз)

- Доставка: **прямые DSP API** (с поправкой на реальность выше — реально
  DDEX + аккредитация/агрегатор)
- Модель: **полная Release-модель** (эта миграция)
- Роялти: **сбор + выплата** (royalty_statements/lines + payout)
- DJ: **оригиналы + миксы** (is_dj_mix + rights_attested gate)

### Roadmap (фазы)

1. ✅ Data model (миграция 113) — **эта PR**
2. ⬜ Backend CRUD + валидация (release wizard endpoints, audio/cover
   validation, ISRC/UPC assignment)
3. ⬜ Артист wizard UI (многошаговый release-визард)
4. ⬜ DJ flow (rights-attestation gate для миксов)
5. ⬜ Delivery layer (DDEX-ERN export + admin delivery console + worker)
6. ⬜ Royalty subsystem (импорт DSP-отчётов → split → payout)

### MANUAL DEPLOY (миграция 113 — additive, safe)

```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
BEGIN;
\i /opt/promofm-api/src/migrations/113_distribution_v2_releases.sql
COMMIT;
EOF
```
Идемпотентна (CREATE TABLE/INDEX IF NOT EXISTS). Ноль изменений
существующих таблиц — можно применять без code-restart (код v2 ещё не
читает эти таблицы).

---

## Tracks

### Publication price flow

**Source:** `src/track-moderation-routes.tsx`.

- `PUBLICATION_PRICE = 7000` ₽ (track-moderation-routes.tsx:27; в
  этом файле ранее стояло устаревшее «5000» — из-за таких хвостов
  2026-07-07 админка показывала артисту не ту цену)
- `MIX_PUBLICATION_PRICE = 7000` ₽ (dj-mix-moderation-routes.tsx:27;
  выровнена с треками решением Никиты 2026-07-07, до этого 5000).
  ⚠️ Grandfathering: цена штампуется в `dj_mixes.payment_amount` при
  АПРУВЕ, checkout-гейт сверяет с ней — миксы, одобренные до
  повышения и ещё не оплаченные, легитимно платят свои 5000.
- **«Первый трек бесплатно» — ОТКЛЮЧЕНО** (URGENT business
  decision 2026-05-31, commits `7d0a5ea` + `aedec9e`). Акция
  отменена немедленно после инцидента с артистом «Deafness»
  (письмо противоречило само себе: «бесплатно по акции» + «ждём
  оплату»). Сейчас:
  - `requires_payment = true` ВСЕГДА, для каждого трека и микса
  - `payment_amount = PUBLICATION_PRICE` (треки) /
    `MIX_PUBLICATION_PRICE` (миксы)
  - `first_track_free_applied = false` hardcoded
    (track-moderation-routes.tsx:441, 766)
  - функция `resolveTrackPublicationPrice` снесена из кода
    полностью (commit `aedec9e` «полный снос dead-code»)
  - ⚠️ **Не реализовывать обратно** без явного указания Никиты —
    аудит-агент 2026-06-10 чуть не «починил» акцию, посчитав её
    регрессией, потому что эта запись была stale.
- AI-flagged треки идут в отдельный AI-catalog flow — тоже
  полная цена.

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
- `upcoming` — **auto-set by the payment webhook** on a confirmed payment (symmetric with DJ mixes & free-track publishing); lives in "Скоро" ~3 days (`upcoming_until = paid_at + 3d`), then cron `/promote-upcoming` -> `published`. Manual `/approve-paid` gate removed by owner decision 2026-06-17.
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

## PROMO.CHECK — watermark, fingerprint, airplay monitoring

**Источник истины:** `src/promo-check-routes.tsx` +
`src/track-moderation-routes.tsx:312-328` +
`src/radio-routes.tsx:1394-1448` + Python-инжектор на VPS
(`/opt/promofm-promo-check/fingerprinter.py`, не в git-репо).

### Что это и зачем
Система автоматического учёта ротаций треков платформы на радио.
**Радиостанция НЕ ведёт ручных отчётов** в РАО/ВОИС/чарты по нашим
трекам — мы сами фиксируем каждое проигрывание через watermark в
файле. Используется и для маркетинга («автоучёт ротаций»), и для
анти-пиратства, и для статистики артиста в кабинете «Мои треки».

### Когда прошивается watermark — НЕ при скачивании радио, а при upload артистом

Это критично для маркетинговой формулировки.

1. **Артист загружает трек** через `TrackUploadPage`
   (`POST /api/tracks` или `POST /track-moderation/submit`).
2. **Fire-and-forget queue** в `track-moderation-routes.tsx:325-328`:
   ```ts
   if (audioUrl) {
     fetch(`http://127.0.0.1:3000/server/api/promo-check/process/${track.id}`,
           { method: 'POST' }).catch(() => {});
   }
   ```
   То же самое mirror'ится из `/api/tracks` (комментарий в коде L323).
3. **`POST /promo-check/process/:trackId`** (`promo-check-routes.tsx:165-198`):
   - INSERT в `promo_check_fingerprints` со `status='pending'`,
     `watermark_id = gen_random_uuid()::text`, `ON CONFLICT (track_id)
     DO UPDATE SET status = 'pending'` (re-process idempotent).
   - Spawn detached Python: `spawn('python3', ['/opt/promofm-promo-check/fingerprinter.py', '--track-id', trackId], { detached: true, stdio: 'ignore' }); child.unref();`
4. **`fingerprinter.py`** (на VPS, не в репо) читает оригинальный
   MP3, прошивает watermark, генерит fingerprint, обновляет
   `promo_check_fingerprints` (`fingerprint`, `duration`,
   `status='ready'` или `'error'`).

**Следствие:** к моменту, когда радио скачивает трек, файл на
диске уже содержит watermark. Не «прошивается при скачивании», а
«уже прошит». Радио получает готовый идентифицируемый файл.

### Что делает download для радио — только логирование

`radio-routes.tsx:1399` `GET /tracks/:id/download`:
- Проверка `moderation_status IN ('published', 'upcoming')`.
- Получение `weekly_release_id` (informational) и `stationName`.
- **INSERT в `track_downloads_by_radio`** (`user_id`, `station_name`,
  `track_id`, `weekly_release_id`, `ip_addr`, `user_agent`) — это
  логирование скачивания, НЕ инжекция watermark.
- `streamTrackAudio(c, track.audio_url, filename)` —
  `track-download-helper.tsx:191` — простой `createReadStream` +
  `Readable.toWeb` без модификации содержимого.

### Скачивание треков станциями из письма «Новинки недели» (с 01.10.2026)

- В еженедельном письме (`radio-digest-routes.tsx` `/run-weekly`) кнопка «Скачать» ведёт на
  `/server/api/radio-get/:trackId?k=<ключ>` — личная ссылка получателя, вход в кабинет НЕ нужен.
  Ключ — `radio-dl-token.tsx`: `u.<users.id>` (аккаунт станции), `p.<radio_partner_contacts.id>`
  (партнёрский контакт без аккаунта), `t.<нули>` (служебная копия на info@ и `?test=`, не учитывается).
- Страница (`radio-get-routes.tsx`): плеер, кнопка «Скачать», анкета станции (название, город, формат,
  ссылка на эфир → `radio_profiles` / `radio_partner_contacts`), остальные треки подборки.
  Прямой ссылки на файл в HTML нет: адрес `/file?…&go=1` собирает скрипт по нажатию, чтобы проверка
  ссылок Mail.ru (79.137.*, 12:00–12:08 после рассылки) не засчитывалась скачиванием.
- Учёт: `track_downloads_by_radio` (`via='email_link'`, `user_id` ИЛИ `partner_contact_id`); повтор той же
  станции и трека в течение 30 мин не пишется, боты по User-Agent не пишутся. Артист видит станции в
  аналитике скачиваний (`artist-analytics-routes.tsx` `/downloads/:artistId`).
- Старый путь `GET /server/api/tracks/:id/download` (вход + `radio_profiles.is_verified`) остаётся для кабинета.
- Файл отдаёт `track-file.tsx` (`sendTrackFile`, `Readable.toWeb`). До 01.10 там был `c.body(createReadStream())`:
  после отдачи файла процесс падал с «ReadableStream is already closed».

- «Отметить, что трек в эфире» на той же странице → `POST /server/api/radio-get/rotation {k, track_id}` →
  `track_radio_pickups` (`source='radio_self_report'`, `submitted_via='email_link'`, `submitted_by_user_id` или
  `submitted_by_partner_contact_id`). Станция скачивала трек → `confirmed` (артист видит сразу, SSE
  `radio_rotation_confirmed`), не скачивала → `pending` (модерация `/api/radio/admin/rotation-reports`).
  Не чаще раза в 20 ч на трек от получателя письма. Строка-декор `auto` не делает отчёт подтверждённым
  (то же исправлено в кабинетном `POST /api/radio/rotations/report`, он пишет `submitted_via='cabinet'`).
- Публичные счётчики «станции/города» (`landing-data-routes.tsx` /new-releases и airplay, `weekly-releases-routes.tsx`)
  считают ВСЕ строки `track_radio_pickups`, включая отчёты станций на модерации (`pending`) и отклонённые.
  Решение владельца 02.10.2026: «на витрине для не наших специальная статистика, она должна остаться» — не фильтровать.

### PROMO.CHECK Live — настоящие эфиры по водяному знаку (с 02.10.2026)

- `promo-check/live_monitor.py` (сервис `promo-check-live`) слушает активные станции `promo_check_monitoring`
  непрерывно: 30-с куски, в каждом `audiowmark get`; засчитываются только наши watermark_id.
- Находки склеиваются в проигрывания → `promo_check_plays` (одна строка = одна ротация: станция, трек/микс,
  `started_at`, `last_heard_at`, `hits`, `max_score`, `evidence_path`). Состояние станций → `promo_check_live_status`.
- Отпечатки (Chromaprint) сюда не попадают. Старый `monitor.py` (выборочно, 30 с раз в ~6 мин) и
  `promo_check_detections` не менялись — на них стоит витрина.
- Проверка 02.10.2026: водяной знак после эфирной обработки (loudnorm + компрессор + MP3 128k) виден в 7 из 7
  случайных 30-с кусков; трек даёт 6–8 подтверждений за проигрывание.

### Приглашение артиста в лейбл (с 05.10.2026)

- Письмо-приглашение ведёт на `/server/api/label/invite/:id` (`label-routes.tsx`, страница сервера), а не сразу в
  `/artist/settings?tab=labels`. Страница смотрит сессию: адресат-артист → «Принять приглашение»
  (POST `/invitations/:id/accept`); вход под лейблом/другим артистом/другой ролью → «Выйти и войти как артист»;
  гость → «Войти как артист» (возврат после входа через sessionStorage `pf_return_to` в «Настройки → Лейблы»).
- Причина: охрана кабинета артиста (`ArtistApp.tsx` → `cabinetGuardRedirect`) молча уводит вошедшего с другой ролью
  в его кабинет — артистка с сессией лейбла попадала в кабинет лейбла, приглашение оставалось непринятым.
- Лейблу карточка артиста не создаётся: `vpsSaveProfile` (`vps-userdata.tsx`, зовётся при регистрации и каждом входе)
  пропускает upsert `artist_profiles` для роли `label`. Треки лейбл выпускает от имени артистов ростера (actingForArtistId).

### Слушающий сервис и хранилища

- **Мониторинг 7 станций seed:** `src/migrations/010_promo_check_monitoring_seed.sql` (`promo_check_monitoring` rows со
  `station_id`, `station_name`, `stream_url`, `active`).
- **Детекции:** `promo_check_detections` (`track_id`,
  `station_id`, `watermark_confirmed bool`, `detected_at`).
- **API статистики:** `promo-check-routes.tsx:24-71`
  `GET /stats/:trackId` (rotations по станциям + count
  `watermark_confirmed = true`); `:75-111` `GET /artist/:artistId`
  (агрегация по треку артиста); `:146-163` `GET /stations`
  (список мониторинга с `last_scanned_at`, `error_count`).

### Что НЕ работает / в активной разработке (по состоянию 2026-06-05)

- **Кабинет «отчёты по эфирам» в radio-UI** — сама система-движок
  работает, но визуальная панель в `src/radio/components/*` пока
  не зарелизена. На LP `/radio-stations` помечено «в ближайшем
  релизе».
- **Сравнение детекций с РАО-отчётами** (диспутный механизм) — нет.

### Где НЕ повторять ошибку маркетинга

- Watermark **не прошивается при скачивании радио**. Прошивается
  при upload артистом. LP-формулировка должна быть «платформа
  автоматически прошивает в каждый трек watermark, радио скачивает
  уже идентифицируемый файл».
- Аудит-агент в сессии 2026-06-05 ошибочно заключил что watermark
  «не реализован» потому что не нашёл инжекции в
  `streamTrackAudio` — но инжекция идёт через Python-процесс на
  VPS до download'а. Это типичный артефакт reading-from-code
  без VPS-доступа. Перед утверждениями типа «фича X не работает»
  цитируй файл — но и помни про детач'ные процессы вне git-репо.

---

## Venue cabinet

### Subscription tiers (venue-side, NOT artist)

**Source:** `src/venue-billing-routes.tsx:VENUE_PLANS` (duplicated in
`checkout-routes.tsx` webhook handler for offline activation path —
keep both in sync when prices change).

| Tier       | Price/mo  | Price/yr   | Effective plan limits |
|------------|-----------|------------|------------------------|
| start      | 4 990     | 49 900     | 1 zone, basic library, 5 playlists, 500 tracks |
| business   | 9 990     | 99 900     | 4 zones, full library, 20 playlists, 2000 tracks, analytics + scheduling + branding |
| network    | 14 990    | 149 900    | unlimited zones, premium library, multi-location, API access |
| enterprise | by sales  | by sales   | unlimited everything, custom contract |

Trial: 7 days at `effectivePlan='business'` (owner 2026-10-16; trials
started before 2026-10-16 keep 14 days, see `venue-trial.tsx:trialPeriodDaysFor`).
Starts only after the venue attaches a card: 1 ₽ check payment, refunded at
once; the `venue_card_attach` webhook (checkout-routes.tsx) stamps
`trial_expires_at`. At trial end the cron charges the first month to the
saved card (`venue-billing-helpers.tsx:tryAutoChargeAtTrialEnd`).

### Radio ad campaigns — pricing & amount-gate posture

**Status (2026-06-18):** server-side amount-gate ADDED in PR #288.
Previous PRODUCT_FACTS entry (deliberately ungated, 2026-06-17) is
superseded.

`venue/components/radio-section.tsx:180` creates a checkout session with
`itemType: 'radio_campaign'` and `amount = selectedPackage.price`. The
backend does NOT yet have a canonical radio ad package price table —
`POST /venue/radio-campaigns` (`src/venue-routes.tsx:790`) still stores
`budget: body.budget` straight from the client. Package definitions live
only in the frontend.

**New (#288) `/checkout/create-session` gate** for `metadata.itemType =
'radio_campaign'`:

| Check | Behaviour |
|---|---|
| `metadata.campaignId` обязателен | 400 |
| campaign существует | 404 |
| `campaign.venueId === getVenueProfile(userId).id` | 403 (IDOR-safe) |
| `campaign.status === 'pending'` | 409 (защита от double-pay) |
| `Math.abs(amount - campaign.budget) ≤ 0.01` | 400 + `radio_campaign_amount_tampering_blocked` |

**Каваэт:** gate сравнивает `amount` против `campaign.budget`, который
venue **сам же установил при `POST /radio-campaigns`**. Это закрывает
**public DevTools-tampering на checkout**, но не полную защиту —
venue всё ещё может занизить `body.budget` на этапе `POST /radio-
campaigns` (это другой layer). Полная защита потребует переноса
pricing-расчёта в backend (slot SUM или canonical package-price table) —
отложено как отдельная PR.

**Если будет добавлен canonical price source** (`radio_ad_packages`
таблица): mirror шаблон рядом с `digital_purchase` gate; recompute
`expected` из server source keyed на `metadata.packageType + stationId`,
`Math.abs(amount - expected) > 0.01` → 400.

### Subscribe / save-card / recurring (venue billing)

**Source:** `src/venue-billing-routes.tsx` + `src/venue-billing-helpers.tsx` + webhook branch in `src/checkout-routes.tsx`.

Endpoints under `/server/api/venue-billing`:
- `POST /subscribe { tier, interval }` — creates YooKassa session
  with `savePaymentMethod: true` so future recurring charges work
  without redirecting the user. Returns `confirmationUrl`.
- `POST /cancel` — flips `subscriptionStatus='cancelled'` but keeps
  `subscriptionExpiresAt` intact. Stream plays until period end,
  then the cron flips to expired + revokes tokens.
- `GET  /me` — current subscription state + saved card summary
  (last4, brand, gateway) for cabinet display.
- `POST /cron/charge-recurring` — CRON_SECRET. Mirror of artist
  `/subscriptions/charge-recurring` but scoped to `venue_profiles`.
  Charges venues whose `subscriptionExpiresAt` is within 3 days OR
  past. On charge failure / no card past expiry → marks expired
  (see `markVenueExpired` below). Idempotent via deterministic
  `venue-renew-{userId}-{expiresMs}` orderId.

Webhook in `checkout-routes.tsx`: `session.type === 'venue_subscription'`
+ `session.metadata.planKey` → activates the tier on
`venue_profiles.data`:
  - `subscriptionStatus='active'`
  - `subscriptionPlan=<tier>`
  - `subscriptionExpiresAt` extended from existing expiry (mid-cycle
    upgrades don't lose remaining days)
  - `subscriptionInterval`, `subscriptionPriceRub`
  - Also un-pauses any `venue_station_streams` rows that were
    `paused` (post-expiry reactivation).

### `markVenueExpired(userId, email, reason)` — kill-switch helper

When a venue's subscription becomes unviable (charge failed, no card
at trial end, paid period after cancellation ran out):
- `venue_profiles.data.subscriptionStatus = 'expired'`
- `venue_profiles.data.subscriptionPlan = 'free'`
- All `venue_api_tokens.revoked_at = NOW()` — APK gets 401 on next
  poll, shows lock-screen «оплатите чтобы продолжить»
- All `venue_station_streams.status = 'paused'` — admin UI shows
  the state
- SSE `venue_subscription_expired` event + email (re-uses
  `sendVenueTrialExpiredEmail` for now)

### Trial-end auto-charge

**Source:** `src/venue-billing-helpers.tsx:tryAutoChargeAtTrialEnd` +
hook in `venue-trial.tsx:expireTrialsOnce`.

If venue saved a card during onboarding (via /venue-billing/subscribe
with savePaymentMethod=true), the trial-expiry cron attempts to
charge it for the first paid month BEFORE falling back to «mark
expired». Charge succeeds → subscription becomes active with 30-day
period from trial end. Charge fails / no card → original expired
path kicks in (revoke tokens, pause streams, email).

This is the difference between «1000 триалов / 0 платящих» and a
working funnel — without it every trial silently dies on day 14.

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
- `POST /venue/playlists` — `maxPlaylists` quota (playlist count)
  AND `maxTracks` quota (total tracks across all playlists, including
  the new playlist's `contentItems`).
- `PUT  /venue/playlists/:id` — `maxTracks` quota. When the update
  changes `contentItems`, we count (sum of every OTHER playlist's
  length + new length) and reject if it breaches the cap. Also keeps
  the per-playlist `trackCount` in sync with the actual array length.
- `GET /venue/analytics/*` (5 endpoints) + `POST /venue/analytics/export` — `features.analytics` flag

`maxTracks` caps:
- free/start → 500
- business / trial → 2000
- network / enterprise → -1 (unlimited)

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
- `POST /upload-logo` — multipart/form-data, gated by
  `limits.customBranding`. Constraints: PNG/JPEG/WebP/SVG/GIF,
  5 MiB max, filename re-issued as
  `<venue_id>-<8-hex>.<ext>` (no path traversal possible, free
  cache-busting per upload). Writes to
  `/opt/promofm-api/uploads/venue-logos/` and returns the public
  URL. Caller MUST follow up with `PUT /` carrying the new
  `logoUrl` to persist on the branding row.
  Served at `/server/uploads/venue-logos/<filename>` (added to
  `STATIC_UPLOAD_SUBDIRS` in `src/index.ts`).

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

Not yet enforced: none. All `VENUE_PLAN_LIMITS` flags
(zones / maxPlaylists / maxTracks / analytics / scheduling /
multiLocation / apiAccess / customBranding) have route gating as of
2026-05-25. `libraryAccess` ('basic' / 'full' / 'premium') is a
helper ladder reserved for future catalog endpoints — no
consumer yet.

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

### Venue station — onboarding + provisioning (per-venue dedicated radio)

**Source:** `src/venue-station-routes.tsx` + `src/migrations/021_venue_station.sql` + email templates in `email-helper.tsx`.

The «promo.fm-style» per-venue stream pipeline. NOT the same as
`venue-radio-routes.tsx` (which is the legacy subscription to the
common ПРОМО.ЭИР). This is the dedicated, per-venue radio with
real hosts and music sourced from artists who pitch through the
platform.

**Internal note for devs:** the hosts run on Gemini + voice
synthesis (template borrowed from promo.fm). This is
intentionally invisible in every user-facing string — venue
copy / cabinet labels / emails refer to «ведущие эфира» /
«радиоведущие» without naming the tech.

**Two tables:**
- `venue_station_requests` — venue's onboarding submission
  (music_preferences, jingles, ai_host_config jsonb). One open
  request per venue at a time (partial unique index).
- `venue_station_streams` — provisioned stream + pairing code for
  the Android APK. One row per (venue, location).

**Lifecycle:**
```
request:  pending_admin → in_setup → provisioned → live
                                  ↓
                        rejected / changes_requested
stream:   in_setup → provisioned → live → paused → dead
```

**Endpoints under `/server/api/venue-station`:**

Venue (JWT):
- `GET    /me`                          — own request + streams (UI uses for lock-overlay vs «my radio»)
- `POST   /`                            — submit onboarding wizard (409 if open request exists)
- `PUT    /`                            — update preferences; auto-bumps status back to `pending_admin`
- `POST   /me/regenerate-pairing`       — fresh 24h code when replacing in-venue device

Admin (requireAuth + requireAdmin):
- `GET    /admin/queue`                            — sorted by status priority + venue profile joined
- `GET    /admin/:requestId`                       — full detail + streams + venue_profile
- `POST   /admin/:requestId/take`                  — assign to self
- `POST   /admin/:requestId/reject`                — `{ reason }` required
- `POST   /admin/:requestId/request-changes`       — `{ message }` shown to venue, status → changes_requested
- `POST   /admin/:requestId/provision`             — `{ streamUrl, vpsHost?, bearerTokenId?, locationId?, geminiConfig? }`, creates stream row + 24h pairing code
- `POST   /admin/streams/:streamId/pause|resume|mark-live`

APK (no auth, single-use code):
- `POST   /pair  { code, deviceInfo? }`            — returns `streamUrl + venueId + streamId`. Single-use: subsequent attempts → 410.

**Pairing code format:** `XXX-XXX` (6 chars, base32 sans 0/O/1/I/L
ambiguity). 24h TTL. Generated at provision; replaceable via
regenerate-pairing if venue lost it / changes device.

**Email cadence — fully wired as of Level 1 (2026-05-25):**

| Email | Trigger | Idempotency guard |
|---|---|---|
| `sendVenueRadioWelcomeEmail` | `auth-routes.tsx` POST `/auth/signup` when `userRole === 'venue'` | None (single signup event) |
| `sendVenueTrialEndingEmail` (T-3) | `expireTrialsOnce` cron when `daysRemaining ∈ (0..3]` | `data.trial_warning_sent_at` |
| `sendVenueTrialLastDayEmail` (T-1) | `expireTrialsOnce` cron when `daysRemaining === 1` | `data.trial_last_day_sent_at` (separate flag so T-1 fires even after T-3 already did) |
| `sendVenueTrialExpiredEmail` | `expireTrialsOnce` cron when `daysRemaining <= 0` | `status` flips to `expired` (terminal) |
| `sendVenueRadioReadyEmail` | `venue-station-routes` POST `/admin/:id/provision` — carries the fresh pairing code | New row per provision; admin can re-provision if needed |
| `sendVenueRadioChangesRequestedEmail` | `venue-station-routes` POST `/admin/:id/request-changes` — carries admin's message | None (admin can re-send if needed) |

All triggers use fire-and-forget: email outage logs a warning but
never blocks the user/admin action. `loadVenueContact(userId)`
helper resolves the user's email + display name from the `users`
table for the venue-station emails (welcome already has the values
at signup time).

### Venue APK (Android player) — release metadata + download (Level 3 pilot)

**Source:** `src/venue-apk-routes.tsx` + `system_config` jsonb store
(key `venue_apk_release`) + `/server/uploads/apk/<filename>` static
serving (added `'apk'` to `STATIC_UPLOAD_SUBDIRS` in index.ts).

The actual `.apk` file is built in a separate repo. This module is
the metadata + delivery layer on our side. Admin uploads a build via
`POST /admin/upload` (multipart/form-data: `file` + `version` +
`versionCode` + `minAndroidSdk` + `releaseNotes`); backend hashes
the file (sha256), writes it to `/opt/promofm-api/uploads/apk/
promofm-venue-player.apk` (stable filename so URLs don't churn),
and stores metadata in the `system_config` jsonb store.

Endpoints under `/server/api/venue-apk`:
- `GET    /info`                       (JWT) — current release metadata
- `GET    /public-info`                (no auth) — same, for the
  Android device itself to check on first boot
- `POST   /admin/upload`               (requireAdmin, multipart)
  — upload + replace current release. Sanity-checks ZIP magic
  (PK\x03\x04 at offset 0) so HTML/garbage uploads are rejected.
  Max 200 MiB. Version must match `^\d+\.\d+(\.\d+)?$`.
- `PUT    /admin/info`                 (requireAdmin) — update
  metadata without re-uploading (typo fix in release notes etc.)
- `DELETE /admin/release`              (requireAdmin) — wipe file +
  flip available=false. For rollback / debug.
- `GET    /admin/connected-devices`    (requireAdmin) — list every
  paired venue device with last-seen timestamp + venue context.
  Built on top of existing `venue_station_streams.paired_*` columns
  — no new schema.

Metadata shape (from `system_config.data` jsonb):
```ts
{
  available: boolean,             // false when no APK uploaded yet
  filename, version, versionCode,
  sha256, bytes,
  minAndroidSdk,                  // default 24 (Android 7.0)
  releaseNotes, releasedAt,
  downloadUrl,                    // /server/uploads/apk/<filename>
}
```

Cabinet `/venue/apk` page (frontend) reads `/info`, renders the
download button + pairing code (pulled from `venue-station/me`).
When `available=false` → «скоро будет» banner instead of dead link.

---

## DJ cabinet

**Source:** `src/dj-studio-routes.tsx` `DJ_PLANS` (line 623+).

| Plan      | Price/mo | Price/yr | mixes | events/mo | analytics |
|-----------|----------|----------|-------|-----------|-----------|
| starter   | 0        | 0        | 5     | 5         | basic     |
| pro       | 990      | 9 900    | 20    | 50        | advanced  |
| agency    | 2 990    | 29 900   | -1    | -1        | full      |

`-1` = unlimited. Resolver: `getDjPlanLimits(djId)` — reads
`djSubscriptionsStore`, defaults to starter when no record.

Enforced endpoints (audit pass 2026-05-25 closed multiple gaps):
- `POST /dj-studio/mixes` — `limits.mixes` (count vs cap)
- `POST /dj-studio/events` — `limits.events` per-month (counts
  non-cancelled events in the same calendar month as the requested
  date; fires 403 with `{ limit, current }` envelope). NEW in this
  audit pass — comment at line 1477 had promised it for a while.
- `POST /booking/create` — `limits.events` (only when
  `performerType === 'dj'`); counts non-rejected non-cancelled
  bookings in the same calendar month as eventDate.
- `GET /dj-studio/finances/transactions` — `limits.analytics`.
  `basic` (Starter) returns only transactions in the current
  calendar month; `advanced`/`full` (Pro/Agency) return full
  history. Response includes
  `meta: { analyticsLevel, truncated, totalAvailable }` so the
  cabinet can surface a «Полная история — Pro+» CTA when truncated.

Subscription expiry (lazy check, no cron):
- `getDjPlanLimits(djId)` — if stored `sub.endDate` has passed,
  returns starter limits regardless of stored `sub.limits`.
- `GET /dj-studio/subscription/:djId` — runs `subscriptionView()`
  on the stored row: adds `daysLeft` (ceil of remaining days) and,
  when past endDate, sets `expired: true`, `status: 'expired'` and
  rewrites `limits` to starter. Frontend can pivot on these to
  show «Продлите подписку» without re-implementing date math.
- There is intentionally no cron downgrading expired rows in the
  store — the lazy check is the source of truth, and renewals
  arrive via webhook from YooKassa.

Analytics tier — what's actually surfaced:
- `GET /dashboard/stats` includes `data.analyticsLevel`.
- `GET /finances/overview` includes `data.analyticsLevel`.
- `GET /finances/transactions` includes
  `meta.analyticsLevel` + the `basic`-only month truncation
  described above.
- Other endpoints don't gate on tier yet. Future: chart breakdowns,
  CSV export, API tokens for `full`.

Subscription activation:
- **Free plan (`starter`)** — direct `POST /dj-studio/subscription/:djId/change`
  upserts row in `djSubscriptionsStore`.
- **Paid plans (`pro`, `agency`)** — frontend redirects to YooKassa
  via `redirectToPayment({ type: 'subscription', metadata: { planId,
  interval, djId, role: 'dj' } })`. Webhook in
  `checkout-routes.tsx` branch `session.type === 'subscription' &&
  session.metadata.role === 'dj'` activates the subscription on
  payment.succeeded. Audit caught this branch was missing (DJ paid
  990₽ → stayed on Starter); fixed in this pass.
- DJ_PLANS table is duplicated in checkout-routes.tsx webhook
  handler for offline activation path (same pattern as
  artist subscriptions and venue subscriptions). Keep in sync when
  prices change.

### Profile envelope shape (FE ↔ BE)

The editor `DjProfileEditor.tsx:164` (`gatherAllData()`) sends a
**nested** payload to `PUT /dj-studio/profile`:

```
{
  profile: { djName, bio, avatarUrl, city, country, genres,
             specializations, verified, ... },
  booking: { openForBookings, ratePerHour, minBookingHours, ... },
  contacts: {...}, contactPersons: [...], equipmentList: [...],
  portfolioCategories: [...], pricingRules: [...], addonsList: [...],
  faqList: [...]
}
```

Backend `upsertDjProfile()` (`src/db.tsx:913`) extracts native
column values (`dj_name`, `bio`, `avatar_url`, `location`,
`hourly_rate`, etc.) FROM `payload.profile.*` first, falling back
to top-level keys for legacy callers. JSONB `data` column stores
the original nested envelope unchanged so the editor rehydrates
verbatim. `POST /profile/avatar` and `POST /profile/cover` also
write the nested shape (`data.profile.avatarUrl = url`).

`GET /profile` runs `ensureNestedDjEnvelope()` so flat/legacy rows
(pre-fix saves, SQL-seeded QA accounts) are coerced into the
nested envelope on read — the editor never sees a flat row.

**Bug fixed 2026-05-25**: `upsertDjProfile` previously read only
top-level keys, so every native column was nulled out on save.
Public marketplace (`dj-marketplace-routes.tsx:mapRow`) consequently
showed empty cards (no name, no avatar, no bio) even though the
cabinet looked fine (it rehydrates from the JSONB `data` column).

---

## Engineer marketplace (sound engineer cabinet)

**Source:** `src/engineer-routes.tsx` + миграции 023 (orders) и
025 (profiles).

### Order lifecycle

```
pending  →  accepted  →  (payment webhook)  →  in_progress
                                                   ↓
                                              delivered
                                                ↓     ↘ (admin-only) refunded
                                            completed  ↗
                                              ↑
                                  client click "Принять" ИЛИ
                                  cron auto-complete (7 дней)
```

Переходы:

| Action | Endpoint | Authorisation |
|---|---|---|
| client creates pending | POST `/engineer/orders` | client JWT |
| engineer accepts | PUT `/orders/:id/accept` | engineer JWT |
| engineer declines | PUT `/orders/:id/decline` | engineer JWT |
| client cancels (pre-pay) | PUT `/orders/:id/cancel` | client JWT, status ∈ {pending, accepted} |
| client pays | redirectToPayment → webhook | YooKassa, only accepted→in_progress |
| engineer delivers | PUT `/orders/:id/deliver` | engineer JWT, only in_progress |
| client confirms | PUT `/orders/:id/complete` | client JWT, only delivered |
| **cron auto-complete** | POST `/orders/auto-complete` | **X-Internal-Key**, delivered + 7d |
| admin refunds | POST `/admin/orders/:id/refund` | superadmin |

### Revenue attribution

Strings `platform_revenue_log` пишется ПРИ ОПЛАТЕ (`checkout-routes.tsx:1051`,
`processPaymentSuccess` → `recordRevenue`), не при completion:

- `channel='engineer_order'`
- `payee_id=<engineer userId>`
- `status='completed'` (платёжный статус, не lifecycle)
- `metadata->>'orderId'` = `payment_session.orderId`

Lifecycle статусы (`in_progress`/`delivered`/`completed`) — независимы
от финансов. Поэтому **auto-complete cron не влияет на /engineer
/earnings**: цифры одинаковы что при confirmed-completion, что при
auto-completion.

Refund (`POST /admin/orders/:id/refund`) парно обновляет:
1. `engineer_orders.status='refunded'`
2. `platform_revenue_log.status='refunded'` WHERE
   `channel='engineer_order' AND metadata->>'orderId' = payment_order_id`

`/engineer/earnings` filter'ит `status='completed'` — refund'нутые
заказы из сводки автоматически уходят.

### Auto-complete cron (since 2026-06-11)

`POST /server/api/engineer/orders/auto-complete` — X-Internal-Key
only (тот же паттерн что banner-routes `/expire`). Логика:

```sql
UPDATE engineer_orders
   SET status='completed', updated_at=NOW()
 WHERE status='delivered'
   AND updated_at < NOW() - INTERVAL '7 days'
RETURNING id, engineer_id, client_id, title, price;
```

Threshold константа `AUTO_COMPLETE_DAYS = 7` в файле. SSE
`engineer_order_auto_completed` уходит обеим сторонам. Idempotent
через WHERE-фильтр.

Crontab (на VPS):
```
0 3 * * *  curl -s -X POST -H "X-Internal-Key: $VPS_INTERNAL_KEY" \
  http://127.0.0.1:3000/server/api/engineer/orders/auto-complete \
  >> /var/log/promofm-engineer-autocomplete.log 2>&1
```

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

Два сендера, ОБА теперь с одинаковой устойчивостью (SMTP→Resend):

**Транзакционные письма** — `email-helper.tsx` → `sendEmail()`:
- Primary: SMTP via `127.0.0.1:25` Postfix relay (no auth)
- Fallback: Resend HTTP API (env `RESEND_API_KEY`)
- `FROM_EMAIL = '"ПРОМО.МУЗЫКА" <noreply@promo-music.ru>'`
- `ADMIN_EMAIL = 'info@promofm.ru'`

**Bulk/кампании** — `smtp-sender.tsx` → `smtpSendEmail()` / `smtpSendBatch()`
(используется email-campaigns, track-test, checkout, email-routes):
- Primary: SMTP via `SMTP_HOST:SMTP_PORT` (default `localhost:25`)
- Fallback: Resend HTTP API (тот же `RESEND_API_KEY`) — добавлен 2026-06-27
  (`smtp-sender.tsx:157+`). ДО этого fallback'а не было: при недоступном
  Postfix кампании падали на 100%, хотя транзакционные письма выживали
  через Resend. Это была root-cause «рассылка в админке не работает».
- FROM default выровнен на верифицированный домен
  `'ПРОМО.МУЗЫКА <noreply@promo-music.ru>'` (был невалидный `promofm.org`).
- List-Unsubscribe HMAC-заголовки сохраняются и в Resend-ветке.

**Scheduled-кампании** (2026-06-27): `scheduled_at` в редакторе ставит статус
`scheduled`. Их запускает крон `email-campaigns-cron.sh` (каждые 5 мин →
`POST /email-campaigns/campaigns/run-scheduled`, advisory-lock 720110): берёт
`status='scheduled'` со `scheduled_at <= now` и шлёт тем же ядром
`beginCampaignSend`, что и ручной `/send`. До этого крона scheduled-кампании
не уходили ВООБЩЕ (silent no-op). `scheduled_at` — datetime-local без TZ,
сравнение по серверному времени (CRON_TZ скрипта). Битая отложенная кампания
(нет получателей/html) помечается `failed`, чтобы не зациклить крон.

### Radio new-release digests — daily info@ vs weekly direct

Источник новинок в обоих потоках: треки пятничного релиз-бота
(`friday.js`) с `user_id='system-friday'`, `moderation_status='published'`.
Два НЕЗАВИСИМЫХ потока с разными курсорами — не воруют треки друг у друга:

| Поток | Курсор | Когда | Кому | Форма |
|---|---|---|---|---|
| **Daily** (#264) | `tracks.radio_digest_sent_at` (mig 110) | cron 10:00, по 2 трека/день | `info@promofm.ru` → оператор пересылает партнёрам ВРУЧНУЮ | плоский список |
| **Weekly** (2026-06-27) | `tracks.radio_weekly_digest_sent_at` (mig 113) | cron **понедельник 12:00**, весь батч недели | НАПРЯМУЮ всей базе радио | карточная HTML с лого |

Weekly-эндпоинт: `POST /server/api/radio-digest/run-weekly`
(`radio-digest-routes.tsx`), защита `X-Internal-Key` или admin-сессия,
advisory-lock `720108`, окно `created_at >= NOW() - 8 days`. Cron-скрипт
`radio-weekly-cron.sh` (`CRON_TZ=Europe/Moscow; 0 12 * * 1`).

**Получатели weekly** = объединение (дедуп по `lower(email)`,
глобальные отписки `email_unsubscribes` отсекаются):
1. зарегистрированные радио-аккаунты — `users.role='radio_station'`, `users.email`;
2. внешние станции-партнёры — `radio_partner_contacts` (active, не отписаны);
3. копия на `info@promofm.ru`.

**`radio_partner_contacts` сидируется миграцией 114** — 1195 уникальных
email'ов радиостанций, собранных из присланных списков (2gis-директория
19022024 → 931, муз.редакторы → 211, холдинги → 53; дедуп по lower(email)).
Каталог `pitching_radio` (~970 станций) адресов НЕ содержит
(`009_pitching_schema_bridge.sql:90` — `contact_email = ''`), поэтому адреса
взяты из внешних списков, а не из каталога.

**Единая система рассылки** (migration 115 + `docs/RADIO_MAILING_SYSTEM.md`):
`radio_partner_contacts` — ЕДИНСТВЕННЫЙ источник истины для cloud-крона И
laptop. Колонки `last_sent_at` / `send_count` штампуются после каждой отправки
(weekly-крон делает это автоматом), чтобы два актора не били по одним адресам.
«Можно слать» = `active AND unsubscribed_at IS NULL`; «холодный прогон по
оставшимся» = `last_sent_at IS NULL`. Laptop штампует свой уже-разосланный
батч (шаги в RADIO_MAILING_SYSTEM.md) → дубли исключаются автоматически.

⚠️ Это **холодные внешние адреса** (2gis-скрейп) — массовая рассылка на них
несёт риск для репутации домена/попадания в спам (ровно та причина, по которой
#264 шлёт на info@ для ручной пересылки). Перед первым проходом по всей базе
оператору стоит решить вопрос прогрева домена / согласия. Зарегистрированным
радио-юзерам (opted-in) это не грозит.

### Engineer marketplace e-mail pipeline (since 2026-06-11)

Прежде engineer-события шли только в SSE (колокольчик). С PR
feat/engineer-email-pipeline дублируется e-mail'ом в 3 точках:

| Эвент | Файл:линия | Получатель | Функция |
|---|---|---|---|
| `engineer_order_new` (pending создан) | `engineer-routes.tsx:680+` | инженер | `notifyEngineerNewOrder` |
| `engineer_order_paid` (webhook accepted→in_progress) | `checkout-routes.tsx:1051+` | инженер | `notifyEngineerOrderPaid` |
| `engineer_order_delivered` (in_progress→delivered) | `engineer-routes.tsx:780+` | клиент | `notifyClientOrderDelivered` |
| `engineer_order_refunded` (PR #230 admin endpoint) | wire-up в follow-up'е после merge'а #230 | клиент | `notifyClientOrderRefunded` (готова в `email-helper.tsx`) |

Шлются ВСЕМ по умолчанию (mirror notifyArtistRequest). Per-user
toggle'ы для engineer-side эмейлов добавлены миграцией 105
(см. таблицу ниже). Глобальный opt-out продолжает работать через
`isUnsubscribed(email)` — гейт живёт внутри `sendEmail()`, новые
функции его наследуют.

#### Per-user email toggles (миграция 105)

Engineer-side эмейлы (`engineer_order_new`, `_paid`) гейтятся
колонками на `engineer_profiles`:

| Колонка | Default | Что гейтит |
|---|---|---|
| `notify_email_on_new_order` | `TRUE` | notifyEngineerNewOrder в `engineer-routes.tsx:686+` |
| `notify_email_on_paid` | `TRUE` | notifyEngineerOrderPaid в `checkout-routes.tsx:1062+` |

Engineer крутит toggle'ы в `/engineer/settings` → секция
«Email-уведомления». SSE/bell всегда включён — отключить «новый
заказ» в колокольчике смысла нет.

Гейт работает через `LEFT JOIN engineer_profiles ON user_id` прямо
в SQL emit-точки; если `engineer_profiles`-строки нет (legacy
adapter) — COALESCE TRUE сохраняет старое поведение. Денорм-колонки
(как `is_available`), не jsonb-распаковка — нужен fast-read в
hot-path webhook'а.

Клиент-side эмейлы (`engineer_order_delivered`, `_refunded`) — без
per-user toggle: клиент может никогда не иметь
`engineer_profiles`-строки. Если когда-то понадобится — это
отдельный account-settings flow, не engineer-cabinet.

### DM e-mail channel (since миграция 106, 2026-06-11)

Получатель direct-message'а (`POST /api/messaging/messages/:conversationId`)
получает помимо bell+SSE ещё и e-mail-нотификацию (`notifyDmReceived`
в `email-helper.tsx`).

Throttle: 1 письмо на (recipient, conversation) **в час** через
таблицу `dm_email_throttle` — composite PK `(user_id, conversation_id)`,
одно поле `last_sent_at TIMESTAMPTZ`. Атомарный UPSERT с
WHERE-фильтром по возрасту:

```sql
INSERT INTO dm_email_throttle (user_id, conversation_id, last_sent_at)
VALUES ($1, $2, NOW())
ON CONFLICT (user_id, conversation_id) DO UPDATE
   SET last_sent_at = NOW()
 WHERE dm_email_throttle.last_sent_at < NOW() - INTERVAL '1 hour'
RETURNING last_sent_at;
```

`RETURNING` пустой → throttle сработал, e-mail не шлём.
`RETURNING` непустой → или новая беседа, или прошёл час с последнего —
шлём.

Гейт **инлайнится** на module-load через `ensureDmEmailThrottleSchema()`
(messaging-routes.tsx) — миграция 106 file и `CREATE TABLE IF NOT EXISTS`
дублируют друг друга. На свежей проде `ensureSchemaInline` создаёт
таблицу автоматически при первом старте; миграция 106 файл лежит для
аудита/idempotency.

Шкипы:
- админы/superadmin'ы (получают Telegram через `forwardToTelegramIfAdmin`)
- юзеры без `users.email` (legacy / VK-only)
- глобально отписанные через `email_unsubscribes` (гейтит `sendEmail` сам)

Per-role toggle (например `engineer_profiles.notify_email_on_dm`) —
follow-up PR. Сейчас все роли получают по умолчанию.

### SSE (real-time)

`sse-routes.tsx` `connections` Map keyed by various identifiers:
- `<userId>` — main cabinet stream (auth+owner-checked)
- `guest:<token>` — chat-support guest stream
- `admin:chat-support` — admin dashboard broadcast

Frontend connects via EventSource (cookies + query token only —
EventSource doesn't carry Authorization header).

---

## Checkout / payment webhook — idempotency & amount-gate posture

Audited end-to-end 2026-06-17, **expanded 2026-06-18** to cover the new
gates landed today (track_test_promote/exclusive, pitching_bundle,
radio_campaign). This is the single source of truth so the next session
does NOT re-audit the whole `checkout-routes.tsx` fulfilment switch
from scratch.

### Two-layer defence

1. **Outer atomic claim** — every webhook entrypoint calls
   `claimPaymentSessionForProcessing(orderId)` (`db.tsx:398`) BEFORE
   `processPaymentSuccess`. It flips `payment_sessions.status`
   `'pending' → 'processing'` in one UPDATE and returns the session only to
   the winner. A naive re-delivery of an already-succeeded/processing order
   gets `null` → `webhook_already_processed` → no fulfilment re-run. On a
   handler throw, `revertPaymentSessionToPending` (`db.tsx:418`) puts it back
   to `'pending'` so the gateway retry can re-claim. **The only path to
   double-execution is therefore: side-effect commits → later throw → revert
   → retry.** That is the window each per-handler guard below closes.

2. **Per-handler idempotency guard** — every money/value-moving handler is
   self-idempotent so it survives a revert→retry re-entry:

| Flow (`metadata.type` / `itemType`) | Idempotency mechanism | Amount source-of-truth |
|---|---|---|
| topup / donation (balance) | `reserveCreditOnce` ledger (`db.tsx:275`) | n/a (user-set) |
| topup coins | `reserveCreditOnce` (separate `kind`) | n/a |
| subscription (artist / dj / venue) | claim + canonical plan price | `SUBSCRIPTION_PLANS` server-side |
| track_publish / dj_mix_publish / banner_publish | `WHERE moderation_status='approved'` | server gate in create-session |
| distribution / engineer_order / production_360 / collab_accept (escrow) | `WHERE status = <expected>` | server gate |
| track_test / publish_order / content_order | status/flag guard | server gate |
| beat / beat_purchase / digital_good / digital_purchase | deterministic id `bp-/dgp-${orderId}` + `ON CONFLICT (id) DO NOTHING`, side-effects gated on `rowCount>0` | `getBeat().licenseTypes[lt] ?? price` / `digital_goods.price` |
| radio_campaign | deterministic id `rc-${orderId}` + `ON CONFLICT` | **server gate (#288, 2026-06-18)** — `campaign.budget` from `venue_ad_campaigns` |
| venue_radio_subscription | `WHERE COALESCE(payment_order_id,'') <> $1` (the `+ INTERVAL '30 days'` is an increment — without this guard a replay = a free month) | n/a (fixed 30d) |
| pitching_bundle | `finalizePitchingBundle` UPDATE `WHERE status='pending_payment' AND payment_session_id=orderId` | **server gate (#284, 2026-06-18)** — `SUM(pitching_submissions.price_rub)` |
| track_test_promote | UPDATE `WHERE id=$trackId` (idempotent set of `expert_tested_until`) + `data.pipeline.promote.paid_at` guard | **hardcoded 3000 ₽** (`TRACK_TEST_PIPELINE_PROMOTE_PRICE`) + `request.user_id === userId` + `request.status === 'completed'` |
| track_test_exclusive | `smtpSendBatch` + `data.pipeline.exclusive.paid_at` guard (skip on dup) | **hardcoded 7000 ₽** (`TRACK_TEST_PIPELINE_EXCLUSIVE_PRICE`) + same ownership/status |
| engineer_order (revenue side) | `payee_id` resolved from `engineer_orders.engineer_id` (#287, 2026-06-18) — was hardcoded `metadata.artistId` (undefined for engineer_order → NULL payee) | `engineer_orders.price` via existing create-session gate |

### Known-residual (accepted, not bugs)

- **radio_campaign first-layer gap** — `POST /venue/radio-campaigns` (venue-
  routes.tsx:790) still accepts `body.budget` without server-side validation
  against slot prices. The #288 amount-gate on `/checkout/create-session`
  closes the public DevTools-tampering vector, but doesn't replace canonical
  pricing. Full fix = canonical `radio_ad_packages` table OR slot-SUM
  recompute in `POST /radio-campaigns`. Deliberate trade-off — radio ad
  deals are negotiated socially.
- **`itemType:'beat'` / `'digital_good'` legacy simple paths** — NOT dead
  code; create-session still accepts them and they ARE now amount-gated.
  Kept on purpose (orphaning would strand legacy `pending` sessions).
- **`service_order` no money flow** — `POST /services/:id/order` does NOT
  create a payment session; producer-client workflow runs on platform-
  commission-only logic (`recordPlatformCommission` triggered on
  `status='completed'`). Not a bug — design decision (gift-economy / future
  feature). #290 (2026-06-18) added terminal-state lock + role-based
  transitions to prevent workflow circumvention (producer reopening
  completed orders for repeat commission, client self-marking completed).

### Provenance — gates landed 2026-06-18 (this session)

- **track_test_promote / track_test_exclusive** — `/checkout/create-session`
  amount-gate added in PR #282, fulfilment in PR #280.
- **pitching_bundle** — amount-gate added in PR #284 (was missing — last
  gate of the BLOCKER C class found end-of-day).
- **radio_campaign** — amount-gate added in PR #288 (closes public vector,
  full slot-SUM gate still pending).
- **digital-goods IDOR (POST)** — `producerId` from JWT in PR #283 (mirror
  of `POST /beats` pattern).
- **dj_subscription IDOR + free-paid-bypass** — `/dj-studio/subscription/:djId/
  change` PR #286: djId === userId enforced; paid plans redirect to
  `/checkout/create-session`.
- **engineer revenue payee_id** — PR #287: derived from `engineer_orders`
  (was hardcoded `metadata.artistId` → NULL for engineer_order →
  `/engineer/earnings` returned 0 forever).
- **radio balance** — PR #285: `_getRadioBalance` now reads
  `SUM(stationPayout)` from `completed` venue_requests (was hardcoded
  `const balance = 0` → radio could never withdraw earned ad revenue).
- **radio ad commission + payment gate** — 2026-07-03: `RADIO_COMMISSION_RATE`
  выровнен на **0.10** (было 0.15 в `splitRadioCampaignAmount`, но ledger
  `platform_revenue` в checkout-webhook писал 0.10 → станция считалась от 85%,
  платформа книжила 10% — расхождение 5%). Теперь везде 10% / станция 90%.
  Плюс payment-gate: заявка заведения (`radio_venue_requests`) создаётся
  `status='pending_payment'`, радио её НЕ видит и НЕ может одобрить; webhook
  `radio_campaign` переводит в `'pending'` после оплаты; approve требует
  `requireStatus:'pending'`. Раньше станция могла одобрить/заработать
  `stationPayout` на неоплаченной кампании.
- **radio ad pricing = слоты станции (server-side)** — 2026-07-03 (решение
  владельца: «радио выставляет слоты, заведение их покупает, комиссия 10%»).
  `POST /venue/radio-campaigns` теперь ТРЕБУЕТ `timeSlots[]` = реальные slot id
  из `radio_ad_slots` этой станции (status='available') и считает
  `budget = SUM(slot.price) × durationDays` САМ — `body.budget` игнорируется
  (раньше принимался как есть → 1₽-кампания проходила amount-gate). Легаси
  строки ('any_time' и т.п.) → 400. FE venue radio-section: модалка покупки
  показывает живые слоты станции (GET /radio-profile/profile/:id/ad-slots),
  платит `campaign.budget` из ответа сервера. `slot.price` = ₽ за день ротации
  в слоте. Станция без слотов → покупка недоступна (сообщение в модалке).
- **tickets-system IDOR** — PR #289: owner-check on 5 endpoints (was: any
  authenticated user could read/modify/delete tickets by guessing UUID).
- **service_order workflow** — PR #290: terminal-state lock + role-based
  transitions.
- **track-test expert IDOR** — PR #278: identity from JWT on 5 expert
  endpoints + owner-check on `/submit-review` (closes coins-reward theft
  vector).

⚠️ Migrations 111 (DROP kv_store, PR #276) + 112 (track.expert_tested_until
columns, PR #280) require manual psql application — see migration files'
in-line MANUAL DEPLOY STEPS. Auto-runner is stub.

---

## DM-жалобы, onboarding, admin-блокировка (contract-audit 2026-07-02)

Полная сверка фронт↔бэк контрактов нашла 8 разрывов «фронт зовёт —
роута нет». Три закрыты новыми endpoint'ами (остальные — правки URL
на фронте, см. Promomusicfigma тот же день):

- **POST `/server/api/messaging/reports`** — юзер жалуется на
  собеседника из messages-page. Пишет в `dm_reports` (migration 022),
  category ∈ spam|abuse|impersonation|other, анти-флуд 20/24h на
  reporter'а. Source: `messaging-routes.tsx` (рядом с GET /admin/reports).
- **POST `/server/api/messaging/admin/reports/:id/resolve`** — админ
  закрывает жалобу: status → reviewed|rejected|actioned + resolution,
  проставляет reviewer_id/reviewed_at. До этого AdminDmReports.tsx мог
  только читать очередь.
- **POST `/server/api/settings/onboarding`** — ответы onboarding-визарда
  сохраняются в `user_settings.data.onboarding` (userId из JWT-cookie,
  НЕ из URL/тела). Раньше визард слал в несуществующий
  `/settings/user/unknown/onboarding` и данные молча терялись.
- **POST `/server/api/landing-data/admin/users/:userId/status`** —
  блокировка/разблокировка юзера из админки. UI-статус 'blocked' ↔
  enum-значение `'banned'::user_status` (login-гейт `db-client.tsx:641`).
  До фикса кнопка «заблокировать» в UsersManagement только оптимистично
  перекрашивала UI — запрос уходил в 404.

## Video promo-pipeline (VideoModeration, добавлен 2026-07-02)

**Решение владельца 2026-07-03: отдельный видео-тракт (таблица `videos`
+ раздел «Видео» у артиста + таб «Видео» в админ-модерации) —
КАНОНИЧЕН.** Параллельное «схлопывание в publish-флоу» от 2026-07-02
(редирект `/artist/video → /artist/publish`, убранный таб) отменено и
откачено — оно ставилось, когда тракт был демкой. Будущим сессиям:
НЕ схлопывать видео в publish повторно.

Три admin-действия над клипом из `admin/pages/VideoModeration.tsx`.
Цены подтверждены Никитой 2026-07-02 (совпадают с копирайтом UI).
Source: `videos-routes.tsx` (хендлеры + константы цен), фулфилмент
платных — webhook `checkout-routes.tsx` по `metadata.type`.
Требует **migration 122** (`videos.promoted_until / pipeline /
newsletter_requested_at / newsletter_sent_at`) — применить ДО рестарта.

- **POST `/api/videos/promoteToNovelty`** — 10 000 ₽. Артисту уходит
  payment-link (уведомление + SSE); после оплаты webhook
  (`video_promote`) ставит `promoted_until = NOW()+14d`. GET
  `/api/videos/newClips` подмешивает такие клипы ПЕРЕД спарсенным
  чартом (`source: 'promo_music'`) — секция «Новые клипы» на главной.
- **POST `/api/videos/addToNewsletter`** — бесплатно, мгновенной
  отправки НЕТ: клип ставится в очередь понедельничного weekly-дайджеста
  (`radio-digest-routes.tsx /run-weekly`, секция «Новые клипы для
  эфира», курсор `newsletter_requested_at → newsletter_sent_at`,
  штамп только при успешной отправке SMTP).
- **POST `/api/videos/exclusivePitch`** — 15 000 ₽. Payment-link
  артисту; после оплаты webhook (`video_exclusive`) шлёт именную
  рассылку по той же базе, что weekly-дайджест (`getWeeklyRecipients`:
  radio-юзеры + `radio_partner_contacts` минус `curated_2026` и
  отписки). `editors_count` в ответе = размер этой базы.
  Idempotency: `pipeline.exclusive.paid_at` — повторный webhook skip.

Загрузка видео артистом (добавлено следом, тот же день): `video-page.tsx`
теперь POST'ит метаданные link-видео (YouTube/VK) на `POST /api/videos`
→ строка в `videos` с реальным uuid + email-алерт админу; `upsertVideo`
(db.tsx) сохраняет `category`/`tags` (**migration 124**) и возвращает
вставленную строку (раньше ответ содержал фиктивный id, а
category/tags молча терялись). Ограничения: file-источник НЕ грузит
файл на сервер (модалка хранит только имя файла, прогресс
симулированный) — такие видео и черновики остаются локальными;
base64-превью из FileReader на сервер не шлётся (guard и на фронте,
и в upsertVideo: >2 КБ URL → '').

Новости артиста (добавлено следом, тот же день): `news-page.tsx`
раньше жила целиком на localStorage (DataContext) — новости артистов
не существовали для сервера, хотя обложка честно улетала в
`/storage/upload`. Теперь: создание/публикация черновика → `POST
/api/news` (upsert в таблицу `news` c owner-guard'ом — чужой id → 403),
свой список → новый `GET /api/news/mine`, удаление → новый `DELETE
/api/news/:id` (только своё). Обложка — `news.image_url` (**migration
123**), `data:`-URL отбрасываются с обеих сторон. Модерация артист-новостей (добавлено следом, тот же день; продуктовое
решение Никиты: одобренные — на страницу артиста И в общую ленту):
- Очередь: `GET /api/news/admin/artist-queue` (таблица `news` + имя
  артиста из `users`). `NewsModeration.tsx` переведена на неё — раньше
  страница читала `GET /api/news` (лента `news_public`) и парсила ответ
  как `{data}` при голом массиве → список был ВСЕГДА пуст, а
  approve/reject мутировали только локальный стейт.
- Решение: `POST /api/news/admin/:id/moderate` (`approved`/`rejected`+
  note, note обязательна при reject; migration 126 —
  `news.moderation_note/moderated_at/moderated_by` + индексы).
  Артисту уходит уведомление + SSE; причину отклонения он видит в
  news-page (`moderation_note` через GET /mine).
- **approve → общая лента:** строка копируется в `news_public` через
  существующий `upsertNewsPublic` (`source='artist'`,
  `status='published'`) — `GET /api/news` подхватывает её как обычную
  статью, тот же id (детальная `GET /api/news/:id` работает).
- **Страница артиста:** `GET /api/news/artist/:artistId` (public) —
  approved-новости; принимает и `users.id`, и `artist_profiles.id`.
  `ArtistPublicProfile.tsx` рендерит секцию «Новости артиста» (карточки,
  секция скрыта при нуле новостей).

Обложки/превью (fix 2026-07-02, тот же день): оба пути обложки новости
(кнопка И drag&drop) идут через общий `processCoverFile` →
`/storage/upload` (bucket `news-images`); превью видео в
`video-upload-modal.tsx` тоже грузится в storage (bucket
`video-thumbnails`) вместо FileReader-base64. Bucket `news-images`
открыт артистам в `storage-routes.tsx` `ARTIST_WRITABLE_BUCKETS` —
до этого артистский аплоад обложки новости получал 403 (bucket был
admin-only с времён, когда новости писали только агенты), но этого
никто не видел, т.к. новости жили в localStorage.

Модерация видео (добавлено следом, тот же день): очередь стала
реальной — `GET /api/videos/admin/list` (все видимые видео + artist
name + pipeline-состояние), решение `POST /api/videos/:id/moderate`
(`approved`/`rejected`+note, note обязательна при reject; артисту
уходит настоящее уведомление + SSE). Требует **migration 125**
(`moderation_status/note/moderated_at/moderated_by`; grandfather-шаг
помечает все существующие видео `approved`). `VideoModeration.tsx`
грузит этот список и шлёт решения на бэк; локальный `DataContext`
остался только как fallback при недоступном бэке.

---

## Track-test (тест трека) — реальный флоу и анти-зависание (2026-07-07)

Флоу НАМЕРЕННО полуручной — 3 админ-шага и 1 экспертный:
`pending_payment → payment_succeeded` (вебхук YooKassa ИЛИ квота
подписки сразу на /submit) → **админ /moderate approve** →
`pending_expert_assignment` → **админ /assign-experts** (1–10
экспертов, `required_expert_count = required_count || N`) →
`experts_assigned` → эксперты сдают отзывы (`/submit-review`, +50
коинов) → при `completed_reviews_count >= required_expert_count`
авто-консолидация → `analysis_generated` → **админ /finalize
approve** → `completed` → **админ /send-feedback** → отчёт уходит
артисту (`feedback_sent_date`). Source: `track-test-routes.tsx`.

**Точки молчаливого зависания, найденные 2026-07-07 (по сигналу
laptop о застрявших тестовых заявках) и закрытые:**
1. Уведомление эксперту при назначении было **фейком** —
   `console.log('Notification sent…')` и ничего больше. Эксперт не
   онлайн в момент назначения = никогда не узнает. → Теперь durable
   `notifications`-строка + SSE + email эксперту (users по email).
2. Оплаченный тест сигналил админу ТОЛЬКО эфемерным SSE, а
   **квота-путь подписки не сигналил вообще** (минует вебхук). →
   `notifyTrackTestPending` (email info@ + TG) из вебхука И из
   /submit-квоты.
3. SLA существовали только как цифры для дашборда
   (pipeline-engine DEFAULT_SLA) — никто не enforce'ил. → **POST
   /track-test/sla-sweep** (requireAdminOrKey, advisory-lock 924179,
   cron 6ч): заявки в нетерминальном статусе старше SLA + `completed`
   без `feedback_sent_date` >24ч → digest админу (email+TG).
   Неизвестные легаси-статусы ('pending' из старого сидинга) тоже
   всплывают (дефолт SLA 72ч).
4. Осталось БЕЗ авто-фикса (осознанно): завершение требует ВСЕХ
   `required_expert_count` отзывов — один молчащий эксперт держит
   заявку в in_review; sweep это ловит (72ч), но переназначение
   эксперта — ручное решение админа.

Наблюдение laptop «status='pending' + payment_status='completed' +
эксперты назначены» текущим кодом НЕ воспроизводится (submit создаёт
pending_payment/payment_succeeded; assign-experts ставит
experts_assigned) — это артефакты старого кода/тест-сидинга.
Чистку см. HANDOFF §10.

## ПРОМО.ЭИР embed-плеер (добавлен 2026-07-07)

Кнопка «Embed» на AirLivePage раздаёт iframe-код. До 2026-07-07 он
указывал на `/air/embed`, который НИКТО не обслуживал (nginx `/air/*`
→ Icecast/Go, там такого mount'а нет) — пользователи копировали
вечный 404.

Теперь:
- **`GET /server/api/air/embed`** (`air-routes.tsx`, public) — отдаёт
  самодостаточный HTML ~2.4KB: play/pause на Icecast mount
  `/air/live/promo.fm` (relative — работает на любом домене прода),
  now-playing поллится с `/server/api/air/now-playing` каждые 15с,
  ссылка на `promo-music.ru/air-live`. Без React/бандла — iframe
  лёгкий.
- Заголовки: `Content-Security-Policy: frame-ancestors *` (страница
  ОБЯЗАНА открываться в чужом iframe), `Cache-Control: public,
  max-age=300`. Глобальный `X-Frame-Options: DENY` в `index.ts`
  (security-headers middleware) имеет exemption ровно для этого пути.
- FE: `AirLivePage.tsx` embed-код теперь
  `${config.functionsUrl}/api/air/embed`.
- ⚠️ **nginx-каверза (laptop):** комментарий в index.ts говорит
  «nginx also sets these» — если nginx add_header'ит X-Frame-Options
  на `/server/*`, iframe останется заблокированным несмотря на Node.
  Нужно исключение для location `/server/api/air/embed` + проверка:
  `curl -sI https://promo-music.ru/server/api/air/embed | grep -i frame`
  → X-Frame-Options отсутствует, CSP frame-ancestors * есть.

## Security-посture после батча 2026-07-06 (ветка `claude/security-fixes-2026-07-06`, b4e1977 — НА ПРОДЕ)

⚠️ На момент записи код живёт на ветке, сервис перезапущен с неё,
PR ещё не смержен в main (см. OPERATIONS_LOG 2026-07-06 — не делать
`checkout main` на VPS до мержа). После мержа — file:line ниже
уточнить по main.

Что теперь ПРАВДА в проде:

- **Бан = мгновенный разлогин.** Блокировка юзера бампит
  `users.token_version` и ревокает его строки в `refresh_tokens` —
  access-JWT перестаёт проходить проверку, refresh невозможен. Для
  работоспособности ревока **RLS на `refresh_tokens` ВЫКЛЮЧЕН**
  (ручное изменение prod-БД). Source: `auth-routes.tsx` +
  `landing-data-routes.tsx` (ветка b4e1977).
- **Escrow-кредит ТОЛЬКО при успешном flip.** Auto-complete и admin/resolve
  кредитуют продюсера только если `rowCount > 0` на статус-UPDATE —
  повторный вызов не создаёт второй кредит. Source:
  `collaboration-routes.tsx`.
- **DM-throttle per-recipient** — лимит считается на получателя,
  обход мейлбомба через group-UUID закрыт (`messaging-routes.tsx`).
- **resend-verification не палит базу**: любой email → uniform 200,
  per-email cooldown (`auth-routes.tsx`).
- **`GET /promo-check/detections` скоупится на caller'а**:
  client-supplied `artist_id` игнорируется для не-админов, `track_id`
  проверяется на ownership (`t.user_id = userId`); админ (роль +
  `isAdminEmail`) может смотреть любого артиста.
  Source: `promo-check-routes.tsx` /detections.
- **Storage**: clamscan fail-loud (упавший антивирус = reject, не
  silent pass), `GET /storage/list` только под requireAdmin,
  magic-byte-проверка отклоняет файлы с подделанным расширением
  (`storage-routes.tsx`).
- **Stripe-gateway отдаёт реальный статус** платежа (был хардкод
  `pending`). **TBANK НЕ пропатчен** — там хардкод остался (латентно:
  рекуррент не в кроне, tbank-карт нет). Source: `gateway-stripe.tsx`.
- **Concert promote**: `cost > 0` обязателен — бесплатное промо через
  отрицательный `cost` закрыто (`concerts-routes.tsx`).
- **Topup coin-guard**: сервер пересчитывает коины по курсу 10 сам,
  клиентскому количеству не верит (`checkout-routes.tsx`).
  Контекст: коин-машинерия фактически мертва (6×5000 тест-коинов,
  0 транзакций за всё время) — поэтому topup понижен 🔴→🟢, а
  coin_transactions-леджер и deductCoins-гонка осознанно НЕ чинились.
- `.env` на VPS: права 600.

Известные открытые хвосты: TBANK-gateway pending-хардкод; FE
`/air/embed` (нужен nginx/Go-роут + решение есть ли реальный
air-плеер); concert self-approve — Никита сказал «штатно», не баг.
Полный реестр — у laptop'а: `promofm-open-security-findings.md`.

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

---

## Хранилище данных — НЕ KV, а PostgreSQL

Все 90 `*Store` в `src/db.tsx:1461-…` это **не** key-value хранилища
в духе Redis/Deno KV/Upstash. Это helper'ы `jsonbStore(table, pk)`
(определение `db.tsx:1425`) над PostgreSQL-таблицами с колонкой
`data jsonb`. Под капотом — `pg.Pool` напрямую (`db-client.tsx:10`),
никакого внешнего KV-сервиса нет и не было.

### Под капотом каждого `*Store`

```
store.get(id)    → SELECT data FROM <table> WHERE <pk> = $1
store.set(id, v) → INSERT INTO <table> … ON CONFLICT(<pk>) DO UPDATE
store.del(id)    → DELETE FROM <table> WHERE <pk> = $1
store.getAll()   → SELECT data FROM <table> ORDER BY created_at DESC
store.getByCol() → SELECT data FROM <table> WHERE <col> = $1
```

### Производительность горячих фильтров

Для частых WHERE на JSONB-поле — добавлять expression-индекс,
не переписывать стор в типизированные колонки. См. миграцию
`migrations/031_jsonb_hot_path_indexes.sql`:

| Таблица | Индексируемое выражение |
|---|---|
| bookings | `(data->>'status')`, `((data->>'eventDate')::tstz)` |
| publish_orders | `(data->>'status')`, `(data->>'type')` |
| venue_profiles | `(data->>'subscriptionStatus')`, expires |
| dj_profiles | `(data->>'city')`, `(data->>'verified')` |
| payment_transactions | `(data->>'status')` |
| service_orders | `(data->>'status')` |

EXPLAIN ANALYZE на любом из этих фильтров после миграции 031 покажет
`Index Scan using idx_*_jsonb` вместо `Seq Scan`.

### Когда переходить со store на типизированные колонки

JSONB удобен, но в трёх случаях нужны реальные колонки:
1. **Деньги** — `amount NUMERIC(12,2)`, не JSONB (риск float-арифметики)
2. **FK-целостность** — если ссылка должна каскадно удаляться/CHECK'иться
3. **JOIN'ы по часто-фильтруемому полю** — JOIN через
   `(data->>'field')::uuid` работает, но индекс на typed-колонке
   быстрее в разы

Пример уже мигрированной таблицы — `tracks` (typed-API в
`src/db-typed.tsx:99` getPublishedTracks etc.). Список оставшихся
`*Store` к рассмотрению на типизацию — раздел «Платежи / Финансы»
из ответа в чате 2026-05-26.


## Индексация новостей — корень найден и закрыт (2026-07-08, hotfix #301+#302 НА ПРОДЕ)

Реальный механизм отдачи статей ботам — НЕ снапшоты prerender.py, а
**серверный рендер `/server/prerender/*` (seo-routes.tsx)**, куда
nginx роутит поисковых ботов. Диагностика curl'ом на проде: sitemap
рекламировал 2016 URL статей из news_public, а обе ветки хендлера
(статья + листинг /news) читали legacy-таблицу `news` → КАЖДЫЙ
sitemap-URL отдавал боту 4KB SPA-оболочку. Новости не индексировались
никогда.

Фикс (сам цикл: хотфикс-ветка от main → PR #301/#302 → мерж →
авто-деплой Action → верификация ботом, всё cloud-сессией):
- статья: `getNewsPublic(id)` + status==='published', фолбэк legacy
  news; листинг: `listNewsPublic({status:'published', limit:30})`.
- ⚠️ Урок #301: news_public — НАТИВНЫЕ колонки с миграции 077, БЕЗ
  data jsonb (mapArticle с `row.data ?? row` — легаси-шим, врёт о
  схеме). Только typed-хелперы db.tsx.
- Верифицировано на проде: YandexBot/Googlebot получают title статьи,
  контент, h1, NewsArticle JSON-LD.

Следствие: prerender.py-снапшоты статей (b3f04c3) — вторичный слой;
основной канал — серверный рендер, он теперь и работает.

## Article-agent — авторские статьи 2×/день (добавлен 2026-07-08, v2 в тот же день)

Решения Никиты: статьи для привлечения всех аудиторий; «максимально
про ПРОМО.МУЗЫКА, вести через фразы на нужные разделы, оставаясь
максимально информативными; где-то рерайт, где-то авторство;
выходить 2 раза в день в 10:00 и 18:00».

- **`src/article-agent.tsx`** — НЕ путать с `news-agent.tsx` (тот
  переписывает чужие новости). Article-agent пишет СВОИ статьи под
  запросы ДЕВЯТИ семантических ядер (все xlsx 2026-07): артисты 12
  тем, диджеи 10, инженеры 8, продюсеры/композиторы 10, лейблы 6,
  международное продвижение 6, радио 4, ТВ 3, заведения 7 — итого 66
  (≈33 дня при 2/день). У тем есть `mode` ('authored' — чистое
  авторство / 'review' — обзор рынка, рерайт общеизвестного) и
  `landings` — разделы платформы, куда статья ведёт ссылками-фразами
  (2–4 на статью, анкоры из целевых запросов; информативность
  обязательна — промпт требует полный ответ и без кликов).
- **Запуск:** `POST /news-agent/generate-article` (requireAdminOrKey,
  advisory-lock 924180), cron 2/день — 10:00 и 18:00. Ротация
  аудитории по числу уже опубликованных статей агента → два тика в
  день = две РАЗНЫЕ аудитории. Внутри — первая неопубликованная тема
  (маркер `data.seoTopic` в news_public, новых таблиц НЕТ). Банк
  исчерпан — `{done:true}` без публикации. `GET /article-topics` —
  остаток.
- **Генерация:** quickLLM (llm-router), персонажи news-agent
  (Лиана/DJ Den/Нико/Марк/Сандра/РэдКэт). Промпт запрещает выдумывать
  статистику/цены платформы и гарантии; ровно одна ссылка на
  профильную LP. Ответ LLM не-JSON/короткий → статья НЕ публикуется,
  ошибка в ответе (перегенерация тем же topicSlug).
- **Дистрибуция автоматом** (уже существующие механизмы): лента
  /news, sitemap с lastmod, prerender-снапшот (40 свежих),
  IndexNow+Yandex-ping через pingSitemapAsync.
- Пополнение банка тем = править массивы AUDIENCES (чистые данные,
  без логики).

## Genre-detect — определение стиля трека (добавлен 2026-07-11)

**Инцидент-повод:** рассылка 09.07 — ВСЕ треки «Pop», включая U2 и
Beyoncé. Корень: `friday.js` при пустом/нечитаемом ID3-теге ставил
дефолт `'Pop'` (3 места в `getMetadata`). Дефолты заменены на `''` —
принцип фичи: **не угадали → жанр честно ПУСТОЙ, никогда не 'Pop'**.

**Каскад** (`src/genre-detect.tsx`):
1. **Tier 1 — ID3-тег** → **Tier 2 — нормализация к канону**:
   27 жанров, `CANON_GENRES` = копия списка формы загрузки
   (Promomusicfigma `track-upload-page.tsx` GENRES — менять синхронно).
   Понимает ID3v1-коды («(17)»→Rock), ru/en-синонимы («рэп»→Hip-Hop,
   «шансон»→Folk), поджанры→родитель (trap→Hip-Hop, metal→Rock,
   lofi→Electronic), мульти-жанры («Rock; Pop»→первый распознанный).
   «Other»/«Unknown» → null.
2. **Tier 3 — LLM** (`detectGenreLLM`): quickLLM по «артист — название»,
   tag `genre-detect`, maxTokens 8; ответ строго валидируется по канону
   (не из списка / «Unknown» → null).
3. Аудио-ML (по мотивам ADDinc/style_music, Denis-Mukhanov) — **бэклог
   tier-4** в promo-check python, не реализовано.

**Где срабатывает:**
- Загрузка трека без жанра: fire-and-forget `enrichTrackGenre` в
  `tracks-routes.tsx` POST / и `track-moderation-routes.tsx`
  /submitTrack. Guard `WHERE genre IS NULL OR genre=''` — ручной ввод
  артиста не перетирается.
- **POST /server/api/tracks/genre-backfill** (`tracks-routes.tsx`) —
  разовый прогон по хвосту: пустые жанры + system-friday 'Pop'
  (заражённый дефолт, тегу не доверяем — сразу LLM). requireAdmin или
  X-Internal-Key; advisory-lock **924181**; батч 25/тик, дёргать до
  `remaining=0`.

**tracks.genre_source** (миграция `135_tracks_genre_source.sql`,
НЕ автоприменяется): 'tag' | 'llm' (загрузка) | 'backfill-llm' |
'backfill-unknown' (backfill); NULL = не проходил через genre-detect.
Backfill маркирует КАЖДЫЙ проверенный трек (иначе батч зациклится);
при «неизвестно» заражённый friday-'Pop' очищается в `''`.

**После завершения backfill** обязательно перегнать
`friday.js sync-library` — `radio_library` копирует genre из tracks
и иначе останется с 'Pop'.

## Радио-пикапы: витринный декор vs реальный эфир (инцидент 2026-07-13)

**Инцидент:** кабинет артиста (DJ Альберт) показывал «80 подтверждённых
ротаций» на Русском Радио/Европе Плюс и т.д. — при нуле реальных
promo.check-детектов. Это была ФИКЦИЯ, показанная как «по отчётам
радиостанций».

**Два генератора декоративных пикапов** (`source='auto'` в
`track_radio_pickups`, задумка — маркеры «N радио / M городов» на
витрине «Новинки недели»):
1. `friday.js` (~стр. 328–356) — при импорте релиза 2–6 случайных
   станций из зашитого списка федеральных + случайные города.
2. `daily-radio-growth.js` (cron 13:00) — ежедневно +1–2 пикапа с
   `rotation_count = 1 + random*6` трекам из последних 6 релизов,
   потолок 8 станций/трек.

**Как фикция попала к живому артисту:** `promote-upcoming`
(track-moderation-routes.tsx) инжектит опубликованные артист-треки в
активный weekly_release → daily-radio-growth качал им фейк; фильтр
«реального эфира» проверял только источники пикапов, не владельца
трека.

**Фиксы 2026-07-13:**
- **Read-side (кабинет артиста):** `source='auto'` исключён из
  `/artist-analytics/home` (карточка ротаций), `/artist-analytics/
  radio-details` (страница «Ротации на радио») и `/tracks/radio-stats/
  all` (бейджи на треках). Фильтр `IS DISTINCT FROM 'auto'` — легаси-
  строки с NULL source остаются.
- **Write-side:** daily-radio-growth скипает треки, чей `tracks.user_id`
  существует в `users` (реальный пользователь). Декор — только
  синтетическим friday-кабинетам (их user_id — random UUID без
  users-строки).
- **Прод-чистка (laptop):** DELETE auto-пикапов с треков реальных
  пользователей — см. issue.

**Публичная витрина** (лендинг «Новинки», weekly-releases,
landing-data) auto-пикапы ПРОДОЛЖАЕТ считать — решение Никиты
2026-07-13: «убираем в кабинетах» (витрину не трогаем).
