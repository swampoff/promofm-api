-- 091_drop_orphan_tables.sql
-- DROP 10 verified-orphan tables. Laptop adversarial-verified 2026-05-30 across 5 lenses
-- (hidden-refs / external-writers / db-objects / frontend-repo / semantic-dormant):
-- each is empty, 0 code refs (src+migrations+scripts+frontend), cold (0 idx_scan, 0 writes/16d),
-- 0 incoming FK, 0 view/trigger/function dependency. 0 hard blockers across all lenses.
--
-- Superseded-by map:
--   email_verifications, password_resets -> verification_tokens (mig 070, vpsStoreToken)
--   user_subscriptions                   -> subscriptions
--   artist_subscription_plans            -> code const SUBSCRIPTION_PLANS (subscriptions-routes)
--   daily_analytics                      -> artist_analytics_cache
--   dj_bookings                          -> bookings
--   support_messages                     -> chat_sessions / chat_messages
--   pitching_campaigns                   -> pitching_submissions / pitching_playlists (dead alt-name)
--   dj_profiles_kv                       -> dj_profiles (native; '_kv' = legacy KV artifact)
--   event_venues                         -> venue_profiles / venue_locations (0 refs)
--
-- delete_user_account(): 8 of these appear in its user_tables[] cleanup array. The per-iteration
-- BEGIN/EXCEPTION WHEN undefined_table block makes a dropped table a safe no-op (loop continues,
-- no deletion-coverage gap). Array left intentionally broad (tolerant-by-design, protective if a
-- table is recreated). Not modified here.
--
-- HELD for human confirm (NOT dropped): feature_flags, playlist_tracks, press_releases,
-- radio_stream_stats -- semantic lens flagged dormant-but-possibly-intended scaffolds.

DROP TABLE IF EXISTS artist_subscription_plans;
DROP TABLE IF EXISTS daily_analytics;
DROP TABLE IF EXISTS dj_bookings;
DROP TABLE IF EXISTS email_verifications;
DROP TABLE IF EXISTS event_venues;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS pitching_campaigns;
DROP TABLE IF EXISTS support_messages;
DROP TABLE IF EXISTS user_subscriptions;
DROP TABLE IF EXISTS dj_profiles_kv;
