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
