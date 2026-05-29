-- Migration 085 — chart_aggregation: singleton cache, promote to native cols.
--
-- Context:
--   chart_aggregation — singleton (key='last') хранит status последнего chart
--   aggregation run. Fields: timestamp, sourcesProcessed, totalTracks, results.
--
--   3 callers (1 read content-health, 2 writes charts-routes).
--
-- Native design:
--   key TEXT PK + timestamp TIMESTAMPTZ + sources_processed INT + total_tracks INT
--   + results JSONB (legit polymorphic — per-source shape varies: yandex/shazam/etc).
--
-- Bonus race fix:
--   Concurrent aggregation runs могут писать в один и тот же 'last' row.
--   Native UPSERT с ON CONFLICT — atomic.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS chart_aggregation (
  key TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chart_aggregation
  ADD COLUMN IF NOT EXISTS timestamp          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sources_processed  INTEGER,
  ADD COLUMN IF NOT EXISTS total_tracks       INTEGER,
  ADD COLUMN IF NOT EXISTS results            JSONB;

-- Backfill из data jsonb (camelCase → snake_case).
UPDATE chart_aggregation SET
  timestamp         = COALESCE(timestamp, NULLIF(data->>'timestamp', '')::timestamptz),
  sources_processed = COALESCE(sources_processed, NULLIF(data->>'sourcesProcessed', '')::int, 0),
  total_tracks      = COALESCE(total_tracks, NULLIF(data->>'totalTracks', '')::int, 0),
  results           = COALESCE(results,
                               CASE WHEN jsonb_typeof(data->'results') = 'array'
                                    THEN data->'results' ELSE '[]'::jsonb END)
WHERE data IS NOT NULL;

ALTER TABLE chart_aggregation
  ALTER COLUMN sources_processed SET DEFAULT 0,
  ALTER COLUMN total_tracks      SET DEFAULT 0,
  ALTER COLUMN results           SET DEFAULT '[]'::jsonb;

UPDATE chart_aggregation SET
  sources_processed = COALESCE(sources_processed, 0),
  total_tracks      = COALESCE(total_tracks, 0),
  results           = COALESCE(results, '[]'::jsonb);

ALTER TABLE chart_aggregation
  ALTER COLUMN sources_processed SET NOT NULL,
  ALTER COLUMN total_tracks      SET NOT NULL,
  ALTER COLUMN results           SET NOT NULL;

ALTER TABLE chart_aggregation DROP COLUMN IF EXISTS data;
