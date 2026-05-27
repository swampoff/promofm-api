-- 034_dj_events_multi.sql
-- dj_events имел `UNIQUE idx_dj_events_djid btree (dj_id)` — тот же баг
-- что был у dj_mixes (миграция 027). Из-за UNIQUE один DJ мог создать
-- только ОДНО событие — второй INSERT падал с
-- `duplicate key value violates unique constraint`.
--
-- DJ-кабинет показывает раздел «События» как ленту будущих выступлений
-- (анонсы клубных нightов, фестивалей, стримов). Очевидно их должно
-- быть много на одного DJ — UNIQUE здесь архитектурная ошибка.
--
-- Идемпотентно через IF EXISTS / IF NOT EXISTS.

BEGIN;

DROP INDEX IF EXISTS idx_dj_events_djid;
CREATE INDEX IF NOT EXISTS idx_dj_events_dj_id ON dj_events(dj_id);
CREATE INDEX IF NOT EXISTS idx_dj_events_date  ON dj_events(event_date DESC);

COMMIT;
