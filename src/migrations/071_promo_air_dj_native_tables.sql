-- Migration 071 — promo_air_dj_* native tables (fix broken feature).
--
-- Context:
--   src/promo-air-dj-routes.tsx — live venue AI-DJ feature (Gemini +
--   ElevenLabs LLM generation) uses 3 stores через aliases:
--     djScriptsStore  = promoAirDjScriptsStore
--     djSettingsStore = promoAirDjSettingsStore
--     djQueueStore    = promoAirDjQueueStore
--
--   Production state до этой миграции:
--     promo_air_dj_scripts   — EXISTS, 0 rows, legacy (pk, data jsonb)
--                              schema where data = array of 100 scripts
--     promo_air_dj_settings  — MISSING (feature partially broken)
--     promo_air_dj_queue     — MISSING (feature partially broken)
--
--   Это значит POST /settings и GET /queue/:venueId сейчас падают —
--   venue cabinet UI (src/venue/components/radio-brand-section.tsx)
--   уже использует генерацию через POST /generate-script (это
--   работает потому что scripts table есть), но не может persist'ить
--   settings или прочитать queue.
--
--   Эта миграция:
--     1. DROP'ает legacy promo_air_dj_scripts (0 rows — safe).
--     2. CREATE 3 новых native tables с proper schema.
--     3. Companion code change (src/db.tsx + promo-air-dj-routes.tsx)
--        переводит 6 handlers на pool.query через typed functions.
--
--   После миграции feature работает целиком: settings persist'ятся,
--   queue читается, scripts retention'ятся (last 100 per venue) и
--   queue items retention'ятся (last 50 per venue).
--
-- Schema design rationale:
--   promo_air_dj_settings — 1 row per venue (per-venue config).
--     PK = venue_id (TEXT, matches venue_profiles.user_id contract).
--     No FK constraint — venue_id может быть placeholder 'current' из
--     frontend (см. radio-brand.tsx:765). Auth-gate отдельно в handler.
--
--   promo_air_dj_scripts — row-per-script (many per venue).
--     PK = id TEXT (format 'dj-<uuid>' — preserved from current handler).
--     Index (venue_id, generated_at DESC) для "last N scripts per venue".
--
--   promo_air_dj_queue — row-per-queue-item.
--     PK = id UUID auto-gen.
--     Index (venue_id, played, scheduled_at) для playback lookup.
--
-- Idempotent: DROP IF EXISTS + CREATE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

-- ── DROP legacy scripts table (0 rows on prod, schema mismatch)
DROP TABLE IF EXISTS promo_air_dj_scripts;

-- ── 1. promo_air_dj_settings — per-venue config singleton
CREATE TABLE IF NOT EXISTS promo_air_dj_settings (
  venue_id              TEXT        PRIMARY KEY,
  voice_style           TEXT        NOT NULL DEFAULT 'warm',
  language              TEXT        NOT NULL DEFAULT 'ru',
  dj_name               TEXT        NOT NULL DEFAULT 'Промо FM',
  enabled_segments      TEXT[]      NOT NULL DEFAULT ARRAY['track_intro', 'time_check', 'greeting']::TEXT[],
  track_intro_frequency INTEGER     NOT NULL DEFAULT 3,
  time_check_frequency  INTEGER     NOT NULL DEFAULT 30,
  weather_frequency     INTEGER     NOT NULL DEFAULT 60,
  custom_prompt         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. promo_air_dj_scripts — script history (row-per-script)
CREATE TABLE IF NOT EXISTS promo_air_dj_scripts (
  id            TEXT        PRIMARY KEY,
  venue_id      TEXT        NOT NULL,
  segment_type  TEXT        NOT NULL,
  text          TEXT        NOT NULL,
  audio_url     TEXT,
  model         TEXT,
  latency_ms    INTEGER,
  status        TEXT        NOT NULL DEFAULT 'text_ready',
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_air_dj_scripts_venue_recent
  ON promo_air_dj_scripts (venue_id, generated_at DESC);

-- ── 3. promo_air_dj_queue — playback queue (row-per-item)
CREATE TABLE IF NOT EXISTS promo_air_dj_queue (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      TEXT        NOT NULL,
  script_id     TEXT,
  segment_type  TEXT        NOT NULL,
  text          TEXT        NOT NULL,
  audio_url     TEXT,
  scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  played        BOOLEAN     NOT NULL DEFAULT FALSE,
  played_at     TIMESTAMPTZ
);

-- Partial index — hot-path query "next un-played items for venue".
CREATE INDEX IF NOT EXISTS idx_promo_air_dj_queue_pending
  ON promo_air_dj_queue (venue_id, scheduled_at) WHERE played = FALSE;

-- Full index — для retention queries и admin browse.
CREATE INDEX IF NOT EXISTS idx_promo_air_dj_queue_venue_recent
  ON promo_air_dj_queue (venue_id, scheduled_at DESC);
