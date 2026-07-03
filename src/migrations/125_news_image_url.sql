-- 123: обложка на строке новости артиста
--
-- news-page.tsx всегда загружала обложку в /storage/upload и получала
-- CDN-URL, но метаданные новости жили только в localStorage фронта —
-- а после подключения POST /api/news upsertNews не имел куда писать
-- картинку. Нативная колонка, читается в GET /api/news/mine и
-- mapArticle (image_url).

ALTER TABLE news ADD COLUMN IF NOT EXISTS image_url TEXT;
