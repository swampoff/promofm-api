-- 122: category/tags на строке видео
--
-- Форма загрузки видео у артиста всегда собирала category и tags, но
-- upsertVideo (db.tsx) их молча отбрасывал — в админ-модерации у всех
-- видео категория была «other». Теперь колонки нативные, фильтр по
-- категории в VideoModeration работает по реальным данным.

ALTER TABLE videos ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
