-- KV → SQL migration step 2: notifications, support_tickets, beats, beat_purchases, donations
BEGIN;

-- ── notifications (2932 rows) ──────────────────────────
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS type     TEXT,
  ADD COLUMN IF NOT EXISTS title    TEXT,
  ADD COLUMN IF NOT EXISTS read_flag BOOLEAN DEFAULT false;

UPDATE notifications SET
  type      = COALESCE(type,      data->>'type'),
  title     = COALESCE(title,     data->>'title'),
  read_flag = COALESCE(read_flag, (data->>'read')::boolean)
WHERE data IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_type  ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_read  ON notifications(read_flag) WHERE read_flag = false;

CREATE OR REPLACE FUNCTION sync_notifications_native() RETURNS trigger AS $func$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.type      = COALESCE(NEW.type,      NEW.data->>'type');
    NEW.title     = COALESCE(NEW.title,     NEW.data->>'title');
    NEW.read_flag = COALESCE(NEW.read_flag, (NEW.data->>'read')::boolean);
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_notifications ON notifications;
CREATE TRIGGER trg_sync_notifications BEFORE INSERT OR UPDATE ON notifications
FOR EACH ROW EXECUTE FUNCTION sync_notifications_native();

-- ── support_tickets (1 row) ────────────────────────────
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS status      TEXT,
  ADD COLUMN IF NOT EXISTS priority    TEXT,
  ADD COLUMN IF NOT EXISTS category    TEXT,
  ADD COLUMN IF NOT EXISTS subject     TEXT,
  ADD COLUMN IF NOT EXISTS assigned_to TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at   TIMESTAMPTZ;

UPDATE support_tickets SET
  status      = COALESCE(status,      data->>'status'),
  priority    = COALESCE(priority,    data->>'priority'),
  category    = COALESCE(category,    data->>'category'),
  subject     = COALESCE(subject,     data->>'subject'),
  assigned_to = COALESCE(assigned_to, data->>'assigned_to'),
  resolved_at = COALESCE(resolved_at, NULLIF(data->>'resolved_at','')::timestamptz),
  closed_at   = COALESCE(closed_at,   NULLIF(data->>'closed_at','')::timestamptz)
WHERE data IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_tickets_status   ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned ON support_tickets(assigned_to);

CREATE OR REPLACE FUNCTION sync_support_tickets_native() RETURNS trigger AS $func$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.status      = COALESCE(NEW.status,      NEW.data->>'status');
    NEW.priority    = COALESCE(NEW.priority,    NEW.data->>'priority');
    NEW.category    = COALESCE(NEW.category,    NEW.data->>'category');
    NEW.subject     = COALESCE(NEW.subject,     NEW.data->>'subject');
    NEW.assigned_to = COALESCE(NEW.assigned_to, NEW.data->>'assigned_to');
    NEW.resolved_at = COALESCE(NEW.resolved_at, NULLIF(NEW.data->>'resolved_at','')::timestamptz);
    NEW.closed_at   = COALESCE(NEW.closed_at,   NULLIF(NEW.data->>'closed_at','')::timestamptz);
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_support_tickets ON support_tickets;
CREATE TRIGGER trg_sync_support_tickets BEFORE INSERT OR UPDATE ON support_tickets
FOR EACH ROW EXECUTE FUNCTION sync_support_tickets_native();

-- ── beats ────────────────────────────
ALTER TABLE beats
  ADD COLUMN IF NOT EXISTS title       TEXT,
  ADD COLUMN IF NOT EXISTS genre       TEXT,
  ADD COLUMN IF NOT EXISTS bpm         INT,
  ADD COLUMN IF NOT EXISTS key_signature TEXT,
  ADD COLUMN IF NOT EXISTS duration    INT,
  ADD COLUMN IF NOT EXISTS price       NUMERIC,
  ADD COLUMN IF NOT EXISTS plays       INT,
  ADD COLUMN IF NOT EXISTS likes       INT,
  ADD COLUMN IF NOT EXISTS rating      NUMERIC,
  ADD COLUMN IF NOT EXISTS producer_id TEXT;

UPDATE beats SET
  title       = COALESCE(title,       data->>'title'),
  genre       = COALESCE(genre,       data->>'genre'),
  bpm         = COALESCE(bpm,         NULLIF(data->>'bpm','')::int),
  key_signature = COALESCE(key_signature, data->>'key'),
  duration    = COALESCE(duration,    NULLIF(data->>'duration','')::int),
  price       = COALESCE(price,       NULLIF(data->>'price','')::numeric),
  plays       = COALESCE(plays,       NULLIF(data->>'plays','')::int),
  likes       = COALESCE(likes,       NULLIF(data->>'likes','')::int),
  rating      = COALESCE(rating,      NULLIF(data->>'rating','')::numeric),
  producer_id = COALESCE(producer_id, data->>'producerId')
WHERE data IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_beats_genre       ON beats(genre);
CREATE INDEX IF NOT EXISTS idx_beats_producer_id ON beats(producer_id);
CREATE INDEX IF NOT EXISTS idx_beats_bpm         ON beats(bpm);

