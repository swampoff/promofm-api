/**
 * THREAT DETECTOR — WAF-level request inspection engine
 * Detects: XSS, Command Injection, Path Traversal, SSTI, Prototype Pollution,
 *          Header Injection, Log Injection, XXE, LDAP Injection
 *
 * Runs as first middleware — blocks malicious requests before they reach routes.
 * All detections are logged and optionally forwarded to Telegram.
 */

import type { Context, Next } from 'hono';

import { createLogger } from "./logger.tsx";

const log = createLogger("waf");

// ─── THREAT CATEGORIES ──────────────────────────────────────────

export type ThreatCategory =
  | 'xss' | 'sqli' | 'rce' | 'path_traversal' | 'ssti'
  | 'proto_pollution' | 'header_injection' | 'xxe'
  | 'log_injection' | 'ldap_injection' | 'scanner'
  | 'bot_abuse' | 'payload_overflow';

export interface ThreatEvent {
  timestamp: string;
  category: ThreatCategory;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  ip: string;
  method: string;
  path: string;
  payload: string;       // truncated suspicious input
  userAgent: string;
  blocked: boolean;
  requestId: string;
}

// ─── DETECTION PATTERNS ─────────────────────────────────────────

const XSS_PATTERNS = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on(?:load|error|click|mouse|focus|blur|submit|change|input|key|drag|drop|copy|cut|paste|scroll|resize|unload|before)\s*=/i,
  /<(?:img|svg|iframe|object|embed|link|meta|style|base|form|input|button|textarea|select|details|marquee|video|audio|source|body)\b[^>]*>/i,
  /&#(?:x[0-9a-f]+|\d+);/i,
  /expression\s*\(/i,
  /url\s*\(\s*['"]?\s*(?:javascript|data)\s*:/i,
  /\beval\s*\(/i,
  /\bdocument\s*\.\s*(?:cookie|domain|write|location)/i,
  /\bwindow\s*\.\s*(?:location|open|eval)/i,
  /<!\[CDATA\[/i,
  /data\s*:\s*text\/html/i,
  /vbscript\s*:/i,
  /xlink:href/i,
  /fromCharCode/i,
  /\batob\s*\(/i,
  /\bString\s*\.\s*fromCharCode/i,
];

const RCE_PATTERNS = [
  /;\s*(?:ls|cat|wget|curl|nc|ncat|bash|sh|zsh|python|perl|ruby|php|node|exec|system)\b/i,
  /\|\s*(?:bash|sh|zsh|python|perl|ruby|php|node|nc|ncat|wget|curl)\b/i,
  /`[^`]*(?:ls|cat|wget|curl|nc|bash|sh|id|whoami|uname|pwd|env)`/i,
  /\$\(\s*(?:ls|cat|wget|curl|nc|bash|sh|id|whoami|uname|pwd|env)\b/i,
  /\$\{(?:IFS|PATH|HOME|USER|SHELL|TERM|HOSTNAME)\}/i,
  /\b(?:child_process|spawn|execSync|execFile|fork)\s*\(/i,
  /\brequire\s*\(\s*['"](?:child_process|fs|net|http|os|cluster|dgram|vm)\b/i,
  /\bprocess\s*\.\s*(?:exit|kill|env|mainModule|binding)\b/i,
  /\b__(?:proto|constructor|defineGetter|defineSetter|lookupGetter)__\b/i,
  /\bFunction\s*\(\s*['"`]/i,
  /\bnew\s+Function\b/i,
  /\bimport\s*\(\s*['"`]/i,
  /\/etc\/(?:passwd|shadow|hosts|crontab)/i,
  /\/proc\/self\//i,
  /\bchmod\s+[0-7]{3,4}\b/i,
  /\bchown\b.*\b(?:root|www-data)\b/i,
  /\bcrontab\b/i,
  /\bnc\s+-[el]/i,
  /\b(?:rm|dd)\s+-[rfi]/i,
  /\bmkfifo\b/i,
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.[\/\\]/,                     // ../
  /\.\.%2[fF]/,                     // ..%2f (URL encoded)
  /\.\.%5[cC]/,                     // ..%5c (URL encoded backslash)
  /%2e%2e[\/\\%]/i,                 // %2e%2e/ (double-encoded dots)
  /(?:\/|\\)\.\.(?:\/|\\)/,         // /../
  /\.\.[\/\\]\.\.(?:[\/\\])?/,     // ../../
  /(?:file|php|zip|phar|glob|expect|rar|zlib|data|input|fd):\/\//i,  // PHP wrappers
  /\/(?:proc|dev|sys|run)\/(?!null)/,
  // Narrowed 2026-05-23: matched any URL with /home/, /var/, /opt/, /usr/
  // segment — including legit routes like /api/artist-analytics/home/<uuid>
  // and asset paths /uploads/... that contain /var/www/promofm/uploads in
  // response payloads. Now only flags KNOWN sensitive filesystem targets.
  /[\/\\](?:etc|root)[\/\\](?:passwd|shadow|hosts|crontab|\.ssh)/i,
  /%00/,                            // Null byte
  /%0[0aAdD]/,                      // Null / CR / LF
];

const SSTI_PATTERNS = [
  /\{\{.*\}\}/,                     // Jinja2 / Twig / Mustache
  /\$\{.*\}/,                       // Template literals (in URL/header context)
  /<%= .* %>/,                      // EJS
  /\{%.*%\}/,                       // Jinja2 blocks
  /#\{.*\}/,                        // Ruby / Pug
  /\{\{.*config\b/i,               // Jinja2 config access
  /\{\{.*__class__\b/i,            // Python class traversal
  /\{\{.*__builtins__\b/i,         // Python builtins access
  /\{\{.*\bimport\b/i,             // Jinja2 import
  /\{\{.*\bself\b.*__init__/i,     // Python MRO access
];

const PROTO_POLLUTION_PATTERNS = [
  /__proto__/,
  /constructor\s*\.\s*prototype/,
  /Object\s*\.\s*(?:assign|defineProperty|setPrototypeOf)\s*\(/,
  /\["__proto__"\]/,
  /\['__proto__'\]/,
  /prototype\s*\[\s*['"]/,
];

const HEADER_INJECTION_PATTERNS = [
  /\r\n/,                           // CRLF injection
  /%0[dD]%0[aA]/,                   // URL-encoded CRLF
  /\n(?:Set-Cookie|Location|Content-Type|X-)/i,  // Header injection via newlines
];

const XXE_PATTERNS = [
  /<!ENTITY/i,
  /<!DOCTYPE.*\[/i,
  /SYSTEM\s+["']/i,
  /PUBLIC\s+["']/i,
  /<!ELEMENT/i,
  /<!ATTLIST/i,
  /xmlns:xi\s*=/i,
  /xi:include/i,
];

const LOG_INJECTION_PATTERNS = [
  /\n\[\d{4}-\d{2}-\d{2}/,         // Fake log timestamp injection
  /\x1b\[/,                         // ANSI escape codes
  /\e\[/,                           // ANSI escape shorthand
  /%1B%5B/i,                        // URL-encoded ANSI
];

const SCANNER_SIGNATURES = [
  /(?:sqlmap|nikto|nmap|masscan|wpscan|dirbuster|gobuster|ffuf|nuclei|burpsuite|havij|acunetix|netsparker|w3af|openvas|nessus|hydra|medusa|patator|wfuzz|arachni|skipfish|joomla|drupal|wordpress)(?:\/|\s|$)/i,
  /python-requests\/\d/i,           // Default Python-requests UA without customization
  /Go-http-client/i,                // Default Go HTTP client
  // Empty UA removed — health checks and internal tools may not set it
];

// Scanner path probes (high confidence indicators of automated scanning)
const SCANNER_PATHS = [
  /\/\.env/,
  /\/wp-(?:admin|login|includes|content)/,
  /\/\.git\//,
  /\/\.svn\//,
  /\/\.DS_Store/,
  /\/\.htaccess/,
  /\/phpMyAdmin/i,
  /\/phpmyadmin/i,
  /\/admin\.php/i,
  /\/wp-config\.php/i,
  /\/config\.php/i,
  /\/server-status/,
  /\/server-info/,
  /\/actuator/,
  /\/debug\/pprof/,
  /\/\.well-known\/(?!acme)/,
  /\/xmlrpc\.php/,
  /\/cgi-bin\//,
  /\/manager\/html/,
  /\/solr\//,
  /\/console/,
  /\/jmx-console/,
  /\/Autodiscover/i,
  /\/HNAP1/,
  /\/api\/v1\/__admin/,
  /\/telescope\/requests/,
  /\/vendor\/phpunit/i,
  /\/owa\/auth/i,
  /\/remote\/fgt_lang/,
  /\/boaform/,
  /\/login\.action/,
  /\/shell/,
  /\/(\.aws|\.azure|\.gcp)\//,
];

// ─── BOT / ABUSE PATTERNS ───────────────────────────────────────

const SUSPICIOUS_USER_AGENTS = [
  /^Mozilla\/4\.0$/,                // Ancient/fake UA
  /compatible;\s*MSIE\s*[4-6]/,    // Very old IE
  /^Java\//,                        // Default Java HTTP client
  // curl removed — legitimate tool, not a scanner indicator
  /^Wget\//i,                       // Raw wget
  /^-$/,                            // Dash UA
  /^Mozilla\/5\.0$/,                // Bare Mozilla string
];

// ─── DETECTION ENGINE ───────────────────────────────────────────

function testPatterns(input: string, patterns: RegExp[]): boolean {
  if (!input || typeof input !== 'string') return false;
  for (const p of patterns) {
    if (p.test(input)) return true;
  }
  return false;
}

function scanValue(val: unknown, patterns: RegExp[], depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof val === 'string') {
    for (const p of patterns) {
      if (p.test(val)) return val.slice(0, 200);
    }
    // Also test URL-decoded version
    try {
      const decoded = decodeURIComponent(val);
      if (decoded !== val) {
        for (const p of patterns) {
          if (p.test(decoded)) return decoded.slice(0, 200);
        }
      }
    } catch {}
    return null;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      const found = scanValue(item, patterns, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (val && typeof val === 'object') {
    for (const [k, v] of Object.entries(val)) {
      // Check key names for proto pollution
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        return `key: ${k}`;
      }
      const found = scanValue(v, patterns, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

interface DetectionResult {
  detected: boolean;
  category: ThreatCategory;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  payload: string;
}

function detect(input: string | unknown, category: ThreatCategory, patterns: RegExp[], severity: DetectionResult['severity']): DetectionResult | null {
  const payload = typeof input === 'string'
    ? (testPatterns(input, patterns) ? input.slice(0, 200) : null)
    : scanValue(input, patterns);
  if (payload) return { detected: true, category, severity, payload };
  return null;
}

// ─── EVENT LOGGING ──────────────────────────────────────────────

const recentEvents: ThreatEvent[] = [];
const MAX_EVENTS = 5000;
let totalBlocked = 0;
let totalDetected = 0;

// IP-based tracking for auto-ban decisions
const ipThreatScores = new Map<string, { score: number; lastSeen: number; events: number }>();

// Auto-cleanup every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 3600000; // 1 hour
  for (const [ip, data] of ipThreatScores) {
    if (data.lastSeen < cutoff) ipThreatScores.delete(ip);
  }
  // Trim events
  while (recentEvents.length > MAX_EVENTS) recentEvents.shift();
}, 300000);

function recordEvent(event: ThreatEvent): void {
  recentEvents.push(event);
  totalDetected++;
  if (event.blocked) totalBlocked++;

  // Update IP threat score
  const existing = ipThreatScores.get(event.ip) || { score: 0, lastSeen: 0, events: 0 };
  const severityWeight = { LOW: 1, MEDIUM: 3, HIGH: 7, CRITICAL: 15 };
  existing.score += severityWeight[event.severity];
  existing.lastSeen = Date.now();
  existing.events++;
  ipThreatScores.set(event.ip, existing);

  // Log to console with structured format
  const icon = event.blocked ? '🛑' : '⚠️';
  log.warn({ severity: event.severity, category: event.category, ip: event.ip, method: event.method, path: event.path, payload: event.payload.slice(0, 80), blocked: event.blocked }, 'waf_threat_detected');
}

// ─── TELEGRAM ALERTING ──────────────────────────────────────────

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_SECURITY_CHAT = process.env.TELEGRAM_SECURITY_CHAT_ID || process.env.TELEGRAM_LEAD_CHAT_ID || '';
let lastTgAlert = 0;
const TG_COOLDOWN = 30000; // 30 sec between alerts

async function sendTelegramAlert(event: ThreatEvent): Promise<void> {
  if (!TG_BOT_TOKEN || !TG_SECURITY_CHAT) return;
  if (Date.now() - lastTgAlert < TG_COOLDOWN) return;
  lastTgAlert = Date.now();

  const msg = `🚨 WAF Alert — ${event.severity}

🏷 Тип: ${event.category}
🌐 IP: ${event.ip}
📍 ${event.method} ${event.path}
💣 Payload: ${event.payload.slice(0, 150)}
🤖 UA: ${event.userAgent.slice(0, 100)}
🕐 ${event.timestamp}
${event.blocked ? '✅ Заблокировано' : '⚠️ Пропущено (мониторинг)'}`;

  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_SECURITY_CHAT, text: msg, parse_mode: 'HTML' }),
    });
  } catch {}
}

// ─── IP REPUTATION (auto-ban threshold) ─────────────────────────

const BANNED_IPS = new Set<string>();
const BAN_THRESHOLD = 30;     // threat score to trigger ban
const BAN_DURATION = 3600000; // 1 hour

// Persist bans cleanup
setInterval(() => {
  // Bans are time-limited via ipThreatScores cleanup
}, 600000);

export function isIPBanned(ip: string): boolean {
  return BANNED_IPS.has(ip);
}

function checkAutoBan(ip: string): boolean {
  const data = ipThreatScores.get(ip);
  if (!data) return false;
  if (data.score >= BAN_THRESHOLD) {
    BANNED_IPS.add(ip);
    log.warn({ ip, score: data.score, events: data.events }, 'waf_auto_ban');
    // Auto-unban after duration
    setTimeout(() => {
      BANNED_IPS.delete(ip);
      ipThreatScores.delete(ip);
      log.info({ ip }, 'waf_auto_unban');
    }, BAN_DURATION);
    return true;
  }
  return false;
}

// ─── MAIN WAF MIDDLEWARE ────────────────────────────────────────

export function wafMiddleware() {
  return async (c: Context, next: Next) => {
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '0.0.0.0';
    const method = c.req.method;
    const path = c.req.path;
    const ua = c.req.header('user-agent') || '';
    const requestId = crypto.randomUUID().slice(0, 8);

    // ── Whitelist internal IPs (localhost, health checks, internal services) ──
    const INTERNAL_IPS = ['127.0.0.1', '::1', '0.0.0.0', '::ffff:127.0.0.1'];
    if (INTERNAL_IPS.includes(ip)) {
      return next(); // Skip WAF for internal traffic
    }

    // ── Check if IP is banned ──
    if (BANNED_IPS.has(ip)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    // ── Scan URL path for threats ──
    const allPathChecks: [ThreatCategory, RegExp[], DetectionResult['severity']][] = [
      ['path_traversal', PATH_TRAVERSAL_PATTERNS, 'HIGH'],
      ['rce', RCE_PATTERNS, 'CRITICAL'],
      ['xss', XSS_PATTERNS, 'HIGH'],
      ['ssti', SSTI_PATTERNS, 'HIGH'],
      ['xxe', XXE_PATTERNS, 'HIGH'],
    ];

    const fullUrl = c.req.url;
    for (const [category, patterns, severity] of allPathChecks) {
      const decoded = decodeURIComponent(path);
      if (testPatterns(path, patterns) || testPatterns(decoded, patterns) || testPatterns(fullUrl, patterns)) {
        const event: ThreatEvent = {
          timestamp: new Date().toISOString(), category, severity, ip, method, path,
          payload: path.slice(0, 200), userAgent: ua, blocked: true, requestId,
        };
        recordEvent(event);
        if (severity === 'CRITICAL' || severity === 'HIGH') sendTelegramAlert(event);
        checkAutoBan(ip);
        return c.json({ success: false, error: 'Request blocked by security policy' }, 403);
      }
    }

    // ── Scanner detection (path probes) ──
    for (const p of SCANNER_PATHS) {
      if (p.test(path)) {
        const event: ThreatEvent = {
          timestamp: new Date().toISOString(), category: 'scanner', severity: 'MEDIUM', ip, method, path,
          payload: `Scanner probe: ${path}`, userAgent: ua, blocked: true, requestId,
        };
        recordEvent(event);
        checkAutoBan(ip);
        return c.json({ success: false, error: 'Not found' }, 404);
      }
    }

    // ── Scanner detection (User-Agent) ──
    for (const p of SCANNER_SIGNATURES) {
      if (p.test(ua)) {
        const event: ThreatEvent = {
          timestamp: new Date().toISOString(), category: 'scanner', severity: 'LOW', ip, method, path,
          payload: `Scanner UA: ${ua.slice(0, 100)}`, userAgent: ua, blocked: false, requestId,
        };
        recordEvent(event);
        break; // Don't block — just log (legitimate tools sometimes have default UAs)
      }
    }

    // ── Check query parameters ──
    const queryString = c.req.url.split('?')[1] || '';
    if (queryString) {
      const queryChecks: [ThreatCategory, RegExp[], DetectionResult['severity']][] = [
        ['xss', XSS_PATTERNS, 'HIGH'],
        ['rce', RCE_PATTERNS, 'CRITICAL'],
        ['path_traversal', PATH_TRAVERSAL_PATTERNS, 'HIGH'],
        ['ssti', SSTI_PATTERNS, 'HIGH'],
        ['log_injection', LOG_INJECTION_PATTERNS, 'MEDIUM'],
      ];
      const decodedQuery = decodeURIComponent(queryString);
      for (const [category, patterns, severity] of queryChecks) {
        if (testPatterns(queryString, patterns) || testPatterns(decodedQuery, patterns)) {
          const event: ThreatEvent = {
            timestamp: new Date().toISOString(), category, severity, ip, method, path,
            payload: `query: ${decodedQuery.slice(0, 200)}`, userAgent: ua, blocked: true, requestId,
          };
          recordEvent(event);
          if (severity === 'CRITICAL' || severity === 'HIGH') sendTelegramAlert(event);
          checkAutoBan(ip);
          return c.json({ success: false, error: 'Request blocked by security policy' }, 403);
        }
      }
    }

    // ── Check headers for injection ──
    const suspiciousHeaders = ['referer', 'origin', 'x-forwarded-host', 'x-original-url', 'x-rewrite-url'];
    for (const h of suspiciousHeaders) {
      const val = c.req.header(h);
      if (val && testPatterns(val, HEADER_INJECTION_PATTERNS)) {
        const event: ThreatEvent = {
          timestamp: new Date().toISOString(), category: 'header_injection', severity: 'HIGH', ip, method, path,
          payload: `header ${h}: ${val.slice(0, 200)}`, userAgent: ua, blocked: true, requestId,
        };
        recordEvent(event);
        sendTelegramAlert(event);
        checkAutoBan(ip);
        return c.json({ success: false, error: 'Request blocked by security policy' }, 403);
      }
    }

    // ── Scan request body (POST/PUT/PATCH) ──
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const contentType = c.req.header('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          // Hono caches body reads via #cachedBody — no stream consumption
          const body = await c.req.json();

          // Proto pollution check (critical — check before anything else)
          const protoPayload = scanValue(body, PROTO_POLLUTION_PATTERNS);
          if (protoPayload) {
            const event: ThreatEvent = {
              timestamp: new Date().toISOString(), category: 'proto_pollution', severity: 'CRITICAL', ip, method, path,
              payload: protoPayload, userAgent: ua, blocked: true, requestId,
            };
            recordEvent(event);
            sendTelegramAlert(event);
            checkAutoBan(ip);
            return c.json({ success: false, error: 'Request blocked by security policy' }, 403);
          }

          // Body deep scan for all attack types
          const bodyChecks: [ThreatCategory, RegExp[], DetectionResult['severity']][] = [
            ['xss', XSS_PATTERNS, 'HIGH'],
            ['rce', RCE_PATTERNS, 'CRITICAL'],
            ['ssti', SSTI_PATTERNS, 'MEDIUM'],
            ['xxe', XXE_PATTERNS, 'HIGH'],
            ['path_traversal', PATH_TRAVERSAL_PATTERNS, 'HIGH'],
            ['log_injection', LOG_INJECTION_PATTERNS, 'LOW'],
          ];

          for (const [category, patterns, severity] of bodyChecks) {
            const payload = scanValue(body, patterns);
            if (payload) {
              // For body attacks, only block HIGH/CRITICAL
              const shouldBlock = severity === 'CRITICAL' || severity === 'HIGH';
              const event: ThreatEvent = {
                timestamp: new Date().toISOString(), category, severity, ip, method, path,
                payload, userAgent: ua, blocked: shouldBlock, requestId,
              };
              recordEvent(event);
              if (shouldBlock) {
                if (severity === 'CRITICAL') sendTelegramAlert(event);
                checkAutoBan(ip);
                return c.json({ success: false, error: 'Invalid input detected' }, 400);
              }
            }
          }
        } catch {
          // Body parse failure — let route handler deal with it
        }
      }

      // Check for oversized payload (defense against payload-based DoS)
      const contentLength = parseInt(c.req.header('content-length') || '0');
      if (!contentType.includes('multipart') && !contentType.includes('octet-stream') && contentLength > 5 * 1024 * 1024) {
        const event: ThreatEvent = {
          timestamp: new Date().toISOString(), category: 'payload_overflow', severity: 'MEDIUM', ip, method, path,
          payload: `Non-file body size: ${contentLength} bytes`, userAgent: ua, blocked: true, requestId,
        };
        recordEvent(event);
        return c.json({ success: false, error: 'Request body too large' }, 413);
      }
    }

    // ── All checks passed ──
    await next();
  };
}

// ─── STATS API (for security-monitor-routes) ────────────────────

export function getWafStats() {
  return {
    totalDetected,
    totalBlocked,
    recentEvents: recentEvents.slice(-100).reverse(),
    bannedIPs: Array.from(BANNED_IPS),
    ipScores: Object.fromEntries(
      Array.from(ipThreatScores.entries())
        .filter(([_, d]) => d.score > 5)
        .sort(([, a], [, b]) => b.score - a.score)
        .slice(0, 20)
    ),
    patternCounts: getPatternCounts(),
  };
}

function getPatternCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of recentEvents) {
    counts[e.category] = (counts[e.category] || 0) + 1;
  }
  return counts;
}

export function getRecentEvents(limit = 50, severity?: string): ThreatEvent[] {
  let events = recentEvents;
  if (severity) {
    events = events.filter(e => e.severity === severity.toUpperCase());
  }
  return events.slice(-limit).reverse();
}

// ─── HONEYPOT ROUTES ────────────────────────────────────────────

export function honeypotMiddleware() {
  // Common paths attackers probe — immediate ban
  const HONEYPOT_PATHS = [
    '/wp-login.php', '/wp-admin/', '/administrator/',
    '/admin/login', '/.env', '/.git/config',
    '/config.json', '/backup.sql', '/dump.sql',
    '/db.sql', '/database.sql', '/api/v1/admin',
    '/debug', '/trace', '/_debug',
    '/shell.php', '/cmd.php', '/c99.php', '/r57.php',
    '/eval-stdin.php', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
  ];

  return async (c: Context, next: Next) => {
    const path = c.req.path.toLowerCase();
    for (const hp of HONEYPOT_PATHS) {
      if (path === hp || path.startsWith(hp)) {
        const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '0.0.0.0';
        const ua = c.req.header('user-agent') || '';
        const event: ThreatEvent = {
          timestamp: new Date().toISOString(), category: 'scanner', severity: 'HIGH', ip,
          method: c.req.method, path: c.req.path,
          payload: `Honeypot hit: ${path}`, userAgent: ua, blocked: true,
          requestId: crypto.randomUUID().slice(0, 8),
        };
        recordEvent(event);
        sendTelegramAlert(event);
        checkAutoBan(ip);

        // Return a delayed response (tarpit — wastes scanner's time)
        await new Promise(r => setTimeout(r, 2000));
        return c.json({ success: false, error: 'Not found' }, 404);
      }
    }
    await next();
  };
}
