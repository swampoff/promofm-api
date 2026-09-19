-- DJ-миксы недели в пакете «Новинки недели».
--
-- friday.js с самого начала пытается дописать миксы в weekly_releases.mix_ids,
-- но колонки не существовало: каждый пятничный прогон печатал
-- «mix attach skipped: column "mix_ids" does not exist» и молча шёл дальше,
-- поэтому миксы не попадали в выпуск ни разу. Тип текстовый, а не uuid[],
-- потому что скрипт передаёт параметр как $3::text[].
ALTER TABLE weekly_releases ADD COLUMN IF NOT EXISTS mix_ids text[];

COMMENT ON COLUMN weekly_releases.mix_ids IS
  'ID опубликованных DJ-миксов недели (до 5), дописывает friday.js scan';
