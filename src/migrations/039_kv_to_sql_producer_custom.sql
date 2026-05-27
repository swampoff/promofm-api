-- 039_kv_to_sql_producer_custom.sql
--
-- KV→SQL: producer_custom_services + producer_custom_portfolio.
-- Wave 1, публичный контент продюсера.
--
-- BEFORE: jsonbStore('producer_custom_services', 'user_id') —
-- одна строка на producer'а с jsonb-массивом услуг/портфолио.
-- Race condition при concurrent POST /services/create:
--   handler1: get(producerId) → arr [A]
--   handler2: get(producerId) → arr [A]
--   handler1: set(producerId, [A, B])
--   handler2: set(producerId, [A, C])   -- B потерян
-- Маловероятно в реальности (один продюсер не редактирует портфель
-- из двух tab'ов одновременно), но дешёвый фикс — row-per-item.
--
-- AFTER: row-per-service / row-per-portfolio-item.
--
-- ⚠️ RLS POLICY note (laptop pre-flight ловил это):
-- Обе таблицы имеют RLS policies producer_sel/ins/upd/del, которые
-- ссылаются на user_id колонку → DROP COLUMN user_id падал с
-- «policy depends on column». Миграция:
--   1. DROP POLICY перед DROP COLUMN user_id
--   2. После backfill — CREATE POLICY на producer_id с тем же
--      owner-check pattern что в db-client.tsx:40 — comparing
--      current_setting('app.current_user_id', true) с ownership колонкой.
-- Если оригинальные политики имели НЕ такой body (не owner-check, а
-- например role-based) — laptop должен сравнить мой CREATE POLICY с
-- pg_dump --schema-only ДО миграции и подкрутить если расходится.
-- App-код использует pool.query (admin connection bypasses RLS), так что
-- даже если policy body чуть разойдётся — runtime поведение не меняется,
-- это defense-in-depth для promofm_app user.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d producer_custom_services
--   \d producer_custom_portfolio
--   -- Snapshot существующих policies перед миграцией:
--   SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr,
--          pg_get_expr(polwithcheck, polrelid) AS check_expr
--     FROM pg_policy
--    WHERE polrelid::regclass::text IN
--          ('producer_custom_services', 'producer_custom_portfolio');
--   SELECT COUNT(*) row_cnt,
--          COALESCE(SUM(jsonb_array_length(data)),0) item_cnt
--     FROM producer_custom_services WHERE jsonb_typeof(data)='array';
--   SELECT COUNT(*) row_cnt,
--          COALESCE(SUM(jsonb_array_length(data)),0) item_cnt
--     FROM producer_custom_portfolio WHERE jsonb_typeof(data)='array';
--   BEGIN; \i 039_kv_to_sql_producer_custom.sql;
--     SELECT 'services', COUNT(*) FROM producer_custom_services
--     UNION ALL SELECT 'portfolio', COUNT(*) FROM producer_custom_portfolio;
--   ROLLBACK;
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t producer_custom_services -t producer_custom_portfolio promofm \
--        > /tmp/producer_custom_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--        -f /opt/promofm-api/src/migrations/039_kv_to_sql_producer_custom.sql
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. producer_custom_services → row-per-service
-- ════════════════════════════════════════════════════════════════════
-- KV pk='user_id' (TEXT), сохраним как producer_id колонку.

CREATE TEMP TABLE _pcs_backup ON COMMIT DROP AS
  SELECT user_id AS legacy_producer_id, data, created_at FROM producer_custom_services;

-- RLS policies на user_id (producer_sel/ins/upd/del) надо снять ДО
-- DROP COLUMN — иначе DROP падает с «policy depends on column user_id».
-- Recreate ниже на producer_id с тем же owner-check паттерном что в
-- db-client.tsx:40 (current_setting('app.current_user_id', true)).
DROP POLICY IF EXISTS producer_sel ON producer_custom_services;
DROP POLICY IF EXISTS producer_ins ON producer_custom_services;
DROP POLICY IF EXISTS producer_upd ON producer_custom_services;
DROP POLICY IF EXISTS producer_del ON producer_custom_services;

ALTER TABLE producer_custom_services DROP CONSTRAINT IF EXISTS producer_custom_services_pkey;
ALTER TABLE producer_custom_services DROP CONSTRAINT IF EXISTS producer_custom_services_user_id_key;
-- Защита от повторного запуска:
ALTER TABLE producer_custom_services DROP CONSTRAINT IF EXISTS producer_custom_services_app_id_unique;
ALTER TABLE producer_custom_services DROP CONSTRAINT IF EXISTS pcs_producer_app_unique;

TRUNCATE producer_custom_services;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_custom_services' AND column_name='user_id') THEN
    ALTER TABLE producer_custom_services DROP COLUMN user_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_custom_services' AND column_name='id') THEN
    ALTER TABLE producer_custom_services DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE producer_custom_services
  ADD COLUMN id            UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id        TEXT,
  ADD COLUMN IF NOT EXISTS producer_id   TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS title         TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS service_type  TEXT         NOT NULL DEFAULT 'mixing',
  ADD COLUMN IF NOT EXISTS base_price    NUMERIC      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS delivery_days INTEGER      NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS revisions     INTEGER      NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS includes      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS status        TEXT         NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS orders        INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating        NUMERIC      NOT NULL DEFAULT 5.0;

ALTER TABLE producer_custom_services ADD PRIMARY KEY (id);
-- Композитный UNIQUE: legacy 'svc1', 'svc2' могли дублироваться у разных продюсеров.
ALTER TABLE producer_custom_services
  ADD CONSTRAINT pcs_producer_app_unique UNIQUE (producer_id, app_id);

CREATE INDEX IF NOT EXISTS idx_pcs_producer_id ON producer_custom_services(producer_id);
CREATE INDEX IF NOT EXISTS idx_pcs_status      ON producer_custom_services(status);

INSERT INTO producer_custom_services (
  id, app_id, producer_id, title, service_type, base_price, description,
  delivery_days, revisions, includes, status, orders, rating, created_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  COALESCE(elem->>'producerId', b.legacy_producer_id),
  COALESCE(NULLIF(elem->>'title',''), ''),
  COALESCE(NULLIF(elem->>'type',''), 'mixing'),
  COALESCE(NULLIF(elem->>'basePrice','')::numeric, 0),
  elem->>'description',
  COALESCE(NULLIF(elem->>'deliveryDays','')::integer, 5),
  COALESCE(NULLIF(elem->>'revisions','')::integer, 2),
  COALESCE(elem->'includes', '[]'::jsonb),
  COALESCE(NULLIF(elem->>'status',''), 'active'),
  COALESCE(NULLIF(elem->>'orders','')::integer, 0),
  COALESCE(NULLIF(elem->>'rating','')::numeric, 5.0),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW())
FROM _pcs_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE producer_custom_services DROP COLUMN IF EXISTS data;

-- Recreate RLS policies на новой producer_id колонке.
-- Pattern из db-client.tsx:40: app.current_user_id выставляется в
-- session, политики сверяют с ownership column.
-- Use the same names that already existed на проде (producer_sel/ins/upd/del)
-- чтобы grant/revoke и admin-инспекция psql \dp не сломались.
CREATE POLICY producer_sel ON producer_custom_services
  FOR SELECT USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_ins ON producer_custom_services
  FOR INSERT WITH CHECK (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_upd ON producer_custom_services
  FOR UPDATE USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_del ON producer_custom_services
  FOR DELETE USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );

-- ════════════════════════════════════════════════════════════════════
-- 2. producer_custom_portfolio → row-per-entry
-- ════════════════════════════════════════════════════════════════════

-- Симметричный DROP POLICY перед DROP COLUMN, см. секцию выше.
DROP POLICY IF EXISTS producer_sel ON producer_custom_portfolio;
DROP POLICY IF EXISTS producer_ins ON producer_custom_portfolio;
DROP POLICY IF EXISTS producer_upd ON producer_custom_portfolio;
DROP POLICY IF EXISTS producer_del ON producer_custom_portfolio;

CREATE TEMP TABLE _pcp_backup ON COMMIT DROP AS
  SELECT user_id AS legacy_producer_id, data, created_at FROM producer_custom_portfolio;

ALTER TABLE producer_custom_portfolio DROP CONSTRAINT IF EXISTS producer_custom_portfolio_pkey;
ALTER TABLE producer_custom_portfolio DROP CONSTRAINT IF EXISTS producer_custom_portfolio_user_id_key;
-- Защита от повторного запуска:
ALTER TABLE producer_custom_portfolio DROP CONSTRAINT IF EXISTS producer_custom_portfolio_app_id_unique;
ALTER TABLE producer_custom_portfolio DROP CONSTRAINT IF EXISTS pcp_producer_app_unique;

TRUNCATE producer_custom_portfolio;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_custom_portfolio' AND column_name='user_id') THEN
    ALTER TABLE producer_custom_portfolio DROP COLUMN user_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='producer_custom_portfolio' AND column_name='id') THEN
    ALTER TABLE producer_custom_portfolio DROP COLUMN id;
  END IF;
