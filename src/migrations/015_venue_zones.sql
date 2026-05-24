-- Venue zones — multi-room music for Бизнес+ venues.
--
-- A "zone" is a physical area of a venue with its own audio output
-- (бар, ресторан, лаунж, веранда). The stream-server treats each
-- zone as a separate broadcaster — the venue cabinet sets a
-- `current_playlist_id` per zone (and optionally schedules per zone
-- in a follow-up PR that links venue_schedules.zone_id).
--
-- Quota: `VENUE_PLAN_LIMITS[plan].zones` caps the row count per
-- venue. free/start = 1, business = 4, network/enterprise = unlimited.
-- Enforcement lives in src/venue-zones-routes.tsx — POST hits 403
-- with quotaExceeded(...) when current >= limit.
--
-- Every venue gets a default 'Основная зона' lazily on first GET
-- /zones — see venue-zones-routes.tsx. We do NOT pre-seed here
-- because the seed needs a venue_profiles row to anchor to.
--
-- Idempotent. Safe to re-run.
--
-- MANUAL DEPLOY:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/015_venue_zones.sql

BEGIN;

CREATE TABLE IF NOT EXISTS venue_zones (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT         NOT NULL,                       -- venue owner (FK semantics to venue_profiles.user_id)
  venue_id              TEXT         NOT NULL,                       -- venue_profiles.id snapshot
  name                  TEXT         NOT NULL,                       -- "Основная зона", "Веранда", "VIP-комната"
  description           TEXT,                                          -- optional
  current_playlist_id   TEXT,                                          -- references items inside venue_playlists.data jsonb (no FK — jsonb store)
  is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order            INTEGER      NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_venue_zones_user_id
  ON venue_zones (user_id);

CREATE INDEX IF NOT EXISTS idx_venue_zones_venue_id
  ON venue_zones (venue_id, sort_order);

COMMIT;
