-- 103_donations_autopayout_native.sql
--
-- Donations autopayout + admin fallback. Закрывает два запроса Никиты:
--
-- (1) Артист выводит донат через ЮКассу автоматически (как DJ — см.
-- 044_kv_wave1_5_dj_withdrawals.sql + dj-studio-routes.tsx:1298). Сейчас
-- POST /donations/withdrawals просто INSERT'ит pending row и админ
-- руками платит. После этой миграции — sync вызов
-- gateway-yookassa-payouts.tsx::createYooKassaPayout, YK status пишется
-- в новую колонку yoo_payout_id, fail-кейс пишет error.
--
-- (2) Если у артиста нет внутреннего кабинета (artist_profile есть,
-- но user_id NULL — например, импортированный артист) — донат
-- зачисляется на платформу (admin user), а donations.intended_artist_id
-- сохраняет ссылку на исходного артиста для отчётов / future передачи
-- при регистрации. Идея: «деньги не зависают на чужом неактивном
-- балансе» (Option B из предложения мобу), владение чёткое.
--
-- Колонки (defensive ADD COLUMN IF NOT EXISTS — миграция идемпотентна,
-- запуск повторно безопасен):
--
-- payment_withdrawals (зеркалит dj_withdrawals — для donation autopayout):
--   - yoo_payout_id     TEXT — id выплаты в YooKassa (api/v3/payouts)
--   - destination_label TEXT — маска для UI: «СБП +7***1234», «Карта …4242»
--   - error             TEXT — error message от YK при status='failed'
--   - requested_at      TIMESTAMPTZ — когда артист подал заявку
--   - paid_at           TIMESTAMPTZ — когда YK реально выплатила
--
-- donations (admin fallback):
--   - intended_artist_id TEXT — id артиста, для которого донат был
--                               сделан, когда recipient_id указывает на
--                               admin user (артист без кабинета). NULL
--                               для нормальных донатов где recipient_id
--                               и есть артист.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ⚠️ ENV (Никита подтвердил «уже настроили»):
--   YOOKASSA_PAYOUT_AGENT_ID
--   YOOKASSA_PAYOUT_SECRET_KEY
-- Без них POST /donations/withdrawals упадёт в catch с понятной
-- ошибкой ещё до записи в БД (см. gateway-yookassa-payouts.tsx:23).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d payment_withdrawals
--   \d donations
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/103_donations_autopayout_native.sql
--      COMMIT;
--      EOF
--   2. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api
--
-- Defensive: handler'ы используют ensureSchemaInline (db-client.tsx:41)
-- → миграция и так применится при первом запросе, но всё равно лучше
-- руками для предсказуемости deploy window.

ALTER TABLE payment_withdrawals
  ADD COLUMN IF NOT EXISTS yoo_payout_id     TEXT,
  ADD COLUMN IF NOT EXISTS destination_label TEXT,
  ADD COLUMN IF NOT EXISTS error             TEXT,
  ADD COLUMN IF NOT EXISTS requested_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at           TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pw_yoo_payout_id
  ON payment_withdrawals (yoo_payout_id)
  WHERE yoo_payout_id IS NOT NULL;

ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS intended_artist_id TEXT;

-- Index для admin-view «pending donations to unregistered artists»:
-- WHERE intended_artist_id IS NOT NULL. Маленький partial index,
-- читать редко (раз в день админ через cabinet).
CREATE INDEX IF NOT EXISTS idx_donations_intended_artist
  ON donations (intended_artist_id, created_at DESC)
  WHERE intended_artist_id IS NOT NULL;
