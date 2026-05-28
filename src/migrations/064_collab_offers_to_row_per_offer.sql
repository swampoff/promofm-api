-- 058_collab_offers_to_row_per_offer.sql
--
-- Artist cluster: collab_offers — kill dual-array-index anti-pattern.
--
-- Раньше: каждый offer хранился ДВАЖДЫ:
--   collab_offers_by_artist   (artist_id PK + data = массив offers артиста)
--   collab_offers_by_producer (producer_id PK + data = массив offers продюсера)
-- Любой update писал в оба места через атомарную транзакцию (workaround
-- предотвращал partial write но не основную проблему — O(N) get-modify-set
-- на каждый update, дублирование данных, невозможность индексов).
--
-- Теперь: row-per-offer таблица `collab_offers` с native cols. Single
-- source of truth. Indexes на artist_id и producer_id обеспечивают тот
-- же per-user listing.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d collab_offers_by_artist
--   \d collab_offers_by_producer
--   SELECT COUNT(*) artists_with_offers FROM collab_offers_by_artist;
--   SELECT SUM(jsonb_array_length(data))::int total_offers
--     FROM collab_offers_by_artist WHERE jsonb_typeof(data) = 'array';
--   -- Сверка: каждый offer должен быть в обоих сторах
--   WITH a AS (
--     SELECT artist_id, elem->>'id' AS oid
--       FROM collab_offers_by_artist, jsonb_array_elements(data) elem
--   ), p AS (
--     SELECT producer_id, elem->>'id' AS oid
--       FROM collab_offers_by_producer, jsonb_array_elements(data) elem
--   )
--   SELECT
--     (SELECT COUNT(DISTINCT oid) FROM a) artist_unique,
--     (SELECT COUNT(DISTINCT oid) FROM p) producer_unique,
--     (SELECT COUNT(*) FROM a a1 WHERE NOT EXISTS (SELECT 1 FROM p WHERE oid = a1.oid)) artist_only,
--     (SELECT COUNT(*) FROM p p1 WHERE NOT EXISTS (SELECT 1 FROM a WHERE oid = p1.oid)) producer_only;
--   SELECT polname FROM pg_policy
--    WHERE polrelid::regclass::text IN ('collab_offers_by_artist','collab_offers_by_producer');
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t collab_offers_by_artist -t collab_offers_by_producer promofm
--        > /tmp/collab_offers_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/058_collab_offers_to_row_per_offer.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- ─── Создаём новую row-per-offer таблицу ──────────────────────────────

-- Existing collab_offers table on prod has different schema (sender_id/recipient_id);
-- since 0 rows + 0 FK refs, safe to DROP. Cloud's CREATE TABLE recreates clean.
DROP TABLE IF EXISTS collab_offers CASCADE;

