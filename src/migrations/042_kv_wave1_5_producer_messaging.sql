-- 042_kv_wave1_5_producer_messaging.sql
--
-- Wave 1.5: producer_convs + producer_messages + producer_sessions —
-- те же race-condition паттерны как у Wave 1 collab_messages/publish_chats.
-- Не попали в Wave 1 первоначально, чиним сейчас.
--
-- BEFORE: каждая таблица — jsonbStore('foo', 'user_id'), где user_id
-- TEXT PK хранит:
--   - producer_convs:    producerId → массив ConversationMeta
--   - producer_messages: ОШИБОЧНО названо user_id, фактически conversationId
--                        → массив Message
--   - producer_sessions: producerId → массив CalendarSession
--
-- Все три имеют get-modify-set race: 2 параллельных POST → теряем
-- одну запись. Реальные баги, не теория (producer cabinet messaging
-- активно используется).
--
-- AFTER: row-per-entity, native колонки, native owner_id (producer_id
-- или conversation_id), composite UNIQUE (owner, app_id) для idempotency.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT — runner
-- оборачивает (см. CLAUDE.md → «Migration files: NO BEGIN/COMMIT»).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d producer_convs
--   \d producer_messages
--   \d producer_sessions
--   SELECT COUNT(*) rows, COALESCE(SUM(jsonb_array_length(data)),0) items
--     FROM producer_convs WHERE jsonb_typeof(data)='array';
--   SELECT COUNT(*) rows, COALESCE(SUM(jsonb_array_length(data)),0) items
--     FROM producer_messages WHERE jsonb_typeof(data)='array';
--   SELECT COUNT(*) rows, COALESCE(SUM(jsonb_array_length(data)),0) items
--     FROM producer_sessions WHERE jsonb_typeof(data)='array';
--   -- Snapshot существующих RLS-policies (если есть):
--   SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr
--     FROM pg_policy WHERE polrelid::regclass::text IN
--          ('producer_convs', 'producer_messages', 'producer_sessions');
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t producer_convs -t producer_messages -t producer_sessions promofm \
--        > /tmp/wave15_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/042_kv_wave1_5_producer_messaging.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- ════════════════════════════════════════════════════════════════════
-- 1. producer_convs → row-per-conversation
-- ════════════════════════════════════════════════════════════════════

CREATE TEMP TABLE _pc_convs_backup ON COMMIT DROP AS
  SELECT user_id AS legacy_producer_id, data, created_at
    FROM producer_convs;

-- RLS policies (если есть — DROP POLICY IF EXISTS перед DROP COLUMN
-- по той же причине что у producer_custom в Wave 1).
DROP POLICY IF EXISTS producer_sel ON producer_convs;
DROP POLICY IF EXISTS producer_ins ON producer_convs;
DROP POLICY IF EXISTS producer_upd ON producer_convs;
DROP POLICY IF EXISTS producer_del ON producer_convs;

ALTER TABLE producer_convs DROP CONSTRAINT IF EXISTS producer_convs_pkey;
ALTER TABLE producer_convs DROP CONSTRAINT IF EXISTS producer_convs_user_id_key;
-- Защита от повторного запуска:
ALTER TABLE producer_convs DROP CONSTRAINT IF EXISTS producer_convs_app_id_unique;
ALTER TABLE producer_convs DROP CONSTRAINT IF EXISTS pc_convs_producer_app_unique;

TRUNCATE producer_convs;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_convs' AND column_name='user_id') THEN
    ALTER TABLE producer_convs DROP COLUMN user_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_convs' AND column_name='id') THEN
    ALTER TABLE producer_convs DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE producer_convs
  ADD COLUMN id              UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id          TEXT,
  ADD COLUMN IF NOT EXISTS producer_id     TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS client_name     TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS client_initial  TEXT,
  ADD COLUMN IF NOT EXISTS order_title     TEXT,
  ADD COLUMN IF NOT EXISTS order_id        TEXT,
  ADD COLUMN IF NOT EXISTS last_message    TEXT,
  ADD COLUMN IF NOT EXISTS last_time       TEXT,
  ADD COLUMN IF NOT EXISTS unread          INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS online          BOOLEAN      NOT NULL DEFAULT FALSE;

ALTER TABLE producer_convs ADD PRIMARY KEY (id);
ALTER TABLE producer_convs
  ADD CONSTRAINT pc_convs_producer_app_unique UNIQUE (producer_id, app_id);

CREATE INDEX IF NOT EXISTS idx_pc_convs_producer_created
  ON producer_convs(producer_id, created_at DESC);

