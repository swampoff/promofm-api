-- Migration 118: track_radio_pickups UNIQUE (track_id, station_name) — чинит friday.js
--
-- friday.js (крон создания «Новинок недели», Пт 10:00) генерит auto-пикапы:
--   INSERT ... ON CONFLICT (track_id, station_name) DO NOTHING
-- Но unique-констрейнта на (track_id, station_name) не было → PG кидал
-- «no unique or exclusion constraint matching the ON CONFLICT specification»
-- на КАЖДОМ инсерте, friday.js глотал его в catch{} → 0 radio pickups на
-- новинках недели («крон забывает добавлять радио партнёров и города»).
-- Дедуп накопившихся (auto-runs без констрейнта наплодили дубли) + unique-индекс.
-- Идемпотентно.
DELETE FROM track_radio_pickups WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY track_id, station_name
      ORDER BY (source <> 'auto') DESC, rotation_count DESC NULLS LAST, id
    ) rn FROM track_radio_pickups
  ) x WHERE rn > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trp_track_station
  ON track_radio_pickups (track_id, station_name);
