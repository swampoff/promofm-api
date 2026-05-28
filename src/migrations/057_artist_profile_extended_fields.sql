-- Hotfix: artist profile silent field-drop bug
--
-- Symptom (reported 2026-05-27 by Надежда Гуськова via support):
--   Artist fills label / manager / bookingEmail / careerStart /
--   languages / location → presses «Сохранить» → API replies OK →
--   refresh → all six fields reset to defaults. Email survives
--   because it sits in `users.email` which DOES have a mapping.
--
-- Root cause: `vpsSaveProfile` (src/vps-userdata.tsx:56-180) targets
-- `artist_profiles` but its INSERT column list does NOT include
-- label/manager/booking_email/career_start/languages/location, and
-- those columns do not exist on the table either. The TypeScript
-- `ArtistProfile` interface (src/artist-profile-routes.tsx:25-67)
-- declares them, and the PUT handler's allow-list accepts them, so
-- they reach `vpsSaveProfile` — and are silently dropped on the
-- floor. CLAUDE.md "Don't invent columns" already warned about
-- this; the hotfix lands the missing columns and the matching
-- mapping in the same PR.
--
-- This migration adds the columns + a defensive backfill from any
-- `data` jsonb where earlier patches may have shoved a value.

ALTER TABLE artist_profiles
  ADD COLUMN IF NOT EXISTS label         text,
  ADD COLUMN IF NOT EXISTS manager       text,
  ADD COLUMN IF NOT EXISTS booking_email text,
  ADD COLUMN IF NOT EXISTS career_start  text,
  ADD COLUMN IF NOT EXISTS languages     text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS location      text;

-- Backfill from data jsonb (idempotent — only fills NULL/empty rows).
UPDATE artist_profiles
   SET label = NULLIF(data->>'label', '')
 WHERE label IS NULL AND data ? 'label';

UPDATE artist_profiles
   SET manager = NULLIF(data->>'manager', '')
 WHERE manager IS NULL AND data ? 'manager';

UPDATE artist_profiles
   SET booking_email = NULLIF(data->>'bookingEmail', '')
 WHERE booking_email IS NULL AND data ? 'bookingEmail';

UPDATE artist_profiles
   SET career_start = NULLIF(data->>'careerStart', '')
 WHERE career_start IS NULL AND data ? 'careerStart';

UPDATE artist_profiles
   SET location = NULLIF(data->>'location', '')
 WHERE location IS NULL AND data ? 'location';

UPDATE artist_profiles
   SET languages = ARRAY(SELECT jsonb_array_elements_text(data->'languages'))
 WHERE cardinality(languages) = 0
   AND jsonb_typeof(data->'languages') = 'array';
