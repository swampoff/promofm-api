-- 057_marketplace_promote_jsonb_to_native.sql
--
-- producer_services + service_orders → native cols. DROP 2 derived
-- index tables (service_orders_by_client, service_orders_by_producer)
-- — заменяются индексами на client_id / producer_id в main service_orders.
--
-- Это закрывает marketplace cluster:
--   producer_services      — каталог услуг (id → service object)
--   service_orders         — заказы (id → order object)
--   service_orders_by_client/producer — DROP (derived from main.client_id/producer_id)
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d producer_services
--   \d service_orders
--   \d service_orders_by_client
--   \d service_orders_by_producer
--   SELECT COUNT(*) FROM producer_services;
--   SELECT COUNT(*) FROM service_orders;
--   SELECT polname FROM pg_policy
--    WHERE polrelid::regclass::text IN ('producer_services','service_orders');
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t producer_services -t service_orders -t service_orders_by_client
--               -t service_orders_by_producer promofm
--        > /tmp/marketplace_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/057_marketplace_promote_jsonb_to_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- ─── producer_services ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS producer_services (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE producer_services
  ADD COLUMN IF NOT EXISTS producer_id   TEXT,
  ADD COLUMN IF NOT EXISTS producer_name TEXT,
  ADD COLUMN IF NOT EXISTS title         TEXT,
  ADD COLUMN IF NOT EXISTS service_type  TEXT,
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS base_price    NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_days INTEGER       NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS status        TEXT          NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS orders_count  INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating        NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra         JSONB         NOT NULL DEFAULT '{}'::jsonb;

UPDATE producer_services SET
  producer_id   = COALESCE(producer_id,   NULLIF(data->>'producerId','')),
  producer_name = COALESCE(producer_name, NULLIF(data->>'producer','')),
  title         = COALESCE(title,         NULLIF(data->>'title','')),
  service_type  = COALESCE(service_type,  NULLIF(data->>'type','')),
  description   = COALESCE(description,   NULLIF(data->>'description','')),
  base_price    = CASE WHEN base_price = 0
                       AND (data->>'basePrice' IS NOT NULL OR data->>'price' IS NOT NULL)
                       THEN COALESCE(NULLIF(data->>'basePrice','')::numeric,
                                     NULLIF(data->>'price','')::numeric, 0)
                       ELSE base_price END,
  delivery_days = CASE WHEN delivery_days = 5 AND data->>'deliveryDays' IS NOT NULL
                       THEN COALESCE(NULLIF(data->>'deliveryDays','')::integer, 5)
                       ELSE delivery_days END,
  status        = CASE WHEN status = 'active' AND data->>'status' IS NOT NULL
                       THEN data->>'status'
                       ELSE status END,
  orders_count  = CASE WHEN orders_count = 0 AND data->>'orders' IS NOT NULL
                       THEN COALESCE(NULLIF(data->>'orders','')::integer, 0)
                       ELSE orders_count END,
  rating        = CASE WHEN rating = 0 AND data->>'rating' IS NOT NULL
                       THEN COALESCE(NULLIF(data->>'rating','')::numeric, 0)
                       ELSE rating END,
  extra         = CASE WHEN extra = '{}'::jsonb
                       THEN (data - 'producerId' - 'producer' - 'title' - 'type'
                                 - 'description' - 'basePrice' - 'price' - 'deliveryDays'
                                 - 'status' - 'orders' - 'rating' - 'id'
                                 - 'createdAt' - 'updatedAt')
                       ELSE extra END
WHERE jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_producer_services_active_rating
  ON producer_services(status, rating DESC, orders_count DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_producer_services_producer
  ON producer_services(producer_id)
  WHERE producer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_producer_services_type
  ON producer_services(service_type)
  WHERE service_type IS NOT NULL;

ALTER TABLE producer_services DROP COLUMN IF EXISTS data;

-- ─── service_orders ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_orders (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE service_orders
  ADD COLUMN IF NOT EXISTS service_id      TEXT,
  ADD COLUMN IF NOT EXISTS service_title   TEXT,
  ADD COLUMN IF NOT EXISTS service_type    TEXT,
  ADD COLUMN IF NOT EXISTS producer_id     TEXT,
  ADD COLUMN IF NOT EXISTS producer_name   TEXT,
  ADD COLUMN IF NOT EXISTS client_id       TEXT,
  ADD COLUMN IF NOT EXISTS client_name     TEXT,
  ADD COLUMN IF NOT EXISTS message         TEXT,
  ADD COLUMN IF NOT EXISTS details         TEXT,
  ADD COLUMN IF NOT EXISTS urgency         TEXT          NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS price           NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission      NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS producer_payout NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status          TEXT          NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS progress        INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status_message  TEXT,
  ADD COLUMN IF NOT EXISTS delivery_days   INTEGER       NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS deadline        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extra           JSONB         NOT NULL DEFAULT '{}'::jsonb;

UPDATE service_orders SET
  service_id      = COALESCE(service_id,      NULLIF(data->>'serviceId','')),
  service_title   = COALESCE(service_title,   NULLIF(data->>'serviceTitle','')),
  service_type    = COALESCE(service_type,    NULLIF(data->>'serviceType','')),
  producer_id     = COALESCE(producer_id,     NULLIF(data->>'producerId','')),
  producer_name   = COALESCE(producer_name,   NULLIF(data->>'producerName','')),
  client_id       = COALESCE(client_id,       NULLIF(data->>'clientId','')),
  client_name     = COALESCE(client_name,     NULLIF(data->>'clientName','')),
  message         = COALESCE(message,         NULLIF(data->>'message','')),
  details         = COALESCE(details,         NULLIF(data->>'details','')),
  urgency         = CASE WHEN urgency = 'normal' AND data->>'urgency' IS NOT NULL
                         THEN data->>'urgency'
                         ELSE urgency END,
  price           = CASE WHEN price = 0 AND data->>'price' IS NOT NULL
                         THEN COALESCE(NULLIF(data->>'price','')::numeric, 0)
                         ELSE price END,
  commission      = CASE WHEN commission = 0 AND data->>'commission' IS NOT NULL
                         THEN COALESCE(NULLIF(data->>'commission','')::numeric, 0)
                         ELSE commission END,
  producer_payout = CASE WHEN producer_payout = 0 AND data->>'producerPayout' IS NOT NULL
                         THEN COALESCE(NULLIF(data->>'producerPayout','')::numeric, 0)
                         ELSE producer_payout END,
  status          = CASE WHEN status = 'pending' AND data->>'status' IS NOT NULL
                         THEN data->>'status'
                         ELSE status END,
  progress        = CASE WHEN progress = 0 AND data->>'progress' IS NOT NULL
                         THEN COALESCE(NULLIF(data->>'progress','')::integer, 0)
                         ELSE progress END,
  status_message  = COALESCE(status_message,  NULLIF(data->>'statusMessage','')),
  delivery_days   = CASE WHEN delivery_days = 5 AND data->>'deliveryDays' IS NOT NULL
                         THEN COALESCE(NULLIF(data->>'deliveryDays','')::integer, 5)
                         ELSE delivery_days END,
  deadline        = COALESCE(deadline,        NULLIF(data->>'deadline','')::timestamptz),
  completed_at    = COALESCE(completed_at,    NULLIF(data->>'completedAt','')::timestamptz),
  extra           = CASE WHEN extra = '{}'::jsonb
                         THEN (data - 'serviceId' - 'serviceTitle' - 'serviceType'
                                   - 'producerId' - 'producerName' - 'clientId' - 'clientName'
                                   - 'message' - 'details' - 'urgency' - 'price'
                                   - 'commission' - 'producerPayout' - 'status' - 'progress'
                                   - 'statusMessage' - 'deliveryDays' - 'deadline'
                                   - 'completedAt' - 'id' - 'createdAt' - 'updatedAt')
                         ELSE extra END
WHERE jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_service_orders_client_created
  ON service_orders(client_id, created_at DESC)
  WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_orders_producer_created
  ON service_orders(producer_id, created_at DESC)
  WHERE producer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_orders_service
  ON service_orders(service_id, created_at DESC)
  WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_orders_active
  ON service_orders(status, created_at DESC)
  WHERE status IN ('pending', 'accepted', 'in_progress', 'revision');

ALTER TABLE service_orders DROP COLUMN IF EXISTS data;

-- ─── DROP redundant index tables ─────────────────────────────────────
-- Заменяются native idx_service_orders_client_created / _producer_created
-- индексами выше. 2 store'а в db.tsx становятся derived view'ями
-- (вторая половина PR — TS refactor).

DROP TABLE IF EXISTS service_orders_by_client;
DROP TABLE IF EXISTS service_orders_by_producer;
