-- KV → SQL migration step 1: publish_orders + subscriptions
-- Applied on production 2026-05-17. Idempotent (IF NOT EXISTS).

BEGIN;

-- publish_orders
ALTER TABLE publish_orders
  ADD COLUMN IF NOT EXISTS status            TEXT,
  ADD COLUMN IF NOT EXISTS type              TEXT,
  ADD COLUMN IF NOT EXISTS title             TEXT,
  ADD COLUMN IF NOT EXISTS plan              TEXT,
  ADD COLUMN IF NOT EXISTS price             NUMERIC,
  ADD COLUMN IF NOT EXISTS currency          TEXT DEFAULT $$RUB$$,
  ADD COLUMN IF NOT EXISTS event_date        DATE,
  ADD COLUMN IF NOT EXISTS published_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS moderated_at      TIMESTAMPTZ;

UPDATE publish_orders SET
  status=COALESCE(status, data->>$$status$$), type=COALESCE(type, data->>$$type$$),
  title=COALESCE(title, data->>$$title$$), plan=COALESCE(plan, data->>$$plan$$),
  price=COALESCE(price, NULLIF(data->>$$price$$,$$$$)::numeric),
  currency=COALESCE(currency, data->>$$currency$$),
  event_date=COALESCE(event_date, NULLIF(data->>$$eventDate$$,$$$$)::date),
  published_at=COALESCE(published_at, NULLIF(data->>$$publishedAt$$,$$$$)::timestamptz),
  paid_at=COALESCE(paid_at, NULLIF(data->>$$paidAt$$,$$$$)::timestamptz),
  moderated_at=COALESCE(moderated_at, NULLIF(data->>$$moderatedAt$$,$$$$)::timestamptz)
WHERE data IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_publish_orders_status      ON publish_orders(status);
CREATE INDEX IF NOT EXISTS idx_publish_orders_type        ON publish_orders(type);
CREATE INDEX IF NOT EXISTS idx_publish_orders_event_date  ON publish_orders(event_date);
CREATE INDEX IF NOT EXISTS idx_publish_orders_updated_at  ON publish_orders(updated_at DESC);

CREATE OR REPLACE FUNCTION sync_publish_orders_native() RETURNS trigger AS \$func\$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = $$object$$ THEN
    NEW.status        = COALESCE(NEW.status,        NEW.data->>$$status$$);
    NEW.type          = COALESCE(NEW.type,          NEW.data->>$$type$$);
    NEW.title         = COALESCE(NEW.title,         NEW.data->>$$title$$);
    NEW.plan          = COALESCE(NEW.plan,          NEW.data->>$$plan$$);
    NEW.price         = COALESCE(NEW.price,         NULLIF(NEW.data->>$$price$$,$$$$)::numeric);
    NEW.currency      = COALESCE(NEW.currency,      NEW.data->>$$currency$$, $$RUB$$);
    NEW.event_date    = COALESCE(NEW.event_date,    NULLIF(NEW.data->>$$eventDate$$,$$$$)::date);
    NEW.published_at  = COALESCE(NEW.published_at,  NULLIF(NEW.data->>$$publishedAt$$,$$$$)::timestamptz);
    NEW.paid_at       = COALESCE(NEW.paid_at,       NULLIF(NEW.data->>$$paidAt$$,$$$$)::timestamptz);
    NEW.moderated_at  = COALESCE(NEW.moderated_at,  NULLIF(NEW.data->>$$moderatedAt$$,$$$$)::timestamptz);
  END IF;
  RETURN NEW;
END;
\$func\$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_publish_orders ON publish_orders;
CREATE TRIGGER trg_sync_publish_orders BEFORE INSERT OR UPDATE ON publish_orders
FOR EACH ROW EXECUTE FUNCTION sync_publish_orders_native();

-- subscriptions
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS tier              TEXT,
  ADD COLUMN IF NOT EXISTS tier_name         TEXT,
  ADD COLUMN IF NOT EXISTS status            TEXT,
  ADD COLUMN IF NOT EXISTS interval          TEXT,
  ADD COLUMN IF NOT EXISTS price             NUMERIC,
  ADD COLUMN IF NOT EXISTS expires_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credits_remaining INT,
  ADD COLUMN IF NOT EXISTS credits_per_month INT,
  ADD COLUMN IF NOT EXISTS donation_fee      NUMERIC;

CREATE INDEX IF NOT EXISTS idx_subscriptions_status     ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tier       ON subscriptions(tier);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at ON subscriptions(expires_at);

CREATE OR REPLACE FUNCTION sync_subscriptions_native() RETURNS trigger AS \$func\$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = $$object$$ THEN
    NEW.tier              = COALESCE(NEW.tier,              NEW.data->>$$tier$$);
    NEW.tier_name         = COALESCE(NEW.tier_name,         NEW.data->>$$tierName$$);
    NEW.status            = COALESCE(NEW.status,            NEW.data->>$$status$$);
    NEW.interval          = COALESCE(NEW.interval,          NEW.data->>$$interval$$);
    NEW.price             = COALESCE(NEW.price,             NULLIF(NEW.data->>$$price$$,$$$$)::numeric);
    NEW.expires_at        = COALESCE(NEW.expires_at,        NULLIF(NEW.data->>$$expires_at$$,$$$$)::timestamptz);
    NEW.credits_remaining = COALESCE(NEW.credits_remaining, NULLIF(NEW.data->>$$credits_remaining$$,$$$$)::int);
    NEW.credits_per_month = COALESCE(NEW.credits_per_month, NULLIF(NEW.data->>$$credits_per_month$$,$$$$)::int);
    NEW.donation_fee      = COALESCE(NEW.donation_fee,      NULLIF(NEW.data->>$$donation_fee$$,$$$$)::numeric);
  END IF;
  RETURN NEW;
END;
\$func\$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_subscriptions ON subscriptions;
CREATE TRIGGER trg_sync_subscriptions BEFORE INSERT OR UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION sync_subscriptions_native();

COMMIT;
