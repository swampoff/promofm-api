-- 136: учёт прослушиваний треков.
--
-- Жалоба Александра Черниченко 2026-08-11: «не работает статистика трека».
-- Причина: plays_count никогда и никем не инкрементировался — эндпоинта
-- учёта не существовало, плеер ничего не отправлял. Ненулевые счётчики у
-- 20 треков — демо-засев от 2026-03-27.
--
-- Храним событие, а не только счётчик: из событий строится таймлайн в
-- кабинете артиста, а счётчик остаётся денормализованным для быстрых
-- выборок и сортировок.

CREATE TABLE IF NOT EXISTS track_plays (
  id         BIGSERIAL PRIMARY KEY,
  track_id   UUID        NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  user_id    TEXT        NULL,
  ip_hash    TEXT        NOT NULL,
  source     TEXT        NOT NULL DEFAULT 'site',
  played_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_track_plays_track_time ON track_plays (track_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_track_plays_dedup      ON track_plays (ip_hash, track_id, played_at DESC);
