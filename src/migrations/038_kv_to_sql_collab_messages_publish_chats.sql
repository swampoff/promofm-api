-- 038_kv_to_sql_collab_messages_publish_chats.sql
--
-- KV→SQL: collab_messages + publish_chats — обе таблицы хранили
-- сообщения как jsonb-массив на один offer_id / order_id. Race
-- condition: два одновременных POST → один get-modify-set перетирает
-- другой, сообщение теряется. На проде это уже могло случиться
-- (никто не считает «исчезнувшие» сообщения).
--
-- AFTER: row-per-message. Каждый POST = INSERT, никаких массивов.
-- `read` flag перенесли в native колонку → mark-as-read становится
-- UPDATE WHERE order_id=$1 AND sender_id != $2 AND is_read=false.
-- Unread count = SELECT COUNT(*) WHERE is_read=false ... O(rows in INDEX).
--
-- Текущее состояние таблиц (jsonbStore):
--   collab_messages: pk='id' (фактически offer_id), data=массив сообщений
--   publish_chats:   pk='order_id', data=массив сообщений
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d collab_messages
--   \d publish_chats
--   SELECT COUNT(*) row_cnt,
--          COALESCE(SUM(jsonb_array_length(data)),0) msg_cnt
--     FROM collab_messages WHERE jsonb_typeof(data)='array';
--   SELECT COUNT(*) row_cnt,
--          COALESCE(SUM(jsonb_array_length(data)),0) msg_cnt
--     FROM publish_chats WHERE jsonb_typeof(data)='array';
--   BEGIN; \i 038_kv_to_sql_collab_messages_publish_chats.sql;
--     SELECT 'collab' tbl, COUNT(*) FROM collab_messages
--     UNION ALL SELECT 'publish', COUNT(*) FROM publish_chats;
--   ROLLBACK;
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t collab_messages -t publish_chats promofm \
--        > /tmp/msgs_backup_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/038_kv_to_sql_collab_messages_publish_chats.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT — wrapping
-- управляется внешним runner'ом (см. MANUAL DEPLOY STEPS выше).
-- Inner BEGIN в DO $$ ... END $$ — это PL/pgSQL block, не transaction.

-- ════════════════════════════════════════════════════════════════════
-- 1. collab_messages → row-per-message
-- ════════════════════════════════════════════════════════════════════
-- В KV-эре pk='id' (TEXT), но фактически id содержит offer_id (т.е.
-- ключ был «offer_id хранится в колонке id»). Сохраним legacy id как
-- offer_id, заведём новый uuid PK на новое имя.

CREATE TEMP TABLE _cm_backup ON COMMIT DROP AS
  SELECT id AS legacy_offer_id, data, created_at FROM collab_messages;

ALTER TABLE collab_messages DROP CONSTRAINT IF EXISTS collab_messages_pkey;
ALTER TABLE collab_messages DROP CONSTRAINT IF EXISTS collab_messages_id_key;
-- Защита от повторного запуска:
ALTER TABLE collab_messages DROP CONSTRAINT IF EXISTS collab_messages_app_id_unique;
ALTER TABLE collab_messages DROP CONSTRAINT IF EXISTS collab_messages_offer_app_unique;

TRUNCATE collab_messages;

-- Переименовать старую `id TEXT` если она ещё есть, чтобы освободить
-- имя под uuid PK.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='collab_messages' AND column_name='id') THEN
    ALTER TABLE collab_messages DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE collab_messages
  ADD COLUMN id          UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id      TEXT,
  ADD COLUMN IF NOT EXISTS offer_id    TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sender_id   TEXT,
  ADD COLUMN IF NOT EXISTS sender_name TEXT,
  ADD COLUMN IF NOT EXISTS sender_role TEXT,
  ADD COLUMN IF NOT EXISTS body        TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS attachment  JSONB;

ALTER TABLE collab_messages ADD PRIMARY KEY (id);
-- Композитный UNIQUE: legacy app_id мог дублироваться между офферами
-- (если в коде раньше был per-offer counter). (offer_id, app_id) разводит.
ALTER TABLE collab_messages
  ADD CONSTRAINT collab_messages_offer_app_unique UNIQUE (offer_id, app_id);

CREATE INDEX IF NOT EXISTS idx_collab_messages_offer_id_created
  ON collab_messages(offer_id, created_at ASC);

INSERT INTO collab_messages (
  id, app_id, offer_id, sender_id, sender_name, sender_role,
  body, attachment, created_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  COALESCE(elem->>'offerId', b.legacy_offer_id),
  elem->>'senderId',
  elem->>'senderName',
  elem->>'senderRole',
  COALESCE(elem->>'text', ''),
  elem->'attachment',
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW())
FROM _cm_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE collab_messages DROP COLUMN IF EXISTS data;

-- ════════════════════════════════════════════════════════════════════
-- 2. publish_chats → row-per-message
-- ════════════════════════════════════════════════════════════════════
-- В KV-эре pk='order_id' (TEXT). Сохраним как order_id колонку
-- (она там уже есть), заведём новый uuid PK.

CREATE TEMP TABLE _pc_backup ON COMMIT DROP AS
  SELECT order_id AS legacy_order_id, data, created_at FROM publish_chats;

ALTER TABLE publish_chats DROP CONSTRAINT IF EXISTS publish_chats_pkey;
ALTER TABLE publish_chats DROP CONSTRAINT IF EXISTS publish_chats_order_id_key;
-- Защита от повторного запуска:
ALTER TABLE publish_chats DROP CONSTRAINT IF EXISTS publish_chats_app_id_unique;
ALTER TABLE publish_chats DROP CONSTRAINT IF EXISTS publish_chats_order_app_unique;

TRUNCATE publish_chats;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='publish_chats' AND column_name='id') THEN
    ALTER TABLE publish_chats DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE publish_chats
  ADD COLUMN id          UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id      TEXT,
  ADD COLUMN IF NOT EXISTS sender_id   TEXT,
  ADD COLUMN IF NOT EXISTS sender_name TEXT,
  ADD COLUMN IF NOT EXISTS sender_role TEXT,
  ADD COLUMN IF NOT EXISTS body        TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS attachment  JSONB,
  ADD COLUMN IF NOT EXISTS is_read     BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS read_at     TIMESTAMPTZ;

-- order_id колонка уже есть (была PK), просто убедимся что NOT NULL
-- не выставлен на пустой таблице (это не критично, добавим default).
ALTER TABLE publish_chats ALTER COLUMN order_id SET DEFAULT '';

ALTER TABLE publish_chats ADD PRIMARY KEY (id);
-- Композит — defensive, как у collab_messages:
ALTER TABLE publish_chats
  ADD CONSTRAINT publish_chats_order_app_unique UNIQUE (order_id, app_id);

CREATE INDEX IF NOT EXISTS idx_publish_chats_order_id_created
  ON publish_chats(order_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_publish_chats_unread
  ON publish_chats(order_id, is_read) WHERE is_read = FALSE;

INSERT INTO publish_chats (
  id, app_id, order_id, sender_id, sender_name, sender_role,
  body, attachment, is_read, read_at, created_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  COALESCE(elem->>'orderId', b.legacy_order_id),
  elem->>'senderId',
  elem->>'senderName',
  elem->>'senderRole',
  COALESCE(elem->>'text', ''),
  elem->'attachment',
  COALESCE((elem->>'read')::boolean, FALSE),
  NULLIF(elem->>'readAt','')::timestamptz,
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW())
FROM _pc_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE publish_chats DROP COLUMN IF EXISTS data;
