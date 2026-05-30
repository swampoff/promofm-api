-- 089_tracks_drop_data_column.sql
--
-- Финальный убийца KV anti-pattern на tracks. Migration 062 промоутнула
-- payment/upcoming/ai_* поля в native, но оставила `data jsonb` колонку
-- с "оставшимися" keys (description / music_composer / lyricist —
-- scalar text) и dead mirrors (aiCheck blob без readers, label-on-behalf
-- context).
--
-- Этот PR:
--   1. Promote 3 native text cols (description / music_composer / lyricist).
--   2. Promote label-on-behalf context (acting_for_artist_user_id +
--      label_id). actingForArtistId был дубликатом artist_id — drop'аем.
--   3. Backfill native ← data для всех 5 promoted polys + shoutout_url
--      (последний промоутнут в 062, но writers всё писали в data).
--   4. DROP COLUMN data — никаких остаточных keys, dead mirrors ушли.
--
-- Code changes:
--   - track-moderation-routes.tsx POST /upload — пишет 4 поля в native cols
--   - tracks-routes.tsx POST / — label-on-behalf пишет в native, drop redundant actingForArtistId
--   - ai-check.tsx — drop dead mirror write tracks.data->aiCheck (0 readers)
--   - Все остальные writers/readers tracks.data — audited, 0 hits после
--     code changes
--
-- ⚠️ КОНВЕНЦИЯ: НЕТ BEGIN/COMMIT — runner оборачивает.

-- ════════════════════════════════════════════════════════════════════
-- 1. ADD native cols
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE tracks
  -- Opt-in metadata из upload form (раньше в data jsonb)
  ADD COLUMN IF NOT EXISTS description       TEXT,
  ADD COLUMN IF NOT EXISTS music_composer    TEXT,
  ADD COLUMN IF NOT EXISTS lyricist          TEXT,
  -- Label-on-behalf context (раньше data.actingForArtistUserId / data.labelId).
  -- data.actingForArtistId = artist_id — drop redundant, не промоутим.
  ADD COLUMN IF NOT EXISTS acting_for_user_id  TEXT,
  ADD COLUMN IF NOT EXISTS label_id            TEXT,
  -- AI catalog display (раньше data.aiTool — legacy backfilled rows).
  -- 0 active writers, но legacy data hot rows должны видеть в /api/ai-charts.
  ADD COLUMN IF NOT EXISTS ai_tool            TEXT;

-- ════════════════════════════════════════════════════════════════════
-- 2. Backfill из data jsonb
-- ════════════════════════════════════════════════════════════════════
-- COALESCE — не перезаписываем native если уже есть. NULLIF на пустые строки.

UPDATE tracks SET
  description    = COALESCE(description,    NULLIF(data->>'description','')),
  music_composer = COALESCE(music_composer, NULLIF(data->>'music_composer','')),
  lyricist       = COALESCE(lyricist,       NULLIF(data->>'lyricist','')),
  shoutout_url   = COALESCE(shoutout_url,   NULLIF(data->>'shoutout_url','')),
  acting_for_user_id = COALESCE(acting_for_user_id, NULLIF(data->>'actingForArtistUserId','')),
  label_id           = COALESCE(label_id,           NULLIF(data->>'labelId','')),
  ai_tool            = COALESCE(ai_tool,            NULLIF(data->>'aiTool',''))
WHERE data IS NOT NULL
  AND jsonb_typeof(data) = 'object';

-- Legacy is_ai_generated backfill — migration 062 покрыла только
-- data->>'is_ai_track', но в hot data были legacy aliases (is_ai / isAi)
-- из старого upload pipeline. Подтягиваем их пока data ещё жива.

UPDATE tracks SET is_ai_generated = TRUE
 WHERE is_ai_generated = FALSE
   AND ((data->>'is_ai')::boolean = TRUE OR (data->>'isAi')::boolean = TRUE
        OR (data->>'aiTool') IS NOT NULL OR (data->>'aiSource') IS NOT NULL);

-- ════════════════════════════════════════════════════════════════════
-- 3. Indexes на новые native cols для hot-path queries
-- ════════════════════════════════════════════════════════════════════
-- Label-on-behalf фильтры (admin dashboard "tracks uploaded for roster
-- artists"):
CREATE INDEX IF NOT EXISTS idx_tracks_label_id
  ON tracks(label_id, created_at DESC)
  WHERE label_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- 4. DROP COLUMN data — финал KV kill на tracks
-- ════════════════════════════════════════════════════════════════════
-- ВСЕ известные writers code/migration audit'нуты:
--   - track-moderation-routes.tsx:313 (upload metadata) — переписан на native
--   - tracks-routes.tsx:106 (label-on-behalf) — переписан на native
--   - ai-check.tsx:154 (aiCheck blob) — dead mirror удалён (0 readers)
--   - artist-profile-routes.tsx (removed `data: { ...track.data, ... }`)
--   - landing/charts/cron queries — все используют native cols
--
-- Если в проде остались НЕЗАДОКУМЕНТИРОВАННЫЕ keys в data jsonb они
-- теряются. Backup pg_dump обязателен (см. MANUAL DEPLOY STEPS).

ALTER TABLE tracks DROP COLUMN IF EXISTS data;
