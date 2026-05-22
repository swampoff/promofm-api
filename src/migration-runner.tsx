/**
 * MIGRATION RUNNER (Stub)
 *
 * Real schema migrations are inlined into each route module as
 * `ensureSchema()` / `CREATE TABLE IF NOT EXISTS` blocks that run on
 * first request — no centralised migration framework. This module is
 * kept only for the legacy `migration-routes.tsx` admin endpoint.
 */

export async function runAllMigrations() {
  console.log('Migrations skipped: schema bootstraps inline in each route module.');
  return {
    success: true,
    results: {
      migration_001: {
        success: true,
        migration: 'Skipped',
        successCount: 0,
        totalStatements: 0,
        successRate: 100,
      },
    },
    timestamp: new Date().toISOString(),
  };
}

export async function checkTablesStatus() {
  return {
    success: true,
    mode: 'inline-bootstrap',
    message: 'Tables are created on demand by individual route modules.',
    existingTables: [],
  };
}
