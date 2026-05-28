-- Promote 17 radio_profiles fields from `data` jsonb to native columns.
--
-- Part 2 of 3 in the cross-role silent-drop cleanup (see migration 059
-- for venue). Same root cause: upsertRadioProfile in db.tsx:1243 was
-- writing the entire PUT payload to `data jsonb` and never touching
-- native columns. Every consumer that joins on name / city / frequency
-- / stream_url etc. saw NULL on every newly-onboarded radio station.
--
-- Existing native columns (don't re-add):
--   email, is_email_verified, account_status, phone   (migration 008)
--   is_verified                                       (migration 011)
--   logo_url, cover_url                               (migration 026)
--
-- Fields that don't get native columns this PR:
--   tracksInRotation, partners, monthlyReach,
--   totalArtistRequests, totalAdSlots, revenue        — computed stats,
--                                                       written by
--                                                       radio_stats helpers
--   socials                                           — nested object,
--                                                       gets a dedicated
--                                                       JSONB column for
--                                                       query convenience
--   createdAt                                         — already covered
--                                                       by `created_at` /
--                                                       row metadata
--
-- Backfill is COALESCE-based so re-running the migration is safe —
-- native values already populated by the new writer code won't be
-- overwritten by stale jsonb.
--
-- Companion code: db.tsx upsertRadioProfile / getRadioProfile refactor.
-- Auto-fixes radio-profile-routes.tsx PUT (uses upsertRadioProfile via
-- saveToKv wrapper) and curator-agents.tsx:123 (also writes via
-- upsertRadioProfile).

ALTER TABLE radio_profiles
  ADD COLUMN IF NOT EXISTS name              TEXT,
  ADD COLUMN IF NOT EXISTS city              TEXT,
  ADD COLUMN IF NOT EXISTS country           TEXT,
  ADD COLUMN IF NOT EXISTS frequency         TEXT,
  ADD COLUMN IF NOT EXISTS description       TEXT,
  ADD COLUMN IF NOT EXISTS founded           TEXT,
  ADD COLUMN IF NOT EXISTS website           TEXT,
  ADD COLUMN IF NOT EXISTS address           TEXT,
  ADD COLUMN IF NOT EXISTS stream_url        TEXT,
  ADD COLUMN IF NOT EXISTS backup_stream_url TEXT,
  ADD COLUMN IF NOT EXISTS bitrate           TEXT,
  ADD COLUMN IF NOT EXISTS audio_format      TEXT,
  ADD COLUMN IF NOT EXISTS listeners         TEXT,
  ADD COLUMN IF NOT EXISTS status            TEXT,
  ADD COLUMN IF NOT EXISTS broadcast_cities  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS formats           TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS socials           JSONB  NOT NULL DEFAULT '{}'::jsonb;

-- ── Backfill scalar fields from jsonb ────────────────────────────
-- COALESCE keeps any value already in the native column (idempotent).
UPDATE radio_profiles SET
  name              = COALESCE(name,              data->>'name'),
  city              = COALESCE(city,              data->>'city'),
  country           = COALESCE(country,           data->>'country'),
  frequency         = COALESCE(frequency,         data->>'frequency'),
  description       = COALESCE(description,       data->>'description'),
  founded           = COALESCE(founded,           data->>'founded'),
  website           = COALESCE(website,           data->>'website'),
  address           = COALESCE(address,           data->>'address'),
  stream_url        = COALESCE(stream_url,        data->>'streamUrl'),
  backup_stream_url = COALESCE(backup_stream_url, data->>'backupStreamUrl'),
  bitrate           = COALESCE(bitrate,           data->>'bitrate'),
  audio_format      = COALESCE(audio_format,      data->>'audioFormat'),
  listeners         = COALESCE(listeners,         data->>'listeners'),
  status            = COALESCE(status,            data->>'status')
WHERE data IS NOT NULL;

-- ── Backfill arrays / nested objects ─────────────────────────────
-- Only when native is empty so re-running won't clobber later edits.
UPDATE radio_profiles SET
  broadcast_cities = ARRAY(SELECT jsonb_array_elements_text(data->'broadcast_cities'))
WHERE (broadcast_cities IS NULL OR array_length(broadcast_cities, 1) IS NULL)
  AND data ? 'broadcast_cities'
  AND jsonb_typeof(data->'broadcast_cities') = 'array';

UPDATE radio_profiles SET
  formats = ARRAY(SELECT jsonb_array_elements_text(data->'formats'))
WHERE (formats IS NULL OR array_length(formats, 1) IS NULL)
  AND data ? 'formats'
  AND jsonb_typeof(data->'formats') = 'array';

UPDATE radio_profiles SET
  socials = data->'socials'
WHERE socials = '{}'::jsonb
  AND data ? 'socials'
  AND jsonb_typeof(data->'socials') = 'object';

-- ── Indexes ──────────────────────────────────────────────────────
-- city/status are the two filter columns on the public /radio listing
-- and the partner discovery flow. Indexing pays off as soon as ~50
-- stations onboard.
CREATE INDEX IF NOT EXISTS idx_radio_profiles_city
  ON radio_profiles(city) WHERE city IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_radio_profiles_status
  ON radio_profiles(status) WHERE status IS NOT NULL;
