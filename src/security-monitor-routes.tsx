/**
 * Security Monitor Routes — SOC Dashboard API
 * Aggregates: WAF events, Warden alerts, FIM status, kill chains, IP reputation
 * Incident response protocol: DETECT → ASSESS → CONTAIN → ANALYZE → ERADICATE → RECOVER → REPORT
 */
import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { getWafStats, getRecentEvents as getWafEvents, isIPBanned } from './threat-detector.tsx';
import { getWardenStatus, getWardenAlerts, checkIPReputation, updateFimBaseline } from './security-warden.tsx';
import { pool } from './db-client.tsx';

const securityRoutes = new Hono();

// ─── GET /status — unified SOC dashboard ────────────────────────
securityRoutes.get('/status', requireAuth, requireAdmin, async (c) => {
  const waf = getWafStats();
  const warden = getWardenStatus();

  return c.json({
    success: true,
    data: {
      // Overall status
      status: 'operational',
      components: {
        waf: { active: true, totalBlocked: waf.totalBlocked, totalDetected: waf.totalDetected, bannedIPs: waf.bannedIPs.length },
        warden: { active: true, lastScan: warden.last_scan, scanCount: warden.scan_count, totalAlerts: warden.total_alerts },
        clamav: { active: true },
        fail2ban: { active: true, jails: 6 },
        ufw: { active: true },
        rateLimiter: { active: true },
        fim: { active: true, monitoredFiles: warden.monitored_files },
      },
      // Aggregate stats
      totalThreatsDetected: waf.totalDetected + warden.total_alerts,
      totalBlocked: waf.totalBlocked,
      bannedIPs: waf.bannedIPs,
      topThreats: waf.patternCounts,
      startTime: warden.start_time,
    },
  });
});

// ─── GET /events — all security events (WAF + Warden) ───────────
securityRoutes.get('/events', requireAuth, requireAdmin, async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const severity = c.req.query('severity') || undefined;
  const source = c.req.query('source'); // 'waf' | 'warden' | undefined (all)

  let events: any[] = [];

  if (!source || source === 'waf') {
    const wafEvents = getWafEvents(limit, severity);
    events.push(...wafEvents.map(e => ({ ...e, source: 'waf' })));
  }

  if (!source || source === 'warden') {
    const wardenAlerts = getWardenAlerts(limit, severity);
    events.push(...wardenAlerts.map(a => ({
      timestamp: a.timestamp,
      category: a.category,
      severity: a.severity,
      payload: a.message,
      details: a.details,
      mitre: a.mitre,
      source: 'warden',
    })));
  }

  // Sort by timestamp descending
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return c.json({
    success: true,
    data: events.slice(0, limit),
    total: events.length,
  });
});

