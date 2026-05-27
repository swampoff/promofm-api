-- 045_kv_wave1_5_dj_campaigns_drop_notifications.sql
--
-- Wave 1.5 продолжение:
-- 1. `dj_campaigns` → row-per-campaign (array-store с race risk)
-- 2. `dj_notifications` → DROP TABLE (orphan — handlers читают пустую
--    таблицу, cross-cabinet-notify.tsx уже пишет в
--    cross_cabinet_notifications). DJ-cabinet /notifications handlers
--    переписаны на cross_cabinet_notifications в этом PR.
--
-- BEFORE (dj_campaigns):
--   jsonbStore('dj_campaigns', 'dj_id') — pk=dj_id, data jsonb array.
--   POST /promotion/campaigns: get → unshift → set. Race-condition
--   при concurrent создании кампаний.
--
-- BEFORE (dj_notifications):
--   jsonbStore('dj_notifications', 'dj_id') — pk=dj_id, data jsonb array.
--   GET /notifications читает массив, POST /notifications/read
--   mark-as-read. НО: grep подтвердил 0 writers (cross-cabinet-notify.tsx
--   пишет в `cross_cabinet_notifications`, не сюда!). dj_notifications —
--   мёртвый код, GET всегда возвращал []. DJ не видел свои
--   cross-cabinet-уведомления вообще.
--
-- AFTER:
--   - dj_campaigns: row-per-campaign, native cols, composite UNIQUE
--   - dj_notifications: DROP TABLE. DJ-handlers переписаны на
--     cross_cabinet_notifications (актуальный store).
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT — runner
-- оборачивает (см. CLAUDE.md → «Migration files: NO BEGIN/COMMIT»).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d dj_campaigns
--   \d dj_notifications
--   SELECT COUNT(*) rows, COALESCE(SUM(jsonb_array_length(data)),0) items
--     FROM dj_campaigns WHERE jsonb_typeof(data)='array';
--   SELECT COUNT(*) rows, COALESCE(SUM(jsonb_array_length(data)),0) items
--     FROM dj_notifications WHERE jsonb_typeof(data)='array';
--   -- Если в dj_notifications есть rows с непустыми массивами —
--   -- DROP TABLE их wipes. Backup-страховка по умолчанию (см. STEPS).
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t dj_campaigns -t dj_notifications promofm \
--        > /tmp/dj_camp_notif_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/045_kv_wave1_5_dj_campaigns_drop_notifications.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- ════════════════════════════════════════════════════════════════════
-- 1. dj_campaigns → row-per-campaign
-- ════════════════════════════════════════════════════════════════════

-- Bootstrap legacy kv-store table if missing (jsonbStore.set never called → table not created).
-- Laptop pre-flight 2026-05-27: dj_campaigns не существовал на проде.
CREATE TABLE IF NOT EXISTS dj_campaigns (
  dj_id      TEXT        PRIMARY KEY,
  data       JSONB                DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ          DEFAULT NOW(),
  updated_at TIMESTAMPTZ          DEFAULT NOW()
);

CREATE TEMP TABLE _djc_backup ON COMMIT DROP AS
  SELECT dj_id AS legacy_dj_id, data, created_at FROM dj_campaigns;

DROP POLICY IF EXISTS dj_campaigns_sel ON dj_campaigns;
DROP POLICY IF EXISTS dj_campaigns_ins ON dj_campaigns;
DROP POLICY IF EXISTS dj_campaigns_upd ON dj_campaigns;
DROP POLICY IF EXISTS dj_campaigns_del ON dj_campaigns;
DROP POLICY IF EXISTS djc_admin_all ON dj_campaigns;
DROP POLICY IF EXISTS djc_select_own ON dj_campaigns;
DROP POLICY IF EXISTS djc_insert ON dj_campaigns;
DROP POLICY IF EXISTS djc_update_own ON dj_campaigns;

ALTER TABLE dj_campaigns DROP CONSTRAINT IF EXISTS dj_campaigns_pkey;
ALTER TABLE dj_campaigns DROP CONSTRAINT IF EXISTS dj_campaigns_dj_id_key;
ALTER TABLE dj_campaigns DROP CONSTRAINT IF EXISTS dj_campaigns_app_id_unique;
ALTER TABLE dj_campaigns DROP CONSTRAINT IF EXISTS djc_dj_app_unique;

TRUNCATE dj_campaigns;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='dj_campaigns' AND column_name='id') THEN
    ALTER TABLE dj_campaigns DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE dj_campaigns
  ADD COLUMN id            UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id        TEXT,
  -- dj_id уже есть как TEXT — keep
  ADD COLUMN IF NOT EXISTS title         TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS campaign_type TEXT         NOT NULL DEFAULT 'banner',
  ADD COLUMN IF NOT EXISTS status        TEXT         NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS impressions   INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicks        INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget        NUMERIC      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spent         NUMERIC      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mix_id        TEXT,
  ADD COLUMN IF NOT EXISTS started_at    TIMESTAMPTZ;

ALTER TABLE dj_campaigns ADD PRIMARY KEY (id);
ALTER TABLE dj_campaigns
  ADD CONSTRAINT djc_dj_app_unique UNIQUE (dj_id, app_id);

CREATE INDEX IF NOT EXISTS idx_djc_dj_created
  ON dj_campaigns(dj_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_djc_status_active
  ON dj_campaigns(status) WHERE status = 'active';

-- Backfill: jsonb_array_elements → строки.
-- Shape: {id, djId, title, type, status, impressions, clicks, budget,
--         spent, mixId, startedAt, createdAt, updatedAt}
INSERT INTO dj_campaigns (
  id, app_id, dj_id, title, campaign_type, status,
  impressions, clicks, budget, spent, mix_id, started_at,
  created_at, updated_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  COALESCE(elem->>'djId', b.legacy_dj_id),
  COALESCE(NULLIF(elem->>'title',''), ''),
  COALESCE(NULLIF(elem->>'type',''), 'banner'),
  COALESCE(NULLIF(elem->>'status',''), 'active'),
  COALESCE(NULLIF(elem->>'impressions','')::integer, 0),
  COALESCE(NULLIF(elem->>'clicks','')::integer, 0),
  COALESCE(NULLIF(elem->>'budget','')::numeric, 0),
  COALESCE(NULLIF(elem->>'spent','')::numeric, 0),
  NULLIF(elem->>'mixId',''),
  NULLIF(elem->>'startedAt','')::timestamptz,
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz,
           NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW())
FROM _djc_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE dj_campaigns DROP COLUMN IF EXISTS data;

-- RLS (djc_* pattern, симметрично djw_*)
CREATE POLICY djc_admin_all ON dj_campaigns
  FOR ALL USING (
    current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY djc_select_own ON dj_campaigns
  FOR SELECT USING (
    dj_id = current_setting('app.current_user_id', true)
  );
CREATE POLICY djc_insert ON dj_campaigns
  FOR INSERT WITH CHECK (
    dj_id = current_setting('app.current_user_id', true)
  );
CREATE POLICY djc_update_own ON dj_campaigns
  FOR UPDATE USING (
    dj_id = current_setting('app.current_user_id', true)
  );

-- ════════════════════════════════════════════════════════════════════
-- 2. dj_notifications → DROP TABLE (orphan)
-- ════════════════════════════════════════════════════════════════════
-- Никто не пишет в dj_notifications: cross-cabinet-notify.tsx пишет
-- в cross_cabinet_notifications. DJ /notifications handlers были
-- broken — читали пустую таблицу. После этой миграции handlers
-- читают из cross_cabinet_notifications (PR PROD изменения).
DROP TABLE IF EXISTS dj_notifications;
