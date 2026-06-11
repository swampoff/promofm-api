-- Migration 108: pitching_radio.user_id — link catalog station → radio cabinet user
--
-- Контекст: pitching_radio это VIEW над real таблицей pitching_radio
-- (970 legacy строк, migration 009_pitching_schema_bridge.sql). До этого PR'а
-- catalog row никак не связан с реальным юзером радио-кабинета. Артист
-- питчит на radio station X → запись в pitching_submissions → admin
-- модерирует, НО кабинет радио (которому теоретически принадлежит
-- станция X) ничего не видит — radio_artist_requests никем не пишется.
--
-- Этот PR ломает архитектурный обрыв: добавляем user_id NULL колонку
-- на pitching_radio. Когда radio cabinet user «claim'ит» свою станцию
-- из каталога через POST /pitching/admin/radio-stations/:id/claim,
-- user_id заполняется. После этого finalizePitchingBundle при
-- завершении оплаты артистского pitch'а делает зеркальный INSERT
-- в radio_artist_requests с radio_id=user_id — и заявка появляется
-- в кабинете радио.
--
-- Без claim'а (970 unclaimed legacy строк) — старое поведение: pitch
-- идёт только в admin moderation queue. Migration не ломает существующий
-- flow, только открывает новый.
--
-- pitching_radio — реальная таблица (НЕ view). pitching_radio_stations
-- VIEW над ней (см. migration 009). ALTER TABLE на base — VIEW
-- автоматически наследует user_id колонку через CREATE OR REPLACE VIEW
-- ниже (нужно потому что explicit column list в SELECT VIEW'а).
--
-- Apply: см. CLAUDE.md «Migration files: NO BEGIN/COMMIT inside»
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
--   BEGIN;
--   \i /opt/promofm-api/src/migrations/108_pitching_radio_user_id.sql
--   COMMIT;
--   EOF

ALTER TABLE pitching_radio
  ADD COLUMN IF NOT EXISTS user_id TEXT;

-- Index: для lookup'а по user_id (radio cabinet → catalog row),
-- и для «не повторять claim» (один user_id = одна claimed station).
CREATE INDEX IF NOT EXISTS idx_pitching_radio_user_id
  ON pitching_radio (user_id)
  WHERE user_id IS NOT NULL;

-- VIEW pitching_radio_stations — пересоздаём чтобы пробросить user_id
-- наверх (иначе финализатор не сможет SELECT pitching_radio_stations.user_id).
-- Тот же SELECT что в migration 009, плюс user_id колонка.

DROP VIEW IF EXISTS pitching_radio_stations CASCADE;

CREATE OR REPLACE VIEW pitching_radio_stations AS
SELECT
  id,
  name,
  COALESCE(region, '')      AS region,
  'Russia'::text            AS country,
  COALESCE(radio_type, '')  AS genre,
  ''::text                  AS website,
  ''::text                  AS contact_email,
  'active'::text            AS status,
  user_id
FROM pitching_radio;
