-- 053_track_test_reviews_cluster_promote_jsonb.sql
--
-- ExpertReview-кластер (4 satellite stores под track_test_requests):
--
-- ✅ track_test_reviews         — promote 16 native cols + audio_notes jsonb
-- ✅ track_test_expert_stats    — promote 5 native cols (counters + joined_at)
-- 🗑  track_test_request_reviews — DROP TABLE (derived: review.request_id)
-- 🗑  track_test_experts        — DROP TABLE (derived: SELECT DISTINCT expert_id
--                                FROM track_test_expert_stats)
--
-- handler'ы в src/track-test-routes.tsx не трогаются — stores в db.tsx
-- становятся обёртками preserving .get/.set/.del/.getAll interface.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d track_test_reviews
--   \d track_test_expert_stats
--   \d track_test_request_reviews
--   \d track_test_experts
--   SELECT COUNT(*) FROM track_test_reviews;
--   SELECT COUNT(DISTINCT data->>'expert_email') FROM track_test_reviews;
--   SELECT polname FROM pg_policy
--    WHERE polrelid::regclass::text IN ('track_test_reviews','track_test_expert_stats');
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t track_test_reviews -t track_test_expert_stats
--               -t track_test_request_reviews -t track_test_experts promofm
--        > /tmp/track_test_cluster_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/053_track_test_reviews_cluster_promote_jsonb.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- ─── track_test_reviews — ExpertReview ───

