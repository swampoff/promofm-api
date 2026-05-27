-- 051_track_test_requests_promote_jsonb_to_native.sql
--
-- Wave 3 #6/7: track_test_requests — KV (id PK + data JSONB) →
-- row-per-request с 24 native cols + 2 legit jsonb cols.
--
-- В PR также DROP'аем 2 redundant index таблицы:
--   - track_test_user_requests (user_id PK + JSON-массив request_id'ов) —
--     заменяется на SELECT … WHERE user_id = $1 ORDER BY created_at DESC.
--   - track_test_all_requests  (id='singleton' + JSON-массив всех id'ов) —
--     заменяется на SELECT … ORDER BY created_at DESC.
-- Обе хранили derived data из main table → источник рассинхрона
-- (handler делал 2-3 write'а на каждый submit без транзакции).
--
-- НЕ трогаем в этом PR (отложено в отдельный):
--   - track_test_reviews (review_id PK + data) — отдельная сущность ExpertReview
--   - track_test_request_reviews (request_id PK + array of review_ids) — index reviews
--   - track_test_experts (singleton + array of expert_ids) — registry экспертов
--   - track_test_expert_stats (expert_id PK + data) — статистика экспертов
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d track_test_requests
--   \d track_test_user_requests
--   \d track_test_all_requests
--   SELECT COUNT(*) total,
--          COUNT(*) FILTER (WHERE data->>'user_id' IS NOT NULL) with_user,
--          COUNT(DISTINCT data->>'status') statuses,
--          COUNT(DISTINCT data->>'payment_status') payment_statuses
--     FROM track_test_requests;
--   SELECT polname FROM pg_policy
--    WHERE polrelid::regclass::text='track_test_requests';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t track_test_requests -t track_test_user_requests
--               -t track_test_all_requests promofm
--        > /tmp/track_test_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/051_track_test_requests_promote_jsonb_to_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Bootstrap legacy kv-store если lazy mode не создал таблицу.
CREATE TABLE IF NOT EXISTS track_test_requests (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE track_test_requests
  ADD COLUMN IF NOT EXISTS user_id                       TEXT,
  ADD COLUMN IF NOT EXISTS track_id                      TEXT,
  ADD COLUMN IF NOT EXISTS guest_email                   TEXT,
  ADD COLUMN IF NOT EXISTS guest_name                    TEXT,
  ADD COLUMN IF NOT EXISTS guest_track_url               TEXT,
  ADD COLUMN IF NOT EXISTS guest_cover_url               TEXT,
  ADD COLUMN IF NOT EXISTS track_title                   TEXT,
  ADD COLUMN IF NOT EXISTS artist_name                   TEXT,
  ADD COLUMN IF NOT EXISTS genre                         TEXT,
  ADD COLUMN IF NOT EXISTS status                        TEXT          NOT NULL DEFAULT 'pending_payment',
  ADD COLUMN IF NOT EXISTS payment_status                TEXT          NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_amount                NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_transaction_id        TEXT,
  ADD COLUMN IF NOT EXISTS required_expert_count         INTEGER       NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS completed_reviews_count       INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS average_rating                NUMERIC,
  ADD COLUMN IF NOT EXISTS assigned_experts              JSONB         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS category_averages             JSONB         NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS final_analysis                TEXT,
  ADD COLUMN IF NOT EXISTS consolidated_feedback         TEXT,
  ADD COLUMN IF NOT EXISTS consolidated_recommendations  TEXT,
  ADD COLUMN IF NOT EXISTS admin_approval_status         TEXT,
  ADD COLUMN IF NOT EXISTS moderation_notes              TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason              TEXT,
  ADD COLUMN IF NOT EXISTS feedback_sent_date            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at                  TIMESTAMPTZ;

-- Backfill из data jsonb (идемпотентно: пишем только если native NULL / default).
UPDATE track_test_requests SET
  user_id                      = COALESCE(user_id,                NULLIF(data->>'user_id','')),
  track_id                     = COALESCE(track_id,               NULLIF(data->>'track_id','')),
  guest_email                  = COALESCE(guest_email,            NULLIF(data->>'guest_email','')),
  guest_name                   = COALESCE(guest_name,             NULLIF(data->>'guest_name','')),
  guest_track_url              = COALESCE(guest_track_url,        NULLIF(data->>'guest_track_url','')),
  guest_cover_url              = COALESCE(guest_cover_url,        NULLIF(data->>'guest_cover_url','')),
  track_title                  = COALESCE(track_title,            NULLIF(data->>'track_title','')),
  artist_name                  = COALESCE(artist_name,            NULLIF(data->>'artist_name','')),
  genre                        = COALESCE(genre,                  NULLIF(data->>'genre','')),
  status                       = CASE WHEN status = 'pending_payment' AND data->>'status' IS NOT NULL
                                      THEN data->>'status'
                                      ELSE status END,
  payment_status               = CASE WHEN payment_status = 'pending' AND data->>'payment_status' IS NOT NULL
                                      THEN data->>'payment_status'
                                      ELSE payment_status END,
  payment_amount               = CASE WHEN payment_amount = 0 AND data->>'payment_amount' IS NOT NULL
                                      THEN COALESCE(NULLIF(data->>'payment_amount','')::numeric, 0)
                                      ELSE payment_amount END,
  payment_transaction_id       = COALESCE(payment_transaction_id, NULLIF(data->>'payment_transaction_id','')),
  required_expert_count        = CASE WHEN required_expert_count = 5 AND data->>'required_expert_count' IS NOT NULL
                                      THEN COALESCE(NULLIF(data->>'required_expert_count','')::integer, 5)
                                      ELSE required_expert_count END,
  completed_reviews_count      = CASE WHEN completed_reviews_count = 0 AND data->>'completed_reviews_count' IS NOT NULL
                                      THEN COALESCE(NULLIF(data->>'completed_reviews_count','')::integer, 0)
                                      ELSE completed_reviews_count END,
  average_rating               = COALESCE(average_rating,         NULLIF(data->>'average_rating','')::numeric),
  assigned_experts             = CASE WHEN assigned_experts = '[]'::jsonb
                                      THEN COALESCE(data->'assigned_experts', '[]'::jsonb)
                                      ELSE assigned_experts END,
  category_averages            = CASE WHEN category_averages = '{}'::jsonb
                                      THEN COALESCE(data->'category_averages', '{}'::jsonb)
                                      ELSE category_averages END,
  final_analysis               = COALESCE(final_analysis,         NULLIF(data->>'final_analysis','')),
  consolidated_feedback        = COALESCE(consolidated_feedback,  NULLIF(data->>'consolidated_feedback','')),
  consolidated_recommendations = COALESCE(consolidated_recommendations, NULLIF(data->>'consolidated_recommendations','')),
  admin_approval_status        = COALESCE(admin_approval_status,  NULLIF(data->>'admin_approval_status','')),
  moderation_notes             = COALESCE(moderation_notes,       NULLIF(data->>'moderation_notes','')),
  rejection_reason             = COALESCE(rejection_reason,       NULLIF(data->>'rejection_reason','')),
  feedback_sent_date           = COALESCE(feedback_sent_date,     NULLIF(data->>'feedback_sent_date','')::timestamptz),
  completed_at                 = COALESCE(completed_at,           NULLIF(data->>'completed_at','')::timestamptz),
  created_at                   = COALESCE(created_at,             NULLIF(data->>'created_at','')::timestamptz),
  updated_at                   = COALESCE(updated_at,             NULLIF(data->>'updated_at','')::timestamptz)
WHERE jsonb_typeof(data) = 'object';

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_track_test_requests_user_created
  ON track_test_requests(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_track_test_requests_status_created
  ON track_test_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_track_test_requests_moderation_queue
  ON track_test_requests(created_at DESC)
  WHERE status IN ('payment_succeeded', 'pending_moderation');

-- DROP COLUMN data — всё промоутировано + 2 legit jsonb cols
-- (assigned_experts/category_averages) скопированы выше.
ALTER TABLE track_test_requests DROP COLUMN IF EXISTS data;

-- DROP избыточные index таблицы — derived из track_test_requests.user_id +
-- ORDER BY created_at DESC. С новыми индексами те же запросы дают
-- consistent view + автоматическая синхронизация при INSERT/DELETE.
DROP TABLE IF EXISTS track_test_user_requests;
DROP TABLE IF EXISTS track_test_all_requests;
