/**
 * VK ID ticket for the promoair.ru sign-up (21.10.2026, docs/PROMOAIR.md §8).
 *
 * POST /auth/vk-air verifies a VK ID access token with VK and, when no account
 * matches, answers needsSignup with this ticket. The sign-up form sends it back
 * with the application; /auth/signup trusts only what the ticket says about the
 * VK account (id, e-mail, name, phone, avatar), never client fields.
 *
 * Format: base64url(JSON payload) + '.' + base64url(HMAC-SHA256), the same
 * HMAC pattern as unsub-token.tsx / track-url-token.tsx. Secret:
 * VK_AIR_TICKET_SECRET, else JWT_SECRET (always set). Lifetime 30 minutes.
 * Single use: the nonce `n` is stored in verification_tokens (type
 * 'vk_air_ticket') under an id derived with the secret, so the stored row is
 * not usable as any other token; sign-up marks it used atomically.
 */

import crypto from 'crypto';

export const VK_AIR_TICKET_TTL_S = 30 * 60;
export const VK_AIR_TICKET_TYPE = 'vk_air_ticket';

export interface VkAirTicket {
  v: 1;
  /** Nonce: single use (verification_tokens) */
  n: string;
  vkUserId: string;
  /** E-mail from VK (lower-case), null when VK gave none */
  email: string | null;
  /** true when `email` came from VK (then it counts as confirmed) */
  emailFromVk: boolean;
  name: string;
  phone: string | null;
  avatar: string | null;
  /** Unix seconds */
  exp: number;
}

function secret(): string {
  const s = process.env.VK_AIR_TICKET_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('VK_AIR_TICKET_SECRET or JWT_SECRET must be set');
  return s;
}

const b64url = (b: Buffer) => b.toString('base64url');
const mac = (body: string) => crypto.createHmac('sha256', secret()).update(`vk-air-ticket.v1.${body}`).digest();

export function signVkAirTicket(data: Omit<VkAirTicket, 'v' | 'n' | 'exp'>, nowMs: number = Date.now()): { ticket: string; payload: VkAirTicket } {
  const payload: VkAirTicket = { v: 1, n: crypto.randomBytes(16).toString('hex'), ...data, exp: Math.floor(nowMs / 1000) + VK_AIR_TICKET_TTL_S };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return { ticket: `${body}.${b64url(mac(body))}`, payload };
}

/** Payload of a genuine, unexpired ticket; null for anything else (forged, broken, expired). */
export function verifyVkAirTicket(ticket: unknown, nowMs: number = Date.now()): VkAirTicket | null {
  if (typeof ticket !== 'string' || ticket.length > 4096) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  const want = mac(body);
  let got: Buffer;
  try {
    got = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p: any;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!p || p.v !== 1 || typeof p.n !== 'string' || typeof p.vkUserId !== 'string' || !/^\d{1,20}$/.test(p.vkUserId)) return null;
  if (typeof p.exp !== 'number' || p.exp * 1000 <= nowMs) return null;
  return {
    v: 1,
    n: p.n,
    vkUserId: p.vkUserId,
    email: typeof p.email === 'string' && p.email ? p.email : null,
    emailFromVk: p.emailFromVk === true,
    name: typeof p.name === 'string' ? p.name : '',
    phone: typeof p.phone === 'string' && p.phone ? p.phone : null,
    avatar: typeof p.avatar === 'string' && p.avatar ? p.avatar : null,
    exp: p.exp,
  };
}

/** verification_tokens id of a ticket's nonce (derived with the secret, never sent to the client). */
export function vkAirTicketStoreId(nonce: string): string {
  return `vkair_${crypto.createHmac('sha256', secret()).update(`vk-air-nonce.v1.${nonce}`).digest('hex').slice(0, 40)}`;
}
