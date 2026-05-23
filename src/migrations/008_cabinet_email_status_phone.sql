-- 008_cabinet_email_status_phone.sql
-- KV-phase-out PHASE 1 of 5.
--
-- The "KV profile layer" (vpsGetProfile in src/vps-userdata.tsx) serves
-- five fields that aren't mirrored in any cabinet table:
--   email, is_email_verified, account_status (users.status), phone
-- (The fifth, `role`, is implicit in *which* cabinet table you're in
-- and doesn't need a column.)
--
-- This migration adds those columns to all six cabinet tables and
-- backfills from `users` so a Phase 2 cutover can read them directly
-- without joining users.
--
-- All sections are idempotent (table-exists guard + ADD COLUMN IF NOT
-- EXISTS + COALESCE backfill), so re-applying the file is safe.

-- ── artist_profiles ─────────────────────────────────────────────────────
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'artist_profiles') THEN
    ALTER TABLE artist_profiles
      ADD COLUMN IF NOT EXISTS email             TEXT,
      ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS account_status    TEXT    DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS phone             TEXT;

    -- Backfill from users where the cabinet row knows its user_id and
    -- the cabinet column hasn't been set yet (COALESCE-style).
    UPDATE artist_profiles ap SET
      email             = COALESCE(ap.email,             u.email),
      is_email_verified = COALESCE(ap.is_email_verified, u.is_email_verified),
      account_status    = COALESCE(ap.account_status,    u.status),
      phone             = COALESCE(ap.phone,             u.phone)
    FROM users u
    WHERE u.id = ap.user_id;

    CREATE INDEX IF NOT EXISTS idx_artist_profiles_email
      ON artist_profiles(LOWER(email)) WHERE email IS NOT NULL;
  END IF;
END $$;
COMMIT;

-- ── dj_profiles ─────────────────────────────────────────────────────────
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'dj_profiles') THEN
    ALTER TABLE dj_profiles
      ADD COLUMN IF NOT EXISTS email             TEXT,
      ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS account_status    TEXT    DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS phone             TEXT;

    UPDATE dj_profiles dp SET
      email             = COALESCE(dp.email,             u.email),
      is_email_verified = COALESCE(dp.is_email_verified, u.is_email_verified),
      account_status    = COALESCE(dp.account_status,    u.status),
      phone             = COALESCE(dp.phone,             u.phone)
    FROM users u
    WHERE u.id = dp.user_id;

    CREATE INDEX IF NOT EXISTS idx_dj_profiles_email
      ON dj_profiles(LOWER(email)) WHERE email IS NOT NULL;
  END IF;
END $$;
COMMIT;

-- ── radio_profiles ──────────────────────────────────────────────────────
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'radio_profiles') THEN
    ALTER TABLE radio_profiles
      ADD COLUMN IF NOT EXISTS email             TEXT,
      ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS account_status    TEXT    DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS phone             TEXT;

    UPDATE radio_profiles rp SET
      email             = COALESCE(rp.email,             u.email),
      is_email_verified = COALESCE(rp.is_email_verified, u.is_email_verified),
      account_status    = COALESCE(rp.account_status,    u.status),
      phone             = COALESCE(rp.phone,             u.phone)
    FROM users u
    WHERE u.id = rp.user_id;

    CREATE INDEX IF NOT EXISTS idx_radio_profiles_email
      ON radio_profiles(LOWER(email)) WHERE email IS NOT NULL;
  END IF;
END $$;
COMMIT;

-- ── venue_profiles ──────────────────────────────────────────────────────
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'venue_profiles') THEN
    ALTER TABLE venue_profiles
      ADD COLUMN IF NOT EXISTS email             TEXT,
      ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS account_status    TEXT    DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS phone             TEXT;

    UPDATE venue_profiles vp SET
      email             = COALESCE(vp.email,             u.email),
      is_email_verified = COALESCE(vp.is_email_verified, u.is_email_verified),
      account_status    = COALESCE(vp.account_status,    u.status),
      phone             = COALESCE(vp.phone,             u.phone)
    FROM users u
    WHERE u.id = vp.user_id;

    CREATE INDEX IF NOT EXISTS idx_venue_profiles_email
      ON venue_profiles(LOWER(email)) WHERE email IS NOT NULL;
  END IF;
END $$;
COMMIT;

-- ── producer_profiles ───────────────────────────────────────────────────
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'producer_profiles') THEN
    ALTER TABLE producer_profiles
      ADD COLUMN IF NOT EXISTS email             TEXT,
      ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS account_status    TEXT    DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS phone             TEXT;

    UPDATE producer_profiles pp SET
      email             = COALESCE(pp.email,             u.email),
      is_email_verified = COALESCE(pp.is_email_verified, u.is_email_verified),
      account_status    = COALESCE(pp.account_status,    u.status),
      phone             = COALESCE(pp.phone,             u.phone)
    FROM users u
    WHERE u.id = pp.user_id;

    CREATE INDEX IF NOT EXISTS idx_producer_profiles_email
      ON producer_profiles(LOWER(email)) WHERE email IS NOT NULL;
  END IF;
END $$;
COMMIT;

-- ── label_profiles ──────────────────────────────────────────────────────
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'label_profiles') THEN
    ALTER TABLE label_profiles
      ADD COLUMN IF NOT EXISTS email             TEXT,
      ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS account_status    TEXT    DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS phone             TEXT;

    UPDATE label_profiles lp SET
      email             = COALESCE(lp.email,             u.email),
      is_email_verified = COALESCE(lp.is_email_verified, u.is_email_verified),
      account_status    = COALESCE(lp.account_status,    u.status),
      phone             = COALESCE(lp.phone,             u.phone)
    FROM users u
    WHERE u.id = lp.user_id;

    CREATE INDEX IF NOT EXISTS idx_label_profiles_email
      ON label_profiles(LOWER(email)) WHERE email IS NOT NULL;
  END IF;
END $$;
COMMIT;
