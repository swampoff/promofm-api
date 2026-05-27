-- 036_kv_to_sql_agent_queue_dj_events_venue_playlists.sql
--
-- KV→SQL migration для трёх таблиц. Часть progress tracker'а
-- "Переезд KV-store на реальные SQL" (см. docs/kv-to-sql-migration.md).
--
-- BEFORE: jsonbStore-паттерн — одна строка на entity (dj_id / venue_id /
-- 'singleton') с jsonb-массивом сущностей внутри. Тихие upsert-фейлы,
-- невозможные индексы по полям внутри массива, owner-check через
-- in-memory filter после полной загрузки массива.
--
-- AFTER: row-per-entity — каждый event/playlist/task = отдельная строка
-- с нативными колонками + uuid PK + индексы на entity_id/status/date.
-- jsonb остаётся только для legit nested data (extra, content_items).
--
-- Атомарно в одной транзакции. Backfill из jsonb-массивов в строки
-- через jsonb_array_elements. Объём данных на проде на момент
-- миграции:
--   agent_queue:      1 строка ('singleton')
--   dj_events:        1 строка (DJ Den 1dbc0c77, 0-1 events)
--   venue_playlists:  0 строк
--
-- ПРЕД-ПРОВЕРКА на laptop ДО применения:
--   \d agent_queue
--   \d dj_events
--   \d venue_playlists
-- Затем dry-run:
--   BEGIN; \i 036_kv_to_sql_agent_queue_dj_events_venue_playlists.sql; ROLLBACK;
-- Если ошибок нет — применять с COMMIT.
--
-- MANUAL DEPLOY STEPS:
--   1. (laptop) pg_dump -t agent_queue -t dj_events -t venue_playlists \
--        promofm > /tmp/kv_backup_$(date +%s).sql
--   2. (laptop) sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/036_kv_to_sql_agent_queue_dj_events_venue_playlists.sql
--      COMMIT;
--      EOF
--   3. (laptop) cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api
--
-- Откат: восстановить из дампа шага 1.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT — wrapping
-- управляется внешним runner'ом (см. MANUAL DEPLOY STEPS выше).
-- Inner BEGIN в DO $$ ... END $$ — это PL/pgSQL block, не transaction.

-- ════════════════════════════════════════════════════════════════════
-- 1. agent_queue → agent_tasks (новая таблица, старую DROP'аем)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_tasks (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        TEXT         UNIQUE,
  task          TEXT         NOT NULL,
  priority      TEXT         NOT NULL DEFAULT 'normal',
  status        TEXT         NOT NULL DEFAULT 'pending',
  session_id    TEXT,
  added_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status   ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_added_at ON agent_tasks(added_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='agent_queue') THEN
    INSERT INTO agent_tasks (app_id, task, priority, status, session_id, added_at, completed_at)
    SELECT
      elem->>'id',
      COALESCE(NULLIF(elem->>'task', ''), '(пустая задача)'),
      COALESCE(elem->>'priority', 'normal'),
      COALESCE(elem->>'status', 'pending'),
      elem->>'sessionId',
      COALESCE(NULLIF(elem->>'addedAt','')::timestamptz, NOW()),
      NULLIF(elem->>'completedAt','')::timestamptz
    FROM agent_queue, LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(data) = 'array' THEN data ELSE '[]'::jsonb END
    ) elem
    ON CONFLICT (app_id) DO NOTHING;
  END IF;
END $$;

DROP TABLE IF EXISTS agent_queue;

-- ════════════════════════════════════════════════════════════════════
-- 2. dj_events → row-per-event (in-place reshape)
-- ════════════════════════════════════════════════════════════════════

-- Snapshot перед TRUNCATE — TEMP так что виден только в транзакции.
CREATE TEMP TABLE _dje_backup ON COMMIT DROP AS
SELECT * FROM dj_events;

