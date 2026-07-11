-- 135: tracks.genre_source — откуда взялся жанр трека.
-- Значения: 'tag' (ID3), 'llm' (genre-detect при загрузке),
-- 'backfill-llm' / 'backfill-unknown' (прогон /tracks/genre-backfill).
-- NULL = ещё не проходил через genre-detect (легаси или ручной ввод).
--
-- Зачем: инцидент «U2 = Pop» (рассылка 09.07) — friday.js дефолтил 'Pop'
-- при пустом ID3-теге. Backfill перепроверяет system-friday-треки с
-- genre='Pop' через LLM; без маркера подтверждённый Pop оставался бы
-- в скоупе и перепроверялся каждый тик вечно.

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS genre_source TEXT;
