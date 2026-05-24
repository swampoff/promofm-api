-- Stream-player state snapshot — one row per venue (or per
-- venue+zone for multi-zone setups).
--
-- Written by the cron tick that polls "what should be playing now"
-- and recorded for both observability ("is the music actually
-- changing?") and as the source of truth a future ffmpeg playout
-- worker will read to decide which file to stream next.
--
-- The PK is (venue_id, zone_id) with NULL zone_id meaning «whole
-- venue» / fallback row. Postgres treats NULLs as distinct values
-- in unique constraints by default, so the pattern requires a
-- coalesce-on-write OR we use partial unique indexes — we go with
-- partial indexes for clarity.
--
-- This is a STATE table, not an event log. `last_change_at`
-- captures when the resolved playlist last flipped; useful for
-- "still playing X since N minutes ago" UIs. For a full history,
-- a later iteration can write append-only `stream_player_history`
-- rows on every change.
--
-- Idempotent. Safe to re-run.
--
-- MANUAL DEPLOY:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/020_stream_player_state.sql

BEGIN;

CREATE TABLE IF NOT EXISTS stream_player_state (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id              TEXT         NOT NULL,
  user_id               TEXT         NOT NULL,                         -- audit / RLS pivot
  zone_id               TEXT,                                            -- NULL = venue-wide fallback
  current_schedule_id   TEXT,                                            -- references venue_schedules.id::text
  current_playlist_id   TEXT,                                            -- references venue_playlists data items
  status                TEXT         NOT NULL DEFAULT 'idle',           -- 'idle' | 'playing' | 'error'
  error_text            TEXT,                                            -- populated when status='error'
  last_tick_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),             -- bumped every cron tick (proves liveness)
  last_change_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),             -- only updated when playlist_id changes
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT stream_player_state_status_chk
    CHECK (status IN ('idle', 'playing', 'error'))
);

-- Exactly one row per (venue, zone) — partial indexes because
-- NULLs are distinct under a normal UNIQUE constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stream_player_state_venue_zone
  ON stream_player_state (venue_id, zone_id)
  WHERE zone_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stream_player_state_venue_default
  ON stream_player_state (venue_id)
  WHERE zone_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_stream_player_state_last_tick
  ON stream_player_state (last_tick_at DESC);

COMMIT;
