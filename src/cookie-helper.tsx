/**
 * COOKIE HELPER — HttpOnly session cookie для JWT auth.
 *
 * Phase D etap A (2026-06-01): backward-compatible foundation для миграции
 * JWT из localStorage → HttpOnly cookie (audit INC-A2 / F-3).
 *
 * На этом этапе backend начинает дополнительно ставить cookie при каждом
 * signToken-моменте (login / signup / refresh / vk-callback). Response body
 * по-прежнему возвращает accessToken + refreshToken для совместимости со
 * существующим frontend (localStorage path). auth-middleware читает либо
 * Bearer header, либо cookie.
 *
 * Этап B (будущий PR): frontend переключается на cookie, перестаёт
 * читать/писать localStorage.
 * Этап C (будущий PR): backend перестаёт возвращать accessToken в body,
 * Bearer-only path выпиливается из middleware.
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
 * Max-Age   — = JWT_EXPIRES_IN (2h в секундах). Cookie истекает вместе
 *             с JWT; refresh-flow обновляет оба.
 *
 * Refresh cookie живёт отдельной парой (pf_refresh, 30d Max-Age) — но
 * её add'им в этап B вместе с frontend переключением. На этап A
 * refresh_token продолжает летать в body.
 *
 * ── Domain ────────────────────────────────────────────────────────────
 *
 * Cookie domain НЕ задаём явно — браузер использует current host.
 * Это означает что cookie pf_session, поставленный для api.promofm.org,
 * НЕ будет отправляться при запросе на promofm.org. У нас frontend и
 * API на разных subdomain'ах — в этап B придётся либо:
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

const SESSION_MAX_AGE_SECONDS = 2 * 60 * 60; // 2h — = JWT_EXPIRES_IN

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
 * Clear session cookie. Используется в POST /auth/logout.
 * Issues Set-Cookie с Max-Age=0 — браузер удалит.
 */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
  });
}
