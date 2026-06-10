-- Migration 105: backfill nested envelope в dj_profiles.data
--
-- Контекст (PROMO.FM аудит 2026-06-05, P1): editor-frontend
-- (DjProfileEditor.tsx) читает поля из `data.profile.djName` и т.д.,
-- но в БД часть строк хранится плоско — `data.djName`, `data.bio`,
-- `data.openForBookings`. Возникло из:
--   1. Legacy upsertDjProfile() до 2026-05-25 не сохранял nested envelope.
--   2. SQL-seeded QA-аккаунты писали поля прямо в верхний уровень data.
--
-- Бэкенд маскирует через ensureNestedDjEnvelope() на каждом read
-- (dj-studio-routes.tsx:253), но это work-around. Источник истины
-- (БД) остаётся неконсистентным, а в марктплейсе при join'ах с
-- data->>'djName' через JSONB-операторы реально текут пустые значения.
--
-- Эта миграция мигрирует плоский shape в nested ОДНОКРАТНО, после чего
-- ensureNestedDjEnvelope становится noop (но остаётся в коде как
-- defensive — на случай если qa руками вставит flat row).
--
-- Идемпотентна: NOT (data ? 'profile') гарантирует пропуск уже-nested
-- строк. Можно безопасно перезапускать.

WITH editor_keys AS (
  SELECT ARRAY[
    'djName', 'dj_name', 'stageName',
    'bio', 'about',
    'avatarUrl', 'avatar_url', 'coverUrl',
    'city', 'country', 'location',
    'genres', 'tags', 'specializations',
    'hourlyRate', 'ratePerHour', 'ratePerEvent', 'priceFrom',
    'openForBookings', 'isAvailable',
    'experienceYears', 'completedGigs', 'rating',
    'photo', 'photo_url'
  ]::text[] AS keys
),
targets AS (
  SELECT dp.user_id, dp.data, ek.keys
  FROM dj_profiles dp
  CROSS JOIN editor_keys ek
  WHERE dp.data IS NOT NULL
    AND jsonb_typeof(dp.data) = 'object'
    AND NOT (dp.data ? 'profile')
    AND dp.data ?| ek.keys
)
UPDATE dj_profiles dp
SET data = (
  -- Remove editor keys from top level…
  (
    SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
    FROM jsonb_each(t.data) AS f(k, v)
    WHERE NOT (k = ANY(t.keys))
  )
  -- …and add them back under data.profile, dropping nulls.
  || jsonb_build_object(
       'profile',
       jsonb_strip_nulls(
         (
           SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
           FROM jsonb_each(t.data) AS f(k, v)
           WHERE k = ANY(t.keys)
         )
       )
     )
)
FROM targets t
WHERE dp.user_id = t.user_id;
