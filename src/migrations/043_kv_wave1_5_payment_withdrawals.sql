-- 043_kv_wave1_5_payment_withdrawals.sql
--
-- Wave 1.5: payment_withdrawals — kv-array, race condition + ДЕНЬГИ.
-- 4 модуля (payments/donations/radio/producer-studio) делают
-- get(user_id) → array.push(req) → set(user_id, array) — два
-- одновременных POST /withdraw теряют одну заявку. На проде это
-- = пользователь нажал «вывести» два раза подряд, увидел успех в
-- UI, но в БД только одна запись. Деньги в воздухе.
--
-- Radio модуль использует префикс `radio:${stationUserId}` как
-- user_id (namespace в одной таблице). Backfill распакует это в
-- честное user_id + source='radio'.
--
-- BEFORE: jsonbStore-style — pk='user_id' (TEXT) + data jsonb (array
-- of withdrawal requests). 4 модуля × разные shape:
--   payments-routes:     {id, userId, amount, paymentMethodId, status, createdAt}
--   donations-routes:    {id, source:'donation', userId, amount, commission,
--                         commissionRate, commissionTier, payout,
--                         paymentMethod, paymentDetails, status, createdAt, updatedAt}
--   radio-routes:        {id, source:'radio', stationId, amount,
--                         paymentMethod, paymentDetails, status, createdAt, updatedAt}
--                         user_id ключ = 'radio:${stationId}'
--   producer-studio:     {id, producerId, amount, method, methodLabel, status, createdAt}
--
-- AFTER: row-per-withdrawal, native columns. Source + (user_id, app_id)
-- composite UNIQUE. Radio-namespace распакован.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT — runner
-- оборачивает (см. CLAUDE.md → «Migration files: NO BEGIN/COMMIT»).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d payment_withdrawals
--   SELECT COUNT(*) rows, COALESCE(SUM(jsonb_array_length(data)),0) items,
--          COUNT(*) FILTER (WHERE user_id LIKE 'radio:%') radio_namespaced
--     FROM payment_withdrawals WHERE jsonb_typeof(data)='array';
--   -- Snapshot RLS policies если есть:
--   SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr
--     FROM pg_policy WHERE polrelid::regclass::text = 'payment_withdrawals';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t payment_withdrawals promofm > /tmp/pw_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/043_kv_wave1_5_payment_withdrawals.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Snapshot existing data перед TRUNCATE
CREATE TEMP TABLE _pw_backup ON COMMIT DROP AS
  SELECT user_id AS legacy_user_id, data, created_at FROM payment_withdrawals;

-- RLS policies (если есть — снять до DROP COLUMN/изменения user_id type)
DROP POLICY IF EXISTS pw_admin_all ON payment_withdrawals;
DROP POLICY IF EXISTS pw_insert ON payment_withdrawals;
DROP POLICY IF EXISTS pw_select_own ON payment_withdrawals;
DROP POLICY IF EXISTS pw_update_own ON payment_withdrawals;
-- На всякий случай — generic-style имена, если разработчик когда-то использовал:
DROP POLICY IF EXISTS payment_withdrawals_sel ON payment_withdrawals;
DROP POLICY IF EXISTS payment_withdrawals_ins ON payment_withdrawals;
DROP POLICY IF EXISTS payment_withdrawals_upd ON payment_withdrawals;
DROP POLICY IF EXISTS payment_withdrawals_del ON payment_withdrawals;

ALTER TABLE payment_withdrawals DROP CONSTRAINT IF EXISTS payment_withdrawals_pkey;
ALTER TABLE payment_withdrawals DROP CONSTRAINT IF EXISTS payment_withdrawals_user_id_key;
-- Защита от повторного запуска:
ALTER TABLE payment_withdrawals DROP CONSTRAINT IF EXISTS payment_withdrawals_app_id_unique;
ALTER TABLE payment_withdrawals DROP CONSTRAINT IF EXISTS pw_user_app_unique;

