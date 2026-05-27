-- 034_dj_events_venue_playlists.sql
--
-- KV-style таблицы для двух jsonbStore'ов из src/db.tsx, у которых
-- не было явных миграций (созданы вручную в KV-эру, на проде могут
-- отсутствовать или иметь не те колонки).
--
-- Симптомы без миграции (наблюдалось в System Test):
--   • POST /api/dj-studio/events возвращает 201, но GET .../:id → 404
--     (djEventsStore.set падает silently, console.error без throw)
--   • POST /api/venue/playlists → 500 (venuePlaylists.set / .get
--     обращается к несуществующей таблице)
--
-- Колоночный контракт jsonbStore (см. src/db.tsx:1449-1481):
--   • <pk>  — TEXT/UUID primary key (имя задаётся в конструкторе)
--   • data  — JSONB полезная нагрузка
--   • created_at, updated_at — timestamps (getAll читает .order('created_at'))
--
-- Соответствие в коде:
--   djEventsStore   = jsonbStore('dj_events', 'dj_id')
--   venuePlaylists  = jsonbStore('venue_playlists', 'venue_id')
--
-- Колонки, читаемые SQL: dj_id (TEXT — приходит как userId TEXT из JWT),
-- venue_id (TEXT — приходит как profile.id TEXT), data, created_at, updated_at.
--
-- Идемпотентно: CREATE TABLE IF NOT EXISTS, ALTER ... ADD COLUMN IF NOT EXISTS.
-- Если таблица уже существует на проде с другими колонками — laptop
-- должен сначала прогнать BEGIN; <ниже>; ROLLBACK; и проверить \d.
--
-- MANUAL DEPLOY STEPS:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/034_dj_events_venue_playlists.sql
--   (применить ДО `systemctl restart promofm-api`)

BEGIN;

CREATE TABLE IF NOT EXISTS dj_events (
  dj_id       TEXT         PRIMARY KEY,
  data        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE dj_events
  ADD COLUMN IF NOT EXISTS data       JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS venue_playlists (
  venue_id    TEXT         PRIMARY KEY,
  data        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE venue_playlists
  ADD COLUMN IF NOT EXISTS data       JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

COMMIT;
