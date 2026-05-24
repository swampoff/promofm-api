-- Venue scheduling — weekly playlist rotation feature for Бизнес+ tiers.
--
-- A "schedule" is a recurring time-slot mapping (day_of_week, start_minute,
-- end_minute) → playlist_id, scoped to a single venue. The stream-server
-- (or future background player) polls GET /schedules/active-now once a
-- minute to decide which playlist to play right now.
--
-- Times are stored as minutes-since-midnight in venue-local time (INTEGER
-- 0..1440). Avoiding TIMETZ + tzname complexity until we add explicit
-- timezone-per-venue (rough plan: read tz from venue_profiles.data.timezone,
-- default Europe/Moscow). For 2026-Q1 we ship local-Moscow only.
--
-- Overlap policy: the player picks the schedule with the HIGHEST priority
-- (and lowest start_minute as tiebreaker). priority=0 is the default.
-- This lets a venue define a base 09:00-22:00 "morning chill" + a
-- 12:00-14:00 "lunch jazz" override at priority=10.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS. Safe to re-run.
--
-- MANUAL DEPLOY:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/014_venue_schedules.sql

BEGIN;

CREATE TABLE IF NOT EXISTS venue_schedules (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT         NOT NULL,                       -- venue owner (FK semantics to venue_profiles.user_id; not a hard FK because venue_profiles.user_id has no UNIQUE)
  venue_id      TEXT         NOT NULL,                       -- venue_profiles.id snapshot at create time
  name          TEXT         NOT NULL,                       -- "Утренний прохлад", "Обеденный джаз"…
  day_of_week   INTEGER      NOT NULL,                       -- 0=Monday … 6=Sunday (ISO-8601 weekday-1)
  start_minute  INTEGER      NOT NULL,                       -- 0..1439 inclusive
  end_minute    INTEGER      NOT NULL,                       -- 1..1440 inclusive (1440 = end-of-day exclusive)
  playlist_id   TEXT         NOT NULL,                       -- references venue_playlists items (stored in venue_playlists.data jsonb, no FK)
  priority      INTEGER      NOT NULL DEFAULT 0,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT venue_schedules_day_chk     CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT venue_schedules_start_chk   CHECK (start_minute BETWEEN 0 AND 1439),
  CONSTRAINT venue_schedules_end_chk     CHECK (end_minute BETWEEN 1 AND 1440),
  CONSTRAINT venue_schedules_range_chk   CHECK (end_minute > start_minute)
);

CREATE INDEX IF NOT EXISTS idx_venue_schedules_user_id
  ON venue_schedules (user_id);

CREATE INDEX IF NOT EXISTS idx_venue_schedules_venue_id
  ON venue_schedules (venue_id);

-- Hot path: stream-server polls "what should be playing for venue X right now"
-- by (venue_id, day_of_week, is_active) and filters in app on start/end.
CREATE INDEX IF NOT EXISTS idx_venue_schedules_active_lookup
  ON venue_schedules (venue_id, day_of_week, is_active)
  WHERE is_active = TRUE;

COMMIT;
