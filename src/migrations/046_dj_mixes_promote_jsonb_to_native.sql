-- 046_dj_mixes_promote_jsonb_to_native.sql
--
-- dj_mixes — hybrid таблица с активным `data jsonb`. Native columns
-- покрывают только id/dj_id/title/genre/duration/plays_count/audio_url/
-- cover_url/description/bpm_range/status/moderation_status/
-- moderated_at/moderation_comment/rejection_reason/is_hidden/
-- created_at/updated_at. Остальные 15+ полей живут в data jsonb и
-- читаются hot-path запросами (landing-data WHERE data->>'…',
-- checkout payment validation, cron upcoming→published).
--
-- Migration: promote ВСЕ известные data-поля в native columns +
-- backfill + INDEX'ы для hot-path. После этого ВСЕ writers/readers
-- переключаются на native cols, и `data jsonb` DROP'ается.
--
-- Inventory data полей (audit grep + reading writers):
--
-- Upload-time (dj-studio-routes.tsx::POST /mixes/upload):
--   isPremium     BOOL   — премиум-флаг (платная публикация)
--   price         NUMBER — цена за публикацию
--   likes         INT    — лайки (всегда 0 при upload)
--   downloads     INT    — скачивания
--   comments      INT    — комментарии
--   distribute    OBJECT — {radio: bool, venues: bool} | null
--
-- Moderation approve (dj-mix-moderation-routes.tsx):
--   requires_payment        BOOL — нужна ли оплата
--   payment_amount          NUM  — сумма
--   first_mix_free_applied  BOOL — первый микс бесплатно
--   paid_at                 ISO  — момент бесплатной публикации
--   upcoming_until          ISO  — таймер upcoming→published
--   approved_for_release_at ISO  — момент одобрения админом
--
-- Checkout (checkout-routes.tsx::webhook payment success):
--   payment_completed BOOL — флаг оплаты
--   payment_amount    NUM  — повторная запись с server-amount
--   payment_order_id  TEXT — id заказа
--   payment_gateway   TEXT — yookassa/stripe/etc
--   paid_at           ISO  — момент оплаты
--   upcoming_until    ISO  — +3 дня от paid_at
--   approved_for_release_at ISO
--
-- Promote cron (track-moderation-routes.tsx::POST /promote-upcoming):
--   published_at ISO — момент публикации в Новинки недели
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT — runner
-- оборачивает heredoc'ом (см. CLAUDE.md → «Migration files: NO
-- BEGIN/COMMIT inside the file»).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d dj_mixes
--   -- Counts of data field usage:
--   SELECT
--     COUNT(*) total,
--     COUNT(*) FILTER (WHERE (data->>'payment_completed')='true') paid,
--     COUNT(*) FILTER (WHERE (data->>'first_mix_free_applied')='true') free,
--     COUNT(*) FILTER (WHERE (data->>'isPremium')='true') premium,
--     COUNT(*) FILTER (WHERE data->>'upcoming_until' IS NOT NULL) has_upcoming
--   FROM dj_mixes WHERE jsonb_typeof(data) = 'object';
--   -- RLS snapshot:
--   SELECT polname FROM pg_policy WHERE polrelid::regclass::text='dj_mixes';
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t dj_mixes promofm > /tmp/dj_mixes_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/046_dj_mixes_promote_jsonb_to_native.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- ════════════════════════════════════════════════════════════════════
-- 1. Promote data jsonb поля в native columns
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE dj_mixes
  ADD COLUMN IF NOT EXISTS is_premium             BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS price                  NUMERIC      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS likes_count            INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS downloads_count        INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comments_count         INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS distribute_radio       BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS distribute_venues      BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS requires_payment       BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS first_mix_free_applied BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_completed      BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_amount         NUMERIC,
  ADD COLUMN IF NOT EXISTS payment_order_id       TEXT,
  ADD COLUMN IF NOT EXISTS payment_gateway        TEXT,
  ADD COLUMN IF NOT EXISTS paid_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS upcoming_until         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_for_release_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at           TIMESTAMPTZ;

