# KV-store → SQL migration tracker

Активный мандат: переезд легаси `jsonbStore`-паттерна (1 строка на entity,
массив сущностей внутри `data jsonb`) на нормальную реляционную схему
(row-per-entity, native колонки, индексы по полям).

**Почему:**
- Тихие upsert-фейлы при отсутствии констрейнтов (см. dj_events инцидент 2026-05 — POST 201, GET 404)
- IDOR-уязвимости — нельзя check'ать ownership по индексу, только full-scan jsonb
- Race conditions: 2 одновременных write'а через `get-modify-set` → 1 потерян (особенно для chat/message таблиц)
- Невозможно нормально индексировать поля внутри массива
- Невозможна транзакционная гарантия для записи

## Inventory (от laptop, 2026-05-27)

- **80** `jsonbStore()` деклараций в `src/db.tsx`
- **129** таблиц с jsonb колонкой `data` в БД
- **47** чистых kv-store (только 4 колонки: pk + data + timestamps)

## Прогресс

### ✅ Wave 1 — DONE (на проде row-per-entity)

| Таблица | Composite UNIQUE | Code refactor PR | Notes |
|---|---|---|---|
| `publish_orders` | — | (исторически) | row-per-order |
| `subscriptions` | — | (исторически) | row-per-subscription |
| `agent_queue` → `agent_tasks` | `(app_id)` | #51 | row-per-task, новая таблица |
| `dj_events` | `(dj_id, app_id)` | #51 | row-per-event, native cols |
| `venue_playlists` | `(venue_id, app_id)` | #51 | row-per-playlist, content_items остаётся jsonb (legit nested) |
| `payment_transactions` | `(user_id, app_id)` | #52 | row-per-tx, 4 RLS policies (pt_admin_all/insert/select_own/update_own) |
| `collab_messages` | `(offer_id, app_id)` | #53 | row-per-message |
| `publish_chats` | `(order_id, app_id)` | #53 | row-per-message, partial index на is_read=FALSE |
| `producer_custom_services` | `(producer_id, app_id)` | #54 (merged) | row-per-service |
| `producer_custom_portfolio` | `(producer_id, app_id)` | #54 (merged) | row-per-entry |
| `dj_calendar` | — | #55 | DROP TABLE (orphan, 0 callers) |
| `producer_convs` | `(producer_id, app_id)` | Wave 1.5 (042) | row-per-conversation, unread updates через UPDATE column |
| `producer_messages` | `(conversation_id, app_id)` | Wave 1.5 (042) | row-per-message, legacy pk='user_id' переименован в conversation_id (был misnamed) |
| `producer_sessions` | `(producer_id, app_id)` | Wave 1.5 (042) | row-per-calendar-session, session_date DATE (был TEXT YYYY-MM-DD) |

**Инцидент 2026-05-27:** все эти таблицы оказались уже в target state на проде
к моменту code-refactor merge'a (миграции применились через путь вне cloud-сессии).
Migration SQL файлы (036, 037, 038, 040) удалены из PR'ов — оставлены только
code refactor (`pool.query` per-row INSERT/SELECT/UPDATE/DELETE) + удаление
stale `jsonbStore` declarations из `src/db.tsx`. См. `docs/OPERATIONS_LOG.md`.

### ✅ Wave 2 — analytics (частично DONE, остаток валидные singleton-KV)

| Таблица | Pattern | Действие | Migration / PR |
|---|---|---|---|
| `artist_analytics_cache` | cache `v2:artistId:period` → объект | row-per-key + native `expires_at TTL` (5 мин). Handler фильтрует `expires_at > NOW()`. | 041 |
| `artist_tracks_stats` | declaration в db.tsx, 0 callers | DROP TABLE, declaration удалена | 041 |
| `chart_aggregation` | singleton `key='last'`, метаданные о последней aggregation | **Оставлен как есть** — валидный singleton, переписывать незачем | — |
| `radio_analytics` | per-station объект (+ `.getAll()` для radio-partners) | **Оставлен как есть** на этом waves. ⚠️ Дуальное назначение (analytics + station-registry для landing) — стоит распутать в Wave 3 (вынести registry в `radio_stations` или дать landing запрос к нему). | — |
| `venue_analytics` | per-venue объект, 4 `.get()` callers, 0 `.set()` в коде | **Оставлен как есть** — singleton cache, читается, пишется откуда-то ещё (cron?). Если будет cross-venue admin dashboard — добавить native cols. | — |

### ⏳ Wave 1.5 — array-stores пропущенные в Wave 1

| Таблица | Composite UNIQUE | PR | Risk closed |
|---|---|---|---|
| `producer_convs` | `(producer_id, app_id)` | #58 | race на conv create |
| `producer_messages` | `(conversation_id, app_id)` | #58 | race на message send + 69 orphan messages wipe |
| `producer_sessions` | `(producer_id, app_id)` | #58 | race на session create |
| `payment_withdrawals` | `(user_id, app_id)` | #59 | **💰 race на withdrawal create — деньги в воздухе.** Radio префикс `radio:${userId}` распакован в `source='radio'`. |

### 🔜 Wave 3 — гибриды (НЕ тривиальный, нужен per-table refactor)

Аудит 2026-05-27 показал что «гибрид» = native cols + active data jsonb writes
(сохраняют full object). Просто `DROP COLUMN data` ломает чтения. Реальный
объём работы похож на Wave 1.

