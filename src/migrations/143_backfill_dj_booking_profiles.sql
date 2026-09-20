-- Перенос диджеев, уже включивших букинг, в общую анкету.
--
-- Они включили openForBookings у себя в студии — это тот же осознанный
-- выбор «принимаю заявки», просто сделанный раньше, чем появился общий
-- каталог. Переносим, а не просим заполнить заново.
--
-- Берём только тех, у кого есть имя и город: карточка без города в
-- каталоге бесполезна — заказчик ищет по городу. Остальные попадут
-- туда сами при следующем сохранении профиля (зеркало в
-- dj-studio-routes).
--
-- Идемпотентно: ON CONFLICT DO NOTHING, повторный прогон ничего не
-- перетрёт, в том числе анкеты, отредактированные вручную.

INSERT INTO booking_profiles (
  user_id, performer_category, is_open, display_name, cities, fee_hint, min_duration_hours
)
SELECT
  dp.user_id,
  'dj',
  true,
  NULLIF(dp.dj_name, ''),
  ARRAY[COALESCE(NULLIF(dp.location, ''), dp.data->>'city')],
  NULLIF(dp.data->'booking'->>'ratePerHour', '0')::numeric,
  NULLIF(dp.data->'booking'->>'minBookingHours', '')::numeric
FROM dj_profiles dp
WHERE COALESCE(dp.data->'booking'->>'openForBookings', 'true') <> 'false'
  AND COALESCE(dp.is_available, true) = true
  AND NULLIF(dp.dj_name, '') IS NOT NULL
  AND COALESCE(NULLIF(dp.location, ''), dp.data->>'city') IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;
