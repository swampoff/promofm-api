-- 047_bookings_promote_jsonb_to_native.sql
--
-- Wave 3 #1 / 7: bookings — hybrid table с активным `data jsonb`
-- (full booking object stringified в data + дубль в native cols).
--
-- ❗ BUG ИСПРАВЛЯЕМ: booking-routes.tsx:222-226 query фильтрует по
-- `data->>'eventDate'` и `data->>'status'` ВМЕСТО native `event_date`
-- и `status` колонок которые уже есть. Это работало случайно — native
-- и data jsonb пишут одно и то же значение в upsertBooking. Но при
-- desync (например, ручная админ-правка только native) запрос врёт.
-- После миграции native — source of truth.
--
-- Audit grep show booking object имеет 35+ полей. Promote ВСЕ
-- из них в native + technical_requirements оставляется JSONB
-- (legit nested object).
--
-- BEFORE: native cols + `data: JSON.stringify(fullObject)`. Все reads
-- через `r.data || r` fallback. Writes — upsertBooking пишет данные
-- ДВАЖДЫ (native + data). Запросы фильтруют data->>'foo'.
--
-- AFTER: 30+ native cols. data column DROPped. mapBookingRow строит
-- API контракт из native + JOIN'ed profiles для populated objects
-- (performer/requester — derived, не stored snapshot).
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d bookings
--   SELECT COUNT(*) total,
--          COUNT(*) FILTER (WHERE data IS NOT NULL) with_data,
--          COUNT(DISTINCT data->>'status') statuses
--     FROM bookings;
--   SELECT polname FROM pg_policy WHERE polrelid::regclass::text='bookings';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t bookings promofm > /tmp/bookings_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/047_bookings_promote_jsonb_to_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Bootstrap legacy kv-store table if missing (lazy jsonbStore pattern).
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Promote все известные поля booking object → native columns.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS requester_type        TEXT,
  ADD COLUMN IF NOT EXISTS performer_type        TEXT,
  ADD COLUMN IF NOT EXISTS event_type            TEXT,
  ADD COLUMN IF NOT EXISTS event_title           TEXT,
  ADD COLUMN IF NOT EXISTS event_description     TEXT,
  ADD COLUMN IF NOT EXISTS start_time            TEXT,         -- HH:mm
  ADD COLUMN IF NOT EXISTS duration_hours        NUMERIC,
  ADD COLUMN IF NOT EXISTS venue_name            TEXT,
  ADD COLUMN IF NOT EXISTS venue_address         TEXT,
  ADD COLUMN IF NOT EXISTS venue_city            TEXT,
  ADD COLUMN IF NOT EXISTS venue_type            TEXT,
  ADD COLUMN IF NOT EXISTS expected_audience     INTEGER,
  ADD COLUMN IF NOT EXISTS audience_type         TEXT,
  ADD COLUMN IF NOT EXISTS performer_fee         NUMERIC,
  ADD COLUMN IF NOT EXISTS platform_commission   NUMERIC,
  ADD COLUMN IF NOT EXISTS deposit_percentage    NUMERIC,
  ADD COLUMN IF NOT EXISTS final_amount          NUMERIC,
  ADD COLUMN IF NOT EXISTS technical_requirements JSONB        DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS special_requests      TEXT,
  ADD COLUMN IF NOT EXISTS accepted_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_paid_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS final_paid_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by          TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by_role     TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason   TEXT,
  -- Lightweight marketplace flow (dj-marketplace-routes.tsx) добавляет:
  ADD COLUMN IF NOT EXISTS client_name           TEXT,
  ADD COLUMN IF NOT EXISTS client_email          TEXT,
  ADD COLUMN IF NOT EXISTS source                TEXT;

-- Также гарантируем что базовые native cols есть (на случай неполной
-- legacy схемы).
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS user_id        TEXT,        -- requesterId
  ADD COLUMN IF NOT EXISTS performer_id   TEXT,
  ADD COLUMN IF NOT EXISTS venue_id       TEXT,
  ADD COLUMN IF NOT EXISTS event_date     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status         TEXT         NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS total_price    NUMERIC,
  ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS deposit_paid   BOOLEAN      NOT NULL DEFAULT FALSE;

-- Laptop pre-flight fix 2026-05-27: event_date уже существует как TEXT,
-- ADD COLUMN IF NOT EXISTS skipped. Конвертируем в TIMESTAMPTZ до UPDATE.
ALTER TABLE bookings
  ALTER COLUMN event_date TYPE TIMESTAMPTZ
  USING NULLIF(event_date, '')::timestamptz;

