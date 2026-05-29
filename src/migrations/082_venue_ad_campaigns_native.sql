-- Migration 082 — venue_ad_campaigns: kill jsonb-array per venue.
--
-- Context:
--   venue_ad_campaigns хранится как 1 row per venue_id с jsonb array внутри
--   (`data` = array of campaign objects). 9 callers — все в venue-routes.tsx
--   + checkout-routes.tsx.
--
-- Native design:
--   row-per-campaign (id PK). venue_id NOT NULL (FK semantic). 17 native cols.
--   time_slots JSONB (legit nested — varying slot shape) + extra JSONB.
--
-- Bugs обнаруженные аудитом (фиксим попутно):
--   1. checkout-routes.tsx:413 делает `set(campaign.id, campaign)` — пишет
--      ROW с venue_id=campaign.id (PK старой таблицы = venue_id). Read'ы в
--      venue-routes делают `get(profile.id)` — campaign никогда не найдётся.
--      Native row-per-campaign убирает эту неконсистентность.
--   2. POST /radio-campaigns (venue-routes:800-803): get array → push → set
--      array. 2 concurrent POST'а одного venue теряют один campaign
--      (classic lost-update). Native INSERT — atomic, no race.
--   3. PUT /radio-campaigns/:id (venue-routes:880-888): get array → find+
--      mutate → set whole array. Native UPDATE WHERE id = $1 — atomic.
--
-- Idempotent: re-run safe через CREATE TABLE IF NOT EXISTS + ON CONFLICT.

-- Step 1: Snapshot legacy data перед изменением shape (DROP COLUMN data).
-- Применяется только если main table все ещё old shape (data column есть).
CREATE TEMP TABLE _vac_backup ON COMMIT DROP AS
  SELECT venue_id, data, created_at
    FROM venue_ad_campaigns
   WHERE 1=0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'venue_ad_campaigns' AND column_name = 'data'
  ) THEN
    INSERT INTO _vac_backup
      SELECT venue_id, data, created_at FROM venue_ad_campaigns;
  END IF;
END $$;

-- Step 2: Drop old PK + truncate (only if data column still present —
-- значит ещё не мигрировано). Idempotent: после миграции этот блок no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'venue_ad_campaigns' AND column_name = 'data'
  ) THEN
    -- RLS policies (если есть — снять до DROP COLUMN data).
    EXECUTE 'DROP POLICY IF EXISTS venue_ad_campaigns_admin_all ON venue_ad_campaigns';
    EXECUTE 'DROP POLICY IF EXISTS venue_ad_campaigns_select_own ON venue_ad_campaigns';
    EXECUTE 'DROP POLICY IF EXISTS venue_ad_campaigns_owner ON venue_ad_campaigns';
    EXECUTE 'DROP POLICY IF EXISTS vac_admin_all ON venue_ad_campaigns';
    EXECUTE 'DROP POLICY IF EXISTS vac_owner_all ON venue_ad_campaigns';

    EXECUTE 'ALTER TABLE venue_ad_campaigns DROP CONSTRAINT IF EXISTS venue_ad_campaigns_pkey';
    EXECUTE 'TRUNCATE venue_ad_campaigns';
  END IF;
END $$;

