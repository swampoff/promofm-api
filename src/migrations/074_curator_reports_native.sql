-- Migration 074 — curator_reports: kill data jsonb, kill "latest:" duplicates,
-- promote to native cols.
--
-- Context:
--   curator_reports — отчёты автоматических аудит-агентов кураторов
--   (запускаются POST /curator/run, проверяют endpoints per-role).
--   Legacy storage был abused — table использовалась для DVUH целей:
--     1. Historical reports (id = 'curator-<role>-<timestamp>')
--     2. Latest-per-role pointer (id = 'latest:<role>') — duplicate
--        copy of самого свежего report для O(1) read.
--
--   Каждый run делал DUAL WRITE:
--     curatorReportsStore.set(report.id, report)
--     curatorReportsStore.set(`latest:${role}`, report)  ← race-prone
--
--   Native design убирает duplicate: "latest per role" computes через
--   SELECT ... ORDER BY completed_at DESC LIMIT 1 на indexed col.
--   Single INSERT per run, никаких race на pointer.
--
-- Shape:
--   id              TEXT      -- 'curator-<role>-<ts>'
--   role            TEXT      -- one of CURATOR_ROLES
--   role_name       TEXT
--   started_at      TIMESTAMPTZ
--   completed_at    TIMESTAMPTZ
--   total_endpoints INTEGER
--   passed/failed/warnings INTEGER
--   setup_done      BOOLEAN
--   summary         TEXT       -- human-readable text dump
--   results         JSONB      -- array of CuratorReportResult — LEGIT
--                                 nested polymorphic data (per-endpoint
--                                 result shape varies); keep as jsonb
--                                 per CLAUDE.md "legit nested data" OK.
--
-- Companion code: db.tsx (3 typed funcs + interface + mapRow),
-- curator-agents.tsx (kill dual-write), curator-routes.tsx (3 callers).
--
-- Idempotent.

-- ── 1. Native cols
ALTER TABLE curator_reports
  ADD COLUMN IF NOT EXISTS role            TEXT,
  ADD COLUMN IF NOT EXISTS role_name       TEXT,
  ADD COLUMN IF NOT EXISTS started_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_endpoints INTEGER,
  ADD COLUMN IF NOT EXISTS passed          INTEGER,
  ADD COLUMN IF NOT EXISTS failed          INTEGER,
  ADD COLUMN IF NOT EXISTS warnings        INTEGER,
  ADD COLUMN IF NOT EXISTS setup_done      BOOLEAN,
  ADD COLUMN IF NOT EXISTS summary         TEXT,
  ADD COLUMN IF NOT EXISTS results         JSONB;

-- ── 2. Backfill historical rows из data jsonb.
--    Skip 'latest:*' rows — они будут DROPPED шагом 3, дублируют
--    самый свежий historical report per role.
UPDATE curator_reports SET
  role            = COALESCE(role,            data->>'role'),
  role_name       = COALESCE(role_name,       data->>'roleName'),
  started_at      = COALESCE(started_at,      NULLIF(data->>'startedAt','')::timestamptz),
  completed_at    = COALESCE(completed_at,    NULLIF(data->>'completedAt','')::timestamptz),
  total_endpoints = COALESCE(total_endpoints, NULLIF(data->>'totalEndpoints','')::int),
  passed          = COALESCE(passed,          NULLIF(data->>'passed','')::int),
  failed          = COALESCE(failed,          NULLIF(data->>'failed','')::int),
  warnings        = COALESCE(warnings,        NULLIF(data->>'warnings','')::int),
  setup_done      = COALESCE(setup_done,      NULLIF(data->>'setupDone','')::boolean),
  summary         = COALESCE(summary,         data->>'summary'),
  results         = COALESCE(results,         data->'results')
WHERE data IS NOT NULL
  AND id NOT LIKE 'latest:%';

-- ── 3. DELETE 'latest:*' pointer rows. После migration "latest per role"
--    вычисляется через SELECT ... ORDER BY completed_at DESC LIMIT 1
--    (см. getLatestCuratorReport в db.tsx).
DELETE FROM curator_reports WHERE id LIKE 'latest:%';

-- ── 4. Cleanup orphan rows (no role / completed_at — невалидные)
DELETE FROM curator_reports WHERE role IS NULL OR completed_at IS NULL;

-- ── 5. Tighten constraints + defaults
ALTER TABLE curator_reports
  ALTER COLUMN role            SET NOT NULL,
  ALTER COLUMN role_name       SET NOT NULL,
  ALTER COLUMN completed_at    SET NOT NULL,
  ALTER COLUMN total_endpoints SET DEFAULT 0,
  ALTER COLUMN passed          SET DEFAULT 0,
  ALTER COLUMN failed          SET DEFAULT 0,
  ALTER COLUMN warnings        SET DEFAULT 0,
  ALTER COLUMN setup_done      SET DEFAULT FALSE,
  ALTER COLUMN summary         SET DEFAULT '',
  ALTER COLUMN results         SET DEFAULT '[]'::jsonb;

UPDATE curator_reports SET
  total_endpoints = COALESCE(total_endpoints, 0),
  passed          = COALESCE(passed,          0),
  failed          = COALESCE(failed,          0),
  warnings        = COALESCE(warnings,        0),
  setup_done      = COALESCE(setup_done,      FALSE),
  summary         = COALESCE(summary,         ''),
  results         = COALESCE(results,         '[]'::jsonb),
  started_at      = COALESCE(started_at,      completed_at);

ALTER TABLE curator_reports
  ALTER COLUMN total_endpoints SET NOT NULL,
  ALTER COLUMN passed          SET NOT NULL,
  ALTER COLUMN failed          SET NOT NULL,
  ALTER COLUMN warnings        SET NOT NULL,
  ALTER COLUMN setup_done      SET NOT NULL,
  ALTER COLUMN summary         SET NOT NULL,
  ALTER COLUMN results         SET NOT NULL,
  ALTER COLUMN started_at      SET NOT NULL;

-- ── 6. DROP COLUMN data
ALTER TABLE curator_reports DROP COLUMN IF EXISTS data;

-- ── 7. Hot-path index — "latest report per role" + history sorting.
CREATE INDEX IF NOT EXISTS idx_curator_reports_role_recent
  ON curator_reports(role, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_curator_reports_completed_recent
  ON curator_reports(completed_at DESC);
