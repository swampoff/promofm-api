-- 040_drop_orphan_dj_calendar.sql
--
-- Orphan cleanup: dj_calendar таблица + jsonbStore-декларация
-- объявлена в src/db.tsx:1509 но НИКТО НЕ ИСПОЛЬЗУЕТ (grep по
-- кодовой базе показывает 0 callers, кроме самой декларации).
-- Зомби-код от старого attempted feature, который не реализовали.
--
-- BEFORE: dj_calendar kv-table со схемой (dj_id TEXT PK, data JSONB,
-- created_at, updated_at). Все callers удалены, но таблица + декларация
-- продолжают существовать как mental noise.
--
-- AFTER: таблица + декларация удалены. Если когда-нибудь понадобится
-- DJ-календарь — создавать row-per-event сразу (см. dj_events за пример
-- proper relational schema).
--
-- ПРЕД-ПРОВЕРКА (laptop):
--   \d dj_calendar
--   SELECT COUNT(*) FROM dj_calendar;
--   -- если 0 строк — точно безопасно DROP'ать
--   -- если >0 строк — посмотреть data, скорее всего тестовый мусор
--      от ручных INSERT'ов, всё равно сделать бэкап и DROP'ать
--
-- MANUAL DEPLOY STEPS:
--   1. pg_dump -t dj_calendar promofm > /tmp/dj_calendar_$(date +%s).sql
--      (на случай если там какие-то данные)
--   2. sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--        -f /opt/promofm-api/src/migrations/040_drop_orphan_dj_calendar.sql
--   3. cd /opt/promofm-api && git pull && sudo systemctl restart promofm-api

BEGIN;

DROP TABLE IF EXISTS dj_calendar;

COMMIT;
