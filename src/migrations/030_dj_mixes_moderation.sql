-- 030_dj_mixes_moderation.sql
--
-- DJ-миксы получают тот же модерационный пайплайн что и треки артистов.
-- Структура зеркалит поля tracks.moderation_status, чтобы можно было
-- использовать тот же admin-флоу (pending → approved → published) и
-- ту же логику "первый микс — бесплатно" + 5000 ₽ за публикацию.
--
-- ВАЖНО: backfill существующих миксов. До этой миграции все строки в
-- dj_mixes были de-facto published (status='published' колонка, никакой
-- модерации). Чтобы не сломать публичные профили / маркетплейс /
-- лендинг после деплоя — помечаем все старые миксы как уже одобренные
-- и оплаченные. Иначе они мгновенно скроются.
--
-- MANUAL DEPLOY STEPS:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/030_dj_mixes_moderation.sql

ALTER TABLE dj_mixes
  ADD COLUMN IF NOT EXISTS moderation_status TEXT,
  ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS moderation_comment TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT TRUE;

-- Backfill: всё что было до миграции — считаем уже опубликованным.
-- Без этого первый же запрос /tracks/new или DJ public profile вернёт
-- 0 миксов потому что новый default='pending' + is_hidden=true.
UPDATE dj_mixes
   SET moderation_status = 'published',
       is_hidden         = FALSE,
       moderated_at      = COALESCE(updated_at, created_at, NOW())
 WHERE moderation_status IS NULL;

-- Дефолт для всех ПОСЛЕДУЮЩИХ INSERT — модерация
ALTER TABLE dj_mixes
  ALTER COLUMN moderation_status SET DEFAULT 'pending';

-- NOT NULL после backfill — гарантия что pending/approved/published/rejected/upcoming
-- всегда есть значение в админ-фильтрах.
ALTER TABLE dj_mixes
  ALTER COLUMN moderation_status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dj_mixes_moderation_status
  ON dj_mixes(moderation_status);

CREATE INDEX IF NOT EXISTS idx_dj_mixes_pending_created
  ON dj_mixes(created_at DESC) WHERE moderation_status = 'pending';

-- Audit comments
COMMENT ON COLUMN dj_mixes.moderation_status IS
  'pending → admin не смотрел | approved → оплата нужна | upcoming → first-mix-free | published → виден | rejected → отклонён';
COMMENT ON COLUMN dj_mixes.is_hidden IS
  'TRUE для pending/approved/rejected. FALSE только для upcoming/published. Дублирует логику tracks.is_hidden.';
