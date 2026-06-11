-- Migration 106: dm_email_throttle — анти-спам гейт для DM-email-канала
--
-- Контекст: PR feat/dm-email-channel добавляет e-mail-нотификацию
-- получателю DM (раньше летел только bell+SSE через
-- cross-cabinet-notify). Без throttle десять подряд сообщений = 10
-- писем в Inbox. Эта таблица — гейт «не чаще раз в N минут per
-- (recipient, conversation)».
--
-- Дизайн (не KV-store): композитный PK (user_id, conversation_id),
-- одно поле timestamptz. Никакого jsonb. Каждая пара (получатель,
-- беседа) — одна строка, обновляется через UPSERT с CHECK по
-- last_sent_at. INSERT ... ON CONFLICT ... DO UPDATE WHERE даёт
-- атомарный «возьми лок и обнови, либо ничего не делай» —
-- идеально для throttle'а без race conditions.
--
-- Threshold: 60 минут в боевом коде (см. THROTTLE_MIN в
-- messaging-routes.tsx). Изменение порога — правка кода + restart,
-- без миграции (порог не в схеме).
--
-- Размер: max ~ active_users * avg_conversations_per_user. На
-- момент 2026-06-11 не превысит 10K строк ещё долго. VACUUM не
-- нужен — UPDATE того же ряда, не INSERT/DELETE churn.
--
-- Apply: см. CLAUDE.md «Migration files: NO BEGIN/COMMIT inside»
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--   BEGIN;
--   \i /opt/promofm-api/src/migrations/106_dm_email_throttle.sql
--   COMMIT;
--   EOF

CREATE TABLE IF NOT EXISTS dm_email_throttle (
  user_id         TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL,
  last_sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);

-- Индекс для cleanup-крона если когда-нибудь захотим
-- DELETE FROM dm_email_throttle WHERE last_sent_at < NOW() - INTERVAL '30 days'.
-- PK уже покрывает hot-path (точечный UPSERT), это для bulk-purge.
CREATE INDEX IF NOT EXISTS idx_dm_email_throttle_last_sent
  ON dm_email_throttle (last_sent_at);
