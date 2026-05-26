-- 032_pitching_pipeline_complete.sql
-- См. описание выше — добавляет недостающие колонки + создаёт таблицы
-- + засеивает каталог плейлистов (4 платформы × 5 = 20). Идемпотентно.

BEGIN;

ALTER TABLE pitching_submissions
  ADD COLUMN IF NOT EXISTS category            TEXT,
  ADD COLUMN IF NOT EXISTS price_rub           INTEGER,
  ADD COLUMN IF NOT EXISTS payment_session_id  TEXT;

UPDATE pitching_submissions
   SET category = submission_type
 WHERE category IS NULL AND submission_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pitching_submissions_category
  ON pitching_submissions(category);
CREATE INDEX IF NOT EXISTS idx_pitching_submissions_payment
  ON pitching_submissions(payment_session_id);

ALTER TABLE pitching_playlists
  ADD COLUMN IF NOT EXISTS price_rub INTEGER;

UPDATE pitching_playlists
   SET price_rub = COALESCE(submission_fee, 15000)
 WHERE price_rub IS NULL;

CREATE TABLE IF NOT EXISTS pitching_influencers (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT         NOT NULL,
  platform      TEXT         NOT NULL,
  followers     BIGINT       NOT NULL DEFAULT 0,
  genre         TEXT,
  region        TEXT,
  description   TEXT,
  contact       TEXT,
  price_rub     INTEGER      NOT NULL DEFAULT 10000,
  status        TEXT         NOT NULL DEFAULT 'active',
  created_by    TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pitching_influencers_status
  ON pitching_influencers(status);
CREATE INDEX IF NOT EXISTS idx_pitching_influencers_platform
  ON pitching_influencers(platform);

CREATE TABLE IF NOT EXISTS pitching_media_outlets (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT         NOT NULL,
  website           TEXT,
  monthly_audience  BIGINT       NOT NULL DEFAULT 0,
  genre             TEXT,
  region            TEXT,
  description       TEXT,
  contact           TEXT,
  price_rub         INTEGER      NOT NULL DEFAULT 8000,
  status            TEXT         NOT NULL DEFAULT 'active',
  created_by        TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pitching_media_outlets_status
  ON pitching_media_outlets(status);

-- Seed pitching_playlists — только если таблица пустая.
-- Защита от повторного применения после ручного редактирования каталога.
INSERT INTO pitching_playlists (name, platform, followers, genre, region, description, curator_contact, status, price_rub)
SELECT v.name, v.platform, v.followers, v.genre, v.region, v.description, v.contact, 'active', v.price
FROM (VALUES
  ('Поп Хиты',              'Яндекс Музыка', 280000::bigint, 'Pop'::text,         'Россия', 'Главные поп-хиты на Яндекс Музыке',          'editorial@music.yandex.ru', 15000),
  ('Электроника',           'Яндекс Музыка', 145000::bigint, 'Electronic',        'Россия', 'Свежая электроника, House, Techno, DnB',    'editorial@music.yandex.ru', 15000),
  ('Русский Рэп',           'Яндекс Музыка', 320000::bigint, 'Hip-Hop',           'Россия', 'Главный плейлист русского рэпа',             'editorial@music.yandex.ru', 18000),
  ('Новинки Недели',        'Яндекс Музыка', 510000::bigint, NULL,                'Россия', 'Свежие релизы каждую пятницу',               'editorial@music.yandex.ru', 20000),
  ('Чилл-аут',              'Яндекс Музыка',  85000::bigint, 'Chillout',          'Россия', 'Расслабляющая музыка на каждый день',        'editorial@music.yandex.ru', 12000),
  ('Открытие',              'VK Музыка',     420000::bigint, NULL,                'Россия', 'Топ редакторских находок ВКонтакте',        'music@vk.com',              16000),
  ('Хиты ВК',               'VK Музыка',     680000::bigint, 'Pop',               'Россия', 'Главные хиты площадки',                      'music@vk.com',              18000),
  ('Электронные Волны',     'VK Музыка',     195000::bigint, 'Electronic',        'Россия', 'Электронные треки от российских артистов',   'music@vk.com',              14000),
  ('Инди ВКонтакте',        'VK Музыка',     112000::bigint, 'Indie',             'Россия', 'Независимые артисты и нестандартные релизы', 'music@vk.com',              12000),
  ('Клубный Чарт',          'VK Музыка',     230000::bigint, 'Dance',             'Россия', 'Танцпол ВКонтакте — House, Techno, EDM',     'music@vk.com',              14000),
  ('Russia Hot',            'Spotify',       540000::bigint, 'Pop',               'Global', 'Самое горячее из России на Spotify',         'editorial@spotify.com',     25000),
  ('Mint Russia',           'Spotify',       180000::bigint, 'Electronic',        'Global', 'Свежая электроника от RU/CIS артистов',      'editorial@spotify.com',     20000),
  ('New Music Friday RU',   'Spotify',       290000::bigint, NULL,                'Global', 'Все главные новинки пятницы',                'editorial@spotify.com',     22000),
  ('Russian Chill',         'Spotify',        95000::bigint, 'Chillout',          'Global', 'Спокойная музыка от русских артистов',       'editorial@spotify.com',     18000),
  ('Russian Rap',           'Spotify',       310000::bigint, 'Hip-Hop',           'Global', 'Главный рэп-плейлист на Spotify',            'editorial@spotify.com',     22000),
  ('Хиты Звука',            'Звук',          175000::bigint, 'Pop',               'Россия', 'Главные хиты на Звуке',                      'editorial@zvuk.com',        14000),
  ('Электроника Звука',     'Звук',           88000::bigint, 'Electronic',        'Россия', 'Электронные треки на Звуке',                 'editorial@zvuk.com',        12000),
  ('Открытия Звука',        'Звук',          134000::bigint, NULL,                'Россия', 'Свежие находки редакции',                    'editorial@zvuk.com',        13000),
  ('Инди Звук',             'Звук',           62000::bigint, 'Indie',             'Россия', 'Независимые артисты на Звуке',               'editorial@zvuk.com',        10000),
  ('Ночной Эфир',           'Звук',           71000::bigint, 'Chillout',          'Россия', 'Музыка для ночных поездок',                  'editorial@zvuk.com',        10000)
) AS v(name, platform, followers, genre, region, description, contact, price)
WHERE NOT EXISTS (SELECT 1 FROM pitching_playlists LIMIT 1);

COMMIT;
