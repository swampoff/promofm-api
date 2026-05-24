-- Venue station — dedicated AI radio for a venue (the «promo.fm-style»
-- per-venue stream with Gemini hosts, jingles, and a custom theme).
--
-- TWO tables, both created here in one migration because they're
-- created/managed as a logical unit:
--
--   `venue_station_requests` — the venue's onboarding submission
--     (music preferences, jingles, AI host config). Goes through an
--     admin queue who curates the actual radio config + provisions
--     the Go-service / Icecast mount on the VPS infrastructure.
--
--   `venue_station_streams` — the provisioned stream itself (Icecast
--     URL, Bearer token, pairing-code for the Android APK to claim).
--     One row per (venue, location). Multi-location chains (Сеть+)
--     get one stream per location.
--
-- Lifecycle:
--   request:  pending_admin → in_setup → provisioned → live
--                                     ↓
--                            rejected / changes_requested
--
--   stream:   in_setup → provisioned → live → paused → dead
--
-- The pairing flow: admin marks request 'provisioned' → backend
-- inserts a stream row with a fresh 6-digit code. Venue sees the
-- code in their cabinet, enters it once into the Android APK on
-- the in-venue device → APK POST /venue-station/pair {code} →
-- gets back stream_url + bearer token (with venue-public scopes)
-- → starts playing. Code is single-use, 24h TTL.
--
-- Soft refs to venue_profiles, venue_locations, venue_api_tokens —
-- no hard FKs (those tables have text PKs / different cascades).
--
-- Idempotent. Safe to re-run.
--
-- MANUAL DEPLOY:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/021_venue_station.sql

BEGIN;

-- ── venue_station_requests ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS venue_station_requests (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT         NOT NULL,                       -- account owner
  venue_id            TEXT         NOT NULL,                       -- venue_profiles.id snapshot
  -- Onboarding wizard step 2: music preferences (genres, BPM range,
  -- vibe, languages, exclusions). Free-form jsonb so we can extend
  -- without a schema change.
  music_preferences   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Step 3: jingles + advert config. Shape:
  --   { uploads: [{ url, name, durationSec }], frequencyMinutes: 60,
  --     peakHours: [12, 13, 18, 19], adverts: [{ text, voice }] }
  jingles             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Step 4: AI host (Gemini) config.
  --   { voice: 'female', style: 'casual', topics: ['weather','events'],
  --     intervalMinutes: 20 }
  ai_host_config      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Lifecycle
  status              TEXT         NOT NULL DEFAULT 'pending_admin',
  assigned_admin_id   TEXT,                                          -- users.id of admin who took it
  admin_notes         TEXT,                                          -- internal
  rejected_reason     TEXT,                                          -- shown to venue if rejected
  changes_requested   TEXT,                                          -- shown to venue if changes_requested
  -- Timestamps
  submitted_at        TIMESTAMPTZ,                                   -- when user clicked Submit
  taken_at            TIMESTAMPTZ,                                   -- when an admin took it
  provisioned_at      TIMESTAMPTZ,                                   -- when admin marked provisioned
  live_at             TIMESTAMPTZ,                                   -- first time stream went live
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT venue_station_requests_status_chk
    CHECK (status IN ('draft', 'pending_admin', 'in_setup', 'provisioned',
                      'live', 'paused', 'rejected', 'changes_requested'))
);

-- One open request per venue at a time — keeps the admin queue
-- predictable. Closed states ('rejected') don't count.
CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_station_requests_one_open
  ON venue_station_requests (venue_id)
  WHERE status NOT IN ('rejected');

CREATE INDEX IF NOT EXISTS idx_venue_station_requests_user_id
  ON venue_station_requests (user_id);

CREATE INDEX IF NOT EXISTS idx_venue_station_requests_status
  ON venue_station_requests (status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_station_requests_admin
  ON venue_station_requests (assigned_admin_id)
  WHERE assigned_admin_id IS NOT NULL;


-- ── venue_station_streams ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS venue_station_streams (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id            UUID,                                        -- → venue_station_requests.id (soft ref)
  user_id               TEXT         NOT NULL,
  venue_id              TEXT         NOT NULL,
  location_id           TEXT,                                          -- → venue_locations.id (soft ref; NULL = single-location venue)
  stream_url            TEXT,                                          -- icecast/HLS URL the APK plays
  vps_host              TEXT,                                          -- infra audit (which VPS hosts the Go-service)
  bearer_token_id       UUID,                                          -- → venue_api_tokens.id (soft ref)
  -- Pairing flow: admin generates code → venue shows it in cabinet
  -- → APK POSTs /pair {code} → backend returns stream_url + bearer.
  pairing_code          TEXT         UNIQUE,                          -- 6 chars (3-3 dash-separated, A-Z0-9 excluding ambiguous chars)
  pairing_expires_at    TIMESTAMPTZ,                                  -- typically created_at + 24h
  paired_at             TIMESTAMPTZ,                                  -- when APK first paired
  paired_device_info    JSONB,                                          -- { model, androidVer, appVer }
  -- Stream lifecycle
  status                TEXT         NOT NULL DEFAULT 'in_setup',
  -- Gemini host config copied from the request at provision time
  -- (so retro changes to the request don't auto-mutate live streams).
  gemini_config         JSONB,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ,                                  -- last heartbeat from APK or stream-server
  CONSTRAINT venue_station_streams_status_chk
    CHECK (status IN ('in_setup', 'provisioned', 'live', 'paused', 'dead'))
);

CREATE INDEX IF NOT EXISTS idx_venue_station_streams_user_id
  ON venue_station_streams (user_id, status);

CREATE INDEX IF NOT EXISTS idx_venue_station_streams_venue_id
  ON venue_station_streams (venue_id);

CREATE INDEX IF NOT EXISTS idx_venue_station_streams_request_id
  ON venue_station_streams (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_venue_station_streams_pairing
  ON venue_station_streams (pairing_code)
  WHERE pairing_code IS NOT NULL AND paired_at IS NULL;

COMMIT;
