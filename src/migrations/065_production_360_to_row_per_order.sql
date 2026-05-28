-- 059_production_360_to_row_per_order.sql
--
-- Artist cluster, ч.2: production_360 — kill 3-table KV pattern.
--
-- Раньше:
--   production_360_orders     (id PK + data = весь order)
--   production_360_by_status  (status PK + data = array of order_ids)
--   production_360_by_artist  (artist_id PK + data = array of order_ids)
-- Каждое создание/удаление/смена статуса → write в 3 таблицы без транз.
-- updateStatusIndex() делал N+1 get-modify-set на массив order_ids.
--
-- Теперь: row-per-order `production_360_orders` с native cols + indexes.
-- 2 derived index таблицы DROP'нуты — list-by-status и list-by-artist
-- через native indexes.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t production_360_orders -t production_360_by_status \
--               -t production_360_by_artist promofm
--        > /tmp/p360_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/059_production_360_to_row_per_order.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Bootstrap legacy table if absent.
CREATE TABLE IF NOT EXISTS production_360_orders (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Promote 18 native cols + 6 jsonb (legit nested arrays/objects).
ALTER TABLE production_360_orders
  ADD COLUMN IF NOT EXISTS artist_id            TEXT,
  ADD COLUMN IF NOT EXISTS artist_name          TEXT,
  ADD COLUMN IF NOT EXISTS service_type         TEXT,
  ADD COLUMN IF NOT EXISTS project_title        TEXT,
  ADD COLUMN IF NOT EXISTS project_description  TEXT,
  ADD COLUMN IF NOT EXISTS project_goals        TEXT,
  ADD COLUMN IF NOT EXISTS target_audience      TEXT,
  ADD COLUMN IF NOT EXISTS genre                TEXT,
  ADD COLUMN IF NOT EXISTS service_price        NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS addons_total         NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount             NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_price          NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_full_price NUMERIC,
  ADD COLUMN IF NOT EXISTS subscription         TEXT          NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS status               TEXT          NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS status_entered_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_stage        TEXT,
  ADD COLUMN IF NOT EXISTS completed_percentage INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_completion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deadline             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_comment        TEXT,
  ADD COLUMN IF NOT EXISTS client_feedback      TEXT,
  ADD COLUMN IF NOT EXISTS revision_notes       TEXT,
  ADD COLUMN IF NOT EXISTS revision_count       INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rejection_reason     TEXT,
  ADD COLUMN IF NOT EXISTS existing_material    TEXT,
  ADD COLUMN IF NOT EXISTS paid_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_date        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_date       TIMESTAMPTZ,
  -- Legit nested jsonb:
  ADD COLUMN IF NOT EXISTS services             JSONB         NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS addons               JSONB         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "references"         JSONB         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS stage_progress       JSONB         NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS assigned_team        JSONB         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS files                JSONB         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS extra                JSONB         NOT NULL DEFAULT '{}'::jsonb;

UPDATE production_360_orders SET
  artist_id            = COALESCE(artist_id,            NULLIF(data->>'artistId','')),
  artist_name          = COALESCE(artist_name,          NULLIF(data->>'artistName','')),
  service_type         = COALESCE(service_type,         NULLIF(data->>'serviceType','')),
  project_title        = COALESCE(project_title,        NULLIF(data->>'projectTitle','')),
  project_description  = COALESCE(project_description,  NULLIF(data->>'projectDescription','')),
  project_goals        = COALESCE(project_goals,        NULLIF(data->>'projectGoals','')),
  target_audience      = COALESCE(target_audience,      NULLIF(data->>'targetAudience','')),
  genre                = COALESCE(genre,                NULLIF(data->>'genre','')),
  service_price        = CASE WHEN service_price = 0 AND data->>'servicePrice' IS NOT NULL
                              THEN COALESCE(NULLIF(data->>'servicePrice','')::numeric, 0)
                              ELSE service_price END,
  addons_total         = CASE WHEN addons_total = 0 AND data->>'addonsTotal' IS NOT NULL
                              THEN COALESCE(NULLIF(data->>'addonsTotal','')::numeric, 0)
                              ELSE addons_total END,
  discount             = CASE WHEN discount = 0 AND data->>'discount' IS NOT NULL
                              THEN COALESCE(NULLIF(data->>'discount','')::numeric, 0)
                              ELSE discount END,
  final_price          = CASE WHEN final_price = 0 AND data->>'finalPrice' IS NOT NULL
                              THEN COALESCE(NULLIF(data->>'finalPrice','')::numeric, 0)
                              ELSE final_price END,
  estimated_full_price = COALESCE(estimated_full_price, NULLIF(data->>'estimatedFullPrice','')::numeric),
  subscription         = CASE WHEN subscription = 'none' AND data->>'subscription' IS NOT NULL
                              THEN data->>'subscription'
                              ELSE subscription END,
  status               = CASE WHEN status = 'draft' AND data->>'status' IS NOT NULL
                              THEN data->>'status'
                              ELSE status END,
  status_entered_at    = COALESCE(status_entered_at,    NULLIF(data->>'statusEnteredAt','')::timestamptz),
  current_stage        = COALESCE(current_stage,        NULLIF(data#>>'{progress,currentStage}','')),
  completed_percentage = CASE WHEN completed_percentage = 0 AND data#>>'{progress,completedPercentage}' IS NOT NULL
                              THEN COALESCE(NULLIF(data#>>'{progress,completedPercentage}','')::integer, 0)
                              ELSE completed_percentage END,
  estimated_completion = COALESCE(estimated_completion, NULLIF(data#>>'{progress,estimatedCompletion}','')::timestamptz),
  deadline             = COALESCE(deadline,             NULLIF(data->>'deadline','')::timestamptz),
  admin_comment        = COALESCE(admin_comment,        NULLIF(data->>'adminComment','')),
  client_feedback      = COALESCE(client_feedback,      NULLIF(data->>'clientFeedback','')),
  revision_notes       = COALESCE(revision_notes,       NULLIF(data->>'revisionNotes','')),
  revision_count       = CASE WHEN revision_count = 0 AND data->>'revisionCount' IS NOT NULL
                              THEN COALESCE(NULLIF(data->>'revisionCount','')::integer, 0)
                              ELSE revision_count END,
  rejection_reason     = COALESCE(rejection_reason,     NULLIF(data->>'rejectionReason','')),
  existing_material    = COALESCE(existing_material,    NULLIF(data->>'existingMaterial','')),
  paid_at              = COALESCE(paid_at,              NULLIF(data->>'paidAt','')::timestamptz),
  approved_date        = COALESCE(approved_date,        NULLIF(data->>'approvedDate','')::timestamptz),
  completed_date       = COALESCE(completed_date,       NULLIF(data->>'completedDate','')::timestamptz),
  services             = CASE WHEN services = '{}'::jsonb
                              THEN COALESCE(data->'services', '{}'::jsonb)
                              ELSE services END,
  addons               = CASE WHEN addons = '[]'::jsonb
                              THEN COALESCE(data->'addons', '[]'::jsonb)
                              ELSE addons END,
  "references"         = CASE WHEN "references" = '[]'::jsonb
                              THEN COALESCE(data->'references', '[]'::jsonb)
                              ELSE "references" END,
  stage_progress       = CASE WHEN stage_progress = '{}'::jsonb
                              THEN COALESCE(data#>'{progress,stageProgress}', '{}'::jsonb)
                              ELSE stage_progress END,
  assigned_team        = CASE WHEN assigned_team = '[]'::jsonb
                              THEN COALESCE(data->'assignedTeam', '[]'::jsonb)
                              ELSE assigned_team END,
  files                = CASE WHEN files = '[]'::jsonb
                              THEN COALESCE(data->'files', '[]'::jsonb)
                              ELSE files END
WHERE jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_p360_artist_created
  ON production_360_orders(artist_id, created_at DESC)
  WHERE artist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_p360_status_created
  ON production_360_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_p360_active
  ON production_360_orders(status, created_at DESC)
  WHERE status NOT IN ('completed', 'cancelled');

ALTER TABLE production_360_orders DROP COLUMN IF EXISTS data;

-- DROP derived index tables — заменены native indexes.
DROP TABLE IF EXISTS production_360_by_status;
DROP TABLE IF EXISTS production_360_by_artist;
