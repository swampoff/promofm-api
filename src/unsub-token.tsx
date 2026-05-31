/**
 * UNSUBSCRIBE TOKEN — HMAC-SHA256 signed token для List-Unsubscribe ссылок.
 *
 * Audit B-7 (2026-05-31): /email-campaigns/unsubscribe раньше принимал
 * любой email без верификации → mass-unsubscribe guess-by-email attack
 * (просто POST {"email":"victim@..."}). Signed token закрывает:
 * атакующий не может сгенерить sig без UNSUBSCRIBE_SECRET, значит
 * unsub возможен только из реально полученного email.
 *
 * Token format в URL: ?email=...&t=<unix_seconds>&sig=<32-hex>
 * (32 hex = первые 16 байт HMAC-SHA256 → 128-bit security, достаточно
 *  для unsub-action — это не auth token).
 *
 * Secret resolution:
 *   1. process.env.UNSUBSCRIBE_SECRET — preferred, отдельный secret
 *   2. process.env.JWT_SECRET — fallback (всегда есть). Если JWT_SECRET
 *      ротируется — старые unsub-link'и инвалидируются (приемлемо).
 *
 * TTL: 365 дней. Email-кампания может «доходить» дольше (inbox latency),
 * но через год token истекает — это soft защита от leaked-link replay.
 *
 * Backward compatibility: endpoint accept'ит request БЕЗ token (legacy
 * emails, отправленные до 2026-05-31) но логирует warning. После
 * migration window (~2 weeks) можно ужесточить до strict-required
 * через ENV STRICT_UNSUB_TOKEN=true (см. email-campaigns-routes.tsx).
 */

import crypto from 'crypto';

const TTL_SECONDS = 365 * 24 * 60 * 60; // 365 days

function getSecret(): string {
  const s = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!s) {
    throw new Error('UNSUBSCRIBE_SECRET or JWT_SECRET must be set');
  }
  return s;
}

function sign(email: string, timestamp: number): string {
  const payload = `${email.toLowerCase()}|${timestamp}`;
  return crypto
    .createHmac('sha256', getSecret())
    .update(payload)
    .digest('hex')
    .slice(0, 32);
}

export interface UnsubTokenParts {
  t: number;       // unix seconds
  sig: string;     // 32 hex chars
}

/** Generate token parts for inclusion in unsub URL. */
export function generateUnsubToken(email: string): UnsubTokenParts {
  const t = Math.floor(Date.now() / 1000);
  return { t, sig: sign(email, t) };
}

export type UnsubVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' };

/**
 * Verify token. Constant-time comparison to prevent timing side-channel.
 * Returns granular reason so caller can log/respond accordingly.
 */
export function verifyUnsubToken(email: string, t: unknown, sig: unknown): UnsubVerifyResult {
  if (!t || !sig || typeof sig !== 'string') return { ok: false, reason: 'missing' };
  const ts = typeof t === 'number' ? t : parseInt(String(t), 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid' };

  const now = Math.floor(Date.now() / 1000);
  if (now - ts > TTL_SECONDS) return { ok: false, reason: 'expired' };
  // Tokens issued in the future (>5min clock skew) are also invalid.
  if (ts - now > 300) return { ok: false, reason: 'invalid' };

  const expected = sign(email, ts);
  if (expected.length !== sig.length) return { ok: false, reason: 'invalid' };

  // Constant-time compare.
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'invalid' };
    return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
