-- Link venue_schedules to a specific zone (optional).
--
-- Before this migration, scheduling was venue-wide: one set of
-- weekly slots that fired for the whole venue. With multi-zone
-- support (migration 015) a Бизнес-tier venue with 4 zones needs
-- to schedule per-zone — "Утренний джаз" в баре + "Lunch acoustic"
-- на веранде в то же время.
--
-- `zone_id` is NULLABLE:
--   - NULL → the schedule is venue-wide (legacy / single-zone
--     behaviour). Active-now resolution treats it as a fallback
--     for every zone that has no zone-specific schedule firing.
--   - SET  → schedule applies ONLY to that zone.
--
-- No hard FK to venue_zones(id) because venue_zones.id is uuid and
-- venue_schedules columns are text in our cabinet schema. If a zone
-- is later deleted, orphaned schedules harmlessly never match the
-- active-now query (it joins/filters by existing zones).
--
-- Idempotent. Safe to re-run.
--
-- MANUAL DEPLOY:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/019_venue_schedules_zone_link.sql

BEGIN;

ALTER TABLE venue_schedules
  ADD COLUMN IF NOT EXISTS zone_id TEXT;

-- Hot path: stream-server resolves per-zone "what's playing now"
-- with (venue_id, zone_id, day_of_week, is_active). Partial index
-- on is_active=TRUE keeps it small.
CREATE INDEX IF NOT EXISTS idx_venue_schedules_zone_lookup
  ON venue_schedules (venue_id, zone_id, day_of_week, is_active)
  WHERE is_active = TRUE;

COMMIT;
