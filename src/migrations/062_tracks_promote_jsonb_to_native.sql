-- 062_tracks_promote_jsonb_to_native.sql
--
-- tracks — hybrid таблица: native cols + hot-path поля в data jsonb.
-- Аналог 046 dj_mixes. Промоут payment + promotion-timing + shoutout +
-- AI-overlap полей в native, backfill из data, оставляем data для legacy
-- keys (year/album/source/week/legacyPaidOnOldPlatform), DROP в follow-up.
--
-- Real race: payment_amount overwritten 1 → 5000 при concurrent
-- /manageTrackModeration + checkout webhook (см. e77b1053 incident в
-- checkout-routes.tsx комментариях). Промоут в native + UPDATE WHERE
-- moderation_status гейт убирают get-modify-set паттерн.
--
-- ⚠️ КОНВЕНЦИЯ: НЕТ BEGIN/COMMIT — runner оборачивает.

-- ════════════════════════════════════════════════════════════════════
-- 1. ADD native columns для hot-path data keys
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE tracks
  -- Payment flow (checkout-routes webhook + track-moderation manageTrackModeration)
  ADD COLUMN IF NOT EXISTS payment_completed         BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_amount            NUMERIC,
  ADD COLUMN IF NOT EXISTS payment_order_id          TEXT,
  ADD COLUMN IF NOT EXISTS payment_gateway           TEXT,
  ADD COLUMN IF NOT EXISTS paid_at                   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requires_payment          BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS first_track_free_applied  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_payment_reminder_at  TIMESTAMPTZ,
  -- Promotion timing (cron promote-upcoming + admin override + checkout)
  ADD COLUMN IF NOT EXISTS upcoming_until            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_for_release_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at              TIMESTAMPTZ,
  -- AutoDJ shoutout overlay
  ADD COLUMN IF NOT EXISTS shoutout_url              TEXT,
  -- AI duplicate-overlap fields (native: ai_score, ai_verdict, ai_analysis уже есть)
  ADD COLUMN IF NOT EXISTS ai_flagged                BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_category               TEXT;

-- ════════════════════════════════════════════════════════════════════
-- 2. Backfill из data jsonb → native cols
-- ════════════════════════════════════════════════════════════════════
-- COALESCE(native, from_data) — не перезаписываем уже-нативные значения.

UPDATE tracks SET
  payment_completed         = COALESCE((data->>'payment_completed')::boolean, FALSE),
  payment_amount            = NULLIF(data->>'payment_amount','')::numeric,
  payment_order_id          = NULLIF(data->>'payment_order_id',''),
  payment_gateway           = NULLIF(data->>'payment_gateway',''),
  paid_at                   = NULLIF(data->>'paid_at','')::timestamptz,
  requires_payment          = COALESCE((data->>'requires_payment')::boolean, TRUE),
  first_track_free_applied  = COALESCE((data->>'first_track_free_applied')::boolean, FALSE),
  last_payment_reminder_at  = NULLIF(data->>'last_payment_reminder_at','')::timestamptz,
  upcoming_until            = NULLIF(data->>'upcoming_until','')::timestamptz,
  approved_for_release_at   = NULLIF(data->>'approved_for_release_at','')::timestamptz,
  published_at              = NULLIF(data->>'published_at','')::timestamptz,
  shoutout_url              = NULLIF(data->>'shoutout_url',''),
  ai_flagged                = COALESCE((data->>'ai_flagged')::boolean, FALSE),
  ai_category               = NULLIF(data->>'ai_category','')
WHERE data IS NOT NULL AND jsonb_typeof(data) = 'object';

-- AI native overlap — merge `overall_score` → ai_score если native пуст:
UPDATE tracks SET
  ai_score = COALESCE(ai_score, NULLIF(data->>'overall_score','')::int)
WHERE ai_score IS NULL
  AND data->>'overall_score' IS NOT NULL;

UPDATE tracks SET
  is_ai_generated = COALESCE(is_ai_generated, (data->>'is_ai_track')::boolean, FALSE)
WHERE data->>'is_ai_track' IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- 3. Indexes для hot-path queries
-- ════════════════════════════════════════════════════════════════════

-- Cron promote-upcoming → published (track-moderation-routes::/promote-upcoming):
-- WHERE moderation_status='upcoming' AND upcoming_until <= NOW()
CREATE INDEX IF NOT EXISTS idx_tracks_upcoming_until
  ON tracks(upcoming_until)
  WHERE moderation_status = 'upcoming' AND upcoming_until IS NOT NULL;

-- Cron payment-reminder: WHERE last_payment_reminder_at < NOW() - INTERVAL
CREATE INDEX IF NOT EXISTS idx_tracks_payment_reminder
  ON tracks(last_payment_reminder_at)
  WHERE moderation_status = 'approved'
    AND payment_completed = FALSE
    AND requires_payment = TRUE;

-- Public catalog (landing): WHERE moderation_status='published' AND is_hidden=FALSE
-- + filter free / paid:
CREATE INDEX IF NOT EXISTS idx_tracks_public_catalog
  ON tracks(moderation_status, created_at DESC)
  WHERE is_hidden = FALSE
    AND (payment_completed = TRUE OR first_track_free_applied = TRUE);

-- AI checking flag — admin queue filter:
CREATE INDEX IF NOT EXISTS idx_tracks_ai_flagged
  ON tracks(created_at DESC) WHERE ai_flagged = TRUE;

-- ════════════════════════════════════════════════════════════════════
-- 4. data jsonb column — НЕ DROP в этой миграции.
-- ════════════════════════════════════════════════════════════════════
-- Оставляем data для legacy keys: year/album/source/week (41 строк
-- каждый), legacyPaidOnOldPlatform (38), description/music_composer/
-- lyricist (по 2). Follow-up PR удалит после migration handlers'ов на
-- native cols + audit что никто не читает data legacy keys в hot path.
