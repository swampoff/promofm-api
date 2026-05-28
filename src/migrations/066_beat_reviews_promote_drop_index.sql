-- 060_beat_reviews_promote_drop_index.sql
--
-- Artist cluster ч.3: beat_reviews — promote review fields в native cols.
-- DROP table beat_reviews_index (derived из beat_reviews.beat_id native idx).
--
-- Anti-pattern до 060:
--   beat_reviews        (id PK 'beat:review_X' + beat_id native + user_id native
--                        + data jsonb с rating/text/title/...)
--   beat_reviews_index  (beat_id PK + data = array of review_ids)
--
-- Каждый POST review делал:
--   1. .get('beat_reviews_index') → массив reviewId'ов
--   2. .get() per reviewId → проверка userId не уже-оставил-отзыв
--      (O(N) get-modify; race window — 2 concurrent POST'а могут оба
--       пройти dedup-check и создать дубль)
--   3. INSERT review row
--   4. unshift(reviewId) + .set('beat_reviews_index') → write индекса
-- = 3 write + N reads на каждый отзыв, + race на dedup.
--
-- Теперь:
--   beat_reviews: native cols + UNIQUE (beat_id, user_id) — DB-level race fix
--   beat_reviews_index DROPPED — derived через idx_beat_reviews_beat
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t beat_reviews -t beat_reviews_index promofm > /tmp/beat_reviews_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/060_beat_reviews_promote_drop_index.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Bootstrap legacy schema if missing.
-- Existing beat_reviews on prod has reviewer_id/comment columns;
-- cloud's migration expects user_id/review_text. 0 rows + 0 FK → DROP+rebuild safe.
DROP TABLE IF EXISTS beat_reviews CASCADE;

CREATE TABLE IF NOT EXISTS beat_reviews (
  id TEXT PRIMARY KEY,
  beat_id TEXT,
  user_id TEXT,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE beat_reviews
  ADD COLUMN IF NOT EXISTS user_name      TEXT,
  ADD COLUMN IF NOT EXISTS rating         INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS title          TEXT,
  ADD COLUMN IF NOT EXISTS review_text    TEXT,
  ADD COLUMN IF NOT EXISTS license_type   TEXT,
  ADD COLUMN IF NOT EXISTS helpful_count  INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS helpful_users  JSONB         NOT NULL DEFAULT '[]'::jsonb;

UPDATE beat_reviews SET
  -- beat_id / user_id уже native, но backfill для строк где было только data->>
  beat_id        = COALESCE(beat_id,        NULLIF(data->>'beatId','')),
  user_id        = COALESCE(user_id,        NULLIF(data->>'userId','')),
  user_name      = COALESCE(user_name,      NULLIF(data->>'userName','')),
  rating         = CASE WHEN rating = 0 AND data->>'rating' IS NOT NULL
                        THEN COALESCE(NULLIF(data->>'rating','')::integer, 0)
                        ELSE rating END,
  title          = COALESCE(title,          NULLIF(data->>'title','')),
  review_text    = COALESCE(review_text,    NULLIF(data->>'text','')),
  license_type   = COALESCE(license_type,   NULLIF(data->>'licenseType','')),
  helpful_count  = CASE WHEN helpful_count = 0 AND data->>'helpful' IS NOT NULL
                        THEN COALESCE(NULLIF(data->>'helpful','')::integer, 0)
                        ELSE helpful_count END,
  helpful_users  = CASE WHEN helpful_users = '[]'::jsonb
                        THEN COALESCE(data->'helpfulUsers', '[]'::jsonb)
                        ELSE helpful_users END,
  created_at     = COALESCE(created_at,     NULLIF(data->>'createdAt','')::timestamptz)
WHERE jsonb_typeof(data) = 'object';

-- Dedup any (beat_id, user_id) duplicates — keep newest, delete older.
DELETE FROM beat_reviews br1
 WHERE EXISTS (
   SELECT 1 FROM beat_reviews br2
    WHERE br2.beat_id = br1.beat_id
      AND br2.user_id = br1.user_id
      AND br1.beat_id IS NOT NULL
      AND br1.user_id IS NOT NULL
      AND (br2.created_at > br1.created_at
           OR (br2.created_at = br1.created_at AND br2.id > br1.id))
 );

-- DB-level race fix: 2 concurrent reviews от одного user'а на тот же beat
-- больше не пройдут — UNIQUE constraint отвалит вторую INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_beat_reviews_beat_user
  ON beat_reviews(beat_id, user_id)
  WHERE beat_id IS NOT NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_beat_reviews_beat_created
  ON beat_reviews(beat_id, created_at DESC)
  WHERE beat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_beat_reviews_user_created
  ON beat_reviews(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

ALTER TABLE beat_reviews DROP COLUMN IF EXISTS data;

-- DROP derived index table.
DROP TABLE IF EXISTS beat_reviews_index;
