-- 147: снять мёртвый триггер trg_sync_publish_orders.
--
-- Миграция 003 повесила BEFORE INSERT OR UPDATE триггер, который переносил
-- значения из jsonb-колонки `data` в нативные колонки. Миграция 078 колонку
-- `data` удалила (строка 285), но триггер не сняла. С этого момента ЛЮБАЯ
-- запись в publish_orders падала с «record "new" has no field "data"»:
-- заказы публикаций нельзя было ни создать, ни промодерировать.
-- Последняя успешная запись в таблице — 21 мая 2026.
--
-- Триггер больше ничего не делает: источник истины — нативные колонки.

DROP TRIGGER IF EXISTS trg_sync_publish_orders ON publish_orders;
DROP FUNCTION IF EXISTS sync_publish_orders_native();
