-- Анкета букинга: единая для артиста, диджея, кавер-группы и ведущего.
--
-- Почему отдельная таблица, а не колонки в artist_profiles: анкета
-- одинаковая для всех типов исполнителей, а профили лежат в разных
-- таблицах (artist_profiles ~2765 строк, dj_profiles ~11). Одна таблица
-- по user_id даёт getPerformerProfile() единственный источник правды.
--
-- Что она чинит: в booking-routes.tsx у артистов bookingEnabled было
-- захардкожено в true, ставка выдумывалась (hourlyRate || 5000), а
-- fallback-ветка делала исполнителем ЛЮБОГО зарегистрированного
-- пользователя. То есть «забукать» можно было кого угодно по
-- несуществующему тарифу. Теперь исполнителем считается только тот, кто
-- сам открыл анкету (is_open).
--
-- Владелец 20.09.2026: исполнитель включает букинг сам; гонорар публично
-- НЕ показывается — в карточке всегда «по запросу». Поэтому fee_hint
-- служебное поле, наружу его отдавать нельзя.

CREATE TABLE IF NOT EXISTS booking_profiles (
  user_id            text PRIMARY KEY,

  -- 'artist' | 'dj' | 'cover_band' | 'host' — новый тип исполнителя
  -- добавляется строкой, а не новой ролью пользователя с отдельной
  -- регистрацией, модерацией и кабинетом.
  performer_category text NOT NULL DEFAULT 'artist',

  -- Главный переключатель: пока false, исполнителя нет ни в каталоге,
  -- ни в приёме заявок.
  is_open            boolean NOT NULL DEFAULT false,

  display_name       text,
  about              text,
  cities             text[] NOT NULL DEFAULT '{}',   -- где готов выступать
  formats            text[] NOT NULL DEFAULT '{}',   -- свадьба, корпоратив, фестиваль, клуб…

  -- Внутренний ориентир гонорара для переговоров. НИКОГДА не отдаётся в
  -- публичные эндпоинты: в карточке «по запросу».
  fee_hint           numeric,
  min_duration_hours numeric DEFAULT 1,

  -- Технический и бытовой райдер. Свободная форма: у кавер-группы и у
  -- диджея требования устроены по-разному, жёсткая схема тут только
  -- мешала бы.
  rider              jsonb NOT NULL DEFAULT '{}'::jsonb,

  contact_name       text,
  contact_phone      text,
  contact_email      text,

  moderation_status  text NOT NULL DEFAULT 'approved',

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Каталог всегда фильтрует по is_open, поэтому индекс частичный.
CREATE INDEX IF NOT EXISTS idx_booking_profiles_open
  ON booking_profiles (performer_category)
  WHERE is_open = true;

CREATE INDEX IF NOT EXISTS idx_booking_profiles_cities
  ON booking_profiles USING gin (cities)
  WHERE is_open = true;

COMMENT ON TABLE booking_profiles IS
  'Анкета букинга исполнителя (артист, DJ, кавер-группа, ведущий). Заполняет сам исполнитель в кабинете.';
COMMENT ON COLUMN booking_profiles.fee_hint IS
  'Служебный ориентир гонорара для переговоров. В публичные эндпоинты НЕ отдаётся — в карточке «по запросу».';
COMMENT ON COLUMN booking_profiles.is_open IS
  'Исполнитель сам открыл букинг. До этого он не виден в каталоге и заявку по нему создать нельзя.';

-- Триггер updated_at — как у остальных таблиц (функция update_updated_at
-- уже есть, её используют event_requests и bookings).
DROP TRIGGER IF EXISTS trg_booking_profiles_updated_at ON booking_profiles;
CREATE TRIGGER trg_booking_profiles_updated_at
  BEFORE UPDATE ON booking_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
