-- 133_drop_engineer_legacy.sql
-- Phase-3 маркетплейса §2: снос legacy-таблиц кабинета звукоинженера.
-- Канон с §2 (2026-07-0x): услуги — producer_services (producer-studio),
-- заказы — service_orders (marketplace), комиссия 10% — platform_revenue_log
-- channel='marketplace_service' при completed.
--
-- ⚠️ НЕ ПРИМЕНЯТЬ, пока не выполнены ВСЕ шаги phase-3 runbook'а
-- (docs/HANDOFF_TO_LAPTOP_2026-07-03.md §9):
--   1) runtime-верификация нового цикла service_orders на проде;
--   2) деплой кода БЕЗ ссылок на engineer_services/engineer_orders
--      (engineer-routes.tsx services/orders/earnings-legacy,
--       checkout-routes.tsx три engineer_order-ветки);
--   3) pg_dump-бэкап обеих таблиц.
-- Миграции не автозапускаются (runner — заглушка), поэтому файл в репо
-- безопасен; порядок применения контролирует laptop.
--
-- FK между таблицами нет (engineer_orders.service_id — голый uuid),
-- порядок DROP произволен.

DROP TABLE IF EXISTS engineer_orders;
DROP TABLE IF EXISTS engineer_services;
