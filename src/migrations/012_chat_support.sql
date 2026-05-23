-- Live support chat — Phase 1 (visitor → admin real-time conversation).
--
-- Separate from `support_tickets` (formal complaints with category /
-- priority workflow). A chat session is identified by a random
-- `guest_token` that the visitor's browser stores in localStorage AND
-- a httpOnly cookie. Unauthenticated visitors get a session by hitting
-- POST /chat-support/init. Authenticated cabinet users can also create
-- sessions — `user_id` is populated from JWT.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS),
-- safe to re-run.

BEGIN;

-- ── chat_sessions ────────────────────────────────────────────────
-- One row per visitor conversation.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_token         TEXT         NOT NULL UNIQUE,        -- random 32-byte hex; cookie + localStorage
  guest_name          TEXT,                                  -- optional, set by visitor in widget onboarding
  guest_email         TEXT,                                  -- optional, used for offline-reply email fallback
  user_id             TEXT,                                  -- set when an authenticated cabinet user starts a session
  status              TEXT         NOT NULL DEFAULT 'open',  -- 'open' | 'assigned' | 'closed'
  assigned_admin_id   TEXT,                                  -- users.id of admin who took the session
  source              TEXT         NOT NULL DEFAULT 'widget',-- 'widget' | 'cabinet' | 'telegram'
  last_message_at     TIMESTAMPTZ,                           -- updated by trigger on chat_messages INSERT
  last_admin_read_at  TIMESTAMPTZ,                           -- for unread badges in admin UI
  last_guest_read_at  TIMESTAMPTZ,                           -- for unread badges in guest widget
  ip_addr             TEXT,                                  -- audit, abuse detection
  user_agent          TEXT,                                  -- audit
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_sessions_status_chk     CHECK (status IN ('open', 'assigned', 'closed')),
  CONSTRAINT chat_sessions_source_chk     CHECK (source IN ('widget', 'cabinet', 'telegram'))
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_status_last
  ON chat_sessions (status, last_message_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id
  ON chat_sessions (user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_assigned
  ON chat_sessions (assigned_admin_id) WHERE assigned_admin_id IS NOT NULL;

-- ── chat_messages ────────────────────────────────────────────────
-- Each row = one bubble in the chat. Cascade-deleted with the session.
CREATE TABLE IF NOT EXISTS chat_messages (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID         NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  sender_type  TEXT         NOT NULL,                       -- 'guest' | 'admin' | 'system' | 'bot'
  sender_id    TEXT,                                          -- users.id when sender_type='admin'
  sender_name  TEXT,                                          -- snapshot at send time (admin display)
  body         TEXT         NOT NULL,
  attachments  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  read_at      TIMESTAMPTZ,                                   -- when the OTHER side acked seeing it
  CONSTRAINT chat_messages_sender_type_chk
    CHECK (sender_type IN ('guest', 'admin', 'system', 'bot'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
  ON chat_messages (session_id, created_at);

-- ── touch trigger: bump chat_sessions.last_message_at on INSERT ──
CREATE OR REPLACE FUNCTION chat_sessions_touch_last_message() RETURNS TRIGGER AS $$
BEGIN
  UPDATE chat_sessions
     SET last_message_at = NEW.created_at,
         updated_at      = NOW()
   WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_messages_touch_session ON chat_messages;
CREATE TRIGGER trg_chat_messages_touch_session
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION chat_sessions_touch_last_message();

COMMIT;