**🔴 Hybrid с active data writes:**
- ✅ `dj_mixes` — PR #62 (migration 046)
- ✅ `bookings` — PR #63 (migration 047)
- ✅ `support_tickets` — PR #64 (migration 048)
- ✅ `notification_campaigns` + `marketing_campaigns` cleanup — PR #65 (migration 049)
- ✅ `radio_ad_slots` — PR #66 (migration 050) — also DROP `radio_ad_slot_index`
- ✅ `track_test_requests` — PR #67 (migration 051) — 24 native cols + 2 jsonb (assigned_experts, category_averages), 3 hot-path indexes. Also DROP `track_test_user_requests` + `track_test_all_requests` (redundant index tables, derived from main `user_id` col).
- `track_moderation` — отдельный PR

**Satellite stores оставлены на jsonbStore (фолловап PR'ы):**
- `track_test_reviews`, `track_test_request_reviews`, `track_test_experts`, `track_test_expert_stats` (cluster под фичей ExpertReview).

**🟢 Truly trivial Wave 3 (write-only data, ready for DROP):**
- `donations` — `createDonation` пишет только native cols, read `r.data \|\| r` works без data

**🤷 Возможные orphan'ы (нужна проверка):**
- `dj_bookings`, `pitching_requests`, `user_subscriptions`, `track_analytics` — нет active callers в grep, могут быть DROPpable

**Wave 1.5 leftovers (kv-array, не Wave 3):**
- `dj_reviews`, `dj_collaborations`, `dj_notifications`, `dj_subscriptions`, `dj_withdrawals` — array-stores из dj cabinet

### 🔜 Wave 4 — settings/configs (можно отложить)

Read-mostly singleton'ы где kv-store валиден (один объект на user/system, не массив):
`system_config`, `accounting_data`, `elevenlabs_config`, `email_templates`, `email_history`, `notification_settings`, `producer_settings`, `producer_ai_last`, `payment_balances`.

### 🚫 Правило для cloud-сессий

**НЕ СОЗДАВАТЬ** новые KV-таблицы с паттерном `entity_id PK + data JSONB`. См. `CLAUDE.md` → секция «⛔ FORBIDDEN: создавать новые KV-store таблицы».

## Шаблон для будущих миграций (Wave 2-3)

### Схема

```sql
-- Колонки:
--   id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
--   app_id      TEXT  -- legacy идентификатор от старого app-кода
--   <entity>_id TEXT INDEX  -- parent entity для группировки/owner-check
--   <native cols под основные поля>
--   extra       JSONB DEFAULT '{}'::jsonb  -- residual поля из старого jsonb
--   created_at  TIMESTAMPTZ DEFAULT NOW()
--   updated_at  TIMESTAMPTZ DEFAULT NOW()
--
-- UNIQUE: композитный (entity_id, app_id) — legacy app_id мог дублироваться
-- между entity'ями (per-entity counter в старом коде).
```

### Migration file — NO `BEGIN/COMMIT` inside

См. CLAUDE.md секцию «Migration files: NO BEGIN/COMMIT inside the file» —
runner оборачивает heredoc'ом. Файл содержит DDL only.

Apply:
```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
BEGIN;
\i /opt/promofm-api/src/migrations/NNN_xxx.sql
COMMIT;
EOF
```

Dry-run (заменить COMMIT на ROLLBACK).

### Шаги в SQL

1. `CREATE TEMP TABLE _backup ON COMMIT DROP AS SELECT * FROM <legacy>`
2. `DROP POLICY IF EXISTS …` (RLS policies зависят от колонок, снять до DROP COLUMN)
3. `ALTER TABLE <legacy> DROP CONSTRAINT IF EXISTS …` (все PK/UNIQUE на entity_id; +старые имена IF EXISTS для idempotency повторного запуска)
4. `TRUNCATE <legacy>`
5. `ALTER TABLE <legacy> ADD COLUMN IF NOT EXISTS id UUID, app_id TEXT, <native cols>, extra JSONB`
6. `ALTER TABLE <legacy> ADD PRIMARY KEY (id)` + `ADD CONSTRAINT … UNIQUE (entity_id, app_id)` + `CREATE INDEX … ON <legacy>(entity_id)`
7. `INSERT INTO <legacy> (…) SELECT … FROM _backup, LATERAL jsonb_array_elements(b.data) elem`
8. `ALTER TABLE <legacy> DROP COLUMN IF EXISTS data`
9. `CREATE POLICY …` для RLS на новой колонке (если на исходной были policies)

### Code

После миграции:
- Удалить `jsonbStore('<table>', ...)` декларацию из `src/db.tsx`
- Заменить все `store.get(id)` / `store.set(id, arr)` на `pool.query(...)`
- Добавить `mapXxxRow(row)` хелпер для конвертации snake_case → camelCase API
- Owner-check через WHERE: `WHERE app_id = $1 AND <owner_col> = $2`
- INSERT с `ON CONFLICT (<entity_id>, app_id) DO NOTHING` для idempotency

Канон — `src/dj-studio-routes.tsx::fetchDjEvents` + CRUD-эндпойнты `/events*`.

### Pre-flight (mandatory)

Перед apply на проде laptop делает dry-run + сравнивает counts (см. CLAUDE.md
секцию «Pre-flight»). Cloud НЕ имеет SSH — пишет SQL и список колонок в PR
description, laptop валидирует.
