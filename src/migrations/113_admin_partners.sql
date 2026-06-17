-- 113_admin_partners.sql
--
-- Admin-managed partners (площадки, рекламные сети, медиа-партнёры,
-- спонсоры — всё что не имеет своего кабинета в платформе). До этой
-- миграции admin/pages/PartnersManagement.tsx был полностью моком —
-- кнопки CRUD меняли локальный state и тостили success, ничего не
-- персистилось. Теперь реальная таблица + 4 endpoint'а в admin-ops.
--
-- Schema (row-per-entity по конвенции CLAUDE.md):
--   id           UUID PK DEFAULT gen_random_uuid()
--   name         TEXT NOT NULL                — название партнёра
--   category     TEXT NOT NULL                — 'radio'/'venue'/'media'/'streaming'/'blogger'/'other'
--   status       TEXT NOT NULL DEFAULT 'pending' — 'active'/'inactive'/'pending'
--   email        TEXT
--   phone        TEXT
--   website      TEXT
--   address      TEXT
--   description  TEXT
--   logo_url     TEXT
--   contact_person TEXT
--   commission   NUMERIC(5,2) NOT NULL DEFAULT 15.00 — комиссия платформы %
--   extra        JSONB NOT NULL DEFAULT '{}'  — теги, заметки, метрики
--   created_by   TEXT                          — admin user_id, кто добавил
--   created_at, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
--
-- Indexes:
--   idx_partners_category — фильтр на UI
--   idx_partners_status_created — список «активные»/«ожидают» с сортировкой
--   uq_partners_name_category — partial UNIQUE на (name, category) для
--                                предотвращения дублей.

CREATE TABLE IF NOT EXISTS admin_partners (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  email           TEXT,
  phone           TEXT,
  website         TEXT,
  address         TEXT,
  description     TEXT,
  logo_url        TEXT,
  contact_person  TEXT,
  commission      NUMERIC(5,2) NOT NULL DEFAULT 15.00,
  extra           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_partners_category
  ON admin_partners (category);

CREATE INDEX IF NOT EXISTS idx_admin_partners_status_created
  ON admin_partners (status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_partners_name_category
  ON admin_partners (LOWER(name), category);
