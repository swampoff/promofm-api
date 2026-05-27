-- 048_support_tickets_promote_jsonb_to_native.sql
--
-- Wave 3 #2 / 7: support_tickets — hybrid table.
-- Native cols: id, user_id (иногда missing), updated_at, created_at,
-- data jsonb (весь ticket object stringified).
--
-- Promote flat fields → native cols. Сохраняем legit nested JSONB
-- для `messages` (conversation thread), `attachments`, `tags`.
--
-- ❗ BUG ИСПРАВЛЯЕМ: `upsertTicket(ticketId, ticket)` в db.tsx писал
-- только `{id, data, updated_at}` — БЕЗ user_id! Поэтому
-- getTicketsByUser(userId) с WHERE user_id = $1 фильтровал по NULL,
-- возвращал [] для всех ticket'ов созданных через этот helper.
-- (tickets-system-routes.tsx:158 inline INSERT DOES set user_id —
-- spared, но другие callers были broken.)
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d support_tickets
--   SELECT COUNT(*) total,
--          COUNT(*) FILTER (WHERE user_id IS NOT NULL) with_user,
--          COUNT(DISTINCT data->>'status') statuses,
--          COUNT(DISTINCT data->>'category') categories
--     FROM support_tickets;
--   SELECT polname FROM pg_policy WHERE polrelid::regclass::text='support_tickets';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t support_tickets promofm > /tmp/tickets_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/048_support_tickets_promote_jsonb_to_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Bootstrap legacy kv-store table if missing.
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS user_id       TEXT,
  ADD COLUMN IF NOT EXISTS subject       TEXT,
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS category      TEXT,        -- 'technical'|'billing'|'content'|'account'|'other'
  ADD COLUMN IF NOT EXISTS priority      TEXT         NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS status        TEXT         NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS assigned_to   TEXT,
  ADD COLUMN IF NOT EXISTS attachments   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tags          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS messages      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rating        INTEGER,
  ADD COLUMN IF NOT EXISTS feedback      TEXT,
  ADD COLUMN IF NOT EXISTS sla_due_date  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at     TIMESTAMPTZ;

-- Backfill из data jsonb (только если native col NULL / default —
-- не overwrite если уже стояло).
UPDATE support_tickets SET
  user_id       = COALESCE(user_id,      NULLIF(data->>'user_id','')),
  subject       = COALESCE(subject,      NULLIF(data->>'subject','')),
  description   = COALESCE(description,  NULLIF(data->>'description','')),
  category      = COALESCE(category,     NULLIF(data->>'category','')),
  priority      = CASE WHEN priority = 'medium' AND data->>'priority' IS NOT NULL
                       THEN data->>'priority'
                       ELSE priority END,
  status        = CASE WHEN status = 'open' AND data->>'status' IS NOT NULL
                       THEN data->>'status'
                       ELSE status END,
  assigned_to   = COALESCE(assigned_to,  NULLIF(data->>'assigned_to','')),
  attachments   = CASE WHEN attachments = '[]'::jsonb
                       THEN COALESCE(data->'attachments', '[]'::jsonb)
                       ELSE attachments END,
  tags          = CASE WHEN tags = '[]'::jsonb
                       THEN COALESCE(data->'tags', '[]'::jsonb)
                       ELSE tags END,
  messages      = CASE WHEN messages = '[]'::jsonb
                       THEN COALESCE(data->'messages', '[]'::jsonb)
                       ELSE messages END,
  rating        = COALESCE(rating,       NULLIF(data->>'rating','')::integer),
  feedback      = COALESCE(feedback,     NULLIF(data->>'feedback','')),
  sla_due_date  = COALESCE(sla_due_date, NULLIF(data->>'sla_due_date','')::timestamptz),
  resolved_at   = COALESCE(resolved_at,  NULLIF(data->>'resolved_at','')::timestamptz),
  closed_at     = COALESCE(closed_at,    NULLIF(data->>'closed_at','')::timestamptz)
WHERE jsonb_typeof(data) = 'object';

-- Indexes для hot-path queries
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_created
  ON support_tickets(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_admin_queue
  ON support_tickets(status, priority, sla_due_date)
  WHERE status IN ('open', 'in_progress', 'waiting_response');
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned
  ON support_tickets(assigned_to)
  WHERE assigned_to IS NOT NULL;

-- DROP COLUMN data — всё промоутировано в native cols + 3 legit jsonb
-- arrays (messages/attachments/tags) уже скопированы.
ALTER TABLE support_tickets DROP COLUMN IF EXISTS data;
