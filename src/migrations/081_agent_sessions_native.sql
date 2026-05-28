-- Migration 081 — agent_sessions: kill data jsonb + DROP derived index table.
--
-- Context:
--   agent_sessions — AI department discussion sessions (ARCH/DEV/SEC/OPS/QA
--   agents simulated discussions для DevLab). Row-per-session by id.
--   agent_sessions_index — singleton row хранит array of last 100 session
--   summaries (id, title, createdAt). Полностью derived из agent_sessions
--   через SELECT id, title, created_at ORDER BY created_at DESC LIMIT 100.
--
--   7 callers в src/agents-routes.tsx.
--
-- Native design:
--   1. agent_sessions: native cols (title, task, status) + jsonb для messages /
--      decisions / followUps (legit nested polymorphic — varying agent msg
--      shape, append-only audit).
--   2. agent_sessions_index: DROP TABLE entirely. Replaced by indexed SELECT.
--
-- Bonus race fixes:
--   1. updateSessionIndex (agents-routes:122-128) делал get+unshift+set с
--      slice(0, 100). 2 concurrent /discuss могли потерять одну запись
--      (read-modify-write race). После DROP — list через ORDER BY DESC,
--      no synchronization needed.
--   2. POST /sessions/:id/continue (line 180-202) делал get→mutate→set
--      whole session с append к followUps. Native UPDATE через jsonb_set
--      или || concatenation на jsonb path — atomic single statement
--      (см. appendAgentSessionFollowUp в db.tsx).
--   3. DELETE /sessions/:id (line 237-239) делал del + get+filter+set
--      index = 3 writes. Native DELETE — single statement, no index sync.
--
-- Idempotent.

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS title       TEXT,
  ADD COLUMN IF NOT EXISTS task        TEXT,
  ADD COLUMN IF NOT EXISTS status      TEXT,
  ADD COLUMN IF NOT EXISTS messages    JSONB,
  ADD COLUMN IF NOT EXISTS decisions   JSONB,
  ADD COLUMN IF NOT EXISTS follow_ups  JSONB;

-- Backfill (handles object и string-encoded data).
UPDATE agent_sessions SET
  title  = COALESCE(title, data->>'title',
                    (CASE WHEN jsonb_typeof(data) = 'string'
                          THEN (data#>>'{}')::jsonb->>'title'
                          ELSE NULL END)),
  task   = COALESCE(task, data->>'task',
                    (CASE WHEN jsonb_typeof(data) = 'string'
                          THEN (data#>>'{}')::jsonb->>'task'
                          ELSE NULL END)),
  status = COALESCE(status, data->>'status',
                    (CASE WHEN jsonb_typeof(data) = 'string'
                          THEN (data#>>'{}')::jsonb->>'status'
                          ELSE NULL END), 'completed'),
  messages = COALESCE(messages,
                      CASE WHEN jsonb_typeof(data) = 'object' THEN data->'messages'
                           WHEN jsonb_typeof(data) = 'string' THEN (data#>>'{}')::jsonb->'messages'
                           ELSE NULL END,
                      '[]'::jsonb),
  decisions = COALESCE(decisions,
                       CASE WHEN jsonb_typeof(data) = 'object' THEN data->'decisions'
                            WHEN jsonb_typeof(data) = 'string' THEN (data#>>'{}')::jsonb->'decisions'
                            ELSE NULL END,
                       '[]'::jsonb),
  follow_ups = COALESCE(follow_ups,
                        CASE WHEN jsonb_typeof(data) = 'object' THEN data->'followUps'
                             WHEN jsonb_typeof(data) = 'string' THEN (data#>>'{}')::jsonb->'followUps'
                             ELSE NULL END,
                        '[]'::jsonb)
WHERE data IS NOT NULL;

DELETE FROM agent_sessions WHERE title IS NULL OR task IS NULL;

ALTER TABLE agent_sessions
  ALTER COLUMN status     SET DEFAULT 'completed',
  ALTER COLUMN messages   SET DEFAULT '[]'::jsonb,
  ALTER COLUMN decisions  SET DEFAULT '[]'::jsonb,
  ALTER COLUMN follow_ups SET DEFAULT '[]'::jsonb;

UPDATE agent_sessions SET
  status     = COALESCE(status,     'completed'),
  messages   = COALESCE(messages,   '[]'::jsonb),
  decisions  = COALESCE(decisions,  '[]'::jsonb),
  follow_ups = COALESCE(follow_ups, '[]'::jsonb);

ALTER TABLE agent_sessions
  ALTER COLUMN title      SET NOT NULL,
  ALTER COLUMN task       SET NOT NULL,
  ALTER COLUMN status     SET NOT NULL,
  ALTER COLUMN messages   SET NOT NULL,
  ALTER COLUMN decisions  SET NOT NULL,
  ALTER COLUMN follow_ups SET NOT NULL;

ALTER TABLE agent_sessions DROP COLUMN IF EXISTS data;

-- Hot-path index — GET /sessions заменяет .get('singleton') на index store.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_recent
  ON agent_sessions(created_at DESC);

-- DROP derived index table. Сейчас полностью заменяется SELECT title,
-- created_at FROM agent_sessions ORDER BY created_at DESC LIMIT N.
DROP TABLE IF EXISTS agent_sessions_index;
