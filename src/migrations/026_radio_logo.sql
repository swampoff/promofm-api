-- 026_radio_logo.sql — logo + cover для радиостанций
--
-- Радиостанции единственная роль с кабинетом которая не имела
-- собственного логотипа в БД. Sidebar всегда показывал инициалы
-- (`initials` от `getRadioInitials` в src/utils/api/radio-profile.ts).
-- Поскольку маркетплейс радио — пока концепт, до сих пор обходились.
-- Этот PR добавляет колонки + endpoint чтобы привести радио к тому
-- же avatar/cover-паттерну что у других кабинетов.
--
-- Колонки попадают в `radio_profiles` (id PK uuid, user_id text).
-- jsonb `data` уже есть для editor-blob-ов, native колонки нужны
-- для маркетплейс-фильтров и cross-cabinet карточек.
--
-- Идемпотентно через IF NOT EXISTS — миграцию можно гонять
-- повторно без ошибок.

BEGIN;

ALTER TABLE radio_profiles
  ADD COLUMN IF NOT EXISTS logo_url  TEXT,
  ADD COLUMN IF NOT EXISTS cover_url TEXT;

COMMIT;