CREATE TABLE IF NOT EXISTS collab_offers (
  id                TEXT PRIMARY KEY,
  producer_id       TEXT          NOT NULL,
  producer_name     TEXT,
  producer_avatar   TEXT,
  artist_id         TEXT          NOT NULL,
  artist_name       TEXT,
  offer_type        TEXT          NOT NULL DEFAULT 'beat',
                                          -- 'beat'|'mixing'|'mastering'|'arrangement'|'ghost_production'|'collab_track'
  title             TEXT,
  description       TEXT          NOT NULL DEFAULT '',
  price             NUMERIC,
  currency          TEXT          NOT NULL DEFAULT 'RUB',
  audio_preview_url TEXT,
  bpm               INTEGER,
  music_key         TEXT,                  -- column 'key' зарезервировано в PG SQL syntax
  genre             TEXT,
  tags              JSONB         NOT NULL DEFAULT '[]'::jsonb,
  status            TEXT          NOT NULL DEFAULT 'pending',
                                          -- 'pending'|'accepted'|'declined'|'discussion'|'completed'|'cancelled'
  deadline          TIMESTAMPTZ,
  responded_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  artist_comment    TEXT,
  extra             JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─── Backfill из collab_offers_by_artist (там полный набор) ──────────

-- Bootstrap legacy tables если их ещё нет (на dev-окружениях).
CREATE TABLE IF NOT EXISTS collab_offers_by_artist (
  artist_id TEXT PRIMARY KEY,
  data JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS collab_offers_by_producer (
  producer_id TEXT PRIMARY KEY,
  data JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO collab_offers (
  id, producer_id, producer_name, producer_avatar,
  artist_id, artist_name,
  offer_type, title, description, price, currency, audio_preview_url,
  bpm, music_key, genre, tags, status, deadline,
  responded_at, completed_at, artist_comment, extra,
  created_at, updated_at
)
SELECT
  COALESCE(NULLIF(elem->>'id',''), gen_random_uuid()::text)         AS id,
  NULLIF(elem->>'producerId','')                                    AS producer_id,
  NULLIF(elem->>'producerName','')                                  AS producer_name,
  NULLIF(elem->>'producerAvatar','')                                AS producer_avatar,
  COALESCE(NULLIF(elem->>'artistId',''), t.artist_id)               AS artist_id,
  NULLIF(elem->>'artistName','')                                    AS artist_name,
  COALESCE(NULLIF(elem->>'type',''), 'beat')                        AS offer_type,
  NULLIF(elem->>'title','')                                         AS title,
  COALESCE(elem->>'description', '')                                AS description,
  NULLIF(elem->>'price','')::numeric                                AS price,
  COALESCE(NULLIF(elem->>'currency',''), 'RUB')                     AS currency,
  NULLIF(elem->>'audioPreviewUrl','')                               AS audio_preview_url,
  NULLIF(elem->>'bpm','')::integer                                  AS bpm,
  NULLIF(elem->>'key','')                                           AS music_key,
  NULLIF(elem->>'genre','')                                         AS genre,
  COALESCE(elem->'tags', '[]'::jsonb)                               AS tags,
  COALESCE(NULLIF(elem->>'status',''), 'pending')                   AS status,
  NULLIF(elem->>'deadline','')::timestamptz                         AS deadline,
  NULLIF(elem->>'respondedAt','')::timestamptz                      AS responded_at,
  NULLIF(elem->>'completedAt','')::timestamptz                      AS completed_at,
  NULLIF(elem->>'artistComment','')                                 AS artist_comment,
  (elem - 'id' - 'producerId' - 'producerName' - 'producerAvatar'
        - 'artistId' - 'artistName' - 'type' - 'title' - 'description'
        - 'price' - 'currency' - 'audioPreviewUrl' - 'bpm' - 'key' - 'genre'
        - 'tags' - 'status' - 'deadline' - 'respondedAt' - 'completedAt'
        - 'artistComment' - 'createdAt' - 'updatedAt')               AS extra,
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, NOW())       AS created_at,
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW())       AS updated_at
FROM collab_offers_by_artist t,
     jsonb_array_elements(COALESCE(t.data, '[]'::jsonb)) elem
WHERE jsonb_typeof(t.data) = 'array'
ON CONFLICT (id) DO NOTHING;

-- Подстраховка: оффер мог быть в producer-сторе но не в artist-сторе
-- (теоретически после сбоя partial-write). Берём оставшиеся.
INSERT INTO collab_offers (
  id, producer_id, producer_name, producer_avatar,
  artist_id, artist_name,
  offer_type, title, description, price, currency, audio_preview_url,
  bpm, music_key, genre, tags, status, deadline,
  responded_at, completed_at, artist_comment, extra,
  created_at, updated_at
)
SELECT
  COALESCE(NULLIF(elem->>'id',''), gen_random_uuid()::text),
  COALESCE(NULLIF(elem->>'producerId',''), t.producer_id),
  NULLIF(elem->>'producerName',''),
  NULLIF(elem->>'producerAvatar',''),
  NULLIF(elem->>'artistId',''),
  NULLIF(elem->>'artistName',''),
  COALESCE(NULLIF(elem->>'type',''), 'beat'),
  NULLIF(elem->>'title',''),
  COALESCE(elem->>'description', ''),
  NULLIF(elem->>'price','')::numeric,
  COALESCE(NULLIF(elem->>'currency',''), 'RUB'),
  NULLIF(elem->>'audioPreviewUrl',''),
  NULLIF(elem->>'bpm','')::integer,
  NULLIF(elem->>'key',''),
  NULLIF(elem->>'genre',''),
  COALESCE(elem->'tags', '[]'::jsonb),
  COALESCE(NULLIF(elem->>'status',''), 'pending'),
  NULLIF(elem->>'deadline','')::timestamptz,
  NULLIF(elem->>'respondedAt','')::timestamptz,
  NULLIF(elem->>'completedAt','')::timestamptz,
  NULLIF(elem->>'artistComment',''),
  (elem - 'id' - 'producerId' - 'producerName' - 'producerAvatar'
        - 'artistId' - 'artistName' - 'type' - 'title' - 'description'
        - 'price' - 'currency' - 'audioPreviewUrl' - 'bpm' - 'key' - 'genre'
        - 'tags' - 'status' - 'deadline' - 'respondedAt' - 'completedAt'
        - 'artistComment' - 'createdAt' - 'updatedAt'),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW())
FROM collab_offers_by_producer t,
     jsonb_array_elements(COALESCE(t.data, '[]'::jsonb)) elem
WHERE jsonb_typeof(t.data) = 'array'
ON CONFLICT (id) DO NOTHING;

-- ─── Indexes — same lookups via single SELECT ────────────────────────

CREATE INDEX IF NOT EXISTS idx_collab_offers_artist_created
  ON collab_offers(artist_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collab_offers_producer_created
  ON collab_offers(producer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collab_offers_open
  ON collab_offers(status, created_at DESC)
  WHERE status IN ('pending', 'discussion');

-- ─── DROP старые dual-index таблицы ──────────────────────────────────

DROP TABLE IF EXISTS collab_offers_by_artist;
DROP TABLE IF EXISTS collab_offers_by_producer;
