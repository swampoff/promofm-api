# Remaining Cabinets Audit — 2026-05-31

**Scope:** Mini-audit 5 кабинетов после артиста: **label, dj, radio_station, venue, producer**. Та же шкала (🔥 INC / 🔴 КРИТ / 🟠 ВАЖНО / 🟡 ЗАМЕТКА), что в admin- и artist-аудитах. Цель — overview для приоритизации, не deep-dive.

**Метод:** 5 параллельных Explore-агентов, каждый ≤500 слов по 4 категориям (mocks / API / dead UI / security).

---

## Сводка (16 issues total — для приоритизации batch'ей)

| Кабинет | 🔥 INC | 🔴 КРИТ | 🟠 ВАЖНО | 🟡 ЗАМЕТКА | Состояние |
|---|---|---|---|---|---|
| **label** | 0 | 0 | 2 | 1 | ✅ MVP-grade — clean |
| **dj** | 0 | 1 | 1 | 3 | 🟢 чисто, аудит-лог на финансы |
| **radio_station** | **2** | **3** | 4 | 4 | 🔴 **самый проблемный** |
| **venue** | **2** | **1** | 3 | 3 | 🟠 IDOR POST /orders |
| **producer** | 3 | 3 | 4 | 4 | 🟠 MIME + public portfolio + audit |

---

## 🟢 label cabinet

### 🟠 ВАЖНО
- **L-A1** localStorage cache mismatch — `LabelNotificationsPage.tsx:17` падает на `localStorage.getItem('labelProfileId')`, но Profile page кеширует только `labelAvatarUrl` (line 46). Stale ID в transition.
- **L-A2** `LabelAnalyticsPage.tsx` — нет try-catch вокруг `fetchLabelAnalytics()`, top-5 артистов рендерит `undefined` при API error.

### 🟡 ЗАМЕТКА
- Все endpoints под `requireLabelRole()`. Roster ops валидируют ownership per artist. Upload validate MIME (8MB, JPEG/PNG/WebP/GIF). Bio/socials — plain text. ✅

---

## 🟢 dj cabinet

### 🔴 КРИТ
- **B-D1** нет audit log на финансовые операции — `dj-studio-routes.tsx` `/finances`, `/finances/payout` мутируют без записи в `audit_logs`. Аналог B-8 admin / B-A1 artist.

### 🟠 ВАЖНО
- **A-D1** `dj-marketplace-routes.tsx:307-316` `POST /djs/:id/book` — optional-auth, продолжает как guest при невалидном JWT, но не валидирует `clientEmail` → спам-бронирования с невалидных адресов.

### 🟡 ЗАМЕТКА
- **D-D1** MIME audio — frontend `File.type` есть, backend должен повторить.
- **D-D2** `FALLBACK_DJ_USER_ID = 'anonymous'` в `dj-studio-routes.tsx:37-45` — защищён `requireAuth`, но pattern fragile.
- **D-D3** Hardcoded portfolio categories в `DjProfileEditor.tsx:41-45` — graceful degradation, ОК.

---

## 🔴 radio_station cabinet — самый проблемный

### 🔥 INC
- **INC-R1** IDOR в PUT `/profile/:radioId` — `radio-profile-routes.tsx:149` берёт URL-param `radioId` БЕЗ ownership check. Любая radio_station может править чужой профиль. `ownsRadioProfile()` есть для logo/cover, но НЕ для PUT.
- **INC-R2** GET `/profile/:radioId` БЕЗ `requireAuth` — `radio-profile-routes.tsx:128`. Любой может читать чужой профиль через guess radioId.

### 🔴 КРИТ
- **B-R1** Silent-drop `body.notes` в `/orders/:id/approve` — `radio-routes.tsx:536-537` (`void body.notes`). Фронт может слать — backend игнорит.
- **B-R2** `FALLBACK_RADIO_USER_ID = 'anonymous'` — `radio-routes.tsx:48,52` — если `c.get('userId')` null → ВСЁ работает под `'anonymous'`. Cross-station contamination в KV-store.
- **B-R3** Нет audit log на DELETE `/ad-slots/:id` — `radio-routes.tsx:150`.

### 🟠 ВАЖНО
- **A-R1** `radio_finance + radio_transactions` — dead stores (`radio-routes.tsx:653-688`). Возвращают нули, 0 writers в codebase.
- **A-R2** Нет rate-limit на accept/reject заявок — `radio-routes.tsx:197,276`.
- **A-R3** Race на `/venue-requests/:id/complete` — `radio-routes.tsx:382`, status-check есть но нет SELECT FOR UPDATE.
- **A-R4** Многие endpoints на `requireAuth` без `requireRole('radio_station')` — другие роли могут дёрнуть `/ad-slots/list` и т.п.

### 🟡 ЗАМЕТКА
- **D-R1** KV-store на artist_requests/venue_requests/notifications (`radio-routes.tsx:33-35`) — техдолг (миграция на row-per-entity).
- **D-R2** Analytics — empty finance metrics, нет шаблонов графиков.
- **D-R3** `/register-player` `/player-status` (`radio-routes.tsx:1021-1052`) — hardcoded результаты, не трогают БД.
- **D-R4** Нет XSS issues, error 500-prone normalized через `safeErrorMessage`.

---

## 🟠 venue cabinet

### 🔥 INC
- **INC-V1** POST `/orders` БЕЗ ownership check — `content-orders-routes.tsx:54-84`. Frontend шлёт `venueId` в body, backend верит без проверки `venueId === userId`. Venue может создать заказ для **чужого** заведения. GET защищён правильно (line 99-101), POST — нет.
- **INC-V2** Hardcoded analytics fallback на frontend — `venue/components/analytics-section.tsx:86-97`. Раньше захардкоженные 53125/245%/85K. Сейчас `?? 0` — показывает нули как «успешный load» при API down.

