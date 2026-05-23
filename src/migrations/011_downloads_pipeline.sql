-- 011_downloads_pipeline.sql
--
-- Track downloads pipeline + admin verification for radio/venue
-- ────────────────────────────────────────────────────────────────
--
-- 1. is_verified BOOLEAN on radio_profiles + venue_profiles
--    «approve-user» (users.status='active') means the account can
--    log in. is_verified is a SEPARATE second-level gate that means
--    «admin has reviewed this radio/venue and trusts it enough to
--    download tracks for broadcast / in-venue play». Defaults to
--    FALSE; admin flips it via POST /admin/verify-profile.
--    Existing rows get seeded to TRUE if the underlying user is
--    already active — they were trusted under the old, looser model;
--    forcing every existing radio/venue back to false would break
--    production access overnight.
--
-- 2. city TEXT column on track_downloads_by_radio (existing table)
--    Captured at INSERT time from radio_profiles.data->>'city' so
--    analytics reflect WHERE the station was when it downloaded the
--    track, not where it is now. Historical accuracy.
--
-- 3. track_downloads_by_venue NEW table — same shape as the radio
--    version, parallel pipeline for venue downloads.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS).
-- Safe to re-run.

BEGIN;

-- ── 1. is_verified on radio_profiles ─────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'radio_profiles') THEN
    ALTER TABLE radio_profiles
      ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false;

    -- Seed: existing radios that already have active users carry
    -- their de-facto verified state forward. Newly-registered
    -- radios after this migration start at false and need an
    -- explicit admin flip.
    UPDATE radio_profiles rp
       SET is_verified = true
      FROM users u
     WHERE u.id::text = rp.user_id
       AND u.status::text = 'active'
       AND rp.is_verified = false;

    CREATE INDEX IF NOT EXISTS idx_radio_profiles_is_verified
      ON radio_profiles(is_verified) WHERE is_verified = true;
  END IF;
END $$;

-- ── 2. is_verified on venue_profiles ─────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'venue_profiles') THEN
    ALTER TABLE venue_profiles
      ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false;

    UPDATE venue_profiles vp
       SET is_verified = true
      FROM users u
     WHERE u.id::text = vp.user_id
       AND u.status::text = 'active'
       AND vp.is_verified = false;

    CREATE INDEX IF NOT EXISTS idx_venue_profiles_is_verified
      ON venue_profiles(is_verified) WHERE is_verified = true;
  END IF;
END $$;

-- ── 3. city column on existing track_downloads_by_radio ──────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'track_downloads_by_radio') THEN
    ALTER TABLE track_downloads_by_radio
      ADD COLUMN IF NOT EXISTS city TEXT;

    -- Backfill: city was never captured before. Existing rows stay
    -- NULL; analytics groups them under '(не указан)' so they're
    -- visible without distorting per-city counts.

    CREATE INDEX IF NOT EXISTS idx_track_downloads_by_radio_city
      ON track_downloads_by_radio(city) WHERE city IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_track_downloads_by_radio_track_id
      ON track_downloads_by_radio(track_id);
  END IF;
END $$;

-- ── 4. NEW track_downloads_by_venue ─────────────────────────────
CREATE TABLE IF NOT EXISTS track_downloads_by_venue (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT        NOT NULL,           -- venue_profiles.user_id
  venue_name   TEXT,                            -- snapshot of venue at download time
  city         TEXT,                            -- snapshot from venue_profiles.data->>'city'
  track_id     UUID        NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  ip_addr      TEXT,
  user_agent   TEXT,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_track_downloads_by_venue_track_id
  ON track_downloads_by_venue(track_id);

CREATE INDEX IF NOT EXISTS idx_track_downloads_by_venue_user_id
  ON track_downloads_by_venue(user_id);

CREATE INDEX IF NOT EXISTS idx_track_downloads_by_venue_city
  ON track_downloads_by_venue(city) WHERE city IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_track_downloads_by_venue_downloaded_at
  ON track_downloads_by_venue(downloaded_at DESC);

COMMIT;
