-- tools/dump_prod_schema.sql
--
-- READ-ONLY query — dumps current prod schema (public schema, BASE TABLEs)
-- as JSON in the SAME shape as tools/expected_schema.json so cloud can do
-- a structural diff.
--
-- Run on prod (laptop):
--
--   sudo -u postgres psql -d promofm -At -f /opt/promofm-api/tools/dump_prod_schema.sql \
--     > /tmp/prod_schema_$(date +%s).json
--
-- Then paste the JSON contents back into chat (or attach the file).
--
-- Excludes:
--   - non-public schemas (pg_catalog, information_schema, etc.)
--   - VIEWs, MATERIALIZED VIEWs, FOREIGN TABLEs (only BASE TABLE)
--   - pg_* prefixed system tables in public if any leaked
--
-- Output shape:
--   {
--     "generated_at": "<timestamp>",
--     "tables": {
--       "users":  ["id", "email", "status", "phone", ...],
--       "tracks": ["id", "artist_id", ...]
--     }
--   }

SELECT json_build_object(
  'generated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'tables', COALESCE(json_object_agg(table_name, columns ORDER BY table_name), '{}'::json)
)::text
FROM (
  SELECT
    c.table_name,
    json_agg(c.column_name ORDER BY c.ordinal_position) AS columns
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON  t.table_schema = c.table_schema
    AND t.table_name   = c.table_name
  WHERE c.table_schema = 'public'
    AND t.table_type   = 'BASE TABLE'
    AND c.table_name NOT LIKE 'pg\_%' ESCAPE '\'
  GROUP BY c.table_name
) sub;
