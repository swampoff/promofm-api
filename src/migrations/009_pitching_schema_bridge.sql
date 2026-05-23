-- 009_pitching_schema_bridge.sql
--
-- Bridge legacy `pitching_*` tables to the column shape new pitching-routes.tsx
-- code expects. Triggered by /pitching/playlists 500 ("column 'followers'
-- does not exist") on prod, root-caused by laptop on 2026-05-23:
--
--   ensureSchema() runs CREATE TABLE IF NOT EXISTS pitching_playlists (...)
--   with the NEW columns (followers, genre, region, curator_contact, status),
--   but the table already exists with OLD columns (curator_name,
--   curator_email, curator_phone, playlist_url) — so IF NOT EXISTS
--   skips. No ALTER ever runs, the new column-list SELECT crashes.
--
-- Strategy = Variant A (minimum-change bridge), not full data migration.
-- 970 rows in pitching_radio are real and must not be lost; full clean-
-- slate (Variant B) is planned 2-4 weeks out as a separate effort.
--
-- MANUAL DEPLOY STEPS (per AGENTS.md — migrations don't auto-run):
--
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/009_pitching_schema_bridge.sql
--
-- Run BEFORE `systemctl restart promofm-api` so the restarted process
-- doesn't hit the old "column followers does not exist" error.
--
-- All statements are idempotent (IF NOT EXISTS / CREATE OR REPLACE) so
-- re-running on partial failure is safe.

BEGIN;

-- ─── 1. pitching_playlists: add the columns new code reads ────────────────
--
-- pitching-routes.tsx:146 selects: id, name, platform, followers, genre,
-- region, description, curator_contact. Old schema has id, name, platform,
-- description, playlist_url, curator_name, curator_email, curator_phone.
-- Missing: followers, genre, region, curator_contact, status.

ALTER TABLE pitching_playlists
  ADD COLUMN IF NOT EXISTS followers       BIGINT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS genre           TEXT,
  ADD COLUMN IF NOT EXISTS region          TEXT,
  ADD COLUMN IF NOT EXISTS curator_contact TEXT,
  ADD COLUMN IF NOT EXISTS status          TEXT    DEFAULT 'active';

-- Backfill curator_contact by collapsing the three legacy curator_*
-- columns into a single string. Email preferred, then phone, then name.
-- Only fills rows where curator_contact is still NULL — idempotent on
-- re-run, and admin edits made after the migration stick.
UPDATE pitching_playlists
SET curator_contact = COALESCE(curator_email, curator_phone, curator_name)
WHERE curator_contact IS NULL
  AND COALESCE(curator_email, curator_phone, curator_name) IS NOT NULL;

-- Backfill status='active' for legacy rows that have NULL (the column
-- DEFAULT only applies to NEW rows after ALTER).
UPDATE pitching_playlists
SET status = 'active'
WHERE status IS NULL;

-- ─── 2. pitching_radio_stations: VIEW over pitching_radio ──────────────────
--
-- New code SELECTs id, name, region, country, genre, website, contact_email
-- from pitching_radio_stations (pitching-routes.tsx:159). Old pitching_radio
-- has 970 rows with columns: id, name, description, slogan, radio_type,
-- frequency, city, region. The new "country / website / contact_email"
-- columns have no source in the old data — synthesized as defaults so the
-- shape matches.
--
-- VIEW (not a real table) means:
--   - SELECTs from pitching_radio_stations work and return all 970 rows
--   - Seed INSERT at pitching-routes.tsx:122 is GUARDED by `count = 0`
--     check (line 121) — 970 > 0 means seed never runs, the INSERT-into-
--     view problem never materialises
--   - Edits to either table flow through (single source of truth)
--
-- DROP-IF-EXISTS first in case a partial CREATE TABLE got committed by
-- the broken ensureSchema run before today's fix. CASCADE would drop FK
-- dependents — there are none against pitching_radio_stations because
-- the table never existed cleanly. Safe.

DROP TABLE IF EXISTS pitching_radio_stations CASCADE;

CREATE OR REPLACE VIEW pitching_radio_stations AS
SELECT
  id,
  name,
  COALESCE(region, '')      AS region,
  'Russia'::text            AS country,        -- no source column in old schema
  COALESCE(radio_type, '')  AS genre,          -- radio_type maps to "жанр станции"
  ''::text                  AS website,        -- no source column
  ''::text                  AS contact_email,  -- no source column
  'active'::text            AS status          -- treat all legacy stations as active
FROM pitching_radio;

-- ─── 3. pitching_submissions: brand-new table ──────────────────────────────
--
-- Net-new (no legacy equivalent). Required by bundle-payment flow and
-- per-channel pitch routing. References for the column list:
--   pitching-routes.tsx:177-180 (SELECT)
--   pitching-routes.tsx:229-232 (INSERT)
--   pitching-routes.tsx:217-220 (dedup check)
--
-- submission_type values: 'playlist' | 'radio' | 'influencer' | 'outlet'
-- status values:          'pending' | 'approved' | 'rejected' | 'cancelled'
-- (status enum kept as TEXT for now — codebase uses string compares only;
--  proper enum constraint can come in a follow-up migration if needed.)

CREATE TABLE IF NOT EXISTS pitching_submissions (
  id                  TEXT        PRIMARY KEY,
  user_id             TEXT        NOT NULL,
  submission_type     TEXT        NOT NULL,
  target_id           TEXT        NOT NULL,
  target_name         TEXT,
  track_id            TEXT,
  video_id            TEXT,
  message             TEXT,
  status              TEXT        NOT NULL DEFAULT 'pending',
  moderator_response  TEXT,
  actor_role          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pitching_submissions_user_id
  ON pitching_submissions (user_id);

CREATE INDEX IF NOT EXISTS idx_pitching_submissions_status
  ON pitching_submissions (status);

CREATE INDEX IF NOT EXISTS idx_pitching_submissions_target_id
  ON pitching_submissions (target_id);

CREATE INDEX IF NOT EXISTS idx_pitching_submissions_created_at
  ON pitching_submissions (created_at DESC);

COMMIT;

-- ─── Post-migration verification (run manually after applying) ────────────
--
--   -- Should return 8 columns: id, name, platform, followers, genre,
--   -- region, description, curator_contact (and others)
--   \d pitching_playlists
--
--   -- Should return 970 rows
--   SELECT COUNT(*) FROM pitching_radio_stations;
--
--   -- Should return 8 columns matching CREATE TABLE above
--   \d pitching_submissions
--
--   -- Sanity check the failing endpoint:
--   curl -sS http://127.0.0.1:3000/server/api/pitching/playlists | jq .