CREATE TABLE IF NOT EXISTS track_test_reviews (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE track_test_reviews
  ADD COLUMN IF NOT EXISTS request_id                       TEXT,
  ADD COLUMN IF NOT EXISTS expert_email                     TEXT,
  ADD COLUMN IF NOT EXISTS expert_name                      TEXT,
  ADD COLUMN IF NOT EXISTS expert_role                      TEXT,
  ADD COLUMN IF NOT EXISTS status                           TEXT          NOT NULL DEFAULT 'assigned',
  ADD COLUMN IF NOT EXISTS mixing_mastering_score           NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrangement_score                NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS originality_score                NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commercial_potential_score       NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overall_score                    NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mixing_mastering_feedback        TEXT          NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS arrangement_feedback             TEXT          NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS originality_feedback             TEXT          NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS commercial_potential_feedback    TEXT          NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS general_feedback                 TEXT          NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recommendations                  TEXT          NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS audio_notes                      JSONB         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reward_points                    INTEGER       NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS reward_paid                      BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS completed_at                     TIMESTAMPTZ;

UPDATE track_test_reviews SET
  request_id                    = COALESCE(request_id,                     NULLIF(data->>'request_id','')),
  expert_email                  = COALESCE(expert_email,                   NULLIF(data->>'expert_email','')),
  expert_name                   = COALESCE(expert_name,                    NULLIF(data->>'expert_name','')),
  expert_role                   = COALESCE(expert_role,                    NULLIF(data->>'expert_role','')),
  status                        = CASE WHEN status = 'assigned' AND data->>'status' IS NOT NULL
                                       THEN data->>'status'
                                       ELSE status END,
  mixing_mastering_score        = CASE WHEN mixing_mastering_score = 0     AND data->>'mixing_mastering_score'     IS NOT NULL
                                       THEN COALESCE(NULLIF(data->>'mixing_mastering_score','')::numeric, 0)
                                       ELSE mixing_mastering_score END,
  arrangement_score             = CASE WHEN arrangement_score = 0          AND data->>'arrangement_score'          IS NOT NULL
                                       THEN COALESCE(NULLIF(data->>'arrangement_score','')::numeric, 0)
                                       ELSE arrangement_score END,
  originality_score             = CASE WHEN originality_score = 0          AND data->>'originality_score'          IS NOT NULL
                                       THEN COALESCE(NULLIF(data->>'originality_score','')::numeric, 0)
                                       ELSE originality_score END,
  commercial_potential_score    = CASE WHEN commercial_potential_score = 0 AND data->>'commercial_potential_score' IS NOT NULL
                                       THEN COALESCE(NULLIF(data->>'commercial_potential_score','')::numeric, 0)
                                       ELSE commercial_potential_score END,
  overall_score                 = CASE WHEN overall_score = 0              AND data->>'overall_score'              IS NOT NULL
                                       THEN COALESCE(NULLIF(data->>'overall_score','')::numeric, 0)
                                       ELSE overall_score END,
  mixing_mastering_feedback     = CASE WHEN mixing_mastering_feedback = '' THEN COALESCE(data->>'mixing_mastering_feedback','')
                                       ELSE mixing_mastering_feedback END,
  arrangement_feedback          = CASE WHEN arrangement_feedback = ''      THEN COALESCE(data->>'arrangement_feedback','')
                                       ELSE arrangement_feedback END,
  originality_feedback          = CASE WHEN originality_feedback = ''      THEN COALESCE(data->>'originality_feedback','')
                                       ELSE originality_feedback END,
  commercial_potential_feedback = CASE WHEN commercial_potential_feedback = '' THEN COALESCE(data->>'commercial_potential_feedback','')
                                       ELSE commercial_potential_feedback END,
  general_feedback              = CASE WHEN general_feedback = ''          THEN COALESCE(data->>'general_feedback','')
                                       ELSE general_feedback END,
  recommendations               = CASE WHEN recommendations = ''           THEN COALESCE(data->>'recommendations','')
                                       ELSE recommendations END,
  audio_notes                   = CASE WHEN audio_notes = '[]'::jsonb      THEN COALESCE(data->'audio_notes', '[]'::jsonb)
                                       ELSE audio_notes END,
  reward_points                 = CASE WHEN reward_points = 50 AND data->>'reward_points' IS NOT NULL
                                       THEN COALESCE(NULLIF(data->>'reward_points','')::integer, 50)
                                       ELSE reward_points END,
  reward_paid                   = CASE WHEN reward_paid = FALSE AND data->>'reward_paid' IS NOT NULL
                                       THEN COALESCE(NULLIF(data->>'reward_paid','')::boolean, FALSE)
                                       ELSE reward_paid END,
  completed_at                  = COALESCE(completed_at,                   NULLIF(data->>'completed_at','')::timestamptz),
  created_at                    = COALESCE(created_at,                     NULLIF(data->>'created_at','')::timestamptz)
WHERE jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_track_test_reviews_request
  ON track_test_reviews(request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_track_test_reviews_expert
  ON track_test_reviews(expert_email)
  WHERE expert_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_track_test_reviews_open
  ON track_test_reviews(status, created_at DESC)
  WHERE status IN ('assigned', 'in_progress');

ALTER TABLE track_test_reviews DROP COLUMN IF EXISTS data;

-- ─── track_test_expert_stats — ExpertStats ───

CREATE TABLE IF NOT EXISTS track_test_expert_stats (
  expert_id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE track_test_expert_stats
  ADD COLUMN IF NOT EXISTS total_assigned   INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_completed  INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_coins      INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_bonus     NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS joined_at        TIMESTAMPTZ;

UPDATE track_test_expert_stats SET
  total_assigned  = CASE WHEN total_assigned = 0  AND data->>'total_assigned'  IS NOT NULL
                         THEN COALESCE(NULLIF(data->>'total_assigned','')::integer, 0)
                         ELSE total_assigned END,
  total_completed = CASE WHEN total_completed = 0 AND data->>'total_completed' IS NOT NULL
                         THEN COALESCE(NULLIF(data->>'total_completed','')::integer, 0)
                         ELSE total_completed END,
  total_coins     = CASE WHEN total_coins = 0     AND data->>'total_coins'     IS NOT NULL
                         THEN COALESCE(NULLIF(data->>'total_coins','')::integer, 0)
                         ELSE total_coins END,
  rating_bonus    = CASE WHEN rating_bonus = 0    AND data->>'rating_bonus'    IS NOT NULL
                         THEN COALESCE(NULLIF(data->>'rating_bonus','')::numeric, 0)
                         ELSE rating_bonus END,
  joined_at       = COALESCE(joined_at,           NULLIF(data->>'joined_at','')::timestamptz)
WHERE jsonb_typeof(data) = 'object';

ALTER TABLE track_test_expert_stats DROP COLUMN IF EXISTS data;

-- ─── DROP derived tables ───

-- track_test_request_reviews: per-request array of review_ids — derived
-- из track_test_reviews.request_id + idx_track_test_reviews_request.
DROP TABLE IF EXISTS track_test_request_reviews;

-- track_test_experts: singleton с array of expert_ids — derived из
-- SELECT DISTINCT expert_id FROM track_test_expert_stats.
DROP TABLE IF EXISTS track_test_experts;
