-- 033_agent_queue.sql
--
-- Создаёт таблицу `agent_queue` для очереди задач AI-агентов.
-- Используется через `jsonbStore('agent_queue')` в src/db.tsx:1550
-- — все запись/чтение идут через колонки (id, data, updated_at).
-- В System Test ловили 500 «Internal server error» на POST/DELETE
-- /api/agents/queue потому что таблицы не было.
--
-- Hot-path запросы (см. src/agents-routes.tsx:245-340):
--   SELECT * FROM agent_queue WHERE id = 'singleton'   ← maybeSingle()
--   UPSERT (id='singleton', data=<jsonb массив>, updated_at=now())
--
-- pk = TEXT потому что вызывающий код шлёт фиксированный ключ
-- 'singleton' (один общий список задач, не per-user).
--
-- MANUAL DEPLOY STEPS:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/033_agent_queue.sql

BEGIN;

CREATE TABLE IF NOT EXISTS agent_queue (
  id          TEXT         PRIMARY KEY,
  data        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMIT;
