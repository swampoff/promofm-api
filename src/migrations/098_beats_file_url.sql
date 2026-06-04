-- 098_beats_file_url.sql
--
-- Beats marketplace delivery — добавляем поля для физического хранения
-- битового файла + preview-семпла. Аналогично digital_goods (097).
--
-- ⚠️ NOTE: эта миграция НЕ делает полный KV→native refactor для beats.
-- Сейчас `beats` живёт как `(id TEXT PK, data jsonb)` через jsonbStore
-- (см. src/db.tsx getBeat/upsertBeat). Полный refactor с backfill из
-- `data jsonb` в native cols (как 075 для digital_goods) — отдельная
-- задача в KV-migration tracker, не блокирует delivery.
--
-- Колонки (ADD COLUMN IF NOT EXISTS — idempotent):
--   - file_url     TEXT      — '/server/uploads/beats/<filename>'
--                              писательный через POST /beats/:id/upload
--                              читается через GET /beats/:id/download
--                              NULL = файл не выложен (legacy / pending)
--   - file_bytes   BIGINT    — размер, для UI + audit
--   - file_mime    TEXT      — Content-Type по magic-bytes
--   - preview_url  TEXT      — публичный preview (не required)
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d beats
--   SELECT COUNT(*) total,
--          COUNT(*) FILTER (WHERE data ? 'fileUrl') legacy_in_jsonb,
--          COUNT(*) FILTER (WHERE file_url IS NOT NULL) native_set
--     FROM beats;
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/098_beats_file_url.sql
--      COMMIT;
--      EOF
--   2. mkdir -p /opt/promofm-api/uploads/beats
--      mkdir -p /opt/promofm-api/uploads/beats-previews
--      chown -R www-data:www-data /opt/promofm-api/uploads/beats*
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- Review #180: Bootstrap CREATE TABLE убран — таблица beats не предмет
-- этой миграции (создаётся lazy через jsonbStore либо более ранней
-- миграцией). Если её нет в проде — ALTER упадёт с понятной ошибкой,
-- лучше чем тихо создать pre-KV структуру и потом рассинхронизироваться.
ALTER TABLE beats
  ADD COLUMN IF NOT EXISTS file_url    TEXT,
  ADD COLUMN IF NOT EXISTS file_bytes  BIGINT,
  ADD COLUMN IF NOT EXISTS file_mime   TEXT,
  ADD COLUMN IF NOT EXISTS preview_url TEXT;

-- Backfill из data jsonb если legacy producer'ы клали fileUrl внутрь
-- (на случай если frontend уже отправлял в jsonb). Idempotent — пишем
-- только если native col NULL и jsonb имеет значение.
UPDATE beats SET
  file_url    = COALESCE(file_url,    NULLIF(data->>'fileUrl', '')),
  file_bytes  = COALESCE(file_bytes,  NULLIF(data->>'fileBytes', '')::bigint),
  file_mime   = COALESCE(file_mime,   NULLIF(data->>'fileMime', '')),
  preview_url = COALESCE(preview_url, NULLIF(data->>'previewUrl', ''))
WHERE data IS NOT NULL
  AND (data ? 'fileUrl' OR data ? 'fileBytes' OR data ? 'fileMime' OR data ? 'previewUrl')
  AND (file_url IS NULL OR file_bytes IS NULL OR file_mime IS NULL OR preview_url IS NULL);

-- Partial index для admin-ревизии «биты без файла» (после массового импорта).
CREATE INDEX IF NOT EXISTS idx_beats_no_file
  ON beats (created_at DESC)
  WHERE file_url IS NULL;
