-- Хвост связки: 213 треков, чей artist_id не совпал ни с профилем, ни с
-- пользователем — это записи, оставшиеся от удалённых или пересозданных
-- профилей. Все их имена однозначно находятся в artist_profiles
-- (Artik & Asti, DJ Smash, Нэлли Мотяева и другие), поэтому связываем
-- по имени.
--
-- Берём только имена, у которых РОВНО ОДИН профиль: там, где профилей
-- с одинаковым именем несколько, угадывать нельзя — такой трек лучше
-- оставить несвязанным, чем приписать чужому артисту.

BEGIN;

UPDATE tracks t
   SET artist_id = uniq.pid, updated_at = now()
  FROM (
    SELECT lower(btrim(artist_name)) AS n, min(id::text)::uuid AS pid
      FROM artist_profiles
     WHERE NULLIF(btrim(artist_name), '') IS NOT NULL
     GROUP BY 1 HAVING count(*) = 1
  ) uniq
 WHERE uniq.n = lower(btrim(t.artist_name))
   AND t.artist_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM artist_profiles ap WHERE ap.id = t.artist_id);

COMMIT;