// ─── GET /stats — aggregate security statistics ─────────────────
securityRoutes.get('/stats', requireAuth, requireAdmin, async (c) => {
  const waf = getWafStats();
  const warden = getWardenStatus();

  // DB stats
  let dbStats = { totalEvents: 0, last24h: 0, criticalCount: 0 };
  try {
    const res = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '24 hours') as last_24h,
        COUNT(*) FILTER (WHERE severity = 'CRITICAL') as critical_count
      FROM security_events
    `);
    if (res.rows[0]) {
      dbStats = {
        totalEvents: parseInt(res.rows[0].total),
        last24h: parseInt(res.rows[0].last_24h),
        criticalCount: parseInt(res.rows[0].critical_count),
      };
    }
  } catch {}

  return c.json({
    success: true,
    data: {
      waf: {
        totalDetected: waf.totalDetected,
        totalBlocked: waf.totalBlocked,
        patternCounts: waf.patternCounts,
        bannedIPs: waf.bannedIPs,
        topSuspiciousIPs: waf.ipScores,
      },
      warden: {
        scanCount: warden.scan_count,
        lastScan: warden.last_scan,
        totalAlerts: warden.total_alerts,
        monitoredFiles: warden.monitored_files,
        killChains: warden.kill_chains,
        ipReputationCacheSize: warden.ip_reputation_cache_size,
      },
      database: dbStats,
    },
  });
});

// ─── GET /ip/:address — check IP reputation ────────────────────
securityRoutes.get('/ip/:address', requireAuth, requireAdmin, async (c) => {
  const ip = c.req.param('address');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return c.json({ success: false, error: 'Invalid IP format' }, 400);
  }

  const reputation = await checkIPReputation(ip);
  const banned = isIPBanned(ip);

  // Check WAF events for this IP
  const wafEvents = getWafEvents(100).filter((e: any) => e.ip === ip);

  // Check DB for login attempts
  let loginAttempts = { total: 0, failed: 0 };
  try {
    const res = await pool.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE success = false) as failed
       FROM login_attempts WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [ip]
    );
    if (res.rows[0]) {
      loginAttempts = { total: parseInt(res.rows[0].total), failed: parseInt(res.rows[0].failed) };
    }
  } catch {}

  return c.json({
    success: true,
    data: {
      ip,
      banned,
      abuseScore: reputation.score,
      isMalicious: reputation.isMalicious,
      wafEvents: wafEvents.length,
      recentWafEvents: wafEvents.slice(0, 10),
      loginAttempts,
      verdict: reputation.score > 80 || banned ? 'MALICIOUS' :
               reputation.score > 50 ? 'SUSPICIOUS' :
               wafEvents.length > 5 ? 'ELEVATED' : 'CLEAN',
    },
  });
});

// ─── POST /fim/reset — reset FIM baseline after legitimate deploy ──
securityRoutes.post('/fim/reset', requireAuth, requireAdmin, async (c) => {
  updateFimBaseline();
  return c.json({ success: true, message: 'FIM baseline reset successfully' });
});

// ─── GET /incidents — structured incident reports from DB ───────
securityRoutes.get('/incidents', requireAuth, requireAdmin, async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  const severity = c.req.query('severity');

  try {
    let query = 'SELECT * FROM security_events WHERE 1=1';
    const params: any[] = [];

    if (severity) {
      params.push(severity.toUpperCase());
      query += ` AND severity = $${params.length}`;
    }

    query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await pool.query(query, params);

    // Format as incident reports
    const incidents = res.rows.map((row: any, idx: number) => ({
      id: `INC-${String(row.id).padStart(4, '0')}`,
      timestamp: row.timestamp,
      severity: row.severity,
      category: row.category,
      message: row.message,
      details: row.details,
      mitre: row.mitre,
      resolved: row.resolved,
      // Incident response format
      report: `🚨 [${row.severity}] ИНЦИДЕНТ ${`INC-${String(row.id).padStart(4, '0')}`}
━━━━━━━━━━━━━━━━━━━━━━━━
Время:        ${row.timestamp}
Компонент:    promofm-api
Тип угрозы:   ${row.category}
MITRE ATT&CK: ${row.mitre || 'N/A'}
━━━━━━━━━━━━━━━━━━━━━━━━
КОНТЕКСТ:     ${row.message}
${row.details ? `ДЕТАЛИ:       ${row.details}` : ''}
СТАТУС:       ${row.resolved ? 'Resolved' : 'Open'}`
    }));

    return c.json({ success: true, data: incidents, total: res.rows.length });
  } catch (err) {
    return c.json({ success: true, data: [], total: 0 });
  }
});

// ─── POST /incidents/:id/resolve — mark incident resolved ──────
securityRoutes.post('/incidents/:id/resolve', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id').replace('INC-', '');
  try {
    await pool.query('UPDATE security_events SET resolved = true WHERE id = $1', [id]);
    return c.json({ success: true, message: `Incident ${c.req.param('id')} resolved` });
  } catch {
    return c.json({ success: false, error: 'Failed to resolve incident' }, 500);
  }
});

// ─── GET /kill-chains — attack chain analysis ───────────────────
securityRoutes.get('/kill-chains', requireAuth, requireAdmin, async (c) => {
  const warden = getWardenStatus();
  return c.json({
    success: true,
    data: warden.kill_chains,
    phases: ['reconnaissance', 'weaponization', 'delivery', 'exploitation', 'installation', 'command_control', 'exfiltration'],
  });
});

export default securityRoutes;
