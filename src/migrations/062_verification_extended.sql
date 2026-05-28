-- Extends verification request/approve/reject flow to venue, radio,
-- and producer roles. Mirrors migration 058's artist columns +
-- partial index. Closes the cross-role verification gap left by
-- the audit (PR-2 in the roadmap).
--
-- Before this migration:
--   artist_profiles  — full flow (058): is_verified + requested_at +
--                      approved_at + rejection_reason
--   radio_profiles   — is_verified only (mig 011); no request flow
--   venue_profiles   — is_verified only (mig 011); no request flow
--   producer_profiles — NO verification at all (mig 011 skipped producer)
--
-- After this migration: all four roles carry the same verification
-- state shape and can flow through POST /<role>/request-verification
-- → POST /auth/admin/verify-profile.
--
-- The companion code change:
--   - 3 new POST /request-verification endpoints (venue/radio/producer)
--   - admin/verify-profile gains 'producer' role + extended flow
--     (approved_at / rejection_reason) for venue/radio/producer
--   - get<Role>Profile overlays surface verification_* fields so the
--     settings UI can render the status block (mirrors artist).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

-- ── venue_profiles ────────────────────────────────────────────────
ALTER TABLE venue_profiles
  ADD COLUMN IF NOT EXISTS verification_requested_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_approved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_venue_profiles_pending_verification
  ON venue_profiles(verification_requested_at)
  WHERE verification_requested_at IS NOT NULL
    AND is_verified = false
    AND verification_rejection_reason IS NULL;

-- ── radio_profiles ────────────────────────────────────────────────
ALTER TABLE radio_profiles
  ADD COLUMN IF NOT EXISTS verification_requested_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_approved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_radio_profiles_pending_verification
  ON radio_profiles(verification_requested_at)
  WHERE verification_requested_at IS NOT NULL
    AND is_verified = false
    AND verification_rejection_reason IS NULL;

-- ── producer_profiles ─────────────────────────────────────────────
-- Producer never got is_verified (migration 011 was radio+venue only),
-- so this migration adds the trust flag too. Default false — new
-- producers start unverified and have to request like the others.
ALTER TABLE producer_profiles
  ADD COLUMN IF NOT EXISTS is_verified                   BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_requested_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_approved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_producer_profiles_pending_verification
  ON producer_profiles(verification_requested_at)
  WHERE verification_requested_at IS NOT NULL
    AND is_verified = false
    AND verification_rejection_reason IS NULL;
