-- 101_venue_ad_campaigns_payment_refund.sql
--
-- Radio Blocker B (audit 2026-06-03): когда радио-станция отклоняет
-- оплаченную venue_ad_campaign — деньги venue застревают навсегда.
-- POST /venue-requests/:id/reject и POST /orders/:id/reject на main
-- просто флипают status='rejected' БЕЗ возврата средств.
--
-- Колонки нужны чтобы refund-helper мог определить:
--   - была ли кампания оплачена (paid_at IS NOT NULL)
--   - через какой gateway (для выбора refund API)
--   - какой YooKassa payment-id рефаднуть (через payment_order_id →
--     getPaymentSession → gatewayPaymentId)
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d venue_ad_campaigns
--   SELECT status, COUNT(*) FROM venue_ad_campaigns GROUP BY status;
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/101_venue_ad_campaigns_payment_refund.sql
--      COMMIT;
--      EOF
--   2. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

ALTER TABLE venue_ad_campaigns
  ADD COLUMN IF NOT EXISTS payment_order_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_gateway  TEXT,
  ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refunded_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_id        TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ;

-- Индекс для admin-ревизии «отклонённые с непрошедшим refund'ом» во время
-- migration window после деплоя — увидеть legacy кампании где деньги
-- застряли до этого фикса.
CREATE INDEX IF NOT EXISTS idx_vac_rejected_unrefunded
  ON venue_ad_campaigns (status, rejected_at DESC)
  WHERE status = 'rejected' AND refunded_at IS NULL AND paid_at IS NOT NULL;
