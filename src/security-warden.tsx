/**
 * SECURITY WARDEN — SOC-level autonomous monitoring daemon
 *
 * Capabilities:
 * 1. File Integrity Monitoring (FIM) — SHA-256 checksums of critical files
 * 2. Process Monitoring — detect suspicious spawned processes
 * 3. Cron Job Auditing — detect unauthorized cron changes
 * 4. Outbound Connection Analysis — beacon/exfiltration detection
 * 5. Dependency Supply Chain Check — audit node_modules
 * 6. AbuseIPDB Reputation Check — rate suspicious IPs
 * 7. Kill Chain Correlation — link events into attack chains
 * 8. Telegram Alerting — instant incident notifications
 *
 * Runs as periodic timer inside the Node.js process (every 15 min).
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { pool } from './db-client.tsx';

// ─── CONFIGURATION ──────────────────────────────────────────────

const SCAN_INTERVAL = 15 * 60 * 1000;  // 15 minutes
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_SECURITY_CHAT = process.env.TELEGRAM_SECURITY_CHAT_ID || process.env.TELEGRAM_LEAD_CHAT_ID || '';
const ABUSEIPDB_KEY = process.env.ABUSEIPDB_API_KEY || '';

// Critical files to monitor (FIM)
const MONITORED_FILES = [
  '/opt/promofm-api/src/index.ts',
  '/opt/promofm-api/src/auth-routes.tsx',
  '/opt/promofm-api/src/auth-middleware.tsx',
  '/opt/promofm-api/src/auth-security.tsx',
  '/opt/promofm-api/src/security.tsx',
  '/opt/promofm-api/src/db-client.tsx',
  '/opt/promofm-api/src/rate-limiter.tsx',
  '/opt/promofm-api/src/checkout-routes.tsx',
  '/opt/promofm-api/src/storage-routes.tsx',
  '/opt/promofm-api/src/storage-setup.tsx',
  '/opt/promofm-api/package.json',
  '/opt/promofm-api/tsconfig.json',
  '/etc/nginx/sites-enabled/promofm',
  '/etc/systemd/system/promofm-api.service',
  '/etc/ssh/sshd_config',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/crontab',
];

// Suspicious outbound ports (beacon / exfiltration)
const SUSPICIOUS_PORTS = [
  4444, 5555, 8888, 9999,   // Common reverse shell ports
  1234, 31337, 6667, 6697,  // IRC, leet ports
  53,                        // DNS exfiltration (unusual for our app)
];

// Known malicious process names
const SUSPICIOUS_PROCESSES = [
  'cryptominer', 'xmrig', 'minerd', 'cpuminer',
  'kdevtmpfsi', 'kinsing', 'tsunamid', 'dovecat',
  'kerberods', 'sshd-keygen', 'ld-linux-x86',
  'bioset', 'watchbog', 'dbused', 'linux32',
];

// ─── STATE ──────────────────────────────────────────────────────

interface SecurityState {
  startTime: string;
  lastScan: string;
  scanCount: number;
  fileHashes: Record<string, string>;
  cronSnapshot: string;
  alerts: SecurityAlert[];
  killChains: KillChainEvent[];
  ipReputationCache: Record<string, { score: number; checkedAt: string }>;
}

interface SecurityAlert {
  timestamp: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  category: string;
  message: string;
  details?: string;
  mitre?: string;  // MITRE ATT&CK technique ID
}

interface KillChainEvent {
  timestamp: string;
  ip: string;
  phase: 'reconnaissance' | 'weaponization' | 'delivery' | 'exploitation' | 'installation' | 'command_control' | 'exfiltration';
  evidence: string;
}

const STATE_FILE = '/tmp/promofm-security-state.json';

let state: SecurityState = {
  startTime: new Date().toISOString(),
  lastScan: '',
  scanCount: 0,
  fileHashes: {},
  cronSnapshot: '',
  alerts: [],
  killChains: [],
  ipReputationCache: {},
};

function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) };
    }
  } catch {}
}

function saveState(): void {
  try {
    // Trim alerts to last 500
    if (state.alerts.length > 500) state.alerts = state.alerts.slice(-500);
    if (state.killChains.length > 200) state.killChains = state.killChains.slice(-200);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[WARDEN] Failed to save state:', err);
  }
}

function addAlert(alert: Omit<SecurityAlert, 'timestamp'>): void {
  const full: SecurityAlert = { ...alert, timestamp: new Date().toISOString() };
  state.alerts.push(full);
  const icon = { INFO: 'ℹ️', LOW: '🟡', MEDIUM: '🟠', HIGH: '🔴', CRITICAL: '🚨' }[full.severity];
  console.warn(`${icon} [WARDEN] ${full.severity} ${full.category}: ${full.message}`);

  if (full.severity === 'HIGH' || full.severity === 'CRITICAL') {
    sendSecurityAlert(full);
  }
}

// ─── TELEGRAM ALERTING ──────────────────────────────────────────

async function sendSecurityAlert(alert: SecurityAlert): Promise<void> {
  if (!TG_BOT_TOKEN || !TG_SECURITY_CHAT) return;
  const icon = { INFO: 'ℹ️', LOW: '🟡', MEDIUM: '🟠', HIGH: '🔴', CRITICAL: '🚨' }[alert.severity];
  const msg = `${icon} Security Warden Alert

Severity: ${alert.severity}
Category: ${alert.category}
Message: ${alert.message}
${alert.mitre ? `MITRE: ${alert.mitre}` : ''}
${alert.details ? `Details: ${alert.details.slice(0, 200)}` : ''}
Time: ${alert.timestamp}`;

  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_SECURITY_CHAT, text: msg }),
    });
  } catch {}
}

// ─── 1. FILE INTEGRITY MONITORING ───────────────────────────────

function computeFileHash(filepath: string): string | null {
  try {
    if (!fs.existsSync(filepath)) return null;
    const content = fs.readFileSync(filepath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function scanFileIntegrity(): void {
  const isFirstRun = Object.keys(state.fileHashes).length === 0;

  for (const filepath of MONITORED_FILES) {
    const hash = computeFileHash(filepath);
    if (hash === null) {
      if (state.fileHashes[filepath]) {
        addAlert({
          severity: 'CRITICAL', category: 'FIM',
          message: `Critical file DELETED: ${filepath}`,
          mitre: 'T1070.004 — Indicator Removal: File Deletion',
        });
      }
      continue;
    }

    if (isFirstRun) {
      state.fileHashes[filepath] = hash;
    } else if (state.fileHashes[filepath] && state.fileHashes[filepath] !== hash) {
      addAlert({
        severity: 'HIGH', category: 'FIM',
        message: `File modified: ${filepath}`,
        details: `Old hash: ${state.fileHashes[filepath].slice(0, 16)}... New hash: ${hash.slice(0, 16)}...`,
        mitre: 'T1565.001 — Data Manipulation: Stored Data',
      });
      state.fileHashes[filepath] = hash; // Update to new hash
    }
  }

  if (isFirstRun) {
    console.info(`[WARDEN] FIM baseline established: ${MONITORED_FILES.length} files hashed`);
  }
}

// ─── 2. PROCESS MONITORING ──────────────────────────────────────

function scanProcesses(): void {
  try {
    const ps = execSync('ps aux --no-headers 2>/dev/null || ps aux', { timeout: 5000 }).toString();
    const lines = ps.split('\n');

    for (const line of lines) {
      const lower = line.toLowerCase();
      for (const proc of SUSPICIOUS_PROCESSES) {
        if (lower.includes(proc)) {
          addAlert({
            severity: 'CRITICAL', category: 'MALWARE',
            message: `Suspicious process detected: ${proc}`,
            details: line.trim().slice(0, 200),
            mitre: 'T1496 — Resource Hijacking',
          });
        }
      }

      // Detect reverse shells
      if (lower.includes('/dev/tcp/') || lower.includes('mkfifo') ||
          (lower.includes('bash -i') && lower.includes('>&')) ||
          lower.includes('nc -e') || lower.includes('ncat -e')) {
        addAlert({
          severity: 'CRITICAL', category: 'REVERSE_SHELL',
          message: 'Possible reverse shell detected',
          details: line.trim().slice(0, 200),
          mitre: 'T1059.004 — Command & Scripting: Unix Shell',
        });
      }
    }
  } catch (err) {
    console.error('[WARDEN] Process scan error:', err);
  }
}

// ─── 3. CRON JOB AUDITING ───────────────────────────────────────

function scanCronJobs(): void {
  try {
    let cronContent = '';
    // System crontab
    try { cronContent += execSync('cat /etc/crontab 2>/dev/null', { timeout: 3000 }).toString(); } catch {}
    // User crontabs
    try { cronContent += execSync('crontab -l 2>/dev/null', { timeout: 3000 }).toString(); } catch {}
    // /etc/cron.d/
    try { cronContent += execSync('ls -la /etc/cron.d/ 2>/dev/null', { timeout: 3000 }).toString(); } catch {}

    if (state.cronSnapshot && state.cronSnapshot !== cronContent) {
      addAlert({
        severity: 'HIGH', category: 'CRON_CHANGE',
        message: 'Cron job configuration changed',
        details: `Previous length: ${state.cronSnapshot.length}, New length: ${cronContent.length}`,
        mitre: 'T1053.003 — Scheduled Task: Cron',
      });
    }
    state.cronSnapshot = cronContent;

    // Check for suspicious cron entries
    const suspiciousCron = [
      /curl.*\|.*(?:bash|sh)/i,
      /wget.*\|.*(?:bash|sh)/i,
      /python.*-c.*import/i,
      /\/tmp\/[a-z]+/i,
      /base64.*-d/i,
      /nohup.*&$/,
    ];

    for (const pattern of suspiciousCron) {
      if (pattern.test(cronContent)) {
        addAlert({
          severity: 'CRITICAL', category: 'CRON_MALICIOUS',
          message: `Suspicious cron entry detected: ${pattern.source}`,
          mitre: 'T1053.003 — Scheduled Task: Cron',
        });
      }
    }
  } catch (err) {
    console.error('[WARDEN] Cron scan error:', err);
  }
}

// ─── 4. OUTBOUND CONNECTION ANALYSIS ────────────────────────────

function scanOutboundConnections(): void {
  try {
    const connections = execSync('ss -tunp 2>/dev/null || netstat -tunp 2>/dev/null', { timeout: 5000 }).toString();
    const lines = connections.split('\n');

    for (const line of lines) {
      // Check for suspicious outbound ports
      for (const port of SUSPICIOUS_PORTS) {
        if (line.includes(`:${port}`) && line.includes('ESTAB')) {
          addAlert({
            severity: 'HIGH', category: 'BEACON',
            message: `Suspicious outbound connection on port ${port}`,
            details: line.trim().slice(0, 200),
            mitre: 'T1571 — Non-Standard Port',
          });
        }
      }

      // Detect high-frequency outbound connections (possible C2 beacon)
      if (line.includes('ESTAB') && !line.includes(':443') && !line.includes(':80') &&
          !line.includes(':5432') && !line.includes(':3000') && !line.includes(':22')) {
        // Non-standard port connections — log for correlation
        const match = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/g);
        if (match && match.length >= 2) {
          const remoteAddr = match[1];
          if (remoteAddr && !remoteAddr.startsWith('127.') && !remoteAddr.startsWith('10.') &&
              !remoteAddr.startsWith('192.168.') && !remoteAddr.startsWith('172.')) {
            // External non-standard connection — add to kill chain
            state.killChains.push({
              timestamp: new Date().toISOString(),
              ip: remoteAddr.split(':')[0],
              phase: 'command_control',
              evidence: line.trim().slice(0, 200),
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[WARDEN] Connection scan error:', err);
  }
}

// ─── 5. DEPENDENCY SUPPLY CHAIN CHECK ───────────────────────────

function scanDependencies(): void {
  try {
    // Check for recently modified node_modules (potential supply chain attack)
    const result = execSync(
      'find /opt/promofm-api/node_modules -name "*.js" -newer /opt/promofm-api/package-lock.json -type f 2>/dev/null | head -20',
      { timeout: 10000 }
    ).toString().trim();

    if (result) {
      const modifiedFiles = result.split('\n').filter(Boolean);
      if (modifiedFiles.length > 0) {
        addAlert({
          severity: 'HIGH', category: 'SUPPLY_CHAIN',
          message: `${modifiedFiles.length} node_modules files modified after package-lock.json`,
          details: modifiedFiles.slice(0, 5).join(', '),
          mitre: 'T1195.002 — Supply Chain: Compromise Software Supply Chain',
        });
      }
    }

    // Check for postinstall scripts with suspicious content
    const postinstalls = execSync(
      "grep -rl 'postinstall' /opt/promofm-api/node_modules/*/package.json 2>/dev/null | head -10",
      { timeout: 10000 }
    ).toString().trim();

    if (postinstalls) {
      const files = postinstalls.split('\n').filter(Boolean);
      for (const f of files) {
        try {
          const pkg = JSON.parse(fs.readFileSync(f, 'utf-8'));
          const script = pkg.scripts?.postinstall || '';
          if (script.includes('curl') || script.includes('wget') || script.includes('eval') ||
              script.includes('base64') || script.includes('/tmp/')) {
            addAlert({
              severity: 'CRITICAL', category: 'SUPPLY_CHAIN',
              message: `Suspicious postinstall script in ${f}`,
              details: script.slice(0, 200),
              mitre: 'T1195.002 — Supply Chain Compromise',
            });
          }
        } catch {}
      }
    }
  } catch (err) {
    // Not critical if this fails
  }
}

