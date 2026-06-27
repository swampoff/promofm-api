-- Migration 113: понедельничный weekly-дайджест новинок прямой рассылкой радио
--
-- Контекст: помимо daily info@-дайджеста (#264, marker radio_digest_sent_at,
-- migration 110 — ручная пересылка партнёрам по 2/день), запускаем ОТДЕЛЬНУЮ
-- понедельничную рассылку 12:00, которая шлёт пятничный батч новинок
-- (user_id='system-friday') НАПРЯМУЮ:
--   а) зарегистрированным радио-аккаунтам (users.role='radio_station');
--   б) внешним станциям-партнёрам из radio_partner_contacts (см. ниже);
--   в) копией на info@promofm.ru.
-- #264 продолжает работать независимо — у него свой курсор.
--
-- Две вещи в этой миграции:
--
-- 1) tracks.radio_weekly_digest_sent_at — ОТДЕЛЬНЫЙ курсор от
--    radio_digest_sent_at, чтобы понедельничный поток и daily info@-поток
--    не воровали треки друг у друга. NULL = в очереди на ближайший понедельник,
--    timestamptz = уже ушёл в weekly-рассылку. Не KV: одна нативная nullable-
--    колонка, как 110.
--
-- 2) radio_partner_contacts — нормальная row-per-station таблица под список
--    800+ радиостанций (у каталога pitching_radio адресов нет — там
--    contact_email пустой, см. 009_pitching_schema_bridge.sql:90). Заполняется
--    импортом присланного оператором списка. НЕ KV: одна строка = одна станция,
--    нативная колонка email, уникальность по LOWER(email), нативная отписка.
--
-- Колонки, на которые опирается код (radio-digest-routes.tsx, /run-weekly):
--   tracks: id(uuid), title, artist_name, genre, audio_url, cover_url,
--           moderation_status, user_id, created_at, radio_weekly_digest_sent_at
--   users:  id(uuid), email, full_name, role
--   radio_partner_contacts: email, station_name, active, unsubscribed_at
--   email_unsubscribes: email (глобальный opt-out, гейт уже в email-helper)
--
-- Apply (CLAUDE.md «Migration files: NO BEGIN/COMMIT inside»):
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--   BEGIN;
--   \i /opt/promofm-api/src/migrations/113_radio_weekly_digest.sql
--   COMMIT;
--   EOF

ALTER TABLE tracks
  ADD COLUMN IF NOT EXISTS radio_weekly_digest_sent_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS radio_partner_contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_name    TEXT        NOT NULL,
  email           TEXT        NOT NULL,
  region          TEXT,
  city            TEXT,
  source          TEXT,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  unsubscribed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_radio_partner_contacts_email
  ON radio_partner_contacts (LOWER(email));
