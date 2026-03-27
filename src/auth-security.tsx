/**
 * AUTH SECURITY MODULE
 * H5: Account lockout after N failed attempts
 * H6: reCAPTCHA v3 verification
 * H7: MFA/2FA (TOTP) setup & verify
 * H9: Refresh token management
 * H10: Telegram brute-force alerting
 */

import { Context, Next } from 'hono';
import { pool } from './db-client.tsx';
import crypto from 'crypto';

import { createLogger } from "./logger.tsx";

const log = createLogger("auth-sec");

// ─── H5: Account Lockout ───────────────────────────────────────

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const LOCKOUT_WINDOW_MINUTES = 30;

export async function checkAccountLockout(email: string, ip: string): Promise<{ locked: boolean; remainingMinutes?: number }> {
  try {
    const res = await pool.query(
      `SELECT COUNT(*) as cnt, MAX(created_at) as last_attempt
       FROM login_attempts
       WHERE email = $1 AND success = false
         AND created_at > NOW() - INTERVAL '${LOCKOUT_WINDOW_MINUTES} minutes'`,
      [email]
    );
    const count = parseInt(res.rows[0]?.cnt || '0');
    if (count >= MAX_FAILED_ATTEMPTS) {
      const lastAttempt = new Date(res.rows[0].last_attempt);
      const lockoutEnd = new Date(lastAttempt.getTime() + LOCKOUT_MINUTES * 60000);
      if (new Date() < lockoutEnd) {
        const remaining = Math.ceil((lockoutEnd.getTime() - Date.now()) / 60000);
        return { locked: true, remainingMinutes: remaining };
      }
    }
    return { locked: false };
  } catch (err) {
    log.error({ err }, 'lockout_check_error');
    return { locked: false };
  }
}

export async function recordLoginAttempt(email: string, ip: string, ua: string, success: boolean): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO login_attempts (email, ip_address, user_agent, success) VALUES ($1, $2, $3, $4)`,
      [email, ip, ua || '', success]
    );

    // H10: Check if brute-force threshold reached
    if (!success) {
      const res = await pool.query(
        `SELECT COUNT(*) as cnt FROM login_attempts
         WHERE ip_address = $1 AND success = false
           AND created_at > NOW() - INTERVAL '1 hour'`,
        [ip]
      );
      const ipFailCount = parseInt(res.rows[0]?.cnt || '0');
      if (ipFailCount === 10 || ipFailCount === 50 || ipFailCount === 100) {
        sendBruteForceAlert(email, ip, ipFailCount).catch(() => {});
      }
    }

    // Clear failed attempts on successful login
    if (success) {
      await pool.query(
        `DELETE FROM login_attempts WHERE email = $1 AND success = false`,
        [email]
      );
    }
  } catch (err) {
    log.error({ err }, 'lockout_record_error');
  }
}

export async function getFailedAttemptsCount(email: string): Promise<number> {
  try {
    const res = await pool.query(
      `SELECT COUNT(*) as cnt FROM login_attempts
       WHERE email = $1 AND success = false
         AND created_at > NOW() - INTERVAL '${LOCKOUT_WINDOW_MINUTES} minutes'`,
      [email]
    );
    return parseInt(res.rows[0]?.cnt || '0');
  } catch {
    return 0;
  }
}


// ─── H6: reCAPTCHA v3 ──────────────────────────────────────────

const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET_KEY || '';
const RECAPTCHA_MIN_SCORE = 0.5;

export async function verifyCaptcha(token: string | undefined, action: string): Promise<{ ok: boolean; score?: number; error?: string }> {
  // Skip if reCAPTCHA not configured (graceful degradation)
  if (!RECAPTCHA_SECRET) {
    return { ok: true, score: 1.0 };
  }
  if (!token) {
    return { ok: false, error: 'reCAPTCHA token required' };
  }

  try {
    const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: RECAPTCHA_SECRET,
        response: token,
      }).toString(),
    });
    const data = await resp.json() as { success: boolean; score?: number; action?: string; 'error-codes'?: string[] };

    if (!data.success) {
      return { ok: false, error: 'reCAPTCHA verification failed' };
    }
    if (data.score !== undefined && data.score < RECAPTCHA_MIN_SCORE) {
      return { ok: false, score: data.score, error: 'Suspicious activity detected' };
    }
    if (data.action && data.action !== action) {
      return { ok: false, error: 'reCAPTCHA action mismatch' };
    }
    return { ok: true, score: data.score };
  } catch (err) {
    log.error({ err }, 'captcha_verification_error');
    // Fail open — don't block users if Google is down
    return { ok: true, score: 0.5 };
  }
}

export function captchaMiddleware(action: string) {
  return async (c: Context, next: Next) => {
    if (!RECAPTCHA_SECRET) {
      await next();
      return;
    }
    const body = await c.req.json().catch(() => ({}));
    // Store parsed body for reuse
    c.set('parsedBody', body);
    const result = await verifyCaptcha(body.captchaToken, action);
    if (!result.ok) {
      return c.json({ success: false, error: result.error || 'CAPTCHA failed' }, 403);
    }
    await next();
  };
}


// ─── H7: MFA/2FA (TOTP) ────────────────────────────────────────

export async function setupMFA(userId: string): Promise<{ secret: string; qrCodeUrl: string; backupCodes: string[] }> {
  const { TOTP, Secret } = await import('otpauth');

  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: 'PromoMusic',
    label: 'promo-music.ru',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });

  // Generate 10 backup codes
  const backupCodes = Array.from({ length: 10 }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );

  // Hash backup codes for storage
  const hashedCodes = backupCodes.map(c => crypto.createHash('sha256').update(c).digest('hex'));

  // Store in DB (not enabled until verified)
  await pool.query(
    `INSERT INTO user_mfa (user_id, totp_secret, totp_enabled, backup_codes)
     VALUES ($1, $2, false, $3)
     ON CONFLICT (user_id) DO UPDATE SET totp_secret = $2, backup_codes = $3, totp_enabled = false`,
    [userId, secret.base32, hashedCodes]
  );

  const uri = totp.toString();

  // Generate QR code as data URL
  const QRCode = await import('qrcode');
  const qrCodeUrl = await QRCode.toDataURL(uri);

  return { secret: secret.base32, qrCodeUrl, backupCodes };
}

export async function verifyAndEnableMFA(userId: string, code: string): Promise<{ success: boolean; error?: string }> {
  const { TOTP, Secret } = await import('otpauth');

  const res = await pool.query(
    `SELECT totp_secret, totp_enabled FROM user_mfa WHERE user_id = $1`,
    [userId]
  );
  if (res.rows.length === 0) return { success: false, error: 'MFA not set up' };
  if (res.rows[0].totp_enabled) return { success: false, error: 'MFA already enabled' };

  const totp = new TOTP({
    issuer: 'PromoMusic',
    label: 'promo-music.ru',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(res.rows[0].totp_secret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return { success: false, error: 'Invalid code' };

  await pool.query(
    `UPDATE user_mfa SET totp_enabled = true, enabled_at = NOW() WHERE user_id = $1`,
    [userId]
  );

  return { success: true };
}

export async function verifyMFACode(userId: string, code: string): Promise<boolean> {
  const { TOTP, Secret } = await import('otpauth');

  const res = await pool.query(
    `SELECT totp_secret, totp_enabled, backup_codes FROM user_mfa WHERE user_id = $1`,
    [userId]
  );
  if (res.rows.length === 0 || !res.rows[0].totp_enabled) return false;

  // Try TOTP first
  const totp = new TOTP({
    issuer: 'PromoMusic',
    label: 'promo-music.ru',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(res.rows[0].totp_secret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta !== null) return true;

  // Try backup code
  const codeHash = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
  const backupCodes: string[] = res.rows[0].backup_codes || [];
  const codeIndex = backupCodes.indexOf(codeHash);
  if (codeIndex >= 0) {
    // Remove used backup code
    backupCodes.splice(codeIndex, 1);
    await pool.query(
      `UPDATE user_mfa SET backup_codes = $1 WHERE user_id = $2`,
      [backupCodes, userId]
    );
    return true;
  }

  return false;
}

export async function isMFAEnabled(userId: string): Promise<boolean> {
  try {
    const res = await pool.query(
      `SELECT totp_enabled FROM user_mfa WHERE user_id = $1`,
      [userId]
    );
    return res.rows.length > 0 && res.rows[0].totp_enabled === true;
  } catch {
    return false;
  }
}

export async function disableMFA(userId: string): Promise<void> {
  await pool.query(`DELETE FROM user_mfa WHERE user_id = $1`, [userId]);
}


// ─── H9: Refresh Tokens ────────────────────────────────────────

const REFRESH_TOKEN_DAYS = 30;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createRefreshToken(userId: string, ip: string, ua: string): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(48).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 3600 * 1000);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, tokenHash, ua || '', ip || '', expiresAt]
  );

  // Limit to 5 active refresh tokens per user (revoke oldest)
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL
       AND id NOT IN (
         SELECT id FROM refresh_tokens
         WHERE user_id = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 5
       )`,
    [userId]
  );

  return { token, expiresAt };
}

