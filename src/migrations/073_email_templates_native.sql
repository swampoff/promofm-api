-- Migration 073 — email_templates: kill data jsonb, promote to native cols.
--
-- Context:
--   email_templates — registry of HTML templates для transactional /
--   notification / newsletter emails. Seeded with 4 defaults на первый
--   GET /templates если table empty. 3 callers, contained в
--   src/email-routes.tsx (email-campaigns-routes.tsx import dead, dropped
--   в companion change).
--
-- Shape (per handler defaults):
--   id          TEXT     -- 'welcome' | 'new_follower' | ...
--   name        TEXT
--   subject     TEXT
--   content     TEXT     -- HTML body с {{placeholders}}
--   type        TEXT     -- 'transactional' | 'notification' | 'newsletter'
--   variables   TEXT[]   -- placeholder names, e.g. ['user_name', 'track_url']
--   created_at  TIMESTAMPTZ
--
-- Companion code: db.tsx (4 typed functions), email-routes.tsx
-- (3 call sites refactored), email-campaigns-routes.tsx (dead import dropped).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + COALESCE backfill.

-- ── 1. Native cols
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS name      TEXT,
  ADD COLUMN IF NOT EXISTS subject   TEXT,
  ADD COLUMN IF NOT EXISTS content   TEXT,
  ADD COLUMN IF NOT EXISTS type      TEXT,
  ADD COLUMN IF NOT EXISTS variables TEXT[];

-- ── 2. Backfill из data jsonb
UPDATE email_templates SET
  name      = COALESCE(name,      data->>'name'),
  subject   = COALESCE(subject,   data->>'subject'),
  content   = COALESCE(content,   data->>'content'),
  type      = COALESCE(type,      data->>'type'),
  variables = COALESCE(variables,
                       ARRAY(SELECT jsonb_array_elements_text(
                         COALESCE(data->'variables', '[]'::jsonb)
                       )))
WHERE data IS NOT NULL;

-- ── 3. DELETE orphan rows без required content (name/subject/content)
--    После backfill их быть не должно — defensive.
DELETE FROM email_templates
 WHERE name IS NULL OR subject IS NULL OR content IS NULL;

-- ── 4. Tighten constraints + defaults
ALTER TABLE email_templates
  ALTER COLUMN name      SET NOT NULL,
  ALTER COLUMN subject   SET NOT NULL,
  ALTER COLUMN content   SET NOT NULL,
  ALTER COLUMN type      SET DEFAULT 'notification',
  ALTER COLUMN variables SET DEFAULT '{}'::TEXT[];

UPDATE email_templates SET
  type      = COALESCE(type,      'notification'),
  variables = COALESCE(variables, '{}'::TEXT[]);

ALTER TABLE email_templates
  ALTER COLUMN type      SET NOT NULL,
  ALTER COLUMN variables SET NOT NULL;

-- ── 5. DROP COLUMN data
ALTER TABLE email_templates DROP COLUMN IF EXISTS data;

-- ── 6. Index — type для фильтра "newsletter only" в админ-листах
CREATE INDEX IF NOT EXISTS idx_email_templates_type
  ON email_templates(type);
