-- Promote 12 venue_profiles fields from `data` jsonb to native columns.
--
-- Mirrors migration 057 (artist_profiles) — same root cause:
-- upsertVenueProfile in db.tsx:1214 was writing the entire payload to
-- `data jsonb` and never touching native columns, so every consumer
-- that joins on venueName / city / venueType / capacity etc. saw
-- NULL on every newly-onboarded venue. Discovered 2026-05-28 during
-- the cross-role profile audit triggered by Гуськова's artist bug.
--
-- Fields that don't get native columns this PR:
--   socialLinks       — nested object, keep in JSONB (still added as a
--                       dedicated jsonb column for query convenience)
--   status            — stays in data jsonb (used by subscription state
--                       machine, churns more than profile data)
--   subscription*     — billing concern, separate PR
--   trial             — computed, not stored
--
-- Backfill is COALESCE-based so re-running the migration is safe —
-- native values already populated by the writer code won't be
-- overwritten by stale jsonb.
--
-- Companion code: db.tsx upsertVenueProfile / getVenueProfile refactor.

ALTER TABLE venue_profiles
  ADD COLUMN IF NOT EXISTS venue_name       TEXT,
  ADD COLUMN IF NOT EXISTS description      TEXT,
  ADD COLUMN IF NOT EXISTS venue_type       TEXT,
  ADD COLUMN IF NOT EXISTS address          TEXT,
  ADD COLUMN IF NOT EXISTS city             TEXT,
  ADD COLUMN IF NOT EXISTS country          TEXT,
  ADD COLUMN IF NOT EXISTS capacity         INTEGER,
  ADD COLUMN IF NOT EXISTS logo_url         TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url  TEXT,
  ADD COLUMN IF NOT EXISTS genres           TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS social_links     JSONB  NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS working_hours    TEXT;

-- ── Backfill scalar fields from jsonb ────────────────────────────
-- COALESCE keeps any value already in the native column (idempotent).
-- venueName has two legacy keys: 'venueName' (current) and 'name' (older).
-- venueType same: 'venueType' vs 'type'.
-- coverImageUrl same: 'coverImageUrl' vs 'coverUrl'.
UPDATE venue_profiles SET
  venue_name      = COALESCE(venue_name,      data->>'venueName',      data->>'name'),
  description     = COALESCE(description,     data->>'description'),
  venue_type      = COALESCE(venue_type,      data->>'venueType',      data->>'type'),
  address         = COALESCE(address,         data->>'address'),
  city            = COALESCE(city,            data->>'city'),
  country         = COALESCE(country,         data->>'country'),
  capacity        = COALESCE(capacity,        NULLIF(data->>'capacity', '')::int),
  logo_url        = COALESCE(logo_url,        data->>'logoUrl'),
  cover_image_url = COALESCE(cover_image_url, data->>'coverImageUrl', data->>'coverUrl'),
  working_hours   = COALESCE(working_hours,   data->>'workingHours')
WHERE data IS NOT NULL;

-- ── Backfill arrays / nested objects ─────────────────────────────
-- Only when native is empty (genres = empty array, social_links = empty obj)
-- so re-running won't clobber later edits.
UPDATE venue_profiles SET
  genres = ARRAY(SELECT jsonb_array_elements_text(data->'genres'))
WHERE (genres IS NULL OR array_length(genres, 1) IS NULL)
  AND data ? 'genres'
  AND jsonb_typeof(data->'genres') = 'array';

UPDATE venue_profiles SET
  social_links = data->'socialLinks'
WHERE social_links = '{}'::jsonb
  AND data ? 'socialLinks'
  AND jsonb_typeof(data->'socialLinks') = 'object';

-- ── Indexes ──────────────────────────────────────────────────────
-- city/venueType are the two filter columns on the public /venues
-- listing; indexing pays off as soon as 100+ venues onboard.
CREATE INDEX IF NOT EXISTS idx_venue_profiles_city
  ON venue_profiles(city) WHERE city IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_venue_profiles_venue_type
  ON venue_profiles(venue_type) WHERE venue_type IS NOT NULL;
