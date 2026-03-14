-- Mass fix: DROP NOT NULL and change UUID→TEXT for remaining failed tables

-- cross_cabinet_notifications (18 rows, KV-format data)
ALTER TABLE cross_cabinet_notifications ALTER COLUMN recipient_id DROP NOT NULL;
ALTER TABLE cross_cabinet_notifications ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE cross_cabinet_notifications ALTER COLUMN message DROP NOT NULL;
ALTER TABLE cross_cabinet_notifications ALTER COLUMN type DROP NOT NULL;
ALTER TABLE cross_cabinet_notifications ALTER COLUMN sender_id TYPE TEXT;
ALTER TABLE cross_cabinet_notifications ALTER COLUMN recipient_id TYPE TEXT;

-- chart_sources (16 rows, text IDs)
ALTER TABLE chart_sources ALTER COLUMN name DROP NOT NULL;
ALTER TABLE chart_sources ALTER COLUMN source_type DROP NOT NULL;

-- producer_messages (15 rows, KV data)
ALTER TABLE producer_messages ALTER COLUMN recipient_id DROP NOT NULL;
ALTER TABLE producer_messages ALTER COLUMN content DROP NOT NULL;
ALTER TABLE producer_messages ALTER COLUMN sender_id TYPE TEXT;
ALTER TABLE producer_messages ALTER COLUMN recipient_id TYPE TEXT;

-- promo_guide_data: PK id is NULL in Supabase data (KV format)
-- Need to drop PK, change to allow nulls, re-add
ALTER TABLE promo_guide_data DROP CONSTRAINT IF EXISTS promo_guide_data_pkey;
ALTER TABLE promo_guide_data ALTER COLUMN id DROP NOT NULL;

-- platform_stats: PK id is NULL in Supabase data
ALTER TABLE platform_stats DROP CONSTRAINT IF EXISTS platform_stats_pkey;
ALTER TABLE platform_stats ALTER COLUMN id DROP NOT NULL;

-- service_orders (5 rows)
ALTER TABLE service_orders ALTER COLUMN producer_id DROP NOT NULL;
ALTER TABLE service_orders ALTER COLUMN status DROP NOT NULL;
ALTER TABLE service_orders ALTER COLUMN client_id TYPE TEXT;
ALTER TABLE service_orders ALTER COLUMN producer_id TYPE TEXT;

-- coin_packages (5 rows, text IDs like "starter","basic")
ALTER TABLE coin_packages ALTER COLUMN coins DROP NOT NULL;
ALTER TABLE coin_packages ALTER COLUMN price DROP NOT NULL;
ALTER TABLE coin_packages ALTER COLUMN name DROP NOT NULL;

-- venue_profiles (4 rows, text IDs like "venue-1")
ALTER TABLE venue_profiles ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE venue_profiles ALTER COLUMN user_id TYPE TEXT;

-- dm_messages (4 rows)
ALTER TABLE dm_messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE dm_messages ALTER COLUMN content DROP NOT NULL;
ALTER TABLE dm_messages ALTER COLUMN sender_id TYPE TEXT;
ALTER TABLE dm_messages ALTER COLUMN conversation_id TYPE TEXT;

-- media_contacts (3 rows, has tags text[])
-- Change tags from text[] to jsonb since Supabase sends JSON arrays
ALTER TABLE media_contacts ALTER COLUMN tags TYPE JSONB USING tags::text::jsonb;

-- track_analytics: track_id is also UUID but data has "test-track"
ALTER TABLE track_analytics ALTER COLUMN track_id TYPE TEXT;
