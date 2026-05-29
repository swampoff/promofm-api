-- Migration 083 — ticket_sales: kill jsonb blob, native cols.
--
-- Context:
--   ticket_sales хранит продажи билетов на концерты. Сейчас (id PK, concert_id,
--   data jsonb) — `data` содержит TicketSale interface (8 scalar fields +
--   buyer_email + metadata).
--
--   4 callers в ticketing-routes.tsx.
--
-- Native design:
--   8 scalar cols + buyer_email + metadata jsonb (legit polymorphic — provider-
--   specific data: kassir.ru fields vs ticketland fields).
--
-- Bonus race fix:
--   PUT /sales/:saleId/cancel (line 296-307) делает getBySaleId + mutate +
--   upsert = read-modify-write. 2 concurrent cancel'а одного билета —
--   second перезаписывает first без updates. Native UPDATE WHERE id =
--   atomic.
--
-- Idempotent.

-- Bootstrap legacy table если её не существует (jsonbStore lazy-init).
CREATE TABLE IF NOT EXISTS ticket_sales (
  id TEXT PRIMARY KEY,
  concert_id TEXT,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ticket_sales
  ADD COLUMN IF NOT EXISTS artist_id      TEXT,
  ADD COLUMN IF NOT EXISTS provider       TEXT,
  ADD COLUMN IF NOT EXISTS quantity       INTEGER,
  ADD COLUMN IF NOT EXISTS price          NUMERIC,
  ADD COLUMN IF NOT EXISTS total_amount   NUMERIC,
  ADD COLUMN IF NOT EXISTS commission     NUMERIC,
  ADD COLUMN IF NOT EXISTS net_amount     NUMERIC,
  ADD COLUMN IF NOT EXISTS buyer_email    TEXT,
  ADD COLUMN IF NOT EXISTS status         TEXT,
  ADD COLUMN IF NOT EXISTS purchased_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata       JSONB;

-- Backfill из data jsonb (camelCase → snake_case). Handles object + string-encoded.
UPDATE ticket_sales SET
  concert_id   = COALESCE(concert_id, data->>'concertId',
                          CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'concertId' END),
  artist_id    = COALESCE(artist_id, data->>'artistId',
                          CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'artistId' END),
  provider     = COALESCE(provider, data->>'provider', 'manual'),
  quantity     = COALESCE(quantity,
                          NULLIF(data->>'quantity', '')::int, 1),
  price        = COALESCE(price,
                          NULLIF(data->>'price', '')::numeric, 0),
  total_amount = COALESCE(total_amount,
                          NULLIF(data->>'totalAmount', '')::numeric, 0),
  commission   = COALESCE(commission,
                          NULLIF(data->>'commission', '')::numeric, 0),
  net_amount   = COALESCE(net_amount,
                          NULLIF(data->>'netAmount', '')::numeric, 0),
  buyer_email  = COALESCE(buyer_email, NULLIF(data->>'buyerEmail', '')),
  status       = COALESCE(status, NULLIF(data->>'status', ''), 'confirmed'),
  purchased_at = COALESCE(purchased_at,
                          NULLIF(data->>'purchasedAt', '')::timestamptz,
                          created_at, NOW()),
  metadata     = COALESCE(metadata,
                          CASE WHEN jsonb_typeof(data->'metadata') = 'object'
                               THEN data->'metadata' ELSE NULL END,
                          '{}'::jsonb)
WHERE data IS NOT NULL;

-- Orphans cleanup — rows without minimal identifying fields.
DELETE FROM ticket_sales WHERE concert_id IS NULL;

ALTER TABLE ticket_sales
  ALTER COLUMN concert_id   SET NOT NULL,
  ALTER COLUMN provider     SET DEFAULT 'manual',
  ALTER COLUMN quantity     SET DEFAULT 1,
  ALTER COLUMN price        SET DEFAULT 0,
  ALTER COLUMN total_amount SET DEFAULT 0,
  ALTER COLUMN commission   SET DEFAULT 0,
  ALTER COLUMN net_amount   SET DEFAULT 0,
  ALTER COLUMN status       SET DEFAULT 'confirmed',
  ALTER COLUMN metadata     SET DEFAULT '{}'::jsonb;

UPDATE ticket_sales SET
  provider     = COALESCE(provider, 'manual'),
  quantity     = COALESCE(quantity, 1),
  price        = COALESCE(price, 0),
  total_amount = COALESCE(total_amount, 0),
  commission   = COALESCE(commission, 0),
  net_amount   = COALESCE(net_amount, 0),
  status       = COALESCE(status, 'confirmed'),
  metadata     = COALESCE(metadata, '{}'::jsonb);

ALTER TABLE ticket_sales
  ALTER COLUMN provider     SET NOT NULL,
  ALTER COLUMN quantity     SET NOT NULL,
  ALTER COLUMN price        SET NOT NULL,
  ALTER COLUMN total_amount SET NOT NULL,
  ALTER COLUMN commission   SET NOT NULL,
  ALTER COLUMN net_amount   SET NOT NULL,
  ALTER COLUMN status       SET NOT NULL,
  ALTER COLUMN metadata     SET NOT NULL;

ALTER TABLE ticket_sales DROP COLUMN IF EXISTS data;

-- Indexes:
-- 1. Hot-path: GET /sales/:concertId + stats + funnel.
CREATE INDEX IF NOT EXISTS idx_ticket_sales_concert
  ON ticket_sales(concert_id, purchased_at DESC);
-- 2. Status filter (confirmed/cancelled/refunded для stats).
CREATE INDEX IF NOT EXISTS idx_ticket_sales_concert_status
  ON ticket_sales(concert_id, status);
-- 3. Artist-level reporting (future).
CREATE INDEX IF NOT EXISTS idx_ticket_sales_artist
  ON ticket_sales(artist_id) WHERE artist_id IS NOT NULL;
