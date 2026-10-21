/**
 * AUTH ROUTES
 * Регистрация, вход, VK OAuth, сброс пароля, верификация email
 * PostgreSQL + bcrypt + JWT
 */

import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { upsertNotification } from './db.tsx';
import { logAdminAction } from './audit-helper.tsx';
import { vpsGetProfile, vpsSaveProfile, vpsStoreToken, vpsGetToken, vpsUseToken } from './vps-userdata.tsx';
import { notifyNewUser, sendPasswordResetEmail, sendVerificationEmail, sendAccountApprovedEmail, sendAccountRejectedEmail, sendVenueRadioWelcomeEmail, sendActivationEmail, sendProfileVerifiedEmail, sendProfileVerificationRejectedEmail } from "./email-helper.tsx";
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { isValidRole } from './roles.tsx';
import {
  checkAccountLockout, recordLoginAttempt, getFailedAttemptsCount,
  verifyCaptcha,
  isMFAEnabled, verifyMFACode, setupMFA, verifyAndEnableMFA, disableMFA,
  createRefreshToken, validateRefreshToken, rotateRefreshToken, revokeAllRefreshTokens, revokeRefreshToken,
  sendSecurityAlert,
} from './auth-security.tsx';
import { setSessionCookie, clearSessionCookie, getSessionCookie, setRefreshCookie, getRefreshCookie, clearRefreshCookie } from './cookie-helper.tsx';
import { ALLOWED_ORIGINS, PATH, originFromRequest, siteFromRequest, siteForUserId, signupSiteFromRequest } from './site-origin.tsx';
import { accountBlockOf, accountBlockBody, autoLoginBlockBody, moderationConflictText } from './access-gates.tsx';
import { parseVenueApplication, isPromoAirSignup, normalizeVenuePhone, type VenueApplication } from './venue-application.tsx';
import { signVkAirTicket, verifyVkAirTicket, vkAirTicketStoreId, VK_AIR_TICKET_TTL_S, VK_AIR_TICKET_TYPE, type VkAirTicket } from './vk-air-ticket.tsx';

import { createLogger } from "./logger.tsx";

const log = createLogger("auth");

const PARTNER_ROLES = ['radio_station', 'radio', 'venue'];
/**
 * Роли, которые регистрируются ТОЛЬКО по электронной почте.
 *
 * VK не отдаёт адрес — аккаунту достаётся плейсхолдер
 * vk<id>@promo-music.ru, на который физически нельзя написать. Для
 * бизнес-ролей это неприемлемо: им уходят счета, договорные письма и
 * результат проверки заявки. Список шире PARTNER_ROLES: лейбл почту
 * иметь обязан, но админского одобрения при регистрации не требует.
 */
const EMAIL_ONLY_ROLES = ['radio_station', 'radio', 'venue', 'label'];
const MAX_FAILED_ATTEMPTS = 5;
const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = '24h'; // STOPGAP 2026-06-03 — откат на '2h' после доставки silent-refresh (#96 + AuthContext global-net). См. PR/OPERATIONS_LOG.

