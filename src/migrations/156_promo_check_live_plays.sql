-- 156: PROMO.CHECK Live — настоящие эфиры по водяному знаку (02.10.2026)
--
-- promo-check/live_monitor.py слушает станции непрерывно и пишет сюда ПРОИГРЫВАНИЯ
-- (одно проигрывание = одна ротация), найденные только по нашему водяному знаку.
-- Отпечатки (Chromaprint) сюда не попадают — ложных эфиров здесь нет.
-- Старая таблица promo_check_detections и витрина не меняются.
-- Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS promo_check_plays (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type   text NOT NULL DEFAULT 'track',          -- 'track' | 'mix'
  track_id       uuid REFERENCES tracks(id) ON DELETE CASCADE,
  mix_id         text,
  station_id     uuid NOT NULL,                           -- promo_check_monitoring.station_id
  station_name   text NOT NULL,
  started_at     timestamptz NOT NULL,                    -- начало первого куска с водяным знаком
  last_heard_at  timestamptz NOT NULL,                    -- конец последнего куска с водяным знаком
  hits           integer NOT NULL DEFAULT 1,              -- сколько 30-с кусков подтвердили
  max_score      real,
  method         text NOT NULL DEFAULT 'watermark',
  evidence_path  text,                                    -- фрагмент эфира (внутреннее доказательство)
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((content_type = 'track' AND track_id IS NOT NULL) OR (content_type = 'mix' AND mix_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_pcp_track   ON promo_check_plays (track_id, started_at DESC) WHERE track_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pcp_mix     ON promo_check_plays (mix_id, started_at DESC) WHERE mix_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pcp_station ON promo_check_plays (station_id, started_at DESC);

CREATE TABLE IF NOT EXISTS promo_check_live_status (
  station_id        uuid PRIMARY KEY,
  station_name      text,
  capture_state     text,               -- running | restarting | stopped
  last_segment_at   timestamptz,
  segments_ok       bigint NOT NULL DEFAULT 0,
  segments_skipped  bigint NOT NULL DEFAULT 0,
  hits_total        bigint NOT NULL DEFAULT 0,
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON promo_check_plays, promo_check_live_status TO promofm_app;

COMMIT;
