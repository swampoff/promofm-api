-- 097_digital_goods_file_url.sql
--
-- Marketplace digital goods delivery — добавляем поля для физического
-- хранения файла товара и preview-семпла. До этого digital_goods был
-- «order-only» marketplace: producer создаёт лот, юзер платит, в БД
-- появляется запись о продаже — но самого ФАЙЛА купленного товара
-- нигде нет, ни одного endpoint'а его не отдаёт. Producer связывался
-- с buyer'ом off-platform.
--
-- Колонки:
--   - file_url     TEXT      — относительный путь /server/uploads/digital-goods/<filename>
--                              писательного через POST /digital-goods/:id/upload (producer-only)
--                              читается через GET /digital-goods/:id/download (access-check)
--                              NULL = товар без выложенного файла (legacy / в процессе)
--   - file_bytes   BIGINT    — размер файла в байтах, для UI + audit
--   - file_mime    TEXT      — Content-Type, выставляется по magic-bytes при upload
--   - preview_url  TEXT      — публичный preview (короткий sample), не требует auth.
--                              Раздаётся через static-handler /server/uploads/digital-goods-previews/*.
--                              NULL = preview не выложен (по умолчанию).
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT.
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d digital_goods
--   SELECT COUNT(*) total,
--          COUNT(*) FILTER (WHERE file_url IS NOT NULL) with_file
--     FROM digital_goods;
--
-- MANUAL DEPLOY STEPS:
--   1. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/097_digital_goods_file_url.sql
--      COMMIT;
--      EOF
--   2. mkdir -p /opt/promofm-api/uploads/digital-goods
--      mkdir -p /opt/promofm-api/uploads/digital-goods-previews
--      chown -R www-data:www-data /opt/promofm-api/uploads/digital-goods*
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

ALTER TABLE digital_goods
  ADD COLUMN IF NOT EXISTS file_url    TEXT,
  ADD COLUMN IF NOT EXISTS file_bytes  BIGINT,
  ADD COLUMN IF NOT EXISTS file_mime   TEXT,
  ADD COLUMN IF NOT EXISTS preview_url TEXT;

-- Индекс для будущей admin-ревизии «товары без выложенного файла».
CREATE INDEX IF NOT EXISTS idx_digital_goods_no_file
  ON digital_goods (created_at DESC)
  WHERE file_url IS NULL AND status = 'active';