INSERT INTO producer_convs (
  id, app_id, producer_id, client_name, client_initial, order_title,
  order_id, last_message, last_time, unread, online, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  COALESCE(elem->>'producerId', b.legacy_producer_id),
  COALESCE(NULLIF(elem->>'clientName',''), ''),
  elem->>'clientInitial',
  elem->>'orderTitle',
  elem->>'orderId',
  elem->>'lastMessage',
  elem->>'lastTime',
  COALESCE(NULLIF(elem->>'unread','')::integer, 0),
  COALESCE((elem->>'online')::boolean, FALSE),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, b.created_at, NOW())
FROM _pc_convs_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE producer_convs DROP COLUMN IF EXISTS data;

-- ════════════════════════════════════════════════════════════════════
-- 2. producer_messages → row-per-message
-- ════════════════════════════════════════════════════════════════════
-- Legacy pk='user_id' БЫЛ ОШИБОЧНО НАЗВАН — фактически хранил
-- conversationId. Переименовываем колонку в conversation_id.

CREATE TEMP TABLE _pc_msgs_backup ON COMMIT DROP AS
  SELECT user_id AS legacy_conversation_id, data, created_at
    FROM producer_messages;

DROP POLICY IF EXISTS producer_sel ON producer_messages;
DROP POLICY IF EXISTS producer_ins ON producer_messages;
DROP POLICY IF EXISTS producer_upd ON producer_messages;
DROP POLICY IF EXISTS producer_del ON producer_messages;

ALTER TABLE producer_messages DROP CONSTRAINT IF EXISTS producer_messages_pkey;
ALTER TABLE producer_messages DROP CONSTRAINT IF EXISTS producer_messages_user_id_key;
ALTER TABLE producer_messages DROP CONSTRAINT IF EXISTS producer_messages_app_id_unique;
ALTER TABLE producer_messages DROP CONSTRAINT IF EXISTS pc_msgs_conv_app_unique;

TRUNCATE producer_messages;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_messages' AND column_name='user_id') THEN
    ALTER TABLE producer_messages DROP COLUMN user_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_messages' AND column_name='id') THEN
    ALTER TABLE producer_messages DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE producer_messages
  ADD COLUMN id              UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id          TEXT,
  ADD COLUMN IF NOT EXISTS conversation_id TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS body            TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sender          TEXT         NOT NULL DEFAULT 'producer',
  ADD COLUMN IF NOT EXISTS attachment      JSONB,
  ADD COLUMN IF NOT EXISTS is_read         BOOLEAN      NOT NULL DEFAULT FALSE;

ALTER TABLE producer_messages ADD PRIMARY KEY (id);
ALTER TABLE producer_messages
  ADD CONSTRAINT pc_msgs_conv_app_unique UNIQUE (conversation_id, app_id);

CREATE INDEX IF NOT EXISTS idx_pc_msgs_conv_created
  ON producer_messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_pc_msgs_unread
  ON producer_messages(conversation_id, is_read) WHERE is_read = FALSE;

