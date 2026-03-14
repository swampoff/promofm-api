/**
 * HEALTH ROUTES — Detailed system health endpoint
 */
import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import os from 'os';

const app = new Hono();

app.get('/detailed', async (c) => {
  const checks: Record<string, any> = {};
  
  // DB check
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    checks.database = { status: 'ok', latency_ms: Date.now() - start };
  } catch (e: any) {
    checks.database = { status: 'error', error: e.message };
  }
  
  // System info
  checks.system = {
    uptime_hours: Math.round(os.uptime() / 3600),
    memory_free_mb: Math.round(os.freemem() / 1048576),
    memory_total_mb: Math.round(os.totalmem() / 1048576),
    load_avg: os.loadavg(),
    node_version: process.version,
  };
  
  // Process info
  const mem = process.memoryUsage();
  checks.process = {
    heap_used_mb: Math.round(mem.heapUsed / 1048576),
    heap_total_mb: Math.round(mem.heapTotal / 1048576),
    rss_mb: Math.round(mem.rss / 1048576),
    uptime_hours: Math.round(process.uptime() / 3600),
  };
  
  const allOk = Object.values(checks).every(
    (c: any) => !c.status || c.status === 'ok'
  );
  
  return c.json({
    status: allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: 'beta-1.0',
    checks,
  });
});

export default app;
