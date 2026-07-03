-- 124: модерация артист-новостей
--
-- Продуктовое решение (Никита, 2026-07-02): одобренные новости артистов
-- выходят на публичную страницу артиста И в общую ленту (news_public).
-- Очередь: GET /api/news/admin/artist-queue, решение:
-- POST /api/news/admin/:id/moderate (news-routes.tsx). При approve
-- строка копируется в news_public через существующий upsertNewsPublic
-- (source='artist').

ALTER TABLE news ADD COLUMN IF NOT EXISTS moderation_note TEXT;
ALTER TABLE news ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE news ADD COLUMN IF NOT EXISTS moderated_by TEXT;

-- Очередь модерации + выборка approved на страницу артиста
CREATE INDEX IF NOT EXISTS idx_news_status_created ON news (status, created_at);
CREATE INDEX IF NOT EXISTS idx_news_author_status ON news (author_id, status);