INSERT INTO producer_messages (
  id, app_id, conversation_id, body, sender, attachment, is_read, created_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  b.legacy_conversation_id,
  COALESCE(elem->>'text', ''),
  COALESCE(NULLIF(elem->>'sender',''), 'producer'),
  elem->'attachment',
  COALESCE((elem->>'read')::boolean, FALSE),
  COALESCE(NULLIF(elem->>'timestamp','')::timestamptz, b.created_at, NOW())
FROM _pc_msgs_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE producer_messages DROP COLUMN IF EXISTS data;

-- ════════════════════════════════════════════════════════════════════
-- 3. producer_sessions → row-per-session
-- ════════════════════════════════════════════════════════════════════

CREATE TEMP TABLE _pc_sess_backup ON COMMIT DROP AS
  SELECT user_id AS legacy_producer_id, data, created_at
    FROM producer_sessions;

DROP POLICY IF EXISTS producer_sel ON producer_sessions;
DROP POLICY IF EXISTS producer_ins ON producer_sessions;
DROP POLICY IF EXISTS producer_upd ON producer_sessions;
DROP POLICY IF EXISTS producer_del ON producer_sessions;

ALTER TABLE producer_sessions DROP CONSTRAINT IF EXISTS producer_sessions_pkey;
ALTER TABLE producer_sessions DROP CONSTRAINT IF EXISTS producer_sessions_user_id_key;
ALTER TABLE producer_sessions DROP CONSTRAINT IF EXISTS producer_sessions_app_id_unique;
ALTER TABLE producer_sessions DROP CONSTRAINT IF EXISTS pc_sess_producer_app_unique;

TRUNCATE producer_sessions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_sessions' AND column_name='user_id') THEN
    ALTER TABLE producer_sessions DROP COLUMN user_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_sessions' AND column_name='id') THEN
    ALTER TABLE producer_sessions DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE producer_sessions
  ADD COLUMN id              UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id          TEXT,
  ADD COLUMN IF NOT EXISTS producer_id     TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS title           TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS client_name     TEXT,
  ADD COLUMN IF NOT EXISTS client_id       TEXT,
  ADD COLUMN IF NOT EXISTS session_date    DATE,
  ADD COLUMN IF NOT EXISTS start_time      TEXT,
  ADD COLUMN IF NOT EXISTS end_time        TEXT,
  ADD COLUMN IF NOT EXISTS session_type    TEXT         NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS status          TEXT         NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS notes           TEXT,
  ADD COLUMN IF NOT EXISTS color           TEXT,
  ADD COLUMN IF NOT EXISTS order_id        TEXT;

ALTER TABLE producer_sessions ADD PRIMARY KEY (id);
ALTER TABLE producer_sessions
  ADD CONSTRAINT pc_sess_producer_app_unique UNIQUE (producer_id, app_id);

CREATE INDEX IF NOT EXISTS idx_pc_sess_producer_date
  ON producer_sessions(producer_id, session_date);

INSERT INTO producer_sessions (
  id, app_id, producer_id, title, client_name, client_id, session_date,
  start_time, end_time, session_type, status, notes, color, order_id,
  created_at, updated_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  COALESCE(elem->>'producerId', b.legacy_producer_id),
  COALESCE(NULLIF(elem->>'title',''), ''),
  elem->>'clientName',
  elem->>'clientId',
  NULLIF(elem->>'date','')::date,
  elem->>'startTime',
  elem->>'endTime',
  COALESCE(NULLIF(elem->>'type',''), 'other'),
  COALESCE(NULLIF(elem->>'status',''), 'scheduled'),
  elem->>'notes',
  elem->>'color',
  elem->>'orderId',
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, b.created_at, NOW())
FROM _pc_sess_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE producer_sessions DROP COLUMN IF EXISTS data;

-- ════════════════════════════════════════════════════════════════════
-- 4. Recreate RLS policies на новых owner-колонках
-- ════════════════════════════════════════════════════════════════════
-- Pattern: producer_id = current_setting('app.current_user_id', true)
-- с admin escape hatch — те же что у producer_custom_* в Wave 1
-- (см. migration 039). Если на проде были другие policy bodies —
-- pg_policy snapshot из PRE-ПРОВЕРКА выше покажет, laptop скорректирует.
-- producer_messages: owner-check через JOIN с producer_convs.

CREATE POLICY producer_sel ON producer_convs
  FOR SELECT USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_ins ON producer_convs
  FOR INSERT WITH CHECK (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_upd ON producer_convs
  FOR UPDATE USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_del ON producer_convs
  FOR DELETE USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );

-- producer_messages owner-check через producer_convs.producer_id
-- (conversation_id → producer_convs.app_id → producer_id). Sub-select
-- в каждой policy чтобы не вводить дополнительный owner_id столбец.
CREATE POLICY producer_sel ON producer_messages
  FOR SELECT USING (
    current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
    OR EXISTS (
      SELECT 1 FROM producer_convs c
       WHERE c.app_id = producer_messages.conversation_id
         AND c.producer_id = current_setting('app.current_user_id', true)
    )
  );
CREATE POLICY producer_ins ON producer_messages
  FOR INSERT WITH CHECK (
    current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
    OR EXISTS (
      SELECT 1 FROM producer_convs c
       WHERE c.app_id = producer_messages.conversation_id
         AND c.producer_id = current_setting('app.current_user_id', true)
    )
  );
CREATE POLICY producer_upd ON producer_messages
  FOR UPDATE USING (
    current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
    OR EXISTS (
      SELECT 1 FROM producer_convs c
       WHERE c.app_id = producer_messages.conversation_id
         AND c.producer_id = current_setting('app.current_user_id', true)
    )
  );
CREATE POLICY producer_del ON producer_messages
  FOR DELETE USING (
    current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
    OR EXISTS (
      SELECT 1 FROM producer_convs c
       WHERE c.app_id = producer_messages.conversation_id
         AND c.producer_id = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY producer_sel ON producer_sessions
  FOR SELECT USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_ins ON producer_sessions
  FOR INSERT WITH CHECK (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_upd ON producer_sessions
  FOR UPDATE USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_del ON producer_sessions
  FOR DELETE USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