CREATE OR REPLACE FUNCTION sync_beats_native() RETURNS trigger AS $func$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.title       = COALESCE(NEW.title,       NEW.data->>'title');
    NEW.genre       = COALESCE(NEW.genre,       NEW.data->>'genre');
    NEW.bpm         = COALESCE(NEW.bpm,         NULLIF(NEW.data->>'bpm','')::int);
    NEW.key_signature = COALESCE(NEW.key_signature, NEW.data->>'key');
    NEW.duration    = COALESCE(NEW.duration,    NULLIF(NEW.data->>'duration','')::int);
    NEW.price       = COALESCE(NEW.price,       NULLIF(NEW.data->>'price','')::numeric);
    NEW.plays       = COALESCE(NEW.plays,       NULLIF(NEW.data->>'plays','')::int);
    NEW.likes       = COALESCE(NEW.likes,       NULLIF(NEW.data->>'likes','')::int);
    NEW.rating      = COALESCE(NEW.rating,      NULLIF(NEW.data->>'rating','')::numeric);
    NEW.producer_id = COALESCE(NEW.producer_id, NEW.data->>'producerId');
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_beats ON beats;
CREATE TRIGGER trg_sync_beats BEFORE INSERT OR UPDATE ON beats
FOR EACH ROW EXECUTE FUNCTION sync_beats_native();

-- ── beat_purchases ────────────────────────────
ALTER TABLE beat_purchases
  ADD COLUMN IF NOT EXISTS beat_id      TEXT,
  ADD COLUMN IF NOT EXISTS buyer_id     TEXT,
  ADD COLUMN IF NOT EXISTS amount       NUMERIC,
  ADD COLUMN IF NOT EXISTS license_type TEXT,
  ADD COLUMN IF NOT EXISTS status       TEXT;

UPDATE beat_purchases SET
  beat_id      = COALESCE(beat_id,      data->>'beatId'),
  buyer_id     = COALESCE(buyer_id,     data->>'buyerId'),
  amount       = COALESCE(amount,       NULLIF(data->>'amount','')::numeric),
  license_type = COALESCE(license_type, data->>'licenseType'),
  status       = COALESCE(status,       data->>'status')
WHERE data IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_beat_purchases_buyer ON beat_purchases(buyer_id);
CREATE INDEX IF NOT EXISTS idx_beat_purchases_beat  ON beat_purchases(beat_id);

CREATE OR REPLACE FUNCTION sync_beat_purchases_native() RETURNS trigger AS $func$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.beat_id      = COALESCE(NEW.beat_id,      NEW.data->>'beatId');
    NEW.buyer_id     = COALESCE(NEW.buyer_id,     NEW.data->>'buyerId');
    NEW.amount       = COALESCE(NEW.amount,       NULLIF(NEW.data->>'amount','')::numeric);
    NEW.license_type = COALESCE(NEW.license_type, NEW.data->>'licenseType');
    NEW.status       = COALESCE(NEW.status,       NEW.data->>'status');
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_beat_purchases ON beat_purchases;
CREATE TRIGGER trg_sync_beat_purchases BEFORE INSERT OR UPDATE ON beat_purchases
FOR EACH ROW EXECUTE FUNCTION sync_beat_purchases_native();

-- ── donations (0 rows — just schema for future) ────────────────────────────
ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS donor_id   TEXT,
  ADD COLUMN IF NOT EXISTS artist_id  TEXT,
  ADD COLUMN IF NOT EXISTS amount     NUMERIC,
  ADD COLUMN IF NOT EXISTS status     TEXT,
  ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS paid_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_donations_donor   ON donations(donor_id);
CREATE INDEX IF NOT EXISTS idx_donations_artist  ON donations(artist_id);
CREATE INDEX IF NOT EXISTS idx_donations_status  ON donations(status);

CREATE OR REPLACE FUNCTION sync_donations_native() RETURNS trigger AS $func$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.donor_id     = COALESCE(NEW.donor_id,     NEW.data->>'donorId');
    NEW.artist_id    = COALESCE(NEW.artist_id,    NEW.data->>'artistId');
    NEW.amount       = COALESCE(NEW.amount,       NULLIF(NEW.data->>'amount','')::numeric);
    NEW.status       = COALESCE(NEW.status,       NEW.data->>'status');
    NEW.is_anonymous = COALESCE(NEW.is_anonymous, (NEW.data->>'isAnonymous')::boolean);
    NEW.paid_at      = COALESCE(NEW.paid_at,      NULLIF(NEW.data->>'paidAt','')::timestamptz);
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_donations ON donations;
CREATE TRIGGER trg_sync_donations BEFORE INSERT OR UPDATE ON donations
FOR EACH ROW EXECUTE FUNCTION sync_donations_native();

COMMIT;

\echo ''
\echo '=== Verify backfill ==='
SELECT 'notifications' AS t, COUNT(*) FILTER (WHERE type IS NOT NULL) AS backfilled, COUNT(*) AS total FROM notifications
UNION ALL SELECT 'support_tickets', COUNT(*) FILTER (WHERE status IS NOT NULL), COUNT(*) FROM support_tickets
UNION ALL SELECT 'beats', COUNT(*) FILTER (WHERE title IS NOT NULL), COUNT(*) FROM beats
UNION ALL SELECT 'beat_purchases', COUNT(*) FILTER (WHERE beat_id IS NOT NULL), COUNT(*) FROM beat_purchases
UNION ALL SELECT 'donations', COUNT(*) FILTER (WHERE artist_id IS NOT NULL), COUNT(*) FROM donations;
