-- ════════════════════════════════════════════════════════════════════
-- Migration 113: Distribution v2 — full Release model (DDEX-aware)
-- ════════════════════════════════════════════════════════════════════
--
-- Контекст: текущая distribution_orders (миграция 013) — тонкая модель
-- «трек × DSP», достаточная для ручной админ-доставки одиночного трека.
-- Для полноценной собственной дистрибуции (артист И DJ → DSP, со сбором
-- роялти) нужна богатая Release-модель, как у реальных дистрибьюторов:
--
--   Release (single/EP/album, UPC, обложка, ℗/©, дата)
--     └─ ReleaseTrack[] (ISRC, версия, explicit, аудио-мастер)
--          └─ ReleaseContributor[] (composer/lyricist/producer + сплиты)
--     └─ ReleaseDelivery[] (per-DSP статус доставки + DDEX message id)
--
--   RoyaltyStatement (импорт DSP-отчёта за период)
--     └─ RoyaltyLine[] (по ISRC → earner → net → payout)
--
-- РЕАЛЬНОСТЬ ДОСТАВКИ (важно для архитектуры): Spotify/Apple НЕ имеют
-- публичного upload-API. Доставка идёт через DDEX-ERN + аккредитованный
-- канал (SFTP/агрегатор) или ручную админ-доставку. Поэтому
-- release_deliveries несёт `ddex_message_id` + `dsp_release_id` — те поля,
-- что нужны и ручному админу, и будущему delivery-worker'у, БЕЗ изменения
-- модели данных когда канал доставки подключится.
--
-- distribution_orders (v1) НЕ дропается — DistributionTab всё ещё его
-- использует. Миграция артистского UI на v2 — отдельная фаза. Эта
-- миграция только ADDITIVE: 6 новых таблиц, ноль изменений существующих.
--
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS) — safe to re-run.
-- DDL-only (без top-level BEGIN/COMMIT — runner оборачивает в транзакцию,
-- см. CLAUDE.md «Migration files: NO BEGIN/COMMIT inside the file»).
--
-- FK type-consistency (per cheat-sheet):
--   releases.user_id            TEXT  (как tracks.user_id)
--   releases.artist_profile_id  UUID  → artist_profiles(id)
--   release_tracks.track_id     UUID  → tracks(id)

