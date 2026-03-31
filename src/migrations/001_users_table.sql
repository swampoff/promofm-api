-- Migration: Create users table for auth (replaces Supabase Auth)
-- Run on VPS PostgreSQL: promofm database

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'artist',
  avatar TEXT,
  vk_id TEXT UNIQUE,
  email_verified BOOLEAN DEFAULT false,
  account_status TEXT DEFAULT 'active',
  created_via TEXT DEFAULT 'email',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_sign_in_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_vk_id ON users(vk_id) WHERE vk_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_account_status ON users(account_status) WHERE account_status = 'pending';
