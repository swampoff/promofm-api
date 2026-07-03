-- Migration 121: слияние engineer_orders в service_orders (маркетплейс)
--
-- Шаг 2 «полного слияния» (владелец: комиссия инженерных заказов = 10%,
-- как у продюсеров; статус 'delivered' → 'in_progress'). Идёт ПОСЛЕ 120.
--
-- ВАЖНО про деньги: реальные выплаты инженеров уже проведены отдельным
-- каналом platform_revenue channel='engineer_order' — этот backfill их НЕ
-- трогает и НЕ создаёт новых. Он лишь копирует строки заказов в service_orders
-- для единого отображения/истории. commission/producer_payout проставляются
-- по ставке 5% как учётная запись (не новое списание).
--
-- Свойства: аддитивно, id 'eng-ord-<uuid>', ON CONFLICT DO NOTHING
-- (идемпотентно). Старая engineer_orders НЕ дропается (бэкап до phase-3).
-- Оригиналы (status/delivery/payment) сохраняются в extra — ничего не теряем.
--
-- Маппинг статусов (владелец подтвердил delivered→in_progress):
--   delivered → in_progress ; declined → rejected ; cancelled → rejected ;
--   остальные (pending/accepted/in_progress/completed) — 1:1.
--
-- Колонки (pre-flight):
--   engineer_orders: id(uuid), service_id(uuid), engineer_id(text),
--     client_id(text), title, service_type, price(numeric), brief, status,
--     delivery_url, delivery_note, payment_order_id, paid_at, created_at, updated_at
--   users: id(uuid), full_name, display_name
--   service_orders: id(text PK), service_id, service_title, service_type,
--     producer_id, producer_name, client_id, client_name, message, details,
--     urgency, price, commission, producer_payout, status, progress,
--     status_message, delivery_days, deadline, completed_at, extra, created_at, updated_at
--
-- Apply (CLAUDE.md «NO BEGIN/COMMIT inside»), ПОСЛЕ 120:
--   BEGIN; \i .../121_merge_engineer_orders_into_marketplace.sql; COMMIT;

INSERT INTO service_orders
  (id, service_id, service_title, service_type, producer_id, producer_name,
   client_id, client_name, message, details, urgency, price, commission,
   producer_payout, status, progress, status_message, delivery_days,
   deadline, completed_at, extra, created_at, updated_at)
SELECT
  'eng-ord-' || eo.id::text,
  CASE WHEN eo.service_id IS NULL THEN NULL ELSE 'eng-svc-' || eo.service_id::text END,
  eo.title,
  COALESCE(eo.service_type, 'mixing'),
  eo.engineer_id,
  COALESCE(NULLIF(ue.full_name, ''), NULLIF(ue.display_name, ''), 'Саунд-инженер'),
  eo.client_id,
  COALESCE(NULLIF(uc.full_name, ''), NULLIF(uc.display_name, ''), ''),
  eo.brief,
  eo.brief,
  'normal',
  COALESCE(eo.price, 0),
  ROUND(COALESCE(eo.price, 0) * 0.10, 2),
  ROUND(COALESCE(eo.price, 0) * 0.90, 2),
  CASE eo.status
    WHEN 'delivered' THEN 'in_progress'
    WHEN 'declined'  THEN 'rejected'
    WHEN 'cancelled' THEN 'rejected'
    ELSE eo.status
  END,
  CASE WHEN eo.status = 'completed' THEN 100 ELSE 0 END,
  NULL,
  3,
  NULL,
  CASE WHEN eo.status = 'completed' THEN eo.updated_at ELSE NULL END,
  jsonb_build_object(
    'sellerType',     'engineer',
    'srcTable',       'engineer_orders',
    'srcId',          eo.id::text,
    'origStatus',     eo.status,
    'commissionRate', 0.10,
    'deliveryUrl',    eo.delivery_url,
    'deliveryNote',   eo.delivery_note,
    'paymentOrderId', eo.payment_order_id,
    'paidAt',         eo.paid_at
  ),
  eo.created_at,
  eo.updated_at
FROM engineer_orders eo
LEFT JOIN users ue ON ue.id::text = eo.engineer_id
LEFT JOIN users uc ON uc.id::text = eo.client_id
ON CONFLICT (id) DO NOTHING;