-- ────────────────────────────────────────────────────────────────────
-- 1. releases — один релиз (single/EP/album)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS releases (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              TEXT         NOT NULL,                    -- владелец (артист/DJ user_id, text)
  creator_role         TEXT         NOT NULL DEFAULT 'artist',   -- 'artist' | 'dj'
  artist_profile_id    UUID         REFERENCES artist_profiles(id) ON DELETE SET NULL,
  title                TEXT         NOT NULL,
  release_type         TEXT         NOT NULL DEFAULT 'single',   -- 'single' | 'ep' | 'album'
  primary_artist_name  TEXT         NOT NULL,                    -- display-имя основного исполнителя
  label_name           TEXT,                                     -- лейбл (или платформенный дефолт)
  -- Идентификаторы (присваиваются при submit; nullable в draft)
  upc                  TEXT,                                     -- UPC/EAN релиза
  catalog_number       TEXT,                                     -- внутренний кат-номер
  -- Классификация
  genre                TEXT,
  subgenre             TEXT,
  language             TEXT         NOT NULL DEFAULT 'ru',
  -- Даты
  release_date         DATE,                                     -- когда должен выйти в DSP
  original_release_date DATE,                                    -- для переизданий
  -- Обложка (DSP требуют 3000×3000 sRGB JPG/PNG)
  cover_url            TEXT,
  cover_width          INTEGER,                                  -- snapshot валидации
  cover_height         INTEGER,
  -- Копирайты
  c_line               TEXT,                                     -- © строка (composition)
  p_line               TEXT,                                     -- ℗ строка (sound recording)
  c_line_year          INTEGER,
  p_line_year          INTEGER,
  -- Флаги
  explicit             BOOLEAN      NOT NULL DEFAULT FALSE,      -- release-level (если любой трек explicit)
  -- Статус
  status               TEXT         NOT NULL DEFAULT 'draft',
  rejection_reason     TEXT,
  -- Оплата (release-level fee)
  payment_session_id   TEXT,
  base_price_rub       INTEGER      NOT NULL DEFAULT 0,
  price_rub            INTEGER      NOT NULL DEFAULT 0,
  discount_pct         NUMERIC(4,3) NOT NULL DEFAULT 0,
  -- Прочее
  extra                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT releases_creator_role_chk CHECK (creator_role IN ('artist','dj')),
  CONSTRAINT releases_type_chk         CHECK (release_type IN ('single','ep','album')),
  CONSTRAINT releases_status_chk       CHECK (status IN (
    'draft','pending_payment','paid','in_review','approved',
    'delivering','live','rejected','taken_down','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_releases_user        ON releases (user_id);
CREATE INDEX IF NOT EXISTS idx_releases_status      ON releases (status);
CREATE INDEX IF NOT EXISTS idx_releases_artist_prof ON releases (artist_profile_id) WHERE artist_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_releases_upc         ON releases (upc) WHERE upc IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 2. release_tracks — трек внутри релиза
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS release_tracks (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id           UUID         NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  track_id             UUID         REFERENCES tracks(id) ON DELETE SET NULL,  -- связь с tracks (аудио-хранилище), nullable
  track_number         INTEGER      NOT NULL DEFAULT 1,
  disc_number          INTEGER      NOT NULL DEFAULT 1,
  title                TEXT         NOT NULL,
  version              TEXT,                                     -- 'Radio Edit' | 'Extended Mix' | 'Remix' (важно для DJ)
  isrc                 TEXT,                                     -- присваивается при submit
  explicit             BOOLEAN      NOT NULL DEFAULT FALSE,
  language             TEXT         NOT NULL DEFAULT 'ru',
  -- Аудио-мастер (DSP требуют WAV 16/24-bit, 44.1kHz+)
  audio_url            TEXT,
  audio_format         TEXT,                                     -- 'wav' | 'flac' (snapshot валидации)
  audio_sample_rate    INTEGER,
  audio_bit_depth      INTEGER,
  duration_sec         INTEGER,
  preview_start_sec    INTEGER,                                  -- старт 30-сек превью
  -- DJ-mix flow (миксы требуют подтверждения прав на содержимое)
  is_dj_mix            BOOLEAN      NOT NULL DEFAULT FALSE,
  rights_attested      BOOLEAN      NOT NULL DEFAULT FALSE,      -- DJ подтвердил права (clearance) на mix-контент
  rights_attested_at   TIMESTAMPTZ,
  extra                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_release_tracks_release ON release_tracks (release_id);
CREATE INDEX IF NOT EXISTS idx_release_tracks_isrc    ON release_tracks (isrc) WHERE isrc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_release_tracks_track   ON release_tracks (track_id) WHERE track_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 3. release_contributors — авторы/участники трека + сплиты роялти
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS release_contributors (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  release_track_id     UUID         NOT NULL REFERENCES release_tracks(id) ON DELETE CASCADE,
  name                 TEXT         NOT NULL,
  role                 TEXT         NOT NULL,                    -- 'primary_artist'|'featured_artist'|'composer'|'lyricist'|'producer'|'remixer'|'mixer'
  -- Сплит для распределения роялти. Сумма split_pct внутри одной
  -- role-группы (напр. всех 'primary_artist') ожидается = 100, но
  -- enforcement делается на app-уровне (не CHECK, т.к. многострочный).
  split_pct            NUMERIC(5,2) NOT NULL DEFAULT 0,
  -- Привязка к платформенному юзеру (если контрибьютор — наш артист,
  -- его доля роялти пойдёт ему на баланс). Nullable для внешних.
  payee_user_id        TEXT,
  ipi                  TEXT,                                     -- IPI/CAE номер (опционально, для PRO)
  extra                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT release_contributors_role_chk CHECK (role IN (
    'primary_artist','featured_artist','composer','lyricist',
    'producer','remixer','mixer'))
);
CREATE INDEX IF NOT EXISTS idx_release_contributors_track ON release_contributors (release_track_id);
CREATE INDEX IF NOT EXISTS idx_release_contributors_payee ON release_contributors (payee_user_id) WHERE payee_user_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 4. release_deliveries — статус доставки релиза в конкретный DSP
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS release_deliveries (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id           UUID         NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  target_dsp           TEXT         NOT NULL,                    -- 'spotify'|'apple_music'|'yandex_music'|'vk_music'|'soundcloud'|'other'
  status               TEXT         NOT NULL DEFAULT 'queued',   -- 'queued'|'delivering'|'live'|'rejected'|'taken_down'
  dsp_release_id       TEXT,                                     -- ID релиза на стороне DSP
  dsp_url              TEXT,                                     -- публичная ссылка
  ddex_message_id      TEXT,                                     -- DDEX ERN MessageId этой доставки
  delivered_at         TIMESTAMPTZ,
  live_at              TIMESTAMPTZ,
  rejected_reason      TEXT,
  extra                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT release_deliveries_status_chk CHECK (status IN (
    'queued','delivering','live','rejected','taken_down')),
  CONSTRAINT release_deliveries_dsp_chk CHECK (target_dsp IN (
    'spotify','apple_music','yandex_music','vk_music','soundcloud','other')),
  CONSTRAINT release_deliveries_uniq UNIQUE (release_id, target_dsp)
);
CREATE INDEX IF NOT EXISTS idx_release_deliveries_release ON release_deliveries (release_id);
CREATE INDEX IF NOT EXISTS idx_release_deliveries_dsp_st  ON release_deliveries (target_dsp, status);

-- ────────────────────────────────────────────────────────────────────
-- 5. royalty_statements — импортированный DSP-отчёт за период
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS royalty_statements (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  target_dsp           TEXT         NOT NULL,
  period_start         DATE         NOT NULL,
  period_end           DATE         NOT NULL,
  source_filename      TEXT,
  imported_by          TEXT,                                     -- admin user_id
  currency             TEXT         NOT NULL DEFAULT 'RUB',
  total_amount_rub     NUMERIC(14,2) NOT NULL DEFAULT 0,
  status               TEXT         NOT NULL DEFAULT 'imported', -- 'imported'|'reconciled'|'paid_out'
  extra                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT royalty_statements_status_chk CHECK (status IN ('imported','reconciled','paid_out'))
);
CREATE INDEX IF NOT EXISTS idx_royalty_statements_dsp_period ON royalty_statements (target_dsp, period_start);

-- ────────────────────────────────────────────────────────────────────
-- 6. royalty_lines — заработок по (отчёт × ISRC) + payout-статус
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS royalty_lines (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id         UUID         NOT NULL REFERENCES royalty_statements(id) ON DELETE CASCADE,
  release_track_id     UUID         REFERENCES release_tracks(id) ON DELETE SET NULL,  -- matched by ISRC, nullable если не нашли
  isrc                 TEXT,
  -- Earner (денормализовано для быстрых payout-запросов «сколько должен юзеру X»)
  user_id              TEXT,
  units                BIGINT       NOT NULL DEFAULT 0,          -- streams/downloads
  gross_amount_rub     NUMERIC(14,2) NOT NULL DEFAULT 0,
  platform_fee_rub     NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_amount_rub       NUMERIC(14,2) NOT NULL DEFAULT 0,         -- что причитается earner'у
  payout_status        TEXT         NOT NULL DEFAULT 'unpaid',   -- 'unpaid'|'reserved'|'paid'
  payout_withdrawal_id TEXT,                                     -- → payment_withdrawals.app_id когда выплачено
  extra                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT royalty_lines_payout_status_chk CHECK (payout_status IN ('unpaid','reserved','paid'))
);
CREATE INDEX IF NOT EXISTS idx_royalty_lines_statement ON royalty_lines (statement_id);
CREATE INDEX IF NOT EXISTS idx_royalty_lines_user_pay  ON royalty_lines (user_id, payout_status) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_royalty_lines_isrc      ON royalty_lines (isrc) WHERE isrc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_royalty_lines_rtrack    ON royalty_lines (release_track_id) WHERE release_track_id IS NOT NULL;
