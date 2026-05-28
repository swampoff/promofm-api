-- Migration 079 — email_history: kill data jsonb, native cols + compound-key
-- decomposition (transactional + campaign sent/open/click events).
--
-- Context:
--   email_history table используется для DVUH целей через compound keys:
--     1. Transactional emails — id = uuid, kind='transactional'.
--     2. Campaign tracking — id = `${campaignId}_<sent|open|click>_${email}`.
--   14 callers across src/email-routes.tsx (5) + src/email-campaigns-routes.tsx (9).
--
-- Native model:
--   id PK (preserves both formats), user_id, campaign_id (nullable),
--   kind TEXT, to_email, subject, template, content, type, status,
--   sent_at, opened, clicked, opened_at, clicked_at, metadata jsonb.
--
-- Bonus fixes:
--   1. Compound-key parsing хрупкий — email с подчёркиванием рушит split.
--      После migration новый код использует (campaign_id, kind, to_email)
--      tuple lookups вместо parsing string'а.
--   2. Open/click dedup чеки (lines 244/342 в campaigns) делают .get(key)
--      просто чтобы проверить existence. Index (campaign_id, kind, to_email)
--      делает существование O(log n) vs JSON parse.
--
-- Idempotent. NO BEGIN/COMMIT (Flyway convention).

ALTER TABLE email_history
  ADD COLUMN IF NOT EXISTS user_id      TEXT,
  ADD COLUMN IF NOT EXISTS campaign_id  TEXT,
  ADD COLUMN IF NOT EXISTS kind         TEXT,
  ADD COLUMN IF NOT EXISTS to_email     TEXT,
  ADD COLUMN IF NOT EXISTS subject      TEXT,
  ADD COLUMN IF NOT EXISTS template     TEXT,
  ADD COLUMN IF NOT EXISTS content      TEXT,
  ADD COLUMN IF NOT EXISTS type         TEXT,
  ADD COLUMN IF NOT EXISTS status       TEXT,
  ADD COLUMN IF NOT EXISTS sent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opened       BOOLEAN,
  ADD COLUMN IF NOT EXISTS clicked      BOOLEAN,
  ADD COLUMN IF NOT EXISTS opened_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clicked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata     JSONB;

-- Backfill from data jsonb (object + string-encoded both supported).
UPDATE email_history SET
  user_id  = COALESCE(user_id,  data->>'user_id',
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN (data#>>'{}')::jsonb->>'user_id'
                            ELSE NULL END)),
  to_email = COALESCE(to_email, data->>'to_email',
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN (data#>>'{}')::jsonb->>'to_email'
                            ELSE NULL END)),
  subject  = COALESCE(subject,  data->>'subject',
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN (data#>>'{}')::jsonb->>'subject'
                            ELSE NULL END)),
  template = COALESCE(template, data->>'template',
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN (data#>>'{}')::jsonb->>'template'
                            ELSE NULL END)),
  content  = COALESCE(content,  data->>'content',
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN (data#>>'{}')::jsonb->>'content'
                            ELSE NULL END)),
  type     = COALESCE(type,     data->>'type',
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN (data#>>'{}')::jsonb->>'type'
                            ELSE NULL END)),
  status   = COALESCE(status,   data->>'status',
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN (data#>>'{}')::jsonb->>'status'
                            ELSE NULL END)),
  sent_at  = COALESCE(sent_at,  NULLIF(data->>'sent_at','')::timestamptz,
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN NULLIF((data#>>'{}')::jsonb->>'sent_at','')::timestamptz
                            ELSE NULL END)),
  opened   = COALESCE(opened,   NULLIF(data->>'opened','')::boolean,
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN NULLIF((data#>>'{}')::jsonb->>'opened','')::boolean
                            ELSE NULL END)),
  clicked  = COALESCE(clicked,  NULLIF(data->>'clicked','')::boolean,
                      (CASE WHEN jsonb_typeof(data) = 'string'
                            THEN NULLIF((data#>>'{}')::jsonb->>'clicked','')::boolean
                            ELSE NULL END)),
  opened_at  = COALESCE(opened_at,  NULLIF(data->>'opened_at','')::timestamptz,
                        (CASE WHEN jsonb_typeof(data) = 'string'
                              THEN NULLIF((data#>>'{}')::jsonb->>'opened_at','')::timestamptz
                              ELSE NULL END)),
  clicked_at = COALESCE(clicked_at, NULLIF(data->>'clicked_at','')::timestamptz,
                        (CASE WHEN jsonb_typeof(data) = 'string'
                              THEN NULLIF((data#>>'{}')::jsonb->>'clicked_at','')::timestamptz
                              ELSE NULL END))
WHERE data IS NOT NULL;

-- metadata: жить в jsonb (legit polymorphic — sendError, opens count, …)
UPDATE email_history SET
  metadata = COALESCE(
    CASE WHEN jsonb_typeof(data) = 'object' THEN data->'metadata'
         WHEN jsonb_typeof(data) = 'string' THEN (data#>>'{}')::jsonb->'metadata'
         ELSE NULL END,
    '{}'::jsonb)
WHERE metadata IS NULL AND data IS NOT NULL;

-- Decompose compound IDs '{campaignId}_<sent|open|click>_{email}' into
-- (campaign_id, kind, to_email). Detects via underscore positions —
-- safe heuristic т.к. campaign_id это uuid с дефисами, email содержит
-- '@'. Pattern: ^(.+)_(sent|open|click)_(.+@.+)$.
UPDATE email_history SET
  campaign_id = COALESCE(campaign_id, substring(id from '^(.+)_(sent|open|click)_.+@.+$')),
  kind        = COALESCE(kind, substring(id from '^.+_(sent|open|click)_.+@.+$')),
  to_email    = COALESCE(to_email, substring(id from '^.+_(?:sent|open|click)_(.+@.+)$'))
WHERE kind IS NULL
  AND id ~ '^.+_(sent|open|click)_.+@.+$';

-- Остальные rows — transactional (uuid id).
UPDATE email_history SET kind = 'transactional'
 WHERE kind IS NULL;

-- DROP orphans без kind/to_email после backfill (мусор).
DELETE FROM email_history
 WHERE kind IS NULL OR (to_email IS NULL AND kind != 'transactional');

-- Defaults
ALTER TABLE email_history
  ALTER COLUMN opened   SET DEFAULT FALSE,
  ALTER COLUMN clicked  SET DEFAULT FALSE,
  ALTER COLUMN type     SET DEFAULT 'notification',
  ALTER COLUMN status   SET DEFAULT 'sent',
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

UPDATE email_history SET
  opened   = COALESCE(opened,   FALSE),
  clicked  = COALESCE(clicked,  FALSE),
  metadata = COALESCE(metadata, '{}'::jsonb);

ALTER TABLE email_history
  ALTER COLUMN kind     SET NOT NULL,
  ALTER COLUMN opened   SET NOT NULL,
  ALTER COLUMN clicked  SET NOT NULL,
  ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE email_history DROP COLUMN IF EXISTS data;

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_email_history_user_recent
  ON email_history(user_id, sent_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_history_campaign_dedup
  ON email_history(campaign_id, kind, to_email) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_history_to_email
  ON email_history(to_email) WHERE to_email IS NOT NULL;
