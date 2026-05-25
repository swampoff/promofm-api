-- 025_engineer_profiles.sql — sound engineer cabinet base table
--
-- Engineers как роль (`engineer` в `roles.tsx`) существовали с
-- запуска платформы, но кабинета у них не было. Заказы / DM / роль-
-- проверки работали как у остальных, но они не могли
-- редактировать профиль, выкладывать портфолио или принимать
-- ордера централизованно.
--
-- Эта таблица — MVP-основа: один блоб `data` jsonb на
-- пользователя плюс несколько колонок, которые читаются
-- public-листингами / cross-cabinet картами. Структура и
-- наполнение полностью соответствуют `producer_profiles` —
-- engineer кабинет начнётся как близнец producer'а с переименованными
-- сервисами («mixing» / «mastering» / «recording» / «production»).
-- Если позже понадобятся уникальные поля (тренировки, сертификаты,
-- DAW, плагины) — добавим колонки или расширим jsonb.
--
-- ВНИМАНИЕ: миграция НЕ автоприменяется (см. promofm-api/CLAUDE.md
-- → «Migrations don't auto-run»). Деплой вручную:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/025_engineer_profiles.sql

BEGIN;

CREATE TABLE IF NOT EXISTS engineer_profiles (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT         NOT NULL UNIQUE,
  -- Identity, дублируется из data для дешёвых JOIN-ов из публичных
  -- листингов и админ-очередей без распаковки jsonb.
  full_name    TEXT,
  city         TEXT,
  country      TEXT,
  avatar_url   TEXT,
  cover_url    TEXT,
  -- Профессиональные специализации, краткое био — denormalized для
  -- маркетплейса. Полная биография + длинные тексты — в data jsonb.
  bio          TEXT,
  specializations TEXT[]    DEFAULT '{}',  -- ['mixing','mastering','recording','production','vocal_tuning',…]
  hourly_rate  INTEGER      DEFAULT 0,     -- ₽/час, 0 = «договорная»
  -- Маркетплейс-метрики
  rating       NUMERIC(3,2) DEFAULT 0,     -- 0.00..5.00, обновляется по отзывам
  total_reviews INTEGER     DEFAULT 0,
  completed_orders INTEGER  DEFAULT 0,
  is_verified  BOOLEAN      DEFAULT false,
  is_available BOOLEAN      DEFAULT true,  -- «принимаю заказы» toggle
  -- Полный editor-side blob: совместимо с producer'ским подходом
  -- (`profile`, `services`, `portfolio`, …). При расширении кабинета
  -- читать-писать сюда, native колонки выше — denormalized зеркало.
  data         JSONB        DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- Cabinet open: every engineer reads/writes their own row.
-- Public marketplace consumers query by specialization / city.
CREATE INDEX IF NOT EXISTS idx_engineer_profiles_user
  ON engineer_profiles (user_id);

CREATE INDEX IF NOT EXISTS idx_engineer_profiles_city_available
  ON engineer_profiles (city)
  WHERE is_available = true;

-- For ratings-based marketplace sorting.
CREATE INDEX IF NOT EXISTS idx_engineer_profiles_rating
  ON engineer_profiles (rating DESC, total_reviews DESC)
  WHERE is_available = true;

COMMIT;
