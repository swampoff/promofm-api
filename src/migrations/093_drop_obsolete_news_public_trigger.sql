-- 093_drop_obsolete_news_public_trigger.sql
-- KV-kill drift fix. trg_sync_news_public / sync_news_public_native() backfilled
-- news_public native columns FROM a 'data' jsonb blob during the KV->native migration.
-- news_public.data was dropped (migration done); the trigger's IF NEW.data ... now throws
-- 'record "new" has no field "data"' on EVERY insert/update -> upsertNewsPublic (db.tsx)
-- 500s -> news-agent posts ZERO news to Telegram since ~2026-03-29. news_public is fully
-- native and callers write native columns directly; the trigger is obsolete dead code.
DROP TRIGGER IF EXISTS trg_sync_news_public ON news_public;
DROP FUNCTION IF EXISTS sync_news_public_native();
