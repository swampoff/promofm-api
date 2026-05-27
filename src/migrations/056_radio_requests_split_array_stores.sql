-- 056_radio_requests_split_array_stores.sql
--
-- 3 array-in-value KV stores из радио-кабинета → row-per-entity:
--   radio_artist_requests (radio_id PK + data=[...]) → row-per-request
--   radio_venue_requests  (radio_id PK + data=[...]) → row-per-request
--   radio_notifications   (radio_id PK + data=[...]) → row-per-notification
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- НЕ трогаем (read-only, 0 writes в handler коде):
--   radio_finance, radio_transactions — источник записи извне (cron / админ).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d radio_artist_requests
--   \d radio_venue_requests
--   \d radio_notifications
--   SELECT COUNT(*),
--          (SELECT SUM(jsonb_array_length(data))::int FROM radio_artist_requests) elements
--     FROM radio_artist_requests;
--   -- (то же для остальных 2)
--   SELECT polname FROM pg_policy
--    WHERE polrelid::regclass::text IN ('radio_artist_requests','radio_venue_requests','radio_notifications');
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t radio_artist_requests -t radio_venue_requests -t radio_notifications promofm
--        > /tmp/radio_req_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/056_radio_requests_split_array_stores.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- ─── Backfill helper: temp tables of unnested elements ───────────────
-- Этот pattern «extract elements → drop legacy table → create native →
-- INSERT from temp» гарантирует, что мы не теряем data при ALTER'ах.

