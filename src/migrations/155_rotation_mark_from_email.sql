-- 155: отметка «трек в эфире» со страницы скачивания по личной ссылке (01.10.2026)
--
-- Станция без кабинета (партнёрский контакт) теперь может сообщить о ротации.
-- Отчёт ложится в track_radio_pickups как обычный self-report станции
-- (source='radio_self_report'); здесь — откуда он пришёл и от кого.
-- Идемпотентно.

BEGIN;

ALTER TABLE track_radio_pickups ADD COLUMN IF NOT EXISTS submitted_by_partner_contact_id uuid;
ALTER TABLE track_radio_pickups ADD COLUMN IF NOT EXISTS submitted_via text;  -- 'cabinet' | 'email_link'; NULL — старые строки

COMMIT;
