/**
 * ADMIN OPS ROUTES — операции из admin /ctrl-pm7k2f → Settings → «Опасная зона»
 *
 * Phase D follow-up (2026-06-01): backend под 2 из 6 кнопок Опасной зоны
 * (см. Promomusicfigma PR #87). 4 оставшиеся (backup-now / reset-stats /
 * restart-services / data-export) НЕ реализованы по design-reasons:
 *
 * - `backup-now` — pg_dump требует filesystem-permissions + backup-dir +
 *   retention policy. Без env-flags (BACKUP_DIR, RETENTION_DAYS) endpoint
 *   попасть в `/dev/full` ситуацию. Defer до отдельной PR с design-pass.
 *
 * - `reset-stats` — слишком разрушительно (артистам обнуляет plays_count
 *   на всех треках, аналитика теряет history). Без двух-фазной
 *   confirmation flow + audit-protection-banner — не делаем.
 *
 * - `restart-services` — backend сам себя рестартует — bad pattern.
 *   PID hand-off без стороннего supervisor'a не выйдет; systemctl
 *   restart promofm-api убивает сам процесс до того как HTTP response
 *   дойдёт до клиента. Должна быть отдельная sidecar утилита под root
 *   с подписанным запросом.
 *
 * - `data-export` — нужно решить scope (per-table / full-dump / только
 *   audit_logs). Format CSV vs JSON vs parquet. Защита от export'a
 *   персональных данных (152-ФЗ). Отдельный PR с product-decisions.
 *
 * Реализовано:
 * - POST /clear-cache       — clear in-memory module-level Map'ы
 * - POST /db-integrity-check — read-only health metrics (row counts,
 *                              dead tuples, last vacuum, table sizes)
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { logAdminAction } from './audit-helper.tsx';
import { pool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';
import { clearScriptCache } from './news-voice-routes.tsx';
import { clearAiHistoryCache } from './cabinet-ai-routes.tsx';

const app = new Hono();

// ─────────────────────────────────────────────────────────────────────
// POST /clear-cache
// ─────────────────────────────────────────────────────────────────────
//
// Очищает все in-memory module-level кэши которые мы держим в backend.
// Сейчас 2 кэша:
//   1. scriptCache (news-voice-routes) — LLM-сгенерированные подводки
//      DJ под новости. TTL 1h, но иногда нужно срочно сбросить (новости
//      обновили текст, а старая подводка кэширована).
//   2. aiHistoryMap (cabinet-ai-routes) — last AI response per user×cabinet.
//      Если backend перевыпустил prompt template — очищаем чтобы
//      следующий запрос пользователя пошёл свежим путём.
//
// pipeline-engine in-memory audit log НЕ очищается — он source-of-truth
// для UI Activity timeline'а, очистка спрятала бы recent history. БД-
// аудит идёт параллельно и survives.
//
// Идемпотентно. Безопасно (no data loss — кэши заполнятся на следующих
// запросах).
app.post('/clear-cache', requireAuth, requireAdmin, async (c) => {
  try {
    const scriptCacheCleared = clearScriptCache();
    const aiHistoryCleared = clearAiHistoryCache();
    const total = scriptCacheCleared + aiHistoryCleared;

    logAdminAction(c, {
      action: 'admin_ops_clear_cache',
      resourceType: 'cache',
      details: { scriptCacheCleared, aiHistoryCleared, total },
    });

    return c.json({
      success: true,
      cleared: {
        scriptCache: scriptCacheCleared,
        aiHistory: aiHistoryCleared,
        total,
      },
      message: `Очищено ${total} записей (LLM-подводки: ${scriptCacheCleared}, AI-история: ${aiHistoryCleared})`,
    });
  } catch (error: any) {
    console.error('admin_ops_clear_cache error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /db-integrity-check
// ─────────────────────────────────────────────────────────────────────
//
// Read-only БД health-метрики. Никакого VACUUM / REINDEX из приложения —
// это manual SSH-операция (в /etc/cron.d уже есть еженедельный autovacuum).
// Endpoint собирает агрегаты из pg_stat_user_tables + pg_relation_size,
// чтобы admin мог увидеть:
//   - какие таблицы выросли (size_mb)
//   - где много dead tuples (нужен VACUUM)
//   - когда последний раз была analyze (stale stats → плохие планы)
//
// Возвращаем top-15 таблиц по размеру + summary. Если какая-то таблица
// > N dead tuples (порог 50k), отмечаем её как requires_vacuum:true.
//
// Все queries — system-catalog read, без RLS, без блокировок.
app.post('/db-integrity-check', requireAuth, requireAdmin, async (c) => {
  try {
    const top = await pool.query<{
      schema_name: string;
      table_name: string;
      row_count: string;
      dead_tuples: string;
      size_mb: string;
      last_vacuum: string | null;
      last_analyze: string | null;
    }>(`
      SELECT
        s.schemaname AS schema_name,
        s.relname AS table_name,
        s.n_live_tup::text AS row_count,
        s.n_dead_tup::text AS dead_tuples,
        ROUND(pg_total_relation_size(c.oid)::numeric / 1024 / 1024, 2)::text AS size_mb,
        GREATEST(s.last_vacuum, s.last_autovacuum) AS last_vacuum,
        GREATEST(s.last_analyze, s.last_autoanalyze) AS last_analyze
      FROM pg_stat_user_tables s
      JOIN pg_class c ON c.oid = s.relid
      WHERE s.schemaname = 'public'
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 15
    `);

    const summary = await pool.query<{
      table_count: string;
      total_rows: string;
      total_size_mb: string;
      bloated_tables: string;
    }>(`
      SELECT
        COUNT(*)::text AS table_count,
        SUM(s.n_live_tup)::text AS total_rows,
        ROUND(SUM(pg_total_relation_size(c.oid))::numeric / 1024 / 1024, 2)::text AS total_size_mb,
        SUM(CASE WHEN s.n_dead_tup > 50000 THEN 1 ELSE 0 END)::text AS bloated_tables
      FROM pg_stat_user_tables s
      JOIN pg_class c ON c.oid = s.relid
      WHERE s.schemaname = 'public'
    `);

    const VACUUM_THRESHOLD = 50000;
    const tables = top.rows.map(r => ({
      table: `${r.schema_name}.${r.table_name}`,
      rowCount: Number(r.row_count),
      deadTuples: Number(r.dead_tuples),
      sizeMb: Number(r.size_mb),
      lastVacuum: r.last_vacuum,
      lastAnalyze: r.last_analyze,
      requiresVacuum: Number(r.dead_tuples) > VACUUM_THRESHOLD,
    }));

    const sum = summary.rows[0];
    const result = {
      checkedAt: new Date().toISOString(),
      summary: {
        tableCount: Number(sum.table_count),
        totalRows: Number(sum.total_rows),
        totalSizeMb: Number(sum.total_size_mb),
        bloatedTables: Number(sum.bloated_tables),
      },
      topTables: tables,
      threshold: { deadTuplesForVacuum: VACUUM_THRESHOLD },
    };

    logAdminAction(c, {
      action: 'admin_ops_db_integrity_check',
      resourceType: 'database',
      details: { tableCount: result.summary.tableCount, bloatedTables: result.summary.bloatedTables },
    });

    return c.json({ success: true, ...result });
  } catch (error: any) {
    console.error('admin_ops_db_integrity_check error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
