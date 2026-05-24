-- Venue locations — multi-branch chains for Сеть/Enterprise venues.
--
-- A "location" is a physical point of presence (filial / branch).
-- The default venue_profiles.address fields describe ONE location;
-- сетевые заведения (Шоколадница, Кофемания, Тануки) have десятки
-- точек под единым аккаунтом. This table lets one account own
-- multiple physical addresses, each with its own city / timezone /
-- contact / capacity.
--
-- Gating: `VENUE_PLAN_LIMITS[plan].multiLocation` is a boolean.
-- free/start/business = false → only the auto-seeded primary
-- location (mirrors venue_profiles.address). network/enterprise
-- = true → unlimited additional locations.
--
-- The primary location (`is_primary = TRUE`) is auto-seeded from
-- venue_profiles on first GET so legacy single-location venues
-- still see a well-formed list. Exactly one primary per venue —
-- enforced by a partial unique index.
--
-- Idempotent. Safe to re-run.
--
-- MANUAL DEPLOY:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/016_venue_locations.sql

BEGIN;

CREATE TABLE IF NOT EXISTS venue_locations (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT         NOT NULL,                       -- account owner (FK semantics to venue_profiles.user_id)
  venue_id        TEXT         NOT NULL,                       -- venue_profiles.id snapshot
  name            TEXT         NOT NULL,                       -- "Тверская 1", "ТЦ Авиапарк, 3 этаж"
  address         TEXT,                                          -- full street address
  city            TEXT,
  country         TEXT         NOT NULL DEFAULT 'Россия',
  timezone        TEXT         NOT NULL DEFAULT 'Europe/Moscow',-- IANA tz; used by scheduling per-location
  contact_phone   TEXT,
  contact_email   TEXT,
  capacity        INTEGER,                                       -- approximate seating
  is_primary      BOOLEAN      NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order      INTEGER      NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_venue_locations_user_id
  ON venue_locations (user_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_venue_locations_venue_id
  ON venue_locations (venue_id);

-- Exactly one primary location per venue. Allows zero (during seed)
-- but prevents two rows with is_primary=TRUE for the same venue_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_locations_one_primary
  ON venue_locations (venue_id)
  WHERE is_primary = TRUE;

COMMIT;
