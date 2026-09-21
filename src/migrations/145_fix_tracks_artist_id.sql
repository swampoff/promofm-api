-- tracks.artist_id хранил идентификатор ПОЛЬЗОВАТЕЛЯ вместо профиля.
--
-- Код везде считает, что artist_id — это artist_profiles.id: так
-- написаны и публичный профиль артиста, и лендинг, и аналитика. А в
-- данных лежали user_id: из 5934 треков попадали в профиль только 266,
-- остальные 5621 указывали в пустоту.
--
-- Симптом известен и зафиксирован прямо в коде
-- (artist-profile-routes.tsx:781): «why real artists with 30+ tracks saw
-- 0 треков publicly». Обходились двойным JOIN'ом — по id и по имени;
-- там, где обхода не было, данные просто терялись.
--
-- Порядок важен: сначала сохраняем владельца в user_id (он пуст у 5543
-- треков), и только потом переписываем artist_id. Иначе связь трека с
-- аккаунтом исчезнет — ai-score и выдача «мои треки» ходят по user_id.
--
-- Треки, у которых user_id уже заполнен и отличается (334 штуки —
-- загрузки лейбла от имени артиста), НЕ трогаем: там владелец не равен
-- артисту, и перезапись была бы потерей смысла.

BEGIN;

-- Страховка: снимок связки до правки. Дропнуть после проверки.
CREATE TABLE IF NOT EXISTS tracks_artist_id_backup_20260921 AS
SELECT id, artist_id, user_id FROM tracks;

-- 1. Сохраняем владельца там, где его ещё нет.
UPDATE tracks t
   SET user_id = t.artist_id::text
  FROM artist_profiles ap
 WHERE ap.user_id = t.artist_id::text
   AND t.user_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM artist_profiles a2 WHERE a2.id = t.artist_id);

-- 2. Переписываем artist_id на идентификатор профиля.
UPDATE tracks t
   SET artist_id = ap.id, updated_at = now()
  FROM artist_profiles ap
 WHERE ap.user_id = t.artist_id::text
   AND NOT EXISTS (SELECT 1 FROM artist_profiles a2 WHERE a2.id = t.artist_id);

COMMIT;
