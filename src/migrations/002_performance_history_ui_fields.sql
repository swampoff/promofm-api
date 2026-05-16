-- Migration: Add UI-facing fields to performance_history
-- Adds columns required by the artist UI: event_name (title of the show),
-- description (long text), photos (array of URLs)

ALTER TABLE performance_history
  ADD COLUMN IF NOT EXISTS event_name TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS photos JSONB DEFAULT '[]'::jsonb;
