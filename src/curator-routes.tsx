/**
 * CURATOR ROUTES — HTTP endpoints для агентов-кураторов
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { curatorReportsStore } from './db.tsx';
import {
  runCurator,
  runAllCurators,
  getLatestReports,
  CURATOR_ROLES,
} from './curator-agents.tsx';
import type { RoleId } from './curator-agents.tsx';
import { sendEmail } from './email-helper.tsx';
import { safeErrorMessage } from './security.tsx';

const curatorRoutes = new Hono();

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

/** Admin auth: either JWT admin or X-Internal-Key header */
async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) {
    return next();
  }
  return requireAuth(c, () => requireAdmin(c, next));
}

/**
 * POST /run — запустить всех кураторов
 */
curatorRoutes.post('/run', requireAdminOrKey, async (c) => {
  try {
    console.log('[curator] Starting all curators...');
    const result = await runAllCurators();
    return c.json({
      success: true,
      totalRoles: result.totalRoles,
      overallPassed: result.overallPassed,
      overallFailed: result.overallFailed,
      overallWarnings: result.overallWarnings,
      reports: result.reports.map(r => ({
        role: r.role,
        roleName: r.roleName,
        passed: r.passed,
        failed: r.failed,
        warnings: r.warnings,
        totalEndpoints: r.totalEndpoints,
        summary: r.summary,
      })),
    });
  } catch (error) {
    console.error('[curator] Run all error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /run/:roleId — запустить куратора для конкретной роли
 */
curatorRoutes.post('/run/:roleId', requireAdminOrKey, async (c) => {
  try {
    const roleId = c.req.param('roleId') as RoleId;
    const role = CURATOR_ROLES.find(r => r.id === roleId);
    if (!role) {
      return c.json({ success: false, error: `Unknown role: ${roleId}` }, 404);
    }

    console.log(`[curator] Running curator for ${role.name}...`);
    const report = await runCurator(roleId);
    return c.json({ success: true, report });
  } catch (error) {
    console.error('[curator] Run error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /status — статус всех кураторов (последние отчёты)
 */
curatorRoutes.get('/status', requireAdminOrKey, async (c) => {
  try {
    const latest = await getLatestReports();
    const summary: Record<string, any> = {};

    for (const role of CURATOR_ROLES) {
      const report = latest[role.id];
      summary[role.id] = report
        ? {
            roleName: role.name,
            lastRun: report.completedAt,
            passed: report.passed,
            failed: report.failed,
            warnings: report.warnings,
            totalEndpoints: report.totalEndpoints,
            summary: report.summary,
          }
        : { roleName: role.name, lastRun: null, status: 'never_run' };
    }

    return c.json({ success: true, data: summary });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /report/:roleId — детальный отчёт по роли
 */
curatorRoutes.get('/report/:roleId', requireAdminOrKey, async (c) => {
  try {
    const roleId = c.req.param('roleId');
    const report = await curatorReportsStore.get(`latest:${roleId}`);
    if (!report) {
      return c.json({ success: false, error: 'Отчёт не найден. Запустите куратора.' }, 404);
    }
    return c.json({ success: true, report });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /roles — список ролей
 */
curatorRoutes.get('/roles', requireAdminOrKey, async (c) => {
  return c.json({
    success: true,
    data: CURATOR_ROLES.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
    })),
  });
});

/**
 * GET /history — все отчёты (последние 50)
 */
curatorRoutes.get('/history', requireAdminOrKey, async (c) => {
  try {
    const all = await curatorReportsStore.getAll();
    const reports = all
      .filter((r: any) => r.id && !r.id.startsWith('latest:'))
      .sort((a: any, b: any) => (b.completedAt || '').localeCompare(a.completedAt || ''))
      .slice(0, 50)
      .map((r: any) => ({
        id: r.id,
        role: r.role,
        roleName: r.roleName,
        completedAt: r.completedAt,
        passed: r.passed,
        failed: r.failed,
        warnings: r.warnings,
        totalEndpoints: r.totalEndpoints,
      }));

    return c.json({ success: true, data: reports });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /email-report/:roleId — отправить отчёт на email
 */
curatorRoutes.post('/email-report/:roleId', requireAdminOrKey, async (c) => {
  try {
    const roleId = c.req.param('roleId');
    const { to } = await c.req.json().catch(() => ({ to: '' }));
    const toEmail = to || 'info@promofm.ru';

    const report = await curatorReportsStore.get(`latest:${roleId}`) as any;
    if (!report) {
      return c.json({ success: false, error: 'Отчёт не найден' }, 404);
    }

    // Build HTML
    const rows = (report.results || []).map((r: any) => {
      const color = r.ok ? '#4ade80' : '#f87171';
      const icon = r.ok ? '✓' : '✗';
      const val = r.validationMessage ? `<br><small style="color:#94a3b8">${r.validationMessage}</small>` : '';
      return `<tr><td style="padding:6px 10px;border-bottom:1px solid #1e293b;color:${color}">${icon}</td><td style="padding:6px 10px;border-bottom:1px solid #1e293b">${r.description}${val}</td><td style="padding:6px 10px;border-bottom:1px solid #1e293b;text-align:center;color:${color}">${r.status}</td></tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f172a;color:#e2e8f0;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:20px">
<div style="background:linear-gradient(135deg,#FF577F,#FF884B);padding:20px 24px;border-radius:12px 12px 0 0">
<h1 style="margin:0;color:#fff;font-size:20px">🛡️ Отчёт куратора: ${report.roleName}</h1>
<p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px">ПРОМО.МУЗЫКА — Автоматический аудит</p>
</div>
<div style="background:#1e293b;padding:20px 24px;border-radius:0 0 12px 12px">
<table style="width:100%;margin-bottom:16px"><tr>
<td style="background:#0f172a;padding:12px 16px;border-radius:8px;text-align:center;width:33%"><div style="font-size:28px;font-weight:bold;color:#4ade80">${report.passed}/${report.totalEndpoints}</div><div style="font-size:12px;color:#94a3b8">Пройдено</div></td>
<td style="width:8px"></td>
<td style="background:#0f172a;padding:12px 16px;border-radius:8px;text-align:center;width:33%"><div style="font-size:28px;font-weight:bold;color:#f87171">${report.failed}</div><div style="font-size:12px;color:#94a3b8">Ошибок</div></td>
<td style="width:8px"></td>
<td style="background:#0f172a;padding:12px 16px;border-radius:8px;text-align:center;width:33%"><div style="font-size:28px;font-weight:bold;color:#fbbf24">${report.warnings}</div><div style="font-size:12px;color:#94a3b8">Пустых</div></td>
</tr></table>
<table style="width:100%;border-collapse:collapse;font-size:13px">
<tr style="color:#94a3b8;font-size:11px;text-transform:uppercase">
<th style="padding:8px 10px;text-align:left;border-bottom:2px solid #334155">OK</th>
<th style="padding:8px 10px;text-align:left;border-bottom:2px solid #334155">Эндпоинт</th>
<th style="padding:8px 10px;text-align:center;border-bottom:2px solid #334155">HTTP</th>
</tr>${rows}</table>
<pre style="background:#0f172a;padding:12px;border-radius:8px;font-size:11px;color:#94a3b8;white-space:pre-wrap;margin-top:12px">${report.summary}</pre>
<p style="margin:12px 0 0;font-size:11px;color:#64748b;text-align:center">Дата: ${report.completedAt} | Роль: ${report.role}</p>
</div></div></body></html>`;

    const sent = await sendEmail({
      to: toEmail,
      subject: `🛡️ Куратор ${report.roleName}: ${report.passed}/${report.totalEndpoints} OK | ПРОМО.МУЗЫКА`,
      html,
    });

    return c.json({ success: true, sent, to: toEmail });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default curatorRoutes;
