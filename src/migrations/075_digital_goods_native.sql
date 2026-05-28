-- Migration 075 — digital_goods: kill data jsonb, atomic view/sales counters.
--
-- Context:
--   digital_goods — каталог цифровых товаров маркетплейса (sample packs,
--   presets, kits, et al). 8 callers across 3 files:
--     marketplace-routes.tsx: getAllDigitalGoods (filter/sort), GET /:id
--       (view increment), POST create, GET purchase preflight
--     checkout-routes.tsx: webhook complete (sales increment)
--     demo-seed.tsx: seed loop
--
-- Bug fixes earned по пути:
--   1. View increment race: `get + good.views++ + set(JSON.stringify(good))`
--      → 2 concurrent /digital-goods/:id запроса теряли одно
--      view (read same value, both write same +1). Native атомарный
--      UPDATE digital_goods SET views = views + 1.
--   2. Sales increment race: тот же паттерн на purchase webhook.
--      Webhook'и от YooKassa могут retry'иться, native UPDATE атомарен.
--   3. JS-side filter/sort на getAll(): tier-3 hot path (default sort
--      'popular' = ORDER BY sales DESC). Native SQL ORDER BY + LIMIT
--      OFFSET с partial index — pushdown в DB.
--   4. JSON.stringify abuse: handler делал `set(id, JSON.stringify(good))`
--      → store записывал ESCAPED string в data jsonb (см. lesson из
--      makeJsonbKeyStore.set normalizer). После native — direct typed
--      INSERT без JSON.stringify.
--
-- Shape (per handler write site):
--   id          TEXT     -- 'dg-<uuid>'
--   title       TEXT     NOT NULL
--   producer    TEXT     -- display name, default 'Unknown'
--   producerId  TEXT     NOT NULL  → producer_id
--   category    TEXT     NOT NULL
--   description TEXT     default ''
--   price       NUMERIC  NOT NULL
--   tags        TEXT[]   default '{}'
--   fileSize    TEXT     default '0 MB'  → file_size
--   format      TEXT     default ''
--   rating      NUMERIC  default 0
--   sales       INTEGER  default 0
--   views       INTEGER  default 0
--   status      TEXT     default 'active'  -- 'active' | other
--   createdAt   ISO      → created_at
--
-- Companion code: db.tsx (7 typed funcs), marketplace-routes.tsx (5),
-- checkout-routes.tsx (1), demo-seed.tsx (1).

-- ── 1. Native cols
ALTER TABLE digital_goods
  ADD COLUMN IF NOT EXISTS title       TEXT,
  ADD COLUMN IF NOT EXISTS producer    TEXT,
  ADD COLUMN IF NOT EXISTS producer_id TEXT,
  ADD COLUMN IF NOT EXISTS category    TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS price       NUMERIC,
  ADD COLUMN IF NOT EXISTS tags        TEXT[],
  ADD COLUMN IF NOT EXISTS file_size   TEXT,
  ADD COLUMN IF NOT EXISTS format      TEXT,
  ADD COLUMN IF NOT EXISTS rating      NUMERIC,
  ADD COLUMN IF NOT EXISTS sales       INTEGER,
  ADD COLUMN IF NOT EXISTS views       INTEGER,
  ADD COLUMN IF NOT EXISTS status      TEXT;

