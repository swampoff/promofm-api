-- 2026-06-17: admin pipeline для post-test продвижения трека.
--
-- 3 admin-кнопки в TrackTestManagement (Протестировано / Рассылка /
-- Эксклюзив) — см. /track-test/pipeline/{promoteToNovelty,addToNewsletter,
-- exclusivePitch} в track-test-routes.tsx.
--
-- A) promoteToNovelty (3000 ₽, артист платит, payment-link): после оплаты
--    tracks.expert_tested_until = now() + 14 days → отдельная секция на
--    лендинге «Протестировано экспертами».
-- B) addToNewsletter (бесплатно, синхронно): рассылка на email всех
--    users.role IN ('label','producer'). Никаких колонок не добавляет —
--    статус пишется в существующий track_test_requests data.jsonb.
-- C) exclusivePitch (7000 ₽, артист платит, payment-link): после оплаты
--    эксклюзив-рассылка тем же label/producer.
--
-- track_test_requests — KV-store, мутации идут в jsonb data поле, без
-- ALTER. Pipeline-флаги: data.pipeline.promote / newsletter / exclusive.

-- A: флаги «протестировано» на tracks
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS expert_tested_until TIMESTAMPTZ;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS expert_test_avg_rating NUMERIC(3,1);
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS expert_test_request_id UUID;

-- Индекс для лендинг-запроса «активные expert_tested треки» (≤ 50 строк
-- одновременно, индекс — для предотвращения seq-scan по 100K строк tracks).
CREATE INDEX IF NOT EXISTS idx_tracks_expert_tested_until
  ON tracks (expert_tested_until DESC)
  WHERE expert_tested_until IS NOT NULL;