-- Step 3: ensure table exists (in case it didn't on prod — store was lazy-init).
CREATE TABLE IF NOT EXISTS venue_ad_campaigns (
  id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Step 4: ADD native columns idempotently.
ALTER TABLE venue_ad_campaigns
  ADD COLUMN IF NOT EXISTS id              TEXT,
  ADD COLUMN IF NOT EXISTS venue_id        TEXT,
  ADD COLUMN IF NOT EXISTS station_id      TEXT,
  ADD COLUMN IF NOT EXISTS station_name    TEXT,
  ADD COLUMN IF NOT EXISTS advertiser_id   TEXT,
  ADD COLUMN IF NOT EXISTS package_type    TEXT,
  ADD COLUMN IF NOT EXISTS status          TEXT,
  ADD COLUMN IF NOT EXISTS audio_url       TEXT,
  ADD COLUMN IF NOT EXISTS start_date      TEXT,
  ADD COLUMN IF NOT EXISTS end_date        TEXT,
  ADD COLUMN IF NOT EXISTS target_plays    INTEGER,
  ADD COLUMN IF NOT EXISTS total_plays     INTEGER,
  ADD COLUMN IF NOT EXISTS budget          NUMERIC,
  ADD COLUMN IF NOT EXISTS spent           NUMERIC,
  ADD COLUMN IF NOT EXISTS impressions     INTEGER,
  ADD COLUMN IF NOT EXISTS ctr             NUMERIC,
  ADD COLUMN IF NOT EXISTS time_slots      JSONB,
  ADD COLUMN IF NOT EXISTS extra           JSONB;

-- Step 5: Backfill из _vac_backup через jsonb_array_elements.
-- Только если backup непустой (миграция от старого shape).
INSERT INTO venue_ad_campaigns (
  id, venue_id, station_id, station_name, advertiser_id,
  package_type, status, audio_url, start_date, end_date,
  target_plays, total_plays, budget, spent, impressions, ctr,
  time_slots, extra, created_at, updated_at
)
SELECT DISTINCT ON (COALESCE(NULLIF(elem->>'id', ''), 'camp-legacy-' || md5(elem::text || b.venue_id)))
  COALESCE(NULLIF(elem->>'id', ''), 'camp-legacy-' || md5(elem::text || b.venue_id)),
  b.venue_id,
  NULLIF(elem->>'stationId', ''),
  NULLIF(elem->>'stationName', ''),
  NULLIF(elem->>'advertiserId', ''),
  NULLIF(elem->>'packageType', ''),
  COALESCE(NULLIF(elem->>'status', ''), 'pending'),
  NULLIF(elem->>'audioUrl', ''),
  NULLIF(elem->>'startDate', ''),
  NULLIF(elem->>'endDate', ''),
  COALESCE(NULLIF(elem->>'targetPlays', '')::int, 0),
  COALESCE(NULLIF(elem->>'totalPlays', '')::int, 0),
  COALESCE(NULLIF(elem->>'budget', '')::numeric, 0),
  COALESCE(NULLIF(elem->>'spent', '')::numeric, 0),
  COALESCE(NULLIF(elem->>'impressions', '')::int, 0),
  COALESCE(NULLIF(elem->>'ctr', '')::numeric, 0),
  COALESCE(elem->'timeSlots', '[]'::jsonb),
  '{}'::jsonb,
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz,
           NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW())
FROM _vac_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data) = 'array' THEN b.data
            WHEN jsonb_typeof(b.data) = 'object' THEN jsonb_build_array(b.data)
            ELSE '[]'::jsonb END
     ) elem
;  -- ON CONFLICT removed: TRUNCATE'd before INSERT, no conflicts; PK not yet added

-- Step 6: Defaults + NOT NULL + PK.
UPDATE venue_ad_campaigns SET
  status      = COALESCE(status, 'pending'),
  target_plays = COALESCE(target_plays, 0),
  total_plays  = COALESCE(total_plays, 0),
  budget       = COALESCE(budget, 0),
  spent        = COALESCE(spent, 0),
  impressions  = COALESCE(impressions, 0),
  ctr          = COALESCE(ctr, 0),
  time_slots   = COALESCE(time_slots, '[]'::jsonb),
  extra        = COALESCE(extra, '{}'::jsonb);

DELETE FROM venue_ad_campaigns WHERE id IS NULL OR venue_id IS NULL;

ALTER TABLE venue_ad_campaigns
  ALTER COLUMN id          SET NOT NULL,
  ALTER COLUMN venue_id    SET NOT NULL,
  ALTER COLUMN status      SET NOT NULL,
  ALTER COLUMN status      SET DEFAULT 'pending',
  ALTER COLUMN target_plays SET DEFAULT 0,
  ALTER COLUMN total_plays  SET DEFAULT 0,
  ALTER COLUMN budget       SET DEFAULT 0,
  ALTER COLUMN spent        SET DEFAULT 0,
  ALTER COLUMN impressions  SET DEFAULT 0,
  ALTER COLUMN ctr          SET DEFAULT 0,
  ALTER COLUMN time_slots   SET DEFAULT '[]'::jsonb,
  ALTER COLUMN extra        SET DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'venue_ad_campaigns_pkey'
  ) THEN
    ALTER TABLE venue_ad_campaigns ADD PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE venue_ad_campaigns DROP COLUMN IF EXISTS data;

-- Step 7: Indexes.
CREATE INDEX IF NOT EXISTS idx_vac_venue_created
  ON venue_ad_campaigns(venue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vac_station_status
  ON venue_ad_campaigns(station_id, status) WHERE station_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vac_status_active
  ON venue_ad_campaigns(status) WHERE status IN ('pending', 'active');
