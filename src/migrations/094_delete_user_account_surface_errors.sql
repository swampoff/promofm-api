-- 094_delete_user_account_surface_errors.sql
--
-- Audit INC-3 (2026-05-31): delete_user_account swallowed ALL per-table
-- errors via `EXCEPTION WHEN OTHERS THEN NULL`. If a FK constraint (or RLS
-- denial, or any real failure) blocked a PII delete, the row stayed, NO
-- error surfaced, and the `users` row was still deleted → orphan PII.
-- GDPR/152-ФЗ regression: пользователь "удалён", PII висит в чьих-то
-- FK-связанных таблицах.
--
-- Fix: distinguish EXPECTED skips (table dropped in mig 091 / column
-- absent — SQLSTATE 42P01 undefined_table, 42703 undefined_column) from
-- REAL failures (FK violation, RLS, etc). Real failures are collected
-- into a `_errors` jsonb object returned to the caller. The route
-- (profile-routes.tsx) gates success on `_errors` being empty (hardened
-- in the same PR) so a partial deletion can NEVER report false success.
--
-- ⚠️ КОНВЕНЦИЯ: НЕТ BEGIN/COMMIT — runner оборачивает.

CREATE OR REPLACE FUNCTION public.delete_user_account(p_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  deleted_counts JSONB := '{}'::JSONB;
  errors JSONB := '{}'::JSONB;
  tbl TEXT;
  cnt INTEGER;
  err_state TEXT;
  err_msg TEXT;
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
  FOREACH tbl IN ARRAY user_tables
  LOOP
    BEGIN
      EXECUTE format('DELETE FROM %I WHERE user_id::text = $1', tbl) USING p_user_id;
      GET DIAGNOSTICS cnt = ROW_COUNT;
      IF cnt > 0 THEN
        deleted_counts := deleted_counts || jsonb_build_object(tbl, cnt);
      END IF;
    EXCEPTION
      WHEN undefined_table OR undefined_column THEN
        -- Таблица/колонка отсутствует (например дропнута в mig 091, но
        -- всё ещё в массиве). Это ОЖИДАЕМО, не ошибка удаления PII.
        NULL;
      WHEN OTHERS THEN
        -- РЕАЛЬНАЯ ошибка (FK violation, RLS denial, etc) — PII row не
        -- удалён. Записываем в errors чтобы route 500'нул и НЕ сообщил
        -- false success.
        GET STACKED DIAGNOSTICS err_state = RETURNED_SQLSTATE, err_msg = MESSAGE_TEXT;
        errors := errors || jsonb_build_object(tbl, err_state || ': ' || err_msg);
    END;
  END LOOP;

  -- DM messages where user is sender (sender_id is text)
  BEGIN
    DELETE FROM dm_messages WHERE sender_id = p_user_id;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    IF cnt > 0 THEN
      deleted_counts := deleted_counts || jsonb_build_object('dm_messages_sent', cnt);
    END IF;
  EXCEPTION
    WHEN undefined_table OR undefined_column THEN NULL;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS err_state = RETURNED_SQLSTATE, err_msg = MESSAGE_TEXT;
      errors := errors || jsonb_build_object('dm_messages', err_state || ': ' || err_msg);
  END;

  -- Anonymize audit_logs (keep row for compliance, remove PII link).
  BEGIN
    UPDATE audit_logs SET user_id = NULL, details = '{"deleted": true}'
    WHERE user_id::text = p_user_id;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    IF cnt > 0 THEN
      deleted_counts := deleted_counts || jsonb_build_object('audit_logs_anonymized', cnt);
    END IF;
  EXCEPTION
    WHEN undefined_table OR undefined_column THEN NULL;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS err_state = RETURNED_SQLSTATE, err_msg = MESSAGE_TEXT;
      errors := errors || jsonb_build_object('audit_logs', err_state || ': ' || err_msg);
  END;

  -- Anonymize security_events (best-effort; column/table may not exist)
  BEGIN
    UPDATE security_events SET user_id = 'DELETED'
    WHERE user_id::text = p_user_id;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    IF cnt > 0 THEN
      deleted_counts := deleted_counts || jsonb_build_object('security_events_anonymized', cnt);
    END IF;
  EXCEPTION
    WHEN undefined_table OR undefined_column THEN NULL;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS err_state = RETURNED_SQLSTATE, err_msg = MESSAGE_TEXT;
      errors := errors || jsonb_build_object('security_events', err_state || ': ' || err_msg);
  END;

  -- Finally delete the user record itself (users.id is uuid). A failure
  -- here is recorded too — the route already gates on users===1, but now
  -- the reason surfaces.
  BEGIN
    DELETE FROM users WHERE id::text = p_user_id;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    deleted_counts := deleted_counts || jsonb_build_object('users', cnt);
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS err_state = RETURNED_SQLSTATE, err_msg = MESSAGE_TEXT;
      errors := errors || jsonb_build_object('users', err_state || ': ' || err_msg);
  END;

  -- Surface collected real-failures under a reserved key. Empty {} when
  -- everything succeeded.
  IF errors <> '{}'::jsonb THEN
    deleted_counts := deleted_counts || jsonb_build_object('_errors', errors);
  END IF;

  RETURN deleted_counts;
END;
$function$;
