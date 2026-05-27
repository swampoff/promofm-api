-- 054_dj_subscriptions_promote_jsonb_to_native.sql
--
-- dj_subscriptions — KV (dj_id PK + data JSONB) → row-per-dj (1 active
-- subscription per DJ) с 9 native cols + 1 legit jsonb (plan limits).
--
-- Handler пишет camelCase в data jsonb (djId/planId/planName/status/
-- price/currency/interval/startDate/endDate/limits). Promotion на native
-- snake_case + mapDjSubscriptionRow для API-contract preservation.
--
-- В том же PR (не требует SQL):
--   - djCampaignsStore + djNotificationsStore — dead imports в dj-studio-
--     routes.tsx, 0 method invocations. Удалены из импорта + jsonbStore
--     declaration. Таблицы (`dj_campaigns`, `dj_notifications`) остаются
--     как есть на проде — если на них что-то пишут через прямой SQL,
--     drop'ать рискованно. Оставлены до явной проверки laptop'ом.
--   - djTransactionsStore — 0 writes в коде, 2 .get(userId) для
--     read-only timeline. Оставлен как jsonbStore (мы не знаем, кто
--     пишет). Помечен в tracker'е как «orphan-or-external-write».
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d dj_subscriptions
--   SELECT COUNT(*) total,
--          COUNT(DISTINCT data->>'planId') plans,
--          COUNT(DISTINCT data->>'status') statuses
--     FROM dj_subscriptions;
--   SELECT polname FROM pg_policy
--    WHERE polrelid::regclass::text='dj_subscriptions';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t dj_subscriptions promofm > /tmp/dj_sub_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/054_dj_subscriptions_promote_jsonb_to_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

CREATE TABLE IF NOT EXISTS dj_subscriptions (
  dj_id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE dj_subscriptions
  ADD COLUMN IF NOT EXISTS plan_id    TEXT,
  ADD COLUMN IF NOT EXISTS plan_name  TEXT,
  ADD COLUMN IF NOT EXISTS status     TEXT          NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS price      NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency   TEXT          NOT NULL DEFAULT '₽',
  ADD COLUMN IF NOT EXISTS billing_interval TEXT    NOT NULL DEFAULT 'month',
  ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_date   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS limits     JSONB         NOT NULL DEFAULT '{}'::jsonb;

-- Backfill: handler пишет camelCase (planId, planName, startDate, endDate, interval)
-- → mapping. Renamed interval → billing_interval поскольку INTERVAL — reserved keyword
-- в PostgreSQL для type, чтобы не конфликтовать в queries.
UPDATE dj_subscriptions SET
  plan_id           = COALESCE(plan_id,    NULLIF(data->>'planId','')),
  plan_name         = COALESCE(plan_name,  NULLIF(data->>'planName','')),
  status            = CASE WHEN status = 'active' AND data->>'status' IS NOT NULL
                           THEN data->>'status'
                           ELSE status END,
  price             = CASE WHEN price = 0 AND data->>'price' IS NOT NULL
                           THEN COALESCE(NULLIF(data->>'price','')::numeric, 0)
                           ELSE price END,
  currency          = CASE WHEN currency = '₽' AND data->>'currency' IS NOT NULL
                           THEN data->>'currency'
                           ELSE currency END,
  billing_interval  = CASE WHEN billing_interval = 'month' AND data->>'interval' IS NOT NULL
                           THEN data->>'interval'
                           ELSE billing_interval END,
  start_date        = COALESCE(start_date, NULLIF(data->>'startDate','')::timestamptz),
  end_date          = COALESCE(end_date,   NULLIF(data->>'endDate','')::timestamptz),
  limits            = CASE WHEN limits = '{}'::jsonb
                           THEN COALESCE(data->'limits', '{}'::jsonb)
                           ELSE limits END
WHERE jsonb_typeof(data) = 'object';

-- Hot-path: filter активных subscription'ов (для cron'а истекающих).
CREATE INDEX IF NOT EXISTS idx_dj_subscriptions_active_end
  ON dj_subscriptions(end_date)
  WHERE status = 'active' AND end_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dj_subscriptions_plan
  ON dj_subscriptions(plan_id)
  WHERE plan_id IS NOT NULL;

ALTER TABLE dj_subscriptions DROP COLUMN IF EXISTS data;
