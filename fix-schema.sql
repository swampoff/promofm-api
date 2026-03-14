-- Fix schema mismatches for data migration

-- 1. UUID → TEXT for tables with text-style IDs
ALTER TABLE cross_cabinet_notifications ALTER COLUMN id TYPE TEXT;
ALTER TABLE chart_sources ALTER COLUMN id TYPE TEXT;
ALTER TABLE coin_packages ALTER COLUMN id TYPE TEXT;
ALTER TABLE venue_profiles ALTER COLUMN id TYPE TEXT;
ALTER TABLE track_analytics ALTER COLUMN id TYPE TEXT;
ALTER TABLE platform_stats ALTER COLUMN id TYPE TEXT;
ALTER TABLE promo_guide_data ALTER COLUMN id TYPE TEXT;

-- 2. DROP NOT NULL constraints for columns with NULL data
ALTER TABLE producer_messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE service_orders ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE track_test_requests ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE dm_messages ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE dj_reviews ALTER COLUMN rating DROP NOT NULL;
ALTER TABLE dj_mixes ALTER COLUMN title DROP NOT NULL;
ALTER TABLE dj_events ALTER COLUMN title DROP NOT NULL;
ALTER TABLE system_config ALTER COLUMN value DROP NOT NULL;

-- 3. Users: allow NULL password_hash (Supabase users don't have local passwords)
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- 4. promo_guide_data: allow NULL id (Supabase data has NULL ids)
ALTER TABLE promo_guide_data ALTER COLUMN id DROP NOT NULL;
