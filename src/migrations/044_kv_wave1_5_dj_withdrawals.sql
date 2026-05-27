-- 044_kv_wave1_5_dj_withdrawals.sql
--
-- Wave 1.5: dj_withdrawals — kv-array, race condition + ДЕНЬГИ.
-- Аналог payment_withdrawals (Wave 1.5 PR #59). Те же 3 точки записи
-- (`djWithdrawalsStore.set`) — dj-studio-routes.tsx (POST /finances/
-- withdrawals и failed-fallback) + checkout-routes.tsx (webhook
-- статусный апдейт).
--
-- 💰 Race conditions ДО:
-- 1. POST /finances/withdrawals: get → push → set. Два одновременных
--    запроса на вывод теряют один — DJ нажал «вывести» дважды,
--    YooKassa создала два payout'а, но в БД одна запись (другая
--    payout'а osirota).
-- 2. YooKassa webhook payout.succeeded: get → mutate by yooPayoutId
--    → set. Если приходят два webhook'а (succeeded + paid) close в
--    времени — second перезаписывает first без updates.
--
-- AFTER: row-per-withdrawal, native cols, native yoo_payout_id
-- (partial INDEX для webhook lookup). Cancel/status update —
-- atomic UPDATE WHERE.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT — runner
-- оборачивает (см. CLAUDE.md → «Migration files: NO BEGIN/COMMIT»).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d dj_withdrawals
--   SELECT COUNT(*) rows, COALESCE(SUM(jsonb_array_length(data)),0) items,
--          COUNT(*) FILTER (WHERE jsonb_typeof(data)!='array') non_array
--     FROM dj_withdrawals;
--   -- RLS snapshot:
--   SELECT polname FROM pg_policy WHERE polrelid::regclass::text='dj_withdrawals';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t dj_withdrawals promofm > /tmp/djw_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/044_kv_wave1_5_dj_withdrawals.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

CREATE TEMP TABLE _djw_backup ON COMMIT DROP AS
  SELECT dj_id AS legacy_dj_id, data, created_at FROM dj_withdrawals;

-- RLS policies (если есть — снять до DROP COLUMN)
DROP POLICY IF EXISTS dj_withdrawals_admin_all ON dj_withdrawals;
DROP POLICY IF EXISTS dj_withdrawals_select_own ON dj_withdrawals;
DROP POLICY IF EXISTS dj_withdrawals_insert ON dj_withdrawals;
DROP POLICY IF EXISTS dj_withdrawals_update_own ON dj_withdrawals;
DROP POLICY IF EXISTS djw_admin_all ON dj_withdrawals;
DROP POLICY IF EXISTS djw_select_own ON dj_withdrawals;
DROP POLICY IF EXISTS djw_insert ON dj_withdrawals;
DROP POLICY IF EXISTS djw_update_own ON dj_withdrawals;

ALTER TABLE dj_withdrawals DROP CONSTRAINT IF EXISTS dj_withdrawals_pkey;
ALTER TABLE dj_withdrawals DROP CONSTRAINT IF EXISTS dj_withdrawals_dj_id_key;
ALTER TABLE dj_withdrawals DROP CONSTRAINT IF EXISTS dj_withdrawals_app_id_unique;
ALTER TABLE dj_withdrawals DROP CONSTRAINT IF EXISTS djw_dj_app_unique;

TRUNCATE dj_withdrawals;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='dj_withdrawals' AND column_name='id') THEN
    ALTER TABLE dj_withdrawals DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE dj_withdrawals
  ADD COLUMN id                UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id            TEXT,
  -- dj_id уже есть как TEXT — keep
  ADD COLUMN IF NOT EXISTS amount            NUMERIC      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS method            TEXT,
  ADD COLUMN IF NOT EXISTS destination_label TEXT,
  ADD COLUMN IF NOT EXISTS status            TEXT         NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS yoo_payout_id     TEXT,
  ADD COLUMN IF NOT EXISTS error             TEXT,
  ADD COLUMN IF NOT EXISTS requested_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canceled_at       TIMESTAMPTZ;

ALTER TABLE dj_withdrawals ADD PRIMARY KEY (id);
ALTER TABLE dj_withdrawals
  ADD CONSTRAINT djw_dj_app_unique UNIQUE (dj_id, app_id);

CREATE INDEX IF NOT EXISTS idx_djw_dj_created
  ON dj_withdrawals(dj_id, created_at DESC);
-- Critical: webhook UPDATE ищет по yoo_payout_id. Partial index
-- (только non-NULL) держит размер минимальным.
CREATE INDEX IF NOT EXISTS idx_djw_yoo_payout
  ON dj_withdrawals(yoo_payout_id) WHERE yoo_payout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_djw_status_pending
  ON dj_withdrawals(status) WHERE status = 'pending';

-- Backfill jsonb_array_elements → строки. Поля:
-- {id, djId, amount, method, destinationLabel, status, yooPayoutId,
--  error?, requestedAt, paidAt?, canceledAt?, createdAt, updatedAt?}
INSERT INTO dj_withdrawals (
  id, app_id, dj_id, amount, method, destination_label, status,
  yoo_payout_id, error, requested_at, paid_at, canceled_at,
  created_at, updated_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  COALESCE(elem->>'djId', b.legacy_dj_id),
  COALESCE(NULLIF(elem->>'amount','')::numeric, 0),
  NULLIF(elem->>'method',''),
  NULLIF(elem->>'destinationLabel',''),
  COALESCE(NULLIF(elem->>'status',''), 'pending'),
  NULLIF(elem->>'yooPayoutId',''),
  NULLIF(elem->>'error',''),
  COALESCE(NULLIF(elem->>'requestedAt','')::timestamptz,
           NULLIF(elem->>'createdAt','')::timestamptz,
           b.created_at, NOW()),
  NULLIF(elem->>'paidAt','')::timestamptz,
  NULLIF(elem->>'canceledAt','')::timestamptz,
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz,
           NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW())
FROM _djw_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE dj_withdrawals DROP COLUMN IF EXISTS data;

-- RLS — pattern из payment_transactions/payment_withdrawals (pw_*).
-- djw_* префикс для админ-инспекции через \dp.
CREATE POLICY djw_admin_all ON dj_withdrawals
  FOR ALL USING (
    current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY djw_select_own ON dj_withdrawals
  FOR SELECT USING (
    dj_id = current_setting('app.current_user_id', true)
  );
CREATE POLICY djw_insert ON dj_withdrawals
  FOR INSERT WITH CHECK (
    dj_id = current_setting('app.current_user_id', true)
  );
CREATE POLICY djw_update_own ON dj_withdrawals
  FOR UPDATE USING (
    dj_id = current_setting('app.current_user_id', true)
  );
