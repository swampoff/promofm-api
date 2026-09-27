-- Применять под postgres: sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -f <файл>
-- 151: роялти артистам за проигрывания в заведениях ПРОМО.ЭИР (27.09.2026).
--
-- Решение владельца: при размещении трека артист отмечает, что хочет звучать
-- в заведениях, и принимает дополнительное соглашение (/venue-royalty-agreement).
-- PROMO.CHECK фиксирует каждое проигрывание в заведении, за каждое начисляется
-- 20 ₽ на баланс артиста, вывод от 500 ₽ (payment_withdrawals, source='venue_royalty').

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS venue_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS venue_agreement_at timestamptz;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS venue_agreement_version text;

CREATE TABLE IF NOT EXISTS venue_track_plays (
  id             bigserial PRIMARY KEY,
  stream_id      uuid NOT NULL,
  venue_user_id  text,
  venue_name     text,
  point_name     text,
  track_id       uuid NOT NULL,
  artist_user_id text NOT NULL,
  filename       text,
  -- played_at из AutoDJ заведения как есть: ключ от двойного учёта одного проигрывания
  played_key     text NOT NULL,
  played_at      timestamptz NOT NULL DEFAULT now(),
  amount         numeric(10,2) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, played_key)
);
CREATE INDEX IF NOT EXISTS venue_track_plays_artist_idx ON venue_track_plays (artist_user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS venue_track_plays_track_idx ON venue_track_plays (track_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON venue_track_plays TO promofm_app;
GRANT USAGE, SELECT ON SEQUENCE venue_track_plays_id_seq TO promofm_app;
