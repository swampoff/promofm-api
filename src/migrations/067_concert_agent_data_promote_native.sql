-- 061_concert_agent_data_promote_native.sql
--
-- Artist cluster ч.4: concert_agent_data — concerts собранные с внешних
-- источников (KudaGo, Я.Афиша, MTS Live, Kassir). Каждый concert лежит
-- в row с id PK + data jsonb. Promote native cols для индексации по
-- city / sourceId / status / date.
--
-- Anti-pattern был умеренный: row-per-concert уже было (не array-in-value),
-- но `data jsonb` без индексов на published-status / city / date.
-- /status endpoint делал getAll() + JS filter+group.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t concert_agent_data promofm > /tmp/concerts_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/061_concert_agent_data_promote_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

CREATE TABLE IF NOT EXISTS concert_agent_data (
  id TEXT PRIMARY KEY,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE concert_agent_data
  ADD COLUMN IF NOT EXISTS source_id    TEXT,
  ADD COLUMN IF NOT EXISTS source_name  TEXT,
  ADD COLUMN IF NOT EXISTS title        TEXT,
  ADD COLUMN IF NOT EXISTS artist       TEXT,
  ADD COLUMN IF NOT EXISTS venue        TEXT,
  ADD COLUMN IF NOT EXISTS city         TEXT,
  ADD COLUMN IF NOT EXISTS event_date   DATE,
  ADD COLUMN IF NOT EXISTS event_time   TEXT,
  ADD COLUMN IF NOT EXISTS price        TEXT,
  ADD COLUMN IF NOT EXISTS ticket_url   TEXT,
  ADD COLUMN IF NOT EXISTS image_url    TEXT,
  ADD COLUMN IF NOT EXISTS description  TEXT,
  ADD COLUMN IF NOT EXISTS genre        TEXT,
  ADD COLUMN IF NOT EXISTS status       TEXT          NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS extra        JSONB         NOT NULL DEFAULT '{}'::jsonb;

UPDATE concert_agent_data SET
  source_id   = COALESCE(source_id,   NULLIF(data->>'sourceId','')),
  source_name = COALESCE(source_name, NULLIF(data->>'source','')),
  title       = COALESCE(title,       NULLIF(data->>'title','')),
  artist      = COALESCE(artist,      NULLIF(data->>'artist','')),
  venue       = COALESCE(venue,       NULLIF(data->>'venue','')),
  city        = COALESCE(city,        NULLIF(data->>'city','')),
  event_date  = COALESCE(event_date,  NULLIF(data->>'date','')::date),
  event_time  = COALESCE(event_time,  NULLIF(data->>'time','')),
  price       = COALESCE(price,       NULLIF(data->>'price','')),
  ticket_url  = COALESCE(ticket_url,  NULLIF(data->>'ticketUrl','')),
  image_url   = COALESCE(image_url,   NULLIF(data->>'imageUrl','')),
  description = COALESCE(description, NULLIF(data->>'description','')),
  genre       = COALESCE(genre,       NULLIF(data->>'genre','')),
  status      = CASE WHEN status = 'published' AND data->>'status' IS NOT NULL
                     THEN data->>'status'
                     ELSE status END,
  created_at  = COALESCE(created_at,  NULLIF(data->>'createdAt','')::timestamptz)
WHERE jsonb_typeof(data) = 'object';

CREATE INDEX IF NOT EXISTS idx_concerts_published_date
  ON concert_agent_data(event_date)
  WHERE status = 'published' AND event_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_concerts_city_date
  ON concert_agent_data(city, event_date)
  WHERE status = 'published' AND city IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_concerts_source
  ON concert_agent_data(source_id)
  WHERE source_id IS NOT NULL;

ALTER TABLE concert_agent_data DROP COLUMN IF EXISTS data;
