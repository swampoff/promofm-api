#!/usr/bin/env python3
"""Migrate data from Supabase to VPS PostgreSQL.
Fetches via Supabase REST API (service_role key bypasses RLS),
inserts into local PostgreSQL via psql.
"""
import json, urllib.request, subprocess, sys, time

SUPABASE_URL = "https://qzpmiiqfwkcnrhvubdgt.supabase.co/rest/v1"
SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF6cG1paXFmd2tjbnJodnViZGd0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTMzNTMzMywiZXhwIjoyMDg0OTExMzMzfQ.ik9Us-02grJpARn_f4bhEjRt7Afy753TS-DhynxleK8"
DB_URL = "postgresql://promofm_app:PromoFM2024dbSecure@localhost:5432/promofm"

# Tables to migrate (ordered by priority/size)
TABLES = [
    "tracks", "artists", "email_subscribers", "pitching_venues",
    "kv_store", "pitching_radio", "videos", "pitching_tv",
    "concert_agent_data", "pitching_media", "beats", "digital_goods",
    "notifications_kv", "producer_services", "concerts_kv", "news_public",
    "curator_reports", "artist_profiles_kv", "cross_cabinet_notifications",
    "system_config", "dj_profiles_kv", "profiles", "chart_sources",
    "producer_messages", "coin_transactions_kv", "news_kv", "subscriptions_kv",
    "bookings_by_user", "promo_guide_data", "tracks_kv",
    "producer_profiles_kv", "artist_analytics_cache", "bookings", "email_data",
    "dm_conv_list", "platform_stats", "service_orders", "accounting_data",
    "radio_profiles_kv", "artist_subscription_plans", "coin_packages",
    "track_test_requests", "radio_venue_requests", "subscription_plans",
    "ticket_providers", "publish_orders", "radio_ad_slot_index",
    "radio_artist_requests", "radio_notifications_kv", "venue_profiles",
    "dm_conversations", "dm_messages", "venue_ad_campaigns",
    "collab_offers_by_artist", "media_contacts", "event_venues",
    "venue_playlists", "dj_reviews", "dj_mixes", "content_orders_by_status",
    "notification_settings_kv", "dj_marketplace_index", "venue_orders_index",
    "track_test_all_requests", "track_test_experts", "payout_requests",
    "collab_messages", "collab_offers_by_producer", "user_wallets",
    "news_pipeline", "ccn_unread_counts", "coin_balances",
    "artist_tracks_stats", "track_analytics", "agent_queue",
    "transactions", "payment_methods", "user_settings_kv", "contracts",
    "dj_events", "producer_settings", "chart_aggregation", "users",
    "dm_unread_counts",
]

BATCH_SIZE = 500

def fetch_rows(table, limit=500, offset=0):
    """Fetch rows from Supabase REST API."""
    url = f"{SUPABASE_URL}/{table}?select=*&limit={limit}&offset={offset}&order=created_at.asc.nullsfirst"
    req = urllib.request.Request(url)
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    req.add_header("Accept", "application/json")
    req.add_header("Prefer", "count=exact")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            return data
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        print(f"  HTTP {e.code}: {body[:200]}")
        # Try without ordering (some tables lack created_at)
        if "created_at" in url:
            url2 = f"{SUPABASE_URL}/{table}?select=*&limit={limit}&offset={offset}"
            req2 = urllib.request.Request(url2)
            req2.add_header("apikey", SERVICE_KEY)
            req2.add_header("Authorization", f"Bearer {SERVICE_KEY}")
            req2.add_header("Accept", "application/json")
            try:
                with urllib.request.urlopen(req2, timeout=30) as resp2:
                    return json.loads(resp2.read())
            except Exception as e2:
                print(f"  Retry failed: {e2}")
                return []
        return []
    except Exception as e:
        print(f"  Error: {e}")
        return []

