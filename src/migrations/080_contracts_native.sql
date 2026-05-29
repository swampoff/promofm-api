-- Migration 080 — contracts: kill data jsonb, promote metadata; milestones jsonb.
--
-- Context:
--   contracts table — milestone-based contracts для service orders
--   (marketplace). 6 callers, все в src/marketplace-routes.tsx.
--   Store key = orderId (1:1 с service_orders). Лookup pattern:
--   contractsStore.get(orderId).
--
-- Native design:
--   - id PK (contract id 'ctr-uuid')
--   - order_id TEXT UNIQUE — 1:1 lookup paт same idx
--   - producer_id, client_id, total_amount, paid_amount, status, …
--   - milestones JSONB (per-stage shape — title/desc/amount/dueDate/
--     status/paidAt/completedAt). Per CLAUDE.md «extra JSONB для legit
--     nested data» — milestones это array of stages с varying structure.
--
-- Out of scope: row-per-milestone refactor (требует API change на
-- frontend — milestone status updates). Сейчас milestones остаются в
-- jsonb, update идёт через read-modify-write (race возможна но scope
-- limited — две стороны одного контракта race'ятся редко).
--
-- Idempotent. NO BEGIN/COMMIT в файле.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS order_id      TEXT,
  ADD COLUMN IF NOT EXISTS service_title TEXT,
  ADD COLUMN IF NOT EXISTS producer_id   TEXT,
  ADD COLUMN IF NOT EXISTS producer_name TEXT,
  ADD COLUMN IF NOT EXISTS client_id     TEXT,
  ADD COLUMN IF NOT EXISTS client_name   TEXT,
  ADD COLUMN IF NOT EXISTS total_amount  NUMERIC,
  ADD COLUMN IF NOT EXISTS paid_amount   NUMERIC,
  ADD COLUMN IF NOT EXISTS status        TEXT,
  ADD COLUMN IF NOT EXISTS milestones    JSONB,
  ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ;

-- Backfill from data jsonb (object и string-encoded both handled —
-- handler писал JSON.stringify(contract) в .set, см. marketplace-routes:1132).
-- Note: store key = order_id, so backfill order_id из id column как fallback.
UPDATE contracts SET
  order_id      = COALESCE(order_id, data->>'orderId',
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN (data#>>'{}')::jsonb->>'orderId'
                                 ELSE NULL END), id),
  service_title = COALESCE(service_title, data->>'serviceTitle',
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN (data#>>'{}')::jsonb->>'serviceTitle'
                                 ELSE NULL END)),
  producer_id   = COALESCE(producer_id, data->>'producerId',
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN (data#>>'{}')::jsonb->>'producerId'
                                 ELSE NULL END)),
  producer_name = COALESCE(producer_name, data->>'producerName',
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN (data#>>'{}')::jsonb->>'producerName'
                                 ELSE NULL END)),
  client_id     = COALESCE(client_id, data->>'clientId',
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN (data#>>'{}')::jsonb->>'clientId'
                                 ELSE NULL END)),
  client_name   = COALESCE(client_name, data->>'clientName',
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN (data#>>'{}')::jsonb->>'clientName'
                                 ELSE NULL END)),
  total_amount  = COALESCE(total_amount, NULLIF(data->>'totalAmount','')::numeric,
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN NULLIF((data#>>'{}')::jsonb->>'totalAmount','')::numeric
                                 ELSE NULL END), 0),
  paid_amount   = COALESCE(paid_amount, NULLIF(data->>'paidAmount','')::numeric,
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN NULLIF((data#>>'{}')::jsonb->>'paidAmount','')::numeric
                                 ELSE NULL END), 0),
  status        = COALESCE(status, data->>'status',
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN (data#>>'{}')::jsonb->>'status'
                                 ELSE NULL END), 'active'),
  milestones    = COALESCE(milestones,
                           CASE WHEN jsonb_typeof(data) = 'object' THEN data->'milestones'
                                WHEN jsonb_typeof(data) = 'string' THEN (data#>>'{}')::jsonb->'milestones'
                                ELSE NULL END,
                           '[]'::jsonb),
  completed_at  = COALESCE(completed_at, NULLIF(data->>'completedAt','')::timestamptz,
                           (CASE WHEN jsonb_typeof(data) = 'string'
                                 THEN NULLIF((data#>>'{}')::jsonb->>'completedAt','')::timestamptz
                                 ELSE NULL END))
WHERE data IS NOT NULL;

-- Orphans
DELETE FROM contracts WHERE order_id IS NULL;

-- Defaults + NOT NULL
ALTER TABLE contracts
  ALTER COLUMN total_amount SET DEFAULT 0,
  ALTER COLUMN paid_amount  SET DEFAULT 0,
  ALTER COLUMN status       SET DEFAULT 'active',
  ALTER COLUMN milestones   SET DEFAULT '[]'::jsonb;

UPDATE contracts SET
  total_amount = COALESCE(total_amount, 0),
  paid_amount  = COALESCE(paid_amount, 0),
  status       = COALESCE(status, 'active'),
  milestones   = COALESCE(milestones, '[]'::jsonb);

ALTER TABLE contracts
  ALTER COLUMN order_id     SET NOT NULL,
  ALTER COLUMN total_amount SET NOT NULL,
  ALTER COLUMN paid_amount  SET NOT NULL,
  ALTER COLUMN status       SET NOT NULL,
  ALTER COLUMN milestones   SET NOT NULL;

-- UNIQUE на order_id (1:1 с service_orders, prevent duplicate contracts).
CREATE UNIQUE INDEX IF NOT EXISTS uq_contracts_order_id
  ON contracts(order_id);

-- DROP data
ALTER TABLE contracts DROP COLUMN IF EXISTS data;

-- Hot-path indexes для future "my contracts" lists
CREATE INDEX IF NOT EXISTS idx_contracts_producer
  ON contracts(producer_id, created_at DESC) WHERE producer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contracts_client
  ON contracts(client_id, created_at DESC) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contracts_status
  ON contracts(status);
