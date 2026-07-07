-- 120: video promo-pipeline (admin VideoModeration)
--
-- Три admin-действия над клипом (videos-routes.tsx):
--   promoteToNovelty — платно (10 000 ₽): 14 дней в секции «Новые клипы»
--                      на главной (GET /videos/newClips подмешивает
--                      promoted_until > NOW());
--   addToNewsletter  — бесплатно: клип попадает в ближайший понедельничный
--                      weekly-дайджест радиостанциям (radio-digest-routes,
--                      курсор newsletter_requested_at/newsletter_sent_at);
--   exclusivePitch   — платно (15 000 ₽): именная рассылка ТВ/радио-базе
--                      после оплаты (webhook checkout-routes).
--
-- pipeline jsonb — состояние платёжных заказов/отметок (payment_order_id,
-- paid_at, счётчики отправки) — nested-данные, основные поля нативные.

ALTER TABLE videos ADD COLUMN IF NOT EXISTS promoted_until TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS pipeline JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS newsletter_requested_at TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS newsletter_sent_at TIMESTAMPTZ;

-- Лендинг каждые N секунд спрашивает активные промо — partial index
CREATE INDEX IF NOT EXISTS idx_videos_promoted_until
  ON videos (promoted_until)
  WHERE promoted_until IS NOT NULL;

-- Очередь weekly-дайджеста: «запрошено, ещё не отправлено»
CREATE INDEX IF NOT EXISTS idx_videos_newsletter_pending
  ON videos (newsletter_requested_at)
  WHERE newsletter_requested_at IS NOT NULL AND newsletter_sent_at IS NULL;
