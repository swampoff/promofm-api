/**
 * Security Monitor Routes — Admin dashboard API for security agent data
 * Reads state from /tmp/promofm-security-state.json (written by Python agent)
 */
import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import * as fs from 'fs';

const STATE_FILE = '/tmp/promofm-security-state.json';

const securityRoutes = new Hono();

function readState(): any {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {}
  return { agent_status: 'unknown', recent_events: [], total_alerts: 0, total_blocked: 0 };
}

// GET /status — current security agent status
securityRoutes.get('/status', requireAuth, requireAdmin, async (c) => {
  const state = readState();
  return c.json({
    success: true,
    data: {
      agent_status: state.agent_status || 'unknown',
      start_time: state.start_time,
      last_update: state.last_update,
      total_alerts: state.total_alerts || 0,
      total_blocked: state.total_blocked || 0,
      health_failures: state.health_failures || 0,
    },
  });
});

// GET /events — recent security events
securityRoutes.get('/events', requireAuth, requireAdmin, async (c) => {
  const state = readState();
  const limit = parseInt(c.req.query('limit') || '50');
  const severity = c.req.query('severity');

  let events = state.recent_events || [];
  if (severity) {
    events = events.filter((e: any) => e.severity === severity.toUpperCase());
  }

  return c.json({
    success: true,
    data: events.slice(-limit).reverse(),
    total: events.length,
  });
});

// GET /stats — aggregate security stats
securityRoutes.get('/stats', requireAuth, requireAdmin, async (c) => {
  const state = readState();
  const events = state.recent_events || [];

  const bySeverity: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const e of events) {
    bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  return c.json({
    success: true,
    data: {
      total_events: events.length,
      total_alerts: state.total_alerts || 0,
      total_blocked: state.total_blocked || 0,
      by_severity: bySeverity,
      by_type: byType,
      known_admin_ips: state.known_admin_ips || [],
      agent_uptime: state.start_time,
    },
  });
});

export default securityRoutes;
