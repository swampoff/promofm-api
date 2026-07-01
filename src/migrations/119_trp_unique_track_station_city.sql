-- Migration 119: track_radio_pickups UNIQUE → (track_id, station_name, city)
--
-- Migration 118 добавила UNIQUE (track_id, station_name), но это ОШИБОЧНО
-- запрещало станции иметь несколько городов на одном треке. Модель footprint =
-- одна строка на station×city (лендинг «Свежие релизы» считает
-- COUNT(DISTINCT station_name)=радио, COUNT(DISTINCT city)=города).
-- Реальный пример: Soul FM вещает в 5 городах Коста-Бланки (Calpe, Benidorm,
-- Denia, Altea, Alicante) → нужно 5 строк на трек, что двойной ключ блокировал.
-- Ослабляем до (track_id, station_name, city). friday.js ON CONFLICT синхронно
-- обновлён на тройку. Идемпотентно.
DROP INDEX IF EXISTS uq_trp_track_station;
CREATE UNIQUE INDEX IF NOT EXISTS uq_trp_track_station_city
  ON track_radio_pickups (track_id, station_name, city) NULLS NOT DISTINCT;
