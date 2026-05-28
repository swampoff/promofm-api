-- DROP 3 orphan KV tables — promo_air_dj_* cluster.
--
-- Все три таблицы — `(pk, data jsonb)` KV schema без callers в коде:
--   promo_air_dj_scripts   — 0 callers (verified via grep)
--   promo_air_dj_settings  — 0 callers
--   promo_air_dj_queue     — 0 callers
--
-- Originally declared в src/db.tsx как jsonbStore wrappers; после
-- PR #90 (helper deletion) переведены на makeJsonbKeyStore — но
-- ни один handler / route file / context их не импортирует.
-- Backend Explore audit (post-#87/#88) явно flagged их orphans.
--
-- Feature "promo air DJ" не реализована — таблицы залипли на проде
-- от ранней спекулятивной попытки. DROP TABLE — единственно
-- правильное действие per CLAUDE.md "FORBIDDEN: создавать новые
-- KV-store таблицы; ДЛЯ существующих с багами: мигрировать".
-- Здесь bug = таблица существует но не используется → DROP.
--
-- Companion code change: src/db.tsx удалены 3 export const declaration.
--
-- Pre-flight (laptop): подтвердить 0 rows во всех 3 таблицах перед
-- DROP. Если есть data — abort и сообщить cloud для перепланирования.

DROP TABLE IF EXISTS promo_air_dj_scripts;
DROP TABLE IF EXISTS promo_air_dj_settings;
DROP TABLE IF EXISTS promo_air_dj_queue;
