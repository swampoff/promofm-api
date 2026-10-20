/**
 * Security utilities — SSRF protection, input sanitization, error masking
 */

import { URL } from 'url';
import * as dns from 'dns';
import { promisify } from 'util';
import { createHash, timingSafeEqual } from 'crypto';

const dnsResolve = promisify(dns.resolve4);

// Private/reserved IP ranges (CIDR)
const PRIVATE_RANGES = [
  { start: 0x0A000000, end: 0x0AFFFFFF },   // 10.0.0.0/8
  { start: 0xAC100000, end: 0xAC1FFFFF },   // 172.16.0.0/12
  { start: 0xC0A80000, end: 0xC0A8FFFF },   // 192.168.0.0/16
  { start: 0x7F000000, end: 0x7FFFFFFF },   // 127.0.0.0/8
  { start: 0xA9FE0000, end: 0xA9FEFFFF },   // 169.254.0.0/16 (link-local + metadata)
  { start: 0x00000000, end: 0x00FFFFFF },   // 0.0.0.0/8
  { start: 0xC0000000, end: 0xC00000FF },   // 192.0.0.0/24
  { start: 0xC6120000, end: 0xC613FFFF },   // 198.18.0.0/15 (benchmarking)
];

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isPrivateIP(ip: string): boolean {
  // IPv6 loopback
  if (ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
    return true;
  }
  const num = ipToInt(ip);
  return PRIVATE_RANGES.some(r => num >= r.start && num <= r.end);
}

/**
 * Validate that a URL is safe to fetch (no SSRF)
 * - Only http/https schemes allowed
 * - Hostname must resolve to a public IP
 * - Blocks private/reserved/loopback IPs
 */
export async function isUrlSafe(urlStr: string): Promise<{ safe: boolean; reason?: string }> {
  try {
    const parsed = new URL(urlStr);

    // Only http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { safe: false, reason: 'Only http/https URLs allowed' };
    }

    // Block credentials in URL
    if (parsed.username || parsed.password) {
      return { safe: false, reason: 'URLs with credentials not allowed' };
    }

    const hostname = parsed.hostname;

    // Block direct IP access to common metadata endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return { safe: false, reason: 'Access to metadata service blocked' };
    }

    // Try to resolve hostname
    try {
      // Check if hostname is an IP literal
      const ipRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
      if (ipRegex.test(hostname)) {
        if (isPrivateIP(hostname)) {
          return { safe: false, reason: 'Access to private IP addresses blocked' };
        }
        return { safe: true };
      }

      // Resolve DNS
      const addresses = await dnsResolve(hostname);
      for (const addr of addresses) {
        if (isPrivateIP(addr)) {
          return { safe: false, reason: 'Hostname resolves to private IP (' + addr + ')' };
        }
      }
    } catch (dnsErr: any) {
      if (dnsErr.code === 'ENOTFOUND') {
        return { safe: false, reason: 'Hostname could not be resolved' };
      }
      // Allow through if DNS lookup fails for other reasons
    }

    return { safe: true };
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }
}

/**
 * Sanitize a URL string — validates format and checks SSRF safety
 */
export async function sanitizeUrl(url: string): Promise<string> {
  if (!url || typeof url !== 'string') throw new Error('Invalid URL');
  const trimmed = url.trim();
  const check = await isUrlSafe(trimmed);
  if (!check.safe) throw new Error(check.reason || 'URL blocked by security policy');
  return trimmed;
}

/**
 * Sanitize string input — strip control chars, enforce max length
 */
export function sanitizeString(input: unknown, maxLen = 1000): string {
  if (typeof input !== 'string') return '';
  // Remove control characters (except newline, tab) and HTML angle brackets
  const cleaned = input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[<>]/g, '');
  return cleaned.trim().slice(0, maxLen);
}

/**
 * Секрет крона (X-Cron-Secret / Bearer) против CRON_SECRET за постоянное время:
 * сравниваются sha256 обеих строк (одинаковая длина, timingSafeEqual не бросает),
 * так время ответа не выдаёт совпавший префикс. Пустой или не строка = false.
 */
export function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !provided || !expected) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Safe error message for API responses — hides internals in production
 */
export function safeErrorMessage(err: unknown, fallback = 'Internal server error'): string {
  if (process.env.NODE_ENV === 'development') {
    return err instanceof Error ? err.message : String(err);
  }
  // In production, only return generic messages
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Allow through known safe/expected errors
    if (msg.includes('not found') || msg.includes('not authorized') ||
        msg.includes('unauthorized') || msg.includes('forbidden') ||
        msg.includes('invalid') || msg.includes('required') ||
        msg.includes('already exists') || msg.includes('too large') ||
        msg.includes('too many')) {
      return err.message;
    }
  }
  return fallback;
}


// ─── SQL Injection Detection (defense-in-depth) ───────────────

const SQLI_PATTERNS = [
  /(\b(UNION)\b\s+\b(ALL\s+)?SELECT\b)/i,
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b\s+.*(FROM|INTO|TABLE|DATABASE)\b)/i,
  /(;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE)\b)/i,
  /(';\s*--)/,
  /(OR\s+['"]?1['"]?\s*=\s*['"]?1)/i,
  /(AND\s+['"]?1['"]?\s*=\s*['"]?1)/i,
  /(\bSLEEP\s*\(\s*\d+\s*\))/i,
  /(\bBENCHMARK\s*\()/i,
  /(\bWAITFOR\s+DELAY\b)/i,
  /(\bEXEC\s*\()/i,
  /(\bxp_cmdshell\b)/i,
  /(\bLOAD_FILE\s*\()/i,
  /(\bINTO\s+(OUT|DUMP)FILE\b)/i,
  /(0x[0-9a-fA-F]{8,})/,  // Long hex strings (encoded payloads)
  /(\bINFORMATION_SCHEMA\b)/i,
  /(\bpg_sleep\s*\()/i,
  /(\bCONCAT\s*\(.*0x)/i,
];

export function detectSqlInjection(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  return SQLI_PATTERNS.some(p => p.test(input));
}

/**
 * Deep scan object values for SQL injection patterns
 * Returns the first suspicious value found, or null if clean
 */
export function scanForSqlInjection(obj: unknown, depth = 0): string | null {
  if (depth > 5) return null; // prevent infinite recursion

  if (typeof obj === 'string') {
    if (detectSqlInjection(obj)) return obj;
    return null;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = scanForSqlInjection(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      const found = scanForSqlInjection(val, depth + 1);
      if (found) return found;
    }
  }

  return null;
}
