-- 095_tracks_streaming_links.sql
--
-- Streaming-сервисы для каждого трека: Яндекс.Музыка, Spotify, Apple Music,
-- YouTube, ВКонтакте. Заполняет артист при загрузке/редактировании трека;
-- player на лендинге (секция «Новинки недели») рендерит кнопки перехода
-- если ссылки заполнены.
--
-- ⚠️ КОНВЕНЦИЯ: НЕТ BEGIN/COMMIT — runner оборачивает (см. CLAUDE.md
-- «Migration files: NO BEGIN/COMMIT inside the file»).
--
-- BUG context: insertTrack в db-typed.tsx уже маппил yandex_music_url /
-- spotify_url / apple_music_url / youtube_url, но миграции не было →
-- Supabase ORM silent-drop'ал unknown колонки. Эта миграция закрывает
-- silent-drop + добавляет недостающий vk_music_url.

ALTER TABLE tracks
  ADD COLUMN IF NOT EXISTS yandex_music_url  TEXT,
  ADD COLUMN IF NOT EXISTS spotify_url       TEXT,
  ADD COLUMN IF NOT EXISTS apple_music_url   TEXT,
  ADD COLUMN IF NOT EXISTS youtube_url       TEXT,
  ADD COLUMN IF NOT EXISTS vk_music_url      TEXT;

-- Длина URL > 2048 — почти всегда мусор / атака. CHECK предотвращает
-- ad-hoc джойны со statically-длинной строкой ("?utm=..." × N). Postgres
-- не поддерживает ADD CONSTRAINT IF NOT EXISTS — делаем через каталог.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tracks_streaming_url_len') THEN
    ALTER TABLE tracks
      ADD CONSTRAINT tracks_streaming_url_len CHECK (
            (yandex_music_url IS NULL OR length(yandex_music_url) <= 2048)
        AND (spotify_url      IS NULL OR length(spotify_url)      <= 2048)
        AND (apple_music_url  IS NULL OR length(apple_music_url)  <= 2048)
        AND (youtube_url      IS NULL OR length(youtube_url)      <= 2048)
        AND (vk_music_url     IS NULL OR length(vk_music_url)     <= 2048)
      );
  END IF;
END $$;
