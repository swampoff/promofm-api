-- 127: promo_check pipeline — поддержка DJ-миксов (watermark/мониторинг)
--
-- До этого watermark/fingerprint-пайплайн знал только tracks. DJ-миксы
-- (dj_mixes, id TEXT вида 'mix-<uuid>') писались в БД без постановки в
-- мониторинг — единственная сущность на радио, которая НЕ маркировалась.
--
-- ⚠️ ВАЖНО ДЛЯ LAPTOP: таблицы promo_check_fingerprints и
-- promo_check_detections созданы ПРЯМО НА ПРОДЕ (не через миграции) —
-- поэтому все ALTER'ы обёрнуты в guard по information_schema (на свежей
-- laptop-БД этих таблиц нет, миграция там просто ничего не делает).
-- Перед COMMIT сверь `\d promo_check_fingerprints` / `\d promo_check_detections`.
--
-- Типы: track_id там UUID; mix_id — TEXT (= dj_mixes.id).
--
-- ⚠️ ЭТО ТОЛЬКО QUEUE-СТОРОНА. Реальная инъекция watermark + запись
-- detections делает Python fingerprinter.py на VPS, которому нужен новый
-- флаг `--mix-id` (спека в docs/HANDOFF_TO_LAPTOP_2026-07-03.md §6). Без
-- Python-части эта миграция безопасна и бездейственна: mix-строки просто
-- висят status='pending'.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'promo_check_fingerprints') THEN
    ALTER TABLE promo_check_fingerprints ADD COLUMN IF NOT EXISTS mix_id TEXT;

    -- mix-строки имеют track_id = NULL — снимаем NOT NULL, если он стоит.
    BEGIN
      ALTER TABLE promo_check_fingerprints ALTER COLUMN track_id DROP NOT NULL;
    EXCEPTION WHEN others THEN
      -- уже nullable либо track_id участвует в PK — оставляем как есть,
      -- laptop разрулит по факту \d
      NULL;
    END;

    -- Партиал-уникальность для ON CONFLICT (mix_id) в /process-mix.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_check_fingerprints_mix
      ON promo_check_fingerprints (mix_id) WHERE mix_id IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'promo_check_detections') THEN
    -- Куда Python пишет эфирные детекты миксов (track_id там UUID и для
    -- mix-<uuid> не годится — отдельная TEXT-колонка).
    ALTER TABLE promo_check_detections ADD COLUMN IF NOT EXISTS mix_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_promo_check_detections_mix
      ON promo_check_detections (mix_id) WHERE mix_id IS NOT NULL;
  END IF;
END $$;
