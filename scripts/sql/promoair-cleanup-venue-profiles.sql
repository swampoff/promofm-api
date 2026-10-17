-- PROMO.AIR: удалить мусорные строки venue_profiles ДО включения кронов
-- expire-trials / charge-recurring (critic A3, be-venue §6). Подготовил
-- агент BILLING 16.10.2026; НЕ запускался. Запускает ведущий, после бэкапа:
--
--   sudo -u postgres pg_dump -d promofm -t public.venue_profiles --data-only --column-inserts \
--     > /root/backups/venue_profiles_$(date +%F_%H%M).sql
--
--   # 1) dry-run (по умолчанию ROLLBACK): показывает, что удалится
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -f /opt/promofm-api/scripts/sql/promoair-cleanup-venue-profiles.sql
--   # 2) применить
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 -v apply=1 -f /opt/promofm-api/scripts/sql/promoair-cleanup-venue-profiles.sql
--
-- Критерии (каждый проверен SELECT'ом на проде 16.10.2026, всего 12 строк в таблице):
--   no_user_id        user_id NULL или пустой               → venue-1, venue-2, venue-3 (демо «Bar Decor», «Lounge 21», «Sky Rooftop»)
--   anonymous         user_id = 'anonymous'                 → anonymous
--   test_id           user_id начинается с 'test'           → test-venue-001
--   user_missing      user_id нет в users                   → fa1d5dd7-5737-48b3-8870-3a9a0fc23b04 («Curator Test Venue»),
--                                                             3ad323fe-440c-459b-9e56-029dfff860b9, f13827aa-a909-4a8f-89c3-169aa3ddc971,
--                                                             b86e0e74-4e77-4833-9d36-71dcba620604, 3a683a87-62f9-4407-827c-400a549233d9
--   admin_fake_trial  профиль админа с «пробным» без карты:  → 6b54fb8b-05f5-4e55-8bf3-2b1a8aceed99 (role admin)
--                     status 'trial', нет trial_expires_at и cardAttachedAt, нет карты,
--                     заявок и потоков эфира (строка появилась от захода админа в /venue)
-- Итого ожидается 11 строк. Остаётся 1: 10c0e848-1e41-4b00-b95a-6e58081a4e96
-- (user d6b6ffa8-…, role venue). Профили пользователей с role='venue' не
-- удаляются ни при каком критерии.
--
-- Если набор на проде к моменту запуска изменился, скрипт падает с ошибкой
-- (ON_ERROR_STOP) и ничего не удаляет. Сначала разобраться; осознанно
-- пропустить проверку: -v allow_diff=1.
--
-- Связанные демо-строки в других таблицах (по venue_id 'venue-1..3' и
-- 'venue-test-venue-001': radio_venue_requests 11, venue_ad_campaigns 5,
-- venue_playlists 12, venue_orders_index 1) этот скрипт только показывает и
-- НЕ удаляет: внешних ключей на venue_profiles нет, кроны их не читают.

BEGIN;

CREATE TEMP TABLE _junk_venue_profiles ON COMMIT DROP AS
SELECT vp.id,
       vp.user_id,
       vp.venue_name,
       vp.data->>'subscriptionStatus' AS status,
       vp.created_at,
       CASE
         WHEN vp.user_id IS NULL OR btrim(vp.user_id) = '' THEN 'no_user_id'
         WHEN vp.user_id = 'anonymous'                     THEN 'anonymous'
         WHEN vp.user_id ~* '^test'                        THEN 'test_id'
         WHEN u.id IS NULL                                 THEN 'user_missing'
         ELSE 'admin_fake_trial'
       END AS reason
  FROM venue_profiles vp
  LEFT JOIN users u ON u.id::text = vp.user_id
 WHERE COALESCE(u.role::text, '') <> 'venue'
   AND (
         vp.user_id IS NULL OR btrim(vp.user_id) = ''
      OR vp.user_id = 'anonymous'
      OR vp.user_id ~* '^test'
      OR u.id IS NULL
      OR (    u.role::text IN ('admin', 'superadmin')
          AND vp.data->>'subscriptionStatus' = 'trial'
          AND COALESCE(vp.data->>'trial_expires_at', '') = ''
          AND COALESCE(vp.data->>'cardAttachedAt', '') = ''
          AND NOT EXISTS (SELECT 1 FROM payment_methods pm        WHERE pm.user_id = vp.user_id)
          AND NOT EXISTS (SELECT 1 FROM venue_station_requests r  WHERE r.user_id  = vp.user_id)
          AND NOT EXISTS (SELECT 1 FROM venue_station_streams st  WHERE st.user_id = vp.user_id))
   );

-- Превью: что будет удалено и почему
SELECT reason, id, user_id, venue_name, status, created_at::date AS created
  FROM _junk_venue_profiles
 ORDER BY reason, id;

-- Превью: что останется
SELECT vp.id, vp.user_id, u.role::text AS role, vp.data->>'subscriptionStatus' AS status
  FROM venue_profiles vp
  LEFT JOIN users u ON u.id::text = vp.user_id
 WHERE vp.id NOT IN (SELECT id FROM _junk_venue_profiles)
 ORDER BY vp.created_at;

-- Превью (не удаляется): демо-строки в других таблицах, привязанные к мусорным профилям
SELECT t, venue_id, n FROM (
  SELECT 'radio_venue_requests' AS t, venue_id, count(*) AS n FROM radio_venue_requests GROUP BY venue_id
  UNION ALL SELECT 'venue_ad_campaigns', venue_id, count(*) FROM venue_ad_campaigns GROUP BY venue_id
  UNION ALL SELECT 'venue_playlists', venue_id, count(*) FROM venue_playlists GROUP BY venue_id
  UNION ALL SELECT 'venue_orders_index', venue_id, count(*) FROM venue_orders_index GROUP BY venue_id
) x
 WHERE venue_id IN (SELECT id FROM _junk_venue_profiles)
    OR venue_id IN (SELECT 'venue-' || user_id FROM _junk_venue_profiles WHERE user_id IS NOT NULL)
 ORDER BY t, venue_id;

\if :{?allow_diff}
\else
DO $$
DECLARE
  expected text[] := ARRAY[
    '3a683a87-62f9-4407-827c-400a549233d9', '3ad323fe-440c-459b-9e56-029dfff860b9',
    '6b54fb8b-05f5-4e55-8bf3-2b1a8aceed99', 'anonymous',
    'b86e0e74-4e77-4833-9d36-71dcba620604', 'f13827aa-a909-4a8f-89c3-169aa3ddc971',
    'fa1d5dd7-5737-48b3-8870-3a9a0fc23b04', 'test-venue-001',
    'venue-1', 'venue-2', 'venue-3'];
  got text[];
BEGIN
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO got FROM _junk_venue_profiles;
  IF got IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(expected) AS x) THEN
    RAISE EXCEPTION 'junk set differs from the 16.10.2026 check (expected 11 ids), got: %', got;
  END IF;
END $$;
\endif

DELETE FROM venue_profiles
 WHERE id IN (SELECT id FROM _junk_venue_profiles)
RETURNING id, user_id;

\if :{?apply}
COMMIT;
\echo 'venue_profiles cleanup COMMITTED'
\else
ROLLBACK;
\echo 'DRY-RUN: rolled back. Re-run with -v apply=1 to delete.'
\endif
