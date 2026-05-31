-- tools/audit_duplicate_artists.sql
--
-- READ-ONLY audit. Finds duplicate artist_profiles and, for each
-- profile in a duplicate group, counts dependent rows across EVERY
-- table that has an `artist_id` column. No FK constraints exist on
-- artist_profiles (verified: 0 REFERENCES in migrations), so orphaning
-- is silent — this audit is the only way to see the blast radius
-- before any merge/dedup.
--
-- Run (laptop):
--   sudo -u postgres psql -d promofm -f /opt/promofm-api/tools/audit_duplicate_artists.sql
--
-- Paste the three result sets back into chat. NOTHING is modified.

\echo '════════════════════════════════════════════════════'
\echo '1. DUPLICATE GROUPS — profiles sharing a normalized name'
\echo '════════════════════════════════════════════════════'
-- Two profiles are "the same artist" if their artist_name matches
-- case-insensitively after trimming. (slug can differ: friday.js makes
-- ariana-grande, legacy import may have ariana-grande-1 etc.)
WITH norm AS (
  SELECT
    id,
    user_id,
    slug,
    artist_name,
    LOWER(TRIM(artist_name)) AS norm_name,
    created_at
  FROM artist_profiles
  WHERE artist_name IS NOT NULL AND TRIM(artist_name) <> ''
),
groups AS (
  SELECT norm_name, COUNT(*) AS n
  FROM norm
  GROUP BY norm_name
  HAVING COUNT(*) > 1
)
SELECT
  n.norm_name,
  n.id,
  n.slug,
  n.user_id,
  n.created_at,
  g.n AS group_size
FROM norm n
JOIN groups g USING (norm_name)
ORDER BY n.norm_name, n.created_at;

\echo ''
\echo '════════════════════════════════════════════════════'
\echo '2. DEPENDENT ROW COUNTS — per duplicate profile, per table'
\echo '   (only tables with an artist_id column)'
\echo '════════════════════════════════════════════════════'
-- Dynamic: loop every public table with an artist_id column, count
-- rows whose artist_id matches a profile that lives in a dup group.
DO $$
DECLARE
  r RECORD;
  cnt BIGINT;
  total_tables INT := 0;
BEGIN
  DROP TABLE IF EXISTS _dup_ids;
  CREATE TEMP TABLE _dup_ids AS
    WITH norm AS (
      SELECT id, LOWER(TRIM(artist_name)) AS norm_name
      FROM artist_profiles
      WHERE artist_name IS NOT NULL AND TRIM(artist_name) <> ''
    ),
    groups AS (
      SELECT norm_name FROM norm GROUP BY norm_name HAVING COUNT(*) > 1
    )
    SELECT n.id::text AS id, n.norm_name
    FROM norm n JOIN groups g USING (norm_name);

  DROP TABLE IF EXISTS _dep_counts;
  CREATE TEMP TABLE _dep_counts (
    table_name TEXT,
    artist_id  TEXT,
    n_rows     BIGINT
  );

  FOR r IN
    SELECT c.table_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'artist_id'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  LOOP
    total_tables := total_tables + 1;
    -- Cast artist_id to text on both sides to survive uuid/text mix
    EXECUTE format(
      'INSERT INTO _dep_counts
         SELECT %L, d.id, COUNT(*)
         FROM %I tbl
         JOIN _dup_ids d ON tbl.artist_id::text = d.id
         GROUP BY d.id',
      r.table_name, r.table_name
    );
  END LOOP;

  RAISE NOTICE 'Scanned % tables with an artist_id column', total_tables;
END $$;

-- emit the collected counts. _dup_ids / _dep_counts are plain TEMP
-- (session-scoped, NOT ON COMMIT DROP), so they survive the DO block's
-- implicit commit and are visible to this SELECT. They vanish when the
-- psql session ends.
SELECT
  dc.table_name,
  dc.artist_id,
  ap.slug,
  ap.artist_name,
  dc.n_rows
FROM _dep_counts dc
LEFT JOIN artist_profiles ap ON ap.id::text = dc.artist_id
ORDER BY dc.table_name, dc.n_rows DESC;

\echo ''
\echo '════════════════════════════════════════════════════'
\echo '3. SUMMARY — dup groups and how many carry real data'
\echo '════════════════════════════════════════════════════'
WITH norm AS (
  SELECT id, LOWER(TRIM(artist_name)) AS norm_name
  FROM artist_profiles
  WHERE artist_name IS NOT NULL AND TRIM(artist_name) <> ''
),
groups AS (
  SELECT norm_name, COUNT(*) AS n_profiles
  FROM norm GROUP BY norm_name HAVING COUNT(*) > 1
)
SELECT
  COUNT(*)                       AS duplicate_groups,
  SUM(n_profiles)                AS total_profiles_in_dupes,
  SUM(n_profiles) - COUNT(*)     AS profiles_that_could_merge_away
FROM groups;
