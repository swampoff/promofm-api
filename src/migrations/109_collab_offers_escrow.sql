-- 109_collab_offers_escrow.sql
--
-- Escrow для коллаборационных офферов. Сейчас (до этой миграции) поток
-- такой: продюсер шлёт оффер с price → артист принимает → completed →
-- ПЛАТФОРМА НЕ ВИДИТ ДЕНЕГ. Артист и продюсер договариваются вне
-- платформы, ни залога, ни защиты сторон, ни выплат.
--
-- Эта миграция добавляет escrow-поля на collab_offers (созданная
-- migration 064). Money-handler'ы (POST /api/checkout/create-session
-- для type='collab_accept' + webhook fulfilment) идут в follow-up
-- backend PR — миграция только готовит schema.
--
-- Колонки:
--   payment_status  TEXT NOT NULL DEFAULT 'unpaid'
--                   Значения: 'unpaid' | 'escrow_pending' | 'escrow_held' |
--                             'released' | 'refunded'
--                   - unpaid: оффер с price=0 ИЛИ создан до этой миграции
--                   - escrow_pending: артист нажал «Принять», ЮКасса-
--                     сессия создана, ждём webhook'а
--                   - escrow_held: webhook подтвердил оплату, деньги
--                     зафризены платформой (status='accepted' тоже)
--                   - released: артист подтвердил complete или сработал
--                     auto-complete cron, выплата продюсеру (status='completed')
--                   - refunded: spor решён в пользу артиста (admin-arbitrage)
--                   Для price=0 (бесплатная коллаба, просто намерение)
--                   payment_status навсегда остаётся 'unpaid', и status
--                   ходит pending→accepted→completed напрямую без escrow.
--
--   payment_order_id TEXT
--                   Идентификатор сессии в payment_sessions; UNIQUE,
--                   используется webhook'ом как idempotency-ключ.
--
--   paid_at         TIMESTAMPTZ — когда webhook подтвердил escrow_held
--   released_at     TIMESTAMPTZ — когда оффер перешёл в released
--   refunded_at     TIMESTAMPTZ — когда отменён в пользу артиста
--
--   accept_deadline TIMESTAMPTZ
--                   Дедлайн для auto-complete cron'а. Формула при escrow_held:
--                   accept_deadline = COALESCE(offer.deadline, paid_at) + INTERVAL '7 days'
--                   Если артист не нажал «Подтвердить завершение» к этому
--                   моменту — cron автоматом complete + release.
--                   Конкретное значение проставляется webhook'ом, не
--                   миграцией (нужен paid_at, а его на момент миграции нет).
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT (Flyway-стиль).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d collab_offers
--   -- На дату 2026-06-16 в проде ожидается NO rows с status='accepted'
--   -- без payment_status — потому что money-handler'а ещё нет. Если есть
--   -- строки status='accepted'/'completed' до этой миграции, у них
--   -- payment_status= останется DEFAULT 'unpaid' (legacy ручные коллабы,
--   -- escrow к ним не применим — нечего возвращать).
--   SELECT status, COUNT(*) FROM collab_offers GROUP BY status;
--   SELECT COUNT(*) FROM collab_offers WHERE price > 0 AND status = 'accepted';
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/109_collab_offers_escrow.sql
--      COMMIT;
--      EOF
--   2. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api
--   3. (после деплоя)
--      SELECT payment_status, COUNT(*) FROM collab_offers GROUP BY payment_status;
--      -- ожидаем: все строки в 'unpaid' до первой новой оплаты.

ALTER TABLE collab_offers
  ADD COLUMN IF NOT EXISTS payment_status   TEXT NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS payment_order_id TEXT,
  ADD COLUMN IF NOT EXISTS paid_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS released_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refunded_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accept_deadline  TIMESTAMPTZ;

-- CHECK на допустимые значения payment_status.
ALTER TABLE collab_offers
  DROP CONSTRAINT IF EXISTS collab_offers_payment_status_chk;
ALTER TABLE collab_offers
  ADD CONSTRAINT collab_offers_payment_status_chk
  CHECK (payment_status IN ('unpaid', 'escrow_pending', 'escrow_held', 'released', 'refunded'));

-- Idempotency: payment_order_id уникален (partial — только когда заполнен).
-- Webhook ищет оффер по order_id; UPDATE с WHERE payment_order_id=$1 AND
-- payment_status='escrow_pending' даёт 0 строк при повторе → выходим без
-- двойного перехода в escrow_held.
CREATE UNIQUE INDEX IF NOT EXISTS uq_collab_offers_payment_order_id
  ON collab_offers (payment_order_id)
  WHERE payment_order_id IS NOT NULL;

-- Cron-индекс: auto-complete WHERE payment_status='escrow_held' AND
-- accept_deadline < NOW(). Partial, чтобы не индексировать сотни
-- нерелевантных строк.
CREATE INDEX IF NOT EXISTS idx_collab_offers_accept_deadline
  ON collab_offers (accept_deadline)
  WHERE payment_status = 'escrow_held' AND accept_deadline IS NOT NULL;