export async function validateRefreshToken(token: string): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const tokenHash = hashToken(token);

  const res = await pool.query(
    `SELECT user_id, expires_at, revoked_at FROM refresh_tokens
     WHERE token_hash = $1`,
    [tokenHash]
  );

  if (res.rows.length === 0) return { valid: false, error: 'Invalid refresh token' };

  const row = res.rows[0];
  if (row.revoked_at) return { valid: false, error: 'Token has been revoked' };
  if (new Date() > new Date(row.expires_at)) return { valid: false, error: 'Refresh token expired' };

  return { valid: true, userId: row.user_id };
}

export async function rotateRefreshToken(oldToken: string, userId: string, ip: string, ua: string): Promise<{ token: string; expiresAt: Date } | null> {
  const oldHash = hashToken(oldToken);

  // Revoke old token
  const res = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [oldHash, userId]
  );

  if (res.rows.length === 0) return null;

  // Issue new one
  return createRefreshToken(userId, ip, ua);
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
    [tokenHash]
  );
}


// ─── H10: Telegram Brute-Force Alert ───────────────────────────

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || process.env.TELEGRAM_LEAD_CHAT_ID || '';

async function sendBruteForceAlert(email: string, ip: string, count: number): Promise<void> {
  if (!TG_BOT_TOKEN || !TG_ALERT_CHAT_ID) return;

  const message = `🚨 *Brute-force Alert*\n\n` +
    `🔑 Target: \`${email}\`\n` +
    `🌐 IP: \`${ip}\`\n` +
    `❌ Failed attempts (1h): *${count}*\n` +
    `⏰ ${new Date().toISOString()}\n\n` +
    `Action: Consider blocking IP in firewall:\n` +
    `\`sudo ufw deny from ${ip}\``;

  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_ALERT_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    log.error({ err }, 'telegram_alert_error');
  }
}

export async function sendSecurityAlert(subject: string, details: string): Promise<void> {
  if (!TG_BOT_TOKEN || !TG_ALERT_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_ALERT_CHAT_ID,
        text: `⚠️ *Security: ${subject}*\n\n${details}\n\n⏰ ${new Date().toISOString()}`,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    log.error({ err }, 'telegram_alert_error');
  }
}