TRUNCATE payment_withdrawals;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='payment_withdrawals' AND column_name='id') THEN
    ALTER TABLE payment_withdrawals DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE payment_withdrawals
  ADD COLUMN id              UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id          TEXT,
  -- user_id уже есть как TEXT — keep
  ADD COLUMN IF NOT EXISTS source          TEXT,
  ADD COLUMN IF NOT EXISTS amount          NUMERIC      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission      NUMERIC,
  ADD COLUMN IF NOT EXISTS commission_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS commission_tier TEXT,
  ADD COLUMN IF NOT EXISTS payout          NUMERIC,
  ADD COLUMN IF NOT EXISTS payment_method  TEXT,
  ADD COLUMN IF NOT EXISTS method_label    TEXT,
  ADD COLUMN IF NOT EXISTS payment_details JSONB,
  ADD COLUMN IF NOT EXISTS status          TEXT         NOT NULL DEFAULT 'pending';

ALTER TABLE payment_withdrawals ADD PRIMARY KEY (id);
ALTER TABLE payment_withdrawals
  ADD CONSTRAINT pw_user_app_unique UNIQUE (user_id, app_id);

CREATE INDEX IF NOT EXISTS idx_pw_user_created
  ON payment_withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pw_status_pending
  ON payment_withdrawals(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pw_source
  ON payment_withdrawals(source) WHERE source IS NOT NULL;

-- Backfill: jsonb_array_elements в строки. Radio префикс распаковываем
-- в честный user_id + source='radio'. Поля shape варьируются между
-- 4 модулями — нормализуем через COALESCE.
INSERT INTO payment_withdrawals (
  id, app_id, user_id, source, amount, commission, commission_rate,
  commission_tier, payout, payment_method, method_label, payment_details,
  status, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  -- Strip 'radio:' префикс если есть. Иначе использовать elem.userId/
  -- producerId/stationId если в данных, иначе legacy_user_id.
  CASE
    WHEN b.legacy_user_id LIKE 'radio:%' THEN substring(b.legacy_user_id from 7)
    ELSE COALESCE(
      elem->>'userId',
      elem->>'producerId',
      elem->>'stationId',
      b.legacy_user_id
    )
  END,
  -- source: если префикс radio — 'radio'. Иначе берём elem.source
  -- (donation писали явно), иначе NULL (default payments-routes).
  CASE
    WHEN b.legacy_user_id LIKE 'radio:%' THEN 'radio'
    ELSE NULLIF(elem->>'source', '')
  END,
  COALESCE(NULLIF(elem->>'amount','')::numeric, 0),
  NULLIF(elem->>'commission','')::numeric,
  NULLIF(elem->>'commissionRate','')::numeric,
  NULLIF(elem->>'commissionTier',''),
  NULLIF(elem->>'payout','')::numeric,
  -- payment_method может быть в paymentMethod/method/paymentMethodId
  COALESCE(
    NULLIF(elem->>'paymentMethod',''),
    NULLIF(elem->>'method',''),
    NULLIF(elem->>'paymentMethodId','')
  ),
  NULLIF(elem->>'methodLabel',''),
  elem->'paymentDetails',
  COALESCE(NULLIF(elem->>'status',''), 'pending'),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW()),
  COALESCE(
    NULLIF(elem->>'updatedAt','')::timestamptz,
    NULLIF(elem->>'createdAt','')::timestamptz,
    b.created_at, NOW()
  )
FROM _pw_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE payment_withdrawals DROP COLUMN IF EXISTS data;

-- RLS — pattern из payment_transactions (Wave 1 PR #52 + laptop's
-- pt_admin_all/pt_select_own/pt_update_own/pt_insert policies).
-- Имена pw_* симметрично, чтобы admin сразу понимал назначение.
CREATE POLICY pw_admin_all ON payment_withdrawals
  FOR ALL USING (
    current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY pw_select_own ON payment_withdrawals
  FOR SELECT USING (
    user_id = current_setting('app.current_user_id', true)
  );
CREATE POLICY pw_insert ON payment_withdrawals
  FOR INSERT WITH CHECK (
    user_id = current_setting('app.current_user_id', true)
  );
CREATE POLICY pw_update_own ON payment_withdrawals
  FOR UPDATE USING (
    user_id = current_setting('app.current_user_id', true)
  );
