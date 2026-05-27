-- 049_notification_campaigns_promote_jsonb_to_native.sql
--
-- Wave 3 #3+#5 of 7: notification_campaigns — KV (id PK + data JSONB) →
-- row-per-campaign with 17 native cols + 4 legit jsonb arrays/objects.
--
-- Эта таблица — **реальный backing store** для feature «промо-кампании»
-- (см. src/marketing-campaigns-routes.tsx, помимо имени файла она пишет
-- именно в notification_campaigns через notificationCampaignsStore /
-- getNotificationCampaignsByUser / upsertNotificationCampaign).
--
-- Bonus в том же PR (не требует SQL): удаление мёртвых хелперов
-- getCampaignsByUser / upsertCampaign в src/db.tsx — они пишут в
-- `marketing_campaigns.data jsonb`, но в этой таблице сейчас native cols
-- и НИ ОДНОГО caller'а у этих хелперов нет (grep пустой). Просто dead
-- code — убираем чтобы не сбивать с толку. SQL миграции не нужно,
-- `marketing_campaigns.data` (если столбец вообще есть) остаётся как
-- было — там нет ничего ценного.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d notification_campaigns
--   SELECT COUNT(*) total,
--          COUNT(*) FILTER (WHERE user_id IS NOT NULL) with_user,
--          COUNT(DISTINCT data->>'status') statuses,
--          COUNT(DISTINCT data->>'budget_preference') budgets
--     FROM notification_campaigns;
--   SELECT polname FROM pg_policy
--    WHERE polrelid::regclass::text='notification_campaigns';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t notification_campaigns promofm > /tmp/nc_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/049_notification_campaigns_promote_jsonb_to_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Bootstrap legacy kv-store table if missing (lazy jsonbStore mode never
-- created it on prod если фича ни разу не запускалась).
CREATE TABLE IF NOT EXISTS notification_campaigns (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notification_campaigns
  ADD COLUMN IF NOT EXISTS user_id              TEXT,
  ADD COLUMN IF NOT EXISTS campaign_name        TEXT,
  ADD COLUMN IF NOT EXISTS artist_name          TEXT,
  ADD COLUMN IF NOT EXISTS description          TEXT,
  ADD COLUMN IF NOT EXISTS start_date           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_date             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS budget_preference    TEXT,         -- 'low'|'medium'|'high'|custom
  ADD COLUMN IF NOT EXISTS custom_budget        NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_price           NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_price          NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_applied     NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status               TEXT          NOT NULL DEFAULT 'pending_review',
  ADD COLUMN IF NOT EXISTS rejection_reason     TEXT,
  ADD COLUMN IF NOT EXISTS content_ids          JSONB         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS channels             JSONB         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS target_audience      JSONB         NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS additional_materials JSONB         NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS approved_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS launched_at          TIMESTAMPTZ;

-- Backfill из data jsonb. COALESCE / CASE гарантируют что мы не
-- overwrite'ним native value которое уже было выставлено.
UPDATE notification_campaigns SET
  user_id              = COALESCE(user_id,              NULLIF(data->>'user_id','')),
  campaign_name        = COALESCE(campaign_name,        NULLIF(data->>'campaign_name','')),
  artist_name          = COALESCE(artist_name,          NULLIF(data->>'artist_name','')),
  description          = COALESCE(description,          NULLIF(data->>'description','')),
  start_date           = COALESCE(start_date,           NULLIF(data->>'start_date','')::timestamptz),
  end_date             = COALESCE(end_date,             NULLIF(data->>'end_date','')::timestamptz),
  budget_preference    = COALESCE(budget_preference,    NULLIF(data->>'budget_preference','')),
  custom_budget        = CASE WHEN custom_budget = 0    AND data->>'custom_budget'    IS NOT NULL
                              THEN COALESCE(NULLIF(data->>'custom_budget','')::numeric, 0)
                              ELSE custom_budget END,
  base_price           = CASE WHEN base_price = 0       AND data->>'base_price'       IS NOT NULL
                              THEN COALESCE(NULLIF(data->>'base_price','')::numeric, 0)
                              ELSE base_price END,
  final_price          = CASE WHEN final_price = 0      AND data->>'final_price'      IS NOT NULL
                              THEN COALESCE(NULLIF(data->>'final_price','')::numeric, 0)
                              ELSE final_price END,
  discount_applied     = CASE WHEN discount_applied = 0 AND data->>'discount_applied' IS NOT NULL
                              THEN COALESCE(NULLIF(data->>'discount_applied','')::numeric, 0)
                              ELSE discount_applied END,
  status               = CASE WHEN status = 'pending_review' AND data->>'status' IS NOT NULL
                              THEN data->>'status'
                              ELSE status END,
  rejection_reason     = COALESCE(rejection_reason,     NULLIF(data->>'rejection_reason','')),
  content_ids          = CASE WHEN content_ids = '[]'::jsonb
                              THEN COALESCE(data->'content_ids', '[]'::jsonb)
                              ELSE content_ids END,
  channels             = CASE WHEN channels = '[]'::jsonb
                              THEN COALESCE(data->'channels', '[]'::jsonb)
                              ELSE channels END,
  target_audience      = CASE WHEN target_audience = '{}'::jsonb
                              THEN COALESCE(data->'target_audience', '{}'::jsonb)
                              ELSE target_audience END,
  additional_materials = CASE WHEN additional_materials = '{}'::jsonb
                              THEN COALESCE(data->'additional_materials', '{}'::jsonb)
                              ELSE additional_materials END,
  approved_at          = COALESCE(approved_at,          NULLIF(data->>'approved_at','')::timestamptz),
  rejected_at          = COALESCE(rejected_at,          NULLIF(data->>'rejected_at','')::timestamptz),
  launched_at          = COALESCE(launched_at,          NULLIF(data->>'launched_at','')::timestamptz)
WHERE jsonb_typeof(data) = 'object';

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_notification_campaigns_user_created
  ON notification_campaigns(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_campaigns_pending
  ON notification_campaigns(created_at DESC)
  WHERE status = 'pending_review';
CREATE INDEX IF NOT EXISTS idx_notification_campaigns_status_created
  ON notification_campaigns(status, created_at DESC);

-- DROP COLUMN data — всё промоутировано, 4 legit jsonb колонки уже скопированы.
ALTER TABLE notification_campaigns DROP COLUMN IF EXISTS data;