def escape_sql(val):
    """Escape a Python value for SQL INSERT."""
    if val is None:
        return "NULL"
    if isinstance(val, bool):
        return "TRUE" if val else "FALSE"
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, (dict, list)):
        j = json.dumps(val, ensure_ascii=False)
        j = j.replace("'", "''")
        j = j.replace("\\", "\\\\")
        return f"'{j}'::jsonb"
    s = str(val)
    s = s.replace("'", "''")
    s = s.replace("\\", "\\\\")
    return f"'{s}'"

def generate_sql(table, rows):
    """Generate INSERT SQL from rows."""
    if not rows:
        return ""
    cols = list(rows[0].keys())
    col_list = ", ".join(f'"{c}"' for c in cols)
    stmts = []
    for row in rows:
        vals = ", ".join(escape_sql(row.get(c)) for c in cols)
        stmts.append(f"INSERT INTO {table} ({col_list}) VALUES ({vals}) ON CONFLICT DO NOTHING;")
    return "\n".join(stmts)

def execute_sql(sql):
    """Execute SQL via psql."""
    proc = subprocess.run(
        ["psql", DB_URL],
        input=sql,
        capture_output=True,
        text=True,
        timeout=120
    )
    if proc.returncode != 0:
        # Extract meaningful error
        err = proc.stderr.strip()
        if err:
            # Show first error only
            lines = err.split("\n")
            for line in lines:
                if "ERROR" in line:
                    return False, line[:200]
            return False, lines[0][:200]
    return True, ""

def migrate_table(table):
    """Migrate a single table."""
    print(f"\n{'='*50}")
    print(f"Migrating: {table}")
    offset = 0
    total = 0
    errors = 0

    while True:
        rows = fetch_rows(table, BATCH_SIZE, offset)
        if not rows:
            break

        sql = generate_sql(table, rows)
        if sql:
            ok, err = execute_sql(sql)
            if not ok:
                # Try row by row
                print(f"  Batch error at offset {offset}: {err}")
                print(f"  Falling back to row-by-row insert...")
                for i, row in enumerate(rows):
                    row_sql = generate_sql(table, [row])
                    rok, rerr = execute_sql(row_sql)
                    if rok:
                        total += 1
                    else:
                        errors += 1
                        if errors <= 3:
                            print(f"    Row {offset+i} error: {rerr}")
            else:
                total += len(rows)

        if len(rows) < BATCH_SIZE:
            break
        offset += BATCH_SIZE
        time.sleep(0.1)  # Be gentle with Supabase API

    status = "OK" if errors == 0 else f"PARTIAL ({errors} errors)"
    print(f"  Result: {total} rows imported [{status}]")
    return total, errors

def main():
    tables = TABLES
    if len(sys.argv) > 1:
        tables = sys.argv[1:]

    print("=" * 60)
    print("PromoFM Data Migration: Supabase → VPS PostgreSQL")
    print("=" * 60)

    # Test DB connection
    ok, err = execute_sql("SELECT 1;")
    if not ok:
        print(f"DB connection failed: {err}")
        sys.exit(1)
    print("DB connection: OK")

    # Test Supabase API
    test = fetch_rows("system_config", 1, 0)
    if test is None:
        print("Supabase API: FAILED")
        sys.exit(1)
    print(f"Supabase API: OK (test returned {len(test)} rows)")

    results = {}
    total_rows = 0
    total_errors = 0

    for table in tables:
        rows, errs = migrate_table(table)
        results[table] = (rows, errs)
        total_rows += rows
        total_errors += errs

    print("\n" + "=" * 60)
    print("MIGRATION SUMMARY")
    print("=" * 60)
    for table, (rows, errs) in results.items():
        if rows > 0 or errs > 0:
            status = "OK" if errs == 0 else f"ERRORS: {errs}"
            print(f"  {table:40s} {rows:6d} rows  [{status}]")
    print(f"\nTotal: {total_rows} rows, {total_errors} errors")

if __name__ == "__main__":
    main()
