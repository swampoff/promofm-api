-- 148: снять остальные мёртвые sync-триггеры (продолжение 147).
--
-- Та же история, что с publish_orders: ранние миграции повесили на таблицы
-- BEFORE INSERT OR UPDATE триггеры sync_<table>_native(), которые переносили
-- поля из jsonb-колонки `data` в нативные колонки. Миграция 078 колонки `data`
-- удалила, триггеры остались. Любая запись в такую таблицу падает с
-- «record "new" has no field "data"».
--
-- Проверено 24.09.2026 (BEGIN; UPDATE …; ROLLBACK на track_test_expert_stats):
-- ошибка воспроизводится. Именно поэтому не работал «Тест трека»: эксперт не мог
-- ни взять заявку (/claim-review → incrementExpertAssigned), ни сдать отзыв
-- (/submit-review → completeExpertReviewAndReward). Последние записи в затронутых
-- таблицах — март–май 2026; в payment_withdrawals, email_history,
-- notification_campaigns, agent_sessions, production_360_orders записей нет вовсе.
--
-- Триггер снимается ТОЛЬКО если у таблицы действительно нет колонки `data`
-- (у booking_calendar, payment_webhook_logs, publish_email_prefs, subscriptions
-- она есть — их триггеры рабочие и не трогаются). Функция удаляется, только
-- если на неё больше не ссылается ни один триггер.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.tgname, c.relname AS tbl, p.proname AS fn
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal
       AND n.nspname = 'public'
       AND c.relname IN (
         'agent_sessions', 'contracts', 'curator_reports', 'email_history',
         'investor_inquiries', 'notification_campaigns', 'payment_withdrawals',
         'production_360_orders', 'track_moderation', 'track_test_expert_stats'
       )
       AND p.prosrc ILIKE '%NEW.data%'
       AND NOT EXISTS (
         SELECT 1 FROM information_schema.columns ic
          WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'data'
       )
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', r.tgname, r.tbl);
    RAISE NOTICE 'dropped trigger % on %', r.tgname, r.tbl;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t2 JOIN pg_proc p2 ON p2.oid = t2.tgfoid WHERE p2.proname = r.fn) THEN
      EXECUTE format('DROP FUNCTION IF EXISTS public.%I()', r.fn);
      RAISE NOTICE 'dropped function %', r.fn;
    END IF;
  END LOOP;
END $$;
