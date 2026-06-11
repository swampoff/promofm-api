-- Migration 105: engineer_profiles — per-user e-mail notification toggles
--
-- Контекст: PR feat/engineer-email-pipeline (PR #231) добавил 3
-- emit-точки e-mail для engineer-marketplace'а — `engineer_order_new`,
-- `engineer_order_paid` шлются ИНЖЕНЕРУ; `engineer_order_delivered` /
-- `_refunded` идут КЛИЕНТУ. Все шлются всем по умолчанию.
--
-- Этот PR (B) добавляет per-engineer toggle'ы для двух
-- engineer-side эмейлов. Колонки on клиентских эмейлов сюда НЕ
-- добавляем — клиент мог никогда не заходить в engineer-кабинет, у
-- него нет engineer_profiles-строки и Settings UI'я в engineer-cabinete'е.
-- Если когда-то понадобится клиентский opt-out — это отдельная
-- логика на стороне account-settings, не здесь.
--
-- Дефолт TRUE: после первой миграции existing инженеры продолжают
-- получать email'ы как до toggle'ей (no behaviour change). Чтобы
-- выключить — Settings → Уведомления → toggle OFF.
--
-- Apply: см. CLAUDE.md «Migration files: NO BEGIN/COMMIT inside»
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--   BEGIN;
--   \i /opt/promofm-api/src/migrations/105_engineer_email_toggles.sql
--   COMMIT;
--   EOF

ALTER TABLE engineer_profiles
  ADD COLUMN IF NOT EXISTS notify_email_on_new_order BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notify_email_on_paid      BOOLEAN NOT NULL DEFAULT TRUE;
