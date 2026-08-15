-- 138: поля метаданных для AI-слоя.
--
-- Замер 2026-08-14 показал: из 5864 опубликованных треков жанр указан у 175
-- (3%), описание у 38, теги у 4. Полей настроения, темпа, тональности,
-- языка и ISRC не существовало вовсе. Без них ни каталожный API, ни
-- AI Discoverability Score построить нельзя.
--
-- ⚠️ Источник каждого поля помечаем отдельно (по образцу genre_source):
-- машинно-выведенное нельзя выдавать за подтверждённое человеком. Урок
-- 2026-08-07: массовая простановка меток по вердикту модели ударила по
-- живым артистам.

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mood            TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS bpm             NUMERIC(6,2);
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS music_key       TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS energy          NUMERIC(4,2);
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS language        TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS vocal_type      TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS isrc            TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS instruments     TEXT[];
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS use_contexts    TEXT[];

-- Происхождение значений: 'audio' — обсчитано анализатором, 'ai' — выведено
-- моделью, 'human' — указано артистом или модератором.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS audio_features_source TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mood_source           TEXT;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS analyzed_at           TIMESTAMPTZ;

-- Индексы под каталожный поиск: фильтры по жанру/настроению/темпу/языку.
CREATE INDEX IF NOT EXISTS idx_tracks_catalog_genre ON tracks (genre) WHERE genre IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_catalog_mood  ON tracks (mood)  WHERE mood IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_catalog_bpm   ON tracks (bpm)   WHERE bpm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_analyzed      ON tracks (analyzed_at);
