-- Migration 104: DJ-миксы в еженедельной подборке (Friday Releases)
--
-- Контекст (PROMO.FM аудит 2026-06-05, P0 #5): LP /radio-stations
-- обещает радиостанциям «кураторская подборка треков и миксов DJ»,
-- но weekly_releases нёс только track_ids — DJ-миксы в пакет не
-- попадали. Этот PR добавляет mix_ids + лог скачиваний миксов радио.
--
-- dj_mixes.id — TEXT (не uuid), поэтому mix_ids TEXT[].

-- ── 1. mix_ids на weekly_releases ────────────────────────────────────

ALTER TABLE weekly_releases
  ADD COLUMN IF NOT EXISTS mix_ids TEXT[] DEFAULT '{}';

-- ── 2. mix_downloads_by_radio — лог скачиваний миксов радиостанциями ─
-- Зеркало track_downloads_by_radio (migration 011): кто, когда, какой
-- микс скачал. Нужен для аналитики DJ («мой микс скачали N станций»)
-- и для отчёта недельного пакета.

CREATE TABLE IF NOT EXISTS mix_downloads_by_radio (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL,            -- radio user id
  station_name  TEXT,                            -- snapshot на момент скачивания
  city          TEXT,                            -- snapshot из radio_profiles
  mix_id        TEXT        NOT NULL REFERENCES dj_mixes(id) ON DELETE CASCADE,
  weekly_release_id TEXT,                        -- informational, без FK; TEXT т.к. тип weekly_releases.id не закреплён миграцией (таблица создана на проде вне runner'а) — пишем ::text
  ip_addr       TEXT,
  user_agent    TEXT,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mix_downloads_by_radio_mix_id
  ON mix_downloads_by_radio(mix_id);
CREATE INDEX IF NOT EXISTS idx_mix_downloads_by_radio_user_id
  ON mix_downloads_by_radio(user_id);
