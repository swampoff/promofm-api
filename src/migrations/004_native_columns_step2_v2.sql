-- Step 2 v2 — мигрируем РЕАЛЬНЫЕ KV-style таблицы (id, data jsonb).
-- Каждая таблица в собственной транзакции — если одна fall over, остальные применяются.

-- =====================================================================
-- 1. news_public (1177 rows) — news feed, ХОТКАЯ зона чтения
-- =====================================================================
BEGIN;
ALTER TABLE news_public
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS author_name TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS image_url TEXT;

UPDATE news_public SET
  status       = COALESCE(status, data->>'status'),
  category     = COALESCE(category, data->>'category'),
  source       = COALESCE(source, data->>'source'),
  source_id    = COALESCE(source_id, data->>'sourceId'),
  source_url   = COALESCE(source_url, data->>'sourceUrl'),
  title        = COALESCE(title, data->>'title'),
  author_name  = COALESCE(author_name, data->>'authorName'),
  published_at = COALESCE(published_at, NULLIF(data->>'publishedAt','')::timestamptz),
  image_url    = COALESCE(image_url, data->>'imageUrl')
WHERE data IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_news_public_status        ON news_public(status);
CREATE INDEX IF NOT EXISTS idx_news_public_category      ON news_public(category);
CREATE INDEX IF NOT EXISTS idx_news_public_published_at  ON news_public(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_public_source        ON news_public(source);

CREATE OR REPLACE FUNCTION sync_news_public_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.status       := COALESCE(NEW.status,       NEW.data->>'status');
    NEW.category     := COALESCE(NEW.category,     NEW.data->>'category');
    NEW.source       := COALESCE(NEW.source,       NEW.data->>'source');
    NEW.source_id    := COALESCE(NEW.source_id,    NEW.data->>'sourceId');
    NEW.source_url   := COALESCE(NEW.source_url,   NEW.data->>'sourceUrl');
    NEW.title        := COALESCE(NEW.title,        NEW.data->>'title');
    NEW.author_name  := COALESCE(NEW.author_name,  NEW.data->>'authorName');
    NEW.published_at := COALESCE(NEW.published_at, NULLIF(NEW.data->>'publishedAt','')::timestamptz);
    NEW.image_url    := COALESCE(NEW.image_url,    NEW.data->>'imageUrl');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_news_public ON news_public;
CREATE TRIGGER trg_sync_news_public BEFORE INSERT OR UPDATE ON news_public
  FOR EACH ROW EXECUTE FUNCTION sync_news_public_native();
COMMIT;

-- =====================================================================
-- 2. concert_agent_data (354 rows) — концерты в админке/поиске
-- =====================================================================
BEGIN;
ALTER TABLE concert_agent_data
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS artist TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS venue TEXT,
  ADD COLUMN IF NOT EXISTS genre TEXT,
  ADD COLUMN IF NOT EXISTS event_date DATE,
  ADD COLUMN IF NOT EXISTS event_time TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS ticket_url TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS price NUMERIC;

UPDATE concert_agent_data SET
  status     = COALESCE(status, data->>'status'),
  city       = COALESCE(city, data->>'city'),
  artist     = COALESCE(artist, data->>'artist'),
  title      = COALESCE(title, data->>'title'),
  venue      = COALESCE(venue, data->>'venue'),
  genre      = COALESCE(genre, data->>'genre'),
  event_date = COALESCE(event_date, NULLIF(data->>'date','')::date),
  event_time = COALESCE(event_time, data->>'time'),
  source_id  = COALESCE(source_id, data->>'sourceId'),
  ticket_url = COALESCE(ticket_url, data->>'ticketUrl'),
  image_url  = COALESCE(image_url, data->>'imageUrl'),
  price      = COALESCE(price, NULLIF(data->>'price','')::numeric)
WHERE data IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_concert_agent_data_status     ON concert_agent_data(status);
CREATE INDEX IF NOT EXISTS idx_concert_agent_data_city       ON concert_agent_data(city);
CREATE INDEX IF NOT EXISTS idx_concert_agent_data_event_date ON concert_agent_data(event_date);
CREATE INDEX IF NOT EXISTS idx_concert_agent_data_artist     ON concert_agent_data(artist);

CREATE OR REPLACE FUNCTION sync_concert_agent_data_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.status     := COALESCE(NEW.status,     NEW.data->>'status');
    NEW.city       := COALESCE(NEW.city,       NEW.data->>'city');
    NEW.artist     := COALESCE(NEW.artist,     NEW.data->>'artist');
    NEW.title      := COALESCE(NEW.title,      NEW.data->>'title');
    NEW.venue      := COALESCE(NEW.venue,      NEW.data->>'venue');
    NEW.genre      := COALESCE(NEW.genre,      NEW.data->>'genre');
    NEW.event_date := COALESCE(NEW.event_date, NULLIF(NEW.data->>'date','')::date);
    NEW.event_time := COALESCE(NEW.event_time, NEW.data->>'time');
    NEW.source_id  := COALESCE(NEW.source_id,  NEW.data->>'sourceId');
    NEW.ticket_url := COALESCE(NEW.ticket_url, NEW.data->>'ticketUrl');
    NEW.image_url  := COALESCE(NEW.image_url,  NEW.data->>'imageUrl');
    NEW.price      := COALESCE(NEW.price,      NULLIF(NEW.data->>'price','')::numeric);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_concert_agent_data ON concert_agent_data;
CREATE TRIGGER trg_sync_concert_agent_data BEFORE INSERT OR UPDATE ON concert_agent_data
  FOR EACH ROW EXECUTE FUNCTION sync_concert_agent_data_native();
COMMIT;

-- =====================================================================
-- 3. verification_tokens (143 rows) — auth tokens, нужен expires_at index
-- =====================================================================
BEGIN;
ALTER TABLE verification_tokens
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS token_type TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

UPDATE verification_tokens SET
  user_id    = COALESCE(user_id, data->>'user_id'),
  token_type = COALESCE(token_type, data->>'type'),
  expires_at = COALESCE(expires_at, NULLIF(data->>'expires_at','')::timestamptz),
  used_at    = COALESCE(used_at, NULLIF(data->>'used_at','')::timestamptz)
WHERE data IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_verif_tokens_user       ON verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_verif_tokens_expires_at ON verification_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_verif_tokens_type       ON verification_tokens(token_type);

CREATE OR REPLACE FUNCTION sync_verification_tokens_native() RETURNS trigger AS $$
BEGIN
  IF NEW.data IS NOT NULL AND jsonb_typeof(NEW.data) = 'object' THEN
    NEW.user_id    := COALESCE(NEW.user_id,    NEW.data->>'user_id');
    NEW.token_type := COALESCE(NEW.token_type, NEW.data->>'type');
    NEW.expires_at := COALESCE(NEW.expires_at, NULLIF(NEW.data->>'expires_at','')::timestamptz);
    NEW.used_at    := COALESCE(NEW.used_at,    NULLIF(NEW.data->>'used_at','')::timestamptz);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_verification_tokens ON verification_tokens;
CREATE TRIGGER trg_sync_verification_tokens BEFORE INSERT OR UPDATE ON verification_tokens
  FOR EACH ROW EXECUTE FUNCTION sync_verification_tokens_native();
COMMIT;