-- Снять все возможные легаси-констрейнты (PK на dj_id, UNIQUE на dj_id
-- от laptop'овской 035, и т.п.) — IF EXISTS, чтоб независимо от точного
-- имени констрейнта на проде. Если имя другое — laptop поймает в
-- pre-flight rollback.
ALTER TABLE dj_events DROP CONSTRAINT IF EXISTS dj_events_pkey;
ALTER TABLE dj_events DROP CONSTRAINT IF EXISTS dj_events_dj_id_key;
ALTER TABLE dj_events DROP CONSTRAINT IF EXISTS dj_events_dj_id_unique;
ALTER TABLE dj_events DROP CONSTRAINT IF EXISTS uq_dj_events_dj_id;
-- Защита от повторного запуска: если предыдущий запуск миграции
-- уже добавил эти composite constraint — снять их перед новым ADD.
ALTER TABLE dj_events DROP CONSTRAINT IF EXISTS dj_events_app_id_unique;
ALTER TABLE dj_events DROP CONSTRAINT IF EXISTS dj_events_dj_app_unique;

TRUNCATE dj_events;

-- Новые колонки (ADD ... IF NOT EXISTS — на случай если laptop'овская
-- 034 что-то уже добавила).
ALTER TABLE dj_events
  ADD COLUMN IF NOT EXISTS id            UUID,
  ADD COLUMN IF NOT EXISTS app_id        TEXT,
  ADD COLUMN IF NOT EXISTS title         TEXT,
  ADD COLUMN IF NOT EXISTS venue         TEXT,
  ADD COLUMN IF NOT EXISTS city          TEXT,
  ADD COLUMN IF NOT EXISTS event_date    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fee           INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capacity      INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status        TEXT         NOT NULL DEFAULT 'upcoming',
  ADD COLUMN IF NOT EXISTS event_type    TEXT         NOT NULL DEFAULT 'club',
  ADD COLUMN IF NOT EXISTS notes         TEXT,
  ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extra         JSONB        NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE dj_events ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE dj_events ALTER COLUMN id SET NOT NULL;
ALTER TABLE dj_events ADD PRIMARY KEY (id);
-- Композитный UNIQUE: legacy app_id ('ev1', 'ev2', ...) генерился per-DJ,
-- не глобально. То же значение может встречаться у разных djId. Per-laptop
-- pre-flight на venue_playlists подтвердило паттерн.
ALTER TABLE dj_events
  ADD CONSTRAINT dj_events_dj_app_unique UNIQUE (dj_id, app_id);

CREATE INDEX IF NOT EXISTS idx_dj_events_dj_id      ON dj_events(dj_id);
CREATE INDEX IF NOT EXISTS idx_dj_events_status     ON dj_events(status);
CREATE INDEX IF NOT EXISTS idx_dj_events_event_date ON dj_events(event_date);

-- Backfill: jsonb-массив → строки. extra ловит всё что не промоутили
-- в нативные колонки (любые экзотические поля сохранятся).
INSERT INTO dj_events (
  id, app_id, dj_id, title, venue, city, event_date,
  fee, capacity, status, event_type, notes,
  completed_at, cancelled_at, extra, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  b.dj_id,
  COALESCE(NULLIF(elem->>'title',''), '(без названия)'),
  elem->>'venue',
  elem->>'city',
  NULLIF(elem->>'date', '')::timestamptz,
  COALESCE(NULLIF(elem->>'fee','')::integer, 0),
  COALESCE(NULLIF(elem->>'capacity','')::integer, 0),
  COALESCE(NULLIF(elem->>'status',''), 'upcoming'),
  COALESCE(NULLIF(elem->>'type',''), 'club'),
  NULLIF(elem->>'notes',''),
  NULLIF(elem->>'completedAt', '')::timestamptz,
  NULLIF(elem->>'cancelledAt', '')::timestamptz,
  COALESCE(elem - ARRAY[
    'id','title','venue','city','date','fee','capacity',
    'status','type','notes','completedAt','cancelledAt',
    'djId','createdAt','updatedAt'
  ], '{}'::jsonb),
  COALESCE(NULLIF(elem->>'createdAt', '')::timestamptz, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt', '')::timestamptz, NOW())
FROM _dje_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data) = 'array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

-- Legacy data jsonb колонка больше не нужна — её содержимое теперь в
-- нативных колонках + extra.
ALTER TABLE dj_events DROP COLUMN IF EXISTS data;

-- Zombie native columns (которые laptop'овская 034 добавила в попытке
-- неполного refactor — title TEXT, venue TEXT, event_date TIMESTAMPTZ
-- и т.п., но никогда не записывались). Они теперь живые — backfill их
-- наполнил. Если у них были другие имена (event_type vs type) — оставлю
-- мою канонику; старые удалю если случайно остались как дубликаты:
ALTER TABLE dj_events DROP COLUMN IF EXISTS type;

-- ════════════════════════════════════════════════════════════════════
-- 3. venue_playlists → row-per-playlist (in-place reshape)
-- ════════════════════════════════════════════════════════════════════

CREATE TEMP TABLE _vp_backup ON COMMIT DROP AS
SELECT * FROM venue_playlists;

ALTER TABLE venue_playlists DROP CONSTRAINT IF EXISTS venue_playlists_pkey;
ALTER TABLE venue_playlists DROP CONSTRAINT IF EXISTS venue_playlists_venue_id_key;
-- Защита от повторного запуска:
ALTER TABLE venue_playlists DROP CONSTRAINT IF EXISTS venue_playlists_app_id_unique;
ALTER TABLE venue_playlists DROP CONSTRAINT IF EXISTS venue_playlists_venue_app_unique;

TRUNCATE venue_playlists;

ALTER TABLE venue_playlists
  ADD COLUMN IF NOT EXISTS id              UUID,
  ADD COLUMN IF NOT EXISTS app_id          TEXT,
  ADD COLUMN IF NOT EXISTS owner_id        TEXT,
  ADD COLUMN IF NOT EXISTS title           TEXT         NOT NULL DEFAULT '(без названия)',
  ADD COLUMN IF NOT EXISTS description     TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS content_items   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS track_count     INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_duration  INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_public       BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS status          TEXT         NOT NULL DEFAULT 'draft';

ALTER TABLE venue_playlists ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE venue_playlists ALTER COLUMN id SET NOT NULL;
ALTER TABLE venue_playlists ADD PRIMARY KEY (id);
-- Композитный UNIQUE: laptop'овский dry-run показал что в существующих
-- 4 строках venue_playlists есть playlists с одинаковым app_id='pl1'
-- в разных venues (per-venue numbering, не глобальный). Global UNIQUE
-- (app_id) падал бы. (venue_id, app_id) сохраняет legacy ids без коллизий.
ALTER TABLE venue_playlists
  ADD CONSTRAINT venue_playlists_venue_app_unique UNIQUE (venue_id, app_id);

CREATE INDEX IF NOT EXISTS idx_venue_playlists_venue_id ON venue_playlists(venue_id);
CREATE INDEX IF NOT EXISTS idx_venue_playlists_status   ON venue_playlists(status);

INSERT INTO venue_playlists (
  id, app_id, venue_id, owner_id, title, description, cover_image_url,
  content_items, track_count, total_duration, is_public, status,
  created_at, updated_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  b.venue_id,
  elem->>'ownerId',
  COALESCE(NULLIF(elem->>'title',''), '(без названия)'),
  NULLIF(elem->>'description',''),
  NULLIF(elem->>'coverImageUrl',''),
  COALESCE(elem->'contentItems', '[]'::jsonb),
  COALESCE(NULLIF(elem->>'trackCount','')::integer, 0),
  COALESCE(NULLIF(elem->>'totalDuration','')::integer, 0),
  COALESCE(NULLIF(elem->>'isPublic','')::boolean, TRUE),
  COALESCE(NULLIF(elem->>'status',''), 'draft'),
  COALESCE(NULLIF(elem->>'createdAt', '')::timestamptz, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt', '')::timestamptz, NOW())
FROM _vp_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data) = 'array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE venue_playlists DROP COLUMN IF EXISTS data;
