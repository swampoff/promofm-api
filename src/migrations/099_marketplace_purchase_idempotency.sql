-- 099_marketplace_purchase_idempotency.sql
--
-- Marketplace fulfillment idempotency. Bug A из аудита:
--   purchaseId = 'bp_' + Math.random()  // beat_purchase
--   purchaseId = 'dgp_' + Math.random() // digital_purchase
-- → каждый YooKassa retry webhook'а создавал НОВУЮ запись (id рандомный),
-- ON CONFLICT (id) DO NOTHING не блокировал ничего. Producer получал
-- 2× SSE «продажа», commission записывалась дважды, platform_revenue
-- завышен, в purchase table две строки за один платёж.
--
-- Fix архитектура:
--   - Native колонка `payment_order_id` (бэкфилл из data->>'paymentOrderId')
--   - UNIQUE INDEX на ней → INSERT ... ON CONFLICT (payment_order_id) DO NOTHING
--     атомарно дедуплицирует retry'и.
--
-- Backfill: переносим существующие значения из data jsonb в нативную колонку.
-- Дубликаты по payment_order_id (если они уже есть в проде из-за бага A) —
-- мы НЕ удаляем автоматически; миграция не падает, но UNIQUE INDEX создаётся
-- через UNIQUE с CONCURRENTLY=false (заблокирует если дубликаты есть).
--
-- ⚠️ ПРЕД-ПРОВЕРКА (laptop, обязательно — есть ли дубликаты в проде):
--   SELECT data->>'paymentOrderId' AS oid, COUNT(*) cnt
--     FROM beat_purchases
--    WHERE data->>'paymentOrderId' IS NOT NULL
--    GROUP BY oid HAVING COUNT(*) > 1;
--   -- то же для digital_purchases. Если есть строки — сначала reconcile
--   -- (свернуть дубликаты, refund extra payments), потом миграция.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- MANUAL DEPLOY STEPS:
--   1. Сделать ПРЕД-ПРОВЕРКУ выше. Если дубликаты есть — STOP, reconcile.
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/099_marketplace_purchase_idempotency.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- beat_purchases
ALTER TABLE beat_purchases
  ADD COLUMN IF NOT EXISTS payment_order_id TEXT;

UPDATE beat_purchases
   SET payment_order_id = NULLIF(data->>'paymentOrderId', '')
 WHERE payment_order_id IS NULL
   AND data ? 'paymentOrderId';

CREATE UNIQUE INDEX IF NOT EXISTS uq_beat_purchases_payment_order_id
  ON beat_purchases (payment_order_id)
  WHERE payment_order_id IS NOT NULL;

-- digital_purchases
ALTER TABLE digital_purchases
  ADD COLUMN IF NOT EXISTS payment_order_id TEXT;

UPDATE digital_purchases
   SET payment_order_id = NULLIF(data->>'paymentOrderId', '')
 WHERE payment_order_id IS NULL
   AND data ? 'paymentOrderId';

CREATE UNIQUE INDEX IF NOT EXISTS uq_digital_purchases_payment_order_id
  ON digital_purchases (payment_order_id)
  WHERE payment_order_id IS NOT NULL;
