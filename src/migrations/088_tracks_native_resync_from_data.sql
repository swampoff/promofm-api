-- 088_tracks_native_resync_from_data.sql
--
-- Resync native cols from data jsonb для tracks, одобренных после
-- migration 062. Incident: manageTrackModeration handler писал
-- payment_amount / requires_payment / first_track_free_applied /
-- payment_completed / paid_at / upcoming_until / approved_for_release_at
-- ТОЛЬКО в data jsonb. resolveTrackPublicationPrice читает native cols
-- → видел FALSE/NULL → каждый трек одобрялся как «первый бесплатный»
-- → straight to 'upcoming' с is_hidden=false → визуально опубликован.
--
-- Этот backfill идентичен step 2 из migration 062, но повторно для
-- треков, у которых native cols отстали от data. Идемпотентен —
-- использует COALESCE и UPDATE only WHERE native ещё пустой (или
-- младше data). Безопасно re-применять.
--
-- Code fix отдельно в track-moderation-routes.tsx (dual-write native +
-- data в manageTrackModeration approve flow + batch). После apply
-- этой миграции + deploy кода drift не возобновится.
--
-- ⚠️ КОНВЕНЦИЯ: НЕТ BEGIN/COMMIT — runner оборачивает.

-- ════════════════════════════════════════════════════════════════════
-- 1. Resync payment_completed (was: only in data->>'payment_completed')
-- ════════════════════════════════════════════════════════════════════
-- Если native FALSE, но data говорит TRUE → подтянуть.

UPDATE tracks
   SET payment_completed = TRUE
 WHERE payment_completed = FALSE
   AND COALESCE((data->>'payment_completed')::boolean, FALSE) = TRUE;

-- ════════════════════════════════════════════════════════════════════
-- 2. Resync first_track_free_applied (главный виновник auto-publish бага)
-- ════════════════════════════════════════════════════════════════════
-- Без этого resolveTrackPublicationPrice возвращает 0 (free) для всех
-- последующих треков артиста.

UPDATE tracks
   SET first_track_free_applied = TRUE
 WHERE first_track_free_applied = FALSE
   AND COALESCE((data->>'first_track_free_applied')::boolean, FALSE) = TRUE;

-- ════════════════════════════════════════════════════════════════════
-- 3. Resync payment_amount
-- ════════════════════════════════════════════════════════════════════
-- Если native NULL и data has value → подтянуть. NULLIF предохраняет
-- от пустых строк.

UPDATE tracks
   SET payment_amount = NULLIF(data->>'payment_amount','')::numeric
 WHERE payment_amount IS NULL
   AND data->>'payment_amount' IS NOT NULL
   AND data->>'payment_amount' <> '';

-- ════════════════════════════════════════════════════════════════════
-- 4. Resync requires_payment
-- ════════════════════════════════════════════════════════════════════

UPDATE tracks
   SET requires_payment = (data->>'requires_payment')::boolean
 WHERE requires_payment = TRUE  -- native default
   AND data->>'requires_payment' IS NOT NULL
   AND (data->>'requires_payment')::boolean = FALSE;

-- ════════════════════════════════════════════════════════════════════
-- 5. Resync paid_at
-- ════════════════════════════════════════════════════════════════════

UPDATE tracks
   SET paid_at = NULLIF(data->>'paid_at','')::timestamptz
 WHERE paid_at IS NULL
   AND data->>'paid_at' IS NOT NULL
   AND data->>'paid_at' <> '';

-- ════════════════════════════════════════════════════════════════════
-- 6. Resync upcoming_until / approved_for_release_at / published_at
-- ════════════════════════════════════════════════════════════════════
-- Cron promote-upcoming исторически читал track.data?.upcoming_until,
-- а /approve-paid пишет в native — если ветви разъехались, ресинкнем
-- в native чтобы будущие SQL queries (landing /releases/upcoming)
-- видели правильные timestamps.

UPDATE tracks
   SET upcoming_until = NULLIF(data->>'upcoming_until','')::timestamptz
 WHERE upcoming_until IS NULL
   AND data->>'upcoming_until' IS NOT NULL
   AND data->>'upcoming_until' <> '';

UPDATE tracks
   SET approved_for_release_at = NULLIF(data->>'approved_for_release_at','')::timestamptz
 WHERE approved_for_release_at IS NULL
   AND data->>'approved_for_release_at' IS NOT NULL
   AND data->>'approved_for_release_at' <> '';

UPDATE tracks
   SET published_at = NULLIF(data->>'published_at','')::timestamptz
 WHERE published_at IS NULL
   AND data->>'published_at' IS NOT NULL
   AND data->>'published_at' <> '';