-- Backfill из data jsonb. Только UPDATE'им существующие строки —
-- defensive: только если native col NULL (не overwrite если уже
-- стояло).
UPDATE bookings SET
  requester_type      = COALESCE(requester_type,      NULLIF(data->>'requesterType','')),
  performer_type      = COALESCE(performer_type,      NULLIF(data->>'performerType','')),
  event_type          = COALESCE(event_type,          NULLIF(data->>'eventType','')),
  event_title         = COALESCE(event_title,         NULLIF(data->>'eventTitle','')),
  event_description   = COALESCE(event_description,   NULLIF(data->>'eventDescription','')),
  start_time          = COALESCE(start_time,          NULLIF(data->>'startTime','')),
  duration_hours      = COALESCE(duration_hours,      NULLIF(data->>'durationHours','')::numeric),
  venue_name          = COALESCE(venue_name,          NULLIF(data->>'venueName','')),
  venue_address       = COALESCE(venue_address,       NULLIF(data->>'venueAddress','')),
  venue_city          = COALESCE(venue_city,          NULLIF(data->>'venueCity','')),
  venue_type          = COALESCE(venue_type,          NULLIF(data->>'venueType','')),
  expected_audience   = COALESCE(expected_audience,   NULLIF(data->>'expectedAudience','')::integer),
  audience_type       = COALESCE(audience_type,       NULLIF(data->>'audienceType','')),
  performer_fee       = COALESCE(performer_fee,       NULLIF(data->>'performerFee','')::numeric),
  platform_commission = COALESCE(platform_commission, NULLIF(data->>'platformCommission','')::numeric),
  deposit_percentage  = COALESCE(deposit_percentage,  NULLIF(data->>'depositPercentage','')::numeric),
  final_amount        = COALESCE(final_amount,        NULLIF(data->>'finalAmount','')::numeric),
  technical_requirements = COALESCE(
    CASE WHEN technical_requirements = '{}'::jsonb THEN data->'technicalRequirements' ELSE technical_requirements END,
    '{}'::jsonb
  ),
  special_requests    = COALESCE(special_requests,    NULLIF(data->>'specialRequests','')),
  accepted_at         = COALESCE(accepted_at,         NULLIF(data->>'acceptedAt','')::timestamptz),
  rejected_at         = COALESCE(rejected_at,         NULLIF(data->>'rejectedAt','')::timestamptz),
  cancelled_at        = COALESCE(cancelled_at,        NULLIF(data->>'cancelledAt','')::timestamptz),
  deposit_paid_at     = COALESCE(deposit_paid_at,     NULLIF(data->>'depositPaidAt','')::timestamptz),
  final_paid_at       = COALESCE(final_paid_at,       NULLIF(data->>'finalPaidAt','')::timestamptz),
  cancelled_by        = COALESCE(cancelled_by,        NULLIF(data->>'cancelledBy','')),
  cancelled_by_role   = COALESCE(cancelled_by_role,   NULLIF(data->>'cancelledByRole','')),
  cancellation_reason = COALESCE(cancellation_reason, NULLIF(data->>'cancellationReason','')),
  user_id             = COALESCE(user_id,             NULLIF(data->>'requesterId','')),
  performer_id        = COALESCE(performer_id,        NULLIF(data->>'performerId','')),
  venue_id            = COALESCE(venue_id,            NULLIF(data->>'venueId','')),
  event_date          = COALESCE(event_date,          NULLIF(data->>'eventDate','')::timestamptz),
  status              = CASE WHEN status = 'pending' AND data->>'status' IS NOT NULL
                             THEN data->>'status'
                             ELSE status END,
  total_price         = COALESCE(total_price,         NULLIF(data->>'offeredPrice','')::numeric),
  deposit_amount      = COALESCE(deposit_amount,      NULLIF(data->>'depositAmount','')::numeric),
  client_name         = COALESCE(client_name,         NULLIF(data->>'clientName','')),
  client_email        = COALESCE(client_email,        NULLIF(data->>'clientEmail','')),
  source              = COALESCE(source,              NULLIF(data->>'source',''))
WHERE jsonb_typeof(data) = 'object';

-- Indexes для hot-path queries
CREATE INDEX IF NOT EXISTS idx_bookings_performer_event_date
  ON bookings(performer_id, event_date);   -- DJ-plan quota check
CREATE INDEX IF NOT EXISTS idx_bookings_user_id
  ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_venue_id
  ON bookings(venue_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status_pending
  ON bookings(status) WHERE status = 'pending';

-- DROP COLUMN data — все известные поля promoted. Если в data jsonb
-- остались НЕЗАДОКУМЕНТИРОВАННЫЕ поля, они теряются. Backup pg_dump
-- обязателен (см. MANUAL DEPLOY STEPS).
ALTER TABLE bookings DROP COLUMN IF EXISTS data;