-- ════════════════════════════════════════════════════════════════════
-- 2. Backfill existing data jsonb → native columns
-- ════════════════════════════════════════════════════════════════════
-- Только для rows где data jsonb непустой object. Иначе native cols
-- остаются с дефолтами.

UPDATE dj_mixes SET
  is_premium             = COALESCE((data->>'isPremium')::boolean, FALSE),
  price                  = COALESCE(NULLIF(data->>'price','')::numeric, 0),
  likes_count            = GREATEST(likes_count, COALESCE(NULLIF(data->>'likes','')::integer, 0)),
  downloads_count        = GREATEST(downloads_count, COALESCE(NULLIF(data->>'downloads','')::integer, 0)),
  comments_count         = GREATEST(comments_count, COALESCE(NULLIF(data->>'comments','')::integer, 0)),
  distribute_radio       = COALESCE((data->'distribute'->>'radio')::boolean, FALSE),
  distribute_venues      = COALESCE((data->'distribute'->>'venues')::boolean, FALSE),
  requires_payment       = COALESCE((data->>'requires_payment')::boolean, TRUE),
  first_mix_free_applied = COALESCE((data->>'first_mix_free_applied')::boolean, FALSE),
  payment_completed      = COALESCE((data->>'payment_completed')::boolean, FALSE),
  payment_amount         = NULLIF(data->>'payment_amount','')::numeric,
  payment_order_id       = NULLIF(data->>'payment_order_id',''),
  payment_gateway        = NULLIF(data->>'payment_gateway',''),
  paid_at                = NULLIF(data->>'paid_at','')::timestamptz,
  upcoming_until         = NULLIF(data->>'upcoming_until','')::timestamptz,
  approved_for_release_at = NULLIF(data->>'approved_for_release_at','')::timestamptz,
  published_at           = NULLIF(data->>'published_at','')::timestamptz
WHERE jsonb_typeof(data) = 'object';

-- ════════════════════════════════════════════════════════════════════
-- 3. Indexes для hot-path queries
-- ════════════════════════════════════════════════════════════════════

-- Landing «новые миксы» (landing-data-routes.tsx:449-464):
-- WHERE moderation_status IN ('upcoming','published') AND is_hidden=FALSE
--   AND (payment_completed=TRUE OR first_mix_free_applied=TRUE)
-- Partial index — узкий, под публичный каталог.
CREATE INDEX IF NOT EXISTS idx_dj_mixes_public_catalog
  ON dj_mixes(moderation_status, created_at DESC)
  WHERE is_hidden = FALSE
    AND (payment_completed = TRUE OR first_mix_free_applied = TRUE);

-- Cron promote (track-moderation-routes.tsx::POST /promote-upcoming):
-- WHERE moderation_status='upcoming' AND upcoming_until <= NOW()
CREATE INDEX IF NOT EXISTS idx_dj_mixes_upcoming_until
  ON dj_mixes(upcoming_until)
  WHERE moderation_status = 'upcoming' AND upcoming_until IS NOT NULL;

-- Premium-mix lookup для checkout-routes
CREATE INDEX IF NOT EXISTS idx_dj_mixes_premium_pending
  ON dj_mixes(dj_id)
  WHERE is_premium = TRUE AND moderation_status = 'pending';

-- ════════════════════════════════════════════════════════════════════
-- 4. DROP COLUMN data — после backfill больше не нужна
-- ════════════════════════════════════════════════════════════════════
-- ВНИМАНИЕ: если на проде есть НЕЗАДОКУМЕНТИРОВАННЫЕ поля в data,
-- они теряются. Audit grep + reading writers покрыл ВСЕ известные
-- writers — но если есть admin SQL'и или скрытые cron'ы, проверь
-- backup перед apply.

ALTER TABLE dj_mixes DROP COLUMN IF EXISTS data;
