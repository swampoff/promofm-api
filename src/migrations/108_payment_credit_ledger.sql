-- 108_payment_credit_ledger.sql
--
-- Append-only ledger для webhook-idempotency на credit-flow.
--
-- ПОЧЕМУ ЭТА МИГРАЦИЯ: в /checkout/webhook/yookassa структура такая:
--   1. claimPaymentSessionForProcessing(orderId) — pending → processing
--   2. processPaymentSuccess() — выполняет fulfillment (credit balance,
--      add coins, активировать subscription, и т.д.)
--   3. если что-то падает — revertPaymentSessionToPending → следующий
--      retry от YooKassa снова пройдёт claim → снова войдёт в
--      processPaymentSuccess.
--
-- Проблема: между step 2 и финальным response к gateway может
-- произойти ошибка (упало SSE, упал email, упал side-effect) ПОСЛЕ
-- успешного credit'а. Revert + retry → второй credit.
--
-- Атомики creditAvailableAtomic / incrementCoinBalanceAtomic защищены
-- от race, но не от retry — они добавляют каждый раз.
--
-- Эта ledger-таблица — first-write-wins guard. Перед каждым credit'ом
-- webhook вставляет (order_id, kind) row. PK конфликт = retry → skip.
--
-- Колонки:
--   order_id    TEXT      — payment_sessions.order_id (UUID v4)
--   kind        TEXT      — короткий тег: 'donation_credit', 'topup_balance',
--                           'topup_coins'. Один orderId может reservировать
--                           несколько kind'ов (топап даёт И коины И баланс).
--   created_at  TIMESTAMPTZ  — момент первой записи.
--   PRIMARY KEY (order_id, kind)
--
-- Append-only, без UPDATE/DELETE. Если ledger-row есть — credit уже
-- посчитан, даже если flow упал сразу после. Это безопаснее «дважды
-- дать деньги»: при ложном skip ops восстановят через admin-refund.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d payment_sessions
--   -- ожидаем существование таблицы; на FK не ссылаемся.
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/108_payment_credit_ledger.sql
--      COMMIT;
--      EOF
--   2. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

CREATE TABLE IF NOT EXISTS payment_credit_ledger (
  order_id   TEXT         NOT NULL,
  kind       TEXT         NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, kind)
);

-- Аудит-индекс: «дай всё что было сделано по этому orderId».
CREATE INDEX IF NOT EXISTS idx_payment_credit_ledger_order_id
  ON payment_credit_ledger (order_id);
