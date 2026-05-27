-- 041_kv_wave2_analytics.sql
--
-- Wave 2 (analytics). Облегчённый рефактор — большинство analytics
-- таблиц это singleton-cache (один объект на ключ), валидный
-- KV use case; не трогаем. Единственные изменения:
--
-- 1. DROP orphan `artist_tracks_stats` — declaration в db.tsx есть,
--    callers 0 (grep подтвердил). Как dj_calendar в Wave 1.
--
-- 2. `artist_analytics_cache` — добавить native `expires_at TIMESTAMPTZ`
--    для proper TTL. Сейчас комментарий в коде врёт про TTL —
--    `jsonbStore` не имеет expiry, старые записи живут вечно. Native
--    expires_at + partial index закрывает это. Handler фильтрует
--    `WHERE expires_at IS NULL OR expires_at > NOW()` на чтение, на
--    запись стампует `expires_at = NOW() + INTERVAL '1 hour'`.
--    Cleanup-job не нужен — stale rows перезаписываются на следующем
--    compute, занимают копейки места.
--
-- ⚠️ КОНВЕНЦИЯ ТРАНЗАКЦИИ: файл НЕ содержит BEGIN/COMMIT — wrapping
-- управляется внешним runner'ом (см. CLAUDE.md → «Migration files:
-- NO BEGIN/COMMIT inside the file»).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d artist_tracks_stats
--   SELECT COUNT(*) FROM artist_tracks_stats;  -- ожидается 0
--   \d artist_analytics_cache
--   SELECT COUNT(*) FROM artist_analytics_cache;
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t artist_tracks_stats -t artist_analytics_cache promofm \
--        > /tmp/wave2_$(date +%s).sql
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--      BEGIN;
--      \i /opt/promofm-api/src/migrations/041_kv_wave2_analytics.sql
--      COMMIT;
--      EOF
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

-- ════════════════════════════════════════════════════════════════════
-- 1. artist_tracks_stats — orphan, DROP TABLE
-- ════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS artist_tracks_stats;

-- ════════════════════════════════════════════════════════════════════
-- 2. artist_analytics_cache — добавить TTL
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE artist_analytics_cache
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Существующие строки без TTL — пометить как уже истёкшие, чтобы
-- handler пересчитал и записал заново со свежим expires_at. Без этого
-- legacy-записи без expires_at жили бы вечно (т.к. handler на чтение
-- использует строгое expires_at > NOW(), которое NULL отфильтровывает
-- автоматом, но тогда мы вообще не отдадим cached даже для свежих
-- legacy-записей — это норм для первого запроса после деплоя).
UPDATE artist_analytics_cache SET expires_at = NOW() WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_artist_analytics_cache_expires
  ON artist_analytics_cache(expires_at);
