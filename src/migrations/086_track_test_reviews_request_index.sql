-- Migration 086 — track_test_reviews: add index on request_id для
-- listTrackTestReviewsByRequest (заменяет dropped track_test_request_reviews
-- index table из migration 053).
--
-- track_test_reviews schema уже native (migration 053). Эта миграция
-- лишь добавляет hot-path index — все reads теперь идут через
-- WHERE request_id = $1 вместо derived index таблицы.
--
-- Idempotent.

CREATE INDEX IF NOT EXISTS idx_track_test_reviews_request
  ON track_test_reviews(request_id, created_at);

-- Bonus: expert_email index — для listing экспертом своих reviews.
CREATE INDEX IF NOT EXISTS idx_track_test_reviews_expert
  ON track_test_reviews(expert_email, created_at DESC)
  WHERE expert_email IS NOT NULL;
