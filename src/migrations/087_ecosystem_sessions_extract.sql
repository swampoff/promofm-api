-- Migration 087 — ecosystem_sessions: extract из agent_sessions.
--
-- Context:
--   ecosystem-routes.tsx использовал agent_sessions table с id LIKE 'eco_%'
--   prefix как generic session store (mode, status, startedAt etc shape).
--   Реально agent_sessions предназначено для AI dept discussions ('s-*'
--   prefix, title/task/messages shape).
--
--   Migration 081 (agent_sessions promote к native cols + DROP data) ломает
--   ecosystem flow: backfill SELECT data->>'title' / data->>'task' возвращает
--   NULL для eco_* rows; затем DELETE WHERE title IS NULL уничтожает данные
--   ecosystem.
--
-- Это migration отделяет ecosystem flow в собственную таблицу. После apply
-- migration 081 можно безопасно прогонять (только 's-*' rows остаются).
--
-- ⚠️ ORDER OF APPLICATION:
--   1. Apply this migration (087) FIRST.
--   2. Then apply migration 081 (agent_sessions native cols).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS ecosystem_sessions (
  id          TEXT PRIMARY KEY,
  mode        TEXT,
  type        TEXT,
  status      TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill: move eco_* rows из agent_sessions (legacy storage).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'agent_sessions' AND column_name = 'data'
  ) THEN
    INSERT INTO ecosystem_sessions (id, mode, type, status, data, created_at, updated_at)
    SELECT
      id,
      data->>'mode',
      data->>'type',
      data->>'status',
      data,
      created_at,
      updated_at
    FROM agent_sessions
    WHERE id LIKE 'eco_%'
      AND data IS NOT NULL
    ON CONFLICT (id) DO NOTHING;

    -- Удалить eco_ rows из agent_sessions чтобы migration 081 не падал
    -- на NOT NULL (title/task) constraint.
    DELETE FROM agent_sessions WHERE id LIKE 'eco_%';
  END IF;
END $$;

-- Indexes для filter'ов (mode, type) + listing.
CREATE INDEX IF NOT EXISTS idx_ecosystem_sessions_mode_created
  ON ecosystem_sessions(mode, created_at DESC) WHERE mode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ecosystem_sessions_type
  ON ecosystem_sessions(type) WHERE type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ecosystem_sessions_created
  ON ecosystem_sessions(created_at DESC);
