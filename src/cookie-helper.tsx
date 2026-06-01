/**
 * COOKIE HELPER — HttpOnly cookies для JWT auth (session + refresh).
 *
 * Phase D etap A (2026-06-01): backward-compatible foundation для миграции
 * JWT из localStorage → HttpOnly cookie (audit INC-A2 / F-3).
 *
 * Phase D pf_refresh precursor (2026-06-01): добавлен pf_refresh cookie
 * — refresh-токен (30d). Без него полный B2 (выпил localStorage) дал бы
 * logout каждые 2 часа (нечем silent-refresh). Body по-прежнему отдаёт
 * refresh_token для совместимости (dual-mode); frontend перейдёт на
 * cookie-only в B2.
 *
 * На этом этапе backend дополнительно ставит pf_session + pf_refresh
 * cookies при каждом signin/signup/refresh/vk-callback. Response body
 * по-прежнему возвращает accessToken + refreshToken. auth-middleware
 * читает либо Bearer header, либо pf_session cookie. /auth/refresh
 * читает refresh-токен либо из body, либо из pf_refresh cookie.
 *
 * Этап B (будущий PR): frontend переключается на cookies, перестаёт
 * читать/писать localStorage.
 * Этап C (финальный PR): backend перестаёт возвращать accessToken/
 * refreshToken в body, Bearer-only path выпиливается.
 *
 * ── Cookie attributes ─────────────────────────────────────────────────
 *
 * HttpOnly — JS не может прочитать (защита от XSS-эксфильтрации).
 * Secure   — отправляется только по HTTPS (NODE_ENV=production gate;
 *            development без TLS оставляем без флага иначе браузер cookie
 *            отбросит).
 * SameSite=Lax — отправляется при cross-site navigation (GET ссылки),
 *                НЕ при cross-site POST/fetch (защита от CSRF). Для нашей
 *                same-origin платформы (promofm.org / api.promofm.org)
 *                Lax достаточно. На этап C можно поднять до Strict если
 *                окажется что не ломает OAuth-redirect'ы.
 * Path=/    — на весь домен (все API endpoint'ы под /server/api/*).
 *             Для pf_refresh сужение до /server/auth/refresh — follow-up
 *             hardening после deploy B-этапа (минимизация surface area).
 * Max-Age   — pf_session: 2h (= JWT_EXPIRES_IN).
 *             pf_refresh: 30d (= REFRESH_TOKEN_DAYS в auth-security.tsx).
 *
 * ── Domain ────────────────────────────────────────────────────────────
 *
 * Cookie domain НЕ задаём явно — браузер использует current host.
 * Это означает что cookie, поставленный для api.promofm.org, НЕ будет
 * отправляться при запросе на promofm.org. У нас frontend и API на
 * разных subdomain'ах — на этап B придётся либо:
 *   (a) поставить COOKIE_DOMAIN=.promofm.org (отправка на оба) — нужен
 *       Secure + SameSite=Strict иначе CSRF surface,
 *   (b) либо все запросы фронтенда идти на api.promofm.org с
 *       credentials: 'include' — тогда host-only cookie ОК.
 * Для этап A это пока не критично (frontend ещё на localStorage), но
 * на B пометить выбор в OPERATIONS_LOG.
 */

import { Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';

export const SESSION_COOKIE_NAME = 'pf_session';
export const REFRESH_COOKIE_NAME = 'pf_refresh';

const SESSION_MAX_AGE_SECONDS = 2 * 60 * 60;          // 2h — = JWT_EXPIRES_IN
const REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;    // 30d — = REFRESH_TOKEN_DAYS (auth-security.tsx:285)

/**
 * Set session cookie. Вызывается после каждого signToken().
 * Не возвращает значение — модифицирует response headers.
 */
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Read session cookie. Используется auth-middleware как fallback
 * когда Authorization header отсутствует.
 */
export function getSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}

/**
 * Clear session cookie. Используется в POST /auth/signout.
 * Issues Set-Cookie с Max-Age=0 — браузер удалит.
 */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
  });
}

/**
 * Set refresh cookie. Вызывается после каждого createRefreshToken() и
 * rotateRefreshToken(). Token — это plaintext refresh-токен (не hash);
 * backend хранит SHA-256 hash в `refresh_tokens.token_hash`, browser
 * хранит plaintext в cookie. При вызове /auth/refresh cookie прилетает
 * назад, hash'ируется и сверяется с БД.
 *
 * path='/' сейчас — чтобы cookie прилетал на /server/auth/refresh из
 * любого origin'а внутри домена. Follow-up hardening — сузить до
 * '/server/auth' после deploy B этапа (минимизация surface area для
 * случайного отправления refresh-токена в чужие endpoint'ы).
 */
export function setRefreshCookie(c: Context, token: string): void {
  setCookie(c, REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: REFRESH_MAX_AGE_SECONDS,
  });
}

/**
 * Read refresh cookie. Используется в /auth/refresh как fallback когда
 * body.refreshToken не передан (cookie-only client).
 */
export function getRefreshCookie(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE_NAME);
}

/**
 * Clear refresh cookie. Используется в POST /auth/signout. Атрибуты
 * (path/secure/sameSite) ДОЛЖНЫ совпадать с теми что в setRefreshCookie
 * — иначе браузер не сматчит cookie для удаления.
 */
export function clearRefreshCookie(c: Context): void {
  deleteCookie(c, REFRESH_COOKIE_NAME, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
  });
}
