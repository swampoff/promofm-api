-- Migration 077 — news_public: kill data jsonb, promote to native cols.
--
-- Context:
--   news_public — публичная лента новостей музыкальной индустрии.
--   ~14 callers across:
--     news-agent.tsx — pipeline writer (dedup + insert)
--     news-agent-routes.tsx — admin moderation
--     landing-data-routes.tsx — public list / detail / admin CRUD
--     sitemap-routes.tsx — getAll для sitemap.xml
--     content-health-routes.tsx — pipeline health monitoring
--
-- Shape (per handler write site):
--   id          TEXT     -- 'news-<source>-<id>' | 'news-manual-<uuid>'
--   title       TEXT
--   excerpt     TEXT
--   content     TEXT
--   category    TEXT     default 'industry'
--   tags        TEXT[]
--   source      TEXT     -- e.g. 'admin', 'tass-culture', ...
--   source_id   TEXT     -- internal source ID
--   source_url  TEXT     -- external URL
--   image_url   TEXT
--   author_name TEXT
--   author_avatar TEXT
--   published_at TIMESTAMPTZ
--   processed_at TIMESTAMPTZ -- when pipeline processed (for collectedToday)
--   status      TEXT     -- 'pending' | 'published' | 'rejected'
--   created_at  TIMESTAMPTZ
--
-- Companion code: db.tsx (5 typed funcs), 5 route files refactored.
-- Idempotent.

ALTER TABLE news_public
  ADD COLUMN IF NOT EXISTS title         TEXT,
  ADD COLUMN IF NOT EXISTS excerpt       TEXT,
  ADD COLUMN IF NOT EXISTS content       TEXT,
  ADD COLUMN IF NOT EXISTS category      TEXT,
  ADD COLUMN IF NOT EXISTS tags          TEXT[],
  ADD COLUMN IF NOT EXISTS source        TEXT,
  ADD COLUMN IF NOT EXISTS source_id     TEXT,
  ADD COLUMN IF NOT EXISTS source_url    TEXT,
  ADD COLUMN IF NOT EXISTS image_url     TEXT,
  ADD COLUMN IF NOT EXISTS author_name   TEXT,
  ADD COLUMN IF NOT EXISTS author_avatar TEXT,
  ADD COLUMN IF NOT EXISTS published_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status        TEXT;

UPDATE news_public SET
  title         = COALESCE(title,         data->>'title'),
  excerpt       = COALESCE(excerpt,       data->>'excerpt'),
  content       = COALESCE(content,       data->>'content'),
  category      = COALESCE(category,      data->>'category', 'industry'),
  source        = COALESCE(source,        data->>'source'),
  source_id     = COALESCE(source_id,     data->>'sourceId'),
  source_url    = COALESCE(source_url,    data->>'sourceUrl'),
  image_url     = COALESCE(image_url,     data->>'imageUrl'),
  author_name   = COALESCE(author_name,   data->>'authorName'),
  author_avatar = COALESCE(author_avatar, data->>'authorAvatar'),
  published_at  = COALESCE(published_at,  NULLIF(data->>'publishedAt','')::timestamptz),
  processed_at  = COALESCE(processed_at,  NULLIF(data->>'processedAt','')::timestamptz),
  status        = COALESCE(status,        data->>'status', 'published')
WHERE data IS NOT NULL;

UPDATE news_public SET
  tags = ARRAY(SELECT jsonb_array_elements_text(data->'tags'))
WHERE (tags IS NULL OR array_length(tags, 1) IS NULL)
  AND data ? 'tags' AND jsonb_typeof(data->'tags') = 'array';

DELETE FROM news_public WHERE title IS NULL;

ALTER TABLE news_public
  ALTER COLUMN title    SET NOT NULL,
  ALTER COLUMN excerpt  SET DEFAULT '',
  ALTER COLUMN content  SET DEFAULT '',
  ALTER COLUMN category SET DEFAULT 'industry',
  ALTER COLUMN tags     SET DEFAULT '{}'::TEXT[],
  ALTER COLUMN source   SET DEFAULT '',
  ALTER COLUMN status   SET DEFAULT 'published';

UPDATE news_public SET
  excerpt  = COALESCE(excerpt,  ''),
  content  = COALESCE(content,  ''),
  category = COALESCE(category, 'industry'),
  tags     = COALESCE(tags,     '{}'::TEXT[]),
  source   = COALESCE(source,   ''),
  status   = COALESCE(status,   'published'),
  published_at = COALESCE(published_at, COALESCE(created_at, NOW()));

ALTER TABLE news_public
  ALTER COLUMN excerpt      SET NOT NULL,
  ALTER COLUMN content      SET NOT NULL,
  ALTER COLUMN category     SET NOT NULL,
  ALTER COLUMN tags         SET NOT NULL,
  ALTER COLUMN source       SET NOT NULL,
  ALTER COLUMN published_at SET NOT NULL,
  ALTER COLUMN status       SET NOT NULL;

ALTER TABLE news_public DROP COLUMN IF EXISTS data;

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_news_public_published
  ON news_public(published_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_news_public_status_processed
  ON news_public(status, processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_public_source
  ON news_public(source);
