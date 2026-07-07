-- Migration 134: venue_partner_contacts — B2B-база заведений для «радио для заведений»
-- рассылки. Зеркало radio_partner_contacts (которую читают radio-digest/email-campaigns),
-- но для venue-сегмента. Источник — публичные контакты (38-ФЗ/152-ФЗ: перед рассылкой согласие).
CREATE TABLE IF NOT EXISTS venue_partner_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_name      text NOT NULL,
  email           text NOT NULL,
  category        text,
  city            text,
  phone           text,
  source          text,
  active          boolean NOT NULL DEFAULT true,
  unsubscribed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_sent_at    timestamptz,
  send_count      integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_partner_contacts_email ON venue_partner_contacts (lower(email));
