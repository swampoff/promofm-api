-- Step 3 — agent_sessions (43), curator_reports (21), и pre-emptive миграция
-- центральных flow-таблиц (0 rows но критичные пути): track_moderation,
-- payment_withdrawals, production_360_orders.
-- Per-table BEGIN/COMMIT.

-- =====================================================================
-- 1. agent_sessions — runs ИИ-агентов, нужно фильтровать по status/mode
-- =====================================================================
BEGIN;
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS mode TEXT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS error_count INTEGER,
  ADD COLUMN IF NOT EXISTS agent_count INTEGER,
  ADD COLUMN IF NOT EXISTS session_type TEXT;

UPDATE agent_sessions SET
  status            = COALESCE(status, data->>'status'),
  mode              = COALESCE(mode, data->>'mode'),
  started_at        = COALESCE(started_at, NULLIF(data->>'startedAt','')::timestamptz),
  completed_at      = COALESCE(completed_at, NULLIF(data->>'completedAt','')::timestamptz),
  total_latency_ms  = COALESCE(total_latency_ms, NULLIF(data->>'totalLatencyMs','')::integer),
  error_count       = COALESCE(error_count, NULLIF(data->>'errorCount','')::integer),
  agent_count       = COALESCE(agent_count, NULLIF(data->>'agentCount','')::integer),
  session_type      = COALESCE(session_type, data->>'type')
WHERE data IS NOT NULL AND jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_agent_sessions_status     ON agent_sessions(status);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_mode       ON agent_sessions(mode);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_at ON agent_sessions(started_at DESC);

CREATE OR REPLACE FUNCTION sync_agent_sessions_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.status            := COALESCE(NEW.status,            NEW.data->>'status');
    NEW.mode              := COALESCE(NEW.mode,              NEW.data->>'mode');
    NEW.started_at        := COALESCE(NEW.started_at,        NULLIF(NEW.data->>'startedAt','')::timestamptz);
    NEW.completed_at      := COALESCE(NEW.completed_at,      NULLIF(NEW.data->>'completedAt','')::timestamptz);
    NEW.total_latency_ms  := COALESCE(NEW.total_latency_ms,  NULLIF(NEW.data->>'totalLatencyMs','')::integer);
    NEW.error_count       := COALESCE(NEW.error_count,       NULLIF(NEW.data->>'errorCount','')::integer);
    NEW.agent_count       := COALESCE(NEW.agent_count,       NULLIF(NEW.data->>'agentCount','')::integer);
    NEW.session_type      := COALESCE(NEW.session_type,      NEW.data->>'type');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_agent_sessions ON agent_sessions;
CREATE TRIGGER trg_sync_agent_sessions BEFORE INSERT OR UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION sync_agent_sessions_native();
COMMIT;

-- =====================================================================
-- 2. curator_reports — отчёты curator-агентов, фильтр по role/passed
-- =====================================================================
BEGIN;
ALTER TABLE curator_reports
  ADD COLUMN IF NOT EXISTS role TEXT,
  ADD COLUMN IF NOT EXISTS role_name TEXT,
  ADD COLUMN IF NOT EXISTS passed INTEGER,
  ADD COLUMN IF NOT EXISTS failed INTEGER,
  ADD COLUMN IF NOT EXISTS total_endpoints INTEGER,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

UPDATE curator_reports SET
  role            = COALESCE(role, data->>'role'),
  role_name       = COALESCE(role_name, data->>'roleName'),
  passed          = COALESCE(passed, NULLIF(data->>'passed','')::integer),
  failed          = COALESCE(failed, NULLIF(data->>'failed','')::integer),
  total_endpoints = COALESCE(total_endpoints, NULLIF(data->>'totalEndpoints','')::integer),
  started_at      = COALESCE(started_at, NULLIF(data->>'startedAt','')::timestamptz)
WHERE data IS NOT NULL AND jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_curator_reports_role       ON curator_reports(role);
CREATE INDEX IF NOT EXISTS idx_curator_reports_started_at ON curator_reports(started_at DESC);

CREATE OR REPLACE FUNCTION sync_curator_reports_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.role            := COALESCE(NEW.role,            NEW.data->>'role');
    NEW.role_name       := COALESCE(NEW.role_name,       NEW.data->>'roleName');
    NEW.passed          := COALESCE(NEW.passed,          NULLIF(NEW.data->>'passed','')::integer);
    NEW.failed          := COALESCE(NEW.failed,          NULLIF(NEW.data->>'failed','')::integer);
    NEW.total_endpoints := COALESCE(NEW.total_endpoints, NULLIF(NEW.data->>'totalEndpoints','')::integer);
    NEW.started_at      := COALESCE(NEW.started_at,      NULLIF(NEW.data->>'startedAt','')::timestamptz);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_curator_reports ON curator_reports;
CREATE TRIGGER trg_sync_curator_reports BEFORE INSERT OR UPDATE ON curator_reports
  FOR EACH ROW EXECUTE FUNCTION sync_curator_reports_native();
COMMIT;

-- =====================================================================
-- 3. track_moderation (0 rows, ЦЕНТРАЛЬНЫЙ flow модерации треков)
--    Pre-emptive: индексы будут готовы когда поток данных начнётся
-- =====================================================================
BEGIN;
ALTER TABLE track_moderation
  ADD COLUMN IF NOT EXISTS track_id TEXT,
  ADD COLUMN IF NOT EXISTS artist_id TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS moderator_id TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS ai_check_status TEXT;

