#!/usr/bin/env python3
"""Migrate data from Supabase to VPS PostgreSQL v2.
Uses COPY FROM STDIN (CSV) for reliable bulk import.
"""
import json, urllib.request, subprocess, sys, time, csv, io

SUPABASE_URL = "https://qzpmiiqfwkcnrhvubdgt.supabase.co/rest/v1"
SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF6cG1paXFmd2tjbnJodnViZGd0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTMzNTMzMywiZXhwIjoyMDg0OTExMzMzfQ.ik9Us-02grJpARn_f4bhEjRt7Afy753TS-DhynxleK8"
DB_URL = "postgresql://promofm_app:PromoFM2024dbSecure@localhost:5432/promofm"

# Tables to migrate - only tables that exist on VPS
TABLES = [
    "tracks", "artists", "email_subscribers", "pitching_venues",
    "pitching_radio", "videos", "pitching_tv",
    "concert_agent_data", "pitching_media", "beats", "digital_goods",
    "producer_services", "news_public",
    "curator_reports", "cross_cabinet_notifications",
    "system_config", "profiles", "chart_sources",
    "producer_messages",
    "bookings_by_user", "promo_guide_data",
    "bookings", "dm_conv_list",
    "platform_stats", "service_orders", "accounting_data",
    "artist_subscription_plans", "coin_packages",
    "track_test_requests", "radio_venue_requests", "subscription_plans",
    "publish_orders", "radio_ad_slot_index",
    "radio_artist_requests", "venue_profiles",
    "dm_conversations", "dm_messages", "venue_ad_campaigns",
    "collab_offers_by_artist", "media_contacts",
    "venue_playlists", "dj_reviews", "dj_mixes",
    "content_orders_by_status",
    "dj_marketplace_index", "venue_orders_index",
    "track_test_all_requests",
    "collab_messages", "collab_offers_by_producer",
    "news_pipeline", "ccn_unread_counts", "coin_balances",
    "artist_tracks_stats", "track_analytics", "agent_queue",
    "payment_methods",
    "contracts", "dj_events", "producer_settings", "chart_aggregation",
    "users", "dm_unread_counts",
]

BATCH_SIZE = 500

def fetch_rows(table, limit=500, offset=0):
    """Fetch rows from Supabase REST API."""
    url = f"{SUPABASE_URL}/{table}?select=*&limit={limit}&offset={offset}"
    req = urllib.request.Request(url)
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        print(f"  HTTP {e.code}: {body[:200]}")
        return []
    except Exception as e:
        print(f"  Fetch error: {e}")
        return []

def get_vps_columns(table):
    """Get column names from VPS table."""
    proc = subprocess.run(
        ["psql", DB_URL, "-t", "-A", "-c",
         f"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}' ORDER BY ordinal_position"],
        capture_output=True, text=True, timeout=10
    )
    if proc.returncode != 0:
        return None
    cols = [c.strip() for c in proc.stdout.strip().split("\n") if c.strip()]
    return cols

def csv_value(val):
    """Convert a value for CSV output."""
    if val is None:
        return ""
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, (dict, list)):
        return json.dumps(val, ensure_ascii=False)
    return str(val)

def copy_import(table, columns, rows):
    """Import rows via COPY FROM STDIN CSV."""
    if not rows:
        return True, 0, ""

    col_list = ", ".join(f'"{c}"' for c in columns)

    # Build CSV
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
    for row in rows:
        writer.writerow([csv_value(row.get(c)) for c in columns])

    csv_data = buf.getvalue()

    # Use psql \copy
    copy_cmd = f"\\copy {table} ({col_list}) FROM STDIN WITH (FORMAT csv, NULL '')"
    proc = subprocess.run(
        ["psql", DB_URL, "-c", copy_cmd],
        input=csv_data,
        capture_output=True,
        text=True,
        timeout=120
    )

    if proc.returncode != 0:
        err = proc.stderr.strip()
        # Try to extract meaningful error
        for line in err.split("\n"):
            if "ERROR" in line or "error" in line:
                return False, 0, line[:300]
        return False, 0, err[:300] if err else "Unknown error"

    # Parse row count from stdout (e.g., "COPY 500")
    count = 0
    for line in proc.stdout.strip().split("\n"):
        if line.startswith("COPY "):
            try:
                count = int(line.split()[1])
            except (IndexError, ValueError):
                pass

    return True, count, ""

