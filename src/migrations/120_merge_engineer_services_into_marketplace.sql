-- Migration 120: слияние engineer_services в единый маркетплейс producer_services
--
-- Цель (решение владельца «полное слияние»): engineer продаёт на общем
-- маркетплейсе как producer. GET /marketplace/services читает producer_services
-- → после этого backfill'а услуги инженеров появляются в общей витрине рядом
-- с продюсерами.
--
-- ЭТОТ ФАЙЛ — ТОЛЬКО УСЛУГИ (не деньги, безопасно). Backfill заказов
-- (engineer_orders → service_orders) НЕ здесь: у систем разный статус-словарь
-- (engineer: pending→accepted→in_progress→delivered→completed; producer:
-- …→revision→completed→reviewed) и выплаты инженеров идут отдельным каналом
-- platform_revenue channel='engineer_order'. Backfill заказов = деньги →
-- требует owner sign-off + laptop runtime-тест (см. docs/HANDOFF).
--
-- Свойства: аддитивно, id с префиксом 'eng-svc-', ON CONFLICT DO NOTHING
-- (идемпотентно, повторный прогон = 0 строк). Старая engineer_services НЕ
-- дропается — остаётся источником/бэкапом до write-side rewire + phase-3 drop.
--
-- Колонки (pre-flight):
--   engineer_services: id(uuid), user_id(text), title, service_type, base_price,
--     description, delivery_days, is_active, created_at, updated_at
--   users: id(uuid), full_name, display_name
--   producer_services: id(text PK), producer_id, producer_name, title,
--     service_type, description, base_price, delivery_days, status,
--     orders_count, rating, extra(jsonb), created_at, updated_at
--
-- Apply (CLAUDE.md «NO BEGIN/COMMIT inside»):
--   BEGIN; \i .../120_merge_engineer_services_into_marketplace.sql; COMMIT;

INSERT INTO producer_services
  (id, producer_id, producer_name, title, service_type, description,
   base_price, delivery_days, status, orders_count, rating, extra,
   created_at, updated_at)
SELECT
  'eng-svc-' || es.id::text,
  es.user_id,
  COALESCE(NULLIF(u.full_name, ''), NULLIF(u.display_name, ''), 'Саунд-инженер'),
  es.title,
  COALESCE(es.service_type, 'mixing'),
  COALESCE(es.description, ''),
  COALESCE(es.base_price, 0),
  COALESCE(es.delivery_days, 3),
  CASE WHEN es.is_active THEN 'active' ELSE 'inactive' END,
  0,
  0,
  jsonb_build_object(
    'sellerType', 'engineer',
    'srcTable',   'engineer_services',
    'srcId',      es.id::text
  ),
  es.created_at,
  es.updated_at
FROM engineer_services es
LEFT JOIN users u ON u.id::text = es.user_id
ON CONFLICT (id) DO NOTHING;
