# KV-store → SQL migration tracker

Активный мандат: переезд легаси `jsonbStore`-паттерна (1 строка на entity,
массив сущностей внутри `data jsonb`) на нормальную реляционную схему
(row-per-entity, native колонки, индексы по полям).

**Почему:**
- Тихие upsert-фейлы при отсутствии констрейнтов (см. dj_events
  инцидент 2026-05 — POST 201, GET 404)
- IDOR-уязвимости — нельзя check'ать ownership по индексу, только
  full-scan jsonb
- Невозможно нормально индексировать поля внутри массива
- Каждый write — read-modify-write всего массива → конкурентность ломается

## Прогресс

### ✅ Готово (мигрированы)

| Таблица | Миграция | Дата | Notes |
|---|---|---|---|
| `publish_orders` | 013_distribution_orders.sql | — | row-per-order, native cols |
| `subscriptions` | (исторически) | — | row-per-subscription |
| `agent_queue` → `agent_tasks` | **036** | 2026-05-27 | row-per-task, jsonbStore-декларация удалена |
| `dj_events` | **036** | 2026-05-27 | row-per-event, jsonbStore-декларация удалена. Backfill из jsonb-массива |
| `venue_playlists` | **036** | 2026-05-27 | row-per-playlist, jsonbStore-декларация удалена. `content_items` остаётся jsonb (legit nested) |

### ⏳ Ожидают миграции (jsonbStore declarations в `src/db.tsx`)

Полный список см. `grep -E "^export const.*jsonbStore" src/db.tsx`.
Кандидаты на приоритезацию — те, что хранят **массивы** (видно по
коду в handler'ах: `(await store.get(id)) || []; arr.push(...); store.set(id, arr)`).

Известные точно-массивные KV (приоритет высокий):
- `dj_calendar` — массив букингов
- `dj_collaborations` — массив коллабораций
- `dj_pitches` — массив питчей
- `dj_mixes` — частично уже мигрирован (миграции 005, 030, 031)
- `radio_artist_requests` — массив заявок
- `radio_venue_requests` — массив заявок
- `radio_ad_slots` — массив рекламных слотов
- `venue_ad_campaigns` — массив кампаний
- `dj_withdrawals` — массив запросов на вывод
- `dj_transactions` — массив транзакций
- `dj_notifications` — массив уведомлений
- `service_orders` — частично уже мигрирован

Single-value KV (низкий приоритет, можно оставлять как есть):
- `producer_settings`, `producer_ai_last`, `producer_messages` — один объект на user
- `email_history`, `email_templates`, `notification_settings` — settings-style
- `system_config` — singleton

### 🚫 Правило для cloud-сессий

**НЕ СОЗДАВАТЬ** новые KV-таблицы с паттерном `entity_id PK + data JSONB`.
Если handler'у нужна таблица, которой нет — мигрировать сразу на row-per-entity
схему. См. `CLAUDE.md` → секция «FORBIDDEN: создавать новые KV-store таблицы».

## Шаблон миграции

Канонический пример — `src/migrations/036_kv_to_sql_agent_queue_dj_events_venue_playlists.sql`:

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
