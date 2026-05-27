-- 042_kv_wave1_5_producer_messaging.sql (v2 после laptop dry-run 2026-05-27)
--
-- Wave 1.5: producer_convs + producer_messages + producer_sessions —
-- те же race-condition паттерны как у Wave 1 collab_messages/publish_chats.
--
-- v2 ИЗМЕНЕНИЯ относительно v1:
-- - producer_messages: переход с migrate-from-jsonb на wipe-and-rebuild.
--   Прод оказался в hybrid-state (id uuid PK + native колонки + data
--   jsonb), legacy 69 сообщений в data — orphans (нет producer_convs
--   куда attach'нуть, mapping потерян при прошлом partial refactor).
--   App-код всё это время был broken (jsonbStore.set ссылался на
--   несуществующую user_id колонку → silent fail). TRUNCATE + rebuild.
--   Backup /root/wave15-backup-20260527-181500.sql.
-- - producer_convs + producer_sessions: без изменений (laptop confirmed
--   schema matches expected: user_id TEXT PK + data jsonb).
--
-- BEFORE:
--   - producer_convs:    pk='user_id' (producerId), data: ConversationMeta[]
--   - producer_messages: hybrid id uuid PK + 5 unused native cols + data
--                        jsonb (15 rows × 69 orphan messages)
--   - producer_sessions: pk='user_id' (producerId), data: CalendarSession[]
--
-- AFTER: row-per-entity, native колонки, native owner_id (producer_id
-- или conversation_id), composite UNIQUE (owner, app_id) для idempotency.
-- 69 orphan messages wiped (нечем привязать к conversations, 0 convs
-- на проде). Backup сохранён.
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
-- HYBRID-state на проде (обнаружено laptop dry-run 2026-05-27):
-- Таблица уже была частично отрефакторена в прошлом — id uuid PK,
-- + native колонки sender_id/recipient_id/subject/content/is_read
-- (паттерн direct user-to-user, не conversation-grouped). НО data
-- jsonb осталась с legacy-массивами сообщений, а native колонки
-- НИКОГДА не заполнялись (все NULL/FALSE на 15 строках с 69 сообщений
-- в data).
--
-- Параллельно jsonbStore('producer_messages', 'user_id') в db.tsx
-- ссылался на user_id колонку которая уже не существует — все
-- store.set() из app-кода silent-fail'или с момента того старого
-- refactor'а. Producer cabinet messaging НЕ работает на проде сейчас.
--
-- Decision: 69 legacy сообщений ОРФАНЫ — нечем привязать (legacy pk
-- был user_id с conv_id значением; после rename в id uuid это
-- mapping потеряно, plus 0 строк в producer_convs → 0 conversations
-- куда attach'нуть). Wipe + клин-сборка под новую схему. Backup
-- /root/wave15-backup-20260527-181500.sql у laptop.

DROP POLICY IF EXISTS producer_sel ON producer_messages;
DROP POLICY IF EXISTS producer_ins ON producer_messages;
DROP POLICY IF EXISTS producer_upd ON producer_messages;
DROP POLICY IF EXISTS producer_del ON producer_messages;

-- Wipe legacy data (69 orphan messages, no producer_convs to link).
-- Backup preserved at /root/wave15-backup-20260527-181500.sql.
TRUNCATE producer_messages;

-- Drop unused legacy native columns (direct user-to-user pattern,
-- никогда не использовался app-кодом — все 15 строк имели NULL).
ALTER TABLE producer_messages DROP COLUMN IF EXISTS sender_id;
ALTER TABLE producer_messages DROP COLUMN IF EXISTS recipient_id;
ALTER TABLE producer_messages DROP COLUMN IF EXISTS subject;
ALTER TABLE producer_messages DROP COLUMN IF EXISTS content;
ALTER TABLE producer_messages DROP COLUMN IF EXISTS data;
ALTER TABLE producer_messages DROP COLUMN IF EXISTS user_id;

-- Снять старые constraint'ы (включая защиту от повторного запуска).
ALTER TABLE producer_messages DROP CONSTRAINT IF EXISTS producer_messages_user_id_key;
ALTER TABLE producer_messages DROP CONSTRAINT IF EXISTS producer_messages_app_id_unique;
ALTER TABLE producer_messages DROP CONSTRAINT IF EXISTS pc_msgs_conv_app_unique;

-- id uuid PK уже есть на проде — не пересоздаём. Просто гарантируем
-- DEFAULT (на случай если был выставлен и сброшен прошлой попыткой).
ALTER TABLE producer_messages ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Новые колонки. Все ADD ... IF NOT EXISTS — defensive, если кто-то
-- частично применил предыдущую версию миграции.
ALTER TABLE producer_messages
  ADD COLUMN IF NOT EXISTS app_id          TEXT,
  ADD COLUMN IF NOT EXISTS conversation_id TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS body            TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sender          TEXT         NOT NULL DEFAULT 'producer',
  ADD COLUMN IF NOT EXISTS attachment      JSONB,
  ADD COLUMN IF NOT EXISTS is_read         BOOLEAN      NOT NULL DEFAULT FALSE;

-- created_at + updated_at скорее всего уже есть (laptop подтвердил),
-- но defensive ADD IF NOT EXISTS на случай если schema частичная.
ALTER TABLE producer_messages
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW();

ALTER TABLE producer_messages
  ADD CONSTRAINT pc_msgs_conv_app_unique UNIQUE (conversation_id, app_id);

CREATE INDEX IF NOT EXISTS idx_pc_msgs_conv_created
  ON producer_messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_pc_msgs_unread
  ON producer_messages(conversation_id, is_read) WHERE is_read = FALSE;

-- No backfill — legacy 69 сообщений уже wiped TRUNCATE'ом выше.
-- (Восстановить из /root/wave15-backup-... если когда-то понадобится).

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
