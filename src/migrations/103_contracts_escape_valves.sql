-- 103_contracts_escape_valves.sql
--
-- Service contracts: cancel + dispute lifecycle. На main контракт после
-- POST /orders/:id/contract идёт в status='active' и движется через
-- milestones (pending → in_progress → submitted → approved|revision).
--
-- Проблемы которые этот PR закрывает:
--   1. Нет cancel endpoint'а. Если producer перестал работать (умер,
--      сбежал, забил) и не submit'ает — client заперт. Контракт active
--      forever, прогресс orderov висит, producerPayout не растёт.
--   2. Нет dispute. Если producer submit'ает мусор, client может только:
--      (а) approve (платит за плохую работу)
--      (б) revision (бесконечный цикл)
--      Нет эскалации к admin'у.
--
-- Решение архитектурно: escape valves без рефанд-логики (escrow на
-- main нет — paidAt в milestone счётчик, не реальные деньги, см.
-- BLOCKER analysis 2026-06-04).
--
-- Колонки:
--   - cancelled_at        TIMESTAMPTZ
--   - cancelled_by        TEXT       (userId инициатора)
--   - cancelled_by_role   TEXT       ('client'|'producer'|'admin')
--   - cancellation_reason TEXT
--   - has_dispute         BOOLEAN    flag — есть ли open dispute на любом
--                                    milestone (для admin filter)
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/103_contracts_escape_valves.sql
--      COMMIT;
--      EOF
--   2. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by        TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by_role   TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS has_dispute         BOOLEAN NOT NULL DEFAULT FALSE;

-- Индекс для admin-кабинета: «контракты с открытым спором» в очереди
-- на разрешение.
CREATE INDEX IF NOT EXISTS idx_contracts_disputes
  ON contracts (created_at DESC)
  WHERE has_dispute = TRUE AND status = 'active';
