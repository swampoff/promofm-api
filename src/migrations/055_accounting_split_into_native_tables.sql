-- 055_accounting_split_into_native_tables.sql
--
-- accountingStore (KV table accounting_data with 5 array-in-value keys)
-- → 5 separate row-per-entity таблицы. Это был the «last big anti-pattern»
-- — admin-only бухгалтерия хранила всё в `data jsonb = [...]` массивах
-- с full-array overwrite на каждый POST/PUT/DELETE → race condition'ы
-- между конкурентными админскими действиями.
--
-- Сплит на 5 таблиц:
--   accounting_reports        — налоговые отчёты (status workflow: draft→ready→sent→accepted)
--   accounting_documents      — первичные документы / акты / счета
--   accounting_ledger         — бухгалтерские проводки
--   accounting_counterparties — контрагенты (vendors / customers)
--   accounting_calendar       — налоговый календарь / напоминания
--
-- 🐛 BUG fix в handler'ах (отдельно, не SQL): в payments-routes.tsx
-- `parseInt(c.req.param('id'))` на ID, который handler сам создаёт через
-- crypto.randomUUID() (string) → parseInt(uuid) === NaN → findIndex === -1
-- → 404 на любой PUT/DELETE. Фича PUT/DELETE никогда не работала корректно.
-- После рефактора: string ID везде, WHERE id = $1 без parseInt.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d accounting_data
--   SELECT key,
--          jsonb_typeof(data) jt,
--          CASE WHEN jsonb_typeof(data)='array'
--               THEN jsonb_array_length(data)
--               ELSE NULL END len
--     FROM accounting_data
--    WHERE key LIKE 'accounting:%';
--   -- Если данных нет вообще / только тест — миграция тривиальна.
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t accounting_data promofm > /tmp/accounting_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/055_accounting_split_into_native_tables.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- ─── accounting_reports ───
CREATE TABLE IF NOT EXISTS accounting_reports (
  id TEXT PRIMARY KEY,
  report_type     TEXT,                                       -- 'usn' | 'ndfl' | 'social' | …
  tax_period      TEXT,                                       -- '2026-Q1' / '2026' / …
  status          TEXT          NOT NULL DEFAULT 'draft',     -- 'draft'|'ready'|'sent'|'accepted'
  tax_amount      NUMERIC       NOT NULL DEFAULT 0,
  extra           JSONB         NOT NULL DEFAULT '{}'::jsonb, -- residual fields
  sent_at         TIMESTAMPTZ,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_accounting_reports_status_created
  ON accounting_reports(status, created_at DESC);

INSERT INTO accounting_reports
  (id, report_type, tax_period, status, tax_amount, extra,
   sent_at, accepted_at, created_at, updated_at)
SELECT
  COALESCE(NULLIF(elem->>'id',''),
           gen_random_uuid()::text)                      AS id,
  NULLIF(elem->>'type','')                               AS report_type,
  NULLIF(elem->>'taxPeriod','')                          AS tax_period,
  COALESCE(NULLIF(elem->>'status',''), 'draft')          AS status,
  COALESCE(NULLIF(elem->>'taxAmount','')::numeric, 0)    AS tax_amount,
  (elem - 'id' - 'type' - 'taxPeriod' - 'status'
        - 'taxAmount' - 'sentAt' - 'acceptedAt'
        - 'createdAt' - 'updatedAt')                     AS extra,
  NULLIF(elem->>'sentAt','')::timestamptz                AS sent_at,
  NULLIF(elem->>'acceptedAt','')::timestamptz            AS accepted_at,
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, NOW()) AS created_at,
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW()) AS updated_at
FROM accounting_data ad,
     jsonb_array_elements(ad.data) elem
WHERE ad.key = 'accounting:reports'
  AND jsonb_typeof(ad.data) = 'array'
ON CONFLICT (id) DO NOTHING;

-- ─── accounting_documents ───
CREATE TABLE IF NOT EXISTS accounting_documents (
  id TEXT PRIMARY KEY,
  doc_number      TEXT,                                       -- 'INV-001' / '№42-2026' / …
  counterparty    TEXT,                                       -- name OR id, app-level
  description     TEXT,
  doc_date        DATE,
  amount          NUMERIC       NOT NULL DEFAULT 0,
  vat_amount      NUMERIC       NOT NULL DEFAULT 0,
  doc_type        TEXT,                                       -- 'invoice'|'act'|'payment'|…
  status          TEXT          NOT NULL DEFAULT 'draft',     -- 'draft'|'issued'|'paid'
  paid_at         DATE,
  extra           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_accounting_documents_status_date
  ON accounting_documents(status, doc_date DESC);
CREATE INDEX IF NOT EXISTS idx_accounting_documents_counterparty
  ON accounting_documents(counterparty)
  WHERE counterparty IS NOT NULL;

INSERT INTO accounting_documents
  (id, doc_number, counterparty, description, doc_date, amount,
   vat_amount, doc_type, status, paid_at, extra, created_at, updated_at)
SELECT
  COALESCE(NULLIF(elem->>'id',''), gen_random_uuid()::text),
  NULLIF(elem->>'number',''),
  NULLIF(elem->>'counterparty',''),
  NULLIF(elem->>'description',''),
  NULLIF(elem->>'date','')::date,
  COALESCE(NULLIF(elem->>'amount','')::numeric, 0),
  COALESCE(NULLIF(elem->>'vatAmount','')::numeric, 0),
  NULLIF(elem->>'type',''),
  COALESCE(NULLIF(elem->>'status',''), 'draft'),
  NULLIF(elem->>'paidAt','')::date,
  (elem - 'id' - 'number' - 'counterparty' - 'description' - 'date'
        - 'amount' - 'vatAmount' - 'type' - 'status' - 'paidAt'
        - 'createdAt' - 'updatedAt'),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW())
