-- Migration 076 — chart_sources: kill data jsonb, promote metadata cols.
--
-- Context:
--   chart_sources — кэш агрегированных чартов от 4+ source'ов (Русское
--   Радио, Наше Радио, Яндекс.Музыка, Shazam + intl:apple:<country>).
--   1 row per source ID. ~28 call sites across:
--     charts-routes.tsx — основной writer (cron-driven re-aggregation)
--     landing-data-routes.tsx — getAll для weekly TOP-20 aggregation
--     content-health-routes.tsx — get(cfg.id) для freshness check
--     seo-routes.tsx — direct pool.query (уже native)
--
-- Shape:
--   id            TEXT     -- 'russkoe' / 'nashe' / 'yandex' / 'shazam' / 'intl:apple:US'
--   sourceName    TEXT     -- display
--   sourceUrl     TEXT     -- source URL
--   logo          TEXT     -- emoji
--   type          TEXT     -- 'radio' | 'streaming'
--   gradient      TEXT     -- UI styling
--   borderColor   TEXT     -- UI styling
--   tracks        JSONB    -- array of ChartTrackEntry — LEGIT polymorphic
--                             (per-parser shape varies); keep as jsonb per
--                             CLAUDE.md «extra JSONB DEFAULT '{}' — legit nested data».
--   fetchedAt     TIMESTAMPTZ
--   parsedBy      TEXT     -- 'mistral' | 'fallback' | 'html_parser' | 'json_api'
--   error         TEXT     -- optional last error
--
-- Companion code: db.tsx (typed funcs), charts-routes (25 sites),
-- landing-data-routes (1), content-health-routes (1).
--
-- Idempotent.

-- ── 1. Native cols
ALTER TABLE chart_sources
  ADD COLUMN IF NOT EXISTS source_name  TEXT,
  ADD COLUMN IF NOT EXISTS source_url   TEXT,
  ADD COLUMN IF NOT EXISTS logo         TEXT,
  ADD COLUMN IF NOT EXISTS type         TEXT,
  ADD COLUMN IF NOT EXISTS gradient     TEXT,
  ADD COLUMN IF NOT EXISTS border_color TEXT,
  ADD COLUMN IF NOT EXISTS tracks       JSONB,
  ADD COLUMN IF NOT EXISTS fetched_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parsed_by    TEXT,
  ADD COLUMN IF NOT EXISTS error        TEXT;

-- ── 2. Backfill from data jsonb
UPDATE chart_sources SET
  source_name  = COALESCE(source_name,  data->>'sourceName'),
  source_url   = COALESCE(source_url,   data->>'sourceUrl'),
  logo         = COALESCE(logo,         data->>'logo'),
  type         = COALESCE(type,         data->>'type'),
  gradient     = COALESCE(gradient,     data->>'gradient'),
  border_color = COALESCE(border_color, data->>'borderColor'),
  tracks       = COALESCE(tracks,       data->'tracks'),
  fetched_at   = COALESCE(fetched_at,   NULLIF(data->>'fetchedAt','')::timestamptz),
  parsed_by    = COALESCE(parsed_by,    data->>'parsedBy'),
  error        = COALESCE(error,        data->>'error')
WHERE data IS NOT NULL;

-- ── 3. Tighten + defaults
ALTER TABLE chart_sources
  ALTER COLUMN tracks SET DEFAULT '[]'::jsonb;

UPDATE chart_sources SET
  tracks       = COALESCE(tracks,       '[]'::jsonb),
  type         = COALESCE(type,         'radio'),
  source_name  = COALESCE(source_name,  id),
  source_url   = COALESCE(source_url,   ''),
  fetched_at   = COALESCE(fetched_at,   COALESCE(updated_at, NOW()));

ALTER TABLE chart_sources
  ALTER COLUMN tracks      SET NOT NULL,
  ALTER COLUMN source_name SET NOT NULL,
  ALTER COLUMN source_url  SET NOT NULL,
  ALTER COLUMN type        SET NOT NULL,
  ALTER COLUMN fetched_at  SET NOT NULL;

-- ── 4. DROP COLUMN data
ALTER TABLE chart_sources DROP COLUMN IF EXISTS data;

-- ── 5. Indexes
--   type — filter «only radio» / «only streaming» listings.
--   fetched_at — staleness check (content-health, cron triggers).
CREATE INDEX IF NOT EXISTS idx_chart_sources_type
  ON chart_sources(type);
CREATE INDEX IF NOT EXISTS idx_chart_sources_fetched_recent
  ON chart_sources(fetched_at DESC);
