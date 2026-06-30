-- Migration 115: send-tracking на radio_partner_contacts — единая база рассылки
--
-- Контекст: рассылку по базе радиостанций ведут ДВА актора — облачный крон
-- (weekly-дайджест, /run-weekly) и laptop (уже разослал часть вручную). Чтобы
-- они не били по одним и тем же адресам дважды, нужен единый primitive
-- «когда этому контакту в последний раз слали».
--
-- radio_partner_contacts становится ЕДИНСТВЕННЫМ источником истины:
--   active=true, unsubscribed_at IS NULL  → можно слать
--   last_sent_at                          → когда последний раз слали (NULL = ни разу)
--   send_count                            → сколько раз всего
--
-- Сценарии после этой миграции:
--   • Холодный первый прогон по ОСТАВШИМСЯ: WHERE last_sent_at IS NULL
--     (laptop помечает свой уже-разосланный батч → они исключаются автоматически).
--   • Weekly-дайджест: шлёт всем active и штампует last_sent_at (для записи/трокотлинга).
--
-- Apply (CLAUDE.md «NO BEGIN/COMMIT inside»):
--   BEGIN; \i .../115_radio_partner_contacts_send_tracking.sql; COMMIT;

ALTER TABLE radio_partner_contacts
  ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_count   INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_radio_partner_contacts_last_sent
  ON radio_partner_contacts (last_sent_at);
