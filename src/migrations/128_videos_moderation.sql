-- 121: модерация видео (admin VideoModeration)
--
-- До этого модерация видео жила только в локальном DataContext фронта
-- (демо-стор, per-browser) — approve/reject ничего не писали на сервер.
-- Теперь статус хранится на строке videos, admin-очередь читает
-- GET /api/videos/admin/list, решение пишет POST /api/videos/:id/moderate
-- (videos-routes.tsx).

ALTER TABLE videos ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS moderation_note TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS moderated_by TEXT;

-- Grandfather: всё, что уже лежит в таблице на момент миграции, живёт
-- на проде годами (sitemap светит всё is_hidden=false) — считаем
-- одобренным, иначе admin-очередь зальёт старыми записями. Новые
-- загрузки после миграции получают DEFAULT 'pending'.
UPDATE videos
   SET moderation_status = 'approved',
       moderated_at = NOW()
 WHERE moderation_status = 'pending';

-- Очередь модерации: «ждут решения»
CREATE INDEX IF NOT EXISTS idx_videos_moderation_pending
  ON videos (created_at)
  WHERE moderation_status = 'pending';

-- ── Прод-реконсиляция (2026-07-04, laptop): живая схема опережает миграцию ──
-- videos на проде УЖЕ имеет обе колонки из более раннего состояния:
--   moderation_status TEXT DEFAULT 'draft' (НЕ 'pending') → 404 approved + 20 draft, 0 pending
--   moderated_by      UUID                 (НЕ TEXT)
-- Поэтому ADD COLUMN IF NOT EXISTS выше = no-op (тип/дефолт не меняет), а
-- UPDATE ... WHERE ='pending' захватывает 0 строк. Доводим до ветки руками:
ALTER TABLE videos ALTER COLUMN moderated_by TYPE TEXT USING moderated_by::text;
ALTER TABLE videos ALTER COLUMN moderation_status SET DEFAULT 'pending';
-- 404 approved — остаются approved (в эфире). 20 draft — остаются draft
-- (не отправлены; решение по ним за владельцем — не заливаем ими очередь).
-- Новые загрузки идут в DEFAULT 'pending' → попадают в admin-очередь.
