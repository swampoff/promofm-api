-- 154: скачивание треков станциями по личной ссылке из еженедельного письма, без входа (01.10.2026)
--
-- Было: кнопка «Скачать» в письме требовала вход в кабинет + is_verified профиля.
-- За 14 дней ~15 живых станций нажали «Скачать», успешных скачиваний 0.
-- Теперь у каждого получателя письма личная подписанная ссылка (radio-dl-token.tsx).
-- Получатель — либо аккаунт станции (users.id), либо партнёрский контакт
-- (radio_partner_contacts.id), у которого аккаунта нет вовсе.
-- Идемпотентно.

BEGIN;

ALTER TABLE track_downloads_by_radio ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE track_downloads_by_radio ADD COLUMN IF NOT EXISTS partner_contact_id uuid;
ALTER TABLE track_downloads_by_radio ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'cabinet';
CREATE INDEX IF NOT EXISTS idx_tdr_partner_contact
  ON track_downloads_by_radio (partner_contact_id) WHERE partner_contact_id IS NOT NULL;

-- Анкета «для какой станции скачиваете» на странице скачивания
ALTER TABLE radio_partner_contacts ADD COLUMN IF NOT EXISTS formats text[] NOT NULL DEFAULT '{}';
ALTER TABLE radio_partner_contacts ADD COLUMN IF NOT EXISTS stream_url text;
ALTER TABLE radio_partner_contacts ADD COLUMN IF NOT EXISTS details_updated_at timestamptz;
ALTER TABLE radio_profiles ADD COLUMN IF NOT EXISTS details_updated_at timestamptz;

COMMIT;