// ─── 6. ABUSEIPDB REPUTATION CHECK ──────────────────────────────

export async function checkIPReputation(ip: string): Promise<{ score: number; isMalicious: boolean }> {
  // Check cache first (valid for 1 hour)
  const cached = state.ipReputationCache[ip];
  if (cached && Date.now() - new Date(cached.checkedAt).getTime() < 3600000) {
    return { score: cached.score, isMalicious: cached.score > 50 };
  }

  if (!ABUSEIPDB_KEY) return { score: 0, isMalicious: false };

  try {
    const resp = await fetch(`https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`, {
      headers: { Key: ABUSEIPDB_KEY, Accept: 'application/json' },
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      const score = data?.data?.abuseConfidenceScore || 0;
      state.ipReputationCache[ip] = { score, checkedAt: new Date().toISOString() };
      return { score, isMalicious: score > 50 };
    }
  } catch {}
  return { score: 0, isMalicious: false };
}

// ─── 7. KILL CHAIN CORRELATION ──────────────────────────────────

function correlateKillChains(): void {
  // Group events by IP
  const ipEvents = new Map<string, KillChainEvent[]>();
  for (const e of state.killChains) {
    if (!ipEvents.has(e.ip)) ipEvents.set(e.ip, []);
    ipEvents.get(e.ip)!.push(e);
  }

  for (const [ip, events] of ipEvents) {
    const phases = new Set(events.map(e => e.phase));

    // If an IP has events in 3+ kill chain phases — likely an active attack
    if (phases.size >= 3) {
      addAlert({
        severity: 'CRITICAL', category: 'KILL_CHAIN',
        message: `Multi-phase attack detected from ${ip}`,
        details: `Phases: ${Array.from(phases).join(', ')} (${events.length} events)`,
        mitre: 'TA0001-TA0010 — Full Kill Chain',
      });
    }
  }
}

// ─── 8. AUTH LOG ANALYSIS ───────────────────────────────────────

async function scanAuthLogs(): Promise<void> {
  try {
    // Check for mass failed logins from DB
    const res = await pool.query(`
      SELECT ip_address, COUNT(*) as cnt
      FROM login_attempts
      WHERE success = false AND created_at > NOW() - INTERVAL '1 hour'
      GROUP BY ip_address
      HAVING COUNT(*) > 20
      ORDER BY cnt DESC LIMIT 10
    `);

    for (const row of res.rows) {
      addAlert({
        severity: 'HIGH', category: 'BRUTE_FORCE',
        message: `Mass login failures from ${row.ip_address}: ${row.cnt} attempts in 1h`,
        mitre: 'T1110 — Brute Force',
      });

      // Add to kill chain
      state.killChains.push({
        timestamp: new Date().toISOString(),
        ip: row.ip_address,
        phase: 'exploitation',
        evidence: `${row.cnt} failed logins in 1h`,
      });
    }

    // Check for credential stuffing (many different emails from same IP)
    const stuffing = await pool.query(`
      SELECT ip_address, COUNT(DISTINCT email) as email_count
      FROM login_attempts
      WHERE success = false AND created_at > NOW() - INTERVAL '1 hour'
      GROUP BY ip_address
      HAVING COUNT(DISTINCT email) > 10
      ORDER BY email_count DESC LIMIT 5
    `);

    for (const row of stuffing.rows) {
      addAlert({
        severity: 'CRITICAL', category: 'CREDENTIAL_STUFFING',
        message: `Credential stuffing from ${row.ip_address}: ${row.email_count} unique emails`,
        mitre: 'T1110.004 — Credential Stuffing',
      });
    }
  } catch (err) {
    // login_attempts table may not exist yet
  }
}

// ─── 9. PERMISSION CHANGES ─────────────────────────────────────

function scanPermissionChanges(): void {
  try {
    // Check for SUID/SGID files in writable directories
    const suidFiles = execSync(
      'find /opt/promofm-api /tmp /var/tmp -perm /6000 -type f 2>/dev/null | head -10',
      { timeout: 5000 }
    ).toString().trim();

    if (suidFiles) {
      for (const f of suidFiles.split('\n').filter(Boolean)) {
        addAlert({
          severity: 'HIGH', category: 'PRIV_ESC',
          message: `SUID/SGID file found: ${f}`,
          mitre: 'T1548.001 — SUID/SGID Abuse',
        });
      }
    }

    // Check for world-writable files in API directory
    const worldWritable = execSync(
      'find /opt/promofm-api/src -perm -o+w -type f 2>/dev/null | head -10',
      { timeout: 5000 }
    ).toString().trim();

    if (worldWritable) {
      addAlert({
        severity: 'MEDIUM', category: 'PERMISSIONS',
        message: `World-writable source files found`,
        details: worldWritable.split('\n').slice(0, 5).join(', '),
        mitre: 'T1222.002 — File & Directory Permissions Modification',
      });
    }
  } catch {}
}

// ─── 10. LOG DATABASE FOR SIEM QUERIES ──────────────────────────

async function persistAlertsToDb(): Promise<void> {
  try {
    // Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        mitre TEXT,
        ip TEXT,
        resolved BOOLEAN DEFAULT false
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_security_events_ts ON security_events(timestamp DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity)`);

    // Insert new HIGH/CRITICAL alerts
    const newAlerts = state.alerts.filter(a =>
      (a.severity === 'HIGH' || a.severity === 'CRITICAL') &&
      new Date(a.timestamp).getTime() > Date.now() - SCAN_INTERVAL - 60000
    );

    for (const alert of newAlerts) {
      await pool.query(
        `INSERT INTO security_events (timestamp, severity, category, message, details, mitre)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [alert.timestamp, alert.severity, alert.category, alert.message, alert.details || null, alert.mitre || null]
      );
    }
  } catch (err) {
    console.error('[WARDEN] DB persist error:', err);
  }
}

