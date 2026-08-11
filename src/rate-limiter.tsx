/**
 * In-memory sliding window rate limiter for Hono
 * No external dependencies — Map-based with auto-cleanup
 */

import type { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimiterOptions {
  windowMs: number;    // Time window in milliseconds
  max: number;         // Max requests per window
  keyFn?: (c: Context) => string;  // Custom key function (default: IP)
  message?: string;    // Custom error message
  skip?: (c: Context) => boolean;  // Optional bypass predicate
}

// Superadmin-only bypass — System Test fires ~64 batched calls and would
// otherwise blow through apiLimiter (200/min). Narrowed 2026-05-31 from
// "any admin role" to "the one superadmin email" — see audit B-1. Any
// compromised admin-role JWT was previously bypassing rate limits on ALL
// /server/api/* endpoints (LLM-spend abuse, email-campaign spam, etc.).
function isSuperadminToken(c: Context): boolean {
  const auth = c.req.header('Authorization');
  const token = auth?.replace('Bearer ', '');
  if (!token || !process.env.JWT_SECRET) return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }) as any;
    const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'n.moiseev@gmx.de';
    return (decoded?.role === 'admin' || decoded?.role === 'superadmin')
        && decoded?.email === SUPERADMIN_EMAIL;
  } catch {
    return false;
  }
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

// Auto-cleanup every 60s
setInterval(() => {
  const now = Date.now();
  for (const [_name, store] of stores) {
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter(t => now - t < 300000); // 5 min max
      if (entry.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }
}, 60000);

function getClientIP(c: Context): string {
  return c.req.header('x-real-ip') ||
         c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
         '0.0.0.0';
}

export function createRateLimiter(name: string, options: RateLimiterOptions) {
  const { windowMs, max, message = 'Too many requests, please try again later' } = options;

  if (!stores.has(name)) {
    stores.set(name, new Map());
  }
  const store = stores.get(name)!;

  return async (c: Context, next: Next) => {
    if (options.skip && options.skip(c)) {
      await next();
      return;
    }
    const key = options.keyFn ? options.keyFn(c) : getClientIP(c);
    const now = Date.now();

    let entry = store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Remove timestamps outside window
    entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);

    if (entry.timestamps.length >= max) {
      const retryAfter = Math.ceil((entry.timestamps[0] + windowMs - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      c.header('X-RateLimit-Limit', String(max));
      c.header('X-RateLimit-Remaining', '0');
      return c.json({ success: false, error: message }, 429);
    }

    entry.timestamps.push(now);
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(max - entry.timestamps.length));
    await next();
  };
}

// Presets
export const authLimiter = createRateLimiter('auth', {
  windowMs: 60000,   // 1 minute
  max: 10,           // 10 requests per minute
  message: 'Too many authentication attempts, please try again in a minute',
});

export const uploadLimiter = createRateLimiter('upload', {
  windowMs: 60000,
  max: 15,
  message: 'Too many upload requests, please try again later',
});

export const apiLimiter = createRateLimiter('api', {
  windowMs: 60000,
  max: 200,          // 200 requests per minute per IP
  message: 'Rate limit exceeded, please slow down',
  skip: isSuperadminToken,
});

// Audit B-A2 (2026-05-31): destructive self-service endpoints (PUT /profile,
// DELETE track, request-verification) не имели лимита. Артист с украденным
// токеном через XSS (INC-A2) мог в burst удалить все треки / спамить
// verification-team. 5/min per IP — достаточно для legit UX (никто не правит
// профиль чаще), узко для abuse.
export const profileLimiter = createRateLimiter('profile', {
  windowMs: 60000,
  max: 5,
  message: 'Too many profile actions, please slow down',
});

// Настройки кабинета. Автосейв формы шлёт PUT при каждом изменении, поэтому
// порог выше профильного, но конечный: инцидент 2026-08-05 — одна зависшая
// вкладка отправила ~127 000 запросов, из них 18 599 приняты именно этим
// эндпоинтом (лимита на нём не было). 20/мин с запасом покрывает живую
// правку формы и гасит зацикленный автосейв.
export const settingsLimiter = createRateLimiter('settings', {
  windowMs: 60000,
  max: 20,
  message: 'Слишком часто сохраняются настройки, подождите минуту',
});

/**
 * Учёт прослушиваний. Эндпоинт публичный (слушают и незалогиненные с
 * лендинга), поэтому лимит нужен обязательно — см. шторм автосейва
 * 2026-08-05, когда одна вкладка дала 127к запросов. 60/мин с запасом
 * перекрывает живого слушателя: событие шлётся один раз на трек.
 */
export const playLimiter = createRateLimiter('play', {
  windowMs: 60_000,
  max: 60,
});
