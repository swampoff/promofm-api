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

// ════════════════════════════════════════════════════════════════
// PARTNERS — admin-managed CRUD (migration 113)
// ════════════════════════════════════════════════════════════════

const PARTNER_CATEGORIES = new Set(['radio', 'venue', 'media', 'streaming', 'blogger', 'other']);
const PARTNER_STATUSES = new Set(['active', 'inactive', 'pending']);

function mapPartnerRow(r: any) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    status: r.status,
    email: r.email,
    phone: r.phone,
    website: r.website,
    address: r.address,
    description: r.description,
    logoUrl: r.logo_url,
    contactPerson: r.contact_person,
    commission: Number(r.commission),
    extra: typeof r.extra === 'string' ? JSON.parse(r.extra) : (r.extra || {}),
    createdBy: r.created_by,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

app.get('/partners', requireAuth, requireAdmin, async (c) => {
  try {
    const category = c.req.query('category');
    const status = c.req.query('status');
    const conds: string[] = [];
    const vals: any[] = [];
    if (category && PARTNER_CATEGORIES.has(category)) {
      vals.push(category);
      conds.push(`category = $${vals.length}`);
    }
    if (status && PARTNER_STATUSES.has(status)) {
      vals.push(status);
      conds.push(`status = $${vals.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT id::text AS id, name, category, status, email, phone, website,
              address, description, logo_url, contact_person, commission,
              extra, created_by, created_at, updated_at
         FROM admin_partners
         ${where}
        ORDER BY created_at DESC`,
      vals,
    );
    return c.json({ success: true, data: r.rows.map(mapPartnerRow) });
  } catch (error: any) {
    console.error('partners GET error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/partners', requireAuth, requireAdmin, async (c) => {
  try {
    const adminId = c.get('userId' as never) as string;
    const body = await c.req.json();
    const name = String(body?.name || '').trim();
    const category = String(body?.category || '').trim();
    const status = String(body?.status || 'pending').trim();

    if (!name) return c.json({ success: false, error: 'name обязателен' }, 400);
    if (!PARTNER_CATEGORIES.has(category)) {
      return c.json({ success: false, error: `category должен быть одним из: ${[...PARTNER_CATEGORIES].join(', ')}` }, 400);
    }
    if (!PARTNER_STATUSES.has(status)) {
      return c.json({ success: false, error: `status должен быть одним из: ${[...PARTNER_STATUSES].join(', ')}` }, 400);
    }

    const commissionRaw = body?.commission;
    const commission = commissionRaw === undefined || commissionRaw === null || commissionRaw === ''
      ? 15
      : Number(commissionRaw);
    if (!Number.isFinite(commission) || commission < 0 || commission > 100) {
      return c.json({ success: false, error: 'commission должна быть числом 0…100' }, 400);
    }

    try {
      const r = await pool.query(
        `INSERT INTO admin_partners
           (name, category, status, email, phone, website, address, description,
            logo_url, contact_person, commission, extra, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
         RETURNING id::text AS id, name, category, status, email, phone, website,
                   address, description, logo_url, contact_person, commission,
                   extra, created_by, created_at, updated_at`,
        [
          name, category, status,
          body?.email || null, body?.phone || null, body?.website || null,
          body?.address || null, body?.description || null, body?.logoUrl || null,
          body?.contactPerson || null, commission,
          JSON.stringify(body?.extra && typeof body.extra === 'object' ? body.extra : {}),
          adminId,
        ],
      );
      return c.json({ success: true, data: mapPartnerRow(r.rows[0]) }, 201);
    } catch (err: any) {
      if (err?.code === '23505') {
        return c.json({ success: false, error: 'Партнёр с таким названием и категорией уже существует' }, 409);
      }
      throw err;
    }
  } catch (error: any) {
    console.error('partners POST error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.patch('/partners/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const updates: string[] = [];
    const vals: any[] = [];

    const stringFields: Array<{ key: string; col: string }> = [
      { key: 'name', col: 'name' },
      { key: 'email', col: 'email' },
      { key: 'phone', col: 'phone' },
      { key: 'website', col: 'website' },
      { key: 'address', col: 'address' },
      { key: 'description', col: 'description' },
      { key: 'logoUrl', col: 'logo_url' },
      { key: 'contactPerson', col: 'contact_person' },
    ];
    for (const f of stringFields) {
      if (typeof body?.[f.key] === 'string') {
        vals.push(body[f.key]);
        updates.push(`${f.col} = $${vals.length}`);
      }
    }
    if (typeof body?.category === 'string') {
      if (!PARTNER_CATEGORIES.has(body.category)) {
        return c.json({ success: false, error: 'Неподдерживаемая category' }, 400);
      }
      vals.push(body.category);
      updates.push(`category = $${vals.length}`);
    }
    if (typeof body?.status === 'string') {
      if (!PARTNER_STATUSES.has(body.status)) {
        return c.json({ success: false, error: 'Неподдерживаемый status' }, 400);
      }
      vals.push(body.status);
      updates.push(`status = $${vals.length}`);
    }
    if (body?.commission !== undefined) {
      const c2 = Number(body.commission);
      if (!Number.isFinite(c2) || c2 < 0 || c2 > 100) {
        return c.json({ success: false, error: 'commission должна быть числом 0…100' }, 400);
      }
      vals.push(c2);
      updates.push(`commission = $${vals.length}`);
    }
    if (body?.extra && typeof body.extra === 'object') {
      vals.push(JSON.stringify(body.extra));
      updates.push(`extra = $${vals.length}::jsonb`);
    }
    if (!updates.length) return c.json({ success: false, error: 'Нет полей для обновления' }, 400);
    updates.push(`updated_at = NOW()`);
    vals.push(id);

    try {
      const r = await pool.query(
        `UPDATE admin_partners SET ${updates.join(', ')}
          WHERE id::text = $${vals.length}
          RETURNING id::text AS id, name, category, status, email, phone, website,
                    address, description, logo_url, contact_person, commission,
                    extra, created_by, created_at, updated_at`,
        vals,
      );
      if (!r.rowCount) return c.json({ success: false, error: 'Не найдено' }, 404);
      return c.json({ success: true, data: mapPartnerRow(r.rows[0]) });
    } catch (err: any) {
      if (err?.code === '23505') {
        return c.json({ success: false, error: 'Партнёр с таким названием и категорией уже существует' }, 409);
      }
      throw err;
    }
  } catch (error: any) {
    console.error('partners PATCH error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.delete('/partners/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('id');
    const r = await pool.query(`DELETE FROM admin_partners WHERE id::text = $1`, [id]);
    if (!r.rowCount) return c.json({ success: false, error: 'Не найдено' }, 404);
    return c.json({ success: true });
  } catch (error: any) {
    console.error('partners DELETE error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
