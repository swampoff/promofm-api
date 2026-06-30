-- Migration 116: booking_payments idempotency (bug #10, from cloud bug-sweep)
--
-- checkout-routes.tsx INSERT INTO booking_payments ... ON CONFLICT DO NOTHING was
-- BARE (no target); the only unique was PK(id) = auto uuid → a conflict NEVER fired,
-- so a webhook RETRY (same gateway order) inserted a SECOND ledger row.
-- Fix: unique index on the gateway orderId (data->>'orderId') = the true payment
-- identity → a retry of the same payment conflicts → DO NOTHING (no code change,
-- the bare ON CONFLICT picks it up). Partial (orderId NOT NULL) so rows without an
-- orderId aren't constrained. Chosen over (booking_id,payment_type) which would
-- silently drop a legitimately-separate 2nd payment of the same type.
-- Applied to prod 2026-06-30 (table empty, no dups → safe). Idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_payments_order
  ON booking_payments ((data->>'orderId'))
  WHERE data->>'orderId' IS NOT NULL;
