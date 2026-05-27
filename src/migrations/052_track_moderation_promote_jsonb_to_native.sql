-- 052_track_moderation_promote_jsonb_to_native.sql
--
-- Wave 3 #7/7 (last hybrid!): track_moderation — небольшая hybrid таблица
-- (id PK + track_id + ai_check_status уже native, остальное в data jsonb).
--
-- Promotion: aiCheckStartedAt / aiCheckFinishedAt / aiCheckError →
-- native timestamptz/text. aiCheckResult остаётся jsonb (legit nested
-- analyzer breakdown: ai_score, confidence, verdict, breakdown, и т.д.).
--
-- Также: удаляем мёртвый jsonbStore('track_moderation') declaration
-- в src/db.tsx (0 callers, см. grep'ed в PR description). Все актуальные
-- writes идут напрямую через pool.query в src/ai-check.tsx.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d track_moderation
--   SELECT COUNT(*) total,
--          COUNT(*) FILTER (WHERE data ? 'aiCheckResult') with_result,
--          COUNT(DISTINCT ai_check_status) statuses
--     FROM track_moderation;
--   SELECT polname FROM pg_policy
--    WHERE polrelid::regclass::text='track_moderation';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t track_moderation promofm > /tmp/track_mod_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/052_track_moderation_promote_jsonb_to_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Bootstrap legacy table (на всякий случай, обычно она уже есть).
CREATE TABLE IF NOT EXISTS track_moderation (
  id TEXT PRIMARY KEY,
  track_id TEXT,
  ai_check_status TEXT,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE track_moderation
  ADD COLUMN IF NOT EXISTS ai_check_started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_check_finished_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_check_error        TEXT,
  ADD COLUMN IF NOT EXISTS ai_check_result       JSONB;

-- Backfill из data jsonb. Handler писал camelCase через jsonb_build_object
-- (aiCheckStartedAt / aiCheckFinishedAt / aiCheckError / aiCheckResult),
-- так что mapping простой.
UPDATE track_moderation SET
  ai_check_started_at  = COALESCE(ai_check_started_at,  NULLIF(data->>'aiCheckStartedAt','')::timestamptz),
  ai_check_finished_at = COALESCE(ai_check_finished_at, NULLIF(data->>'aiCheckFinishedAt','')::timestamptz),
  ai_check_error       = COALESCE(ai_check_error,       NULLIF(data->>'aiCheckError','')),
  ai_check_result      = COALESCE(ai_check_result,      data->'aiCheckResult')
WHERE jsonb_typeof(data) = 'object';

-- Hot-path indexes
-- track_id lookup для backfill query (LEFT JOIN tm.id = 'ai_'||t.id уже
-- через PK, отдельный индекс не нужен), но для будущего admin filtering
-- по status — partial index на не-final состояния.
CREATE INDEX IF NOT EXISTS idx_track_moderation_status_pending
  ON track_moderation(ai_check_status, updated_at DESC)
  WHERE ai_check_status IN ('pending', 'error');
CREATE INDEX IF NOT EXISTS idx_track_moderation_track_id
  ON track_moderation(track_id)
  WHERE track_id IS NOT NULL;

-- DROP COLUMN data — всё промоутировано, aiCheckResult сохранён в
-- отдельной native jsonb колонке ai_check_result.
ALTER TABLE track_moderation DROP COLUMN IF EXISTS data;
