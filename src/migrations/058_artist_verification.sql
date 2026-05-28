-- Artist self-verification flow.
--
-- Replaces the fake `setProfileVerified(true)` local state in
-- Promomusicfigma's settings-page.tsx:1370 with a real backend
-- request/approve cycle:
--
--   artist clicks «Подать заявку» → POST /artist-profile/request-verification
--   → UPDATE artist_profiles SET verification_requested_at = NOW()
--
--   admin opens pending queue → POST /auth/admin/verify-profile
--   { role: 'artist', isVerified: true }
--   → UPDATE artist_profiles SET is_verified = true,
--                                 verification_approved_at = NOW()
--
-- Before this PR the admin endpoint only accepted role='radio_station'
-- or 'venue'; artists could not be verified at all from the API. The
-- existing GET handler already reads `apRow.is_verified` (artist-
-- profile-routes.tsx:227, :354), so the column likely already exists
-- on prod from an early schema; ADD COLUMN IF NOT EXISTS is idempotent
-- and safe either way.

ALTER TABLE artist_profiles
  ADD COLUMN IF NOT EXISTS is_verified                   BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_requested_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_approved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_rejection_reason TEXT;

-- Partial index for admin "pending verifications" queue.
-- Matches artists who have requested but not been processed yet
-- (neither approved nor rejected). Stays small even on a large
-- artist_profiles table since most rows have requested_at = NULL.
CREATE INDEX IF NOT EXISTS idx_artist_profiles_pending_verification
  ON artist_profiles(verification_requested_at)
  WHERE verification_requested_at IS NOT NULL
    AND is_verified = false
    AND verification_rejection_reason IS NULL;
