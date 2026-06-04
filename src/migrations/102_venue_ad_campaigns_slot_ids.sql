-- 102_venue_ad_campaigns_slot_ids.sql
--
-- Radio Blocker C (1₽-bypass): сейчас POST /venue/radio-campaigns
-- принимает `body.budget` от клиента и пишет в venue_ad_campaigns.budget
-- БЕЗ server-side проверки. POST /checkout/create-session с
-- type='radio_campaign' тоже не валидирует amount. Venue теоретически
-- может оплатить 1₽ за кампанию стоимостью 50000₽.
--
-- Никита по (a)-варианту: радио сама назначает per-slot цены через
-- radio_ad_slots.price, gate проверяет SUM(price). Чтобы реализовать —
-- нужно знать какие конкретно слоты выбрал venue.
--
-- Колонка:
--   - slot_ids TEXT[] — массив id из radio_ad_slots. Записывается при
--                       POST /venue/radio-campaigns (новый flow).
--                       NULL/пустой — legacy кампания (создана без
--                       slot-выбора, до этого PR'а).
--
-- Формула budget'а в новом flow:
--   budget = SUM(radio_ad_slots.price WHERE id = ANY(slot_ids)) * durationDays
--   где durationDays = ceil((end_date - start_date) / 86400000)
--
-- Сервер записывает этот authoritative budget в campaign, body.budget
-- IGNORED (warn-log если != server-computed).
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d venue_ad_campaigns
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/102_venue_ad_campaigns_slot_ids.sql
--      COMMIT;
--      EOF
--   2. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

ALTER TABLE venue_ad_campaigns
  ADD COLUMN IF NOT EXISTS slot_ids TEXT[];

-- Индекс для admin-ревизии «кампании в новом flow без оплаты» —
-- pending_payment'ы старше N дней могут быть abandoned.
CREATE INDEX IF NOT EXISTS idx_vac_pending_payment
  ON venue_ad_campaigns (created_at DESC)
  WHERE status = 'pending_payment';
