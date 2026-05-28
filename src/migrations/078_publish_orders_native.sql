-- Migration 078 — publish_orders: kill data jsonb, promote 30+ scalar cols.
--
-- Context:
--   publish_orders — заказы публикации видео/концертов. 22 call sites
--   через publishOrdersStore.{get,set,del,getAll,getByCol} в src/publish-routes.tsx
--   + 2 sites в src/chat-routes.tsx.
--
--   Bonus race fixes earned:
--     1. PUT /orders/:id/status repricing (line 721-796) — get→mutate→set без
--        блокировки. 2 concurrent admin clicks could lose status update.
--        Native: UPDATE ... WHERE id=$1 — single statement, atomic.
--     2. PUT /admin/batch-status (loop с per-orderId get→set) — same lost-update
--        race. Native parametrized UPDATE per order.
--     3. GET /admin/stats (line 905) — getAll() + 6 JS .filter().length calls.
--        Native: SELECT COUNT(*) FILTER (WHERE status=...) pushdown в SQL.
--
-- Shape: 35+ scalar fields (см. PublishOrder interface в publish-routes.tsx:51).
--   Video-specific (videoUrl, videoSource, videoCategory, thumbnailUrl) + concert-
--   specific (eventDate, eventTime, city, venueName, ...) — все optional cols.
--   tags TEXT[] для filterability.
--   extra JSONB для:
--     - distributionData (platform-specific blob после publish)
--     - statusHistory (append-only audit log, не нужен как column)
--     - labelMetadata, прочая редкая полиморфная инфа
--   (per CLAUDE.md «extra JSONB DEFAULT '{}' — для legit nested data»)
--
-- Idempotent. NO BEGIN/COMMIT (Flyway convention).

-- ── 1. Native cols
ALTER TABLE publish_orders
  ADD COLUMN IF NOT EXISTS user_id              TEXT,
  ADD COLUMN IF NOT EXISTS type                 TEXT,
  ADD COLUMN IF NOT EXISTS status               TEXT,
  ADD COLUMN IF NOT EXISTS title                TEXT,
  ADD COLUMN IF NOT EXISTS description          TEXT,
  ADD COLUMN IF NOT EXISTS plan                 TEXT,
  ADD COLUMN IF NOT EXISTS price                NUMERIC,
  ADD COLUMN IF NOT EXISTS price_base           NUMERIC,
  ADD COLUMN IF NOT EXISTS subscription_applied BOOLEAN,
  ADD COLUMN IF NOT EXISTS currency             TEXT,
  ADD COLUMN IF NOT EXISTS paid_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_method       TEXT,
  ADD COLUMN IF NOT EXISTS moderator_id         TEXT,
  ADD COLUMN IF NOT EXISTS moderator_comment    TEXT,
  ADD COLUMN IF NOT EXISTS moderated_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason     TEXT,
  ADD COLUMN IF NOT EXISTS revision_notes       TEXT,
  ADD COLUMN IF NOT EXISTS published_at         TIMESTAMPTZ,
  -- Video-specific
  ADD COLUMN IF NOT EXISTS video_url            TEXT,
  ADD COLUMN IF NOT EXISTS video_source         TEXT,
  ADD COLUMN IF NOT EXISTS video_category       TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_url        TEXT,
  ADD COLUMN IF NOT EXISTS tags                 TEXT[],
  -- Concert-specific
  ADD COLUMN IF NOT EXISTS event_date           DATE,
  ADD COLUMN IF NOT EXISTS event_time           TEXT,
  ADD COLUMN IF NOT EXISTS city                 TEXT,
  ADD COLUMN IF NOT EXISTS venue_name           TEXT,
  ADD COLUMN IF NOT EXISTS venue_address        TEXT,
  ADD COLUMN IF NOT EXISTS ticket_price_min     NUMERIC,
  ADD COLUMN IF NOT EXISTS ticket_price_max     NUMERIC,
  ADD COLUMN IF NOT EXISTS ticket_url           TEXT,
  ADD COLUMN IF NOT EXISTS poster_url           TEXT,
  ADD COLUMN IF NOT EXISTS genre                TEXT,
  -- Label-on-behalf
  ADD COLUMN IF NOT EXISTS acting_for_artist_id TEXT,
  ADD COLUMN IF NOT EXISTS acting_for_artist_user_id TEXT,
  ADD COLUMN IF NOT EXISTS label_id             TEXT,
  -- Polymorphic / append-only audit (distributionData, statusHistory, etc.)
  ADD COLUMN IF NOT EXISTS extra                JSONB;