### 🔴 КРИТ
- **B-V1** Тот же INC-V1, формализован: POST не извлекает `venueId` из контекста, доверяет body.

### 🟠 ВАЖНО
- **A-V1** Нет rate-limit на POST `/orders` — спам заказов (pending_payment, реальный damage зависит от шлюза).
- **A-V2** Notifications empty fallback вместо error UI — `venue/components/notifications-section.tsx:26-27`.
- **A-V3** Если INC-V1 не закрыть → созданные через POST orders с чужим venueId могут утечь через другие queries.

### 🟡 ЗАМЕТКА
- **D-V1** XSS защита есть в email-helper (`escapeHtml(venueName)` :239-240). Frontend не проверен.
- **D-V2** `venue_api_tokens` scopes хорошо разделены (`venue-api-routes.tsx:83-89`), hash правильный.
- **D-V3** DELETE orders логируется через `logAdminAction` (admin-only guard).

---

## 🟠 producer cabinet

### 🔥 INC
- **INC-P1** Нет rate-limit на destructive — `producer-studio-routes.tsx:1040` wallet/withdraw, DELETE services/portfolio.
- **INC-P2** Нет audit log на destructive — `producer-studio-routes.tsx:623-639` (DELETE /services), 870-888 (DELETE /portfolio/v2).
- **INC-P3** AI fallback hardcoded без контекста — `producer-studio-routes.tsx:1161-1174` → `fallbackRecs(dc)` (line 1196). Клиент получает идентичные «Добавьте услуги»/«Активнее продвигайте» как реальные AI-рекомендации.

### 🔴 КРИТ
- **B-P1** Audio upload только по расширению, нет magic-byte / MIME — `producer-studio-routes.tsx:783-790` → `saveUpload(..., PRODUCER_AUDIO_EXTS, ...)`. `cabinet-uploads.tsx:59` — только `sanitizeExt()`. Malicious binary → .mp3.
- **B-P2** Public portfolio БЕЗ rate-limit — `producer-studio-routes.tsx:891-923` GET `/portfolio/v2/public/:userId`. Public + raw `description` из БД (frontend санитайзит, но API-консюмеры — нет).
- **B-P3** IDOR на services→marketplace sync — `producer-studio-routes.tsx:495-522` `syncServiceToMarketplace`. Если PUT `/services/update/:serviceId` IDOR не закрыт — поддельный service попадает в публичный маркетплейс.

### 🟠 ВАЖНО
- **A-P1** Profile update без audit — `producer-studio-routes.tsx:925-952` PUT `/profile/update`. Bio/city/workPhilosophy мутируются без следа (критично для верификации).
- **A-P2** Fallback recs неверны для активных producer'ов (всегда «добавьте услуги» даже если 5).
- **A-P3** Race на conversation metadata — `producer-studio-routes.tsx:260-273` POST `/messages/send`. UPDATE без LOCK.
- **A-P4** Sessions без time-validation — `producer-studio-routes.tsx:1293-1325` POST `/calendar/create` принимает `startTime`/`endTime` без `start < end`.

### 🟡 ЗАМЕТКА
- **D-P1** Portfolio V1 (jsonb) + V2 (SQL table) coexist без migrate-скрипта.
- **D-P2** AI context: 5 query'ев на каждый `/ai/analyze` без кеширования.
- **D-P3** `/messages/poll since='1970'` default — без `since` selects всю историю.
- **D-P4** Wallet withdrawals `ON CONFLICT DO NOTHING` без подтверждения индекса.

---

## Приоритизированный план batches

### Phase 1 — INC fixes (сразу, urgency = data leak / IDOR)

| Batch | Что | Файлы |
|---|---|---|
| 1.1 | **INC-R1+R2** radio: PUT/GET profile — ownership + requireAuth | radio-profile-routes.tsx |
| 1.2 | **INC-V1** venue POST orders — игнорить body.venueId, брать из JWT | content-orders-routes.tsx |
| 1.3 | **INC-P1+P2** producer rate-limit + audit log на destructive | producer-studio-routes.tsx + audit-helper |

### Phase 2 — КРИТ batches

| Batch | Что | Кабинет |
|---|---|---|
| 2.1 | radio: silent-drop notes + FALLBACK 'anonymous' + audit DELETE ad-slots | radio |
| 2.2 | dj: audit log finances/payout | dj |
| 2.3 | producer: MIME magic-byte + public portfolio rate-limit + IDOR services-sync | producer |

### Phase 3 — ВАЖНО / ЗАМЕТКА — quick wins
Mini-batch'и по кабинетам (rate-limit / audit / dead stores cleanup).

### Phase D — отложено (требует архитектурного решения)
- KV→SQL migration для radio_requests / venue_requests / notifications (B-R)
- Portfolio V1→V2 migrate script (D-P1)
- Refactor FALLBACK_* anonymous patterns (B-R2, D-D2)

---

## Что НЕ нашли (clean across cabinets)

- **No silent-drop** в label/dj/venue (mapping ок).
- **No XSS** через `dangerouslySetInnerHTML` в любом cabinet (только sanitized AI responses в producer).
- **No missing endpoints** (frontend fetches match backend routes).
- **No dead routes/tabs** (label/dj/venue/producer — все навигации работают; radio имеет dead `/register-player`).
- **API tokens** scopes/hash правильные везде (venue_api_tokens; radio_api_tokens отсутствует — возможно намеренно).
