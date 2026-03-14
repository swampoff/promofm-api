#!/usr/bin/env python3
"""Fix migration: re-import failed tables with proper array handling."""
import json, urllib.request, subprocess, sys, time, csv, io

SUPABASE_URL = "https://qzpmiiqfwkcnrhvubdgt.supabase.co/rest/v1"
SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF6cG1paXFmd2tjbnJodnViZGd0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTMzNTMzMywiZXhwIjoyMDg0OTExMzMzfQ.ik9Us-02grJpARn_f4bhEjRt7Afy753TS-DhynxleK8"
DB_URL = "postgresql://promofm_app:PromoFM2024dbSecure@localhost:5432/promofm"

# Only tables that failed in v2
TABLES = [
    "tracks", "cross_cabinet_notifications", "chart_sources",
    "producer_messages", "promo_guide_data", "platform_stats",
    "service_orders", "coin_packages", "track_test_requests",
    "venue_profiles", "dm_messages", "media_contacts",
    "dj_reviews", "dj_mixes", "track_analytics", "dj_events", "users",
]

# Columns that are text[] arrays (need special handling)
ARRAY_COLUMNS = {
    "tracks": ["tags"],
    "media_contacts": ["topics"],
    "pitching_venues": ["music_genres", "collaboration_type"],
    "pitching_radio": ["music_genres"],
}

BATCH_SIZE = 500

def fetch_rows(table, limit=500, offset=0):
    url = f"{SUPABASE_URL}/{table}?select=*&limit={limit}&offset={offset}"
    req = urllib.request.Request(url)
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"  Fetch error: {e}")
        return []

def get_vps_columns(table):
    proc = subprocess.run(
        ["psql", DB_URL, "-t", "-A", "-c",
         f"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}' ORDER BY ordinal_position"],
        capture_output=True, text=True, timeout=10
    )
    if proc.returncode != 0:
        return None
    return [c.strip() for c in proc.stdout.strip().split("\n") if c.strip()]

def json_array_to_pg_array(val):
    """Convert JSON array to PostgreSQL array literal."""
    if val is None:
        return None
    if isinstance(val, list):
        if len(val) == 0:
            return "{}"
        # Escape and format each element
        elements = []
        for item in val:
            s = str(item).replace("\\", "\\\\").replace('"', '\\"')
            elements.append(f'"{s}"')
        return "{" + ",".join(elements) + "}"
    return val

def escape_sql_val(val, col, table):
    """Escape a value for SQL INSERT."""
    if val is None:
        return "NULL"

    # Handle array columns specially
    array_cols = ARRAY_COLUMNS.get(table, [])
    if col in array_cols:
        pg_arr = json_array_to_pg_array(val)
        if pg_arr is None:
            return "NULL"
        return f"'{pg_arr}'"

    if isinstance(val, bool):
        return "TRUE" if val else "FALSE"
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, (dict, list)):
        j = json.dumps(val, ensure_ascii=False).replace("'", "''")
        return f"'{j}'::jsonb"
    s = str(val).replace("'", "''")
    return f"'{s}'"

def migrate_table(table):
    print(f"\n--- {table} ---")

    vps_cols = get_vps_columns(table)
    if not vps_cols:
        print(f"  SKIP: table does not exist on VPS")
        return 0, 0

    # Clear existing data
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

        src_cols = list(rows[0].keys())
        common_cols = [c for c in src_cols if c in vps_cols]

        for row in rows:
            cols_used = [c for c in common_cols if c in row]
            col_list = ", ".join(f'"{c}"' for c in cols_used)
            val_list = ", ".join(escape_sql_val(row.get(c), c, table) for c in cols_used)
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
                    for line in proc.stderr.split("\n"):
                        if "ERROR" in line:
                            print(f"    {line[:200]}")
                            break

        if len(rows) < BATCH_SIZE:
            break
        offset += BATCH_SIZE
        time.sleep(0.1)

        # Progress for large tables
        if total > 0 and total % 1000 == 0:
            print(f"  ... {total} rows so far")

    status = "OK" if errors == 0 else f"PARTIAL ({errors} errors)"
    print(f"  Imported: {total} rows [{status}]")
    return total, errors

def main():
    tables = TABLES
    if len(sys.argv) > 1:
        tables = sys.argv[1:]

    print("=" * 60)
    print("PromoFM Fix Migration: re-importing failed tables")
    print("=" * 60)

    total_rows = 0
    total_errors = 0
    results = {}

    for table in tables:
        rows, errs = migrate_table(table)
        results[table] = (rows, errs)
        total_rows += rows
        total_errors += errs

    print("\n" + "=" * 60)
    print("FIX MIGRATION SUMMARY")
    print("=" * 60)
    for table, (rows, errs) in sorted(results.items(), key=lambda x: -x[1][0]):
        status = "OK" if errs == 0 else f"ERRORS: {errs}"
        print(f"  {table:40s} {rows:6d} rows  [{status}]")
    print(f"\nTotal: {total_rows} rows, {total_errors} errors")

if __name__ == "__main__":
    main()