END $$;

ALTER TABLE producer_custom_portfolio
  ADD COLUMN id            UUID         NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS app_id        TEXT,
  ADD COLUMN IF NOT EXISTS producer_id   TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS title         TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS artist        TEXT,
  ADD COLUMN IF NOT EXISTS item_type     TEXT,
  ADD COLUMN IF NOT EXISTS year          INTEGER,
  ADD COLUMN IF NOT EXISTS description   TEXT;

ALTER TABLE producer_custom_portfolio ADD PRIMARY KEY (id);
-- Композитный UNIQUE: legacy 'pf1', 'pf2' могли дублироваться у разных продюсеров.
ALTER TABLE producer_custom_portfolio
  ADD CONSTRAINT pcp_producer_app_unique UNIQUE (producer_id, app_id);

CREATE INDEX IF NOT EXISTS idx_pcp_producer_id_created
  ON producer_custom_portfolio(producer_id, created_at DESC);

INSERT INTO producer_custom_portfolio (
  id, app_id, producer_id, title, artist, item_type, year, description, created_at
)
SELECT
  gen_random_uuid(),
  elem->>'id',
  COALESCE(elem->>'producerId', b.legacy_producer_id),
  COALESCE(NULLIF(elem->>'title',''), ''),
  elem->>'artist',
  elem->>'type',
  COALESCE(NULLIF(elem->>'year','')::integer, EXTRACT(YEAR FROM NOW())::integer),
  elem->>'description',
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, b.created_at, NOW())
FROM _pcp_backup b,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(b.data)='array' THEN b.data ELSE '[]'::jsonb END
     ) elem;

ALTER TABLE producer_custom_portfolio DROP COLUMN IF EXISTS data;

-- Recreate RLS policies на producer_id (симметрично _services).
CREATE POLICY producer_sel ON producer_custom_portfolio
  FOR SELECT USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_ins ON producer_custom_portfolio
  FOR INSERT WITH CHECK (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_upd ON producer_custom_portfolio
  FOR UPDATE USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );
CREATE POLICY producer_del ON producer_custom_portfolio
  FOR DELETE USING (
    producer_id = current_setting('app.current_user_id', true)
    OR current_setting('app.current_user_role', true) IN ('admin', 'superadmin')
  );

COMMIT;
