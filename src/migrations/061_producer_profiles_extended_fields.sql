-- Promote 6 producer_profiles fields from `data` jsonb to native columns.
--
-- Part 3 of 3 in the cross-role silent-drop cleanup (venue → #81 / 059,
-- radio → PR #82 / 060). Producer architecture differs from venue/radio:
-- the profile editor writes to a SEPARATE jsonbStore `producer_profile_edit`
-- (see producer-studio-routes.tsx:929 PUT /profile/update), and the
-- public-facing `producer_profiles` table is only seeded by
-- persistProducerImage() at producer-studio-routes.tsx:1333 — which
-- writes ONLY avatarUrl/coverUrl, never the rich editor fields.
--
-- Result: cross-cabinet listings at landing-data-routes.tsx:1262
-- (`/landing/producer-profiles`) and the public producer page at
-- landing-data-routes.tsx:1282 (`/landing/producer-profile/:id`) get a
-- nearly-empty row — no `name`, no `city`, no `bio`. The producer's
-- editor cabinet shows correct data (reads from producer_profile_edit)
-- but no other surface in the platform can see what they typed.
--
-- This migration + the companion code change in producer-studio-routes.tsx
-- (PUT /profile/update now ALSO upserts to producer_profiles via
-- db.upsertProducerProfile, same pattern as persistProducerImage) closes
-- that gap.
--
-- Existing native columns (don't re-add):
--   email, is_email_verified, account_status, phone   (migration 008)
--
-- Fields that stay in `data` jsonb (intentional):
--   specializations, averageRating, services, portfolio, …  — managed
--     by separate stores / not yet wired through the editor;
--     follow-up PR.
--
-- Backfill is COALESCE-based so re-running the migration is safe.

ALTER TABLE producer_profiles
  ADD COLUMN IF NOT EXISTS name             TEXT,
  ADD COLUMN IF NOT EXISTS city             TEXT,
  ADD COLUMN IF NOT EXISTS bio              TEXT,
  ADD COLUMN IF NOT EXISTS work_philosophy  TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url       TEXT,
  ADD COLUMN IF NOT EXISTS cover_url        TEXT;

-- ── Backfill from jsonb ──────────────────────────────────────────
-- COALESCE keeps any value already in the native column (idempotent).
-- avatarUrl / coverUrl: persistProducerImage has been writing these
-- keys to `data` jsonb since migration 008-era; backfill picks them up.
UPDATE producer_profiles SET
  name            = COALESCE(name,            data->>'name'),
  city            = COALESCE(city,            data->>'city'),
  bio             = COALESCE(bio,             data->>'bio'),
  work_philosophy = COALESCE(work_philosophy, data->>'workPhilosophy'),
  avatar_url      = COALESCE(avatar_url,      data->>'avatarUrl'),
  cover_url       = COALESCE(cover_url,       data->>'coverUrl')
WHERE data IS NOT NULL;

-- ── Indexes ──────────────────────────────────────────────────────
-- city is the obvious filter on the public producer marketplace.
CREATE INDEX IF NOT EXISTS idx_producer_profiles_city
  ON producer_profiles(city) WHERE city IS NOT NULL;
