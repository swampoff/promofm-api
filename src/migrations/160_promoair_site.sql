-- 160: PROMO.AIR на promoair.ru (16.10.2026). Тот же API и база, что у promo-music.ru;
-- код в src/site-origin.tsx. Без этой миграции код работает (записи best-effort),
-- но сайт регистрации, хост просмотров и метка сайта в чате не сохраняются.

-- Сайт регистрации: письма без контекста запроса (крон, действия админа) ведут
-- на promoair.ru или promo-music.ru. NULL = зарегистрирован до 160.
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_site TEXT
  CONSTRAINT users_signup_site_chk CHECK (signup_site IN ('music', 'air'));

-- Хост просмотра (promo-music.ru, www.promo-music.ru, promoair.ru, ...): разделить
-- статистику сайтов. NULL = до 160 или неизвестный хост.
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS host TEXT;
CREATE INDEX IF NOT EXISTS idx_page_views_host ON page_views (host);

-- Гостевой чат с promoair.ru: source = 'widget:air' (ответ по почте ведёт обратно
-- на promoair.ru). Расширяем CHECK, прежние значения остаются.
ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_source_chk;
ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_source_chk
  CHECK (source = ANY (ARRAY['widget', 'cabinet', 'telegram', 'widget:air', 'cabinet:air']));
