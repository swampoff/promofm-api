-- Migration 084 — platform_revenue_log: kill singleton-array pattern.
--
-- Context:
--   platform_revenue_log — singleton row (key='singleton') хранил array of
--   ВСЕХ revenue entries платформы. ~9 channels × N transactions = неограниченный
--   рост одной jsonb-ячейки. Каждый recordRevenue делал get+push+set всей
--   array. Stats endpoint делал JS reduce over the full array.
--
--   2 caller files, 3 sites:
--   - platform-revenue.tsx:120-123 (recordRevenue race)
--   - platform-revenue.tsx:181 (getRevenueStats — JS aggregation)
--   - marketplace-routes.tsx:1498 (GET /admin/transactions — JS filter+paginate)
--
-- Native design:
--   Row-per-entry. PK = id. 13 native scalar cols + metadata jsonb (legit
--   polymorphic — channel-specific data: trackId, beatId, sessionId...).
--
-- Bonus race fixes:
--   1. recordRevenue (platform-revenue.tsx:120-123): get singleton-array →
--      push → set entire array. На каждое payment'е растёт O(N), а 2
--      concurrent payments теряют один entry (lost-update). После:
--      single INSERT — atomic, O(1).
--   2. getRevenueStats (line 181-220): загружает ВСЁ в JS, reduces + group.
--      После: SQL aggregation через GROUP BY channel — O(log N) pushdown.
--   3. GET /admin/transactions (marketplace-routes:1498): JS filter+sort+
--      paginate over entire array. После: WHERE channel = + ORDER BY
--      created_at DESC + LIMIT/OFFSET — index pushdown.
--
-- Big perf win: stats и admin-list больше не загружают всю историю в RAM.
--
-- Idempotent.

-- Bootstrap legacy table (lazy-init может быть отсутствует на проде).
CREATE TABLE IF NOT EXISTS platform_revenue_log (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Step 1: Snapshot legacy singleton-row data перед сменой shape.
CREATE TEMP TABLE _prl_backup ON COMMIT DROP AS
  SELECT id, data, created_at
    FROM platform_revenue_log WHERE 1=0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'platform_revenue_log' AND column_name = 'data'
  ) THEN
    INSERT INTO _prl_backup
      SELECT id, data, created_at FROM platform_revenue_log;
  END IF;
END $$;

-- Step 2: Drop legacy PK + truncate (only if 'data' column ещё present — иначе
-- мы уже мигрировали, no-op).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'platform_revenue_log' AND column_name = 'data'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS platform_revenue_log_admin_all ON platform_revenue_log';
    EXECUTE 'DROP POLICY IF EXISTS prl_admin_all ON platform_revenue_log';

    EXECUTE 'ALTER TABLE platform_revenue_log DROP CONSTRAINT IF EXISTS platform_revenue_log_pkey';
    EXECUTE 'TRUNCATE platform_revenue_log';
  END IF;
END $$;

-- Step 3: ADD native cols (idempotent).
ALTER TABLE platform_revenue_log
  ADD COLUMN IF NOT EXISTS id                TEXT,
  ADD COLUMN IF NOT EXISTS channel           TEXT,
  ADD COLUMN IF NOT EXISTS description       TEXT,
  ADD COLUMN IF NOT EXISTS gross_amount      NUMERIC,
  ADD COLUMN IF NOT EXISTS platform_revenue  NUMERIC,
  ADD COLUMN IF NOT EXISTS payout_amount     NUMERIC,
  ADD COLUMN IF NOT EXISTS commission_rate   NUMERIC,
  ADD COLUMN IF NOT EXISTS payer_id          TEXT,
  ADD COLUMN IF NOT EXISTS payer_name        TEXT,
  ADD COLUMN IF NOT EXISTS payee_id          TEXT,
  ADD COLUMN IF NOT EXISTS payee_name        TEXT,
  ADD COLUMN IF NOT EXISTS status            TEXT,
  ADD COLUMN IF NOT EXISTS metadata          JSONB;

-- Step 4: Backfill через jsonb_array_elements из snapshot.
-- Старая структура: 1 row с key='singleton', data = array of RevenueEntry.
-- Может также встретиться объект-encoded form.
INSERT INTO platform_revenue_log (
  id, channel, description, gross_amount, platform_revenue, payout_amount,
  commission_rate, payer_id, payer_name, payee_id, payee_name,
  status, metadata, created_at, updated_at
)
SELECT
  COALESCE(NULLIF(elem->>'id', ''), 'rev-legacy-' || md5(elem::text)),
  COALESCE(NULLIF(elem->>'channel', ''), 'unknown'),
  elem->>'description',
  COALESCE(NULLIF(elem->>'grossAmount', '')::numeric, 0),
  COALESCE(NULLIF(elem->>'platformRevenue', '')::numeric, 0),
  COALESCE(NULLIF(elem->>'payoutAmount', '')::numeric, 0),
  COALESCE(NULLIF(elem->>'commissionRate', '')::numeric, 0),
  NULLIF(elem->>'payerId', ''),
  NULLIF(elem->>'payerName', ''),
  NULLIF(elem->>'payeeId', ''),
  NULLIF(elem->>'payeeName', ''),
  COALESCE(NULLIF(elem->>'status', ''), 'completed'),
  COALESCE(
    CASE WHEN jsonb_typeof(elem->'metadata') = 'object' THEN elem->'metadata' ELSE NULL END,
    '{}'::jsonb
  ),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW()),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW())
FROM _prl_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data) = 'array' THEN b.data
            WHEN jsonb_typeof(b.data) = 'object' THEN jsonb_build_array(b.data)
            ELSE '[]'::jsonb END
     ) elem
ON CONFLICT (id) DO NOTHING;

-- Step 5: Defaults + NOT NULL + PK.
UPDATE platform_revenue_log SET
  channel          = COALESCE(channel, 'unknown'),
  status           = COALESCE(status, 'completed'),
  gross_amount     = COALESCE(gross_amount, 0),
  platform_revenue = COALESCE(platform_revenue, 0),
  payout_amount    = COALESCE(payout_amount, 0),
  commission_rate  = COALESCE(commission_rate, 0),
  metadata         = COALESCE(metadata, '{}'::jsonb);

DELETE FROM platform_revenue_log WHERE id IS NULL;

ALTER TABLE platform_revenue_log
  ALTER COLUMN id               SET NOT NULL,
  ALTER COLUMN channel          SET NOT NULL,
  ALTER COLUMN status           SET NOT NULL,
  ALTER COLUMN status           SET DEFAULT 'completed',
  ALTER COLUMN gross_amount     SET DEFAULT 0,
  ALTER COLUMN platform_revenue SET DEFAULT 0,
  ALTER COLUMN payout_amount    SET DEFAULT 0,
  ALTER COLUMN commission_rate  SET DEFAULT 0,
  ALTER COLUMN metadata         SET DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_revenue_log_pkey'
  ) THEN
    ALTER TABLE platform_revenue_log ADD PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE platform_revenue_log DROP COLUMN IF EXISTS data;

-- Step 6: Indexes (для admin listing + stats aggregation).
CREATE INDEX IF NOT EXISTS idx_prl_created
  ON platform_revenue_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prl_channel_created
  ON platform_revenue_log(channel, created_at DESC);
-- Partial — для admin support (refund / pending review).
CREATE INDEX IF NOT EXISTS idx_prl_non_completed
  ON platform_revenue_log(status, created_at DESC) WHERE status <> 'completed';
