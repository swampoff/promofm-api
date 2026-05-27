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

### ✅ Готово (мигрированы)

| Таблица | Миграция | PR | Notes |
|---|---|---|---|
| `publish_orders` | 013 | — | row-per-order, native cols |
| `subscriptions` | (исторически) | — | row-per-subscription |
| `agent_queue` → `agent_tasks` | 036 | #51 | row-per-task, jsonbStore-декларация удалена |
| `dj_events` | 036 | #51 | row-per-event |
| `venue_playlists` | 036 | #51 | row-per-playlist, `content_items` остаётся jsonb (legit nested) |

### ⏳ Wave 1 — критичные деньги/комм (в работе)

| Таблица | Риск | Приоритет |
|---|---|---|
| `payment_transactions` | 💰 деньги в чистом kv — track-test handler пишет через `set(user_id, oneTx)` (а не array), что **перетирает все предыдущие транзакции пользователя** | 1 |
| `collab_messages` | 💬 race condition: 2 одновременных сообщения → 1 потеряно (get-modify-set) | 1 |
| `publish_chats` | 💬 то же | 1 |
| `dj_calendar` | 🧟 orphan — declaration есть, callers нет. Удалить декларацию + DROP TABLE если 0 rows | 1 |
| `producer_custom_portfolio` | 📁 публичный портфель продюсера | 1 |
| `producer_custom_services` | 📁 публичные услуги продюсера | 1 |

### 🔜 Wave 2 — analytics/aggregation

`artist_analytics_cache`, `artist_tracks_stats`, `chart_aggregation`, `radio_analytics`, `venue_analytics` — perf-критично, нужны индексы.

### 🔜 Wave 3 — гибриды (тривиальный refactor)

Таблицы где native колонки уже всё закрывают, но `data jsonb` дублирует — просто удалить:
`dj_collaborations`, `dj_bookings`, `dj_reviews`, `dj_mixes`, `dj_subscriptions`, `dj_notifications`, `notification_campaigns`, `pitching_requests`, `radio_ad_slots`, `track_analytics`, `user_subscriptions`, `track_moderation`, `track_test_requests`, `donations`, `support_tickets`, `bookings`, `payment_withdrawals`, `marketing_campaigns`.

### 🔜 Wave 4 — settings/configs (можно отложить)

Read-mostly singleton'ы где kv-store валиден:
`system_config`, `accounting_data`, `elevenlabs_config`, `email_templates`, `email_history`, `notification_settings`, `producer_settings`, `producer_ai_last`.

### 🚫 Правило для cloud-сессий

**НЕ СОЗДАВАТЬ** новые KV-таблицы с паттерном `entity_id PK + data JSONB`. См. `CLAUDE.md` → секция «⛔ FORBIDDEN: создавать новые KV-store таблицы».

## Шаблон миграции

Канон — `src/migrations/036_kv_to_sql_agent_queue_dj_events_venue_playlists.sql`:

1. `CREATE TEMP TABLE _backup ON COMMIT DROP AS SELECT * FROM <legacy>`
2. `ALTER TABLE <legacy> DROP CONSTRAINT IF EXISTS …` (все PK/UNIQUE на entity_id)
3. `TRUNCATE <legacy>`
4. `ALTER TABLE <legacy> ADD COLUMN IF NOT EXISTS id UUID, app_id TEXT, <native cols>, extra JSONB`
5. `ALTER TABLE <legacy> ADD PRIMARY KEY (id)` + `CREATE INDEX … ON <legacy>(entity_id)`
6. `INSERT INTO <legacy> (…) SELECT … FROM _backup, LATERAL jsonb_array_elements(b.data) elem`
7. `ALTER TABLE <legacy> DROP COLUMN IF EXISTS data`

Атомарно в одной транзакции. Backfill — через `jsonb_array_elements`.
`extra jsonb` ловит любые поля которые не промоутили в нативные колонки.

## Шаблон handler'а

После миграции:
- Удалить `jsonbStore('<table>', ...)` декларацию из `src/db.tsx`
- Заменить все `store.get(id)` / `store.set(id, arr)` на `pool.query(...)`
- Добавить `mapXxxRow(row)` хелпер для конвертации snake_case → camelCase API
- Owner-check через WHERE: `WHERE app_id = $1 AND <owner_col> = $2`

Канон — `src/dj-studio-routes.tsx::fetchDjEvents` + CRUD-эндпойнты `/events*`.
