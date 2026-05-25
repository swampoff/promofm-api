-- 027_profile_user_id_unique.sql — UNIQUE на user_id для остальных
-- profile-таблиц (зеркало того что давно было у dj_profiles).
--
-- Контекст: фикс laptop'a 8652379 + ef43096 для DJ:
--   - upsertDjProfile падал с `dj_profiles_user_id_key duplicate`
--     потому что код пинал `id: djId` (где djId === user_id) а
--     PK `id` был auto-uuid и НЕ совпадал с user_id у existing
--     строки. UNIQUE на user_id выявлял конфликт, INSERT падал,
--     ошибка логировалась но не пробрасывалась → handler 200,
--     данные не сохранены.
--   - Fix: убрать `id` из row + `onConflict: 'user_id'`.
--     Этот PR применяет тот же фикс в db.tsx для venue / radio /
--     producer профилей. Engineer уже был написан корректно
--     (миграция 025 имеет UNIQUE на user_id).
--
-- ЧТО этот SQL делает:
--
-- Создаёт UNIQUE индекс на `user_id` для venue_profiles /
-- radio_profiles / producer_profiles ЕСЛИ ещё нет. Это
-- предусловие для нового `onConflict: 'user_id'` UPSERT — иначе
-- pg-supabase не сможет применить ON CONFLICT clause на колонку
-- без UNIQUE constraint.
--
-- ЧТО НЕ делает:
--
-- Не дедупит. Если по какой-то таблице уже есть несколько строк
-- с одним user_id, CREATE UNIQUE INDEX упадёт с понятной ошибкой
-- — laptop разбирает duplicates вручную в SQL прежде чем гнать
-- миграцию. Это плата за безопасность: лучше упасть на миграции
-- и явно посмотреть прод, чем тихо потерять одну из копий.
--
-- Идемпотентно через IF NOT EXISTS.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS venue_profiles_user_id_key
  ON venue_profiles (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS radio_profiles_user_id_key
  ON radio_profiles (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS producer_profiles_user_id_key
  ON producer_profiles (user_id);

COMMIT;