FROM accounting_data ad,
     jsonb_array_elements(ad.data) elem
WHERE ad.key = 'accounting:documents'
  AND jsonb_typeof(ad.data) = 'array'
ON CONFLICT (id) DO NOTHING;

-- ─── accounting_ledger ───
CREATE TABLE IF NOT EXISTS accounting_ledger (
  id TEXT PRIMARY KEY,
  entry_date      DATE,
  debit_account   TEXT,
  credit_account  TEXT,
  amount          NUMERIC       NOT NULL DEFAULT 0,
  description     TEXT,
  extra           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_accounting_ledger_date
  ON accounting_ledger(entry_date DESC);

INSERT INTO accounting_ledger
  (id, entry_date, debit_account, credit_account, amount, description,
   extra, created_at, updated_at)
SELECT
  COALESCE(NULLIF(elem->>'id',''), gen_random_uuid()::text),
  NULLIF(elem->>'date','')::date,
  NULLIF(elem->>'debit',''),
  NULLIF(elem->>'credit',''),
  COALESCE(NULLIF(elem->>'amount','')::numeric, 0),
  NULLIF(elem->>'description',''),
  (elem - 'id' - 'date' - 'debit' - 'credit' - 'amount'
        - 'description' - 'createdAt' - 'updatedAt'),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW())
FROM accounting_data ad,
     jsonb_array_elements(ad.data) elem
WHERE ad.key = 'accounting:ledger'
  AND jsonb_typeof(ad.data) = 'array'
ON CONFLICT (id) DO NOTHING;

-- ─── accounting_counterparties ───
CREATE TABLE IF NOT EXISTS accounting_counterparties (
  id TEXT PRIMARY KEY,
  name            TEXT,
  inn             TEXT,
  kpp             TEXT,
  email           TEXT,
  address         TEXT,
  status          TEXT          NOT NULL DEFAULT 'active',
  last_activity_date DATE,
  extra           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_accounting_counterparties_status_name
  ON accounting_counterparties(status, name);
CREATE INDEX IF NOT EXISTS idx_accounting_counterparties_inn
  ON accounting_counterparties(inn)
  WHERE inn IS NOT NULL;

INSERT INTO accounting_counterparties
  (id, name, inn, kpp, email, address, status, last_activity_date,
   extra, created_at, updated_at)
SELECT
  COALESCE(NULLIF(elem->>'id',''), gen_random_uuid()::text),
  NULLIF(elem->>'name',''),
  NULLIF(elem->>'inn',''),
  NULLIF(elem->>'kpp',''),
  NULLIF(elem->>'email',''),
  NULLIF(elem->>'address',''),
  COALESCE(NULLIF(elem->>'status',''), 'active'),
  NULLIF(elem->>'lastActivityDate','')::date,
  (elem - 'id' - 'name' - 'inn' - 'kpp' - 'email' - 'address'
        - 'status' - 'lastActivityDate' - 'createdAt' - 'updatedAt'),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW())
FROM accounting_data ad,
     jsonb_array_elements(ad.data) elem
WHERE ad.key = 'accounting:counterparties'
  AND jsonb_typeof(ad.data) = 'array'
ON CONFLICT (id) DO NOTHING;

-- ─── accounting_calendar ───
CREATE TABLE IF NOT EXISTS accounting_calendar (
  id TEXT PRIMARY KEY,
  event_date      DATE,
  title           TEXT,
  description     TEXT,
  completed       BOOLEAN       NOT NULL DEFAULT FALSE,
  extra           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_accounting_calendar_upcoming
  ON accounting_calendar(event_date ASC)
  WHERE completed = FALSE;

INSERT INTO accounting_calendar
  (id, event_date, title, description, completed, extra, created_at, updated_at)
SELECT
  COALESCE(NULLIF(elem->>'id',''), gen_random_uuid()::text),
  NULLIF(elem->>'date','')::date,
  NULLIF(elem->>'title',''),
  NULLIF(elem->>'description',''),
  COALESCE(NULLIF(elem->>'completed','')::boolean, FALSE),
  (elem - 'id' - 'date' - 'title' - 'description' - 'completed'
        - 'createdAt' - 'updatedAt'),
  COALESCE(NULLIF(elem->>'createdAt','')::timestamptz, NOW()),
  COALESCE(NULLIF(elem->>'updatedAt','')::timestamptz, NOW())
FROM accounting_data ad,
     jsonb_array_elements(ad.data) elem
WHERE ad.key = 'accounting:calendar'
  AND jsonb_typeof(ad.data) = 'array'
ON CONFLICT (id) DO NOTHING;

-- ─── DELETE migrated rows from accounting_data ───
-- Не DROP'аем accounting_data table — там могут быть и другие (singleton)
-- ключи (`elevenlabs_config`, etc были тоже там по конвенции). Но 5
-- accounting:* ключей теперь redundant.
DELETE FROM accounting_data WHERE key LIKE 'accounting:%';
