-- 037_kv_to_sql_payment_transactions.sql
--
-- KV→SQL миграция для payment_transactions. Часть Wave 1.
--
-- BEFORE: jsonbStore('payment_transactions', 'user_id') — одна строка
-- на user_id, jsonb-массив транзакций в data. Два writer'а:
--   1. platform-revenue.tsx — system buckets 'platform' и 'marketplace'
--      аккуратно делают get → push → set (preserve all)
--   2. track-test-routes.tsx:397 — БАГ: `paymentTransactionsStore.set(
--      request.user_id, paymentTx)` передаёт single object, перетирая
--      все предыдущие транзакции этого юзера. Этим багом скорее всего
--      объясняются жалобы «куда делись мои tx».
--
-- AFTER: row-per-transaction. user_id остаётся (но НЕ PK), новый
-- id uuid PK + индекс на (user_id, created_at DESC) для горячих
-- запросов «транзакции юзера». 'platform' и 'marketplace' остаются
-- как valid значения user_id (system buckets), отличаются по type.
--
-- Объём на проде: десятки-сотни строк (рост по числу пользователей).
-- Backfill expand jsonb-массива в строки + handle single-object
-- corruption case через jsonb_typeof.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d payment_transactions
--   SELECT user_id, jsonb_typeof(data), COALESCE(jsonb_array_length(
--     CASE WHEN jsonb_typeof(data)='array' THEN data ELSE '[]'::jsonb END), 0)
--     FROM payment_transactions;
--   -- покажет распределение: сколько user_id с массивами vs single object
--
--   BEGIN; \i 037_kv_to_sql_payment_transactions.sql;
--     SELECT user_id, type, COUNT(*) FROM payment_transactions
--      GROUP BY user_id, type ORDER BY 3 DESC LIMIT 30;
--   ROLLBACK;  -- проверить counts vs до миграции
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t payment_transactions promofm > /tmp/payment_tx_backup_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--        -f /opt/promofm-api/src/migrations/037_kv_to_sql_payment_transactions.sql
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

BEGIN;

CREATE TEMP TABLE _pt_backup ON COMMIT DROP AS SELECT * FROM payment_transactions;

ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_pkey;
ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_user_id_key;

TRUNCATE payment_transactions;

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS id                  UUID,
  ADD COLUMN IF NOT EXISTS app_id              TEXT,
  ADD COLUMN IF NOT EXISTS amount              NUMERIC      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency            TEXT         NOT NULL DEFAULT 'RUB',
  ADD COLUMN IF NOT EXISTS tx_type             TEXT         NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS category            TEXT,
  ADD COLUMN IF NOT EXISTS status              TEXT         NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS payment_method      TEXT,
  ADD COLUMN IF NOT EXISTS description         TEXT,
  ADD COLUMN IF NOT EXISTS related_entity_type TEXT,
  ADD COLUMN IF NOT EXISTS related_entity_id   TEXT,
  ADD COLUMN IF NOT EXISTS metadata            JSONB        NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE payment_transactions ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE payment_transactions ALTER COLUMN id SET NOT NULL;
ALTER TABLE payment_transactions ADD PRIMARY KEY (id);
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_app_id_unique UNIQUE (app_id);

-- ЯP user_id уже есть в таблице (TEXT), просто переводим в INDEX.
CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_id_created
  ON payment_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_type
  ON payment_transactions(tx_type);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_status
  ON payment_transactions(status);

-- Backfill #1: data это массив транзакций (нормальный путь от
-- platform-revenue.tsx — для 'platform' и 'marketplace' bucket'ов).
INSERT INTO payment_transactions (
  id, app_id, user_id, amount, currency, tx_type, category, status,
  payment_method, description, related_entity_type, related_entity_id,
  metadata, created_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  b.user_id,
  COALESCE(NULLIF(elem->>'amount','')::numeric, 0),
  COALESCE(NULLIF(elem->>'currency',''), 'RUB'),
  COALESCE(NULLIF(elem->>'type',''), 'unknown'),
  elem->>'category',
  COALESCE(NULLIF(elem->>'status',''), 'completed'),
  elem->>'payment_method',
  elem->>'description',
  elem->>'related_entity_type',
  elem->>'related_entity_id',
  COALESCE(elem->'metadata', elem - ARRAY[
    'id','user_id','amount','currency','type','category','status',
    'payment_method','description','related_entity_type',
    'related_entity_id','metadata','created_at'
  ], '{}'::jsonb),
  COALESCE(NULLIF(elem->>'created_at','')::timestamptz, b.created_at, NOW())
FROM _pt_backup b,
     LATERAL jsonb_array_elements(b.data) elem
WHERE jsonb_typeof(b.data) = 'array';

-- Backfill #2: data это single object (баг track-test-routes.tsx:397
-- перетирал массив одной транзакцией). Спасаем то что осталось.
INSERT INTO payment_transactions (
  id, app_id, user_id, amount, currency, tx_type, category, status,
  payment_method, description, related_entity_type, related_entity_id,
  metadata, created_at
)
SELECT
  gen_random_uuid(),
  b.data->>'id',
  b.user_id,
  COALESCE(NULLIF(b.data->>'amount','')::numeric, 0),
  COALESCE(NULLIF(b.data->>'currency',''), 'RUB'),
  COALESCE(NULLIF(b.data->>'type',''), 'unknown'),
  b.data->>'category',
  COALESCE(NULLIF(b.data->>'status',''), 'completed'),
  b.data->>'payment_method',
  b.data->>'description',
  b.data->>'related_entity_type',
  b.data->>'related_entity_id',
  COALESCE(b.data->'metadata', b.data - ARRAY[
    'id','user_id','amount','currency','type','category','status',
    'payment_method','description','related_entity_type',
    'related_entity_id','metadata','created_at'
  ], '{}'::jsonb),
  COALESCE(NULLIF(b.data->>'created_at','')::timestamptz, b.created_at, NOW())
FROM _pt_backup b
WHERE jsonb_typeof(b.data) = 'object';

ALTER TABLE payment_transactions DROP COLUMN IF EXISTS data;

COMMIT;
