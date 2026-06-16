-- 107_banner_ads_payment_cols.sql
--
-- Добавляет native payment-колонки в banner_ads, чтобы webhook
-- /checkout/webhook/yookassa мог фиксировать факт оплаты идемпотентно.
--
-- ПОЧЕМУ ЭТА МИГРАЦИЯ: до 2026-06-16 для типа `banner_publish` webhook
-- НИЧЕГО не апдейтил в banner_ads — баннер оставался в
-- moderation_status='approved' без status='active', start_date, end_date.
-- Пользователь платил, баннер не крутился (silent gold-bug).
--
-- Эту миграцию нужно применить ДО деплоя companion-PR'а с handler'ом —
-- иначе UPDATE webhook'а будет вылетать на missing column.
--
-- Колонки (паттерн зеркалит tracks + dj_mixes, migration 046/062):
--   payment_order_id  TEXT — id заказа в payment_sessions; UNIQUE для
--                            idempotency (повторный webhook UPDATE'нёт 0).
--   payment_gateway   TEXT — yookassa/stripe/tbank
--   paid_at           TIMESTAMPTZ — момент перехода в moderation_status='paid'
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d banner_ads
--   SELECT moderation_status, status, COUNT(*) FROM banner_ads
--    GROUP BY moderation_status, status ORDER BY 1, 2;
--   -- ожидание: 0 строк в moderation_status='approved' с paid_at IS NOT NULL
--   --           (если есть — это и были «оплачено-но-не-активировано»
--   --            кейсы; их нужно вручную через POST /banner/:id/manual-activate).
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/107_banner_ads_payment_cols.sql
--      COMMIT;
--      EOF
--   2. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api
--   3. Аудит:
--      SELECT payment_order_id, paid_at, moderation_status, status, end_date
--        FROM banner_ads
--       WHERE moderation_status = 'approved'
--          OR paid_at IS NOT NULL
--       ORDER BY updated_at DESC LIMIT 20;

ALTER TABLE banner_ads
  ADD COLUMN IF NOT EXISTS payment_order_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_gateway  TEXT,
  ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ;

-- Idempotency: при retry webhook'а UPDATE с WHERE payment_order_id=$1
-- даст 0 строк, если оплата уже зафиксирована. UNIQUE partial — пустые
-- значения не блокируются друг другом.
CREATE UNIQUE INDEX IF NOT EXISTS uq_banner_ads_payment_order_id
  ON banner_ads (payment_order_id)
  WHERE payment_order_id IS NOT NULL;
