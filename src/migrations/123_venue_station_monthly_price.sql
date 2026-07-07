-- Migration 123: цена абонемента ПРОМО.ЭИР по типу эфира (задаёт админ при
-- провижининге) + связка триала с провижинингом.
--
-- Продукт (решение владельца 2026-07-03): 14 дней эфир бесплатно с момента,
-- когда админ собрал станцию (provision); дальше — абонемент, цена зависит
-- от того, какой эфир сформирован. Источник цены — админ: он знает сложность
-- эфира (AI-хосты, джинглы, частота) и проставляет monthly_price при
-- провижининге. Отдельного прайс-каталога по типам эфира нет — цена
-- индивидуальна на заведение.
--
-- Триал НЕ требует новых значений enum: строка venue_radio_subscriptions
-- пишется со status='active' (уже разрешён), plan_id='trial',
-- current_period_end = NOW()+14д. stream-token уже пускает active+период →
-- триал играет сразу; по истечении 14 дней доступ гаснет по дате, нужен
-- платный абонемент. (Таблица venue_radio_subscriptions создаётся вне репо;
-- INSERT в коде использует только заведомо существующие колонки —
-- venue_id, plan_id, status, current_period_start/end, created_at, updated_at.)
--
-- Apply:
--   BEGIN; \i .../123_venue_station_monthly_price.sql; COMMIT;

ALTER TABLE venue_station_requests
  ADD COLUMN IF NOT EXISTS monthly_price NUMERIC NOT NULL DEFAULT 0;
