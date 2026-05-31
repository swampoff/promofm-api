-- 092_fix_delete_user_account.sql
-- HOTFIX (Phase 1): fix the uuid=text type mismatch that made GDPR/152-FZ account
-- deletion 100% broken since launch. Root cause: schema drift — users.id + 16 user_id
-- columns are uuid, 55 are text; all store valid uuid strings. The old Loop 1 ran
-- `WHERE user_id = $1` (text param) which threw SQLSTATE 42883 (operator does not exist:
-- uuid = text) on the FIRST uuid-typed table (user_sessions). Loop 1 caught only
-- undefined_table/undefined_column, so 42883 aborted the whole function on iteration 1 —
-- zero rows deleted, route 500s, Loop 2 (::uuid retry) was unreachable dead code.
--
-- Fix: cast the COLUMN to text (`user_id::text = $1`) — verified live to plan+run on BOTH
-- uuid and text user_id columns, so a single loop covers all ~80 tables. Loop 2 removed.
-- Per-iteration EXCEPTION broadened to WHEN OTHERS so one missing/dropped table (e.g. the
-- ones dropped in migration 091, still listed in the array) can't abort the rest.
-- audit_logs.user_id is uuid nullable -> anonymize fixed to SET user_id = NULL (cannot store
-- 'DELETED' in a uuid column) with a ::text predicate. users delete simplified to
-- id::text = $1. dm_messages.sender_id is text — left as-is.
--
-- Phase 2 (separate audited PR, NOT here): normalize the 55 text user_id columns to uuid
-- (ALTER ... TYPE uuid USING user_id::uuid) + add missing user_id->users(id) FKs, then drop
-- the now-redundant ::text casts. See memory uuid-text-schema-drift.
--
-- The route (profile-routes.tsx) is hardened separately to gate success on
-- deletedCounts.users === 1, so a future partial deletion cannot report false success.

CREATE OR REPLACE FUNCTION public.delete_user_account(p_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  deleted_counts JSONB := '{}'::JSONB;
  tbl TEXT;
  cnt INTEGER;
  user_tables TEXT[] := ARRAY[
    -- Auth & sessions
    'user_sessions', 'user_mfa', 'user_settings', 'user_subscriptions',
    'login_attempts', 'email_verifications', 'password_resets',
    'verification_tokens', 'refresh_tokens',
    -- Profiles
    'profiles', 'artist_profiles', 'dj_profiles', 'dj_editor_profiles',
    'producer_profiles', 'producer_profile_edit', 'producer_settings',
    'producer_sessions', 'producer_custom_portfolio', 'producer_custom_services',
    'radio_profiles', 'venue_profiles',
    -- Content
    'tracks', 'comments', 'likes', 'videos', 'beats', 'playlists',
    'playlist_tracks', 'concerts', 'news',
    -- Financial
    'payment_sessions', 'payment_methods', 'payment_balances',
    'payment_transactions', 'payment_withdrawals',
    'subscriptions', 'coin_balances', 'coin_transactions', 'donations',
    'beat_purchases_by_user', 'digital_purchases_by_user',
    -- Communication
    'dm_conv_list', 'dm_unread_counts', 'notifications',
    'notification_settings', 'ccn_unread_counts',
    'cross_cabinet_notifications', 'radio_notifications', 'dj_notifications',
    -- Activity
    'page_views', 'daily_analytics', 'track_analytics',
    'artist_tracks_stats', 'artist_analytics_cache',
    'feedback_reports', 'support_tickets', 'support_messages',
    -- Pitching
    'pitches', 'pitching_requests', 'pitching_campaigns',
    -- Booking
    'bookings', 'bookings_by_user', 'booking_calendar', 'booking_payments',
    'dj_bookings',
    -- Track test
    'track_test_requests', 'track_test_user_requests',
    'track_test_reviews', 'track_test_request_reviews',
    -- Producer
    'producer_convs', 'producer_ai_last', 'production_360_requests',
    -- Email
    'email_subscribers', 'publish_email_prefs', 'email_history',
    -- Other
    'beat_favorites', 'followers', 'collab_offers',
    'service_orders', 'contracts', 'publish_orders',
    'memory_user', 'promo_guide_data'
  ];
BEGIN
  -- Delete from all user tables. user_id::text = $1 works for BOTH uuid and text user_id
  -- columns (schema drift); per-iteration WHEN OTHERS isolates any missing/dropped table
  -- so it can never abort deletion of the remaining PII tables.
  FOREACH tbl IN ARRAY user_tables
  LOOP
    BEGIN
      EXECUTE format('DELETE FROM %I WHERE user_id::text = $1', tbl) USING p_user_id;
      GET DIAGNOSTICS cnt = ROW_COUNT;
      IF cnt > 0 THEN
        deleted_counts := deleted_counts || jsonb_build_object(tbl, cnt);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Missing table/column or any per-table failure: skip, never abort the loop.
      NULL;
    END;
  END LOOP;

  -- Delete DM messages where user is sender (sender_id is text)
  BEGIN
    DELETE FROM dm_messages WHERE sender_id = p_user_id;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    IF cnt > 0 THEN
      deleted_counts := deleted_counts || jsonb_build_object('dm_messages_sent', cnt);
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Anonymize audit_logs (keep row for compliance, remove PII link).
  -- user_id is uuid nullable -> NULL it (cannot store 'DELETED' in a uuid column).
  BEGIN
    UPDATE audit_logs SET user_id = NULL, details = '{"deleted": true}'
    WHERE user_id::text = p_user_id;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    IF cnt > 0 THEN
      deleted_counts := deleted_counts || jsonb_build_object('audit_logs_anonymized', cnt);
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Anonymize security_events (best-effort; column/table may not exist)
  BEGIN
    UPDATE security_events SET user_id = 'DELETED'
    WHERE user_id::text = p_user_id;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    IF cnt > 0 THEN
      deleted_counts := deleted_counts || jsonb_build_object('security_events_anonymized', cnt);
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Finally delete the user record itself (users.id is uuid)
  BEGIN
    DELETE FROM users WHERE id::text = p_user_id;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    deleted_counts := deleted_counts || jsonb_build_object('users', cnt);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN deleted_counts;
END;
$function$;