// ─── MAIN SCAN ORCHESTRATOR ─────────────────────────────────────

async function runFullScan(): Promise<void> {
  const start = Date.now();
  state.lastScan = new Date().toISOString();
  state.scanCount++;

  console.info(`[WARDEN] Scan #${state.scanCount} starting...`);

  try {
    // Phase 1: Passive checks (no network)
    scanFileIntegrity();
    scanProcesses();
    scanCronJobs();
    scanPermissionChanges();

    // Phase 2: Network checks
    scanOutboundConnections();

    // Phase 3: Database checks
    await scanAuthLogs();

    // Phase 4: Supply chain (less frequent — every 4th scan)
    if (state.scanCount % 4 === 0) {
      scanDependencies();
    }

    // Phase 5: Correlation
    correlateKillChains();

    // Phase 6: Persist
    await persistAlertsToDb();
    saveState();

    const duration = Date.now() - start;
    console.info(`[WARDEN] Scan #${state.scanCount} complete in ${duration}ms. Alerts: ${state.alerts.length}`);
  } catch (err) {
    console.error('[WARDEN] Scan error:', err);
  }
}

// ─── PUBLIC API ─────────────────────────────────────────────────

export function getWardenStatus() {
  return {
    agent_status: 'active',
    start_time: state.startTime,
    last_scan: state.lastScan,
    scan_count: state.scanCount,
    total_alerts: state.alerts.length,
    recent_alerts: state.alerts.slice(-50).reverse(),
    monitored_files: MONITORED_FILES.length,
    kill_chains: state.killChains.slice(-20).reverse(),
    ip_reputation_cache_size: Object.keys(state.ipReputationCache).length,
  };
}

export function getWardenAlerts(limit = 50, severity?: string): SecurityAlert[] {
  let alerts = state.alerts;
  if (severity) {
    alerts = alerts.filter(a => a.severity === severity.toUpperCase());
  }
  return alerts.slice(-limit).reverse();
}

// Update FIM baseline (after legitimate deploy)
export function updateFimBaseline(): void {
  state.fileHashes = {};
  scanFileIntegrity();
  saveState();
  console.info('[WARDEN] FIM baseline reset');
}

// ─── INIT & SCHEDULER ───────────────────────────────────────────

export function startSecurityWarden(): void {
  console.info('[WARDEN] Security Warden initializing...');
  loadState();

  // Initial scan after 30 sec (let the server start first)
  setTimeout(() => {
    runFullScan().catch(err => console.error('[WARDEN] Initial scan error:', err));
  }, 30000);

  // Periodic scan every 15 minutes
  setInterval(() => {
    runFullScan().catch(err => console.error('[WARDEN] Periodic scan error:', err));
  }, SCAN_INTERVAL);

  console.info(`[WARDEN] Scheduled: full scan every ${SCAN_INTERVAL / 60000} min`);
}
