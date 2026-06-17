-- 111_radio_ad_slot_package_fields.sql
--
-- Extends radio_ad_slots (row-per-slot, migration 050) to carry the rich
-- "advertisement package" model the radio cabinet's CreatePackageModal
-- collects. Before this, the create/update endpoints persisted only
-- slot_type/time_slot/price/duration/max_per_hour/description — so title,
-- pricing type, rotations/day, max slots, featured flag and the nested
-- pricing config (bulk discount / dynamic demand / auction) were silently
-- dropped on save.
--
-- Reused existing columns (no change): price = basePrice, duration =
-- spotDurationSeconds, time_slot, description, slot_type (defaults
-- 'standard'; the FE package model has no tier picker).
--
-- New: native columns for the queryable/primary fields + one JSONB for the
-- legit nested pricing config (per project convention: native cols on main
-- fields, JSONB only for nested data).
--
-- DDL only — the runner wraps this file in a transaction. No BEGIN/COMMIT here.

ALTER TABLE radio_ad_slots ADD COLUMN IF NOT EXISTS title             TEXT;
ALTER TABLE radio_ad_slots ADD COLUMN IF NOT EXISTS pricing_type      TEXT    DEFAULT 'fixed';
ALTER TABLE radio_ad_slots ADD COLUMN IF NOT EXISTS rotations_per_day INTEGER DEFAULT 0;
ALTER TABLE radio_ad_slots ADD COLUMN IF NOT EXISTS max_slots         INTEGER DEFAULT 0;
ALTER TABLE radio_ad_slots ADD COLUMN IF NOT EXISTS is_featured       BOOLEAN DEFAULT FALSE;
ALTER TABLE radio_ad_slots ADD COLUMN IF NOT EXISTS pricing_config    JSONB   DEFAULT '{}'::jsonb;
