-- 137: сегменты качества и признак основного адреса для базы заведений.
--
-- Импорт базы «Рестораны и кафе» (2026-08-11, 18 769 адресов от 10 637
-- заведений). Колонки нужны, чтобы (а) слать волнами по качеству адреса
-- и (б) не отправлять три письма в один ресторан: у 2 693 заведений
-- несколько адресов, основным считается первый.
ALTER TABLE venue_partner_contacts ADD COLUMN IF NOT EXISTS quality_segment TEXT;
ALTER TABLE venue_partner_contacts ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_venue_contacts_wave
  ON venue_partner_contacts (active, quality_segment, is_primary, last_sent_at);
