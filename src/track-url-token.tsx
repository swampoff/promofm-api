/**
 * TRACK-URL TOKEN — HMAC-SHA256 подпись для click-tracking redirect.
 *
 * Audit 2026-06-03 (open redirect): GET /email-campaigns/track/click
 * раньше делал `c.redirect(c.req.query('url'), 302)` с полностью
 * контролируемым url. Любой мог скрафтить
 *   https://promofm.org/server/api/email-campaigns/track/click?url=https://evil.com
 * — ссылка на доверенном домене проходит спам-фильтры и доверие юзера,
 * затем редиректит на фишинг (open-redirect → phishing amplification).
 *
 * Защита: при инжекте click-tracking'а (injectClickTracking, server-side
 * на этапе отправки) подписываем целевой url HMAC'ом. Endpoint редиректит
 * на произвольный host ТОЛЬКО если sig валиден — атакующий не может
 * подделать его без секрета. Невалидный/отсутствующий sig → редирект
 * разрешён лишь на собственные домены (own-domain redirect бесполезен
 * для фишинга), иначе homepage.
 *
 * Секрет — тот же resolution что у unsub-token (EMAIL_TRACK_SECRET →
 * JWT_SECRET fallback). Подпись 32 hex (128-bit) — достаточно, это не
 * auth-token, а tamper-guard на redirect-target.
 */

import crypto from 'crypto';
import { ALLOWED_HOSTS } from './site-origin.tsx';

function getSecret(): string {
  const s = process.env.EMAIL_TRACK_SECRET || process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!s) {
    throw new Error('EMAIL_TRACK_SECRET / UNSUBSCRIBE_SECRET / JWT_SECRET must be set');
  }
  return s;
}

/** Подпись redirect-URL. Возвращает 32 hex. */
export function signRedirectUrl(url: string): string {
  return crypto
    .createHmac('sha256', getSecret())
    .update(url)
    .digest('hex')
    .slice(0, 32);
}

/** Constant-time проверка подписи. */
export function verifyRedirectUrl(url: string, sig: unknown): boolean {
  if (!url || !sig || typeof sig !== 'string') return false;
  const expected = signRedirectUrl(url);
  if (expected.length !== sig.length) return false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Собственные домены — на них redirect без подписи безопасен (нельзя
// использовать для фишинг-амплификации, т.к. цель на доверенном сайте).
// Список общий с CORS и return URL (site-origin.tsx); promoair.ru в нём только
// при включённом PROMOAIR_ORIGIN.
const OWN_REDIRECT_HOSTS = new Set(ALLOWED_HOSTS);

/**
 * Решение о редиректе.
 *  - sig валиден → safe: true (подписано нами при отправке, любой host)
 *  - нет/невалид sig, но host собственный → safe: true (legacy-письма
 *    со ссылками на свой сайт продолжают работать)
 *  - нет/невалид sig + внешний host → safe: false (блок open-redirect)
 */
export function isRedirectAllowed(url: string, sig: unknown): boolean {
  if (verifyRedirectUrl(url, sig)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return OWN_REDIRECT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
