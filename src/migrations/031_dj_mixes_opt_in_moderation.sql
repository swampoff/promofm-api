-- 031_dj_mixes_opt_in_moderation.sql — модерация миксов опциональна.
--
-- Миграция 030 ввела принудительный pending→approved→published пайплайн
-- для ВСЕХ загружаемых миксов. Бизнес-правило другое:
--   - DJ загружает микс → сразу published (для своего публичного профиля)
--   - DJ хочет на радио/в питчинг → нажимает кнопку → moderation_status=pending
--
-- Меняем дефолты обратно: новый микс = published+видимый. Старая логика
-- модерации остаётся в админке для тех миксов, которые DJ САМ отправит.
--
-- Идемпотентно через ALTER COLUMN SET DEFAULT.

BEGIN;

ALTER TABLE dj_mixes
  ALTER COLUMN moderation_status SET DEFAULT 'published';

ALTER TABLE dj_mixes
  ALTER COLUMN is_hidden SET DEFAULT FALSE;

-- Backfill: всё что застряло в pending до этого фикса считаем
-- опубликованным (миграция 030 для НОВЫХ deploy'ев успела пометить
-- только один микс — он уже published. Но если на других стендах
-- что-то ушло в pending — поднимем).
UPDATE dj_mixes
   SET moderation_status = 'published',
       is_hidden         = FALSE
 WHERE moderation_status = 'pending'
   AND moderated_at IS NULL;

COMMIT;
