-- 112_dj_availability_blocks.sql
--
-- Row-per-day-block таблица для DJ-кабинета: «забить» / «освободить»
-- дату в календаре. До этой миграции календарь умел только показывать
-- bookings (read-only) + кнопка block/unblock не существовала.
--
-- НЕ туда лезть: booking_calendar — KV-стайл (1 row на performer-date,
-- data jsonb), не подходит как «taxi-style» сабтаблица для пометок
-- продюсера. Под мандат CLAUDE.md «row-per-entity» делаю отдельную таблицу.
--
-- Schema:
--   id           UUID PK DEFAULT gen_random_uuid()
--   dj_id        TEXT NOT NULL — owner-check (dj_profiles.user_id is TEXT)
--   date         DATE NOT NULL — день, который заблокирован
--   reason       TEXT — опционально: «отпуск», «ремонт», «занят»
--   created_at, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
--
-- Composite UNIQUE предотвращает дубли: один DJ × одна дата = один блок.
-- ON CONFLICT (dj_id, date) DO NOTHING → idempotent.

CREATE TABLE IF NOT EXISTS dj_availability_blocks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dj_id       TEXT NOT NULL,
  date        DATE NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dj_availability_blocks_dj_date
  ON dj_availability_blocks (dj_id, date);

CREATE INDEX IF NOT EXISTS idx_dj_availability_blocks_date
  ON dj_availability_blocks (date);
