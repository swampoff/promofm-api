-- Venue custom branding — colors / logo / player chrome for Бизнес+ venues.
--
-- One row per venue. The venue radio player (and any embedded
-- widget) reads this to override its default palette / logo /
-- copy. Defaults applied client-side if the row is absent.
--
-- Schema notes:
--   - Hex colors stored as TEXT with a strict CHECK to keep
--     #RRGGBB / #RGB only. Validated again on write because CHECK
--     constraints don't get a friendly error message in Hono.
--   - logo_url / favicon_url stored as TEXT (URLs). When we add
--     file uploads later, the upload endpoint will write the
--     resulting public URL here — no schema change needed.
--   - hide_promo_credit toggles the "Powered by promo-music.ru"
--     label in the player. Free tiers cannot disable it (gating
--     in venue-branding-routes.tsx).
--   - custom_css is reserved for a future iteration that needs
--     CSS sanitisation. NOT exposed in the initial PR — kept as
--     a column so we don't need a migration later.
--
-- Gating: `VENUE_PLAN_LIMITS[plan].customBranding` boolean.
-- business/network/enterprise = true; free/start = false.
--
-- Numbered 018 because 017_venue_api_tokens.sql (API access PR)
-- is queued in parallel.
--
-- Idempotent. Safe to re-run.
--
-- MANUAL DEPLOY:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/018_venue_branding.sql

BEGIN;

CREATE TABLE IF NOT EXISTS venue_branding (
  venue_id            TEXT         PRIMARY KEY,                  -- venue_profiles.id (one row per venue)
  user_id             TEXT         NOT NULL,                       -- account owner (FK semantics to venue_profiles.user_id)
  primary_color       TEXT         NOT NULL DEFAULT '#6366f1',     -- buttons, accents
  accent_color        TEXT         NOT NULL DEFAULT '#a855f7',     -- secondary highlights
  background_color    TEXT         NOT NULL DEFAULT '#0a0a14',     -- player background
  text_color          TEXT         NOT NULL DEFAULT '#ffffff',     -- foreground / labels
  logo_url            TEXT,                                          -- displayed in the player header
  favicon_url         TEXT,                                          -- for embed iframe page
  player_title        TEXT,                                          -- override e.g. "Радио Шоколадницы"
  player_subtitle     TEXT,                                          -- subhead under the title
  hide_promo_credit   BOOLEAN      NOT NULL DEFAULT FALSE,         -- toggle "Powered by promo-music.ru"
  custom_css          TEXT,                                          -- reserved for v2 (sanitised CSS overrides)
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Hex color sanity: matches #RGB or #RRGGBB, case-insensitive.
  CONSTRAINT venue_branding_primary_hex    CHECK (primary_color    ~* '^#[0-9a-f]{3}([0-9a-f]{3})?$'),
  CONSTRAINT venue_branding_accent_hex     CHECK (accent_color     ~* '^#[0-9a-f]{3}([0-9a-f]{3})?$'),
  CONSTRAINT venue_branding_background_hex CHECK (background_color ~* '^#[0-9a-f]{3}([0-9a-f]{3})?$'),
  CONSTRAINT venue_branding_text_hex       CHECK (text_color       ~* '^#[0-9a-f]{3}([0-9a-f]{3})?$')
);

CREATE INDEX IF NOT EXISTS idx_venue_branding_user_id
  ON venue_branding (user_id);

COMMIT;
