# Operations Log — promofm-api

Append-only chronicle of **manual interventions on production data**
that aren't visible in git history: direct SQL on the prod DB,
admin-panel edits, account-specific fixes, config tweaks, manual
service kicks. Plus narrative notes on "weird state" we encountered
and what we did about it.

**Why this file exists:** Claude sessions start with zero memory of
prior sessions. If you ran `UPDATE ...` in psql yesterday or
clicked something in `/ctrl-pm7k2f` that changed prod data, the
next Claude session won't know unless it lives here. Code comments
catch *some* of this (see `track-moderation-routes.tsx:324` "Nadezhda
incident") but free-form ops should land here too.

## Format

Newest entries at the top. Use this template:

```md
## YYYY-MM-DD — <one-line summary>
- **What:** human description of the change
- **Affected:** user IDs / table rows / entities involved
- **Why:** what problem prompted this
- **How:** the actual SQL / command / UI action(s)
- **Verified:** how we know it worked
- **Follow-ups (if any):** related code that should track this,
  or audit-tasks for future sessions
```

For multi-step interventions, list each step under **How**. Keep
SQL snippets exact — future Claude will read them as the canonical
record of what got executed.

---

## 2026-05-31 — Security audit batch (Phase A+B+C) + INC-1 key rotation + INC-3 migration 094

**Контекст:** двухагентный аудит admin-кабинета (frontend + backend, security+privacy). Найдено 3 INCIDENT + 11 КРИТ + 21 ВАЖНО/ЗАМЕТКИ. Отчёт — `docs/AUDIT_admin_security_2026_05_31.md` (PR #135). 18/24 пунктов закрыты, в проде. **Эта запись нужна чтобы следующая сессия знала про прод-ротацию и migration 094, иначе можно случайно «починить» правильный код или повторно применить миграцию.**

### Smerged & deployed (порядок merge'а)

| Batch | PR | Что закрыло |
|---|---|---|
| Backend 1 | #136 | INC-1 (cron-скрипты читают `VPS_INTERNAL_KEY` из `.env`, не hardcoded), INC-2 (`/send-payment-reminders` sentinel против `c.json()`-без-throw bypass), B-1 (rate-limit skip ужесточён `isAdminToken` → `isSuperadminToken` — narrow на `SUPERADMIN_EMAIL`+role) |
| Backend 2 | #137 | INC-3 (migration 094 + route gate на `_errors`), B-2 (`password_hash`/`mfa_secret` strip на источнике в обоих export-loops, не post-step), B-5 (UUID-валидация `orderId` + audio-ext allowlist в content-orders/upload), B-6 (`X-Internal-Key` убран из CORS `allowHeaders`), B-9 (`escapeHtml` экспортирован, обёрнуты HTML email-контексты track/dj-mix moderation), B-10 (verify-profile match users.role) |
| Backend 3 | #139 | B-8 (новый `src/audit-helper.tsx` + `logAdminAction` подключён к 8 admin actions: track-moderation approve/reject, dj-mix approve/reject, user_approve/reject, profile_verify/unverify, publish_order_status_change + batch, email_campaign_send) |
| Frontend 1 | #76 | F-1 (убран `userEmail !== ADMIN_EMAIL` в AdminApp.tsx — role-only gate), F-2 (XSS в EmailCampaigns preview, `sanitizeHtml` уже был импортирован но не вызывался на L766), F-4 (Bearer header в apiCall), F-5 (window.confirm перед block user / delete partner) |
| Frontend 2 | #77 | F-6 (email-campaign draft localStorage→sessionStorage — customEmails не выживает между сессиями), F-9 (AdminDmReports на `config.functionsUrl`), F-10 (`toast.success` в catch блоках Support.tsx → `toast.error`), F-11 (`promptBounded` для DM-report resolution: trim + max 500) |
| Docs | #135, #138, #140 | аудит-отчёт + threat-detector callout (см. ниже) |

### INC-1 — VPS_INTERNAL_KEY rotation (laptop, ssh prod, выполнено)

- **Что было опасно:** key `b5f5cced4f4297465726e7069e35c1d113319187853b765af0e8b4df80d7acc3` лежал plaintext в 4 cron-скриптах в git репо. Открывал `requireAdminOrKey`-endpoints: `charts/full-update`, `landing/admin/news` CRUD, `landing/admin/tracks` CRUD, `ecosystem/mode/evolve/run`, `concert-agent/*`, `news-agent/*`, `release-agent/*`, `curator/*`, `landing/seed-live`, `landing/releases/archive-past`. Любой с read-доступом к репо → full backend admin.
- **Сделано laptop'ом:**
  1. Новый ключ через `openssl rand -hex 32`, записан в `/opt/promofm-api/.env` (gitignored)
  2. Cron-скрипты после PR #136 читают `${VPS_INTERNAL_KEY}` через `set -a; source /opt/promofm-api/.env; set +a`. Если var отсутствует — `${VAR:?...}` fails loudly (НЕ silent fallback на старый).
  3. Restart `systemctl restart promofm-api`
- **Verify (выполнено и подтверждено):**
  - `curl -H "X-Internal-Key: b5f5cce..."` (старый ключ) → **401** ✅
  - `curl -H "X-Internal-Key: $NEW_KEY"` → 200/работает ✅
  - `bash /opt/promofm-api/promote-upcoming-cron.sh` → проходит ✅
- **Git history scrub:** статус по словам user'а «scrub done», но **не задокументирован способ** (filter-repo / BFG / force-push). Verify-команда на следующей сессии если нужно:
  ```bash
  git log --all -p | grep -c 'b5f5cced4f4297465726e7069e35c1d113319187853b765af0e8b4df80d7acc3'
  # 0 = scrub успешен; >0 = ключ ещё в каком-то ref'е
  ```

### INC-3 — migration 094 applied to prod (laptop, выполнено)

- **Файл:** `src/migrations/094_delete_user_account_surface_errors.sql` (PR #137)
- **Что меняет:** `CREATE OR REPLACE FUNCTION public.delete_user_account(p_user_id text)`. Старая функция (092) обёрнута `EXCEPTION WHEN OTHERS THEN NULL` на КАЖДОМ per-table delete — FK violation / RLS denial silently swallowed → orphan PII при `users` delete success. GDPR/152-ФЗ regression vector. 094 различает **expected skip** (`undefined_table`/`undefined_column` — таблица дропнута в mig 091) от **real failure** (FK, RLS) — real failures собираются в `_errors` jsonb. Route gate'ит success на `_errors` пустой (PR #137 hardening profile-routes.tsx).
- **Apply (выполнено):**
  ```bash
  sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
  BEGIN;
  \i /opt/promofm-api/src/migrations/094_delete_user_account_surface_errors.sql
  COMMIT;
  EOF
  ```
- **Verify:** round-trip PASS (по словам user'а) — тестовый delete проходит, `_errors` пусто на здоровом пользователе. **Идемпотентно** — `CREATE OR REPLACE` не трогает данные, можно reapply'ить без эффекта.

### threat-detector.tsx:615 callout (INC-2 sentinel — wrong status code, НЕ дыра)

**Симптом:** при verify INC-2 — `POST /server/api/track-moderation/send-payment-reminders` без `X-Internal-Key` И без admin-куки (полностью неавторизованно) → **500 RangeError: init["status"] must be in the range of 200 to 599**. Sentry стек всплывает на `threat-detector.tsx:615 (await next)` — но это middleware на пути, не источник.

**Источник:** sentinel-паттерн в `src/track-moderation-routes.tsx` `/send-payment-reminders` (PR #136). `requireAuth`/`requireAdmin` пишут 401/403 через `c.json()`, **не throw'ят**. Sentinel `let authorized = false; ...; if (!authorized) return;` корректно прерывает, **но в no-auth ветке c.res получает status вне 200-599** (вероятно undefined/0/>599) → RangeError при serialize.

**Важно — bypass всё равно закрыт:** работа не выполняется (fail-closed), просто Hono отвечает 500 вместо чистого 401/403. Это **wrong status code**, не уязвимость. Sentry-нойз + плохая клиентская диагностика.

**Fix TODO** (моя зона как автор sentinel, отдельный PR):
- Найти где в no-auth ветке выставляется out-of-range status. Скорее всего `c.json(..., <undefined>)` или sentinel return оставляет `c.res` с битым статусом из downstream-write.
- Заменить sentinel на явный `return c.json({ success: false, error: 'Unauthorized' }, 401)` если `!authorized` (вместо bare `return`).
- Применить тот же паттерн ко **всем** будущим dual-auth (cron-key ИЛИ admin) endpoints — это generalisable bug.

User записал короткую версию в #140 («threat-detector.tsx:615»). Полная природа — этот entry.

### Что ОСТАЛОСЬ из аудита (Phase D — не сделано)

| # | Что | Почему отложено |
|---|---|---|
| **B-3** | `/auth/admin/pending-users` PII pagination | Self-contained, маленький PR — могу сделать в любой сессии |
| **B-4** | RBAC vs superadmin-gate consistency | Архитектурное решение user'а: одна `requireAdmin` (фактически superadmin) vs полноценный RBAC по permissions. `rate-limiter` trusts role alone; `requireAdmin` требует ещё `SUPERADMIN_EMAIL`. Inconsistency осталась. |
| **B-7** | `/email-campaigns/unsubscribe` signed token | Self-contained, новый HMAC flow — могу сделать |
| **F-3** | JWT в localStorage → HttpOnly cookie | Большой backend+frontend coordinated refactor — отдельная сессия с design pass |
| **F-7** | Secrets рендерятся в admin UI (`Settings.tsx` tbank/yukassa/smtp keys через `GET /api/settings`) | Масштабный write-only refactor — отдельная сессия |
| **F-8** | CSRF UI toggle misleading (`Settings.tsx:790`) | Зависит от F-3 решения (cookie-auth → нужен реальный CSRF) |
| **B-8 follow-up** | Audit logging на content-orders delete, landing/admin/tracks delete, banner moderation | Lower-priority — основные trust/money/mass actions покрыты |

### Не сделано (намеренно)

- **`charts-routes.tsx /full-update` запуск** — user попросил «обнови все чарты» в этой сессии, **но я не запускал из cloud** (нет ssh + internal key). Команда отдана laptop'у; запускалась ли — неизвестно cloud-сессии. Если будут вопросы «почему чарты старые» — проверить запуск.
- **F-8 (CSRF UI toggle)** в #77 — toggle оставлен. Не угадывал backend settings-shape, риск был сломать persistence.

### Follow-ups

- При следующем коде-тач'е track-moderation-routes / любого dual-auth endpoint — починить sentinel status-code (см. threat-detector callout выше).
- Periodic audit `audit_logs` — теперь B-8 пишет на 8 admin actions, можно построить admin-monitoring дэш / алерты на necesseity-of-resolution decisions (mass-reject, mass-email).
- Если будет ещё security audit — F-3/F-7 это следующие большие куски.

---



**Инцидент:** промо «первая публикация бесплатно» раздавало бесплатные публикации (должно быть 5000 ₽ за трек). Отключено по всему стеку:
- **Backend (PR #132):** isFirstFree=false в track-moderation (single + batch) и dj-mix-moderation. Новый одобренный трек теперь: moderation_status='approved', is_hidden=true, requires_payment=true, payment_amount=5000. Smoke по коду пройден.
- **Frontend (PR #70 + дочистка #72, #73):** убраны ВСЕ freemium-формулировки в разных видах («бесплатно», «без оплаты», «первая публикация», «первого трека») из PricingPage, seo-pages.ts (5 мест), SunoMainContent, FloatingCtaBar, DjMixModeration. Build verified грепом = 0 first-free заявлений. NB: #70 (моб) убрал не все варианты — фразы «без оплаты» / «первого трека» ловятся другим грепом, дочищено #72/#73.

**2 трека успели опубликоваться бесплатно. РЕШЕНИЕ (бизнес): GRANDFATHER — оставить бесплатно, НЕ выставлять счёт, НЕ скрывать. Будущим сессиям: НЕ «чинить» их платность, это намеренно (акция была активна на момент публикации):**
- Deafness (c313bd82, ANGLDR) — first_track_free_applied=true, upcoming, 0₽
- Инсульт (97bcb090, Сергей Гребеньков) — first_track_free_applied=true, upcoming, 0₽

**Не сделано (намеренно):** DB-флаги first_track_free_applied / first_mix_free_applied оставлены (впредь всегда false, dead) — cleanup опционален отдельным PR. IndexNow re-ping /pricing — опционально для SEO (Yandex/Google могут держать snippet «первый бесплатно» в кеше).

---

## 2026-05-31 — news pipeline 089-drift fix (093 + #127) + frontend deploy.sh --delete trap

**Prod-интервенции (laptop, ssh):**
- **trg_sync_news_public ДРОПНУТ** (миграция 093, PR #129). Триггер на news_public делал `IF NEW.data IS NOT NULL ...`, но колонку `news_public.data` снёс KV-kill -> КАЖДЫЙ insert новости падал 500 ("record new has no field data") -> news-agent постил 0 новостей с ~29.03 (2 мес). После дропа: +7 русских новостей за прогон. DDL применён на проде + файл миграции в main.
- **PR #127** (news-agent prompt). Translation-инструкция была жёстко привязана к английскому ("ИСТОЧНИК НА АНГЛИЙСКОМ") -> remezcla (исп. источник) шёл СЫРЫМ испанским и в /news лендинг, и в TG (один pipeline: news-agent -> upsertNewsPublic -> news_public -> обе поверхности). Обобщён на любой иностранный -> русский. Verified: remezcla теперь по-русски (имена артистов/альбомов оставляет на оригинале). Merged + backend redeploy (git pull main + restart). Старые испанские строки остаются в БД (backfill SQL в описании PR #127).

**DEPLOY TRAP (frontend Promomusicfigma deploy.sh):**
- deploy.sh делал: rsync -a --delete dist/ -> /var/www/promofm/html/. Папка dist/ НЕ содержит server/ -> флаг --delete СНОСИЛ /var/www/promofm/html/server/uploads/{covers,tracks} (symlinks на /opt/promofm-api/uploads/*) -> отваливались ВСЕ обложки и аудио треков (включая новинки #22). avatars/ безопасен (он есть в dist/).
- Фикс (PR #67): в deploy.sh добавлен --exclude='/server'. Теперь rsync --delete не трогает uploads-symlinks.
- ПРАВИЛО: после КАЖДОГО фронт-деплоя проверять `ls /var/www/promofm/html/server/uploads/` (covers + tracks на месте) + cover/audio HTTP 200/206.

---

## 2026-05-31 — Новинки недели #22 + friday.js post-089 fix + позиционный порядок

**Что сделано (laptop, ssh prod):**
- **Релиз #22** «Новинки недели #22 (29 мая 2026)» создан через `friday.js scan` — 10 треков из `~/Desktop/SOULFM_music/PROMOFM` (EMIN/JONY, Tasso, Santana/Becky G, Ariana Grande, Merab Amzoevi, Ruki Vverh!, Irakli, Filatov & Karas, Yolka, McCartney) + Гуськова «Это и есть любовь» (`e77b1053`) добавлена вручную в **позицию 6 (середина)** из 11. is_published=true.
- **friday.js был СЛОМАН миграцией 089** (DROP tracks.data): INSERT в tracks.data (L190) + showStatus (L292) падали. Пропатчен на VPS, закоммичен в ветку `claude/friday-week22-positional-order` (**PR #126**) — НЕ оставлен dirty-tree. Также убрана KV-запись в `artist_profiles.data` (L162, mandate) + showStatus переписан на native (через weekly_releases). `friday.js status` проверен — работает.
- **Позиционный порядок новинок** (PR #126): `/landing-data/new-releases` и `/weekly-releases/*` теперь `ORDER BY array_position(track_ids, id)` вместо created_at / likes_count.
- **Гуськова `e77b1053` — радио**: 4 строки в `track_radio_pickups` (radio_station_id=`9583aacd` Soul FM, города Benidorm/Calpe/Altea/Alicante) → карточка показывает «1 радио, 4 города». is_paid=true.
- **Soul FM radio_profile `9583aacd`**: `broadcast_cities` = {Benidorm, Calpe, Altea, Alicante} (убраны Denia, Valencia), city=Benidorm.

**Состояние:** #22 опубликован, виден на главной (проверено: API + cover HTTP 200 + audio 206). PR #126 ждёт merge (прод уже применён laptop-ом).
**TODO:** авто-правило «оплаченные при пятничном обновлении опускаются на 2 позиции, не в низ» в friday.js — НЕ реализовано (в этот раз Гуськова поставлена в середину вручную). Позиционный фундамент готов.

---

## 2026-05-27 — wipe 69 orphan messages в producer_messages (Wave 1.5)

- **What:** migration 042 wipe'ает 15 строк × 69 сообщений в
  `producer_messages.data` jsonb. Это «zombie данные» от старого
  partial refactor: native колонки (sender_id, recipient_id, subject,
  content, is_read) добавили, но массивы из `data` jsonb не
  expand'нули в строки, и app-код всё это время был broken
  (`jsonbStore.set` ссылался на user_id колонку, которой не было
  после rename).
- **Affected:** `producer_messages` таблица. 15 row's data (по ~4-5
  messages в jsonb-массиве каждая) удалены через TRUNCATE.
- **Why:** Орфаны — нечем привязать к conversation. Legacy pk был
  `user_id` с `conversationId` значением; после rename в `id uuid`
  это mapping потеряно. Также 0 строк в `producer_convs` — нет
  conversation'ов куда attach. App-код producer cabinet messaging
  всё это время writes silent-fail'или.
- **How:** `TRUNCATE producer_messages` в миграции 042 v2 (см.
  файл `src/migrations/042_kv_wave1_5_producer_messaging.sql`).
- **Verified:** Backup создан laptop'ом перед apply:
  `/root/wave15-backup-20260527-181500.sql` (18.5 KB).
- **Follow-ups:**
  - Producer cabinet messaging получит чистый рестарт после деплоя.
    Старая семантика «direct user-to-user через sender_id/recipient_id»
    дропнута — теперь conversation-grouped (producer_convs links).
  - Если кто-то заметит «исчезли тестовые сообщения» — это они,
    восстановление возможно через backup.

---

## 2026-05-27 — миграция 039 (producer_custom_* row-per-item) случайно применилась к проду в dry-run

- **What:** Laptop запустил `BEGIN; \i 039_kv_to_sql_producer_custom.sql; ROLLBACK;`
  ожидая dry-run, но файл содержал `BEGIN; …; COMMIT;` внутри. Inner
  `COMMIT;` закрыл outer transaction до момента ROLLBACK → миграция
  фактически применилась к prod БД (TRUNCATE producer_custom_services
  + producer_custom_portfolio + reshape schema + recreate RLS policies).
- **Affected:** таблицы `producer_custom_services` и `producer_custom_portfolio`.
  Объём данных был тривиален (несколько строк, мигрированы через
  jsonb_array_elements backfill). RLS policies producer_sel/ins/upd/del
  пересозданы на producer_id колонке.
- **Why:** old migration convention (BEGIN/COMMIT inside file) ломает
  dry-run pattern. Laptop не имел способа откатить применённое.
- **How:**
  1. Сразу мерж `claude/kv-to-sql-producer-custom` → main (commit 22fc952)
     чтобы вернуть синхронность кода (`producer-studio-routes.tsx` уже
     ожидал новые колонки `producer_id`/`base_price`/etc).
  2. `git pull && sudo systemctl restart promofm-api` на VPS.
  3. Health check 200 OK.
  4. Diff чистый — ветка была rebased поверх свежих коммитов
     (Apple RSS albums × 4, X-Internal-Key × 4, authUserId × 8 регрессии
     не вернулись).
- **Verified:** health=200, dj cabinet работает, producer cabinet работает.
- **Follow-ups:**
  - Migration files 036/037/038/040 переработаны: убран inner BEGIN/COMMIT,
    runner оборачивает (PR #51, #52, #53, #55). Apply через heredoc:
    `BEGIN; \i file; COMMIT;`, dry-run через `BEGIN; \i file; ROLLBACK;`.
  - CLAUDE.md обновлён — секция «Migration files: NO BEGIN/COMMIT inside»
    закрепляет конвенцию для будущих сессий.
  - Все будущие миграции (041+) должны следовать тому же паттерну
    (DDL only inside file, runner controls transaction).

---

## 2026-05-25 — TODO: Гуськова Надежда — ручная починка кабинета артиста

> **PLACEHOLDER** — please fill in. The user reported spending
> significant time fixing this account on this date. Without the
> details captured here, every future Claude session will get
> confused by the resulting prod state and propose conflicting fixes.
>
> Suggested fields to fill:
>
> - **Affected user_id:** `d2b0d83f-ca73-4f58-bd4b-26dde68e0d18`
>   (observed in production 5xx logs across /publish/notifications/,
>   /sse/stream/, /artist-profile/profile/:id/stats)
> - **What was broken before the fix:**
> - **What was changed (SQL / admin action / etc.):**
> - **Current expected state:**
> - **Related code refs:**
>   - `track-moderation-routes.tsx:324` (e77b1053 payment_amount incident)
>   - `checkout-routes.tsx:412` (stale-snapshot writes incident)
>   - `artist-profile-routes.tsx:32` (Latin-translit name fallback)

---

## How to use this file (for future Claude sessions)

1. **Read this file early** in any new session that touches user
   accounts, subscriptions, payments, or moderation flows.
2. **Cross-reference user_id / track_id** mentions here against any
   prod-error logs the user shares.
3. **When the user describes a "weird" past fix** — check if it's
   logged here. If not, ask them to describe it and append a new
   entry before proposing any new SQL/code change.
4. **When YOU run SQL or take admin actions** during a session,
   propose appending to this log as part of the same PR.
