-- DJ pitching shares the pitching_submissions table with artist pitches.
-- Add columns to track:
--   actor_role  — 'artist' (default) or 'dj'
--   mix_id      — for DJ pitches (the mix being sent), nullable
-- Widen submission_type CHECK in app-level validation (we don't have a strict
-- CHECK constraint on submission_type — code-side guard only).

ALTER TABLE IF EXISTS pitching_submissions
  ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'artist',
  ADD COLUMN IF NOT EXISTS mix_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pitching_submissions_actor_role
  ON pitching_submissions(actor_role);
CREATE INDEX IF NOT EXISTS idx_pitching_submissions_mix
  ON pitching_submissions(mix_id);
