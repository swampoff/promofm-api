-- Migration 124: персональный APK на каждое заведение (заявка → сборка админом → скачивание).
--
-- Раньше APK был ОДИН общий файл на всех (system_config key venue_apk_release,
-- promofm-venue-player.apk), станция выбиралась pairing-кодом. Владелец: каждому
-- заведению собирается ПЕРСОНАЛЬНЫЙ APK его радио, заведение заказывает его из
-- кабинета и скачивает только свой.
--
-- Row-per-entity, нативные колонки (CLAUDE.md — не KV). Файл хранится ВНЕ
-- открытой статики (/uploads/venue-apk/<venue_id>/), отдаётся авторизованным
-- эндпоинтом /venue-apk/my/download — заведение качает только свой (в отличие
-- от общего /uploads/apk/* без авторизации).
--
-- Apply:
--   BEGIN; \i .../124_venue_apk_builds.sql; COMMIT;

CREATE TABLE IF NOT EXISTS venue_apk_builds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'requested',  -- requested | building | ready | failed
  file_name     TEXT,
  file_bytes    BIGINT,
  sha256        TEXT,
  version       TEXT,
  notes         TEXT,                               -- админ-заметка / причина failed
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_at   TIMESTAMPTZ,
  extra         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT venue_apk_builds_status_chk
    CHECK (status IN ('requested', 'building', 'ready', 'failed'))
);

-- Одна активная сборка на заведение (последняя по requested_at).
CREATE INDEX IF NOT EXISTS idx_venue_apk_builds_venue
  ON venue_apk_builds (venue_id, requested_at DESC);
