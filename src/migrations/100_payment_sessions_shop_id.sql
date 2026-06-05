-- 100_payment_sessions_shop_id.sql
--
-- YooKassa shop rotation safety. Каждая payment_session помечается
-- shop_id под которым она создана. На рефанд/верификацию gateway
-- выбирает creds по session.shop_id, а не глобально (если env-переменная
-- YOOKASSA_SHOP_ID_OLD задана с её secret-key'ем).
--
-- Зачем: при ротации магазина (как 2026-06-03 → 1307217) часть платежей
-- остаётся «в полёте» под старыми кредами. Late-webhook'и и retry'и
-- этих платежей после ротации проваливают verify (новый ключ не
-- работает на старый payment_id → 401). Этот столбец + dual-creds
-- bridge в gateway-yookassa.tsx делают переход seamless: бэк сам
-- выбирает старые creds для старых платежей.
--
-- Колонки:
--   - shop_id TEXT — '1307217' для новых после ротации, '<старый>' для
--                    legacy. NULL допустим (бэкфилл оставляет NULL у
--                    тех чьё происхождение неизвестно — gateway
--                    fallback на current ENV).
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d payment_sessions
--   SELECT provider, COUNT(*) FROM payment_sessions GROUP BY provider;
--   SELECT COUNT(*) yk_sessions
--     FROM payment_sessions
--    WHERE provider = 'yookassa'
--      AND updated_at > NOW() - INTERVAL '14 days';
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/100_payment_sessions_shop_id.sql
--      COMMIT;
--      EOF
--   2. (Optional) backfill для существующих in-flight под старый магазин:
--        UPDATE payment_sessions SET shop_id = '<СТАРЫЙ_SHOP_ID>'
--         WHERE provider = 'yookassa'
--           AND shop_id IS NULL
--           AND updated_at < '2026-06-03 17:00:00+00';  -- момент ротации
--   3. (Optional) добавить в /opt/promofm-api/.env:
--        YOOKASSA_SHOP_ID_OLD=<старый_id>
--        YOOKASSA_SECRET_KEY_OLD=<старый_secret>
--      Без этих ENV миграция работает как обычно (gateway падает на
--      current creds для legacy in-flight'а — то же что сейчас).
--   4. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

ALTER TABLE payment_sessions
  ADD COLUMN IF NOT EXISTS shop_id TEXT;

-- Аналогично для payment_transactions — там тоже refund может пройти.
ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS shop_id TEXT;

-- Индекс для admin-ревизии «платежи под legacy shop» во время migration window.
CREATE INDEX IF NOT EXISTS idx_payment_sessions_shop_id
  ON payment_sessions (shop_id)
  WHERE shop_id IS NOT NULL;
