-- Российские артисты платформы попадают в каталог букинга.
--
-- Решение владельца 21.09.2026: «в букинг добавляй всех российских
-- артистов, что у нас размещаются и кого мы добавляем сами». То есть
-- opt-in остаётся механизмом (артист может выключить себя в кабинете),
-- но стартовое состояние для российских артистов с релизами — включено.
--
-- Кто попадает: профиль со страной Россия, с аккаунтом, с именем и хотя
-- бы одним одобренным или опубликованным треком. Связь трека с профилем
-- идёт ПО ИМЕНИ, а не по artist_id: у 2300 из 2489 артистов в треках
-- artist_id указывает на записи, которых в artist_profiles нет
-- (последствие импорта старой базы), зато имена совпадают у 2299.
--
-- Демо- и тестовые профили исключены: «Demo Artist» с 90 треками в
-- каталоге живых исполнителей никому не нужен.
--
-- Город не заполняем: он есть всего у 85 профилей из 2771. Пустой
-- список городов означает «город не указан» — карточка видна в общем
-- каталоге, но не попадает под фильтр по городу. Артист доукажет сам.
--
-- Идемпотентно: ON CONFLICT DO NOTHING не трогает ни анкеты диджеев,
-- ни тех, кто уже настроил букинг руками.

INSERT INTO booking_profiles (user_id, performer_category, is_open, display_name)
SELECT ap.user_id, 'artist', true, btrim(ap.artist_name)
  FROM artist_profiles ap
 WHERE ap.country IN ('Россия', 'Russia')
   AND ap.user_id IS NOT NULL
   AND NULLIF(btrim(ap.artist_name), '') IS NOT NULL
   AND ap.artist_name NOT ILIKE '%demo%'
   AND ap.artist_name NOT ILIKE '%test%'
   AND EXISTS (
     SELECT 1 FROM tracks t
      WHERE t.moderation_status IN ('published', 'approved')
        AND (t.artist_id = ap.id OR lower(btrim(t.artist_name)) = lower(btrim(ap.artist_name)))
   )
ON CONFLICT (user_id) DO NOTHING;
