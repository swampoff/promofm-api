-- 111_producer_payout_methods.sql
--
-- Adds row-per-method payout table for producer cabinet "Способы оплаты".
-- До этой миграции UI показывал хардкод ЮMoney + Sberbank, кнопка
-- «+ Добавить способ оплаты» вообще не имела onClick — продюсер мог
-- видеть фейк-методы, не существующие в БД. Теперь реальная таблица.
--
-- Schema follows the row-per-entity convention (CLAUDE.md):
--   id           UUID PK — каждая запись отдельная строка.
--   producer_id  TEXT INDEX — owner-check (producer_profiles.user_id is TEXT,
--                  cheat-sheet).
--   method_type  TEXT — 'card'/'yoomoney'/'sbp'/'bank_transfer' и т.д.
--                  Свободный enum-like text, без CHECK — расширяемо без
--                  ALTER.
--   label        TEXT — human-friendly title оператора («Сбер Visa **5678»).
--   details      JSONB DEFAULT '{}' — секреты (последние 4 цифры, ЮMoney
--                  wallet, BIC/IBAN), редактируется через service-layer.
--   is_default   BOOLEAN DEFAULT FALSE — флаг «использовать по умолчанию
--                  для следующего payout». При INSERT/UPDATE логика на
--                  стороне route'а: только один default per producer.
--   created_at, updated_at TIMESTAMPTZ.
--
-- Composite UNIQUE предотвращает «несколько default'ов»:
--   uq_producer_payout_methods_default — partial UNIQUE on (producer_id)
--   WHERE is_default = TRUE.
--
-- DDL only — runner wraps in transaction. NO BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS producer_payout_methods (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  producer_id  TEXT NOT NULL,
  method_type  TEXT NOT NULL,
  label        TEXT NOT NULL,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_producer_payout_methods_producer
  ON producer_payout_methods (producer_id, created_at DESC);

-- Partial UNIQUE — только одна строка `is_default = TRUE` на producer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_producer_payout_methods_default
  ON producer_payout_methods (producer_id)
  WHERE is_default = TRUE;