def migrate_table(table):
    """Migrate a single table."""
    print(f"\n--- {table} ---")

    # Get VPS columns
    vps_cols = get_vps_columns(table)
    if vps_cols is None or len(vps_cols) == 0:
        print(f"  SKIP: table does not exist on VPS")
        return 0, 0, True

    # Clear existing data first (idempotent migration)
    subprocess.run(
        ["psql", DB_URL, "-c", f"DELETE FROM {table};"],
        capture_output=True, text=True, timeout=30
    )

    offset = 0
    total = 0
    errors = 0

    while True:
        rows = fetch_rows(table, BATCH_SIZE, offset)
        if not rows:
            break

        # Filter to only columns that exist on VPS
        src_cols = list(rows[0].keys())
        common_cols = [c for c in src_cols if c in vps_cols]

        if not common_cols:
            print(f"  SKIP: no common columns")
            break

        ok, count, err = copy_import(table, common_cols, rows)
        if ok:
            total += count
        else:
            print(f"  ERROR at offset {offset}: {err}")
            # Fallback: try row by row with INSERT
            for row in rows:
                cols = [c for c in row.keys() if c in vps_cols]
                vals = []
                for c in cols:
                    v = row.get(c)
                    if v is None:
                        vals.append("NULL")
                    elif isinstance(v, bool):
                        vals.append("TRUE" if v else "FALSE")
                    elif isinstance(v, (int, float)):
                        vals.append(str(v))
                    elif isinstance(v, (dict, list)):
                        j = json.dumps(v, ensure_ascii=False).replace("'", "''")
                        vals.append(f"'{j}'::jsonb")
                    else:
                        s = str(v).replace("'", "''")
                        vals.append(f"'{s}'")
                col_list = ", ".join(f'"{c}"' for c in cols)
                val_list = ", ".join(vals)
                sql = f"INSERT INTO {table} ({col_list}) VALUES ({val_list}) ON CONFLICT DO NOTHING;"
                proc = subprocess.run(
                    ["psql", DB_URL, "--set", "ON_ERROR_STOP=1", "-c", sql],
                    capture_output=True, text=True, timeout=10
                )
                if proc.returncode == 0:
                    total += 1
                else:
                    errors += 1
                    if errors <= 3:
                        err_msg = proc.stderr.strip().split("\n")
                        for line in err_msg:
                            if "ERROR" in line:
                                print(f"    Row error: {line[:200]}")
                                break

        if len(rows) < BATCH_SIZE:
            break
        offset += BATCH_SIZE
        time.sleep(0.1)

    status = "OK" if errors == 0 else f"PARTIAL ({errors} errors)"
    print(f"  Imported: {total} rows [{status}]")
    return total, errors, False

def main():
    tables = TABLES
    if len(sys.argv) > 1:
        tables = sys.argv[1:]

    print("=" * 60)
    print("PromoFM Data Migration v2: Supabase -> VPS PostgreSQL")
    print("Using COPY FROM STDIN (CSV) for reliable bulk import")
    print("=" * 60)

    # Test DB connection
    proc = subprocess.run(
        ["psql", DB_URL, "-c", "SELECT 1;"],
        capture_output=True, text=True, timeout=10
    )
    if proc.returncode != 0:
        print(f"DB connection failed: {proc.stderr[:200]}")
        sys.exit(1)
    print("DB connection: OK")

    # Test Supabase API
    test = fetch_rows("profiles", 1, 0)
    if not test:
        print("Supabase API: FAILED")
        sys.exit(1)
    print(f"Supabase API: OK")

    results = {}
    total_rows = 0
    total_errors = 0

    for table in tables:
        rows, errs, skipped = migrate_table(table)
        if not skipped:
            results[table] = (rows, errs)
            total_rows += rows
            total_errors += errs

    print("\n" + "=" * 60)
    print("MIGRATION SUMMARY")
    print("=" * 60)
    for table, (rows, errs) in sorted(results.items(), key=lambda x: -x[1][0]):
        status = "OK" if errs == 0 else f"ERRORS: {errs}"
        print(f"  {table:40s} {rows:6d} rows  [{status}]")
    print(f"\nTotal: {total_rows} rows, {total_errors} errors")
    print("=" * 60)

if __name__ == "__main__":
    main()
