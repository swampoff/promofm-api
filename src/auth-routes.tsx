/**
 * AUTH ROUTES
 * Регистрация, вход, VK OAuth, сброс пароля, верификация email
 * через Supabase Auth Admin API + Resend email
 */

import { Hono } from 'hono';
import { getDbClient, createAnonDbClient } from "./db-client.tsx";
import { upsertNotification } from './db.tsx';
import { vpsGetProfile, vpsSaveProfile, vpsUpdateProfile, vpsDeleteProfile, vpsListProfiles, vpsStoreToken, vpsGetToken, vpsUseToken, vpsLogAuth } from './vps-userdata.tsx';
import { notifyNewUser, sendPasswordResetEmail, sendVerificationEmail, sendAccountApprovedEmail, sendAccountRejectedEmail } from "./email-helper.tsx";
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const PARTNER_ROLES = ['dj', 'radio_station', 'radio', 'venue', 'producer'];

const auth = new Hono();

function getAdminClient() {
  return getDbClient();
}

// ── Helper: создать профиль на VPS (152-ФЗ) ────────────────────────────────────
async function createKVProfile(userId: string, email: string, name: string, role: string, avatar?: string | null) {
  const profile = {
    userId, email,
    name: name || email.split("@")[0],
    role: role || "artist",
    avatar: avatar || null,
    bio: "", genre: "", city: "",
    socialLinks: {},
    subscribers: 0, totalPlays: 0, totalTracks: 0,
    isVerified: false,
    isEmailVerified: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const accountStatus = PARTNER_ROLES.includes(role || 'artist') ? 'pending' : 'active';
  await vpsSaveProfile(userId, { email, name: profile.name, role: profile.role, avatar: profile.avatar, accountStatus });

  const notifId = `notif_${Date.now()}`;
  await upsertNotification(userId, notifId, {
    id: notifId, userId,
    type: "info",
    title: "Добро пожаловать в ПРОМО.МУЗЫКА!",
    message: "Ваш аккаунт создан. Загрузите свой первый трек и начните продвижение.",
    read: false,
    createdAt: new Date().toISOString(),
  });
  return profile;
}

// ──────────────────────────────────────────────────────────────────────
// POST /auth/signup  —  Email-регистрация
// ──────────────────────────────────────────────────────────────────────
auth.post("/signup", async (c) => {
  try {
    const { email, password, name, role } = await c.req.json();
    if (!email || !password) {
      return c.json({ success: false, error: "Email и пароль обязательны" }, 400);
    }
    if (password.length < 6) {
      return c.json({ success: false, error: "Пароль минимум 6 символов" }, 400);
    }

    const userRole = role || "artist";
    const isPartner = PARTNER_ROLES.includes(userRole);
    const accountStatus = isPartner ? 'pending' : 'active';

    const supabase = getAdminClient();
    const { data, error } = await supabase.auth.admin.createUser({
      email, password,
      user_metadata: {
        name: name || email.split("@")[0],
        role: userRole,
        created_via: "promo_music_signup",
        accountStatus,
      },
      email_confirm: false,
    });

    if (error) {
      console.error("Auth signup error:", error);
      if (error.message?.includes("already registered") || error.message?.includes("already exists")) {
        return c.json({ success: false, error: "Пользователь с таким email уже зарегистрирован" }, 409);
      }
      return c.json({ success: false, error: `Ошибка регистрации: ${error.message || error.msg || JSON.stringify(error)}` }, 400);
    }

    const userId = data.user.id;
    await createKVProfile(userId, email, name || email.split("@")[0], userRole);
    console.log(`User registered: ${email} (${userId}), role: ${userRole}, status: ${accountStatus}`);

    // Notify admin about new user
    notifyNewUser({ email, name: name || email.split("@")[0], role: userRole, via: "email", needsApproval: isPartner }).catch(() => {});

    // Send verification email via Resend
    const verificationToken = crypto.randomUUID();
    await vpsStoreToken(userId, verificationToken, "email_verify", 24);
    sendVerificationEmail(email, name || email.split("@")[0], verificationToken).catch((e) => {
      console.warn("Verification email send failed:", e);
    });

    return c.json({
      success: true,
      emailVerificationRequired: true,
      accountStatus: isPartner ? 'pending' : 'active',
      message: isPartner ? 'Заявка отправлена на модерацию. Мы уведомим вас после рассмотрения.' : undefined,
      data: { user: { id: userId, email, name: name || email.split("@")[0], role: userRole } },
    }, 201);
  } catch (error) {
    console.error("Signup route error:", error);
    return c.json({ success: false, error: `Ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/signin  —  Вход через email/пароль
// ──────────────────────────────────────────────────────────────────────
auth.post("/signin", async (c) => {
  try {
    const { email, password } = await c.req.json();
    if (!email || !password) {
      return c.json({ success: false, error: "Email и пароль обязательны" }, 400);
    }

    const supabase = createAnonDbClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.code === "invalid_credentials" || error.message?.includes("Invalid login")) {
        console.warn(`Auth signin: invalid credentials for ${email}`);
      } else {
        console.error("Auth signin error:", error.message, error.code);
      }
      return c.json({ success: false, error: `Ошибка входа: ${error.message}` }, 401);
    }

    const userId = data.user.id;
    const accessToken = data.session.access_token;

    let profile = await vpsGetProfile(userId);
    if (!profile) {
      profile = {
        userId, email,
        name: data.user.user_metadata?.name || email.split("@")[0],
        role: data.user.user_metadata?.role || "artist",
        avatar: null,
        subscribers: 0, totalPlays: 0, totalTracks: 0,
        isEmailVerified: false,
        createdAt: new Date().toISOString(),
      };
      await vpsSaveProfile(userId, profile);
    }
    // Check account status for partner roles (stored in Supabase user_metadata)
    const accountStatus = data.user.user_metadata?.accountStatus || 'active';
    if (accountStatus === 'pending') {
      return c.json({ success: false, error: 'Ваш аккаунт на модерации. Мы уведомим вас после рассмотрения.', accountStatus: 'pending' }, 403);
    }
    if (accountStatus === 'rejected') {
      return c.json({ success: false, error: 'Ваша заявка отклонена. Свяжитесь с поддержкой.', accountStatus: 'rejected' }, 403);
    }

    profile.lastLoginAt = new Date().toISOString();
    await vpsSaveProfile(userId, profile);

    console.log(`User signed in: ${email} (${userId})`);
    return c.json({
      success: true,
      data: {
        user: { id: userId, email, name: profile.name, role: profile.role, isEmailVerified: profile.isEmailVerified || false, accountStatus },
        accessToken, expiresAt: data.session.expires_at,
      },
    });
  } catch (error) {
    console.error("Signin route error:", error);
    return c.json({ success: false, error: `Ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/vk-callback  —  VK ID OAuth: обмен code на сессию
// ──────────────────────────────────────────────────────────────────────
auth.post("/vk-callback", async (c) => {
  try {
    const { code, redirect_uri, code_verifier, device_id, role: vkRequestedRole } = await c.req.json();
    if (!code) {
      return c.json({ success: false, error: "VK authorization code required" }, 400);
    }

    const VK_CLIENT_ID = process.env.VK_CLIENT_ID || "";
    const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET || "";

    if (!VK_CLIENT_ID || !VK_CLIENT_SECRET) {
      console.error("VK_CLIENT_ID or VK_CLIENT_SECRET not set");
      return c.json({ success: false, error: "VK OAuth не настроен на сервере" }, 500);
    }

    // 1. Exchange code for access_token via VK ID
    const tokenBody: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      code,
      redirect_uri: redirect_uri || "https://promo-music.ru/login",
    };
    // device_id is REQUIRED for VK ID SDK flow
    if (device_id) tokenBody.device_id = device_id;
    if (code_verifier) tokenBody.code_verifier = code_verifier;

    const tokenParams = new URLSearchParams(tokenBody);

    console.log(`VK token exchange: client_id=${VK_CLIENT_ID}, redirect_uri=${tokenBody.redirect_uri}, device_id=${device_id || 'none'}`);

    const tokenResp = await fetch("https://id.vk.com/oauth2/auth", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });
    const tokenText = await tokenResp.text();
    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch (parseErr) {
      console.error("VK token response not JSON:", tokenResp.status, tokenText.substring(0, 300));
      return c.json({ success: false, error: "VK OAuth: неожиданный ответ от VK (" + tokenResp.status + ")" }, 502);
    }

    if (tokenData.error || !tokenData.access_token) {
      console.error("VK token exchange error:", JSON.stringify(tokenData));
      return c.json({ success: false, error: `VK OAuth ошибка: ${tokenData.error_description || tokenData.error || "unknown"}` }, 400);
    }

    const vkAccessToken = tokenData.access_token;
    const vkUserId = tokenData.user_id;
    const vkEmail = tokenData.email || null;

    // 2. Get VK user profile
    const profileParams = new URLSearchParams({
      access_token: vkAccessToken,
      client_id: VK_CLIENT_ID,
    });
    const profileResp = await fetch("https://id.vk.com/oauth2/user_info", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: profileParams.toString(),
    });
    const vkProfile: any = await profileResp.json();

    const vkName = [vkProfile.user?.first_name, vkProfile.user?.last_name].filter(Boolean).join(" ") || `VK User ${vkUserId}`;
    const vkAvatar = vkProfile.user?.avatar || null;
    const email = vkEmail || vkProfile.user?.email || null;

    console.log(`VK OAuth: user ${vkUserId}, name: ${vkName}, email: ${email}`);

    // 3. Find or create Supabase user
    const supabase = getAdminClient();

    // Search by VK ID in user_metadata
    const { data: existingUsers } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const existingUser = existingUsers?.users?.find(
      (u: any) => u.user_metadata?.vk_id === String(vkUserId)
    );

    if (existingUser) {
      // Existing user — generate session
      let profile = await vpsGetProfile(existingUser.id);
      const role = profile?.role || existingUser.user_metadata?.role || "artist";

      // Update avatar from VK if changed
      if (profile && vkAvatar && profile.avatar !== vkAvatar) {
        profile.avatar = vkAvatar;
        profile.updatedAt = new Date().toISOString();
      }

      // Update last login
      if (profile) {
        profile.lastLoginAt = new Date().toISOString();
        await vpsSaveProfile(existingUser.id, profile);
      }

      // Generate JWT
      const jwt = await import('jsonwebtoken');
      const jwtLib = (jwt as any).default || jwt;
      const accessToken = jwtLib.sign(
        { sub: existingUser.id, email: existingUser.email, role },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      );

      return c.json({
        success: true,
        newUser: false,
        data: {
          user: { id: existingUser.id, email: existingUser.email, name: profile?.name || vkName, role },
          accessToken,
        },
      });
    }

    // 4. New user — create account
    const userEmail = email || `vk${vkUserId}@promo-music.ru`;
    const randomPassword = crypto.randomUUID() + crypto.randomUUID();

    const { data: newUserData, error: createErr } = await supabase.auth.admin.createUser({
      email: userEmail,
      password: randomPassword,
      user_metadata: {
        name: vkName,
        vk_id: String(vkUserId),
        avatar: vkAvatar,
        role: vkRequestedRole || "artist",
        created_via: "vk_oauth",
      },
      email_confirm: true,
    });

    if (createErr) {
      console.error("VK user creation error:", createErr);
      if (createErr.message?.includes("already") || createErr.message?.includes("exists")) {
        // Try to link VK to existing account
        const existingByEmail = existingUsers?.users?.find((u: any) => u.email === userEmail);
        if (existingByEmail) {
          // Link VK ID to existing user
          await supabase.auth.admin.updateUserById(existingByEmail.id, {
            user_metadata: { ...existingByEmail.user_metadata, vk_id: String(vkUserId), avatar: vkAvatar },
          });
          const { data: magicData3 } = await supabase.auth.admin.generateLink({
            type: "magiclink",
            email: userEmail,
          });
          const profile = await vpsGetProfile(existingByEmail.id);
          return c.json({
            success: true,
            newUser: false,
            data: {
              user: { id: existingByEmail.id, email: userEmail, name: profile?.name || vkName, role: profile?.role || "artist" },
              token_hash: magicData3?.properties?.hashed_token,
              email: userEmail,
            },
          });
        }
        return c.json({ success: false, error: "Пользователь с таким email уже зарегистрирован. Войдите через email." }, 409);
      }
      return c.json({ success: false, error: `Ошибка создания аккаунта: ${createErr.message}` }, 400);
    }

    const userId = newUserData.user.id;

    // Create KV profile for new VK user
    const vkRole = vkRequestedRole || "artist";
    await createKVProfile(userId, userEmail, vkName, vkRole, vkAvatar);

    console.log(`VK new user created: ${userEmail} (${userId})`);

    // Notify admin
    notifyNewUser({ email: userEmail, name: vkName, role: vkRole, via: "vk_oauth" }).catch(() => {});

    // Generate JWT for new user
    const jwt2 = await import('jsonwebtoken');
    const jwtLib2 = (jwt2 as any).default || jwt2;
    const finalRole = vkRole;
    const newAccessToken = jwtLib2.sign(
      { sub: userId, email: userEmail, role: finalRole },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    return c.json({
      success: true,
      newUser: true,
      data: {
        user: { id: userId, email: userEmail, name: vkName, avatar: vkAvatar, role: finalRole },
        accessToken: newAccessToken,
        vkProfile: { vkId: vkUserId, name: vkName, avatar: vkAvatar },
      },
    });
  } catch (error) {
    console.error("VK callback error:", error);
    return c.json({ success: false, error: `VK OAuth ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/set-role  —  Установить роль пользователя (после VK OAuth)
// ──────────────────────────────────────────────────────────────────────
auth.post("/set-role", async (c) => {
  try {
    const { userId, role } = await c.req.json();
    if (!userId || !role) {
      return c.json({ success: false, error: "userId and role are required" }, 400);
    }

    const validRoles = ["artist", "dj", "radio_station", "venue", "producer"];
    if (!validRoles.includes(role)) {
      return c.json({ success: false, error: `Недопустимая роль: ${role}` }, 400);
    }

    const supabase = getAdminClient();

    // Check if role already set — cannot change after first assignment
    let existingProfile = await vpsGetProfile(userId);
    if (existingProfile && existingProfile.role && existingProfile.role !== 'artist') {
      // Role already set to non-default — reject change
      return c.json({ success: false, error: "Роль уже установлена и не может быть изменена", currentRole: existingProfile.role }, 403);
    }

    // Update user_metadata
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { role },
    });

    if (updateErr) {
      console.error("Set role error:", updateErr);
      return c.json({ success: false, error: `Ошибка установки роли: ${updateErr.message}` }, 400);
    }

    // Update KV profile
    let profile = await vpsGetProfile(userId);
    if (profile) {
      profile.role = role;
      profile.updatedAt = new Date().toISOString();
      await vpsSaveProfile(userId, profile);
    } else {
      // Create profile if missing
      const { data: { user } } = await supabase.auth.admin.getUserById(userId);
      if (user) {
        await createKVProfile(userId, user.email || "", user.user_metadata?.name || "", role, user.user_metadata?.avatar);
      }
    }

    console.log(`Role set for ${userId}: ${role}`);
    return c.json({ success: true, role });
  } catch (error) {
    console.error("Set role error:", error);
    return c.json({ success: false, error: `Ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /auth/me
// ──────────────────────────────────────────────────────────────────────
auth.get("/me", async (c) => {
  try {
    const accessToken = c.req.header("Authorization")?.split(" ")[1];
    if (!accessToken) {
      return c.json({ success: false, error: "Authorization header required" }, 401);
    }

    const supabase = getAdminClient();
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    if (error || !user) {
      return c.json({ success: false, error: "Invalid or expired token" }, 401);
    }

    let profile = await vpsGetProfile(user.id);

    return c.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: profile?.name || user.user_metadata?.name || "User",
        role: profile?.role || user.user_metadata?.role || "artist",
        avatar: profile?.avatar || user.user_metadata?.avatar || null,
        isVerified: profile?.isVerified || false,
        isEmailVerified: profile?.isEmailVerified || false,
      },
    });
  } catch (error) {
    console.error("Auth me error:", error);
    return c.json({ success: false, error: `Error fetching user: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/signout
// ──────────────────────────────────────────────────────────────────────
auth.post("/signout", async (c) => {
  try {
    const accessToken = c.req.header("Authorization")?.split(" ")[1];
    if (accessToken) {
      const supabase = getAdminClient();
      const { data: { user } } = await supabase.auth.getUser(accessToken);
      if (user) {
        console.log(`User signed out: ${user.email} (${user.id})`);
      }
    }
    return c.json({ success: true, message: "Signed out successfully" });
  } catch (error) {
    console.error("Signout error:", error);
    return c.json({ success: true, message: "Signed out (with warnings)" });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/request-reset  —  Запрос сброса пароля (отправка email)
// ──────────────────────────────────────────────────────────────────────
auth.post("/request-reset", async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) {
      return c.json({ success: false, error: "Email обязателен" }, 400);
    }

    const supabase = getAdminClient();

    // Check if user exists
    const { data: existingUsers } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const user = existingUsers?.users?.find((u: any) => u.email === email);

    if (!user) {
      // Don't reveal that user doesn't exist (security)
      console.log(`Password reset requested for non-existent email: ${email}`);
      return c.json({ success: true, message: "Если аккаунт с таким email существует, мы отправили письмо для сброса пароля." });
    }

    // Generate reset token
    const resetToken = crypto.randomUUID();
    await vpsStoreToken(user.id, resetToken, "password_reset", 1);

    // Send reset email
    const profile = await vpsGetProfile(user.id);
    const userName = profile?.name || user.user_metadata?.name || email.split("@")[0];
    await sendPasswordResetEmail(email, userName, resetToken);

    console.log(`Password reset email sent to: ${email}`);
    return c.json({ success: true, message: "Если аккаунт с таким email существует, мы отправили письмо ��ля сброса пароля." });
  } catch (error) {
    console.error("Request reset error:", error);
    return c.json({ success: false, error: `Ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/reset-password  —  Сброс пароля по токену
// ──────────────────────────────────────────────────────────────────────
auth.post("/reset-password", async (c) => {
  try {
    const { token, newPassword } = await c.req.json();
    if (!token || !newPassword) {
      return c.json({ success: false, error: "Токен и новый пароль обязательны" }, 400);
    }
    if (newPassword.length < 6) {
      return c.json({ success: false, error: "Пароль минимум 6 символов" }, 400);
    }

    // Verify token
    const resetData = await vpsGetToken(token);
    if (!resetData) {
      return c.json({ success: false, error: "Недействительная или истёкшая ссылка сброса пароля" }, 400);
    }

    // Check expiry
    if (new Date() > new Date(resetData.expiresAt)) {
      await vpsUseToken(token);
      return c.json({ success: false, error: "Ссылка для сброса пароля истекла. Запросите новую." }, 400);
    }

    // Check if already used (usedAt is set by vpsUseToken)
    if (resetData.usedAt) {
      return c.json({ success: false, error: "Эта ссылка уже была использована." }, 400);
    }

    // Update password via Supabase Admin API
    const supabase = getAdminClient();
    const { error: updateErr } = await supabase.auth.admin.updateUserById(resetData.userId, {
      password: newPassword,
    });

    if (updateErr) {
      console.error("Password update error:", updateErr);
      return c.json({ success: false, error: `Ошибка обновления пароля: ${updateErr.message}` }, 400);
    }

    // Mark token as used on VPS
    await vpsUseToken(token);

    console.log(`Password reset completed for user: ${resetData.userId}`);
    return c.json({ success: true, message: "Пароль успешно обновлён. Теперь вы можете войти с новым паролем." });
  } catch (error) {
    console.error("Reset password error:", error);
    return c.json({ success: false, error: `Ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/verify-email  —  Подтверждение email по токену
// ──────────────────────────────────────────────────────────────────────
auth.post("/verify-email", async (c) => {
  try {
    const { token } = await c.req.json();
    if (!token) {
      return c.json({ success: false, error: "Токен верификации обязателен" }, 400);
    }

    // Verify token
    const verifyData = await vpsGetToken(token);
    if (!verifyData) {
      return c.json({ success: false, error: "Недействительная или истёкшая ссылка подтверждения" }, 400);
    }

    // Check expiry
    if (new Date() > new Date(verifyData.expiresAt)) {
      await vpsUseToken(token);
      return c.json({ success: false, error: "Ссылка для подтверждения истекла. Запросите новую." }, 400);
    }

    // Update profile
    const profile = await vpsGetProfile(verifyData.userId);
    if (profile) {
      profile.isEmailVerified = true;
      profile.emailVerifiedAt = new Date().toISOString();
      profile.updatedAt = new Date().toISOString();
      await vpsSaveProfile(verifyData.userId, profile);
    }

    // Clean up token
    await vpsUseToken(token);

    console.log(`Email verified for user: ${verifyData.userId}`);
    return c.json({ success: true, message: "Email успешно подтверждён!" });
  } catch (error) {
    console.error("Verify email error:", error);
    return c.json({ success: false, error: `Ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/resend-verification  —  Повторная отправка email верификации
// ──────────────────────────────────────────────────────────────────────
auth.post("/resend-verification", async (c) => {
  try {
    const accessToken = c.req.header("Authorization")?.split(" ")[1];
    if (!accessToken) {
      return c.json({ success: false, error: "Authorization header required" }, 401);
    }

    const supabase = getAdminClient();
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    if (error || !user) {
      return c.json({ success: false, error: "Invalid or expired token" }, 401);
    }

    // Check if already verified
    const profile = await vpsGetProfile(user.id);
    if (profile?.isEmailVerified) {
      return c.json({ success: true, message: "Email уже подтверждён" });
    }

    // Generate new verification token
    const verificationToken = crypto.randomUUID();
    await vpsStoreToken(user.id, verificationToken, "email_verify", 24);

    const userName = profile?.name || user.user_metadata?.name || user.email?.split("@")[0] || "User";
    await sendVerificationEmail(user.email!, userName, verificationToken);

    console.log(`Verification email resent to: ${user.email}`);
    return c.json({ success: true, message: "Письмо с подтверждением отправлено повторно" });
  } catch (error) {
    console.error("Resend verification error:", error);
    return c.json({ success: false, error: `Ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /auth/verify-email-page?token=...  —  Страница подтверждения (redirect)
// ──────────────────────────────────────────────────────────────────────
auth.get("/verify-email-page", async (c) => {
  const token = c.req.query("token");
  if (!token) {
    return c.redirect("https://promo-music.ru/login?error=missing_token");
  }

  // Verify token
  const verifyData = await vpsGetToken(token);
  if (!verifyData || new Date() > new Date(verifyData.expiresAt)) {
    return c.redirect("https://promo-music.ru/login?error=invalid_token");
  }

  // Confirm email in Supabase Auth so user can sign in
  const supabase = getAdminClient();
  await supabase.auth.admin.updateUserById(verifyData.userId, {
    email_confirm: true,
  });

  // Update profile
  const profile = await vpsGetProfile(verifyData.userId);
  if (profile) {
    profile.isEmailVerified = true;
    profile.emailVerifiedAt = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();
    await vpsSaveProfile(verifyData.userId, profile);
  }

  await vpsUseToken(token);
  console.log(`Email verified via page for user: ${verifyData.userId}`);

  return c.redirect("https://promo-music.ru/login?verified=true");
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/resend-verification-by-email  —  Повторная отправка по email (без токена)
// ──────────────────────────────────────────────────────────────────────
auth.post("/resend-verification-by-email", async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email) {
      return c.json({ success: false, error: "Email обязателен" }, 400);
    }

    const supabase = getAdminClient();
    const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const user = users?.find((u: any) => u.email === email);

    if (!user) {
      // Don't reveal existence
      return c.json({ success: true, message: "Если аккаунт существует, письмо отправлено" });
    }

    if ((user as any).is_email_verified) {
      return c.json({ success: false, error: "Email уже подтверждён. Попробуйте войти." }, 400);
    }

    const verificationToken = crypto.randomUUID();
    await vpsStoreToken(user.id, verificationToken, "email_verify", 24);

    const profile = await vpsGetProfile(user.id);
    const userName = profile?.name || user.user_metadata?.name || email.split("@")[0];
    await sendVerificationEmail(email, userName, verificationToken);

    console.log(`Verification email resent (by email) to: ${email}`);
    return c.json({ success: true, message: "Письмо отправлено" });
  } catch (error) {
    console.error("Resend verification by email error:", error);
    return c.json({ success: false, error: `Ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/change-password  —  Смена пароля (для авторизованных пользователей)
// ──────────────────────────────────────────────────────────────────────
auth.post("/change-password", async (c) => {
  try {
    const accessToken = c.req.header("Authorization")?.split(" ")[1];
    if (!accessToken) {
      return c.json({ success: false, error: "Authorization required" }, 401);
    }

    const supabase = getAdminClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) {
      return c.json({ success: false, error: "Недействительная сессия. Войдите снова." }, 401);
    }

    const { currentPassword, newPassword } = await c.req.json();
    if (!currentPassword || !newPassword) {
      return c.json({ success: false, error: "Текущий и новый пароль обязательны" }, 400);
    }
    if (newPassword.length < 6) {
      return c.json({ success: false, error: "Пароль минимум 6 символов" }, 400);
    }

    // Verify current password
    const anonClient = createAnonDbClient();
    const { error: signInError } = await anonClient.auth.signInWithPassword({
      email: user.email!,
      password: currentPassword,
    });
    if (signInError) {
      return c.json({ success: false, error: "Неверный текущий пароль" }, 400);
    }

    // Update password
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      password: newPassword,
    });
    if (updateError) {
      return c.json({ success: false, error: `Ошибка обновления пароля: ${updateError.message}` }, 400);
    }

    console.log(`Password changed for user: ${user.id}`);
    return c.json({ success: true, message: "Пароль успешно изменён" });
  } catch (error) {
    console.error("Change password error:", error);
    return c.json({ success: false, error: `Ошибка сервера: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /auth/admin/pending-users  —  Список заявок на модерацию
// ──────────────────────────────────────────────────────────────────────
auth.get("/admin/pending-users", requireAuth, requireAdmin, async (c) => {
  try {
    const supabase = getAdminClient();
    const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const pending = users
      .filter((u: any) => u.user_metadata?.accountStatus === 'pending')
      .map((u: any) => ({
        userId: u.id,
        email: u.email,
        name: u.user_metadata?.name,
        role: u.user_metadata?.role,
        createdAt: u.created_at,
      }));
    return c.json({ success: true, data: pending });
  } catch (error) {
    return c.json({ success: false, error: `Ошибка: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/admin/approve-user  —  Одобрить заявку
// ──────────────────────────────────────────────────────────────────────
auth.post("/admin/approve-user", requireAuth, requireAdmin, async (c) => {
  try {
    const { userId } = await c.req.json();
    if (!userId) return c.json({ success: false, error: "userId обязателен" }, 400);

    const supabase = getAdminClient();
    const { data: { user }, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !user) return c.json({ success: false, error: "Пользователь не найден" }, 404);

    // Update accountStatus in user_metadata
    await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { ...user.user_metadata, accountStatus: 'active' },
    });

    // Email notification
    sendAccountApprovedEmail(user.email || '', user.user_metadata?.name || '').catch(() => {});

    // In-app notification
    const notifId = `notif_approved_${Date.now()}`;
    await upsertNotification(userId, notifId, {
      id: notifId, userId,
      type: "info",
      title: "Аккаунт одобрен!",
      message: "Ваша заявка одобрена. Теперь вы можете войти и пользоваться всеми функциями.",
      read: false,
      createdAt: new Date().toISOString(),
    });

    console.log(`Admin approved user: ${userId} (${user.email})`);
    return c.json({ success: true, message: "Пользователь одобрен" });
  } catch (error) {
    return c.json({ success: false, error: `Ошибка: ${error}` }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /auth/admin/reject-user  —  Отклонить заявку
// ──────────────────────────────────────────────────────────────────────
auth.post("/admin/reject-user", requireAuth, requireAdmin, async (c) => {
  try {
    const { userId, reason } = await c.req.json();
    if (!userId) return c.json({ success: false, error: "userId обязателен" }, 400);

    const supabase = getAdminClient();
    const { data: { user }, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !user) return c.json({ success: false, error: "Пользователь не найден" }, 404);

    // Update accountStatus in user_metadata
    await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { ...user.user_metadata, accountStatus: 'rejected', rejectionReason: reason || '' },
    });

    // Email notification
    sendAccountRejectedEmail(user.email || '', user.user_metadata?.name || '', reason || '').catch(() => {});

    // In-app notification
    const notifId = `notif_rejected_${Date.now()}`;
    await upsertNotification(userId, notifId, {
      id: notifId, userId,
      type: "info",
      title: "Заявка отклонена",
      message: reason ? `Причина: ${reason}` : "Ваша заявка отклонена. Свяжитесь с поддержкой для уточнения.",
      read: false,
      createdAt: new Date().toISOString(),
    });

    console.log(`Admin rejected user: ${userId} (${user.email}), reason: ${reason}`);
    return c.json({ success: true, message: "Заявка отклонена" });
  } catch (error) {
    return c.json({ success: false, error: `Ошибка: ${error}` }, 500);
  }
});

export default auth;
