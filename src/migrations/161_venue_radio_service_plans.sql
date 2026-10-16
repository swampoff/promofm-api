-- Migration 161: служебные тарифы 'trial' и 'efir' в venue_radio_plans.
--
-- venue_radio_subscriptions.plan_id ссылается на venue_radio_plans(id)
-- (FK venue_radio_subscriptions_plan_id_fkey). На проде в venue_radio_plans
-- только basic / pro / business (проверено 16.10.2026), поэтому:
--   * провижининг станции (venue-station-routes.tsx, POST /admin/:id/provision)
--     пишет пробный эфир с plan_id='trial' → INSERT падал на FK, ошибка
--     только логировалась, пробный не создавался ни разу;
--   * POST /venue-radio/subscribe с planId='efir' (цена из заявки,
--     venue_station_requests.monthly_price) → INSERT тоже падал бы на FK.
--
-- Строки служебные: is_active=false, поэтому их нет в публичном
-- GET /venue-radio/plans и их нельзя купить через /checkout/create-session
-- (обе выборки фильтруют is_active = true). price_month = 0: реальная цена
-- 'efir' хранится в заявке, у пробного цены нет.
--
-- Идемпотентно (ON CONFLICT DO NOTHING), без BEGIN/COMMIT (см. CLAUDE.md).
-- Dry-run:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--   BEGIN;
--   \i /opt/promofm-api/src/migrations/161_venue_radio_service_plans.sql
--   ROLLBACK;
--   EOF

INSERT INTO venue_radio_plans (id, name, description, price_month, features, is_active, sort_order)
VALUES
  ('trial', 'Пробный период эфира', 'Служебная строка: пробный эфир после сборки станции', 0, '[]'::jsonb, false, 900),
  ('efir',  'Абонемент эфира',      'Служебная строка: цена задаётся в заявке заведения (venue_station_requests.monthly_price)', 0, '[]'::jsonb, false, 901)
ON CONFLICT (id) DO NOTHING;
