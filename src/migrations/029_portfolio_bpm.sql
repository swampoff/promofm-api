-- 029_portfolio_bpm.sql — добавляет BPM в producer/engineer portfolio.
--
-- BPM осмыслен для продюсерских работ (mix-сэмпл / продакшен)
-- и части инженерных (mix_sample, mastering_before/after). Для
-- мастеринга-as-such и restoration — необязателен.
--
-- Колонка nullable, дефолтов нет. Валидируется FE при вводе
-- (type=number, диапазон 40-220) и сохраняется как есть. Backend
-- не enforce-ит range — клиенту достаточно одной точки правды
-- (если артист введёт 5 BPM напрямую через API — это его
-- выбор, маркетплейс просто не возьмёт такой трек в фильтры).
--
-- Идемпотентно через ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE producer_portfolio
  ADD COLUMN IF NOT EXISTS bpm INTEGER;

ALTER TABLE engineer_portfolio
  ADD COLUMN IF NOT EXISTS bpm INTEGER;

COMMIT;
