/**
 * AUTH ROUTES
 * Регистрация, вход, VK OAuth, сброс пароля, верификация email
 * PostgreSQL + bcrypt + JWT (БЕЗ Supabase)
 */

import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { upsertNotification } from './db.tsx';
import { vpsGetProfile, vpsSaveProfile, vpsStoreToken, vpsGetToken, vpsUseToken } from './vps-userdata.tsx';
import { notifyNewUser, sendPasswordResetEmail, sendVerificationEmail, sendAccountApprovedEmail, sendAccountRejectedEmail } from "./email-helper.tsx";
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const PARTNER_ROLES = ['radio_station', 'radio', 'venue'];
const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = '7d';

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
  return Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
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
    console.error('Audit log error:', e);
  }
}


// ──────────────────────────────────────────────────────────────────────
// POST /auth/signup  —  Email-регистрация
// ──────────────────────────────────────────────────────────────────────
auth.post("/signup", async (c) => {
  try {
    const { email, password, name, role, consentPersonalData, consentNewsletter } = await c.req.json();
    if (!email || !password) return c.json({ success: false, error: "Email и пароль обязательны" }, 400);
    const pwErr = validatePassword(password);
    if (pwErr) return c.json({ success: false, error: pwErr }, 400);
    if (!consentPersonalData) return c.json({ success: false, error: "Необходимо согласие на обработку персональных данных" }, 400);

    const userRole = role || "artist";
    const isPartner = PARTNER_ROLES.includes(userRole);
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
        });
        return c.json({ success: false, error: "Ошибка регистрации. Если у вас уже есть аккаунт, попробуйте войти или восстановить пароль." }, 409);
      } else {
        console.error("DB insert user error:", err);
        return c.json({ success: false, error: 'Ошибка регистрации' }, 400);
      }
    }

    await createVpsProfile(userId, email, userName, userRole);
    console.log(`User registered: ${email} (${userId}), role: ${userRole}, status: ${accountStatus}`);
    logAuthEvent('signup_success', {
      userId, description: `Регистрация: ${email}, роль: ${userRole}`,
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
      userAgent: c.req.header('user-agent') || '',
    });

    notifyNewUser({ email, name: userName, role: userRole, via: "email", needsApproval: isPartner }).catch(() => {});

    const verificationToken = crypto.randomUUID();
    await vpsStoreToken(userId, verificationToken, "email_verify", 24);
    sendVerificationEmail(email, userName, verificationToken).catch((e) => console.warn("Verification email failed:", e));

    return c.json({
      success: true, emailVerificationRequired: true,
      accountStatus: isPartner ? 'pending' : 'active',
      message: isPartner ? 'Заявка отправлена на модерацию.' : undefined,
      data: { user: { id: userId, email, name: userName, role: userRole } },
    }, 201);
  } catch (error) {
    console.error("Signup error:", error);
    logAuthEvent('signup_error', {
      description: `Ошибка регистрации`, error: String(error),
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
      userAgent: c.req.header('user-agent') || '',
    });
    return c.json({ success: false, error: 'Внутренняя ошибка сервера' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/signin  —  Вход через email/пароль
// ──────────────────────────────────────────────────────────────────────
auth.post("/signin", async (c) => {
  try {
    const { email, password } = await c.req.json();
    if (!email || !password) return c.json({ success: false, error: "Email и пароль обязательны" }, 400);

    const result = await sql(
      `SELECT id, email, password_hash, full_name, username, role::text, status::text, is_email_verified, avatar_url, token_version
       FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]
    );
    if (result.rows.length === 0) {
      logAuthEvent('signin_fail', {
        description: `Пользователь не найден: ${email}`, error: 'user_not_found',
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
        userAgent: c.req.header('user-agent') || '',
      });
      return c.json({ success: false, error: "Ошибка входа: Invalid login credentials" }, 401);
    }

    const user = result.rows[0];

    if (!user.is_email_verified) {
      return c.json({ success: false, error: "Email не подтверждён. Проверьте почту.", requiresVerification: true }, 401);
    }

    const valid = await bcrypt.compare(password, user.password_hash || '');
    if (!valid) {
      logAuthEvent('signin_fail', {
        description: `Неверный пароль: ${email}`, error: 'wrong_password',
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
        userAgent: c.req.header('user-agent') || '',
      });
      return c.json({ success: false, error: "Ошибка входа: Invalid login credentials" }, 401);
    }

    if (user.status === 'pending') return c.json({ success: false, error: 'Ваш аккаунт на модерации.', accountStatus: 'pending' }, 403);
    if (user.status === 'rejected') return c.json({ success: false, error: 'Ваша заявка отклонена.', accountStatus: 'rejected' }, 403);

    const accessToken = signToken({ id: user.id, email: user.email, role: user.role, token_version: user.token_version || 1 });
    await sql(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
    logAuthEvent('signin_success', {
      userId: user.id, description: `Вход: ${email}, роль: ${user.role}`,
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
      userAgent: c.req.header('user-agent') || '',
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

    console.log(`User signed in: ${email} (${user.id})`);
    return c.json({
      success: true,
      data: {
        user: { id: user.id, email, name: profile.name || user.full_name, role: user.role, isEmailVerified: true, accountStatus: user.status },
        accessToken, expiresAt: tokenExpiresAt(),
      },
    });
  } catch (error) {
    console.error("Signin error:", error);
    return c.json({ success: false, error: 'Внутренняя ошибка сервера' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/vk-callback  —  VK ID OAuth
// ──────────────────────────────────────────────────────────────────────
auth.post("/vk-callback", async (c) => {
  try {
    const { code, redirect_uri, code_verifier, device_id, role: vkRequestedRole } = await c.req.json();
    if (!code) return c.json({ success: false, error: "VK authorization code required" }, 400);

    const VK_CLIENT_ID = process.env.VK_CLIENT_ID || "";
    const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET || "";
    if (!VK_CLIENT_ID || !VK_CLIENT_SECRET) return c.json({ success: false, error: "VK OAuth не настроен" }, 500);

    // 1. Exchange code for access_token
    const tokenBody: Record<string, string> = {
      grant_type: "authorization_code", client_id: VK_CLIENT_ID, client_secret: VK_CLIENT_SECRET,
      code, redirect_uri: redirect_uri || "https://promo-music.ru/login",
    };
    if (device_id) tokenBody.device_id = device_id;
    if (code_verifier) tokenBody.code_verifier = code_verifier;

    console.log(`VK token exchange: client_id=${VK_CLIENT_ID}, redirect_uri=${tokenBody.redirect_uri}`);
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

    console.log(`VK OAuth: user ${vkUserId}, name: ${vkName}, email: ${email}`);

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
      return c.json({
        success: true, newUser: false,
        data: { user: { id: eu.id, email: eu.email, name: profile?.name || eu.full_name || vkName, role }, accessToken },
      });
    }

    // 4. New user
    const userEmail = email || `vk${vkUserId}@promo-music.ru`;
    const passwordHash = await bcrypt.hash(crypto.randomUUID() + crypto.randomUUID(), 12);
    const vkRole = vkRequestedRole || "artist";
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
          const profile = await vpsGetProfile(eu.id);
          return c.json({
            success: true, newUser: false,
            data: { user: { id: eu.id, email: userEmail, name: profile?.name || eu.full_name || vkName, role: eu.role || "artist" }, accessToken },
          });
        }
        return c.json({ success: false, error: "Пользователь с таким email уже зарегистрирован." }, 409);
      }
      console.error('VK user create error:', err);
      return c.json({ success: false, error: 'Ошибка создания аккаунта' }, 400);
    }

    await createVpsProfile(userId, userEmail, vkName, vkRole, vkAvatar);
    notifyNewUser({ email: userEmail, name: vkName, role: vkRole, via: "vk_oauth" }).catch(() => {});

    const accessToken = signToken({ id: userId, email: userEmail, role: vkRole });
    console.log(`VK new user created: ${userEmail} (${userId})`);

    return c.json({
      success: true, newUser: true,
      data: { user: { id: userId, email: userEmail, name: vkName, avatar: vkAvatar, role: vkRole }, accessToken },
    });
  } catch (error) {
    console.error("VK callback error:", error);
    return c.json({ success: false, error: "VK OAuth ошибка" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/set-role
// ──────────────────────────────────────────────────────────────────────
auth.post("/set-role", requireAuth, async (c) => {
  try {
    const authUserId = c.get('userId');
    const authRole = c.get('userRole');
    const { userId, role } = await c.req.json();
    if (!userId || !role) return c.json({ success: false, error: "userId and role are required" }, 400);

    // Only admin or self can change role
    if (userId !== authUserId && authRole !== 'admin') {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const validRoles = ["artist", "dj", "radio_station", "venue", "producer"];
    if (!validRoles.includes(role)) return c.json({ success: false, error: `Недопустимая роль: ${role}` }, 400);

    const result = await sql(`UPDATE users SET role = $1::user_role WHERE id = $2 RETURNING *`, [role, userId]);
    if (result.rows.length === 0) {
      return c.json({ success: false, error: "Пользователь не найден" }, 404);
    }

    let profile = await vpsGetProfile(userId);
    if (profile) {
      profile.role = role;
      profile.updatedAt = new Date().toISOString();
      await vpsSaveProfile(userId, profile);
    } else {
      const user = result.rows[0];
      await createVpsProfile(userId, user.email, user.full_name, role, user.avatar_url);
    }

    console.log(`Role set for ${userId}: ${role}`);
    return c.json({ success: true, role });
  } catch (error) {
    console.error("Set role error:", error);
    return c.json({ success: false, error: 'Внутренняя ошибка сервера' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /auth/me
// ──────────────────────────────────────────────────────────────────────
auth.get("/me", async (c) => {
  try {
    const token = c.req.header("Authorization")?.split(" ")[1];
    if (!token) return c.json({ success: false, error: "Authorization header required" }, 401);

    const decoded = verifyToken(token);
    if (!decoded) return c.json({ success: false, error: "Invalid or expired token" }, 401);

    const result = await sql(`SELECT id, email, full_name, role::text, is_verified, is_email_verified, avatar_url FROM users WHERE id = $1`, [decoded.sub]);
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
    console.error("Auth me error:", error);
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/signout
// ──────────────────────────────────────────────────────────────────────
auth.post("/signout", async (c) => {
  try {
    const token = c.req.header("Authorization")?.split(" ")[1];
    if (token) {
      const decoded = verifyToken(token);
      if (decoded) {
        await sql(`UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = $1`, [decoded.sub]);
        console.log(`User signed out (tokens revoked): ${decoded.email} (${decoded.sub})`);
      }
    }
    return c.json({ success: true, message: "Signed out successfully" });
  } catch {
    return c.json({ success: true, message: "Signed out" });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/request-reset
// ──────────────────────────────────────────────────────────────────────
auth.post("/request-reset", async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ success: false, error: "Email обязателен" }, 400);

    const result = await sql(`SELECT id, full_name FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
    if (result.rows.length === 0) {
      return c.json({ success: true, message: "Если аккаунт с таким email существует, мы отправили письмо." });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomUUID();
    await vpsStoreToken(user.id, resetToken, "password_reset", 1);

    const profile = await vpsGetProfile(user.id);
    await sendPasswordResetEmail(email, profile?.name || user.full_name || email.split("@")[0], resetToken);
    console.log(`Password reset email sent to: ${email}`);
    return c.json({ success: true, message: "Если аккаунт с таким email существует, мы отправили письмо." });
  } catch (error) {
    console.error("Request reset error:", error);
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
    if (new Date() > new Date(resetData.expiresAt)) { await vpsUseToken(token); return c.json({ success: false, error: "Ссылка истекла." }, 400); }
    if (resetData.usedAt) return c.json({ success: false, error: "Ссылка уже использована." }, 400);

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await sql(`UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 1) + 1 WHERE id = $2`, [passwordHash, resetData.userId]);
    await vpsUseToken(token);

    console.log(`Password reset for: ${resetData.userId}`);
    return c.json({ success: true, message: "Пароль обновлён." });
  } catch (error) {
    console.error("Reset password error:", error);
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
  const token = c.req.query("token");
  if (!token) return c.redirect("https://promo-music.ru/login?error=missing_token");

  const verifyData = await vpsGetToken(token);
  if (!verifyData || new Date() > new Date(verifyData.expiresAt)) return c.redirect("https://promo-music.ru/login?error=invalid_token");

  await sql(`UPDATE users SET is_email_verified = true, email_verified_at = NOW() WHERE id = $1`, [verifyData.userId]);
  const profile = await vpsGetProfile(verifyData.userId);
  if (profile) { profile.isEmailVerified = true; profile.emailVerifiedAt = new Date().toISOString(); await vpsSaveProfile(verifyData.userId, profile); }
  await vpsUseToken(token);

  // Auto-login: get user data, generate JWT, redirect to cabinet
  const userResult = await sql(`SELECT id, email, role::text, full_name FROM users WHERE id = $1`, [verifyData.userId]);
  if (userResult.rows.length > 0) {
    const user = userResult.rows[0];
    // Generate short-lived auto-login token (5 min) stored server-side
    const autoLoginToken = crypto.randomUUID();
    await vpsStoreToken(user.id, autoLoginToken, "auto_login", 0.083); // 5 minutes
    return c.redirect(`https://promo-music.ru/login?verified=true&auto_login_token=${autoLoginToken}`);
  }

  return c.redirect("https://promo-music.ru/login?verified=true");
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/resend-verification-by-email
// ──────────────────────────────────────────────────────────────────────
auth.post("/resend-verification-by-email", async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) return c.json({ success: false, error: "Email обязателен" }, 400);

    const result = await sql(`SELECT id, email, is_email_verified, full_name FROM users WHERE email = $1`, [email]);
    if (result.rows.length === 0) return c.json({ success: true, message: "Если аккаунт существует, письмо отправлено" });
    const user = result.rows[0];
    if (user.is_email_verified) return c.json({ success: false, error: "Email уже подтверждён." }, 400);

    const verificationToken = crypto.randomUUID();
    await vpsStoreToken(user.id, verificationToken, "email_verify", 24);
    const profile = await vpsGetProfile(user.id);
    await sendVerificationEmail(email, profile?.name || user.full_name || email.split("@")[0], verificationToken);
    return c.json({ success: true, message: "Письмо отправлено" });
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
    const result = await sql(`SELECT id, email, full_name, role::text, created_at FROM users WHERE status = 'pending' ORDER BY created_at DESC`);
    return c.json({ success: true, data: result.rows.map((u: any) => ({ userId: u.id, email: u.email, name: u.full_name, role: u.role, createdAt: u.created_at })) });
  } catch (error) {
    return c.json({ success: false, error: "Internal server error" }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/admin/approve-user
// ──────────────────────────────────────────────────────────────────────
auth.post("/admin/approve-user", requireAuth, requireAdmin, async (c) => {
  try {
    const { userId } = await c.req.json();
    if (!userId) return c.json({ success: false, error: "userId обязателен" }, 400);
    const result = await sql(`UPDATE users SET status = 'active'::user_status WHERE id = $1 RETURNING email, full_name`, [userId]);
    if (result.rows.length === 0) return c.json({ success: false, error: "Не найден" }, 404);
    const user = result.rows[0];
    sendAccountApprovedEmail(user.email, user.full_name || '').catch(() => {});
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
    const notifId = `notif_rejected_${Date.now()}`;
    await upsertNotification(userId, notifId, { id: notifId, userId, type: "info", title: "Заявка отклонена", message: reason ? `Причина: ${reason}` : "Заявка отклонена.", read: false, createdAt: new Date().toISOString() });
    return c.json({ success: true, message: "Отклонено" });
  } catch (error) {
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
    const profile = await vpsGetProfile(user.id);

    return c.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: profile?.name || user.full_name, role: user.role },
        accessToken, expiresAt: tokenExpiresAt(),
      },
    });
  } catch (error) {
    console.error("Exchange auto-login error:", error);
    return c.json({ success: false, error: "Internal error" }, 500);
  }
});

export default auth;
