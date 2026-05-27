-- 050_radio_ad_slots_promote_jsonb_to_native.sql
--
-- Wave 3 #4/7: radio_ad_slots — KV (id PK + data JSONB + radio_id col)
-- → row-per-slot с 8 native cols + индекс на (radio_id, created_at DESC).
--
-- Также DROP'аем сопутствующую таблицу radio_ad_slot_index — она хранила
-- JSON-массив slot_id'ов на каждую станцию для перечисления слотов.
-- С нативным индексом на (radio_id, created_at DESC) этот «индекс»
-- больше не нужен (`SELECT … WHERE radio_id = $1 ORDER BY created_at DESC`
-- даёт то же самое + автоматически синхронен с INSERT/DELETE, тогда как
-- два отдельных write'а могут разъехаться).
--
-- 🐛 BUG'и закрываемые этим refactor'ом (handler-side, не SQL):
--   - DELETE /ad-slots/:id — radioAdSlotsStore.del(slotId) удаляет
--     только по id, БЕЗ проверки radio_id. **IDOR**: любой залогиненный
--     юзер с известным slotId мог удалить чужой слот. Фикс — composite
--     WHERE (radio_id, id) с rowCount check.
--   - Создание / удаление слота делает 2 write'а (slot + index), без
--     транзакции. Если падал второй — slot orphan'ом, либо index ссылался
--     на удалённый slot.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d radio_ad_slots
--   \d radio_ad_slot_index
--   SELECT COUNT(*) total,
--          COUNT(*) FILTER (WHERE radio_id IS NOT NULL) with_radio,
--          COUNT(DISTINCT data->>'slotType') slot_types,
--          COUNT(DISTINCT data->>'status') statuses
--     FROM radio_ad_slots;
--   -- index table contents (для понимания миграции);
--   SELECT radio_id,
--          jsonb_array_length(data) idx_len,
--          (SELECT COUNT(*) FROM radio_ad_slots s
--            WHERE s.radio_id = i.radio_id) actual_len
--     FROM radio_ad_slot_index i;
--   SELECT polname FROM pg_policy
--    WHERE polrelid::regclass::text='radio_ad_slots';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t radio_ad_slots -t radio_ad_slot_index promofm
--        > /tmp/radio_slots_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/050_radio_ad_slots_promote_jsonb_to_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Bootstrap legacy kv-store если lazy mode так и не создал таблицу.
CREATE TABLE IF NOT EXISTS radio_ad_slots (
  id TEXT PRIMARY KEY,
  radio_id TEXT,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE radio_ad_slots
  ADD COLUMN IF NOT EXISTS radio_id      TEXT,
  ADD COLUMN IF NOT EXISTS slot_type     TEXT          NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS time_slot     TEXT,          -- '12:00-13:00'
  ADD COLUMN IF NOT EXISTS price         NUMERIC       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duration      INTEGER       NOT NULL DEFAULT 30,  -- seconds
  ADD COLUMN IF NOT EXISTS max_per_hour  INTEGER       NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS status        TEXT          NOT NULL DEFAULT 'available';
  -- статусы: 'available' | 'booked' | 'inactive'

-- Backfill: handler пишет camelCase в jsonb (slotType, timeSlot, maxPerHour,
-- createdAt, updatedAt), а radio_id уже native col со времён legacy schema.
UPDATE radio_ad_slots SET
  radio_id     = COALESCE(radio_id,    NULLIF(data->>'stationId','')),
  slot_type    = CASE WHEN slot_type = 'standard' AND data->>'slotType' IS NOT NULL
                      THEN data->>'slotType'
                      ELSE slot_type END,
  time_slot    = COALESCE(time_slot,   NULLIF(data->>'timeSlot','')),
  price        = CASE WHEN price = 0 AND data->>'price' IS NOT NULL
                      THEN COALESCE(NULLIF(data->>'price','')::numeric, 0)
                      ELSE price END,
  duration     = CASE WHEN duration = 30 AND data->>'duration' IS NOT NULL
                      THEN COALESCE(NULLIF(data->>'duration','')::integer, 30)
                      ELSE duration END,
  max_per_hour = CASE WHEN max_per_hour = 4 AND data->>'maxPerHour' IS NOT NULL
                      THEN COALESCE(NULLIF(data->>'maxPerHour','')::integer, 4)
                      ELSE max_per_hour END,
  description  = COALESCE(description, NULLIF(data->>'description','')),
  status       = CASE WHEN status = 'available' AND data->>'status' IS NOT NULL
                      THEN data->>'status'
                      ELSE status END,
  -- handler писал createdAt/updatedAt в data; перенесём в native колонки
  -- только если native ещё не set (table-level defaults уже стоят NOW()).
  created_at   = COALESCE(created_at,  NULLIF(data->>'createdAt','')::timestamptz),
  updated_at   = COALESCE(updated_at,  NULLIF(data->>'updatedAt','')::timestamptz)
WHERE jsonb_typeof(data) = 'object';

-- Hot-path index: list-slots-by-station (раньше требовал отдельный
-- radio_ad_slot_index table). Composite (radio_id, created_at DESC)
-- даёт sorted enumeration без отдельной index-таблицы.
CREATE INDEX IF NOT EXISTS idx_radio_ad_slots_station_created
  ON radio_ad_slots(radio_id, created_at DESC)
  WHERE radio_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_radio_ad_slots_station_status
  ON radio_ad_slots(radio_id, status)
  WHERE radio_id IS NOT NULL;

-- DROP COLUMN data — всё промоутировано в native cols.
ALTER TABLE radio_ad_slots DROP COLUMN IF EXISTS data;

-- DROP избыточную index-таблицу. Если ещё не существует (lazy mode) — IF EXISTS no-op.
DROP TABLE IF EXISTS radio_ad_slot_index;