-- ── 2. Backfill из data jsonb.
--    Note: data может быть escaped string (handler делал JSON.stringify),
--    обрабатываем через jsonb cast'ы. Если data это jsonb string —
--    data->>'title' вернёт NULL; data#>>'{}' извлекает inner string,
--    потом ::jsonb→cast обратно. Defensive: пробуем оба пути.
UPDATE digital_goods SET
  title       = COALESCE(title,       data->>'title',
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'title'
                               ELSE NULL END)),
  producer    = COALESCE(producer,    data->>'producer',
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'producer'
                               ELSE NULL END)),
  producer_id = COALESCE(producer_id, data->>'producerId',
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'producerId'
                               ELSE NULL END)),
  category    = COALESCE(category,    data->>'category',
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'category'
                               ELSE NULL END)),
  description = COALESCE(description, data->>'description',
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'description'
                               ELSE NULL END)),
  price       = COALESCE(price, NULLIF(data->>'price','')::numeric,
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN NULLIF((data#>>'{}')::jsonb->>'price','')::numeric
                               ELSE NULL END)),
  file_size   = COALESCE(file_size,   data->>'fileSize',
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'fileSize'
                               ELSE NULL END)),
  format      = COALESCE(format,      data->>'format',
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'format'
                               ELSE NULL END)),
  rating      = COALESCE(rating, NULLIF(data->>'rating','')::numeric,
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN NULLIF((data#>>'{}')::jsonb->>'rating','')::numeric
                               ELSE NULL END), 0),
  sales       = COALESCE(sales, NULLIF(data->>'sales','')::int,
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN NULLIF((data#>>'{}')::jsonb->>'sales','')::int
                               ELSE NULL END), 0),
  views       = COALESCE(views, NULLIF(data->>'views','')::int,
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN NULLIF((data#>>'{}')::jsonb->>'views','')::int
                               ELSE NULL END), 0),
  status      = COALESCE(status,      data->>'status',
                         (CASE WHEN jsonb_typeof(data) = 'string'
                               THEN (data#>>'{}')::jsonb->>'status'
                               ELSE NULL END), 'active')
WHERE data IS NOT NULL;

-- ── 3. Backfill tags (array): обрабатываем object и string-encoded
UPDATE digital_goods SET
  tags = ARRAY(SELECT jsonb_array_elements_text(data->'tags'))
WHERE (tags IS NULL OR array_length(tags, 1) IS NULL)
  AND data IS NOT NULL
  AND jsonb_typeof(data) = 'object'
  AND data ? 'tags';

UPDATE digital_goods SET
  tags = ARRAY(SELECT jsonb_array_elements_text((data#>>'{}')::jsonb->'tags'))
WHERE (tags IS NULL OR array_length(tags, 1) IS NULL)
  AND data IS NOT NULL
  AND jsonb_typeof(data) = 'string'
  AND (data#>>'{}')::jsonb ? 'tags';

-- ── 4. DELETE orphan rows без required fields
DELETE FROM digital_goods
 WHERE title IS NULL OR producer_id IS NULL OR category IS NULL OR price IS NULL;

-- ── 5. Tighten constraints + defaults
ALTER TABLE digital_goods
  ALTER COLUMN title       SET NOT NULL,
  ALTER COLUMN producer_id SET NOT NULL,
  ALTER COLUMN category    SET NOT NULL,
  ALTER COLUMN price       SET NOT NULL,
  ALTER COLUMN producer    SET DEFAULT 'Unknown',
  ALTER COLUMN description SET DEFAULT '',
  ALTER COLUMN tags        SET DEFAULT '{}'::TEXT[],
  ALTER COLUMN file_size   SET DEFAULT '0 MB',
  ALTER COLUMN format      SET DEFAULT '',
  ALTER COLUMN rating      SET DEFAULT 0,
  ALTER COLUMN sales       SET DEFAULT 0,
  ALTER COLUMN views       SET DEFAULT 0,
  ALTER COLUMN status      SET DEFAULT 'active';

UPDATE digital_goods SET
  producer    = COALESCE(producer,    'Unknown'),
  description = COALESCE(description, ''),
  tags        = COALESCE(tags,        '{}'::TEXT[]),
  file_size   = COALESCE(file_size,   '0 MB'),
  format      = COALESCE(format,      ''),
  rating      = COALESCE(rating,      0),
  sales       = COALESCE(sales,       0),
  views       = COALESCE(views,       0),
  status      = COALESCE(status,      'active');

ALTER TABLE digital_goods
  ALTER COLUMN producer    SET NOT NULL,
  ALTER COLUMN description SET NOT NULL,
  ALTER COLUMN tags        SET NOT NULL,
  ALTER COLUMN file_size   SET NOT NULL,
  ALTER COLUMN format      SET NOT NULL,
  ALTER COLUMN rating      SET NOT NULL,
  ALTER COLUMN sales       SET NOT NULL,
  ALTER COLUMN views       SET NOT NULL,
  ALTER COLUMN status      SET NOT NULL;

-- ── 6. DROP COLUMN data
ALTER TABLE digital_goods DROP COLUMN IF EXISTS data;

-- ── 7. Hot-path indexes
--   Default sort = 'popular' (sales DESC) на active items — основной
--   listing запрос.
--   producer_id — filter «only my goods» от producer cabinet.
--   category    — public filter «vsts only» etc.
--   created_at  — sort='new'.
CREATE INDEX IF NOT EXISTS idx_digital_goods_active_popular
  ON digital_goods(sales DESC, rating DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_digital_goods_producer
  ON digital_goods(producer_id);
CREATE INDEX IF NOT EXISTS idx_digital_goods_category
  ON digital_goods(category) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_digital_goods_created_recent
  ON digital_goods(created_at DESC) WHERE status = 'active';
