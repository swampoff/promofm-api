/**
 * MIGRATION RUNNER (Stub)
 * Миграции не нужны - приложение использует KV Store.
 * Экспорты сохранены для обратной совместимости с migration-routes.tsx
 */

/**
 * Выполнить все миграции (stub - SQL-миграции не используются)
 */
export async function runAllMigrations() {
  console.log('Migrations skipped: application uses KV Store, not SQL tables.');
  return {
    success: true,
    results: {
      migration_001: {
        success: true,
        migration: 'Skipped (KV Store mode)',
        successCount: 0,
        totalStatements: 0,
        successRate: 100,
      },
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Проверить статус таблиц (stub)
 */
export async function checkTablesStatus() {
  return {
    success: true,
    mode: 'kv_store',
    message: 'Application uses KV Store. SQL tables are not required.',
    existingTables: ['kv_store_84730125'],
  };
}