// ── PostgreSQL ──
let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}
async function sql(text: string, params?: any[]) {
  const client = await getPool().connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

// Сайт регистрации (users.signup_site, миграция 160): по нему письма без контекста
// запроса ведут на promoair.ru или promo-music.ru. Отдельный best-effort UPDATE:
// без колонки (миграция не применена) регистрация не должна падать.
async function storeSignupSite(userId: string, site: string): Promise<void> {
  try {
    await sql(`UPDATE users SET signup_site = $1 WHERE id = $2`, [site, userId]);
  } catch (err) {
    log.warn({ err, userId }, 'signup_site_store_failed');
  }
}

// Данные заявки заведения в users.settings.application (слияние jsonb, другие
// ключи settings не трогаются). Заявку собирает и проверяет parseVenueApplication
// (venue-application.tsx). Best-effort, как storeSignupSite.
async function storeVenueApplication(userId: string, application: VenueApplication | null): Promise<void> {
  if (!application) return;
  try {
    await sql(
      `UPDATE users SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('application', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(application), userId]
    );
  } catch (err) {
    log.warn({ err, userId }, 'venue_application_store_failed');
  }
}

// ── JWT helpers ──
function signToken(user: { id: string; email: string; role: string; token_version?: number }) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, tv: user.token_version || 1 }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' });
}
function verifyToken(token: string): { sub: string; email: string; role: string; tv?: number } | null {
  try { return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as any; }
  catch { return null; }
}
function tokenExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + 15 * 60;
}

// ── Username generator ──
function makeUsername(email: string, name?: string): string {
  const base = (name || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9а-яё_]/gi, '_').substring(0, 80);
  return base + '_' + (Date.now() % 100000);
}


// ── Password complexity ──
function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Пароль минимум 8 символов';
  if (!/[A-ZА-ЯЁ]/.test(password)) return 'Пароль должен содержать хотя бы одну заглавную букву';
  if (!/[a-zа-яё]/.test(password)) return 'Пароль должен содержать хотя бы одну строчную букву';
  if (!/[0-9]/.test(password)) return 'Пароль должен содержать хотя бы одну цифру';
  if (!/[!@#$%^&*()_+\-=\[\]{}|;:'",.<>?/`~]/.test(password)) return 'Пароль должен содержать хотя бы один спецсимвол';
  const common = ['password', '12345678', 'qwerty12', 'letmein1', 'admin123', 'welcome1', 'iloveyou', 'monkey12', 'dragon12', 'master12', 'qwerty123', 'password1', 'Password1', '123456789', 'abc12345'];
  if (common.includes(password.toLowerCase())) return 'Этот пароль слишком распространён';
  return null;
}

// Safe JSON body parser — returns 400 instead of crashing with 500
// Narrowing-friendly shape: `response?: any` присутствует на обоих
// вариантах, чтобы TS не падал на parsed.response внутри
// `if (!parsed.ok)` (TS не сужает union {ok:true} | {ok:false} с
// разными ключами на 'parsed.response' без explicit type guard).
async function safeJsonParse(c: any): Promise<{ ok: boolean; body?: any; response?: any }> {
  try {
    const body = await c.req.json();
    return { ok: true, body };
  } catch (e: any) {
    return { ok: false, response: c.json({ success: false, error: 'Invalid request body' }, 400) };
  }
}

async function _safeJsonParse_old(c: any): Promise<{ ok: true; body: any } | { ok: false; response: any }> {
  try {
    const body = await c.req.json();
    return { ok: true, body };
  } catch (e: any) {
    return { ok: false, response: c.json({ success: false, error: 'Invalid request body' }, 400) };
  }
}

const auth = new Hono();

// ── Helper: создать профиль на VPS (152-ФЗ) ──
async function createVpsProfile(userId: string, email: string, name: string, role: string, avatar?: string | null, site: string = 'music') {
  const accountStatus = PARTNER_ROLES.includes(role || 'artist') ? 'pending' : 'active';
  await vpsSaveProfile(userId, { email, name: name || email.split("@")[0], role: role || "artist", avatar: avatar || null, accountStatus });
  const notifId = `notif_${Date.now()}`;
  // Заведению «загрузите первый трек» не подходит (20.10.2026): первый шаг
  // у него анкета эфира. Остальным ролям текст прежний.
  const welcome = role === 'venue'
    ? {
        title: site === 'air' ? "Добро пожаловать в PROMO.AIR!" : "Добро пожаловать в ПРОМО.МУЗЫКА!",
        message: "Заполните анкету эфира: по ней наша команда соберёт и запустит эфир для вашего заведения.",
        actionUrl: "/venue/onboarding",
      }
    : {
        title: "Добро пожаловать в ПРОМО.МУЗЫКА!",
        message: "Ваш аккаунт создан. Загрузите свой первый трек и начните продвижение.",
      };
  await upsertNotification(userId, notifId, {
    id: notifId, userId, type: "info",
    ...welcome,
    read: false, createdAt: new Date().toISOString(),
  });
}

/**
 * Call createVpsProfile() with compensating rollback on failure.
 * If profile creation throws (DB unreachable, RLS reject, etc.) the just-inserted
 * users row is deleted so the registration can be safely retried by the client
 * without hitting a "duplicate email" wall. Returns true on success, false on
 * rollback (caller should return a 5xx to the client).
 */
async function createVpsProfileOrRollback(userId: string, email: string, name: string, role: string, avatar?: string | null, site: string = 'music'): Promise<boolean> {
  try {
    await createVpsProfile(userId, email, name, role, avatar, site);
    return true;
  } catch (profileErr) {
    log.error({ err: profileErr, userId, email, role }, 'profile_create_failed_rolling_back_user');
    try {
      await sql('DELETE FROM users WHERE id = $1', [userId]);
    } catch (rollbackErr) {
      log.error({ err: rollbackErr, userId }, 'user_rollback_failed');
    }
    return false;
  }
}

// ── Audit logging ──
async function logAuthEvent(action: string, details: Record<string, any>, status: string = 'success') {
  try {
    const ip = details.ip || '';
    const ua = details.userAgent || '';
    const userId = details.userId || null;
    const errorMsg = details.error || null;
    await sql(
      `INSERT INTO audit_logs (user_id, action, action_description, resource_type, ip_address, user_agent, status, error_message, created_at)
       VALUES ($1, $2, $3, 'auth', $4::inet, $5, $6, $7, now())`,
      [userId, action, details.description || '', ip || '0.0.0.0', ua, status, errorMsg]
    );
  } catch (e) {
    log.error({ err: e }, 'audit_log_error');
  }
}


// ──────────────────────────────────────────────────────────────────────
// POST /auth/signup  —  Email-регистрация
// ──────────────────────────────────────────────────────────────────────
auth.post("/signup", async (c) => {
  try {
    const parsed = await safeJsonParse(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const { email, password, name, role, consentPersonalData, consentNewsletter, captchaToken, applicationDetails, vkTicket } = body;
    // H6: reCAPTCHA v3 verification (skipped if not configured)
    const captchaResult = await verifyCaptcha(captchaToken, 'signup');
    if (!captchaResult.ok) return c.json({ success: false, error: captchaResult.error || 'Проверка CAPTCHA не пройдена' }, 403);
    // VK ID (PROMO.AIR, docs/PROMOAIR.md §8): тикет из /auth/vk-air читается
    // только у заведения на promoair.ru; пароль тогда необязателен. Для
    // остальных ролей и сайтов поле не читается, регистрация как раньше.
    const vkTicketAllowed = Boolean(vkTicket) && role === 'venue' && siteFromRequest(c) === 'air';
    let vk: VkAirTicket | null = null;
    if (vkTicketAllowed) {
      vk = verifyVkAirTicket(vkTicket);
      if (!vk) return c.json({ success: false, error: VK_TICKET_EXPIRED, code: 'vk_ticket_expired' }, 400);
    }
    if (!email || (!password && !vk)) return c.json({ success: false, error: "Email и пароль обязательны" }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ success: false, error: "Некорректный формат email" }, 400);
    if (password || !vk) {
      const pwErr = validatePassword(password);
      if (pwErr) return c.json({ success: false, error: pwErr }, 400);
    }
    if (!consentPersonalData) return c.json({ success: false, error: "Необходимо согласие на обработку персональных данных" }, 400);

    // Whitelist: only allow roles declared in roles.tsx, and block admin/superadmin
    // (those are server-assigned only). Fallback to 'artist' for any unknown input.
    const userRole = (role && isValidRole(role) && role !== "admin" && role !== "superadmin") ? role : "artist";
    const isPartner = PARTNER_ROLES.includes(userRole);

    // Радиостанция/радио — ОБЯЗАТЕЛЬНЫЕ данные заявки для верификации админом.
    // Раньше партнёр уходил в pending без какой-либо информации → админ не мог
    // проверить легитимность (любой мог подать заявку). Теперь форма обязана
    // прислать applicationDetails, иначе 400.
    const RADIO_APP_ROLES = ['radio_station', 'radio'];
    let radioApp: any = null;
    if (RADIO_APP_ROLES.includes(userRole)) {
      const a = applicationDetails || {};
      const stationName = String(a.stationName || '').trim().slice(0, 200);
      const broadcastType = a.broadcastType === 'online' ? 'online' : 'fm';
      const frequency = String(a.frequency || '').trim().slice(0, 60);
      const streamUrl = String(a.streamUrl || '').trim().slice(0, 500);
      const website = String(a.website || '').trim().slice(0, 500);
      const phone = String(a.phone || '').trim().slice(0, 60);
      const position = String(a.position || '').trim().slice(0, 120);
      if (!stationName) return c.json({ success: false, error: 'Укажите название радиостанции' }, 400);
      if (broadcastType === 'fm' && !frequency) return c.json({ success: false, error: 'Укажите частоту вещания (FM)' }, 400);
      if (broadcastType === 'online' && !streamUrl) return c.json({ success: false, error: 'Укажите ссылку на эфир (интернет-радио)' }, 400);
      if (!website) return c.json({ success: false, error: 'Укажите сайт радиостанции' }, 400);
      if (!phone) return c.json({ success: false, error: 'Укажите контактный телефон' }, 400);
      if (!position) return c.json({ success: false, error: 'Укажите вашу должность' }, 400);
      radioApp = { stationName, broadcastType, frequency, streamUrl, website, phone, position };
    }

    // Заведение с promoair.ru: регистрация и есть заявка на подключение
    // (решение владельца 21.10.2026). Телефон, город и тип обязательны, чтобы
    // команда могла позвонить до одобрения; иначе 400, как у радиостанций.
    // Старая форма promo-music.ru этих полей не шлёт и работает как раньше.
    let venueApp: VenueApplication | null = null;
    if (userRole === 'venue') {
      const parsedApp = parseVenueApplication(applicationDetails, { required: isPromoAirSignup(signupSiteFromRequest(c), applicationDetails) });
      if (!parsedApp.ok) return c.json({ success: false, error: parsedApp.error, field: parsedApp.field }, 400);
      venueApp = parsedApp.application;
    }

    // VK ID: тикет одноразовый (отмечается атомарно, после проверки заявки и
    // до INSERT; повтор = 400), аккаунт VK свободен (иначе 409), почта
    // подтверждена, если совпадает с почтой из VK.
    let vkEmailVerified = false;
    if (vk) {
      if (!(await vpsUseToken(vkAirTicketStoreId(vk.n)))) return c.json({ success: false, error: VK_TICKET_EXPIRED, code: 'vk_ticket_expired' }, 400);
      const taken = await sql(`SELECT 1 FROM users WHERE vk_id = $1 LIMIT 1`, [vk.vkUserId]);
      if (taken.rows.length) return c.json({ success: false, error: VK_ID_TAKEN, code: 'vk_id_taken' }, 409);
      vkEmailVerified = Boolean(vk.emailFromVk && vk.email && String(email).trim().toLowerCase() === vk.email);
    }

    const accountStatus = isPartner ? 'pending' : 'active';
    const userName = name || email.split("@")[0];
    // Без пароля (вход через VK ID): случайный хеш, как у VK-регистрации.
    const passwordHash = await bcrypt.hash(password || (crypto.randomUUID() + crypto.randomUUID()), 12);
    const username = makeUsername(email, userName);

    let userId: string;
    try {
      const result = vk
        ? await sql(
          `INSERT INTO users (email, password_hash, username, full_name, role, status, is_email_verified, consent_personal_data, consent_newsletter, consent_at, vk_id, avatar_url)
           VALUES ($1, $2, $3, $4, $5::user_role, $6::user_status, $7, $8, $9, now(), $10, $11) RETURNING id`,
          [email, passwordHash, username, userName, userRole, accountStatus, vkEmailVerified, !!consentPersonalData, !!consentNewsletter, vk.vkUserId, vk.avatar]
        )
        : await sql(
        `INSERT INTO users (email, password_hash, username, full_name, role, status, is_email_verified, consent_personal_data, consent_newsletter, consent_at)
         VALUES ($1, $2, $3, $4, $5::user_role, $6::user_status, false, $7, $8, now()) RETURNING id`,
        [email, passwordHash, username, userName, userRole, accountStatus, !!consentPersonalData, !!consentNewsletter]
      );
      userId = result.rows[0].id;
    } catch (err: any) {
      if (vk && err.code === '23505' && String(err.constraint || '').includes('vk_id')) {
        return c.json({ success: false, error: VK_ID_TAKEN, code: 'vk_id_taken' }, 409);
      }
      if (err.code === '23505') {
        if (err.constraint?.includes('email')) logAuthEvent('signup_fail', {
          description: `Дубликат email: ${email}`, error: 'email_exists',
          ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
          userAgent: c.req.header('user-agent') || '',
        }, 'fail');
        return c.json({ success: false, error: "Ошибка регистрации. Если у вас уже есть аккаунт, попробуйте войти или восстановить пароль." }, 409);
      } else {
        log.error({ err }, "db_insert_user_error");
        return c.json({ success: false, error: 'Ошибка регистрации' }, 400);
      }
    }

    const signupSite = signupSiteFromRequest(c);
    const profileOk = await createVpsProfileOrRollback(userId, email, userName, userRole, vk ? vk.avatar : null, signupSite);
    if (!profileOk) {
      return c.json({ success: false, error: 'Ошибка регистрации – не удалось создать профиль. Попробуйте ещё раз.' }, 500);
    }

    // Радиозаявка: пишем данные в radio_profiles (колонки уже есть) +
    // position/broadcastType в data jsonb — чтобы админ верифицировал перед approve.
    if (radioApp) {
      try {
        // INSERT … ON CONFLICT, а не UPDATE: строки radio_profiles при
        // регистрации ещё нет, UPDATE обновлял 0 строк без ошибки — заявка
        // (название, сайт, поток, частота, телефон) терялась у всех станций
        // (аудит 10-02: 0/882 строк с data.application).
        await sql(
          `INSERT INTO radio_profiles (user_id, station_name, name, website, stream_url, frequency, phone, data, updated_at)
           VALUES ($1, $2, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6, $7::jsonb, now())
           ON CONFLICT (user_id) DO UPDATE
              SET station_name = EXCLUDED.station_name, name = EXCLUDED.name, website = EXCLUDED.website,
                  stream_url = EXCLUDED.stream_url, frequency = EXCLUDED.frequency, phone = EXCLUDED.phone,
                  data = COALESCE(radio_profiles.data, '{}'::jsonb) || EXCLUDED.data, updated_at = now()`,
          [userId, radioApp.stationName, radioApp.website, radioApp.streamUrl, radioApp.frequency, radioApp.phone,
           JSON.stringify({ application: { position: radioApp.position, broadcastType: radioApp.broadcastType, submittedAt: new Date().toISOString() } })]
        );
      } catch (e) { log.warn({ err: e, userId }, 'radio_application_store_failed'); }
    }

    await storeSignupSite(userId, signupSite);
    // Заявка заведения: контактное лицо (PROMO.AIR шлёт название заведения в
    // name, а имя человека в applicationDetails.contactName). Хранится в
    // users.settings.application: строки venue_profiles при регистрации ещё
    // нет; ensureVenueProfile копирует его в профиль, админка показывает.
    if (userRole === 'venue') await storeVenueApplication(userId, venueApp);
    const site = siteFromRequest(c);

    log.info({ email, userId, role: userRole, status: accountStatus, signupSite }, 'user_registered');
    logAuthEvent('signup_success', {
      userId, description: `Регистрация: ${email}, роль: ${userRole}`,
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
      userAgent: c.req.header('user-agent') || '',
    });

    notifyNewUser({ email, name: userName, role: userRole, via: vk ? "vk_oauth" : "email", needsApproval: isPartner, application: radioApp || venueApp || undefined, site: signupSite }).catch(() => {});

    // Почту из VK не подтверждаем второй раз: письма-ссылки нет.
    if (!vkEmailVerified) {
      const verificationToken = crypto.randomUUID();
      await vpsStoreToken(userId, verificationToken, "email_verify", 24);
      sendVerificationEmail(email, userName, verificationToken, site).catch((e) => log.warn({ err: e, email }, "verification_email_failed"));
    }

    // Venue-specific welcome — fires alongside the standard
    // verification email so the new venue understands the 7-day trial
    // + next steps (onboarding wizard → admin queue → pairing code).
    // Other roles get only the verification email.
    if (userRole === 'venue') {
      sendVenueRadioWelcomeEmail({ toEmail: email, venueName: userName, pendingApproval: isPartner, site })
        .catch((e) => log.warn({ err: e, email }, 'venue_welcome_email_failed'));
    }

    return c.json({
      success: true, emailVerificationRequired: !vkEmailVerified,
      accountStatus: isPartner ? 'pending' : 'active',
      message: isPartner ? 'Заявка отправлена на модерацию.' : undefined,
      data: { user: { id: userId, email, name: userName, role: userRole } },
    }, 201);
  } catch (error) {
    log.error({ err: error }, "signup_error");
    logAuthEvent('signup_error', {
      description: `Ошибка регистрации`, error: String(error),
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
      userAgent: c.req.header('user-agent') || '',
    }, 'error');
    return c.json({ success: false, error: 'Внутренняя ошибка сервера' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/signin  —  Вход через email/пароль
// ──────────────────────────────────────────────────────────────────────
// Alias: /login → /signin (frontend compat)
auth.post("/login", async (c) => {
  return c.redirect(c.req.url.replace("/login", "/signin"), 307);
});
auth.post("/signin", async (c) => {
  try {
    const parsed = await safeJsonParse(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const { email, password, captchaToken } = body;
    // H6: reCAPTCHA v3 verification (skipped if not configured)
    const captchaResult = await verifyCaptcha(captchaToken, 'signin');
    if (!captchaResult.ok) return c.json({ success: false, error: captchaResult.error || 'Проверка CAPTCHA не пройдена' }, 403);
    if (!email || !password) return c.json({ success: false, error: "Email и пароль обязательны" }, 400);

    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || '';
    const ua = c.req.header('user-agent') || '';

    // H5: Check account lockout
    const lockout = await checkAccountLockout(email, ip);
    if (lockout.locked) {
      return c.json({ success: false, error: `Аккаунт временно заблокирован. Попробуйте через ${lockout.remainingMinutes} мин.` }, 429);
    }

    const result = await sql(
      `SELECT id, email, password_hash, full_name, username, role::text, status::text, is_email_verified, avatar_url, token_version
       FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]
    );
    if (result.rows.length === 0) {
      await recordLoginAttempt(email, ip, ua, false);
      logAuthEvent('signin_fail', {
        description: `Неверный email или пароль: ${email}`, error: 'user_not_found', ip, userAgent: ua,
      }, 'fail');
      return c.json({ success: false, error: "Неверный email или пароль" }, 401);
    }

    const user = result.rows[0];

    // Импортированные аккаунты (радиостанции и артисты из старой базы)
    // заведены без пароля: регистрации не было, подтверждать почту им
    // никто не предлагал. Раньше такой вход упирался в «Email не
    // подтверждён. Проверьте почту» — в письмо, которого не существует,
    // и человек кружил между формой входа и пустым ящиком. Отправляем
    // ссылку на установку пароля (она же подтверждает email — см.
    // /reset-password) и говорим об этом прямо.
    if (!user.password_hash) {
      const emailKey = String(email).toLowerCase().trim();
      const lastSent = recentResetSends.get(emailKey);
      // Тот же cooldown, что у /request-reset: перебор логина не должен
      // превращаться в рассылку писем на чужой адрес.
      if (!lastSent || Date.now() - lastSent >= RESET_EMAIL_COOLDOWN_MS) {
        recentResetSends.set(emailKey, Date.now());
        try {
          const setupToken = crypto.randomUUID();
          await vpsStoreToken(user.id, setupToken, "password_reset", 24 * 7);
          await sendActivationEmail(
            user.email,
            user.full_name || user.username || String(user.email).split("@")[0],
            setupToken,
          );
          log.info({ userId: user.id }, 'password_setup_link_sent_on_login');
        } catch (err) {
          log.warn({ err, userId: user.id }, 'password_setup_link_failed');
        }
      }
      return c.json({
        success: false,
        error: "У этого аккаунта ещё нет пароля – он создан при переносе базы. Мы отправили на вашу почту ссылку, чтобы задать пароль.",
        requiresPasswordSetup: true,
      }, 401);
    }

    if (!user.is_email_verified) {
      return c.json({ success: false, error: "Email не подтверждён. Проверьте почту.", requiresVerification: true }, 401);
    }

    const valid = await bcrypt.compare(password, user.password_hash || '');
    if (!valid) {
      await recordLoginAttempt(email, ip, ua, false);
      const remaining = MAX_FAILED_ATTEMPTS - await getFailedAttemptsCount(email) - 1;
      logAuthEvent('signin_fail', {
        description: `Неверный пароль: ${email}`, error: 'wrong_password', ip, userAgent: ua,
      }, 'fail');
      return c.json({
        success: false,
        error: remaining > 0
          ? `Неверный email или пароль. Осталось попыток: ${remaining}`
          : "Неверный email или пароль"
      }, 401);
    }

    // pending / rejected / blocked|banned → 403 (access-gates.tsx; те же
    // ответы на VK-входе, exchange-auto-login и /refresh).
    // 'blocked' ставит админ (POST /admin/users/:id/status, migration 122),
    // 'banned': бан из админки пользователей (landing-data-routes) и
    // блокировка заведения в админке PROMO.AIR. Живые сессии убиты бампом
    // token_version в момент блокировки; этот гейт закрывает повторный вход
    // по паролю (до 17.10.2026 'banned' здесь не проверялся и бан обходился
    // обычным входом).
    const block = accountBlockOf(user.status);
    if (block) return c.json(accountBlockBody(block), 403);

    // H7: Check if MFA is enabled
    const mfaEnabled = await isMFAEnabled(user.id);
    const { mfaCode } = await c.req.json().catch(() => ({}));

    if (mfaEnabled) {
      if (!mfaCode) {
        // Return partial success — client must provide MFA code
        return c.json({
          success: false,
          mfaRequired: true,
          error: "Введите код из приложения-аутентификатора",
        }, 200);
      }
      const mfaValid = await verifyMFACode(user.id, mfaCode);
      if (!mfaValid) {
        await recordLoginAttempt(email, ip, ua, false);
        return c.json({ success: false, error: "Неверный код 2FA" }, 401);
      }
    }

    // Success: record + generate tokens
    await recordLoginAttempt(email, ip, ua, true);
    const accessToken = signToken({ id: user.id, email: user.email, role: user.role, token_version: user.token_version || 1 });
    setSessionCookie(c, accessToken);
    const refreshTokenData = await createRefreshToken(user.id, ip, ua);
    setRefreshCookie(c, refreshTokenData.token);
    await sql(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
    logAuthEvent('signin_success', {
      userId: user.id, description: `Вход: ${email}, роль: ${user.role}`, ip, userAgent: ua,
    });

    // Sync VPS profile
    let profile = await vpsGetProfile(user.id);
    if (!profile) {
      await vpsSaveProfile(user.id, { userId: user.id, email, name: user.full_name, role: user.role, avatar: user.avatar_url, isEmailVerified: true, createdAt: new Date().toISOString() });
      profile = { name: user.full_name, role: user.role };
    } else {
      profile.lastLoginAt = new Date().toISOString();
      await vpsSaveProfile(user.id, profile);
    }

    log.info({ email, userId: user.id }, 'user_signed_in');
    // Phase D C (2026-06-01): accessToken + refreshToken убраны из body —
    // pf_session + pf_refresh cookies (Set-Cookie выше) единственный
    // транспорт. Frontend B2 (#91) больше не читает body.accessToken.
    return c.json({
      success: true,
      data: {
        user: { id: user.id, email, name: profile.name || user.full_name, role: user.role, isEmailVerified: true, accountStatus: user.status },
      },
    });
  } catch (error) {
    if (error instanceof SyntaxError) return c.json({ success: false, error: "Некорректный JSON" }, 400);
    log.error({ err: error }, "signin_error");
    return c.json({ success: false, error: 'Внутренняя ошибка сервера' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/vk-callback  —  VK ID OAuth
// ──────────────────────────────────────────────────────────────────────
auth.post("/vk-callback", async (c) => {
  try {
    const vkParsed = await safeJsonParse(c);
    if (!vkParsed.ok) return vkParsed.response;
    const { code, redirect_uri, code_verifier, device_id, role: vkRequestedRole } = vkParsed.body;

    // Validate redirect_uri: prevent OAuth redirect manipulation.
    // Только наши origin'ы (site-origin.tsx); сам VK дополнительно сверяет
    // redirect_uri с доверенными адресами приложения.
    const ALLOWED_REDIRECT_URIS = ALLOWED_ORIGINS.flatMap((o) => ['/login', '/register', '/auth/vk/callback'].map((p) => o + p));
    const effectiveRedirectUri = redirect_uri || `${originFromRequest(c)}${PATH.login}`;
    if (!ALLOWED_REDIRECT_URIS.includes(effectiveRedirectUri)) {
      return c.json({ success: false, error: 'Invalid redirect_uri' }, 400);
    }
    if (!code) return c.json({ success: false, error: "VK authorization code required" }, 400);

    const VK_CLIENT_ID = process.env.VK_CLIENT_ID || "";
    const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET || "";
    if (!VK_CLIENT_ID || !VK_CLIENT_SECRET) return c.json({ success: false, error: "VK OAuth не настроен" }, 500);

    // 1. Exchange code for access_token
    const tokenBody: Record<string, string> = {
      grant_type: "authorization_code", client_id: VK_CLIENT_ID, client_secret: VK_CLIENT_SECRET,
      code, redirect_uri: effectiveRedirectUri,
    };
    if (device_id) tokenBody.device_id = device_id;
    if (code_verifier) tokenBody.code_verifier = code_verifier;

    log.info({ clientId: VK_CLIENT_ID, redirectUri: tokenBody.redirect_uri }, 'vk_token_exchange');
    const tokenResp = await fetch("https://id.vk.com/oauth2/auth", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenBody).toString(),
    });
    const tokenText = await tokenResp.text();
    let tokenData: any;
    try { tokenData = JSON.parse(tokenText); }
    catch { return c.json({ success: false, error: "VK OAuth: неожиданный ответ от VK" }, 502); }

    if (tokenData.error || !tokenData.access_token) {
      return c.json({ success: false, error: `VK OAuth ошибка: ${tokenData.error_description || tokenData.error}` }, 400);
    }

    const vkAccessToken = tokenData.access_token;
    const vkUserId = tokenData.user_id;
    const vkEmail = tokenData.email || null;

    // 2. Get VK user profile
    const profileResp = await fetch("https://id.vk.com/oauth2/user_info", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: vkAccessToken, client_id: VK_CLIENT_ID }).toString(),
    });
    const vkProfile: any = await profileResp.json();
    const vkName = [vkProfile.user?.first_name, vkProfile.user?.last_name].filter(Boolean).join(" ") || `VK User ${vkUserId}`;
    const vkAvatar = vkProfile.user?.avatar || null;
    const email = vkEmail || vkProfile.user?.email || null;

    log.info({ vkUserId, vkName, email }, 'vk_oauth_user');

    // 3. Find existing user by vk_id
    const existing = await sql(`SELECT id, email, full_name, role::text, status::text, avatar_url FROM users WHERE vk_id = $1 AND deleted_at IS NULL`, [String(vkUserId)]);

    if (existing.rows.length > 0) {
      const eu = existing.rows[0];
      // Тот же гейт статуса, что у /signin: VK не обходит модерацию и бан.
      const vkBlock = accountBlockOf(eu.status);
      if (vkBlock) return c.json(accountBlockBody(vkBlock), 403);
      let profile = await vpsGetProfile(eu.id);
      const role = profile?.role || eu.role || "artist";

      if (vkAvatar && eu.avatar_url !== vkAvatar) {
        await sql(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [vkAvatar, eu.id]);
      }
      await sql(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [eu.id]);
      if (profile) { profile.lastLoginAt = new Date().toISOString(); await vpsSaveProfile(eu.id, profile); }

      const accessToken = signToken({ id: eu.id, email: eu.email, role });
      setSessionCookie(c, accessToken);
      const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
      const ua = c.req.header("user-agent") || "unknown";
      const refreshData = await createRefreshToken(eu.id, ip, ua);
      setRefreshCookie(c, refreshData.token);
      // Phase D C: accessToken + refreshToken убраны (cookies в Set-Cookie).
      return c.json({
        success: true, newUser: false,
        data: { user: { id: eu.id, email: eu.email, name: profile?.name || eu.full_name || vkName, role } },
      });
    }

    // 4. New user
    if (EMAIL_ONLY_ROLES.includes(vkRequestedRole || '')) {
      log.warn({ role: vkRequestedRole, vkUserId }, 'vk_signup_email_only_role_rejected');
      return c.json({
        success: false,
        error: "Радиостанции, заведения и лейблы регистрируются только по электронной почте.",
      }, 400);
    }

    const userEmail = email || `vk${vkUserId}@promo-music.ru`;
    const passwordHash = await bcrypt.hash(crypto.randomUUID() + crypto.randomUUID(), 12);
    const vkRole = (vkRequestedRole && vkRequestedRole !== "admin" && vkRequestedRole !== "superadmin") ? vkRequestedRole : "artist";
    const username = `vk_${vkUserId}`;

    let userId: string;
    try {
      const result = await sql(
        `INSERT INTO users (email, password_hash, username, full_name, role, status, avatar_url, vk_id, is_email_verified)
         VALUES ($1, $2, $3, $4, $5::user_role, 'active'::user_status, $6, $7, true) RETURNING id`,
        [userEmail, passwordHash, username, vkName, vkRole, vkAvatar, String(vkUserId)]
      );
      userId = result.rows[0].id;
    } catch (err: any) {
      if (err.code === '23505') {
        // Email or username conflict — try to link VK
        const byEmail = await sql(`SELECT id, email, full_name, role::text, status::text FROM users WHERE email = $1`, [userEmail]);
        if (byEmail.rows.length > 0) {
          const eu = byEmail.rows[0];
          // До привязки VK: заявка на проверке (заведение с той же почтой) или
          // заблокированный аккаунт не получают ни привязку, ни сессию.
          const linkBlock = accountBlockOf(eu.status);
          if (linkBlock) return c.json(accountBlockBody(linkBlock), 403);
          await sql(`UPDATE users SET vk_id = $1, avatar_url = COALESCE($2, avatar_url) WHERE id = $3`, [String(vkUserId), vkAvatar, eu.id]);
          const accessToken = signToken({ id: eu.id, email: userEmail, role: eu.role || "artist" });
          setSessionCookie(c, accessToken);
          const profile = await vpsGetProfile(eu.id);
          // Phase D C: accessToken убран (pf_session cookie через Set-Cookie).
          return c.json({
            success: true, newUser: false,
            data: { user: { id: eu.id, email: userEmail, name: profile?.name || eu.full_name || vkName, role: eu.role || "artist" } },
          });
        }
        return c.json({ success: false, error: "Пользователь с таким email уже зарегистрирован." }, 409);
      }
      log.error({ err }, 'vk_user_create_error');
      return c.json({ success: false, error: 'Ошибка создания аккаунта' }, 400);
    }

    const profileOk = await createVpsProfileOrRollback(userId, userEmail, vkName, vkRole, vkAvatar);
    if (!profileOk) {
      return c.json({ success: false, error: 'Ошибка создания аккаунта – не удалось создать профиль' }, 500);
    }
    const vkSignupSite = signupSiteFromRequest(c);
    await storeSignupSite(userId, vkSignupSite);
    notifyNewUser({ email: userEmail, name: vkName, role: vkRole, via: "vk_oauth", site: vkSignupSite }).catch(() => {});

    const accessToken = signToken({ id: userId, email: userEmail, role: vkRole });
    setSessionCookie(c, accessToken);
    const ip2 = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const ua2 = c.req.header("user-agent") || "unknown";
    const refreshData2 = await createRefreshToken(userId, ip2, ua2);
    setRefreshCookie(c, refreshData2.token);
    log.info({ email: userEmail, userId }, 'vk_user_created');

    // Phase D C: accessToken + refreshToken убраны (cookies в Set-Cookie).
    return c.json({
      success: true, newUser: true,
      data: { user: { id: userId, email: userEmail, name: vkName, avatar: vkAvatar, role: vkRole } },
    });
  } catch (error) {
    log.error({ err: error }, "vk_callback_error");
    return c.json({ success: false, error: "VK OAuth ошибка" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/vk-air: VK ID на promoair.ru (виджет OAuthList: VK ID, Одноклассники, Mail.ru)
// ──────────────────────────────────────────────────────────────────────
// Отдельное приложение VK ID (PROMOAIR_VK_APP_ID, по умолчанию 54840499),
// виджет обменивает код на токен в браузере и присылает access_token. Токен
// проверяем у VK (user_info с нашим client_id: токен другого приложения не
// пройдёт); личность берём только из ответа VK. Дальше:
//   1. users.vk_id совпал → гейт статуса как у /signin → сессия;
//   2. почта из VK совпала с users.email → на проверке или заблокирован: 403
//      без привязки; активен: привязка vk_id и сессия;
//   3. иначе needsSignup + vkTicket (vk-air-ticket.tsx) для формы заявки.
// Работает только на promoair.ru (сайт 'air'), иначе 404. Токены в журнал не пишем.
const VK_TICKET_EXPIRED = 'Сессия VK ID истекла, войдите через VK ещё раз';
const VK_ID_TAKEN = 'Этот VK ID уже привязан к другому кабинету. Войдите через VK ID.';
const VK_AIR_FAILED = 'Не получилось войти через VK ID. Попробуйте ещё раз.';

interface VkIdUser { id: string; name: string; email: string | null; phone: string | null; avatar: string | null }

async function fetchVkIdUser(accessToken: string): Promise<VkIdUser | null> {
  const clientId = process.env.PROMOAIR_VK_APP_ID || '54840499';
  let resp: Response;
  try {
    resp = await fetch('https://id.vk.com/oauth2/user_info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, access_token: accessToken }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    log.warn({ err: err?.name || 'fetch_failed' }, 'vk_air_user_info_unreachable');
    return null;
  }
  let data: any = null;
  try { data = await resp.json(); } catch { /* ниже: null */ }
  const u = data?.user;
  const id = u && (typeof u.user_id === 'string' || typeof u.user_id === 'number') ? String(u.user_id) : '';
  if (!resp.ok || data?.error || !/^\d{1,20}$/.test(id)) {
    log.warn({ status: resp.status, error: typeof data?.error === 'string' ? data.error.slice(0, 60) : undefined }, 'vk_air_token_rejected');
    return null;
  }
  const name = [u.first_name, u.last_name].filter((x: unknown) => typeof x === 'string' && x.trim()).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const emailRaw = typeof u.email === 'string' ? u.email.trim().toLowerCase() : '';
  const email = emailRaw.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : null;
  const avatar = typeof u.avatar === 'string' && u.avatar.length <= 1000 && /^https:\/\//.test(u.avatar) ? u.avatar : null;
  return { id, name, email, phone: normalizeVenuePhone(u.phone), avatar };
}

/** Сессия как у /signin: pf_session (token_version из базы) + pf_refresh. */
async function startVkAirSession(c: any, u: { id: string; email: string; role: string; token_version?: number }) {
  setSessionCookie(c, signToken({ id: u.id, email: u.email, role: u.role, token_version: u.token_version || 1 }));
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  const ua = c.req.header('user-agent') || 'unknown';
  const refreshData = await createRefreshToken(u.id, ip, ua);
  setRefreshCookie(c, refreshData.token);
  await sql(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [u.id]);
}

auth.post('/vk-air', async (c) => {
  if (siteFromRequest(c) !== 'air') return c.json({ success: false, error: 'Not found' }, 404);
  try {
    const parsed = await safeJsonParse(c);
    if (!parsed.ok) return parsed.response;
    const accessToken = typeof parsed.body?.access_token === 'string' ? parsed.body.access_token.trim() : '';
    const mode = parsed.body?.mode === 'signup' ? 'signup' : 'login';
    if (!accessToken || accessToken.length > 4096) return c.json({ success: false, error: VK_AIR_FAILED }, 400);

    const vkUser = await fetchVkIdUser(accessToken);
    if (!vkUser) return c.json({ success: false, error: VK_AIR_FAILED }, 401);
    const cols = `id::text AS id, email, full_name, role::text AS role, status::text AS status, token_version, vk_id`;
    const userBody = (u: any) => ({ id: u.id, email: u.email, name: u.full_name || vkUser.name, role: u.role });

    // 1. Уже привязан
    const byVk = await sql(`SELECT ${cols} FROM users WHERE vk_id = $1 AND deleted_at IS NULL LIMIT 1`, [vkUser.id]);
    if (byVk.rows.length) {
      const u = byVk.rows[0];
      const block = accountBlockOf(u.status);
      if (block) return c.json(accountBlockBody(block), 403);
      await startVkAirSession(c, u);
      log.info({ userId: u.id, mode }, 'vk_air_signin');
      return c.json({ success: true, linked: false, data: { user: userBody(u) } });
    }

    // 2. Та же почта: привязка только активному аккаунту
    if (vkUser.email) {
      const byEmail = await sql(`SELECT ${cols} FROM users WHERE lower(email) = $1 AND deleted_at IS NULL LIMIT 1`, [vkUser.email]);
      if (byEmail.rows.length) {
        const u = byEmail.rows[0];
        const block = accountBlockOf(u.status);
        if (block) return c.json(accountBlockBody(block), 403);
        if (u.vk_id && u.vk_id !== vkUser.id) {
          return c.json({ success: false, error: 'Этот кабинет уже привязан к другому VK ID. Войдите по почте и паролю.', code: 'vk_other_linked' }, 409);
        }
        try {
          await sql(`UPDATE users SET vk_id = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3 AND vk_id IS NULL`, [vkUser.id, vkUser.avatar, u.id]);
        } catch (err: any) {
          if (err.code === '23505') return c.json({ success: false, error: VK_ID_TAKEN, code: 'vk_id_taken' }, 409);
          throw err;
        }
        await startVkAirSession(c, u);
        log.info({ userId: u.id, mode }, 'vk_air_linked_by_email');
        return c.json({ success: true, linked: true, data: { user: userBody(u) } });
      }
    }

    // 3. Нового аккаунта не создаём: заявку заполняют в форме (тикет на 30 минут)
    const { ticket, payload } = signVkAirTicket({
      vkUserId: vkUser.id, email: vkUser.email, emailFromVk: Boolean(vkUser.email),
      name: vkUser.name, phone: vkUser.phone, avatar: vkUser.avatar,
    });
    await vpsStoreToken(`vk:${vkUser.id}`, vkAirTicketStoreId(payload.n), VK_AIR_TICKET_TYPE, VK_AIR_TICKET_TTL_S / 3600);
    log.info({ mode, hasEmail: Boolean(vkUser.email), hasPhone: Boolean(vkUser.phone) }, 'vk_air_needs_signup');
    return c.json({
      success: false, needsSignup: true,
      prefill: { name: vkUser.name, email: vkUser.email, phone: vkUser.phone },
      emailVerified: Boolean(vkUser.email),
      vkTicket: ticket,
    });
  } catch (error: any) {
    log.error({ err: error?.message }, 'vk_air_error');
    return c.json({ success: false, error: VK_AIR_FAILED }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/set-role — ADMIN ONLY with RBAC validation
// ──────────────────────────────────────────────────────────────────────
auth.post("/set-role", requireAuth, requireAdmin, async (c) => {
  try {
    const actorId = c.get('userId');
    const actorRole = c.get('userRole');
    const actorEmail = c.get('userEmail') || '';
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const { userId, role, reason } = await c.req.json();
    if (!userId || !role) return c.json({ success: false, error: "userId and role are required" }, 400);

    // Import RBAC module
    const { validateRoleChange, formatRoleChangeLog, SUPERADMIN_EMAIL } = await import('./roles.tsx');

    // Get target user's current role
    const targetUser = await sql('SELECT role::text, email FROM users WHERE id = $1', [userId]);
    if (targetUser.rows.length === 0) {
      return c.json({ success: false, error: "Неверный email или пароль" }, 404);
    }
    const targetCurrentRole = targetUser.rows[0].role;
    const targetEmail = targetUser.rows[0].email;

    // Determine effective actor role (superadmin check by email)
    const effectiveRole = actorEmail === SUPERADMIN_EMAIL ? 'superadmin' : actorRole;

    // RBAC validation
    const validation = validateRoleChange(effectiveRole, actorEmail, targetCurrentRole, role);
    if (!validation.allowed) {
      log.warn({ actorEmail, userId, role, reason: validation.reason }, 'rbac_role_change_denied');
      return c.json({ success: false, error: validation.reason }, 403);
    }

    // Apply role change
    const result = await sql('UPDATE users SET role = $1::user_role WHERE id = $2 RETURNING *', [role, userId]);

    // Invalidate existing tokens by bumping token_version
    await sql('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1', [userId]);

    // Update profile. The role change in `users` is the source of truth — if the
    // profile sync fails, log it and continue rather than 500'ing the whole
    // request, since the user already has the new role in the auth table.
    try {
      let profile = await vpsGetProfile(userId);
      if (profile) {
        profile.role = role;
        profile.updatedAt = new Date().toISOString();
        await vpsSaveProfile(userId, profile);
      } else {
        const user = result.rows[0];
        await createVpsProfile(userId, user.email, user.full_name, role, user.avatar_url);
      }
    } catch (profileSyncErr) {
      log.warn({ err: profileSyncErr, userId, role }, 'set_role_profile_sync_failed');
    }

    // Audit log
    const auditEntry = {
      timestamp: new Date().toISOString(),
      actorId, actorEmail, actorRole: effectiveRole,
      targetUserId: userId, previousRole: targetCurrentRole, newRole: role,
      reason: reason || null, ip,
    };
    log.info({ audit: auditEntry }, formatRoleChangeLog(auditEntry));

    // Persist audit log to DB
    try {
      await sql(
        `INSERT INTO audit_logs (action, actor_id, target_id, details, ip_address, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        ['role_change', actorId, userId, JSON.stringify(auditEntry), ip]
      );
    } catch {}

    return c.json({ success: true, role, previousRole: targetCurrentRole });
  } catch (error) {
    log.error({ err: error }, "set_role_error");
    return c.json({ success: false, error: 'Внутренняя ошибка сервера' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /auth/me
// ──────────────────────────────────────────────────────────────────────
auth.get("/me", requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const result = await sql(`SELECT id, email, full_name, role::text, is_verified, is_email_verified, avatar_url FROM users WHERE id = $1`, [userId]);
    if (result.rows.length === 0) return c.json({ success: false, error: "User not found" }, 404);
    const user = result.rows[0];
    let profile = await vpsGetProfile(user.id);

    return c.json({
      success: true,
      data: {
        id: user.id, email: user.email,
        name: profile?.name || user.full_name || "User",
        role: profile?.role || user.role || "artist",
        avatar: profile?.avatar || user.avatar_url || null,
        isVerified: user.is_verified || false,
        isEmailVerified: user.is_email_verified || false,
      },
    });
  } catch (error) {
    log.error({ err: error }, "auth_me_error");
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/signout
// ──────────────────────────────────────────────────────────────────────
// Phase D C (2026-06-01): cookie-only. Bearer header fallback убран
// после B2 deploy. revokeAllRefreshTokens(decoded.sub) ниже revoke'ит
// ВСЕ DB-refresh-токены юзера (включая тот в pf_refresh cookie),
// поэтому отдельно revoke не нужно.
auth.post("/signout", async (c) => {
  try {
    const token = getSessionCookie(c);
    if (token) {
      const decoded = verifyToken(token);
      if (decoded) {
        await sql(`UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = $1`, [decoded.sub]);
        await revokeAllRefreshTokens(decoded.sub);
        log.info({ email: decoded.email, userId: decoded.sub }, 'user_signed_out');
      }
    }
    clearSessionCookie(c);
    clearRefreshCookie(c);
    return c.json({ success: true, message: "Signed out successfully" });
  } catch {
    clearSessionCookie(c);
    clearRefreshCookie(c);
    return c.json({ success: true, message: "Signed out" });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/request-reset
// ──────────────────────────────────────────────────────────────────────
// Per-email cooldown for password reset emails. The IP-based authLimiter doesn't
// help against the "spam a specific user's inbox via many IPs" attack. 60s between
// sends per email is enough to block mailbomb attempts without hurting real users
// who hit the button twice.
const RESET_EMAIL_COOLDOWN_MS = 60_000;
const recentResetSends = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of recentResetSends) {
    if (now - t > RESET_EMAIL_COOLDOWN_MS * 5) recentResetSends.delete(k);
  }
}, RESET_EMAIL_COOLDOWN_MS).unref?.();

auth.post("/request-reset", async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ success: false, error: "Email обязателен" }, 400);

    const emailKey = String(email).toLowerCase().trim();

    // Same fake-success response for cooldown as for "not found" — never leak
    // whether the email exists or not.
    const lastSent = recentResetSends.get(emailKey);
    if (lastSent && Date.now() - lastSent < RESET_EMAIL_COOLDOWN_MS) {
      return c.json({ success: true, message: "Если аккаунт с таким email существует, мы отправили письмо." });
    }

    const result = await sql(`SELECT id, full_name FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
    if (result.rows.length === 0) {
      // Mark cooldown anyway, so probing for valid emails via timing is harder.
      recentResetSends.set(emailKey, Date.now());
      return c.json({ success: true, message: "Если аккаунт с таким email существует, мы отправили письмо." });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomUUID();
    await vpsStoreToken(user.id, resetToken, "password_reset", 1);

    const profile = await vpsGetProfile(user.id);
    await sendPasswordResetEmail(email, profile?.name || user.full_name || email.split("@")[0], resetToken, siteFromRequest(c));
    recentResetSends.set(emailKey, Date.now());
    log.info({ email }, 'password_reset_sent');
    return c.json({ success: true, message: "Если аккаунт с таким email существует, мы отправили письмо." });
  } catch (error) {
    log.error({ err: error }, "request_reset_error");
    return c.json({ success: false, error: 'Внутренняя ошибка сервера' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/reset-password
// ──────────────────────────────────────────────────────────────────────
auth.post("/reset-password", async (c) => {
  try {
    const { token, newPassword } = await c.req.json();
    if (!token || !newPassword) return c.json({ success: false, error: "Токен и пароль обязательны" }, 400);
    const pwErr = validatePassword(newPassword);
    if (pwErr) return c.json({ success: false, error: pwErr }, 400);

    const resetData = await vpsGetToken(token);
    if (!resetData) return c.json({ success: false, error: "Недействительная ссылка" }, 400);
    // Token-confusion guard (2026-06-27): vpsGetToken отдаёт токен ЛЮБОГО типа.
    // Оба входа на /reset-password кладут тип 'password_reset' (line 743 reset,
    // 1324 активация мигрированных). Без проверки email_verify-токен (выдаётся
    // на регистрации) можно было переиграть сюда. `type &&` — legacy-токены без
    // типа продолжают работать.
    if (resetData.type && resetData.type !== 'password_reset') {
      return c.json({ success: false, error: "Недействительная ссылка" }, 400);
    }
    if (new Date() > new Date(resetData.expiresAt)) { await vpsUseToken(token); return c.json({ success: false, error: "Ссылка истекла." }, 400); }
    if (resetData.usedAt) return c.json({ success: false, error: "Ссылка уже использована." }, 400);

    const passwordHash = await bcrypt.hash(newPassword, 12);
    // Legacy-импорт flow: artist получил активационное письмо, поставил
    // пароль — это и есть email-подтверждение (мы знаем email из старой
    // базы). Поэтому is_email_verified=TRUE + email_verified_at=NOW.
    // Для регулярных reset-password у уже-активированных пользователей
    // это идемпотентно (TRUE остаётся TRUE).
    // pending → active (6a5ddda, 28.05.2026) осталось для этой активации, но
    // НЕ для партнёров (PARTNER_ROLES): их заявку одобряет только админ, а
    // сброс пароля раньше снимал модерацию (17.10.2026). Импорт заводил
    // аккаунты сразу 'active', на проде 0 'pending' (проверено 17.10).
    const upd = await sql(
      `UPDATE users SET
         password_hash    = $1,
         token_version    = COALESCE(token_version, 1) + 1,
         is_email_verified = TRUE,
         email_verified_at = COALESCE(email_verified_at, NOW()),
         status            = CASE WHEN status::text = 'pending' AND role::text <> ALL($3::text[])
                                  THEN 'active'::user_status ELSE status END
       WHERE id = $2
       RETURNING status::text AS status`,
      [passwordHash, resetData.userId, PARTNER_ROLES]
    );
    await vpsUseToken(token);

    const accountStatus = upd.rows[0]?.status;
    log.info({ userId: resetData.userId, accountStatus }, 'password_reset_completed');
    // accountStatus: страница сброса может сразу сказать «аккаунт на проверке».
    return c.json({ success: true, message: "Пароль обновлён.", ...(accountStatus ? { accountStatus } : {}) });
  } catch (error) {
    log.error({ err: error }, "reset_password_error");
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/verify-email
// ──────────────────────────────────────────────────────────────────────
/**
 * POST /set-email — вписать настоящую почту вместо VK-плейсхолдера.
 *
 * Только для аккаунтов, у которых адрес — плейсхолдер вида
 * vk<id>@promo-music.ru (VK-вход не отдаёт email). Такой аккаунт не
 * получает ни одного письма: sendEmail пропускает весь домен
 * promo-music.ru, потому что ящиков за этими адресами нет.
 *
 * Заполнение — не смена: аккаунту с настоящим адресом отказываем.
 * Смена подтверждённой почты должна подтверждаться со старого ящика,
 * иначе это угон аккаунта при уведённой сессии.
 */
auth.post("/set-email", requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const parsed = await safeJsonParse(c);
    if (!parsed.ok) return parsed.response;

    const email = String(parsed.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return c.json({ success: false, error: "Укажите корректный адрес почты" }, 400);
    }
    // Плейсхолдер вместо плейсхолдера — не решение задачи.
    if (/@promo-music\.ru$/i.test(email)) {
      return c.json({ success: false, error: "Нужен адрес настоящего почтового ящика" }, 400);
    }

    const cur = await sql(
      `SELECT email, full_name, username FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    if (cur.rows.length === 0) return c.json({ success: false, error: "Пользователь не найден" }, 404);

    const currentEmail = String(cur.rows[0].email || '');
    const isPlaceholder = /@promo-music\.ru$/i.test(currentEmail);
    if (!isPlaceholder) {
      return c.json({
        success: false,
        error: "У аккаунта уже указана почта. Смена адреса – через поддержку.",
      }, 409);
    }

    const taken = await sql(
      `SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2 AND deleted_at IS NULL LIMIT 1`,
      [email, userId]
    );
    if (taken.rows.length > 0) {
      return c.json({ success: false, error: "Этот адрес уже привязан к другому аккаунту" }, 409);
    }

    // Почта записывается сразу (иначе письмо некуда слать), но
    // неподтверждённой: подтверждение придёт по ссылке.
    await sql(
      `UPDATE users
          SET email = $1, is_email_verified = FALSE, email_verified_at = NULL, updated_at = NOW()
        WHERE id = $2`,
      [email, userId]
    );

    const verificationToken = crypto.randomUUID();
    await vpsStoreToken(userId, verificationToken, "email_verify", 24);
    const profile = await vpsGetProfile(userId);
    const name = profile?.name || cur.rows[0].full_name || cur.rows[0].username || email.split('@')[0];
    sendVerificationEmail(email, name, verificationToken, siteFromRequest(c))
      .catch((e) => log.warn({ err: e, email }, "set_email_verification_failed"));

    log.info({ userId, from: currentEmail, to: email }, 'user_email_filled_in');
    return c.json({
      success: true,
      email,
      message: "Почта сохранена. Мы отправили письмо со ссылкой для подтверждения.",
    });
  } catch (error) {
    log.error({ err: error }, "set_email_error");
    return c.json({ success: false, error: 'Внутренняя ошибка сервера' }, 500);
  }
});

auth.post("/verify-email", async (c) => {
  try {
    const { token } = await c.req.json();
    if (!token) return c.json({ success: false, error: "Токен обязателен" }, 400);

    const verifyData = await vpsGetToken(token);
    if (!verifyData) return c.json({ success: false, error: "Недействительная ссылка" }, 400);
    if (new Date() > new Date(verifyData.expiresAt)) { await vpsUseToken(token); return c.json({ success: false, error: "Ссылка истекла." }, 400); }

    await sql(`UPDATE users SET is_email_verified = true, email_verified_at = NOW() WHERE id = $1`, [verifyData.userId]);

    const profile = await vpsGetProfile(verifyData.userId);
    if (profile) { profile.isEmailVerified = true; profile.emailVerifiedAt = new Date().toISOString(); await vpsSaveProfile(verifyData.userId, profile); }
    await vpsUseToken(token);

    return c.json({ success: true, message: "Email подтверждён!" });
  } catch (error) {
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/resend-verification
// ──────────────────────────────────────────────────────────────────────
auth.post("/resend-verification", async (c) => {
  try {
    const token = c.req.header("Authorization")?.split(" ")[1];
    if (!token) return c.json({ success: false, error: "Authorization required" }, 401);
    const decoded = verifyToken(token);
    if (!decoded) return c.json({ success: false, error: "Invalid token" }, 401);

    const result = await sql(`SELECT id, email, is_email_verified, full_name FROM users WHERE id = $1`, [decoded.sub]);
    if (result.rows.length === 0) return c.json({ success: false, error: "Not found" }, 404);
    const user = result.rows[0];
    if (user.is_email_verified) return c.json({ success: true, message: "Email уже подтверждён" });

    const verificationToken = crypto.randomUUID();
    await vpsStoreToken(user.id, verificationToken, "email_verify", 24);
    const profile = await vpsGetProfile(user.id);
    await sendVerificationEmail(user.email, profile?.name || user.full_name || "User", verificationToken, siteFromRequest(c));
    return c.json({ success: true, message: "Письмо отправлено" });
  } catch (error) {
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /auth/verify-email-page?token=...
// ──────────────────────────────────────────────────────────────────────
auth.get("/verify-email-page", async (c) => {
  // Render an intermediate page that auto-submits via POST
  // This avoids state mutation on GET (CSRF-safe)
  const token = c.req.query("token");
  if (!token) return c.redirect(`${originFromRequest(c)}${PATH.login}?error=missing_token`);

  return c.html(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Подтверждение почты</title>
<style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#0a0a1a;color:#fff;font-family:sans-serif}
.card{text-align:center;padding:40px;border-radius:16px;background:#1a1a2e}</style></head>
<body><div class="card"><p>Подтверждаем почту…</p>
<form id="f" method="POST" action="/server/auth/verify-email-confirm">
<input type="hidden" name="token" value="${token.replace(/"/g, '&quot;')}">
</form><script>document.getElementById('f').submit()</script>
</div></body></html>`);
});

// POST /auth/verify-email-confirm — actual verification (state mutation via POST)
auth.post("/verify-email-confirm", async (c) => {
  let token: string | undefined;
  const ct = c.req.header("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    token = body.token as string;
  } else {
    const body = await c.req.json();
    token = body.token;
  }
  // Ссылка из письма открыта на сайте регистрации: туда же и редирект.
  const loginUrl = `${originFromRequest(c)}${PATH.login}`;
  if (!token) return c.redirect(`${loginUrl}?error=missing_token`);

  const verifyData = await vpsGetToken(token);
  if (!verifyData || new Date() > new Date(verifyData.expiresAt)) return c.redirect(`${loginUrl}?error=invalid_token`);

  // Check if already verified (idempotent — safe for GET)
  const alreadyVerified = await sql(`SELECT is_email_verified FROM users WHERE id = $1`, [verifyData.userId]);
  if (alreadyVerified.rows[0]?.is_email_verified) {
    await vpsUseToken(token);
    return c.redirect(`${loginUrl}?verified=true`);
  }

  await sql(`UPDATE users SET is_email_verified = true, email_verified_at = NOW() WHERE id = $1`, [verifyData.userId]);
  const profile = await vpsGetProfile(verifyData.userId);
  if (profile) { profile.isEmailVerified = true; profile.emailVerifiedAt = new Date().toISOString(); await vpsSaveProfile(verifyData.userId, profile); }
  await vpsUseToken(token);

  const userResult = await sql(`SELECT id, email, role::text, full_name FROM users WHERE id = $1`, [verifyData.userId]);
  if (userResult.rows.length > 0) {
    const user = userResult.rows[0];
    const autoLoginToken = crypto.randomUUID();
    await vpsStoreToken(user.id, autoLoginToken, "auto_login", 0.083);
    return c.redirect(`${loginUrl}?verified=true&auto_login_token=${autoLoginToken}`);
  }

  return c.redirect(`${loginUrl}?verified=true`);
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/resend-verification-by-email
// ──────────────────────────────────────────────────────────────────────
// Per-email cooldown, same rationale as request-reset (see above): the
// IP-based authLimiter doesn't stop "mailbomb a specific inbox via many IPs".
const VERIFY_EMAIL_COOLDOWN_MS = 60_000;
const recentVerifySends = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of recentVerifySends) {
    if (now - t > VERIFY_EMAIL_COOLDOWN_MS * 5) recentVerifySends.delete(k);
  }
}, VERIFY_EMAIL_COOLDOWN_MS).unref?.();

// Same fake-success response for every case (not-found / already-verified /
// cooldown / success) — never leak whether the email exists or its verify state.
const VERIFY_EMAIL_GENERIC_MSG = "Если аккаунт с таким email существует и не подтверждён, мы отправили письмо.";

auth.post("/resend-verification-by-email", async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ success: false, error: "Email обязателен" }, 400);

    const emailKey = String(email).toLowerCase().trim();

    // Same fake-success response for cooldown as for "not found" — never leak
    // whether the email exists or its verification state.
    const lastSent = recentVerifySends.get(emailKey);
    if (lastSent && Date.now() - lastSent < VERIFY_EMAIL_COOLDOWN_MS) {
      return c.json({ success: true, message: VERIFY_EMAIL_GENERIC_MSG });
    }

    const result = await sql(`SELECT id, email, is_email_verified, full_name FROM users WHERE email = $1`, [email]);
    if (result.rows.length === 0) {
      // Mark cooldown anyway, so probing for valid emails via timing is harder.
      recentVerifySends.set(emailKey, Date.now());
      return c.json({ success: true, message: VERIFY_EMAIL_GENERIC_MSG });
    }
    const user = result.rows[0];
    if (user.is_email_verified) {
      // Don't reveal that the account exists and is already verified.
      recentVerifySends.set(emailKey, Date.now());
      return c.json({ success: true, message: VERIFY_EMAIL_GENERIC_MSG });
    }

    const verificationToken = crypto.randomUUID();
    await vpsStoreToken(user.id, verificationToken, "email_verify", 24);
    const profile = await vpsGetProfile(user.id);
    await sendVerificationEmail(email, profile?.name || user.full_name || email.split("@")[0], verificationToken, siteFromRequest(c));
    recentVerifySends.set(emailKey, Date.now());
    return c.json({ success: true, message: VERIFY_EMAIL_GENERIC_MSG });
  } catch (error) {
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/change-password
// ──────────────────────────────────────────────────────────────────────
// 20.10.2026: сессия из cookie pf_session, как у requireAuth (фронты шлют
// только cookie, путь через Bearer отвечал 401 всем). Bearer оставлен для
// старых клиентов. Проверка token_version как в requireAuth. После смены
// пароля отзываются все refresh-токены и чистятся cookie: «все сессии
// завершены» теперь правда.
auth.post("/change-password", async (c) => {
  try {
    const token = getSessionCookie(c) || c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return c.json({ success: false, error: "Authorization required" }, 401);
    const decoded = verifyToken(token);
    if (!decoded) return c.json({ success: false, error: "Недействительная сессия." }, 401);

    const { currentPassword, newPassword } = await c.req.json();
    if (!currentPassword || !newPassword) return c.json({ success: false, error: "Оба пароля обязательны" }, 400);
    const pwErr2 = validatePassword(newPassword);
    if (pwErr2) return c.json({ success: false, error: pwErr2 }, 400);

    const result = await sql(`SELECT id, password_hash, token_version FROM users WHERE id = $1`, [decoded.sub]);
    if (result.rows.length === 0) return c.json({ success: false, error: "Not found" }, 404);
    if (decoded.tv !== undefined && (result.rows[0].token_version || 0) > (decoded.tv || 0)) {
      return c.json({ success: false, error: "Сессия устарела. Войдите заново." }, 401);
    }

    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash || '');
    if (!valid) return c.json({ success: false, error: "Неверный текущий пароль" }, 400);

    const newHash = await bcrypt.hash(newPassword, 12);
    await sql(`UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 1) + 1 WHERE id = $2`, [newHash, decoded.sub]);
    await revokeAllRefreshTokens(decoded.sub).catch((e: any) => log.warn({ err: e, userId: decoded.sub }, 'change_password_revoke_failed'));
    clearSessionCookie(c);
    clearRefreshCookie(c);
    return c.json({ success: true, message: "Пароль изменён. Все сессии завершены, войдите заново." });
  } catch (error) {
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /auth/admin/pending-users
// ──────────────────────────────────────────────────────────────────────
auth.get("/admin/pending-users", requireAuth, requireAdmin, async (c) => {
  try {
    // Audit B-3 (2026-05-31): pagination. Раньше отдавался полный dump
    // pending-users со всеми email + full_name. Surface маленький пока
    // requireAdmin фактически = superadmin, но defense-in-depth: если
    // когда-то requireAdmin ослабнет до role='admin' alone, full dump
    // = PII leak. Cap'аем limit на 200 чтобы не сделать /pending-users
    // = de-facto export endpoint.
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

    const [rows, totalRow] = await Promise.all([
      // LEFT JOIN radio_profiles — заявка радиостанции (название/частота/сайт/
      // эфир/телефон/должность) чтобы админ верифицировал перед approve/reject.
      sql(`SELECT u.id, u.email, u.full_name, u.role::text AS role, u.created_at, u.is_email_verified,
                  rp.station_name, rp.website, rp.stream_url, rp.frequency, rp.phone, rp.data AS radio_data
             FROM users u
             LEFT JOIN radio_profiles rp ON rp.user_id = u.id::text
            WHERE u.status = 'pending'
            ORDER BY u.created_at DESC
            LIMIT $1 OFFSET $2`, [limit, offset]),
      sql(`SELECT COUNT(*)::int AS total FROM users WHERE status = 'pending'`),
    ]);
    const total = totalRow.rows[0]?.total ?? 0;

    return c.json({
      success: true,
      data: rows.rows.map((u: any) => ({
        userId: u.id, email: u.email, name: u.full_name, role: u.role,
        createdAt: u.created_at, isEmailVerified: !!u.is_email_verified,
        application: (u.role === 'radio_station' || u.role === 'radio') ? {
          stationName: u.station_name || null,
          website: u.website || null,
          streamUrl: u.stream_url || null,
          frequency: u.frequency || null,
          phone: u.phone || null,
          position: u.radio_data?.application?.position || null,
          broadcastType: u.radio_data?.application?.broadcastType || null,
        } : undefined,
      })),
      pagination: { total, limit, offset, hasMore: offset + rows.rows.length < total },
    });
  } catch (error) {
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/admin/verify-profile
// Toggles is_verified on radio_profiles / venue_profiles / artist_profiles.
// SECOND-LEVEL trust gate, separate from approve-user (which only flips
// users.status='active'). Verified radio/venue accounts can download
// tracks for broadcast; verified artists get a public badge on their
// profile page. Newly-registered profiles start at is_verified=false.
//
// Artist verification (migration 058) is REQUEST-DRIVEN — the artist
// hits POST /artist-profile/request-verification to set
// verification_requested_at = NOW(); admin then approves/rejects here.
// On approve we stamp verification_approved_at; on reject we keep
// the request timestamp visible and store verification_rejection_reason
// so the frontend can show «Заявка отклонена: <reason>».
//
// body: {
//   userId: string,
//   role: 'radio_station'|'venue'|'artist',
//   isVerified: boolean,
//   rejectionReason?: string   // role='artist' && isVerified=false only
// }
// ──────────────────────────────────────────────────────────────────────
auth.post("/admin/verify-profile", requireAuth, requireAdmin, async (c) => {
  try {
    const { userId, role, isVerified, rejectionReason } = await c.req.json();
    if (!userId) return c.json({ success: false, error: 'userId обязателен' }, 400);
    // Migration 062 promoted venue/radio/producer to the same
    // extended verification flow as artist (058). Accept all four
    // roles. Producer was a no-op before 062 — the column didn't
    // exist on producer_profiles.
    if (role !== 'radio_station' && role !== 'venue' && role !== 'artist' && role !== 'producer') {
      return c.json({ success: false, error: "role должно быть 'radio_station', 'venue', 'artist' или 'producer'" }, 400);
    }
    if (typeof isVerified !== 'boolean') {
      return c.json({ success: false, error: 'isVerified должно быть boolean' }, 400);
    }

    // Audit B-10 (2026-05-31): verify userId actually HAS the role being
    // verified. Раньше caller выбирал table по `role` без проверки —
    // admin/fuzz мог flip is_verified на wrong profile row (например
    // verified-badge на producer-строке юзера который artist). Fail-open
    // если users.role отсутствует/unknown — не ломаем edge cases, но
    // блокируем явный mismatch.
    {
      const roleRow = await sql(`SELECT role FROM users WHERE id = $1 LIMIT 1`, [userId]);
      const actualRole = roleRow.rows[0]?.role as string | undefined;
      // radio/radio_station alias tolerance
      const norm = (r?: string) => (r === 'radio' ? 'radio_station' : r);
      if (actualRole && norm(actualRole) !== norm(role)) {
        return c.json({
          success: false,
          error: `Роль пользователя (${actualRole}) не совпадает с запрошенной (${role})`,
        }, 400);
      }
    }

    // All four roles now use the same extended state shape:
    //   On approve: stamp approved_at, clear any previous rejection_reason
    //     so stale rejection messages don't appear after a re-request.
    //   On reject:  keep the existing verification_requested_at so the
    //     UI shows "your request was reviewed" rather than reverting
    //     to "not started"; stash the optional reason in
    //     verification_rejection_reason.
    const table =
      role === 'artist'        ? 'artist_profiles' :
      role === 'radio_station' ? 'radio_profiles'  :
      role === 'venue'         ? 'venue_profiles'  :
                                 'producer_profiles';

    const result = await sql(
      `UPDATE ${table}
          SET is_verified                   = $1,
              verification_approved_at      = CASE WHEN $1 THEN NOW() ELSE verification_approved_at END,
              verification_rejection_reason = CASE WHEN $1 THEN NULL ELSE $3 END
        WHERE user_id = $2
       RETURNING user_id, is_verified, verification_rejection_reason`,
      [isVerified, userId, rejectionReason || null]
    );
    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Профиль не найден' }, 404);
    }

    // Audit B-8: forensic trail кто verified/unverified профиль.
    logAdminAction(c, {
      action: isVerified ? 'profile_verify' : 'profile_unverify',
      resourceType: 'profile',
      targetId: String(userId),
      details: { role, table, rejectionReason: rejectionReason || null },
    });

    // Fire-and-forget notification email. Distinct from
    // sendAccount{Approved,Rejected}Email which fire on USER-level
    // account approval (users.status='active'). These fire on
    // PROFILE verification (is_verified flag). On rejection without
    // a reason ("unverify" — admin demoting an already-verified
    // profile) we skip the email — no user-facing decision happened.
    try {
      const userRow = await sql(
        `SELECT email, full_name FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      const userEmail = userRow.rows[0]?.email;
      const userName = userRow.rows[0]?.full_name || '';
      if (userEmail) {
        // Админ работает на promo-music.ru, а письмо ведёт на сайт пользователя.
        if (isVerified) {
          siteForUserId(String(userId)).then((site) => sendProfileVerifiedEmail(userEmail, userName, role, site))
            .catch((e) => log.warn({ err: e, userId, role }, 'profile_verified_email_failed'));
        } else if (rejectionReason) {
          siteForUserId(String(userId)).then((site) => sendProfileVerificationRejectedEmail(userEmail, userName, role, rejectionReason, site))
            .catch((e) => log.warn({ err: e, userId, role }, 'profile_rejection_email_failed'));
        }
      }
    } catch (notifyErr) {
      log.warn({ err: notifyErr, userId, role }, 'profile_verification_notify_failed');
    }

    return c.json({
      success: true,
      data: result.rows[0],
      message: isVerified ? 'Профиль верифицирован' : (rejectionReason ? 'Заявка отклонена' : 'Верификация снята'),
    });
  } catch (error) {
    console.error('[admin/verify-profile] error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /auth/admin/approve-user
// ──────────────────────────────────────────────────────────────────────
// approve/reject не изменили строку: нет пользователя → 404, статус не
// 'pending' → 409 с текущим статусом (error читаемый: «Заявки партнёров»
// показывают его в тосте; code/status для кода, как в promo-air-admin).
async function moderationMiss(c: any, action: 'approve' | 'reject', userId: string) {
  const cur = await sql(`SELECT status::text AS status FROM users WHERE id::text = $1`, [userId]);
  if (cur.rows.length === 0) return c.json({ success: false, error: "Не найден" }, 404);
  const status = cur.rows[0].status;
  return c.json({ success: false, error: moderationConflictText(action, status), code: 'conflict', status }, 409);
}

auth.post("/admin/approve-user", requireAuth, requireAdmin, async (c) => {
  try {
    const { userId } = await c.req.json();
    if (!userId) return c.json({ success: false, error: "userId обязателен" }, 400);
    // Только pending → active: отклонённый или заблокированный аккаунт этой
    // кнопкой не «оживает» (раньше UPDATE шёл без условия на статус).
    const result = await sql(
      `UPDATE users SET status = 'active'::user_status, is_email_verified = true, email_verified_at = COALESCE(email_verified_at, NOW())
        WHERE id::text = $1 AND status::text = 'pending' RETURNING email, full_name`,
      [String(userId)]
    );
    if (result.rows.length === 0) return moderationMiss(c, 'approve', String(userId));
    const user = result.rows[0];
    siteForUserId(String(userId)).then((site) => sendAccountApprovedEmail(user.email, user.full_name || '', site)).catch(() => {});
    logAdminAction(c, { action: 'user_approve', resourceType: 'user', targetId: String(userId), details: { email: user.email } });
    const notifId = `notif_approved_${Date.now()}`;
    await upsertNotification(userId, notifId, { id: notifId, userId, type: "info", title: "Аккаунт одобрен!", message: "Ваша заявка одобрена.", read: false, createdAt: new Date().toISOString() });
    return c.json({ success: true, message: "Одобрен" });
  } catch (error) {
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/admin/reject-user
// ──────────────────────────────────────────────────────────────────────
auth.post("/admin/reject-user", requireAuth, requireAdmin, async (c) => {
  try {
    const { userId, reason } = await c.req.json();
    if (!userId) return c.json({ success: false, error: "userId обязателен" }, 400);
    // Только pending → rejected (как approve): действующий аккаунт отказом
    // из «Заявок партнёров» не выключить. 'rejected' в enum: миграция 162.
    const result = await sql(
      `UPDATE users SET status = 'rejected'::user_status WHERE id::text = $1 AND status::text = 'pending' RETURNING email, full_name`,
      [String(userId)]
    );
    if (result.rows.length === 0) return moderationMiss(c, 'reject', String(userId));
    const user = result.rows[0];
    siteForUserId(String(userId)).then((site) => sendAccountRejectedEmail(user.email, user.full_name || '', reason || '', site)).catch(() => {});
    logAdminAction(c, { action: 'user_reject', resourceType: 'user', targetId: String(userId), details: { email: user.email, reason: reason || null } });
    const notifId = `notif_rejected_${Date.now()}`;
    await upsertNotification(userId, notifId, { id: notifId, userId, type: "info", title: "Заявка отклонена", message: reason ? `Причина: ${reason}` : "Заявка отклонена.", read: false, createdAt: new Date().toISOString() });
    return c.json({ success: true, message: "Отклонено" });
  } catch (error) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});


// ──────────────────────────────────────────────────────────────────────
// POST /auth/admin/users/:id/status — блокировка/разблокировка пользователя
//
// Раньше FE (UsersManagement) бил в несуществующий /api/admin/users/:id/status
// → 404 при фейковом success-тосте: админ был уверен, что заблокировал юзера,
// а тот продолжал работать. Требует migration 122 ('blocked' в user_status).
//
// Блокировка: status='blocked' + token_version+1 → живые JWT умирают
// НЕМЕДЛЕННО (auth-middleware сверяет tv на каждом запросе), а не при
// следующем логине. Логин 'blocked' отбивается гейтом в /login.
// ──────────────────────────────────────────────────────────────────────
auth.post("/admin/users/:id/status", requireAuth, requireAdmin, async (c) => {
  try {
    const targetId = c.req.param('id');
    const { status } = await c.req.json();
    if (status !== 'blocked' && status !== 'active') {
      return c.json({ success: false, error: "status должен быть 'blocked' или 'active'" }, 400);
    }
    // Нельзя заблокировать самого себя (misclick-защита; разблокировать себя
    // тоже бессмысленно — активен раз выполняет запрос).
    if (String(c.get('userId')) === String(targetId)) {
      return c.json({ success: false, error: 'Нельзя изменить статус собственного аккаунта' }, 400);
    }
    const target = await sql(`SELECT email, role::text FROM users WHERE id::text = $1`, [targetId]);
    if (target.rows.length === 0) return c.json({ success: false, error: 'Не найден' }, 404);
    // Нельзя блокировать админов — только вручную через БД.
    const { isAdminEmail } = await import('./roles.tsx');
    if (status === 'blocked' && (isAdminEmail(target.rows[0].email) || ['admin', 'superadmin'].includes(target.rows[0].role))) {
      return c.json({ success: false, error: 'Нельзя заблокировать администратора' }, 403);
    }
    const result = status === 'blocked'
      ? await sql(
          `UPDATE users SET status = 'blocked'::user_status, token_version = COALESCE(token_version, 1) + 1
            WHERE id::text = $1 RETURNING email`,
          [targetId])
      : await sql(
          `UPDATE users SET status = 'active'::user_status WHERE id::text = $1 RETURNING email`,
          [targetId]);
    if (result.rows.length === 0) return c.json({ success: false, error: 'Не найден' }, 404);
    logAdminAction(c, {
      action: status === 'blocked' ? 'user_block' : 'user_unblock',
      resourceType: 'user', targetId: String(targetId),
      details: { email: result.rows[0].email },
    });
    return c.json({ success: true, status });
  } catch (error) {
    console.error('admin users status error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/exchange-auto-login — exchange short-lived token for JWT
// ──────────────────────────────────────────────────────────────────────
auth.post("/exchange-auto-login", async (c) => {
  try {
    const { token } = await c.req.json();
    if (!token) return c.json({ success: false, error: "Token required" }, 400);

    const tokenData = await vpsGetToken(token);
    if (!tokenData || tokenData.type !== 'auto_login') {
      return c.json({ success: false, error: "Invalid or expired token" }, 400);
    }

    await vpsUseToken(token);

    const result = await sql(
      `SELECT id, email, role::text, full_name, status::text, token_version FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [tokenData.userId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: "User not found" }, 404);

    const user = result.rows[0];
    // Токен выдаётся после подтверждения почты любому аккаунту, но сессию
    // получает только допущенный: заявка на проверке → 403
    // {error:'account_pending'} (фронт показывает «почта подтверждена,
    // аккаунт на проверке»), отказ/блокировка → те же 403, что у /signin.
    // До 17.10.2026 статус здесь не проверялся: это был обход модерации.
    const block = accountBlockOf(user.status);
    if (block) {
      log.info({ userId: user.id, status: user.status }, 'auto_login_refused');
      return c.json(autoLoginBlockBody(block), 403);
    }
    const accessToken = signToken({ id: user.id, email: user.email, role: user.role, token_version: user.token_version || 1 });
    setSessionCookie(c, accessToken);
    // Refresh-cookie как у /signin (20.10.2026): без неё сессия после входа по
    // ссылке из письма не продлевалась и обрывалась вместе с access-токеном.
    try {
      const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || '';
      const ua = c.req.header('user-agent') || '';
      const refreshTokenData = await createRefreshToken(user.id, ip, ua);
      setRefreshCookie(c, refreshTokenData.token);
    } catch (err) {
      log.warn({ err, userId: user.id }, 'auto_login_refresh_token_failed');
    }
    const profile = await vpsGetProfile(user.id);

    // Phase D C: accessToken убран. Auto-login через email-verification
    // ставит cookie через Set-Cookie (см. setSessionCookie выше) — frontend
    // не нуждается в JWT в body. Это закрывает XSS-vector (JWT через URL
    // или local cache).
    return c.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: profile?.name || user.full_name, role: user.role },
      },
    });
  } catch (error) {
    log.error({ err: error }, "exchange_auto_login_error");
    return c.json({ success: false, error: "Internal error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/refresh — H9: Exchange refresh token for new access token
// ──────────────────────────────────────────────────────────────────────
auth.post("/refresh", async (c) => {
  try {
    // Phase D C (2026-06-01): cookie-only. Body fallback на refreshToken
    // убран после B2 deploy — frontend шлёт пустой body, читаем
    // pf_refresh из HttpOnly cookie. Если кто-то всё ещё передаёт
    // body.refreshToken (curl, integration) — игнорируется.
    const refreshToken = getRefreshCookie(c);
    if (!refreshToken) return c.json({ success: false, error: "Refresh token required" }, 400);

    const validation = await validateRefreshToken(refreshToken);
    if (!validation.valid || !validation.userId) {
      return c.json({ success: false, error: validation.error || "Invalid refresh token" }, 401);
    }

    const result = await sql(
      `SELECT id, email, role::text, full_name, status::text, token_version FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [validation.userId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: "User not found" }, 404);

    const user = result.rows[0];
    // Гейт статуса, как у /signin: блокировка через POST /admin/users/:id/status
    // бампает token_version, но refresh-токены не отзывает, и без этой проверки
    // /refresh выдавал заблокированному новую сессию с актуальным tv.
    const block = accountBlockOf(user.status);
    if (block) {
      clearSessionCookie(c);
      clearRefreshCookie(c);
      return c.json(accountBlockBody(block), 403);
    }
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || '';
    const ua = c.req.header('user-agent') || '';

    // Rotate refresh token (old one revoked, new one issued).
    // Reuse-detection: после rotateRefreshToken старый токен в БД помечен
    // revoked_at — повторный /refresh с тем же refreshToken (cookie ещё
    // не успел обновиться у клиента) даст valid=false на validateRefresh
    // выше. Это намеренно: refresh-токен — одноразовый.
    const newRefresh = await rotateRefreshToken(refreshToken, user.id, ip, ua);
    if (!newRefresh) return c.json({ success: false, error: "Token rotation failed" }, 401);

    const accessToken = signToken({ id: user.id, email: user.email, role: user.role, token_version: user.token_version || 1 });
    setSessionCookie(c, accessToken);
    // Ротация: cookie должна получить НОВЫЙ refresh-токен, иначе при
    // следующем /refresh клиент пришлёт уже revoke'нутый старый.
    setRefreshCookie(c, newRefresh.token);

    // Phase D C: accessToken + refreshToken убраны. Frontend B2 шлёт
    // POST /auth/refresh пустым body и не читает body response —
    // достаточно Set-Cookie выше + 200 status.
    return c.json({ success: true });
  } catch (error) {
    log.error({ err: error }, "refresh_error");
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/mfa/setup — H7: Initialize MFA (requires auth)
// ──────────────────────────────────────────────────────────────────────
auth.post("/mfa/setup", requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const result = await setupMFA(userId);
    return c.json({ success: true, data: result });
  } catch (error) {
    log.error({ err: error }, "mfa_setup_error");
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// POST /auth/admin/send-activation-batch — рассылка активационных писем
// legacy-импортированным артистам. Throttle через batch_size+sleep.
// ──────────────────────────────────────────────────────────────────────
auth.post("/admin/send-activation-batch", requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const batchSize = Math.max(1, Math.min(500, parseInt(body.batchSize || '250', 10)));
    const dryRun = body.dryRun === true;

    const { rows } = await sql(`
      SELECT id::text AS id, email, full_name, display_name
        FROM users
       WHERE role::text = 'artist'
         AND password_hash IS NULL
         AND activation_email_sent_at IS NULL
         AND email IS NOT NULL
         AND deleted_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1
    `, [batchSize]);

    if (dryRun) {
      return c.json({
        success: true,
        dryRun: true,
        wouldSend: rows.length,
        sample: rows.slice(0, 5).map((r: any) => ({ email: r.email, name: r.display_name || r.full_name })),
      });
    }

    let sent = 0, failed = 0;
    for (const u of rows) {
      try {
        const token = crypto.randomUUID();
        await vpsStoreToken(u.id, token, 'password_reset', 24 * 7);  // 7 days
        const name = (u.display_name || u.full_name || (u.email as string).split('@')[0]) as string;
        const ok = await sendActivationEmail(u.email, name, token);
        if (ok) {
          await sql(`UPDATE users SET activation_email_sent_at = NOW() WHERE id = $1`, [u.id]);
          sent++;
        } else {
          failed++;
        }
      } catch (err) {
        log.warn({ err, userId: u.id }, 'activation_email_failed');
        failed++;
      }
    }

    return c.json({
      success: true,
      batchSize,
      processed: rows.length,
      sent,
      failed,
    });
  } catch (error) {
    log.error({ err: error }, 'activation_batch_error');
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// POST /auth/mfa/verify — H7: Verify TOTP code and enable MFA
// ──────────────────────────────────────────────────────────────────────
auth.post("/mfa/verify", requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const { code } = await c.req.json();
    if (!code) return c.json({ success: false, error: "Code required" }, 400);

    const result = await verifyAndEnableMFA(userId, code);
    if (!result.success) return c.json({ success: false, error: result.error }, 400);

    sendSecurityAlert('MFA Enabled', `User ${userId} enabled 2FA`).catch(() => {});
    return c.json({ success: true, message: "2FA включена" });
  } catch (error) {
    log.error({ err: error }, "mfa_verify_error");
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/mfa/disable — H7: Disable MFA (requires password)
// ──────────────────────────────────────────────────────────────────────
auth.post("/mfa/disable", requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const { password } = await c.req.json();
    if (!password) return c.json({ success: false, error: "Password required" }, 400);

    const result = await sql(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    if (result.rows.length === 0) return c.json({ success: false, error: "Not found" }, 404);

    const valid = await bcrypt.compare(password, result.rows[0].password_hash || '');
    if (!valid) return c.json({ success: false, error: "Wrong password" }, 401);

    await disableMFA(userId);
    sendSecurityAlert('MFA Disabled', `User ${userId} disabled 2FA`).catch(() => {});
    return c.json({ success: true, message: "2FA отключена" });
  } catch (error) {
    log.error({ err: error }, "mfa_disable_error");
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /auth/mfa/status — H7: Check MFA status
// ──────────────────────────────────────────────────────────────────────
auth.get("/mfa/status", requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const enabled = await isMFAEnabled(userId);
    return c.json({ success: true, data: { mfaEnabled: enabled } });
  } catch (error) {
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});


export default auth;
