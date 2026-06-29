-- Migration 113: email_campaigns — выровнять под KV-хелпер (фича рассылок была мертва)
--
-- Контекст: db.tsx upsertEmailCampaign/getEmailCampaigns используют KV-в-`data`
-- подход — кладут весь объект кампании в `data` jsonb, ключуют по `artist_id`,
-- ставят `updated_at`. Исходно таблица была создана с «богатыми» NOT NULL
-- колонками (name и т.п.), которые хелпер никогда не заполнял → любой insert
-- кампании падал (name NOT NULL / нет artist_id / нет updated_at), и вся
-- система email-кампаний не работала (таблица пустая). Приводим таблицу к хелперу.
-- Идемпотентно.
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS artist_id  text        DEFAULT 'admin';
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE email_campaigns ALTER COLUMN name DROP NOT NULL;
