-- Применять под postgres: sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -f <файл>
-- 153: собственный фоновый каталог ПРОМО.ЭИР (27.09.2026). Треки генерируются на
-- арендованном GPU (services/promo-air-catalog) и заливаются через POST /air-catalog/ingest.
-- ⛔ Коммерческая тайна: в публичных текстах способ создания каталога не раскрывается.
-- Провенанс хранится по каждому треку (модель, версия, промпт, seed) — цепочка прав.

CREATE TABLE IF NOT EXISTS air_catalog_tracks (
  id              text PRIMARY KEY,            -- <genre>-p<prompt>-v<variation>-<model>
  genre           text NOT NULL,
  prompt_id       text,
  variation       int,
  prompt          text NOT NULL,
  negative_prompt text,
  model           text NOT NULL,               -- sa3-medium | ace-step-1.5-xl-turbo
  model_version   text,
  seed            bigint,
  steps           int,
  duration_sec    numeric(8,2),
  bpm             int,
  loudness_lufs   numeric(6,2),
  peak_db         numeric(6,2),
  file_path       text NOT NULL,
  bytes           bigint,
  status          text NOT NULL DEFAULT 'new', -- new | approved | rejected
  compiler        text NOT NULL DEFAULT 'Моисеев Никита Владимирович',  -- составитель и продюсер каталога
  producer        text NOT NULL DEFAULT 'ООО «ПФМ»',                     -- изготовитель фонограммы
  generated_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS air_catalog_tracks_genre_idx ON air_catalog_tracks (genre, status);
CREATE INDEX IF NOT EXISTS air_catalog_tracks_model_idx ON air_catalog_tracks (model);

GRANT SELECT, INSERT, UPDATE, DELETE ON air_catalog_tracks TO promofm_app;
