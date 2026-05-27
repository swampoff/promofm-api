-- 035_dj_events_restore_unique.sql
--
-- Восстановление UNIQUE constraint на dj_events.dj_id.
--
-- Контекст: ранее моя migration 034_dj_events_multi.sql убрала UNIQUE на
-- dj_id предположив что dj_events должна быть row-per-event для нового
-- DjEvents UI (отдельная строка на каждое выступление DJ). Это оказалось
-- архитектурно неверно:
--   - src/db.tsx использует djEventsStore = jsonbStore('dj_events','dj_id')
--   - jsonbStore.set() делает INSERT ... ON CONFLICT (dj_id) DO UPDATE
--   - Без UNIQUE на dj_id это падает с
--     «no unique or exclusion constraint matching the ON CONFLICT spec»
--
-- Корректный контракт: один dj_id → одна строка с массивом events в
-- data jsonb (kv-store паттерн как в venue_playlists).
--
-- Безопасно: проверено что нет дубликатов dj_id (HAVING COUNT > 1 → 0 rows),
-- ADD CONSTRAINT прошёл успешно. Дубликатов и не могло быть — таблица была
-- молодой (1 row на момент применения).
--
-- Идемпотентно через try/IF EXISTS pattern: если constraint уже есть — skip.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dj_events_dj_id_unique'
       AND conrelid = 'dj_events'::regclass
  ) THEN
    ALTER TABLE dj_events
      ADD CONSTRAINT dj_events_dj_id_unique UNIQUE (dj_id);
  END IF;
END$$;
