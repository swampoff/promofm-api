-- Migration 072 — investor_inquiries: kill data jsonb, promote to native cols.
--
-- Контекст:
--   investor_inquiries — лендинг-форма для investor relations
--   ("Запрос инвестиционной презентации"). 1 writer:
--     src/landing-data-routes.tsx:1486 POST /investor-inquiry
--   Readers — нет в коде (admin читает через psql напрямую / нет UI пока).
--
-- Shape очень чистый (см. handler):
--   id        TEXT   -- 'investor-<uuid>'
--   name      TEXT NOT NULL
--   email     TEXT NOT NULL
--   company   TEXT default ''
--   message   TEXT default 'Прошу направить инвестиционную презентацию.'
--   status    TEXT default 'new'
--   createdAt ISO string
--
-- Companion code change: src/db.tsx (typed function вместо store),
-- src/landing-data-routes.tsx (1 call site).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + COALESCE backfill.

-- ── 1. Ensure native cols exist (могут уже быть от ранних попыток)
ALTER TABLE investor_inquiries
  ADD COLUMN IF NOT EXISTS name    TEXT,
  ADD COLUMN IF NOT EXISTS email   TEXT,
  ADD COLUMN IF NOT EXISTS company TEXT,
  ADD COLUMN IF NOT EXISTS message TEXT,
  ADD COLUMN IF NOT EXISTS status  TEXT;

-- ── 2. Backfill из data jsonb (COALESCE — idempotent)
UPDATE investor_inquiries SET
  name    = COALESCE(name,    data->>'name'),
  email   = COALESCE(email,   data->>'email'),
  company = COALESCE(company, data->>'company', ''),
  message = COALESCE(message, data->>'message', ''),
  status  = COALESCE(status,  data->>'status',  'new')
WHERE data IS NOT NULL;

-- ── 3. Drop orphan rows без required fields (name/email).
--    После backfill их быть не должно — writer всегда требует оба
--    (handler возвращает 400 если их нет). Defensive DELETE если на проде
--    остались manual-SQL'нутые legacy rows.
DELETE FROM investor_inquiries WHERE name IS NULL OR email IS NULL;

-- ── 4. Tighten NOT NULL + defaults
ALTER TABLE investor_inquiries
  ALTER COLUMN name    SET NOT NULL,
  ALTER COLUMN email   SET NOT NULL,
  ALTER COLUMN company SET DEFAULT '',
  ALTER COLUMN message SET DEFAULT '',
  ALTER COLUMN status  SET DEFAULT 'new';

UPDATE investor_inquiries SET
  company = COALESCE(company, ''),
  message = COALESCE(message, ''),
  status  = COALESCE(status,  'new');

ALTER TABLE investor_inquiries
  ALTER COLUMN company SET NOT NULL,
  ALTER COLUMN message SET NOT NULL,
  ALTER COLUMN status  SET NOT NULL;

-- ── 5. DROP COLUMN data
ALTER TABLE investor_inquiries DROP COLUMN IF EXISTS data;

-- ── 6. Hot-path indexes
--   (status, created_at DESC) — admin "show pending inquiries" + sorted
--   (created_at DESC)         — общий browse (когда admin UI появится)
CREATE INDEX IF NOT EXISTS idx_investor_inquiries_status_recent
  ON investor_inquiries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_investor_inquiries_created_recent
  ON investor_inquiries(created_at DESC);
