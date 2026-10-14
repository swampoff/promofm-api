-- 159: международный питчинг (бета, 14.10.2026) — бонус к оплаченному размещению трека.
-- Владелец: «представить новую услугу на сайте как тестовый бонус к обычному размещению»;
-- база — таблица Codex v19 (742 адреса, 70 стран), отправка — еженедельной подборкой
-- после подтверждения админом, одно письмо станции в неделю.

CREATE TABLE IF NOT EXISTS intl_radio_contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment          TEXT NOT NULL,              -- ru | cis | world_ru | world
  country          TEXT NOT NULL,
  city             TEXT,
  station_name     TEXT NOT NULL,
  contact_name     TEXT,
  contact_type     TEXT,
  email            TEXT NOT NULL,
  phone            TEXT,
  website          TEXT,
  source_url       TEXT,
  priority         TEXT,
  repertoire_note  TEXT,
  note             TEXT,
  lang             TEXT NOT NULL DEFAULT 'en', -- язык писем: ru | en
  formats          TEXT[] NOT NULL DEFAULT '{}', -- dance, hiphop, rock, jazz, classical, world, reggae, chanson, kids
  excluded         BOOLEAN NOT NULL DEFAULT false,  -- реклама/техподдержка/«не для питчинга»
  exclude_reason   TEXT,
  in_ru_base       BOOLEAN NOT NULL DEFAULT false,  -- уже получает русскую еженедельную рассылку
  active           BOOLEAN NOT NULL DEFAULT true,
  unsubscribed_at  TIMESTAMPTZ,
  bounced_at       TIMESTAMPTZ,
  last_sent_at     TIMESTAMPTZ,
  send_count       INTEGER NOT NULL DEFAULT 0,
  source_file      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_intl_radio_contacts_email ON intl_radio_contacts (lower(email));

CREATE TABLE IF NOT EXISTS intl_pitch_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id      UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  genre_group   TEXT NOT NULL DEFAULT 'pop',
  consent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued | in_digest | sent | excluded | withdrawn
  digest_id     UUID,
  admin_note    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_intl_pitch_requests_track ON intl_pitch_requests (track_id);
CREATE INDEX IF NOT EXISTS idx_intl_pitch_requests_user ON intl_pitch_requests (user_id);

CREATE TABLE IF NOT EXISTS intl_digests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft | sending | sent | cancelled
  track_ids      UUID[] NOT NULL DEFAULT '{}',
  recipients     INTEGER NOT NULL DEFAULT 0,
  sent_count     INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT,
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS intl_digest_sends (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_id   UUID NOT NULL REFERENCES intl_digests(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES intl_radio_contacts(id) ON DELETE CASCADE,
  track_ids   UUID[] NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed | skipped
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_intl_digest_sends ON intl_digest_sends (digest_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_intl_digest_sends_status ON intl_digest_sends (status) WHERE status = 'queued';

-- Скачивания по личной ссылке из международной подборки
ALTER TABLE track_downloads_by_radio ADD COLUMN IF NOT EXISTS intl_contact_id UUID;
CREATE INDEX IF NOT EXISTS idx_tdbr_intl_contact ON track_downloads_by_radio (intl_contact_id) WHERE intl_contact_id IS NOT NULL;
