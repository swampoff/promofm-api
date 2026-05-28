-- 062_beat_favorites_row_per_favorite.sql
--
-- Artist cluster ч.5: beat_favorites — kill array-in-value, row-per-favorite.
--
-- Раньше: (user_id PK, data jsonb = array of beat_ids).
-- POST toggle: get array → modify → set (race window: 2 concurrent
-- toggles могут потерять друг друга).
--
-- Теперь: PK (user_id, beat_id) composite. INSERT ... ON CONFLICT DO NOTHING
-- + DELETE — atomic, no race.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t beat_favorites promofm > /tmp/favs_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/062_beat_favorites_row_per_favorite.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Bootstrap legacy if absent.
CREATE TABLE IF NOT EXISTS beat_favorites (
  user_id TEXT PRIMARY KEY,
  data JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Extract elements into temp backup.
CREATE TEMP TABLE _bf_backup ON COMMIT DROP AS
  SELECT
    user_id,
    elem::text AS beat_id
  FROM beat_favorites t,
       jsonb_array_elements_text(COALESCE(t.data, '[]'::jsonb)) elem
  WHERE jsonb_typeof(t.data) = 'array';

-- Drop legacy schema, recreate as row-per-favorite.
DROP TABLE beat_favorites CASCADE;

CREATE TABLE beat_favorites (
  user_id    TEXT          NOT NULL,
  beat_id    TEXT          NOT NULL,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, beat_id)
);

-- Index для user → favorites list (PK уже даёт это, но explicit для clarity).
-- Plus reverse index для beat → favoriters count.
CREATE INDEX IF NOT EXISTS idx_beat_favorites_beat
  ON beat_favorites(beat_id);

-- Backfill из temp. Дедупликация через ON CONFLICT DO NOTHING.
INSERT INTO beat_favorites (user_id, beat_id, created_at)
SELECT user_id, beat_id, NOW()
  FROM _bf_backup
 WHERE user_id IS NOT NULL AND beat_id IS NOT NULL
ON CONFLICT (user_id, beat_id) DO NOTHING;
