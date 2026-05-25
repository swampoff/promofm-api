-- 028_producer_engineer_portfolio.sql — портфолио работ для продюсеров
-- и звукоинженеров.
--
-- Продюсер сейчас имеет `producerCustomPortfolioStore` (jsonb-store)
-- с метаданными без реальных файлов — клиенту приходилось пастить URL
-- руками. Инженер имеет `POST /engineer/portfolio/upload` который
-- возвращает URL, но метаданные нигде не сохраняются (placeholder).
--
-- Эта миграция:
--   1. Создаёт две таблицы — по одной на роль (структура почти
--      одинаковая, но семантика разная: producer хранит «треки»
--      с типом сведение/мастеринг/продакшен, engineer — «семплы»
--      с категорией mix_sample/mastering_before-after/production).
--   2. UNIQUE на (user_id, sort_order) НЕ ставится — несколько
--      элементов с одним порядком допустимы (порядок ресолвится
--      сортировкой по created_at при равенстве sort_order).
--
-- Идемпотентно через CREATE TABLE IF NOT EXISTS.

BEGIN;

-- ─── Producer portfolio ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS producer_portfolio (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT         NOT NULL,
  title         TEXT         NOT NULL,
  -- «Артист» для которого сделана работа (текст, не FK — может
  -- быть сторонний артист с другой площадки).
  artist_name   TEXT,
  -- Тип работы: 'mixing'|'mastering'|'production'|'arrangement'|
  -- 'sound_design'|'other'
  work_type     TEXT         NOT NULL DEFAULT 'mixing',
  description   TEXT,
  audio_url     TEXT,
  cover_url     TEXT,
  duration_sec  INTEGER,
  sort_order    INTEGER      DEFAULT 0,
  is_public     BOOLEAN      DEFAULT true,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_producer_portfolio_user
  ON producer_portfolio (user_id);

-- Публичный листинг сортирует по (sort_order, created_at) и
-- фильтрует по is_public — индекс под этот use-case.
CREATE INDEX IF NOT EXISTS idx_producer_portfolio_public
  ON producer_portfolio (user_id, sort_order, created_at DESC)
  WHERE is_public = true;

-- ─── Engineer portfolio ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS engineer_portfolio (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT         NOT NULL,
  title         TEXT         NOT NULL,
  artist_name   TEXT,
  -- Категория: 'mix_sample'|'mastering_before'|'mastering_after'|
  -- 'production'|'restoration'|'live_sound'|'other'
  category      TEXT         NOT NULL DEFAULT 'mix_sample',
  description   TEXT,
  audio_url     TEXT,
  cover_url     TEXT,
  duration_sec  INTEGER,
  -- before/after мастеринга — две связанные записи. Если есть
  -- partner_id — клиент рендерит их парой («До/После»).
  partner_id    UUID,
  sort_order    INTEGER      DEFAULT 0,
  is_public     BOOLEAN      DEFAULT true,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_engineer_portfolio_user
  ON engineer_portfolio (user_id);

CREATE INDEX IF NOT EXISTS idx_engineer_portfolio_public
  ON engineer_portfolio (user_id, sort_order, created_at DESC)
  WHERE is_public = true;

COMMIT;
