-- Step 4 — operational flow tables. Per-table BEGIN/COMMIT.
-- Только id-keyed таблицы с object data; *_by_* (агрегаты) не мигрируем.

-- =====================================================================
-- 1. contracts — договоры с артистами/продюсерами
-- =====================================================================
BEGIN;
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS contract_type TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

UPDATE contracts SET
  user_id       = COALESCE(user_id, data->>'userId', data->>'user_id'),
  contract_type = COALESCE(contract_type, data->>'type', data->>'contractType'),
  status        = COALESCE(status, data->>'status'),
  title         = COALESCE(title, data->>'title'),
  signed_at     = COALESCE(signed_at, NULLIF(data->>'signedAt','')::timestamptz, NULLIF(data->>'signed_at','')::timestamptz),
  valid_until   = COALESCE(valid_until, NULLIF(data->>'validUntil','')::timestamptz, NULLIF(data->>'valid_until','')::timestamptz)
WHERE data IS NOT NULL AND jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_contracts_user      ON contracts(user_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status    ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_type      ON contracts(contract_type);
CREATE INDEX IF NOT EXISTS idx_contracts_signed_at ON contracts(signed_at DESC);

CREATE OR REPLACE FUNCTION sync_contracts_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.user_id       := COALESCE(NEW.user_id,       NEW.data->>'userId',     NEW.data->>'user_id');
    NEW.contract_type := COALESCE(NEW.contract_type, NEW.data->>'type',       NEW.data->>'contractType');
    NEW.status        := COALESCE(NEW.status,        NEW.data->>'status');
    NEW.title         := COALESCE(NEW.title,         NEW.data->>'title');
    NEW.signed_at     := COALESCE(NEW.signed_at,     NULLIF(NEW.data->>'signedAt','')::timestamptz,    NULLIF(NEW.data->>'signed_at','')::timestamptz);
    NEW.valid_until   := COALESCE(NEW.valid_until,   NULLIF(NEW.data->>'validUntil','')::timestamptz,  NULLIF(NEW.data->>'valid_until','')::timestamptz);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_contracts ON contracts;
CREATE TRIGGER trg_sync_contracts BEFORE INSERT OR UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION sync_contracts_native();
COMMIT;

-- =====================================================================
-- 2. email_history — отправленные emails
-- =====================================================================
BEGIN;
ALTER TABLE email_history
  ADD COLUMN IF NOT EXISTS recipient TEXT,
  ADD COLUMN IF NOT EXISTS template_id TEXT,
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

UPDATE email_history SET
  recipient   = COALESCE(recipient, data->>'recipient', data->>'to', data->>'email'),
  template_id = COALESCE(template_id, data->>'templateId', data->>'template_id'),
  subject     = COALESCE(subject, data->>'subject'),
  status      = COALESCE(status, data->>'status'),
  sent_at     = COALESCE(sent_at, NULLIF(data->>'sentAt','')::timestamptz, NULLIF(data->>'sent_at','')::timestamptz)
WHERE data IS NOT NULL AND jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_email_history_recipient ON email_history(recipient);
CREATE INDEX IF NOT EXISTS idx_email_history_status    ON email_history(status);
CREATE INDEX IF NOT EXISTS idx_email_history_sent_at   ON email_history(sent_at DESC);

CREATE OR REPLACE FUNCTION sync_email_history_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.recipient   := COALESCE(NEW.recipient,   NEW.data->>'recipient', NEW.data->>'to', NEW.data->>'email');
    NEW.template_id := COALESCE(NEW.template_id, NEW.data->>'templateId', NEW.data->>'template_id');
    NEW.subject     := COALESCE(NEW.subject,     NEW.data->>'subject');
    NEW.status      := COALESCE(NEW.status,      NEW.data->>'status');
    NEW.sent_at     := COALESCE(NEW.sent_at,     NULLIF(NEW.data->>'sentAt','')::timestamptz, NULLIF(NEW.data->>'sent_at','')::timestamptz);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_email_history ON email_history;
CREATE TRIGGER trg_sync_email_history BEFORE INSERT OR UPDATE ON email_history
  FOR EACH ROW EXECUTE FUNCTION sync_email_history_native();
COMMIT;

-- =====================================================================
-- 3. notification_campaigns — push/email кампании
-- =====================================================================
BEGIN;
ALTER TABLE notification_campaigns
  ADD COLUMN IF NOT EXISTS campaign_name TEXT,
  ADD COLUMN IF NOT EXISTS channel TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS audience_count INTEGER;

UPDATE notification_campaigns SET
  campaign_name  = COALESCE(campaign_name, data->>'name', data->>'campaignName'),
  channel        = COALESCE(channel, data->>'channel'),
  status         = COALESCE(status, data->>'status'),
  scheduled_at   = COALESCE(scheduled_at, NULLIF(data->>'scheduledAt','')::timestamptz, NULLIF(data->>'scheduled_at','')::timestamptz),
  sent_at        = COALESCE(sent_at, NULLIF(data->>'sentAt','')::timestamptz, NULLIF(data->>'sent_at','')::timestamptz),
  audience_count = COALESCE(audience_count, NULLIF(data->>'audienceCount','')::integer, NULLIF(data->>'audience_count','')::integer)
WHERE data IS NOT NULL AND jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_notif_campaigns_status       ON notification_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_notif_campaigns_channel      ON notification_campaigns(channel);
CREATE INDEX IF NOT EXISTS idx_notif_campaigns_scheduled_at ON notification_campaigns(scheduled_at);

CREATE OR REPLACE FUNCTION sync_notification_campaigns_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.campaign_name  := COALESCE(NEW.campaign_name,  NEW.data->>'name',         NEW.data->>'campaignName');
    NEW.channel        := COALESCE(NEW.channel,        NEW.data->>'channel');
    NEW.status         := COALESCE(NEW.status,         NEW.data->>'status');
    NEW.scheduled_at   := COALESCE(NEW.scheduled_at,   NULLIF(NEW.data->>'scheduledAt','')::timestamptz, NULLIF(NEW.data->>'scheduled_at','')::timestamptz);
    NEW.sent_at        := COALESCE(NEW.sent_at,        NULLIF(NEW.data->>'sentAt','')::timestamptz,      NULLIF(NEW.data->>'sent_at','')::timestamptz);
    NEW.audience_count := COALESCE(NEW.audience_count, NULLIF(NEW.data->>'audienceCount','')::integer,   NULLIF(NEW.data->>'audience_count','')::integer);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_notification_campaigns ON notification_campaigns;
CREATE TRIGGER trg_sync_notification_campaigns BEFORE INSERT OR UPDATE ON notification_campaigns
  FOR EACH ROW EXECUTE FUNCTION sync_notification_campaigns_native();
COMMIT;

-- =====================================================================
-- 4. track_test_all_requests — все заявки на track testing
-- =====================================================================
BEGIN;
ALTER TABLE track_test_all_requests
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS track_id TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS price NUMERIC,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

UPDATE track_test_all_requests SET
  user_id      = COALESCE(user_id, data->>'userId', data->>'user_id'),
  track_id     = COALESCE(track_id, data->>'trackId', data->>'track_id'),
  status       = COALESCE(status, data->>'status'),
  price        = COALESCE(price, NULLIF(data->>'price','')::numeric),
  submitted_at = COALESCE(submitted_at, NULLIF(data->>'submittedAt','')::timestamptz, NULLIF(data->>'submitted_at','')::timestamptz)
WHERE data IS NOT NULL AND jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_tt_all_user         ON track_test_all_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_tt_all_status       ON track_test_all_requests(status);
CREATE INDEX IF NOT EXISTS idx_tt_all_submitted_at ON track_test_all_requests(submitted_at DESC);

CREATE OR REPLACE FUNCTION sync_tt_all_requests_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.user_id      := COALESCE(NEW.user_id,      NEW.data->>'userId',  NEW.data->>'user_id');
    NEW.track_id     := COALESCE(NEW.track_id,     NEW.data->>'trackId', NEW.data->>'track_id');
    NEW.status       := COALESCE(NEW.status,       NEW.data->>'status');
    NEW.price        := COALESCE(NEW.price,        NULLIF(NEW.data->>'price','')::numeric);
    NEW.submitted_at := COALESCE(NEW.submitted_at, NULLIF(NEW.data->>'submittedAt','')::timestamptz, NULLIF(NEW.data->>'submitted_at','')::timestamptz);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_tt_all_requests ON track_test_all_requests;
CREATE TRIGGER trg_sync_tt_all_requests BEFORE INSERT OR UPDATE ON track_test_all_requests
  FOR EACH ROW EXECUTE FUNCTION sync_tt_all_requests_native();
COMMIT;

-- =====================================================================
-- 5. investor_inquiries — заявки инвесторов
-- =====================================================================
BEGIN;
ALTER TABLE investor_inquiries
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS company TEXT,
  ADD COLUMN IF NOT EXISTS investment_size TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE investor_inquiries SET
  email           = COALESCE(email, data->>'email'),
  name            = COALESCE(name, data->>'name'),
  company         = COALESCE(company, data->>'company'),
  investment_size = COALESCE(investment_size, data->>'investmentSize', data->>'investment_size'),
  status          = COALESCE(status, data->>'status')
WHERE data IS NOT NULL AND jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_investor_inquiries_status ON investor_inquiries(status);
CREATE INDEX IF NOT EXISTS idx_investor_inquiries_email  ON investor_inquiries(email);

CREATE OR REPLACE FUNCTION sync_investor_inquiries_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.email           := COALESCE(NEW.email,           NEW.data->>'email');
    NEW.name            := COALESCE(NEW.name,            NEW.data->>'name');
    NEW.company         := COALESCE(NEW.company,         NEW.data->>'company');
    NEW.investment_size := COALESCE(NEW.investment_size, NEW.data->>'investmentSize', NEW.data->>'investment_size');
    NEW.status          := COALESCE(NEW.status,          NEW.data->>'status');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_investor_inquiries ON investor_inquiries;
CREATE TRIGGER trg_sync_investor_inquiries BEFORE INSERT OR UPDATE ON investor_inquiries
  FOR EACH ROW EXECUTE FUNCTION sync_investor_inquiries_native();
COMMIT;
