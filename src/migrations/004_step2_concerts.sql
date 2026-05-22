-- concert_agent_data — price хранит свободный текст ("от 600 рублей"). Делаем TEXT.
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
  ADD COLUMN IF NOT EXISTS price_text TEXT,
  ADD COLUMN IF NOT EXISTS price_numeric NUMERIC;

-- безопасный backfill
UPDATE concert_agent_data SET
  status      = COALESCE(status, data->>'status'),
  city        = COALESCE(city, data->>'city'),
  artist      = COALESCE(artist, data->>'artist'),
  title       = COALESCE(title, data->>'title'),
  venue       = COALESCE(venue, data->>'venue'),
  genre       = COALESCE(genre, data->>'genre'),
  event_time  = COALESCE(event_time, data->>'time'),
  source_id   = COALESCE(source_id, data->>'sourceId'),
  ticket_url  = COALESCE(ticket_url, data->>'ticketUrl'),
  image_url   = COALESCE(image_url, data->>'imageUrl'),
  price_text  = COALESCE(price_text, data->>'price')
WHERE data IS NOT NULL;

-- event_date — отдельно, может быть невалидной строкой
UPDATE concert_agent_data SET
  event_date = NULLIF(data->>'date','')::date
WHERE data IS NOT NULL
  AND event_date IS NULL
  AND data->>'date' ~ '^\d{4}-\d{2}-\d{2}';

-- price_numeric — извлекаем первое число из строки
UPDATE concert_agent_data SET
  price_numeric = substring(data->>'price' from '(\d+)')::numeric
WHERE data IS NOT NULL
  AND price_numeric IS NULL
  AND data->>'price' ~ '\d';

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
    NEW.event_time := COALESCE(NEW.event_time, NEW.data->>'time');
    NEW.source_id  := COALESCE(NEW.source_id,  NEW.data->>'sourceId');
    NEW.ticket_url := COALESCE(NEW.ticket_url, NEW.data->>'ticketUrl');
    NEW.image_url  := COALESCE(NEW.image_url,  NEW.data->>'imageUrl');
    NEW.price_text := COALESCE(NEW.price_text, NEW.data->>'price');
    IF NEW.event_date IS NULL AND NEW.data->>'date' ~ '^\d{4}-\d{2}-\d{2}' THEN
      NEW.event_date := (NEW.data->>'date')::date;
    END IF;
    IF NEW.price_numeric IS NULL AND NEW.data->>'price' ~ '\d' THEN
      NEW.price_numeric := substring(NEW.data->>'price' from '(\d+)')::numeric;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_concert_agent_data ON concert_agent_data;
CREATE TRIGGER trg_sync_concert_agent_data BEFORE INSERT OR UPDATE ON concert_agent_data
  FOR EACH ROW EXECUTE FUNCTION sync_concert_agent_data_native();
COMMIT;
