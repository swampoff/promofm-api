-- 010_promo_check_monitoring_seed.sql
--
-- Expand promo_check_monitoring from 5 active stations to ~11. The 5
-- baseline stations (Soul FM, Русское Радио, DFM, Наше Радио, Europa
-- Plus) were already seeded when the pipeline was first scaffolded;
-- this migration is purely additive.
--
-- Why: monitor.py fingerprints incoming stream audio against
-- promo_check_fingerprints (the artists' tracks) and writes hits to
-- promo_check_detections. Coverage scales linearly with the number of
-- stations being listened to — 5 stations means a track has to play
-- on one of those 5 to be detected. Adding the 6 popular RU stations
-- below roughly doubles the chance of catching real airplay.
--
-- ⚠ Stream URLs below are BEST-EFFORT from public listings. Stream
-- endpoints rotate, get rate-limited, or move to CDN-signed URLs
-- without notice. Laptop MUST validate each URL responds with audio
-- before flipping active=true. Recommended check command per station:
--
--   timeout 6 curl -sI '<stream_url>' \
--     | head -3 \
--     && timeout 8 ffprobe -hide_banner -i '<stream_url>' 2>&1 \
--         | head -10
--
-- Expect HTTP 200/206 + Content-Type audio/*. If a URL is dead or
-- requires referer, leave that row at active=false and patch the URL
-- in a follow-up. The monitor.py error_count guard means dead
-- streams flagged active=true will just keep retrying, which is
-- wasteful but not destructive — still better to verify first.
--
-- MANUAL DEPLOY STEPS:
--
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/010_promo_check_monitoring_seed.sql
--
-- No restart of promofm-api required — monitor.py picks up the new
-- rows on its next scan cycle (verify with: SELECT station_name,
-- last_scanned_at FROM promo_check_monitoring ORDER BY
-- last_scanned_at DESC NULLS LAST;).

BEGIN;

-- INSERT ... ON CONFLICT DO NOTHING means re-running this migration
-- is safe; existing rows are not overwritten (so any URL fixes laptop
-- applies manually after this won't get reverted).
--
-- active=false on insert — laptop flips to true once URL is validated.
-- This is conservative: dead streams shouldn't be in the rotation
-- silently spinning the monitor's wheels.

INSERT INTO promo_check_monitoring
  (station_name, stream_url, active, error_count, last_error)
VALUES
  ('Авторадио',         'http://pub0202.101.ru:8703/stream/regions/avtoradio_aac', false, 0, NULL),
  ('Хит FM',             'http://hitfm.hostingradio.ru:8043/hitfm-256',             false, 0, NULL),
  ('Радио Шансон',       'http://nashe1.hostingradio.ru/shanson-128.mp3',           false, 0, NULL),
  ('Energy',             'http://ic7.101.ru:8000/v13_1',                            false, 0, NULL),
  ('Радио Дача',         'http://radio-holding.ru:8001/dacha.aacp',                 false, 0, NULL),
  ('Радио Maximum',      'http://stream01.hitv.ru:8000/maximum128.aac',             false, 0, NULL)
ON CONFLICT (station_name) DO NOTHING;

COMMIT;

-- ─── Post-migration smoke (run manually after applying) ───────────────────
--
-- Should now show 11 rows total (5 baseline + 6 new):
--
--   SELECT station_name, active, error_count
--   FROM promo_check_monitoring
--   ORDER BY active DESC, station_name;
--
-- After laptop validates each new URL with the curl + ffprobe pair
-- above, flip them one at a time:
--
--   UPDATE promo_check_monitoring
--   SET active = true, error_count = 0, last_error = NULL
--   WHERE station_name = 'Авторадио';   -- only if URL is good
--
-- Monitor for the first ~30 min after activating each station:
--
--   SELECT station_name, error_count, last_error, last_scanned_at
--   FROM promo_check_monitoring
--   WHERE station_name IN ('Авторадио', 'Хит FM', /* ... */)
--   ORDER BY last_scanned_at DESC NULLS LAST;
--
-- If error_count climbs fast (>10/min), the stream URL is dead or
-- rate-limiting fpcalc — set active=false and dig in.
