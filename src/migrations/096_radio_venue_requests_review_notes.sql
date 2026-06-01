-- 096_radio_venue_requests_review_notes.sql
--
-- Audit B-R1 (2026-05-31): radio /orders/:id/approve принимал body.notes
-- но silently dropped — `void body.notes` без persistence. Если фронтенд
-- ожидал что notes сохранятся → молчаливо потерянные данные при approve.
-- Эта колонка позволяет сохранить заметки модератора при approve/reject.
--
-- ⚠️ КОНВЕНЦИЯ: НЕТ BEGIN/COMMIT — runner оборачивает.

ALTER TABLE radio_venue_requests
  ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- Длина > 2000 — мусор. CHECK через каталог.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'radio_venue_requests_review_notes_len') THEN
    ALTER TABLE radio_venue_requests
      ADD CONSTRAINT radio_venue_requests_review_notes_len
        CHECK (review_notes IS NULL OR length(review_notes) <= 2000);
  END IF;
END $$;
