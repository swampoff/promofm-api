/**
 * SITE ORIGIN: какой из наших сайтов обслуживает запрос и куда вести ссылки.
 *
 * PROMO.AIR (promoair.ru) работает на том же API, базе и сессиях, что и
 * promo-music.ru. Письма, редиректы и return URL ЮKassa должны вести на тот
 * сайт, откуда пришёл запрос или где человек зарегистрировался.
 *
 * Гейт: env PROMOAIR_ORIGIN (https://promoair.ru). Пусто = всё как раньше:
 * promoair.ru нет в списках разрешённых, все ссылки ведут на promo-music.ru.
 * Включать только когда promoair.ru отвечает по HTTPS (DNS + сертификат).
 *
 * Безопасность: хост из заголовков выбирает только между НАШИМИ origin'ами
 * (allowlist ниже). Подделка Host / X-Forwarded-Host / Origin максимум
 * переключит promo-music.ru ↔ promoair.ru; увести ссылку сброса пароля или
 * return URL на чужой домен нельзя.
 */

export type SiteKey = 'music' | 'air';

const MAIN = 'https://promo-music.ru';

const MUSIC_HOSTS = [
  'promo-music.ru', 'www.promo-music.ru', 'admin.promo-music.ru',
  'promofm.org', 'www.promofm.org', 'promofm.ru', 'www.promofm.ru',
];
const AIR_HOSTS = ['promoair.ru', 'www.promoair.ru'];

// Принимаем только https-origin одного из AIR_HOSTS: опечатка в .env не должна
// перенаправить письма на чужой или на основной домен.
function parseAirOrigin(raw: string | undefined): string {
  const v = String(raw || '').trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' && !u.port && AIR_HOSTS.includes(u.hostname)) return u.origin;
  } catch { /* ниже предупреждение */ }
  console.warn('[site-origin] PROMOAIR_ORIGIN must be https://promoair.ru or https://www.promoair.ru; PROMO.AIR stays off');
  return '';
}
const AIR = parseAirOrigin(process.env.PROMOAIR_ORIGIN);
const AIR_PUBLIC = AIR || 'https://promoair.ru';

// Map, а не объект: ключ из заголовка вроде "constructor" не должен находить
// свойство Object.prototype.
const KNOWN_HOST_TO_SITE = new Map<string, SiteKey>([
  ...MUSIC_HOSTS.map((h) => [h, 'music'] as [string, SiteKey]),
  ...AIR_HOSTS.map((h) => [h, 'air'] as [string, SiteKey]),
]);
// Хосты, на которые разрешено вести ссылки и редиректы. promoair.ru попадает
// сюда только при включённом гейте.
const HOST_TO_SITE = AIR
  ? KNOWN_HOST_TO_SITE
  : new Map<string, SiteKey>(MUSIC_HOSTS.map((h) => [h, 'music'] as [string, SiteKey]));

export const isAirEnabled = (): boolean => !!AIR;
export const SITE_ORIGIN: Record<SiteKey, string> = { music: MAIN, air: AIR || MAIN };
export const ALLOWED_HOSTS: string[] = [...HOST_TO_SITE.keys()];
export const ALLOWED_ORIGINS: string[] = ALLOWED_HOSTS.map((h) => `https://${h}`);

export const SITE_BRAND = {
  music: { name: 'ПРОМО.МУЗЫКА', label: 'promo-music.ru', url: MAIN, logo: `${MAIN}/logo.png` },
  air: { name: 'PROMO.AIR', label: new URL(AIR_PUBLIC).hostname, url: AIR_PUBLIC, logo: `${AIR_PUBLIC}/promoair/email-logo.png` },
} as const;

// Пути фронтенда, на которые ведут письма и ЮKassa (одно место, если поменяются).
export const PATH = {
  login: '/login',
  reset: '/reset-password',
  venueHome: '/venue',
  venueSubscription: '/venue/subscription',
  venueOnboarding: '/venue/onboarding',
  venueApk: '/venue/apk',
  venuePromoAir: '/venue/promo-air',
  paymentResult: '/payment/result',
} as const;

/** Минимум от Hono Context, нужный здесь (и удобный для тестов). */
type RequestLike = { req: { header(name: string): string | undefined } };

const normHost = (h?: string | null): string =>
  h ? h.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '') : '';
const hostOf = (url?: string | null): string => {
  try { return url ? new URL(url).hostname : ''; } catch { return ''; }
};

// Первый заголовок с хостом из allowlist. Host первым: его выставляет nginx
// ($host того vhost'а, что принял запрос); X-Forwarded-Host и Origin нужны,
// где Host не проброшен (например, блок SSE).
function pickHost(c: RequestLike, map: Map<string, SiteKey>): string | null {
  const candidates = [c.req.header('host'), c.req.header('x-forwarded-host'), hostOf(c.req.header('origin'))];
  for (const raw of candidates) {
    const h = normHost(raw);
    if (h && map.has(h)) return h;
  }
  return null;
}

/** https-ссылка на один из наших хостов (return URL, редиректы). */
export function isAllowedUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && HOST_TO_SITE.has(u.hostname);
  } catch {
    return false;
  }
}

/** Сайт запроса для ссылок и редиректов. Гейт выключен → всегда 'music'. */
export function siteFromRequest(c: RequestLike): SiteKey {
  const h = pickHost(c, HOST_TO_SITE);
  return (h && HOST_TO_SITE.get(h)) || 'music';
}

export const originFromRequest = (c: RequestLike): string => SITE_ORIGIN[siteFromRequest(c)];

/**
 * Для ЗАПИСИ фактов (users.signup_site, page_views.host): узнаёт promoair.ru и
 * при выключенном гейте, чтобы регистрации с promoair.ru не записались как
 * 'music' до включения. Для ссылок не использовать.
 */
export function knownHostFromRequest(c: RequestLike): string | null {
  return pickHost(c, KNOWN_HOST_TO_SITE);
}
export function signupSiteFromRequest(c: RequestLike): SiteKey {
  const h = knownHostFromRequest(c);
  return (h && KNOWN_HOST_TO_SITE.get(h)) || 'music';
}

/**
 * Сайт пользователя для писем без контекста запроса (крон, действия админа на
 * promo-music.ru): сначала users.signup_site, затем роль venue → PROMO.AIR.
 */
export function siteForUser(u: { role?: string | null; signup_site?: string | null } | null | undefined): SiteKey {
  if (!AIR || !u) return 'music';
  if (u.signup_site === 'air') return 'air';
  if (u.signup_site === 'music') return 'music';
  return u.role === 'venue' ? 'air' : 'music';
}

export const originForUser = (u: Parameters<typeof siteForUser>[0]): string => SITE_ORIGIN[siteForUser(u)];

/**
 * siteForUser по id из базы. Гейт выключен → 'music' без запроса к базе.
 * to_jsonb(u)->>'signup_site' читается и до миграции 160 (нет колонки → null,
 * а не ошибка 42703). Любая ошибка → 'music': письмо важнее бренда.
 */
export async function siteForUserId(userId: string | null | undefined): Promise<SiteKey> {
  if (!AIR || !userId || !/^[0-9a-f-]{36}$/i.test(String(userId))) return 'music';
  try {
    const { pool } = await import('./db-client.tsx');
    const r = await pool.query(
      `SELECT u.role::text AS role, to_jsonb(u)->>'signup_site' AS signup_site FROM users u WHERE u.id = $1 LIMIT 1`,
      [String(userId)]
    );
    return siteForUser(r.rows[0]);
  } catch (err: any) {
    console.warn('[site-origin] siteForUserId failed:', err?.message || err);
    return 'music';
  }
}