CREATE INDEX IF NOT EXISTS idx_track_moderation_status       ON track_moderation(status);
CREATE INDEX IF NOT EXISTS idx_track_moderation_track        ON track_moderation(track_id);
CREATE INDEX IF NOT EXISTS idx_track_moderation_artist       ON track_moderation(artist_id);
CREATE INDEX IF NOT EXISTS idx_track_moderation_submitted_at ON track_moderation(submitted_at DESC);

CREATE OR REPLACE FUNCTION sync_track_moderation_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.track_id         := COALESCE(NEW.track_id,         NEW.data->>'trackId',     NEW.data->>'track_id');
    NEW.artist_id        := COALESCE(NEW.artist_id,        NEW.data->>'artistId',    NEW.data->>'artist_id');
    NEW.status           := COALESCE(NEW.status,           NEW.data->>'status');
    NEW.moderator_id     := COALESCE(NEW.moderator_id,     NEW.data->>'moderatorId', NEW.data->>'moderator_id');
    NEW.submitted_at     := COALESCE(NEW.submitted_at,     NULLIF(NEW.data->>'submittedAt','')::timestamptz, NULLIF(NEW.data->>'submitted_at','')::timestamptz);
    NEW.moderated_at     := COALESCE(NEW.moderated_at,     NULLIF(NEW.data->>'moderatedAt','')::timestamptz, NULLIF(NEW.data->>'moderated_at','')::timestamptz);
    NEW.rejection_reason := COALESCE(NEW.rejection_reason, NEW.data->>'rejectionReason', NEW.data->>'rejection_reason');
    NEW.ai_check_status  := COALESCE(NEW.ai_check_status,  NEW.data->>'aiCheckStatus',   NEW.data->>'ai_check_status');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_track_moderation ON track_moderation;
CREATE TRIGGER trg_sync_track_moderation BEFORE INSERT OR UPDATE ON track_moderation
  FOR EACH ROW EXECUTE FUNCTION sync_track_moderation_native();
COMMIT;

-- =====================================================================
-- 4. payment_withdrawals (0 rows, flow вывода средств)
-- =====================================================================
BEGIN;
ALTER TABLE payment_withdrawals
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS amount NUMERIC,
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS method TEXT,
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payment_withdrawals_user         ON payment_withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_withdrawals_status       ON payment_withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_payment_withdrawals_requested_at ON payment_withdrawals(requested_at DESC);

CREATE OR REPLACE FUNCTION sync_payment_withdrawals_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.user_id      := COALESCE(NEW.user_id,      NEW.data->>'userId',      NEW.data->>'user_id');
    NEW.amount       := COALESCE(NEW.amount,       NULLIF(NEW.data->>'amount','')::numeric);
    NEW.currency     := COALESCE(NEW.currency,     NEW.data->>'currency');
    NEW.status       := COALESCE(NEW.status,       NEW.data->>'status');
    NEW.method       := COALESCE(NEW.method,       NEW.data->>'method');
    NEW.requested_at := COALESCE(NEW.requested_at, NULLIF(NEW.data->>'requestedAt','')::timestamptz, NULLIF(NEW.data->>'requested_at','')::timestamptz);
    NEW.processed_at := COALESCE(NEW.processed_at, NULLIF(NEW.data->>'processedAt','')::timestamptz, NULLIF(NEW.data->>'processed_at','')::timestamptz);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_payment_withdrawals ON payment_withdrawals;
CREATE TRIGGER trg_sync_payment_withdrawals BEFORE INSERT OR UPDATE ON payment_withdrawals
  FOR EACH ROW EXECUTE FUNCTION sync_payment_withdrawals_native();
COMMIT;

-- =====================================================================
-- 5. production_360_orders (0 rows, custom production marketplace)
-- =====================================================================
BEGIN;
ALTER TABLE production_360_orders
  ADD COLUMN IF NOT EXISTS client_id TEXT,
  ADD COLUMN IF NOT EXISTS producer_id TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS service_type TEXT,
  ADD COLUMN IF NOT EXISTS price NUMERIC,
  ADD COLUMN IF NOT EXISTS deadline DATE,
  ADD COLUMN IF NOT EXISTS placed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_prod360_client    ON production_360_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_prod360_producer  ON production_360_orders(producer_id);
CREATE INDEX IF NOT EXISTS idx_prod360_status    ON production_360_orders(status);
CREATE INDEX IF NOT EXISTS idx_prod360_placed_at ON production_360_orders(placed_at DESC);

CREATE OR REPLACE FUNCTION sync_production_360_orders_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.client_id    := COALESCE(NEW.client_id,    NEW.data->>'clientId',    NEW.data->>'client_id');
    NEW.producer_id  := COALESCE(NEW.producer_id,  NEW.data->>'producerId',  NEW.data->>'producer_id');
    NEW.status       := COALESCE(NEW.status,       NEW.data->>'status');
    NEW.service_type := COALESCE(NEW.service_type, NEW.data->>'serviceType', NEW.data->>'service_type');
    NEW.price        := COALESCE(NEW.price,        NULLIF(NEW.data->>'price','')::numeric);
    NEW.placed_at    := COALESCE(NEW.placed_at,    NULLIF(NEW.data->>'placedAt','')::timestamptz, NULLIF(NEW.data->>'placed_at','')::timestamptz);
    IF NEW.deadline IS NULL AND COALESCE(NEW.data->>'deadline','') ~ '^\d{4}-\d{2}-\d{2}' THEN
      NEW.deadline := (NEW.data->>'deadline')::date;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_production_360_orders ON production_360_orders;
CREATE TRIGGER trg_sync_production_360_orders BEFORE INSERT OR UPDATE ON production_360_orders
  FOR EACH ROW EXECUTE FUNCTION sync_production_360_orders_native();
COMMIT;
