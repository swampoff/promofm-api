-- 102_labels_schema.sql
-- Schema extension for Record Label cabinet roster management.
--
-- 1. Extend artist_profiles (make user_id nullable for managed-by-label artist profiles)
ALTER TABLE artist_profiles ALTER COLUMN user_id DROP NOT NULL;

-- 2. Add label relationship columns to artist_profiles
ALTER TABLE artist_profiles
  ADD COLUMN IF NOT EXISTS managed_by_label_id UUID NULL REFERENCES label_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_managed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS label_id UUID NULL REFERENCES label_profiles(id) ON DELETE SET NULL;

-- 3. Create indexes for artist_profiles label columns
CREATE INDEX IF NOT EXISTS idx_artist_profiles_managed_by ON artist_profiles(managed_by_label_id) WHERE managed_by_label_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artist_profiles_label_id   ON artist_profiles(label_id) WHERE label_id IS NOT NULL;

-- 4. Create label_invitations table for roster requests
CREATE TABLE IF NOT EXISTS label_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label_id UUID NOT NULL REFERENCES label_profiles(id) ON DELETE CASCADE,
  artist_user_id UUID NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  message TEXT,
  invited_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_label_invitations_label   ON label_invitations(label_id);
CREATE INDEX IF NOT EXISTS idx_label_invitations_artist  ON label_invitations(artist_user_id) WHERE artist_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_label_invitations_email   ON label_invitations(lower(invited_email));
CREATE INDEX IF NOT EXISTS idx_label_invitations_status  ON label_invitations(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_label_invitation_pending
  ON label_invitations(label_id, COALESCE(artist_user_id::text, lower(invited_email)))
  WHERE status = 'pending';
