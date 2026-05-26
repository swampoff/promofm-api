-- 031_jsonb_hot_path_indexes.sql
--
-- Точечные expression-индексы на JSONB-поля, по которым реально
-- фильтруют запросы в проде. Это даёт «KV-стору на JSONB» нормальную
-- SQL-производительность без перевода данных в типизированные колонки.
--
-- Метод: BTREE expression index на `data->>'field'`. PostgreSQL умеет
-- использовать такой индекс ровно так же, как обычный BTREE по колонке,
-- если запрос содержит то же выражение в WHERE.
--
-- Почему не GIN на весь `data`:
--   GIN индексирует ВСЕ ключи внутри JSONB → растёт пропорционально
--   объёму. На "горячих" фильтрах status/type/city BTREE-expression
--   быстрее и в десятки раз компактнее.
--
-- Источники фильтров — найдено grep'ом по src/*-routes.tsx:
--   bookings.data->>'status'                 ← booking-routes.tsx:226
--   bookings.(data->>'eventDate')::tstz      ← booking-routes.tsx:225
--   publish_orders.data->>'status'           ← publish-routes.tsx:176
--   publish_orders.data->>'type'             ← publish-routes.tsx:174
--   venue_profiles.data->>'subscriptionStatus'         ← venue-billing-routes.tsx:312
--   (venue_profiles.data->>'subscriptionExpiresAt')::tstz ← venue-billing-routes.tsx:314
--   dj_profiles.data->>'city'                ← dj-marketplace-routes.tsx:64
--   dj_profiles.data->>'verified'            ← dj-marketplace-routes.tsx:74
--   payment_transactions.data->>'status'     ← typical admin filter
--   service_orders.data->>'status'           ← typical admin filter
--
-- MANUAL DEPLOY STEPS:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/031_jsonb_hot_path_indexes.sql
--
-- Безопасно к повторному запуску: CREATE INDEX IF NOT EXISTS.
-- Не блокирует таблицы: CONCURRENTLY. Если индекс уже есть — no-op.

-- ── bookings ─────────────────────────────────────────────────
-- Кабинет venue/dj часто фильтрует свои бронирования по статусу
-- (pending/confirmed/rejected/cancelled). Без индекса — full scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_status_jsonb
  ON bookings ((data->>'status'));

-- Расписание на дату/диапазон. Особенно важно для венью с большим
-- календарём — без индекса каждый запрос «booking за неделю» = seq scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_eventdate_jsonb
  ON bookings (((data->>'eventDate')::timestamptz));

-- ── publish_orders ───────────────────────────────────────────
-- Админ-фильтр в очереди публикаций («pending / draft / rejected»).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_publish_orders_status_jsonb
  ON publish_orders ((data->>'status'));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_publish_orders_type_jsonb
  ON publish_orders ((data->>'type'));

-- ── venue_profiles ──────────────────────────────────────────
-- Биллинг крутит cron'ом по active+истекающим — без индекса каждый
-- проход = full scan по venue_profiles. Особенно больно когда заведений
-- много, а expired-проверка идёт каждые 5 минут.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_profiles_sub_status_jsonb
  ON venue_profiles ((data->>'subscriptionStatus'));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_profiles_sub_expires_jsonb
  ON venue_profiles (((data->>'subscriptionExpiresAt')::timestamptz))
  WHERE data->>'subscriptionExpiresAt' IS NOT NULL;

-- ── dj_profiles ─────────────────────────────────────────────
-- Маркетплейс DJ фильтрует по городу и verified — это горячий путь
-- для каждого первого захода на /dj-catalog.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dj_profiles_city_jsonb
  ON dj_profiles ((data->>'city'));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dj_profiles_verified_jsonb
  ON dj_profiles ((data->>'verified'))
  WHERE data->>'verified' = 'true';

-- ── payment_transactions ────────────────────────────────────
-- Админка платежей и пользовательская история — фильтры по статусу
-- (pending/paid/refunded/failed).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transactions_status_jsonb
  ON payment_transactions ((data->>'status'));

-- ── service_orders ──────────────────────────────────────────
-- Producer-кабинет: «активные заказы» / «выполнено». Админ-кабинет:
-- очередь по статусу для модерации.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_service_orders_status_jsonb
  ON service_orders ((data->>'status'));

-- ── Verify (DBA): EXPLAIN ANALYZE
--   EXPLAIN ANALYZE
--   SELECT * FROM bookings WHERE data->>'status' = 'pending' LIMIT 100;
-- ожидается: Index Scan using idx_bookings_status_jsonb ...
-- было: Seq Scan on bookings (cost=0.00..N rows=...)
