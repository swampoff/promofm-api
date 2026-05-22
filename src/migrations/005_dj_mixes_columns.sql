-- Ensure dj_mixes has columns needed for upload flow.
-- Existing column layout (legacy): id, dj_id, title, genre, duration, plays_count, data, created_at, updated_at.
-- This migration is idempotent and safe to re-run.

ALTER TABLE IF EXISTS dj_mixes
  ADD COLUMN IF NOT EXISTS audio_url TEXT,
  ADD COLUMN IF NOT EXISTS cover_url TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS bpm_range TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'published';

CREATE INDEX IF NOT EXISTS idx_dj_mixes_dj_id ON dj_mixes(dj_id);
CREATE INDEX IF NOT EXISTS idx_dj_mixes_created_at ON dj_mixes(created_at DESC);
