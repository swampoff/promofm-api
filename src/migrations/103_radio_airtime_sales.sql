-- Migration 103: airtime sales — продажа эфирного времени артистам
--
-- Контекст (PROMO.FM аудит 2026-06-05): на LP /radio-stations артистам
-- обещана возможность купить эфирное время напрямую у радио (интервью,
-- подкаст, размещение трека). До этого PR в коде не было ни схемы, ни
-- routes — только маркетинг.
--
-- Архитектурное решение: симметрично существующему venue→radio
-- рекламному flow (radio_ad_slots + radio_venue_requests + checkout
-- itemType='radio_campaign'). Радио выставляет slot с базовой ценой,
-- артист видит каталог всех радио и покупает напрямую через платформу
-- (контактов радио у артистов нет — flow через UI). 15% комиссия
-- платформы, 85% выплата радио. Tier-discount подписки артиста
-- применяется через subscription-pricing.tsx category='promotion'.
--
-- Соглашение по типам: artist_id / radio_id хранятся как TEXT
-- (соответствует существующему паттерну radio_venue_requests.venue_id
-- и т.д., где user_id уезжает как text без implicit-cast'ов uuid).
-- format и status — TEXT с CHECK constraint вместо ENUM
-- (пока нет миграций изменения enum'ов, прощё расширять).

-- ─── radio_airtime_slots — каталог слотов от радиостанции ────────────

CREATE TABLE IF NOT EXISTS radio_airtime_slots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  radio_id        TEXT NOT NULL,
  format          TEXT NOT NULL CHECK (format IN ('interview', 'podcast', 'track_placement')),
  title           TEXT NOT NULL,
  description     TEXT,
  duration_min    INTEGER NOT NULL DEFAULT 15 CHECK (duration_min > 0 AND duration_min <= 240),
  base_price      NUMERIC(10, 2) NOT NULL CHECK (base_price > 0 AND base_price <= 1000000),
  available_times JSONB DEFAULT '[]'::jsonb,
  max_per_period  INTEGER NOT NULL DEFAULT 1 CHECK (max_per_period > 0),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  extra           JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_radio_airtime_slots_radio_id
  ON radio_airtime_slots (radio_id);
CREATE INDEX IF NOT EXISTS idx_radio_airtime_slots_status_format
  ON radio_airtime_slots (status, format) WHERE status = 'active';

-- ─── radio_airtime_purchases — заявка/покупка артиста ────────────────

CREATE TABLE IF NOT EXISTS radio_airtime_purchases (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id            UUID NOT NULL REFERENCES radio_airtime_slots(id) ON DELETE RESTRICT,
  radio_id           TEXT NOT NULL,                  -- denormalized для owner-check
  artist_id          TEXT NOT NULL,                  -- users.id артиста
  format             TEXT NOT NULL,                  -- copy from slot для отчётов
  status             TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'approved', 'rejected', 'broadcasted', 'refunded')),
  payment_session_id TEXT,
  scheduled_at       TIMESTAMPTZ,                    -- когда выйдет в эфир (radio задаёт при approve)
  broadcasted_at     TIMESTAMPTZ,                    -- фактический выход в эфир
  content_url        TEXT,                           -- артист загружает после approve (запись интервью/мастер трека)
  artist_message     TEXT,                           -- бриф от артиста (что хочет рассказать)
  rejection_reason   TEXT,
  total_price        NUMERIC(10, 2) NOT NULL CHECK (total_price >= 0),
  discount_pct       NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  platform_fee       NUMERIC(10, 2) NOT NULL CHECK (platform_fee >= 0),
  radio_payout       NUMERIC(10, 2) NOT NULL CHECK (radio_payout >= 0),
  extra              JSONB DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_radio_airtime_purchases_radio_id_status
  ON radio_airtime_purchases (radio_id, status);
CREATE INDEX IF NOT EXISTS idx_radio_airtime_purchases_artist_id
  ON radio_airtime_purchases (artist_id);
CREATE INDEX IF NOT EXISTS idx_radio_airtime_purchases_payment_session
  ON radio_airtime_purchases (payment_session_id) WHERE payment_session_id IS NOT NULL;

-- ─── updated_at trigger (опционально, для удобства аналитики) ────────
-- Не делаю trigger function — keep migration self-contained, updated_at
-- обновляется в коде через `UPDATE … SET updated_at = NOW()`.