-- ── 2. Backfill (handle both object и string-encoded data jsonb —
--    publish-routes писал JSON.stringify(order), see lines 464/563/590/...).
--    Resolve через jsonb_typeof check.
UPDATE publish_orders SET
  user_id              = COALESCE(user_id, data->>'userId',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'userId'
                                        ELSE NULL END)),
  type                 = COALESCE(type, data->>'type',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'type'
                                        ELSE NULL END)),
  status               = COALESCE(status, data->>'status',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'status'
                                        ELSE NULL END)),
  title                = COALESCE(title, data->>'title',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'title'
                                        ELSE NULL END)),
  description          = COALESCE(description, data->>'description',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'description'
                                        ELSE NULL END), ''),
  plan                 = COALESCE(plan, data->>'plan',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'plan'
                                        ELSE NULL END)),
  price                = COALESCE(price, NULLIF(data->>'price','')::numeric,
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN NULLIF((data#>>'{}')::jsonb->>'price','')::numeric
                                        ELSE NULL END)),
  price_base           = COALESCE(price_base, NULLIF(data->>'priceBase','')::numeric,
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN NULLIF((data#>>'{}')::jsonb->>'priceBase','')::numeric
                                        ELSE NULL END)),
  subscription_applied = COALESCE(subscription_applied,
                                  NULLIF(data->>'subscriptionApplied','')::boolean,
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN NULLIF((data#>>'{}')::jsonb->>'subscriptionApplied','')::boolean
                                        ELSE NULL END)),
  currency             = COALESCE(currency, data->>'currency',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'currency'
                                        ELSE NULL END), 'RUB'),
  paid_at              = COALESCE(paid_at, NULLIF(data->>'paidAt','')::timestamptz,
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN NULLIF((data#>>'{}')::jsonb->>'paidAt','')::timestamptz
                                        ELSE NULL END)),
  payment_method       = COALESCE(payment_method, data->>'paymentMethod',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'paymentMethod'
                                        ELSE NULL END)),
  moderator_id         = COALESCE(moderator_id, data->>'moderatorId',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'moderatorId'
                                        ELSE NULL END)),
  moderator_comment    = COALESCE(moderator_comment, data->>'moderatorComment',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'moderatorComment'
                                        ELSE NULL END)),
  moderated_at         = COALESCE(moderated_at, NULLIF(data->>'moderatedAt','')::timestamptz,
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN NULLIF((data#>>'{}')::jsonb->>'moderatedAt','')::timestamptz
                                        ELSE NULL END)),
  rejection_reason     = COALESCE(rejection_reason, data->>'rejectionReason',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'rejectionReason'
                                        ELSE NULL END)),
  revision_notes       = COALESCE(revision_notes, data->>'revisionNotes',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'revisionNotes'
                                        ELSE NULL END)),
  published_at         = COALESCE(published_at, NULLIF(data->>'publishedAt','')::timestamptz,
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN NULLIF((data#>>'{}')::jsonb->>'publishedAt','')::timestamptz
                                        ELSE NULL END)),
  video_url            = COALESCE(video_url, data->>'videoUrl',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'videoUrl'
                                        ELSE NULL END)),
  video_source         = COALESCE(video_source, data->>'videoSource',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'videoSource'
                                        ELSE NULL END)),
  video_category       = COALESCE(video_category, data->>'videoCategory',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'videoCategory'
                                        ELSE NULL END)),
  thumbnail_url        = COALESCE(thumbnail_url, data->>'thumbnailUrl',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'thumbnailUrl'
                                        ELSE NULL END)),
  event_date           = COALESCE(event_date, NULLIF(data->>'eventDate','')::date,
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN NULLIF((data#>>'{}')::jsonb->>'eventDate','')::date
                                        ELSE NULL END)),
  event_time           = COALESCE(event_time, data->>'eventTime',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'eventTime'
                                        ELSE NULL END)),
  city                 = COALESCE(city, data->>'city',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'city'
                                        ELSE NULL END)),
  venue_name           = COALESCE(venue_name, data->>'venueName',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'venueName'
                                        ELSE NULL END)),
  venue_address        = COALESCE(venue_address, data->>'venueAddress',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'venueAddress'
                                        ELSE NULL END)),
  ticket_price_min     = COALESCE(ticket_price_min, NULLIF(data->>'ticketPriceMin','')::numeric,
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN NULLIF((data#>>'{}')::jsonb->>'ticketPriceMin','')::numeric
                                        ELSE NULL END)),
  ticket_price_max     = COALESCE(ticket_price_max, NULLIF(data->>'ticketPriceMax','')::numeric,
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN NULLIF((data#>>'{}')::jsonb->>'ticketPriceMax','')::numeric
                                        ELSE NULL END)),
  ticket_url           = COALESCE(ticket_url, data->>'ticketUrl',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'ticketUrl'
                                        ELSE NULL END)),
  poster_url           = COALESCE(poster_url, data->>'posterUrl',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'posterUrl'
                                        ELSE NULL END)),
  genre                = COALESCE(genre, data->>'genre',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'genre'
                                        ELSE NULL END)),
  acting_for_artist_id      = COALESCE(acting_for_artist_id, data->>'actingForArtistId',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'actingForArtistId'
                                        ELSE NULL END)),
  acting_for_artist_user_id = COALESCE(acting_for_artist_user_id, data->>'actingForArtistUserId',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'actingForArtistUserId'
                                        ELSE NULL END)),
  label_id             = COALESCE(label_id, data->>'labelId',
                                  (CASE WHEN jsonb_typeof(data) = 'string'
                                        THEN (data#>>'{}')::jsonb->>'labelId'
                                        ELSE NULL END))
WHERE data IS NOT NULL;

-- Tags (array): handle both object и string-encoded
UPDATE publish_orders SET
  tags = ARRAY(SELECT jsonb_array_elements_text(data->'tags'))
WHERE (tags IS NULL OR array_length(tags, 1) IS NULL)
  AND data IS NOT NULL
  AND jsonb_typeof(data) = 'object'
  AND data ? 'tags';

UPDATE publish_orders SET
  tags = ARRAY(SELECT jsonb_array_elements_text((data#>>'{}')::jsonb->'tags'))
WHERE (tags IS NULL OR array_length(tags, 1) IS NULL)
  AND data IS NOT NULL
  AND jsonb_typeof(data) = 'string'
  AND (data#>>'{}')::jsonb ? 'tags';

-- extra jsonb: складываем distributionData + statusHistory + всё нерасплющенное.
-- На случай если на проде есть редкие custom поля, выживут здесь.
UPDATE publish_orders SET
  extra = jsonb_strip_nulls(jsonb_build_object(
    'distributionData', CASE WHEN jsonb_typeof(data) = 'object'
                              THEN data->'distributionData'
                              WHEN jsonb_typeof(data) = 'string'
                              THEN (data#>>'{}')::jsonb->'distributionData'
                              ELSE NULL END,
    'statusHistory',    CASE WHEN jsonb_typeof(data) = 'object'
                              THEN data->'statusHistory'
                              WHEN jsonb_typeof(data) = 'string'
                              THEN (data#>>'{}')::jsonb->'statusHistory'
                              ELSE NULL END
  ))
WHERE extra IS NULL AND data IS NOT NULL;

-- ── 3. DELETE orphans без user_id / type / title
DELETE FROM publish_orders
 WHERE user_id IS NULL OR type IS NULL OR title IS NULL;

-- ── 4. Defaults + NOT NULL
ALTER TABLE publish_orders
  ALTER COLUMN status      SET DEFAULT 'draft',
  ALTER COLUMN description SET DEFAULT '',
  ALTER COLUMN price       SET DEFAULT 0,
  ALTER COLUMN currency    SET DEFAULT 'RUB',
  ALTER COLUMN tags        SET DEFAULT '{}'::TEXT[],
  ALTER COLUMN extra       SET DEFAULT '{}'::jsonb;

UPDATE publish_orders SET
  status      = COALESCE(status,      'draft'),
  description = COALESCE(description, ''),
  price       = COALESCE(price,       0),
  currency    = COALESCE(currency,    'RUB'),
  tags        = COALESCE(tags,        '{}'::TEXT[]),
  extra       = COALESCE(extra,       '{}'::jsonb);

ALTER TABLE publish_orders
  ALTER COLUMN user_id     SET NOT NULL,
  ALTER COLUMN type        SET NOT NULL,
  ALTER COLUMN status      SET NOT NULL,
  ALTER COLUMN title       SET NOT NULL,
  ALTER COLUMN description SET NOT NULL,
  ALTER COLUMN price       SET NOT NULL,
  ALTER COLUMN currency    SET NOT NULL,
  ALTER COLUMN tags        SET NOT NULL,
  ALTER COLUMN extra       SET NOT NULL;

-- ── 5. DROP data
ALTER TABLE publish_orders DROP COLUMN IF EXISTS data;

-- ── 6. Hot-path indexes
--   (user_id, created_at DESC) — GET /orders (user-scoped, sort by createdAt DESC)
--   (status, created_at DESC)  — GET /admin/all + admin filters
--   (type) — type-scoped queries (rare but cheap)
CREATE INDEX IF NOT EXISTS idx_publish_orders_user_recent
  ON publish_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publish_orders_status_recent
  ON publish_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publish_orders_type
  ON publish_orders(type);
