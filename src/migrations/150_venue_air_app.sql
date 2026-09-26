-- 150: приложение PROMO.AIR для заведений (26.09.2026).
--
-- Анкета заведения (venue_station_requests.format): тип эфира
-- (background — фоновая музыка, full_radio — радио полного цикла с
-- ведущими, анонсами и джинглами) и список точек (зал, веранда…).
-- Поток (venue_station_streams): название точки и хеш постоянного токена
-- устройства — приложение получает токен при привязке по коду и дальше
-- ходит с ним за настройками потока и шлёт сигнал «в сети».

ALTER TABLE venue_station_requests ADD COLUMN IF NOT EXISTS format jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE venue_station_streams ADD COLUMN IF NOT EXISTS point_name text;
ALTER TABLE venue_station_streams ADD COLUMN IF NOT EXISTS device_token_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_station_streams_device_token
  ON venue_station_streams (device_token_hash) WHERE device_token_hash IS NOT NULL;
