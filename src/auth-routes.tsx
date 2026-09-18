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

import { createLogger } from "./logger.tsx";

const log = createLogger("auth");

const PARTNER_ROLES = ['radio_station', 'radio', 'venue'];
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
async function createVpsProfile(userId: string, email: string, name: string, role: string, avatar?: string | null) {
  const accountStatus = PARTNER_ROLES.includes(role || 'artist') ? 'pending' : 'active';
  await vpsSaveProfile(userId, { email, name: name || email.split("@")[0], role: role || "artist", avatar: avatar || null, accountStatus });
  const notifId = `notif_${Date.now()}`;
  await upsertNotification(userId, notifId, {
    id: notifId, userId, type: "info",
    title: "Добро пожаловать в ПРОМО.МУЗЫКА!",
    message: "Ваш аккаунт создан. Загрузите свой первый трек и начните продвижение.",
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
async function createVpsProfileOrRollback(userId: string, email: string, name: string, role: string, avatar?: string | null): Promise<boolean> {
  try {
    await createVpsProfile(userId, email, name, role, avatar);
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
    const { email, password, name, role, consentPersonalData, consentNewsletter, captchaToken, applicationDetails } = body;
    // H6: reCAPTCHA v3 verification (skipped if not configured)
    const captchaResult = await verifyCaptcha(captchaToken, 'signup');
    if (!captchaResult.ok) return c.json({ success: false, error: captchaResult.error || 'Проверка CAPTCHA не пройдена' }, 403);
    if (!email || !password) return c.json({ success: false, error: "Email и пароль обязательны" }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ success: false, error: "Некорректный формат email" }, 400);
    const pwErr = validatePassword(password);
    if (pwErr) return c.json({ success: false, error: pwErr }, 400);
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

    const accountStatus = isPartner ? 'pending' : 'active';
    const userName = name || email.split("@")[0];
    const passwordHash = await bcrypt.hash(password, 12);
    const username = makeUsername(email, userName);

    let userId: string;
    try {
      const result = await sql(
        `INSERT INTO users (email, password_hash, username, full_name, role, status, is_email_verified, consent_personal_data, consent_newsletter, consent_at)
         VALUES ($1, $2, $3, $4, $5::user_role, $6::user_status, false, $7, $8, now()) RETURNING id`,
        [email, passwordHash, username, userName, userRole, accountStatus, !!consentPersonalData, !!consentNewsletter]
      );
      userId = result.rows[0].id;
    } catch (err: any) {
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

    const profileOk = await createVpsProfileOrRollback(userId, email, userName, userRole);
    if (!profileOk) {
      return c.json({ success: false, error: 'Ошибка регистрации — не удалось создать профиль. Попробуйте ещё раз.' }, 500);
    }

    // Радиозаявка: пишем данные в radio_profiles (колонки уже есть) +
    // position/broadcastType в data jsonb — чтобы админ верифицировал перед approve.
    if (radioApp) {
      try {
        await sql(
          `UPDATE radio_profiles
              SET station_name = $2, name = $2, website = $3,
                  stream_url = NULLIF($4, ''), frequency = NULLIF($5, ''), phone = $6,
                  data = COALESCE(data, '{}'::jsonb) || $7::jsonb, updated_at = now()
            WHERE user_id = $1`,
          [userId, radioApp.stationName, radioApp.website, radioApp.streamUrl, radioApp.frequency, radioApp.phone,
           JSON.stringify({ application: { position: radioApp.position, broadcastType: radioApp.broadcastType, submittedAt: new Date().toISOString() } })]
        );
      } catch (e) { log.warn({ err: e, userId }, 'radio_application_store_failed'); }
    }

    log.info({ email, userId, role: userRole, status: accountStatus }, 'user_registered');
    logAuthEvent('signup_success', {
      userId, description: `Регистрация: ${email}, роль: ${userRole}`,
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
      userAgent: c.req.header('user-agent') || '',
    });

    notifyNewUser({ email, name: userName, role: userRole, via: "email", needsApproval: isPartner, application: radioApp || undefined }).catch(() => {});

    const verificationToken = crypto.randomUUID();
    await vpsStoreToken(userId, verificationToken, "email_verify", 24);
    sendVerificationEmail(email, userName, verificationToken).catch((e) => log.warn({ err: e, email }, "verification_email_failed"));

    // Venue-specific welcome — fires alongside the standard
    // verification email so the new venue understands the 14-day trial
    // + next steps (onboarding wizard → admin queue → pairing code).
    // Other roles get only the verification email.
    if (userRole === 'venue') {
      sendVenueRadioWelcomeEmail({ toEmail: email, venueName: userName })
        .catch((e) => log.warn({ err: e, email }, 'venue_welcome_email_failed'));
    }

    return c.json({
      success: true, emailVerificationRequired: true,
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
        error: "У этого аккаунта ещё нет пароля — он создан при переносе базы. Мы отправили на вашу почту ссылку, чтобы задать пароль.",
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

    if (user.status === 'pending') return c.json({ success: false, error: 'Ваш аккаунт на модерации.', accountStatus: 'pending' }, 403);
    if (user.status === 'rejected') return c.json({ success: false, error: 'Ваша заявка отклонена.', accountStatus: 'rejected' }, 403);
    // 'blocked' ставит админ (POST /admin/users/:id/status, migration 122).
    // Живые сессии убиты бампом token_version в момент блокировки; этот гейт
    // закрывает повторный вход по паролю.
    if (user.status === 'blocked') return c.json({ success: false, error: 'Аккаунт заблокирован администрацией.', accountStatus: 'blocked' }, 403);

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

    // Validate redirect_uri — prevent OAuth redirect manipulation
    const ALLOWED_REDIRECT_URIS = [
      'https://promo-music.ru/login',
      'https://www.promo-music.ru/login',
      'https://promo-music.ru/register',
      'https://www.promo-music.ru/register',
      'https://promo-music.ru/auth/vk/callback',
      'https://www.promo-music.ru/auth/vk/callback',
    ];
    const effectiveRedirectUri = redirect_uri || 'https://promo-music.ru/login';
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
        const byEmail = await sql(`SELECT id, email, full_name, role::text FROM users WHERE email = $1`, [userEmail]);
        if (byEmail.rows.length > 0) {
          const eu = byEmail.rows[0];
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
      return c.json({ success: false, error: 'Ошибка создания аккаунта — не удалось создать профиль' }, 500);
    }
    notifyNewUser({ email: userEmail, name: vkName, role: vkRole, via: "vk_oauth" }).catch(() => {});

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
    await sendPasswordResetEmail(email, profile?.name || user.full_name || email.split("@")[0], resetToken);
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
    await sql(
      `UPDATE users SET
         password_hash    = $1,
         token_version    = COALESCE(token_version, 1) + 1,
         is_email_verified = TRUE,
         email_verified_at = COALESCE(email_verified_at, NOW()),
         status            = CASE WHEN status::text = 'pending' THEN 'active'::user_status ELSE status END
       WHERE id = $2`,
      [passwordHash, resetData.userId]
    );
    await vpsUseToken(token);

    log.info({ userId: resetData.userId }, 'password_reset_completed');
    return c.json({ success: true, message: "Пароль обновлён." });
  } catch (error) {
    log.error({ err: error }, "reset_password_error");
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/verify-email
// ──────────────────────────────────────────────────────────────────────
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
    await sendVerificationEmail(user.email, profile?.name || user.full_name || "User", verificationToken);
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
  if (!token) return c.redirect("https://promo-music.ru/login?error=missing_token");

  return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Email Verification</title>
<style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#0a0a1a;color:#fff;font-family:sans-serif}
.card{text-align:center;padding:40px;border-radius:16px;background:#1a1a2e}</style></head>
<body><div class="card"><p>Confirming your email...</p>
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
  if (!token) return c.redirect("https://promo-music.ru/login?error=missing_token");

  const verifyData = await vpsGetToken(token);
  if (!verifyData || new Date() > new Date(verifyData.expiresAt)) return c.redirect("https://promo-music.ru/login?error=invalid_token");

  // Check if already verified (idempotent — safe for GET)
  const alreadyVerified = await sql(`SELECT is_email_verified FROM users WHERE id = $1`, [verifyData.userId]);
  if (alreadyVerified.rows[0]?.is_email_verified) {
    await vpsUseToken(token);
    return c.redirect("https://promo-music.ru/login?verified=true");
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
    return c.redirect(`https://promo-music.ru/login?verified=true&auto_login_token=${autoLoginToken}`);
  }

  return c.redirect("https://promo-music.ru/login?verified=true");
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
    await sendVerificationEmail(email, profile?.name || user.full_name || email.split("@")[0], verificationToken);
    recentVerifySends.set(emailKey, Date.now());
    return c.json({ success: true, message: VERIFY_EMAIL_GENERIC_MSG });
  } catch (error) {
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/change-password
// ──────────────────────────────────────────────────────────────────────
auth.post("/change-password", async (c) => {
  try {
    const token = c.req.header("Authorization")?.split(" ")[1];
    if (!token) return c.json({ success: false, error: "Authorization required" }, 401);
    const decoded = verifyToken(token);
    if (!decoded) return c.json({ success: false, error: "Недействительная сессия." }, 401);

    const { currentPassword, newPassword } = await c.req.json();
    if (!currentPassword || !newPassword) return c.json({ success: false, error: "Оба пароля обязательны" }, 400);
    const pwErr2 = validatePassword(newPassword);
    if (pwErr2) return c.json({ success: false, error: pwErr2 }, 400);

    const result = await sql(`SELECT id, password_hash FROM users WHERE id = $1`, [decoded.sub]);
    if (result.rows.length === 0) return c.json({ success: false, error: "Not found" }, 404);

    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash || '');
    if (!valid) return c.json({ success: false, error: "Неверный текущий пароль" }, 400);

    const newHash = await bcrypt.hash(newPassword, 12);
    await sql(`UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 1) + 1 WHERE id = $2`, [newHash, decoded.sub]);
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
        if (isVerified) {
          sendProfileVerifiedEmail(userEmail, userName, role)
            .catch((e) => log.warn({ err: e, userId, role }, 'profile_verified_email_failed'));
        } else if (rejectionReason) {
          sendProfileVerificationRejectedEmail(userEmail, userName, role, rejectionReason)
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
auth.post("/admin/approve-user", requireAuth, requireAdmin, async (c) => {
  try {
    const { userId } = await c.req.json();
    if (!userId) return c.json({ success: false, error: "userId обязателен" }, 400);
    const result = await sql(`UPDATE users SET status = 'active'::user_status, is_email_verified = true, email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1 RETURNING email, full_name`, [userId]);
    if (result.rows.length === 0) return c.json({ success: false, error: "Не найден" }, 404);
    const user = result.rows[0];
    sendAccountApprovedEmail(user.email, user.full_name || '').catch(() => {});
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
    const result = await sql(`UPDATE users SET status = 'rejected'::user_status WHERE id = $1 RETURNING email, full_name`, [userId]);
    if (result.rows.length === 0) return c.json({ success: false, error: "Не найден" }, 404);
    const user = result.rows[0];
    sendAccountRejectedEmail(user.email, user.full_name || '', reason || '').catch(() => {});
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
      `SELECT id, email, role::text, full_name, status::text, token_version FROM users WHERE id = $1`,
      [tokenData.userId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: "User not found" }, 404);

    const user = result.rows[0];
    const accessToken = signToken({ id: user.id, email: user.email, role: user.role, token_version: user.token_version || 1 });
    setSessionCookie(c, accessToken);
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
      `SELECT id, email, role::text, full_name, token_version FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [validation.userId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: "User not found" }, 404);

    const user = result.rows[0];
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
