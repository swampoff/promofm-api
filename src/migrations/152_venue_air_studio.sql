-- Применять под postgres: sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -f <файл>
-- 152: студия эфира заведения ПРОМО.ЭИР (27.09.2026): повестка ведущих, подкасты,
-- управление через Telegram (@Promomusicalbot, привязка кодом из кабинета).

CREATE TABLE IF NOT EXISTS venue_air_agenda (
  id             bigserial PRIMARY KEY,
  venue_user_id  text NOT NULL,
  text           text NOT NULL,
  source         text NOT NULL DEFAULT 'cabinet',   -- cabinet | telegram | admin
  active         boolean NOT NULL DEFAULT true,
  expires_at     timestamptz,
  aired_count    int NOT NULL DEFAULT 0,
  last_aired_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venue_air_agenda_venue_idx ON venue_air_agenda (venue_user_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS venue_air_telegram (
  venue_user_id      text PRIMARY KEY,
  chat_id            text UNIQUE,
  chat_title         text,
  channel_id         text,
  channel_title      text,
  link_code          text UNIQUE,
  link_code_expires  timestamptz,
  linked_at          timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Что звучало от студии: выходы ведущего, подкасты, записи заведения.
CREATE TABLE IF NOT EXISTS venue_air_log (
  id             bigserial PRIMARY KEY,
  venue_user_id  text NOT NULL,
  stream_id      uuid,
  kind           text NOT NULL,          -- host | podcast | voice
  title          text,
  text           text,
  status         text NOT NULL DEFAULT 'done',  -- done | queued | failed
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS venue_air_log_venue_idx ON venue_air_log (venue_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS venue_air_log_stream_idx ON venue_air_log (stream_id, kind, created_at DESC);

-- Ведущий на потоке: по умолчанию — если в анкете «радио полного цикла»; админ может включить явно.
ALTER TABLE venue_station_streams ADD COLUMN IF NOT EXISTS host_enabled boolean;

GRANT SELECT, INSERT, UPDATE, DELETE ON venue_air_agenda, venue_air_telegram, venue_air_log TO promofm_app;
GRANT USAGE, SELECT ON SEQUENCE venue_air_agenda_id_seq, venue_air_log_id_seq TO promofm_app;