DO $$
BEGIN
  -- ============= radio_artist_requests =============

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'radio_artist_requests') THEN
    CREATE TABLE radio_artist_requests (
      radio_id TEXT PRIMARY KEY,
      data JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  END IF;

  -- Снимаем элементы массива во временную таблицу.
  CREATE TEMP TABLE _artist_req_backup ON COMMIT DROP AS
    SELECT t.radio_id, elem
      FROM radio_artist_requests t,
           jsonb_array_elements(COALESCE(t.data, '[]'::jsonb)) elem
     WHERE jsonb_typeof(t.data) = 'array';

  -- Если у таблицы текущая схема (radio_id PK + data jsonb), нужно её
  -- пересоздать с native cols. Сохраняем backup, дроп, recreate.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'radio_artist_requests' AND column_name = 'data'
  ) THEN
    DROP TABLE radio_artist_requests CASCADE;
    CREATE TABLE radio_artist_requests (
      id TEXT PRIMARY KEY,
      radio_id          TEXT          NOT NULL,
      artist_id         TEXT,
      artist_name       TEXT,
      track_id          TEXT,
      track_title       TEXT,
      track_url         TEXT,
      status            TEXT          NOT NULL DEFAULT 'pending',
      rejection_reason  TEXT,
      responded_at      TIMESTAMPTZ,
      extra             JSONB         NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    INSERT INTO radio_artist_requests
      (id, radio_id, artist_id, artist_name, track_id, track_title, track_url,
       status, rejection_reason, responded_at, extra, created_at, updated_at)
    SELECT
      COALESCE(NULLIF(elem->>'id',''), gen_random_uuid()::text),
      radio_id,
      NULLIF(elem->>'artistId',''),
      NULLIF(elem->>'artistName',''),
      NULLIF(elem->>'trackId',''),
      NULLIF(elem->>'trackTitle',''),
      NULLIF(elem->>'trackUrl',''),
      COALESCE(NULLIF(elem->>'status',''), 'pending'),
      NULLIF(elem->>'rejectionReason',''),
      NULLIF(elem->>'respondedAt','')::timestamptz,
      (elem - 'id' - 'artistId' - 'artistName' - 'trackId' - 'trackTitle'
            - 'trackUrl' - 'status' - 'rejectionReason' - 'respondedAt'
            - 'createdAt' - 'updatedAt'),
      COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, NOW()),
      COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW())
    FROM _artist_req_backup
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- ============= radio_venue_requests =============

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'radio_venue_requests') THEN
    CREATE TABLE radio_venue_requests (
      radio_id TEXT PRIMARY KEY,
      data JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  END IF;

  CREATE TEMP TABLE _venue_req_backup ON COMMIT DROP AS
    SELECT t.radio_id, elem
      FROM radio_venue_requests t,
           jsonb_array_elements(COALESCE(t.data, '[]'::jsonb)) elem
     WHERE jsonb_typeof(t.data) = 'array';

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'radio_venue_requests' AND column_name = 'data'
  ) THEN
    DROP TABLE radio_venue_requests CASCADE;
    CREATE TABLE radio_venue_requests (
      id TEXT PRIMARY KEY,
      radio_id          TEXT          NOT NULL,
      venue_id          TEXT,
      venue_name        TEXT,
      venue_city        TEXT,
      campaign_id       TEXT,
      package_type      TEXT,
      audio_url         TEXT,
      start_date        TIMESTAMPTZ,
      end_date          TIMESTAMPTZ,
      target_plays      INTEGER       NOT NULL DEFAULT 0,
      completed_plays   INTEGER       NOT NULL DEFAULT 0,
      plays_per_day     INTEGER       NOT NULL DEFAULT 0,
      duration_days     INTEGER       NOT NULL DEFAULT 1,
      total_price       NUMERIC       NOT NULL DEFAULT 0,
      platform_fee      NUMERIC       NOT NULL DEFAULT 0,
      station_payout    NUMERIC       NOT NULL DEFAULT 0,
      time_slots        JSONB         NOT NULL DEFAULT '[]'::jsonb,
      status            TEXT          NOT NULL DEFAULT 'pending',
      rejection_reason  TEXT,
      approved_at       TIMESTAMPTZ,
      reviewed_at       TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ,
      extra             JSONB         NOT NULL DEFAULT '{}'::jsonb,
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    INSERT INTO radio_venue_requests
      (id, radio_id, venue_id, venue_name, venue_city, campaign_id, package_type,
       audio_url, start_date, end_date, target_plays, completed_plays,
       plays_per_day, duration_days, total_price, platform_fee, station_payout,
       time_slots, status, rejection_reason, approved_at, reviewed_at,
       completed_at, extra, created_at, updated_at)
    SELECT
      COALESCE(NULLIF(elem->>'id',''), gen_random_uuid()::text),
      radio_id,
      NULLIF(elem->>'venueId',''),
      NULLIF(elem->>'venueName',''),
      NULLIF(elem->>'venueCity',''),
      NULLIF(elem->>'campaignId',''),
      NULLIF(elem->>'packageType',''),
      NULLIF(elem->>'audioUrl',''),
      NULLIF(elem->>'startDate','')::timestamptz,
      NULLIF(elem->>'endDate','')::timestamptz,
      COALESCE(NULLIF(elem->>'targetPlays','')::integer, 0),
      COALESCE(NULLIF(elem->>'completedPlays','')::integer, 0),
      COALESCE(NULLIF(elem->>'playsPerDay','')::integer, 0),
      COALESCE(NULLIF(elem->>'durationDays','')::integer, 1),
      COALESCE(NULLIF(elem->>'totalPrice','')::numeric, 0),
      COALESCE(NULLIF(elem->>'platformFee','')::numeric, 0),
      COALESCE(NULLIF(elem->>'stationPayout','')::numeric, 0),
      COALESCE(elem->'timeSlots', '[]'::jsonb),
      COALESCE(NULLIF(elem->>'status',''), 'pending'),
      NULLIF(elem->>'rejectionReason',''),
      NULLIF(elem->>'approvedAt','')::timestamptz,
      NULLIF(elem->>'reviewedAt','')::timestamptz,
      NULLIF(elem->>'completedAt','')::timestamptz,
      (elem - 'id' - 'venueId' - 'venueName' - 'venueCity' - 'campaignId'
            - 'packageType' - 'audioUrl' - 'startDate' - 'endDate'
            - 'targetPlays' - 'completedPlays' - 'playsPerDay' - 'durationDays'
            - 'totalPrice' - 'platformFee' - 'stationPayout' - 'timeSlots'
            - 'status' - 'rejectionReason' - 'approvedAt' - 'reviewedAt'
            - 'completedAt' - 'createdAt' - 'updatedAt' - 'submittedAt'),
      COALESCE(NULLIF(elem->>'createdAt','')::timestamptz,
               NULLIF(elem->>'submittedAt','')::timestamptz,
               NOW()),
      COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW())
    FROM _venue_req_backup
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- ============= radio_notifications =============

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'radio_notifications') THEN
    CREATE TABLE radio_notifications (
      radio_id TEXT PRIMARY KEY,
      data JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  END IF;

  CREATE TEMP TABLE _radio_notif_backup ON COMMIT DROP AS
    SELECT t.radio_id, elem
      FROM radio_notifications t,
           jsonb_array_elements(COALESCE(t.data, '[]'::jsonb)) elem
     WHERE jsonb_typeof(t.data) = 'array';

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'radio_notifications' AND column_name = 'data'
  ) THEN
    DROP TABLE radio_notifications CASCADE;
    CREATE TABLE radio_notifications (
      id TEXT PRIMARY KEY,
      radio_id     TEXT          NOT NULL,
      notif_type   TEXT,
      title        TEXT,
      message      TEXT,
      priority     TEXT          NOT NULL DEFAULT 'normal',
      is_read      BOOLEAN       NOT NULL DEFAULT FALSE,
      related_id   TEXT,
      extra        JSONB         NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    INSERT INTO radio_notifications
      (id, radio_id, notif_type, title, message, priority, is_read,
       related_id, extra, created_at, updated_at)
    SELECT
      COALESCE(NULLIF(elem->>'id',''), gen_random_uuid()::text),
      radio_id,
      NULLIF(elem->>'type',''),
      NULLIF(elem->>'title',''),
      NULLIF(elem->>'message',''),
      COALESCE(NULLIF(elem->>'priority',''), 'normal'),
      COALESCE(NULLIF(elem->>'read','')::boolean, FALSE),
      NULLIF(elem->>'relatedId',''),
      (elem - 'id' - 'type' - 'title' - 'message' - 'priority'
            - 'read' - 'relatedId' - 'createdAt' - 'updatedAt'),
      COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, NOW()),
      COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW())
    FROM _radio_notif_backup
    ON CONFLICT (id) DO NOTHING;
  END IF;

END $$;

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_radio_artist_requests_radio_created
  ON radio_artist_requests(radio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radio_artist_requests_status
  ON radio_artist_requests(radio_id, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_radio_venue_requests_radio_created
  ON radio_venue_requests(radio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radio_venue_requests_status
  ON radio_venue_requests(radio_id, status)
  WHERE status IN ('pending', 'approved', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_radio_venue_requests_campaign
  ON radio_venue_requests(campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_radio_notifications_radio_created
  ON radio_notifications(radio_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radio_notifications_unread
  ON radio_notifications(radio_id, created_at DESC)
  WHERE is_read = FALSE;
