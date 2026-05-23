-- booking_calendar (1 row)
BEGIN;
ALTER TABLE booking_calendar
  ADD COLUMN IF NOT EXISTS date TEXT,
  ADD COLUMN IF NOT EXISTS performer_id TEXT,
  ADD COLUMN IF NOT EXISTS kv_created_at TEXT,
  ADD COLUMN IF NOT EXISTS performer_type TEXT,
  ADD COLUMN IF NOT EXISTS booking_id TEXT,
  ADD COLUMN IF NOT EXISTS is_available TEXT;

UPDATE booking_calendar SET
  date = COALESCE(date, data->>'date'),
  performer_id = COALESCE(performer_id, data->>'performerId'),
  kv_created_at = COALESCE(kv_created_at, data->>'createdAt'),
  performer_type = COALESCE(performer_type, data->>'performerType'),
  booking_id = COALESCE(booking_id, data->>'bookingId'),
  is_available = COALESCE(is_available, data->>'isAvailable')
WHERE data IS NOT NULL AND jsonb_typeof(data)='object';

CREATE INDEX IF NOT EXISTS idx_booking_calendar_performer ON booking_calendar(performer_id);
CREATE INDEX IF NOT EXISTS idx_booking_calendar_date ON booking_calendar(date);

CREATE OR REPLACE FUNCTION sync_booking_calendar_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data)='object' THEN
    NEW.date = COALESCE(NEW.date, NEW.data->>'date');
    NEW.performer_id = COALESCE(NEW.performer_id, NEW.data->>'performerId');
    NEW.kv_created_at = COALESCE(NEW.kv_created_at, NEW.data->>'createdAt');
    NEW.performer_type = COALESCE(NEW.performer_type, NEW.data->>'performerType');
    NEW.booking_id = COALESCE(NEW.booking_id, NEW.data->>'bookingId');
    NEW.is_available = COALESCE(NEW.is_available, NEW.data->>'isAvailable');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_booking_calendar ON booking_calendar;
CREATE TRIGGER trg_sync_booking_calendar BEFORE INSERT OR UPDATE ON booking_calendar
  FOR EACH ROW EXECUTE FUNCTION sync_booking_calendar_native();
COMMIT;

-- publish_email_prefs (1 row)
BEGIN;
ALTER TABLE publish_email_prefs
  ADD COLUMN IF NOT EXISTS user_id_kv TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS opt_out BOOLEAN,
  ADD COLUMN IF NOT EXISTS frequency TEXT;

UPDATE publish_email_prefs SET
  user_id_kv = COALESCE(user_id_kv, data->>'userId'),
  email = COALESCE(email, data->>'email'),
  opt_out = COALESCE(opt_out, (data->>'optOut')::boolean),
  frequency = COALESCE(frequency, data->>'frequency')
WHERE data IS NOT NULL AND jsonb_typeof(data)='object';

CREATE INDEX IF NOT EXISTS idx_publish_email_prefs_email ON publish_email_prefs(email);

CREATE OR REPLACE FUNCTION sync_publish_email_prefs_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data)='object' THEN
    NEW.user_id_kv = COALESCE(NEW.user_id_kv, NEW.data->>'userId');
    NEW.email = COALESCE(NEW.email, NEW.data->>'email');
    NEW.frequency = COALESCE(NEW.frequency, NEW.data->>'frequency');
    IF NEW.opt_out IS NULL AND NEW.data->>'optOut' IS NOT NULL THEN
      NEW.opt_out = (NEW.data->>'optOut')::boolean;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_publish_email_prefs ON publish_email_prefs;
CREATE TRIGGER trg_sync_publish_email_prefs BEFORE INSERT OR UPDATE ON publish_email_prefs
  FOR EACH ROW EXECUTE FUNCTION sync_publish_email_prefs_native();
COMMIT;
