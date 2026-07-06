-- 132_dj_mix_fingerprints_detections.sql
-- Promo.check для DJ-миксов — ПАРАЛЛЕЛЬНОЕ хранение, зеркало promo_check_* (трековый мир).
--
-- Решение B (2026-07-06, по \d прод): параллельные таблицы, НЕ «общие + mix_id», потому что:
--   • dj_mixes.id = TEXT, а promo_check_*.track_id = UUID → в общую колонку микс не лёг бы,
--     пришлось бы держать две nullable-колонки разного типа + дискриминатор (полиморф-антипаттерн);
--   • трековые таблицы несут FK->tracks(id) ON DELETE CASCADE и UNIQUE(track_id) — под миксы
--     их пришлось бы разломать (снять NOT NULL, заменить FK на рукописный CHECK);
--   • promo_check_detections читают 5 трек-связанных потребителей (charts-routes [лента
--     new-releases], radio-digest, landing-data, promo-check, track-moderation) → в общей
--     таблице микс-строка протекла бы в трековый контекст при любой забытой WHERE-оговорке.
--   Параллельные таблицы делают такую протечку СТРУКТУРНО невозможной и позволяют дёшево
--   снести всю фичу (DROP двух пустых таблиц), если viability-гейт (matcher ловит длинный
--   микс в эфире?) не пройдёт — трековая система при этом не тронута ни разу.
--
-- Применение (канон проекта, migration-runner = заглушка, руками):
--   Номер 132 — следующий свободный (на диске 131 последняя; 127 ЗАНЯТ videos_pipeline).
--   Dry-run:  ( echo 'BEGIN;'; cat 132_dj_mix_fingerprints_detections.sql; echo 'ROLLBACK;' ) \
--               | sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1
--   Apply:    sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -f 132_dj_mix_fingerprints_detections.sql
-- Аддитивно и идемпотентно (IF NOT EXISTS) — повторный прогон безопасен.

CREATE TABLE IF NOT EXISTS dj_mix_fingerprints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mix_id           text NOT NULL UNIQUE REFERENCES dj_mixes(id) ON DELETE CASCADE,
  fingerprint      bigint[] NOT NULL,
  watermark_id     text NOT NULL UNIQUE,
  duration         double precision NOT NULL DEFAULT 0,
  status           text DEFAULT 'done',
  fingerprinted_at timestamptz DEFAULT now(),
  watermarked_at   timestamptz
);

CREATE TABLE IF NOT EXISTS dj_mix_detections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mix_id              text NOT NULL REFERENCES dj_mixes(id) ON DELETE CASCADE,
  station_id          uuid,
  station_name        text NOT NULL,
  detection_method    text DEFAULT 'fingerprint',
  confidence          double precision NOT NULL,
  watermark_confirmed boolean DEFAULT false,
  detected_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dmd_detected ON dj_mix_detections (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_dmd_station  ON dj_mix_detections (station_id);
CREATE INDEX IF NOT EXISTS idx_dmd_mix      ON dj_mix_detections (mix_id);

-- Единый источник для матчинга в monitor.py: один SELECT, дискриминатор content_type
-- говорит детектору, в какую таблицу писать попадание. watermark_id UNIQUE внутри каждой
-- таблицы; ДЕРЖАТЬ namespace'ы непересекающимися (аллокатор mix-ватермарков не должен
-- выдать id, уже существующий у трека) — иначе обратный маппинг «watermark -> контент»
-- станет двусмысленным. См. generate_watermark_id() в fingerprinter.py.
CREATE OR REPLACE VIEW promo_check_all_fingerprints AS
  SELECT 'track'::text AS content_type, track_id::text AS content_id,
         watermark_id, fingerprint, duration, status
    FROM promo_check_fingerprints
  UNION ALL
  SELECT 'mix'::text AS content_type, mix_id AS content_id,
         watermark_id, fingerprint, duration, status
    FROM dj_mix_fingerprints;
