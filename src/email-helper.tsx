/**
 * EMAIL HELPER — Отправка email через SMTP (Reg.ru) с fallback на Resend HTTP API
 */
import nodemailer from 'nodemailer';
import crypto from 'crypto';

const ADMIN_EMAIL = 'info@promofm.ru';
const FROM_EMAIL = '"ПРОМО.МУЗЫКА" <noreply@promo-music.ru>';
const REPLY_TO = 'noreply@promo-music.ru';
const SITE_URL = 'https://promo-music.ru';

// ── Отписка от рассылок: HMAC-токен (без хранения), ссылка, проверка статуса ──
const UNSUB_KEY = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || 'promofm-unsub-key-v1';
export function unsubscribeToken(email: string): string {
  return crypto.createHmac('sha256', UNSUB_KEY).update(String(email).toLowerCase().trim()).digest('hex').slice(0, 32);
}
export function unsubscribeLink(email: string): string {
  return `${SITE_URL}/server/email/unsubscribe?e=${encodeURIComponent(String(email).toLowerCase().trim())}&t=${unsubscribeToken(email)}`;
}
export async function isUnsubscribed(email: string): Promise<boolean> {
  try {
    const { pool } = await import('./db-client.tsx');
    const r = await pool.query('SELECT 1 FROM email_unsubscribes WHERE email = $1', [String(email).toLowerCase().trim()]);
    return r.rows.length > 0;
  } catch { return false; }
}
const API_BASE = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/server` : 'https://promo-music.ru/server';

// ── Telegram notification ──
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_LEAD_CHAT_ID || '';

function stripHtml(s: string): string {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export async function notifyAdminTelegram(text: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn('[Telegram] non-OK:', resp.status, body.slice(0, 200));
    }
  } catch (err: any) {
    console.warn('[Telegram] send failed:', err?.message || err);
  }
}


// HTML entity escaping for safe email template interpolation
export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

// SMTP transport: localhost Postfix (no auth) or external relay (with auth)
const smtpConfig: any = {
  host: process.env.SMTP_HOST || '127.0.0.1',
  port: parseInt(process.env.SMTP_PORT || '25'),
  secure: false,
  tls: { rejectUnauthorized: false },
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
};
// Only add auth if SMTP_PASS is set (external relay like mail.hosting.reg.ru)
if (process.env.SMTP_PASS) {
  smtpConfig.auth = {
    user: process.env.SMTP_USER || 'noreply@promo-music.ru',
    pass: process.env.SMTP_PASS,
  };
}
const smtpTransport = nodemailer.createTransport(smtpConfig);

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

/**
 * Send email: SMTP first, then Resend HTTP API fallback
 */
export async function sendEmail(opts: EmailOptions): Promise<boolean> {
  // Try SMTP first (localhost Postfix works without auth)
  {
    try {
      const info = await smtpTransport.sendMail({
        from: opts.from || FROM_EMAIL,
        replyTo: REPLY_TO,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        headers: {
          'X-Mailer': 'PROMO.MUSIC Platform',
          // NOTE: 'Precedence: bulk' и 'List-Unsubscribe' убраны —
          // Yandex.Mail отправлял всё в папку «Рассылки», админ не видел уведомления.
          // Транзакционные письма (моderation/payment/seo) теперь идут в Inbox.
        },
      });
      console.log('[Email] Sent via SMTP:', info.messageId, 'to:', opts.to);
      return true;
    } catch (err: any) {
      console.error('[Email] SMTP failed:', err.message);
    }
  }

  // Fallback: Resend HTTP API (port 443)
  if (RESEND_API_KEY) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: opts.from || FROM_EMAIL,
          reply_to: REPLY_TO,
          to: [opts.to],
          subject: opts.subject,
          html: opts.html,
        }),
      });
      const result = await resp.json() as { id?: string };
      if (!resp.ok) {
        console.error('[Email] Resend API error:', resp.status, JSON.stringify(result));
        return false;
      }
      console.log('[Email] Sent via Resend:', result.id, 'to:', opts.to);
      return true;
    } catch (err: any) {
      console.error('[Email] Resend failed:', err.message);
    }
  }

  console.error('[Email] No working transport! Set SMTP_PASS or verify domain in Resend');
  return false;
}

// ── Email Templates ──

export const emailWrapper = (content: string) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background: #0a0a1a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: #0a0a1a; padding: 40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background: #1a1a2e; border-radius: 16px; overflow: hidden;">
        <tr><td style="padding: 32px 40px; background: linear-gradient(135deg, #FF577F 0%, #7C3AED 100%);">
          <h1 style="margin: 0; color: #fff; font-size: 24px; font-weight: 700;">ПРОМО.МУЗЫКА</h1>
        </td></tr>
        <tr><td style="padding: 32px 40px; color: #e0e0e0; font-size: 16px; line-height: 1.6;">
          ${content}
        </td></tr>
        <tr><td style="padding: 24px 40px 32px; color: #666; font-size: 12px; border-top: 1px solid #2a2a3e; text-align: center;">
          <img src="${SITE_URL}/logo.png" alt="ПРОМО.МУЗЫКА" style="height: 34px; margin-bottom: 10px;" />
          <p style="margin: 0 0 10px; color: #e0e0e0; font-size: 14px; font-weight: 600;">Команда ПРОМО.Музыка</p>
          <p style="margin: 0;">&copy; ${new Date().getFullYear()} ПРОМО.МУЗЫКА — платформа продвижения музыки</p>
          <p style="margin: 4px 0 0;"><a href="${SITE_URL}" style="color: #FF577F; text-decoration: none;">promo-music.ru</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const buttonStyle = 'display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #FF577F 0%, #7C3AED 100%); color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;';

export async function sendPasswordResetEmail(email: string, name: string, token: string): Promise<boolean> {
  const resetUrl = `${SITE_URL}/reset-password?token=${token}`;
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 20px;">Сброс пароля</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name)}</strong>!</p>
    <p>Вы запросили сброс пароля для вашего аккаунта на ПРОМО.МУЗЫКА.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${resetUrl}" style="${buttonStyle}">Сбросить пароль</a>
    </p>
    <p style="color: #999; font-size: 14px;">Ссылка действительна в течение 1 часа.</p>
    <p style="color: #666; font-size: 12px; margin-top: 24px; word-break: break-all;">Если кнопка не работает: ${resetUrl}</p>
  `);
  return sendEmail({ to: email, subject: 'Сброс пароля — ПРОМО.МУЗЫКА', html });
}

export async function sendActivationEmail(email: string, name: string, token: string): Promise<boolean> {
  const resetUrl = `${SITE_URL}/reset-password?token=${token}`;
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 20px;">Ваш кабинет на ПРОМО.МУЗЫКА готов</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name)}</strong>!</p>
    <p>Мы перенесли вашу страницу артиста со старой платформы <strong>promo.fm</strong> на новый сервис <strong>promo-music.ru</strong>.</p>
    <p>Чтобы получить доступ — придумайте пароль по ссылке ниже. Email уже привязан, никакая дополнительная верификация не нужна:</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${resetUrl}" style="${buttonStyle}">Активировать кабинет</a>
    </p>
    <p style="color: #999; font-size: 14px;">Ссылка действительна в течение 7 дней. Если не активируете — кабинет останется, можно зайти позже через «Забыли пароль?».</p>
    <p style="color: #999; font-size: 14px; margin-top: 16px;">В кабинете: загрузка треков, публикация на радио ПРОМО.ФМ, статистика, заказы продвижения, продажа концертов и многое другое.</p>
    <p style="color: #666; font-size: 12px; margin-top: 24px; word-break: break-all;">Если кнопка не работает: ${resetUrl}</p>
  `);
  return sendEmail({ to: email, subject: 'Ваш кабинет на ПРОМО.МУЗЫКА — активируйте', html });
}

export async function sendVerificationEmail(email: string, name: string, token: string): Promise<boolean> {
  const verifyUrl = `${API_BASE}/auth/verify-email-page?token=${token}`;
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 20px;">Подтвердите ваш email</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name)}</strong>!</p>
    <p>Спасибо за регистрацию на ПРОМО.МУЗЫКА! Подтвердите ваш email-адрес.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${verifyUrl}" style="${buttonStyle}">Подтвердить email</a>
    </p>
    <p style="color: #999; font-size: 14px;">Ссылка действительна в течение 24 часов.</p>
    <p style="color: #666; font-size: 12px; margin-top: 24px; word-break: break-all;">Если кнопка не работает: ${verifyUrl}</p>
  `);
  return sendEmail({ to: email, subject: 'Подтвердите email — ПРОМО.МУЗЫКА', html });
}

export async function sendLabelInvitationEmail(
  toEmail: string,
  labelName: string,
  message: string | null,
  acceptUrl: string,
): Promise<boolean> {
  const safeName = escapeHtml(labelName);
  const safeMsg = message ? escapeHtml(message) : '';
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 20px;">Приглашение от лейбла</h2>
    <p>Лейбл <strong>${safeName}</strong> приглашает вас в свой ростер на ПРОМО.МУЗЫКА.</p>
    ${safeMsg ? `<blockquote style="border-left: 3px solid #FF577F; margin: 18px 0; padding: 4px 14px; color: #ccc; font-style: italic;">${safeMsg}</blockquote>` : ''}
    <p>После принятия лейбл сможет выпускать ваши релизы через единую модерацию платформы. Вы сможете в любой момент выйти из лейбла в своём кабинете.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${acceptUrl}" style="${buttonStyle}">Открыть приглашение</a>
    </p>
    <p style="color: #999; font-size: 14px;">Если вы не ожидаете это приглашение — просто проигнорируйте письмо.</p>
    <p style="color: #666; font-size: 12px; margin-top: 24px; word-break: break-all;">Прямая ссылка: ${acceptUrl}</p>
  `);
  return sendEmail({ to: toEmail, subject: `Приглашение от лейбла «${safeName}» — ПРОМО.МУЗЫКА`, html });
}

export async function notifyArtistRequest(data: { artistName: string; trackTitle: string; genre?: string; stationName?: string; stationId: string; }) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: #FF577F;">Новая заявка артиста на радио</h2><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 8px; font-weight: bold;">Артист:</td><td>${escapeHtml(data.artistName)}</td></tr><tr><td style="padding: 8px; font-weight: bold;">Трек:</td><td>${escapeHtml(data.trackTitle)}</td></tr>${data.genre ? `<tr><td style="padding: 8px; font-weight: bold;">Жанр:</td><td>${escapeHtml(data.genre)}</td></tr>` : ''}<tr><td style="padding: 8px; font-weight: bold;">Радиостанция:</td><td>${escapeHtml(data.stationName || data.stationId)}</td></tr></table></div>`;
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Заявка: ${escapeHtml(data.artistName)} — ${escapeHtml(data.trackTitle)}`, html });
}

export async function notifyVenueRequest(data: { venueName: string; venueCity?: string; packageType?: string; totalPrice?: number; stationName?: string; stationId: string; }) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: #7C3AED;">Заявка заведения</h2><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 8px;">Заведение:</td><td>${escapeHtml(data.venueName)}</td></tr>${data.venueCity ? `<tr><td style="padding: 8px;">Город:</td><td>${escapeHtml(data.venueCity)}</td></tr>` : ''}${data.totalPrice ? `<tr><td style="padding: 8px;">Сумма:</td><td>${escapeHtml(String(data.totalPrice))}</td></tr>` : ''}<tr><td style="padding: 8px;">Станция:</td><td>${escapeHtml(data.stationName || data.stationId)}</td></tr></table></div>`;
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Заведение: ${escapeHtml(data.venueName)}`, html });
}

export async function notifyBookingRequest(data: { venueName: string; performerName?: string; eventTitle: string; eventDate: string; offeredPrice?: number; }) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: #10B981;">Новое бронирование</h2><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 8px;">Заведение:</td><td>${escapeHtml(data.venueName)}</td></tr>${data.performerName ? `<tr><td style="padding: 8px;">Артист:</td><td>${escapeHtml(data.performerName || "")}</td></tr>` : ''}<tr><td style="padding: 8px;">Событие:</td><td>${escapeHtml(data.eventTitle)}</td></tr><tr><td style="padding: 8px;">Дата:</td><td>${escapeHtml(data.eventDate)}</td></tr></table></div>`;
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Бронирование: ${escapeHtml(data.eventTitle)} — ${escapeHtml(data.eventDate)}`, html });
}

export async function notifyNewUser(data: { email: string; name: string; role: string; via?: string; needsApproval?: boolean; application?: any }) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: ${data.needsApproval ? '#F59E0B' : '#3B82F6'};">${data.needsApproval ? 'Заявка — требует одобрения' : 'Новый пользователь'}</h2><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 8px;">Имя:</td><td>${escapeHtml(data.name)}</td></tr><tr><td style="padding: 8px;">Email:</td><td>${escapeHtml(data.email)}</td></tr><tr><td style="padding: 8px;">Роль:</td><td>${escapeHtml(data.role)}</td></tr>${data.via ? `<tr><td style="padding: 8px;">Через:</td><td>${escapeHtml(data.via)}</td></tr>` : ''}${data.application ? `<tr><td style="padding: 8px;">Заявка:</td><td>${escapeHtml(JSON.stringify(data.application))}</td></tr>` : ''}</table></div>`;
  await sendEmail({ to: ADMIN_EMAIL, subject: data.needsApproval ? `[ПРОМО] ЗАЯВКА: ${escapeHtml(data.role)} ${escapeHtml(data.name)}` : `[ПРОМО] Новый ${escapeHtml(data.role)}: ${escapeHtml(data.name)}`, html });
}

export async function sendAccountApprovedEmail(email: string, name: string): Promise<boolean> {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #10B981;">Аккаунт одобрен!</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name)}</strong>!</p>
    <p>Ваша заявка одобрена. Войдите и пользуйтесь всеми функциями платформы.</p>
    <p style="text-align: center; margin: 28px 0;"><a href="${SITE_URL}/login" style="${buttonStyle}">Войти</a></p>
  `);
  return sendEmail({ to: email, subject: 'Аккаунт одобрен — ПРОМО.МУЗЫКА', html });
}

export async function sendAccountRejectedEmail(email: string, name: string, reason: string): Promise<boolean> {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #EF4444;">Заявка отклонена</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name)}</strong>!</p>
    <p>К сожалению, ваша заявка была отклонена.</p>
    ${reason ? `<p style="padding: 12px; background: #1a1a2e; border-left: 3px solid #EF4444; border-radius: 4px;"><strong>Причина:</strong> ${escapeHtml(reason)}</p>` : ''}
    <p>Свяжитесь с нами: <a href="mailto:info@promofm.ru" style="color: #FF577F;">info@promofm.ru</a></p>
  `);
  return sendEmail({ to: email, subject: 'Заявка отклонена — ПРОМО.МУЗЫКА', html });
}

// ── Profile verification (migration 058 artist + 062 cross-role) ──
//
// Sent by POST /auth/admin/verify-profile when admin approves or
// rejects a user's verification request. Distinct from
// sendAccount{Approved,Rejected}Email above — those fire on USER
// approval (users.status='active'); these fire on PROFILE
// verification (is_verified flag on the role-specific profile row,
// independent of account status).

const PROFILE_ROLE_LABELS: Record<string, string> = {
  artist: 'артиста',
  venue: 'заведения',
  radio_station: 'радиостанции',
  producer: 'продюсера',
};

function profileRoleLabel(role: string): string {
  return PROFILE_ROLE_LABELS[role] || 'профиля';
}

export async function sendProfileVerifiedEmail(
  email: string,
  name: string,
  role: string,
): Promise<boolean> {
  const roleLabel = profileRoleLabel(role);
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #10B981;">Профиль верифицирован!</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name)}</strong>!</p>
    <p>Ваш профиль ${escapeHtml(roleLabel)} прошёл проверку администратором. Значок верификации теперь виден всем пользователям платформы.</p>
    <p style="text-align: center; margin: 28px 0;"><a href="${SITE_URL}/cabinet" style="${buttonStyle}">Открыть кабинет</a></p>
  `);
  return sendEmail({
    to: email,
    subject: 'Профиль верифицирован — ПРОМО.МУЗЫКА',
    html,
  });
}

export async function sendProfileVerificationRejectedEmail(
  email: string,
  name: string,
  role: string,
  reason: string,
): Promise<boolean> {
  const roleLabel = profileRoleLabel(role);
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #EF4444;">Заявка на верификацию отклонена</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name)}</strong>!</p>
    <p>К сожалению, ваша заявка на верификацию профиля ${escapeHtml(roleLabel)} была отклонена.</p>
    ${reason ? `<p style="padding: 12px; background: #1a1a2e; border-left: 3px solid #EF4444; border-radius: 4px;"><strong>Причина:</strong> ${escapeHtml(reason)}</p>` : ''}
    <p>Вы можете подать новую заявку из кабинета после устранения причин.</p>
    <p style="text-align: center; margin: 28px 0;"><a href="${SITE_URL}/cabinet" style="${buttonStyle}">Открыть кабинет</a></p>
  `);
  return sendEmail({
    to: email,
    subject: 'Заявка на верификацию отклонена — ПРОМО.МУЗЫКА',
    html,
  });
}


// ── Admin Notifications: uploads & payments ──

export async function notifyTrackUpload(data: { title: string; artist: string; genre?: string; email?: string; userId?: string; }) {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #3B82F6;">Новый трек на модерации</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      <tr><td style="padding: 8px; color: #999;">Трек:</td><td style="padding: 8px;">${escapeHtml(data.title)}</td></tr>
      <tr><td style="padding: 8px; color: #999;">Артист:</td><td style="padding: 8px;">${escapeHtml(data.artist)}</td></tr>
      ${data.genre ? `<tr><td style="padding: 8px; color: #999;">Жанр:</td><td style="padding: 8px;">${escapeHtml(data.genre)}</td></tr>` : ''}
      ${data.email ? `<tr><td style="padding: 8px; color: #999;">Email:</td><td style="padding: 8px;">${escapeHtml(data.email)}</td></tr>` : ''}
    </table>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${SITE_URL}/admin/moderation" style="${buttonStyle}">Модерация</a>
    </p>
  `);
  notifyAdminTelegram(`🎵 <b>Новый трек на модерации</b>\n\nАртист: <b>${stripHtml(data.artist)}</b>\nТрек: <b>${stripHtml(data.title)}</b>${data.genre ? `\nЖанр: ${stripHtml(data.genre)}` : ''}${data.email ? `\nEmail: ${stripHtml(data.email)}` : ''}\n\n→ <a href="https://promo-music.ru/ctrl-pm7k2f">Модерация</a>`).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Трек: ${escapeHtml(data.artist)} — ${escapeHtml(data.title)}`, html });
}

export async function notifyVideoUpload(data: { title: string; artist: string; category?: string; videoUrl?: string; email?: string; userId?: string; }) {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #EC4899;">Новое видео на модерации</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      <tr><td style="padding: 8px; color: #999;">Видео:</td><td style="padding: 8px;">${escapeHtml(data.title)}</td></tr>
      <tr><td style="padding: 8px; color: #999;">Автор:</td><td style="padding: 8px;">${escapeHtml(data.artist)}</td></tr>
      ${data.category ? `<tr><td style="padding: 8px; color: #999;">Категория:</td><td style="padding: 8px;">${escapeHtml(data.category)}</td></tr>` : ''}
      ${data.email ? `<tr><td style="padding: 8px; color: #999;">Email:</td><td style="padding: 8px;">${escapeHtml(data.email)}</td></tr>` : ''}
      ${data.videoUrl ? `<tr><td style="padding: 8px; color: #999;">Ссылка:</td><td style="padding: 8px; word-break: break-all;"><a href="${escapeHtml(data.videoUrl)}" style="color: #60A5FA;">${escapeHtml(data.videoUrl)}</a></td></tr>` : ''}
    </table>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${SITE_URL}/ctrl-pm7k2f" style="${buttonStyle}">Модерация</a>
    </p>
  `);
  notifyAdminTelegram(`🎬 <b>Новое видео на модерации</b>\n\nАвтор: <b>${stripHtml(data.artist)}</b>\nВидео: <b>${stripHtml(data.title)}</b>${data.category ? `\nКатегория: ${stripHtml(data.category)}` : ''}${data.email ? `\nEmail: ${stripHtml(data.email)}` : ''}${data.videoUrl ? `\nСсылка: ${stripHtml(data.videoUrl)}` : ''}\n\n→ <a href="https://promo-music.ru/ctrl-pm7k2f">Модерация</a>`).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Видео: ${escapeHtml(data.artist)} — ${escapeHtml(data.title)}`, html });
}

export async function notifyConcertCreated(data: { title: string; artist?: string; city?: string; date?: string; venue?: string; }) {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #10B981;">Новый концерт</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      <tr><td style="padding: 8px; color: #999;">Название:</td><td style="padding: 8px;">${escapeHtml(data.title)}</td></tr>
      ${data.artist ? `<tr><td style="padding: 8px; color: #999;">Артист:</td><td style="padding: 8px;">${escapeHtml(data.artist)}</td></tr>` : ''}
      ${data.city ? `<tr><td style="padding: 8px; color: #999;">Город:</td><td style="padding: 8px;">${escapeHtml(data.city)}</td></tr>` : ''}
      ${data.venue ? `<tr><td style="padding: 8px; color: #999;">Площадка:</td><td style="padding: 8px;">${escapeHtml(data.venue)}</td></tr>` : ''}
      ${data.date ? `<tr><td style="padding: 8px; color: #999;">Дата:</td><td style="padding: 8px;">${escapeHtml(data.date)}</td></tr>` : ''}
    </table>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${SITE_URL}/admin/moderation" style="${buttonStyle}">Модерация</a>
    </p>
  `);
  notifyAdminTelegram(`🎤 <b>Новый концерт</b>\n\nНазвание: <b>${stripHtml(data.title)}</b>${data.artist ? `\nАртист: ${stripHtml(data.artist)}` : ''}${data.city ? `\nГород: ${stripHtml(data.city)}` : ''}${data.venue ? `\nПлощадка: ${stripHtml(data.venue)}` : ''}${data.date ? `\nДата: ${stripHtml(data.date)}` : ''}\n\n→ <a href="https://promo-music.ru/ctrl-pm7k2f">Модерация</a>`).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Концерт: ${escapeHtml(data.title)}`, html });
}

export async function notifyBannerCreated(data: { title?: string; userId?: string; position?: string; }) {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #F59E0B;">Новый баннер на модерации</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      ${data.title ? `<tr><td style="padding: 8px; color: #999;">Название:</td><td style="padding: 8px;">${escapeHtml(data.title)}</td></tr>` : ''}
      ${data.position ? `<tr><td style="padding: 8px; color: #999;">Позиция:</td><td style="padding: 8px;">${escapeHtml(data.position)}</td></tr>` : ''}
    </table>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${SITE_URL}/admin/moderation" style="${buttonStyle}">Модерация</a>
    </p>
  `);
  notifyAdminTelegram(`🏷 <b>Новый баннер на модерации</b>${data.title ? `\n\nНазвание: <b>${stripHtml(data.title)}</b>` : ''}${data.position ? `\nПозиция: ${stripHtml(data.position)}` : ''}\n\n→ <a href="https://promo-music.ru/ctrl-pm7k2f">Модерация</a>`).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Баннер: ${escapeHtml(data.title || 'без названия')}`, html });
}

export async function notifySupportTicket(data: { ticketId: string; subject: string; description: string; category?: string; priority?: string; userName?: string; userEmail?: string; }) {
  const userLabel = data.userName || data.userEmail || 'неизвестен';
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #6366F1;">Новый тикет в поддержку</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      <tr><td style="padding: 8px; color: #999;">Тема:</td><td style="padding: 8px;"><b>${escapeHtml(data.subject)}</b></td></tr>
      <tr><td style="padding: 8px; color: #999;">От:</td><td style="padding: 8px;">${escapeHtml(userLabel)}${data.userEmail && data.userName ? ` &lt;${escapeHtml(data.userEmail)}&gt;` : ''}</td></tr>
      ${data.category ? `<tr><td style="padding: 8px; color: #999;">Категория:</td><td style="padding: 8px;">${escapeHtml(data.category)}</td></tr>` : ''}
      ${data.priority ? `<tr><td style="padding: 8px; color: #999;">Приоритет:</td><td style="padding: 8px;">${escapeHtml(data.priority)}</td></tr>` : ''}
      <tr><td style="padding: 8px; color: #999; vertical-align: top;">Сообщение:</td><td style="padding: 8px; white-space: pre-wrap;">${escapeHtml(data.description)}</td></tr>
    </table>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${SITE_URL}/ctrl-pm7k2f/support" style="${buttonStyle}">Открыть в админке</a>
    </p>
  `);
  notifyAdminTelegram(`🆘 <b>Новый тикет поддержки</b>\n\nТема: <b>${stripHtml(data.subject)}</b>\nОт: ${stripHtml(userLabel)}${data.category ? `\nКатегория: ${stripHtml(data.category)}` : ''}${data.priority ? `\nПриоритет: ${stripHtml(data.priority)}` : ''}\n\n→ <a href="https://promo-music.ru/ctrl-pm7k2f/support">Открыть</a>`).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Тикет: ${escapeHtml(data.subject)}`, html });
}

export async function notifyPaymentReceived(data: { amount: number; currency?: string; type: string; description?: string; gateway?: string; userName?: string; userEmail?: string; orderId?: string; }) {
  const typeLabels: Record<string, string> = { purchase: 'Покупка', donation: 'Донат', subscription: 'Подписка', track_test: 'Тестирование трека' };
  const typeLabel = typeLabels[data.type] || data.type;
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #10B981;">Оплата получена</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      <tr><td style="padding: 8px; color: #999;">Сумма:</td><td style="padding: 8px; font-size: 20px; font-weight: 700; color: #10B981;">${data.amount} ${escapeHtml(data.currency || 'RUB')}</td></tr>
      <tr><td style="padding: 8px; color: #999;">Тип:</td><td style="padding: 8px;">${escapeHtml(typeLabel)}</td></tr>
      ${data.description ? `<tr><td style="padding: 8px; color: #999;">Описание:</td><td style="padding: 8px;">${escapeHtml(data.description)}</td></tr>` : ''}
      ${data.userName ? `<tr><td style="padding: 8px; color: #999;">Плательщик:</td><td style="padding: 8px;">${escapeHtml(data.userName)}</td></tr>` : ''}
      ${data.userEmail ? `<tr><td style="padding: 8px; color: #999;">Email:</td><td style="padding: 8px;">${escapeHtml(data.userEmail)}</td></tr>` : ''}
      ${data.gateway ? `<tr><td style="padding: 8px; color: #999;">Шлюз:</td><td style="padding: 8px;">${escapeHtml(data.gateway)}</td></tr>` : ''}
      ${data.orderId ? `<tr><td style="padding: 8px; color: #999;">Заказ:</td><td style="padding: 8px; font-family: monospace; font-size: 13px;">${escapeHtml(data.orderId)}</td></tr>` : ''}
    </table>
  `);
  notifyAdminTelegram(`💰 <b>Оплата получена</b>\n\nСумма: <b>${data.amount} ${stripHtml(data.currency || 'RUB')}</b>\nТип: ${stripHtml(typeLabel)}${data.description ? `\nОписание: ${stripHtml(data.description)}` : ''}${data.userName ? `\nПлательщик: ${stripHtml(data.userName)}` : ''}${data.userEmail ? `\nEmail: ${stripHtml(data.userEmail)}` : ''}${data.gateway ? `\nШлюз: ${stripHtml(data.gateway)}` : ''}${data.orderId ? `\nЗаказ: <code>${stripHtml(data.orderId)}</code>` : ''}`).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Оплата ${data.amount} ${data.currency || 'RUB'} — ${escapeHtml(typeLabel)}`, html });
}

// ── Universal Moderation Submission Notification ──
// Используется когда контент создаётся ИЛИ переходит в состояние pending_review.
// kind: трек / клип / концерт / баннер / промоакция / кампания / публикация
export async function notifyModerationSubmitted(data: {
  kind: string;             // human-readable: 'клип', 'промоакция', etc
  title?: string;
  artist?: string;
  userId?: string;
  email?: string;
  plan?: string;
  url?: string;             // ссылка на материал
  extra?: Record<string, string>;  // произвольные доп. поля
  adminPath?: string;       // путь к моделке: /admin/moderation, /admin/publish и т.п.
}) {
  const rows: string[] = [];
  if (data.title)  rows.push(`<tr><td style="padding: 8px; color: #999;">Название:</td><td style="padding: 8px;">${escapeHtml(data.title)}</td></tr>`);
  if (data.artist) rows.push(`<tr><td style="padding: 8px; color: #999;">Артист:</td><td style="padding: 8px;">${escapeHtml(data.artist)}</td></tr>`);
  if (data.plan)   rows.push(`<tr><td style="padding: 8px; color: #999;">Тариф:</td><td style="padding: 8px;">${escapeHtml(data.plan)}</td></tr>`);
  if (data.email)  rows.push(`<tr><td style="padding: 8px; color: #999;">Email:</td><td style="padding: 8px;">${escapeHtml(data.email)}</td></tr>`);
  if (data.userId) rows.push(`<tr><td style="padding: 8px; color: #999;">User ID:</td><td style="padding: 8px; font-family: monospace; font-size: 12px;">${escapeHtml(data.userId)}</td></tr>`);
  if (data.url)    rows.push(`<tr><td style="padding: 8px; color: #999;">Ссылка:</td><td style="padding: 8px; word-break: break-all;"><a href="${escapeHtml(data.url)}" style="color: #FF577F;">${escapeHtml(data.url)}</a></td></tr>`);
  if (data.extra) {
    for (const [k, v] of Object.entries(data.extra)) {
      if (v) rows.push(`<tr><td style="padding: 8px; color: #999;">${escapeHtml(k)}:</td><td style="padding: 8px;">${escapeHtml(String(v))}</td></tr>`);
    }
  }
  const moderateUrl = `${SITE_URL}${data.adminPath || '/ctrl-pm7k2f'}`;
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #F59E0B;">Новый ${escapeHtml(data.kind)} на модерации</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      ${rows.join('\n')}
    </table>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${moderateUrl}" style="${buttonStyle}">Перейти в модерацию</a>
    </p>
  `);
  const subjectTitle = data.title || data.kind;
  const extraLines = data.extra ? Object.entries(data.extra).filter(([_, v]) => v).map(([k, v]) => `\n${stripHtml(k)}: ${stripHtml(String(v))}`).join('') : '';
  notifyAdminTelegram(`📥 <b>Новый ${stripHtml(data.kind)} на модерации</b>${data.title ? `\n\nНазвание: <b>${stripHtml(data.title)}</b>` : ''}${data.artist ? `\nАртист: ${stripHtml(data.artist)}` : ''}${data.plan ? `\nТариф: ${stripHtml(data.plan)}` : ''}${data.email ? `\nEmail: ${stripHtml(data.email)}` : ''}${extraLines}${data.url ? `\nСсылка: ${stripHtml(data.url)}` : ''}\n\n→ <a href="${moderateUrl}">Перейти</a>`).catch(() => {});
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `[ПРОМО] На модерации (${escapeHtml(data.kind)}): ${escapeHtml(subjectTitle)}`,
    html,
  });
}


// ── Payment Expired (cancellation_details.reason = expired_on_confirmation) ──
export async function notifyPaymentExpired(data: {
  email: string;
  name?: string;
  amount: number;
  currency?: string;
  description?: string;
  retryUrl: string;        // deep link обратно в кабинет для повторной оплаты
  orderId?: string;
}): Promise<boolean> {
  const subject = `Не получилось оплатить ${data.amount} ${escapeHtml(data.currency || 'RUB')} — повторить?`;
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #F59E0B;">Не получилось оплатить?</h2>
    <p>Здравствуйте${data.name ? ', <b>' + escapeHtml(data.name) + '</b>' : ''}!</p>
    <p>Вы начали оплату на платформе ПРОМО.МУЗЫКА, но не завершили её — платёж был автоматически отменён через несколько минут.</p>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0; margin: 16px 0; background: rgba(255,255,255,0.03); border-radius: 8px;">
      <tr><td style="padding: 10px; color: #999;">Сумма:</td><td style="padding: 10px; font-size: 18px; font-weight: 700; color: #FF577F;">${data.amount} ${escapeHtml(data.currency || 'RUB')}</td></tr>
      ${data.description ? `<tr><td style="padding: 10px; color: #999;">Описание:</td><td style="padding: 10px;">${escapeHtml(data.description)}</td></tr>` : ''}
    </table>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${data.retryUrl}" style="${buttonStyle}">Повторить оплату</a>
    </p>
    <p style="color: #888; font-size: 13px;">Если у вас возникли проблемы с оплатой, ответьте на это письмо — мы поможем разобраться.</p>
    ${data.orderId ? `<p style="color: #555; font-size: 11px; margin-top: 20px;">Номер заказа: <code>${escapeHtml(data.orderId)}</code></p>` : ''}
  `);
  // Best-effort Telegram alert
  notifyAdminTelegram(`⏱ <b>Платёж истёк</b>\n\nEmail: ${stripHtml(data.email)}\nСумма: ${data.amount} ${stripHtml(data.currency || 'RUB')}${data.description ? `\nЗа что: ${stripHtml(data.description)}` : ''}\n\nОтправили reminder с retry-ссылкой.`).catch(() => {});
  return sendEmail({ to: data.email, subject, html });
}

// ── Live Support Chat ────────────────────────────────────────────

/**
 * Ping admins (email + Telegram) that a NEW live-chat session was
 * just started by a visitor. Fired from POST /chat-support/init.
 */
export async function notifyChatNewSession(data: { sessionId: string; guestName?: string; guestEmail?: string; firstMessage?: string; }) {
  const who = data.guestName || data.guestEmail || 'аноним';
  const link = `${SITE_URL}/ctrl-pm7k2f/live-chat?session=${encodeURIComponent(data.sessionId)}`;
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #06B6D4;">Новый чат с посетителем</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      <tr><td style="padding: 8px; color: #999;">От:</td><td style="padding: 8px;"><b>${escapeHtml(who)}</b></td></tr>
      ${data.guestEmail ? `<tr><td style="padding: 8px; color: #999;">Email:</td><td style="padding: 8px;">${escapeHtml(data.guestEmail)}</td></tr>` : ''}
      ${data.firstMessage ? `<tr><td style="padding: 8px; color: #999; vertical-align: top;">Первое сообщение:</td><td style="padding: 8px; white-space: pre-wrap;">${escapeHtml(data.firstMessage)}</td></tr>` : ''}
    </table>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${link}" style="${buttonStyle}">Открыть live-чат</a>
    </p>
  `);
  // Embed `[session:UUID]` marker in the TG message so the
  // /webhook/telegram handler can map admin's Reply-to-message back
  // to a chat_sessions row. Plain-text, monospaced so the marker is
  // greppable but doesn't dominate the visual. Reply-route flow:
  // admin presses Reply → sends "ответ" → bot parses
  // update.message.reply_to_message.text → finds [session:UUID] →
  // inserts chat_messages with sender_type='admin' + emits SSE to
  // the guest's stream.
  notifyAdminTelegram(
    `💬 <b>Новый live-чат на сайте</b>\n\n`
    + `От: ${stripHtml(who)}${data.guestEmail ? `\nEmail: ${stripHtml(data.guestEmail)}` : ''}`
    + `${data.firstMessage ? `\n\n${stripHtml(data.firstMessage).slice(0, 500)}` : ''}\n\n`
    + `<i>Чтобы ответить — нажмите Reply на это сообщение и отправьте текст.</i>\n`
    + `<code>[session:${data.sessionId}]</code>\n\n`
    + `→ <a href="${link}">Открыть в админке</a>`
  ).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Новый чат — ${who}`, html });
}

/**
 * Email-back to the visitor when admin replied while the chat widget
 * is offline (no active SSE stream). Lets the visitor return to the
 * conversation later. Only fired when guest_email is set on the session.
 */
export async function sendChatGuestReplyEmail(data: { toEmail: string; toName?: string; adminName: string; body: string; sessionId: string; guestToken: string; }) {
  const returnLink = `${SITE_URL}/?chat=${encodeURIComponent(data.sessionId)}&t=${encodeURIComponent(data.guestToken)}`;
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 20px;">Вам ответили в чате</h2>
    ${data.toName ? `<p>Здравствуйте, <strong>${escapeHtml(data.toName)}</strong>!</p>` : ''}
    <p>Оператор <strong>${escapeHtml(data.adminName)}</strong> ответил в чате на promo-music.ru:</p>
    <blockquote style="margin: 16px 0; padding: 16px 20px; background: #0e0e1f; border-left: 3px solid #FF577F; border-radius: 6px; color: #e0e0e0; white-space: pre-wrap;">${escapeHtml(data.body)}</blockquote>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${returnLink}" style="${buttonStyle}">Открыть чат</a>
    </p>
    <p style="color: #888; font-size: 13px;">Просто перейдите по кнопке — ваша история переписки восстановится. Также можно ответить на это письмо: ответ дойдёт до того же оператора.</p>
  `);
  return sendEmail({
    to: data.toEmail,
    subject: `Ответ в чате на ПРОМО.МУЗЫКА — ${escapeHtml(data.adminName)}`,
    html,
  });
}

// ── Venue trial expiration ───────────────────────────────────────

/**
 * Warning sent ~3 days before a venue's 14-day trial expires.
 * Gives the venue owner time to choose a tariff before access
 * downgrades from «Бизнес» (trial) to «Старт» (paid).
 */
export async function sendVenueTrialEndingEmail(data: { toEmail: string; venueName: string; daysRemaining: number; expiresAtIso: string; }) {
  const expiresHuman = new Date(data.expiresAtIso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 20px;">Триал ПРОМО.ЭИР заканчивается</h2>
    <p>Здравствуйте, <strong>${escapeHtml(data.venueName)}</strong>!</p>
    <p>Ваш 14-дневный пробный период на ПРОМО.ЭИР заканчивается <strong>${escapeHtml(expiresHuman)}</strong> (через ${data.daysRemaining} ${data.daysRemaining === 1 ? 'день' : 'дн.'}).</p>
    <p style="padding:12px;background:#1a1a2e;border-left:3px solid #F59E0B;border-radius:6px;color:#e0e0e0;">После окончания триала доступ к расширенным функциям («Бизнес» — мультизоны, расширенная аналитика, расписание, приоритетная поддержка) приостановится. Чтобы продолжить пользоваться этими возможностями — выберите тариф в кабинете.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${SITE_URL}/venue/subscription" style="${buttonStyle}">Выбрать тариф</a>
    </p>
    <p style="color:#888;font-size:13px;">Если ничего не сделать — заведение перейдёт на бесплатный режим: 1 зона, до 5 плейлистов, базовый каталог. Все ваши данные сохранятся, можно будет вернуться к платному тарифу в любое время.</p>
  `);
  return sendEmail({
    to: data.toEmail,
    subject: `ПРОМО.ЭИР: триал заканчивается через ${data.daysRemaining} ${data.daysRemaining === 1 ? 'день' : 'дн.'}`,
    html,
  });
}

/**
 * Fired by the trial-expiry cron once the venue's 14-day trial has
 * lapsed without payment. Lets the venue owner know their cabinet
 * has rolled back to the free tier and how to restore full access.
 */
export async function sendVenueTrialExpiredEmail(data: { toEmail: string; venueName: string; }) {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 20px;">Триал ПРОМО.ЭИР завершён</h2>
    <p>Здравствуйте, <strong>${escapeHtml(data.venueName)}</strong>!</p>
    <p>14-дневный пробный период подошёл к концу. Доступ к расширенным функциям сейчас ограничен — заведение работает в бесплатном режиме (1 зона, до 5 плейлистов, базовый каталог треков).</p>
    <p style="padding:12px;background:#1a1a2e;border-left:3px solid #10B981;border-radius:6px;color:#e0e0e0;">Все ваши плейлисты, расписания и настройки сохранены. Чтобы вернуть полный функционал — выберите тариф «Бизнес» (₽9 990/мес) или «Сеть» (₽14 990/мес) в кабинете.</p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${SITE_URL}/venue/subscription" style="${buttonStyle}">Выбрать тариф</a>
    </p>
    <p style="color:#888;font-size:13px;">Спасибо за то, что попробовали ПРОМО.ЭИР! Если есть вопросы — напишите на info@promofm.ru или в чат поддержки.</p>
  `);
  return sendEmail({
    to: data.toEmail,
    subject: 'ПРОМО.ЭИР: триал завершён, заведение в бесплатном режиме',
    html,
  });
}

/**
 * Welcome email fired right after venue signup. Sets expectations
 * for the 14-day trial: «заполните анкету → админ соберёт эфир →
 * вы получите код для устройства». Deliberately frames the radio
 * as «свой эфир с ведущими» without mentioning any technology
 * (per product positioning).
 */
export async function sendVenueRadioWelcomeEmail(data: { toEmail: string; venueName: string; trialDaysRemaining?: number; }) {
  const days = data.trialDaysRemaining ?? 14;
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 22px;">Добро пожаловать на ПРОМО.ЭИР!</h2>
    <p>Здравствуйте, <strong>${escapeHtml(data.venueName)}</strong>!</p>
    <p>Вы получили <strong>${days} дней бесплатного доступа</strong> к собственному радио для вашего заведения — без привязки карты.</p>
    <p style="padding:14px;background:#1a1a2e;border-left:3px solid #6366f1;border-radius:6px;color:#e0e0e0;">
      <strong>Что дальше:</strong><br>
      1. Зайдите в кабинет и заполните анкету — какая музыка нужна, какие джинглы, какой стиль ведущих.<br>
      2. Наш редактор соберёт ваш эфир под запрос (обычно за 1-2 рабочих дня).<br>
      3. Вы получите 6-значный код и приложение для Android-устройства в заведении.<br>
      4. Подключаете устройство к колонкам — и эфир играет.
    </p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${SITE_URL}/venue/onboarding" style="${buttonStyle}">Заполнить анкету</a>
    </p>
    <p style="color:#888;font-size:13px;">Вопросы? Напишите в чат поддержки прямо из кабинета или на info@promofm.ru — отвечаем в рабочие часы.</p>
  `);
  return sendEmail({
    to: data.toEmail,
    subject: `Добро пожаловать на ПРОМО.ЭИР — ${days} дней бесплатно`,
    html,
  });
}

/**
 * T-1 day reminder — fired the day before trial expiry by the
 * existing venue-trial cron. Complements sendVenueTrialEndingEmail
 * which fires at T-3 days; this one is the «last chance» nudge.
 */
export async function sendVenueTrialLastDayEmail(data: { toEmail: string; venueName: string; expiresAtIso: string; }) {
  const expiresHuman = new Date(data.expiresAtIso).toLocaleDateString('ru-RU', {
    day: '2-digit', month: 'long',
  });
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 20px;">Завтра последний день триала</h2>
    <p>Здравствуйте, <strong>${escapeHtml(data.venueName)}</strong>!</p>
    <p>Ваш пробный период на ПРОМО.ЭИР заканчивается <strong>${escapeHtml(expiresHuman)}</strong>. Это последний день, когда эфир работает без оплаты.</p>
    <p style="padding:12px;background:#2a1818;border-left:3px solid #EF4444;border-radius:6px;color:#fde0e0;">
      Если карта не привязана к концу дня — эфир в заведении приостановится. Все настройки сохранятся, реактивация занимает минуту после оплаты.
    </p>
    <p style="text-align:center;margin:28px 0;">
      <a href="${SITE_URL}/venue/subscription" style="${buttonStyle}">Выбрать тариф и продолжить</a>
    </p>
    <p style="color:#888;font-size:13px;">Тарифы: «Бизнес» ₽9 990/мес — до 4 зон, расширенная аналитика, расписание. «Сеть» ₽14 990/мес — несколько точек, API.</p>
  `);
  return sendEmail({
    to: data.toEmail,
    subject: 'ПРОМО.ЭИР: завтра последний день триала',
    html,
  });
}

/**
 * Notify the venue that admin has provisioned their radio — stream
 * is ready and the 6-character pairing code is in their cabinet.
 */
export async function sendVenueRadioReadyEmail(data: { toEmail: string; venueName: string; pairingCode: string; }) {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 22px;">Ваше радио готово к запуску</h2>
    <p>Здравствуйте, <strong>${escapeHtml(data.venueName)}</strong>!</p>
    <p>Эфир собран и готов транслироваться в заведении. Чтобы подключить — зайдите в кабинет и используйте код ниже.</p>
    <p style="text-align:center;margin:24px 0;">
      <span style="display:inline-block;padding:14px 28px;background:#0f0f1e;border:1px solid #6366f1;border-radius:12px;color:#a5b4fc;font-family:monospace;font-size:28px;letter-spacing:3px;font-weight:bold;">${escapeHtml(data.pairingCode)}</span>
    </p>
    <p style="padding:12px;background:#1a1a2e;border-left:3px solid #10B981;border-radius:6px;color:#e0e0e0;">
      <strong>Как подключить:</strong><br>
      1. Установите наше приложение на Android-устройство в заведении (ссылка в кабинете).<br>
      2. Откройте приложение, введите код выше.<br>
      3. Подключите устройство к колонкам — эфир начнёт играть.
    </p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${SITE_URL}/venue/apk" style="${buttonStyle}">Открыть кабинет</a>
    </p>
    <p style="color:#888;font-size:13px;">Код действует 24 часа. Если не успеете подключить — сгенерируйте новый в кабинете.</p>
  `);
  return sendEmail({
    to: data.toEmail,
    subject: 'ПРОМО.ЭИР: ваше радио готово, код подключения внутри',
    html,
  });
}

/**
 * Notify the venue when admin requests changes to their onboarding
 * submission («жанры противоречивые, уточните» / «частота джинглов
 * выглядит слишком большой» и т.п.). Brings them back to the wizard.
 */
export async function sendVenueRadioChangesRequestedEmail(data: { toEmail: string; venueName: string; message: string; }) {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #fff; font-size: 20px;">Нужно уточнить анкету</h2>
    <p>Здравствуйте, <strong>${escapeHtml(data.venueName)}</strong>!</p>
    <p>Наш редактор начал собирать ваш эфир и хочет уточнить пару моментов:</p>
    <p style="padding:14px;background:#1a1a2e;border-left:3px solid #F59E0B;border-radius:6px;color:#e0e0e0;">${escapeHtml(data.message)}</p>
    <p style="text-align:center;margin:24px 0;">
      <a href="${SITE_URL}/venue/onboarding" style="${buttonStyle}">Открыть анкету</a>
    </p>
    <p style="color:#888;font-size:13px;">После сохранения изменений анкета снова уйдёт редактору — обычно эфир запускается за 1 рабочий день.</p>
  `);
  return sendEmail({
    to: data.toEmail,
    subject: 'ПРОМО.ЭИР: уточните анкету для эфира',
    html,
  });
}

// ─── Engineer marketplace notifications ────────────────────────────
//
// Жизненный цикл engineer-order'а (см. engineer-routes.tsx):
//   pending → accepted → in_progress → delivered → completed
//                                            ↘ refunded (admin-only)
//
// SSE (колокольчик) уже летит в каждой точке. До этого PR'а e-mail
// дублирования не было — этот блок его добавляет. Шлются ВСЕМ по
// умолчанию (как notifyArtistRequest); per-user toggle'ы добавляются
// отдельным PR ("feat/engineer-email-toggles") вместе с колонками
// engineer_profiles.notify_email_* и Settings UI.
//
// sendEmail() уже умеет проверять unsubscribe-токен через
// isUnsubscribed(email), так что глобальный opt-out продолжает
// работать без знания contour'а.

function engineerOrderCard(title: string, opts?: { amount?: number; deliveryUrl?: string; reason?: string }) {
  const rows: string[] = [`<tr><td style="padding:8px 12px;color:#888;">Заказ:</td><td style="padding:8px 12px;color:#fff;">${escapeHtml(title)}</td></tr>`];
  if (opts?.amount != null) {
    rows.push(`<tr><td style="padding:8px 12px;color:#888;">Сумма:</td><td style="padding:8px 12px;color:#fff;">${escapeHtml(opts.amount.toLocaleString('ru-RU'))} ₽</td></tr>`);
  }
  if (opts?.deliveryUrl) {
    rows.push(`<tr><td style="padding:8px 12px;color:#888;">Файл:</td><td style="padding:8px 12px;"><a href="${escapeHtml(opts.deliveryUrl)}" style="color:#FF577F;">${escapeHtml(opts.deliveryUrl.slice(0, 64))}${opts.deliveryUrl.length > 64 ? '…' : ''}</a></td></tr>`);
  }
  if (opts?.reason) {
    rows.push(`<tr><td style="padding:8px 12px;color:#888;">Причина:</td><td style="padding:8px 12px;color:#fff;">${escapeHtml(opts.reason)}</td></tr>`);
  }
  return `<table style="width:100%;background:#1a1a2e;border-radius:8px;margin:16px 0;">${rows.join('')}</table>`;
}

export async function notifyEngineerNewOrder(
  email: string,
  name: string,
  orderTitle: string,
): Promise<boolean> {
  const html = emailWrapper(`
    <h2 style="margin:0 0 16px;color:#FF577F;">Новая заявка на услугу</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name || 'инженер')}</strong>!</p>
    <p>Клиент оставил заявку. Подтвердите готовность взять заказ — он перейдёт к оплате.</p>
    ${engineerOrderCard(orderTitle)}
    <p style="text-align:center;margin:28px 0;"><a href="${SITE_URL}/engineer/orders" style="${buttonStyle}">Открыть заявки</a></p>
  `);
  return sendEmail({ to: email, subject: `Заявка: ${orderTitle}`, html });
}

export async function notifyEngineerOrderPaid(
  email: string,
  name: string,
  orderTitle: string,
  amount: number,
): Promise<boolean> {
  const html = emailWrapper(`
    <h2 style="margin:0 0 16px;color:#10B981;">Заказ оплачен</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name || 'инженер')}</strong>!</p>
    <p>Клиент оплатил заказ. Можно приступать к работе — после сдачи отправьте файл через кабинет.</p>
    ${engineerOrderCard(orderTitle, { amount })}
    <p style="text-align:center;margin:28px 0;"><a href="${SITE_URL}/engineer/orders" style="${buttonStyle}">К заказам</a></p>
  `);
  return sendEmail({ to: email, subject: `Оплачен: ${orderTitle}`, html });
}

export async function notifyClientOrderDelivered(
  email: string,
  name: string,
  orderTitle: string,
  deliveryUrl: string,
): Promise<boolean> {
  const html = emailWrapper(`
    <h2 style="margin:0 0 16px;color:#FF577F;">Заказ готов</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name || '')}</strong>!</p>
    <p>Звукоинженер сдал работу. Проверьте файл и подтвердите приём — после этого заказ закроется.</p>
    ${engineerOrderCard(orderTitle, { deliveryUrl })}
    <p style="text-align:center;margin:28px 0;"><a href="${SITE_URL}/cabinet/orders" style="${buttonStyle}">Открыть заказ</a></p>
  `);
  return sendEmail({ to: email, subject: `Готов: ${orderTitle}`, html });
}

export async function notifyClientOrderRefunded(
  email: string,
  name: string,
  orderTitle: string,
  amount: number,
  reason: string,
): Promise<boolean> {
  const html = emailWrapper(`
    <h2 style="margin:0 0 16px;color:#7C3AED;">Возврат средств</h2>
    <p>Здравствуйте, <strong>${escapeHtml(name || '')}</strong>!</p>
    <p>Деньги по заказу возвращены на ваш способ оплаты. Зачисление обычно занимает 3–7 рабочих дней (правила банка-эмитента).</p>
    ${engineerOrderCard(orderTitle, { amount, reason: reason || undefined })}
    <p style="color:#888;font-size:13px;">Если у вас есть вопросы — ответьте на это письмо или напишите в поддержку: <a href="mailto:info@promofm.ru" style="color:#FF577F;">info@promofm.ru</a></p>
  `);
  return sendEmail({ to: email, subject: `Возврат: ${orderTitle}`, html });
}

// ─── DM (direct message) e-mail notification ───────────────────────
//
// Шлём получателю DM-сообщения с превью + ссылкой на беседу. Гейт
// от спама — в messaging-routes.tsx через таблицу dm_email_throttle
// (миграция 106): 1 письмо на (recipient, conversation) в час, не чаще.
//
// preview — уже truncated на стороне messaging-routes (≤120 chars
// + '...'). senderName может быть пустым (legacy); подставляем
// «пользователя».

export async function notifyDmReceived(
  recipientEmail: string,
  recipientName: string,
  senderName: string,
  preview: string,
  conversationLink: string,
): Promise<boolean> {
  const safeSender = (senderName || '').trim() || 'пользователя';
  const safePreview = (preview || '').trim() || '(вложение или пустое сообщение)';
  const safeLink = conversationLink.startsWith('/') ? `${SITE_URL}${conversationLink}` : conversationLink;
  const html = emailWrapper(`
    <h2 style="margin:0 0 16px;color:#FF577F;">Новое сообщение</h2>
    <p>Здравствуйте, <strong>${escapeHtml(recipientName || '')}</strong>!</p>
    <p>Вам написал <strong>${escapeHtml(safeSender)}</strong>:</p>
    <blockquote style="margin:16px 0;padding:14px 18px;background:#1a1a2e;border-left:3px solid #FF577F;border-radius:6px;color:#fff;">
      ${escapeHtml(safePreview)}
    </blockquote>
    <p style="text-align:center;margin:28px 0;"><a href="${escapeHtml(safeLink)}" style="${buttonStyle}">Открыть беседу</a></p>
    <p style="color:#888;font-size:12px;">
      Чтобы не получать e-mail про каждое сообщение, отключите DM-уведомления
      в настройках кабинета. Колокольчик в самом кабинете продолжит работать.
    </p>
  `);
  return sendEmail({
    to: recipientEmail,
    subject: `Сообщение от ${safeSender}`.slice(0, 200),
    html,
  });
}

// ── Radio download notification (admin side) ──
//
// Радиостанция скачала трек/микс из недельного пакета. Зеркалит
// notifyTrackUpload: письмо на info@promofm.ru + Telegram. Артисту/DJ
// уведомление шлёт сам роут (upsertNotification + emitSSE) — здесь
// только admin-канал. Fire-and-forget у caller'а: скачивание не должно
// падать из-за SMTP/Telegram.
export async function notifyRadioDownload(data: {
  kind: 'track' | 'mix';
  title: string;
  ownerName?: string;
  stationName?: string;
}): Promise<void> {
  const kindLabel = data.kind === 'mix' ? 'DJ-микс' : 'Трек';
  const station = data.stationName || 'Радиостанция (без имени профиля)';
  const owner = data.ownerName || '—';
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #10B981;">Радио скачало ${kindLabel === 'DJ-микс' ? 'микс' : 'трек'}</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      <tr><td style="padding: 8px; color: #999;">${escapeHtml(kindLabel)}:</td><td style="padding: 8px;">${escapeHtml(data.title)}</td></tr>
      <tr><td style="padding: 8px; color: #999;">Автор:</td><td style="padding: 8px;">${escapeHtml(owner)}</td></tr>
      <tr><td style="padding: 8px; color: #999;">Радиостанция:</td><td style="padding: 8px;">${escapeHtml(station)}</td></tr>
    </table>
    <p style="color:#888;font-size:13px;margin-top:16px;">Скачивание для эфира. Когда станция подтвердит ротацию — артист получит уведомление о ротации отдельно.</p>
  `);
  notifyAdminTelegram(`📻 <b>Радио скачало ${stripHtml(kindLabel === 'DJ-микс' ? 'микс' : 'трек')}</b>\n\n${stripHtml(kindLabel)}: <b>${stripHtml(data.title)}</b>\nАвтор: <b>${stripHtml(owner)}</b>\nРадиостанция: <b>${stripHtml(station)}</b>`).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Радио скачало: ${escapeHtml(station)} — ${escapeHtml(data.title)}`, html });
}

// ─── Track-test (тест трека): чтобы платный тракт не зависал молча ───

/**
 * Оплаченный (или списанный с подписочной квоты) тест трека ждёт
 * модерации админа. До 2026-07-07 сигнал был ТОЛЬКО эфемерным SSE
 * (emitSSE 'admin') — закрытая админ-вкладка = никто не узнал, заявка
 * висит в payment_succeeded с взятыми деньгами.
 */
export async function notifyTrackTestPending(data: { trackTitle: string; artistName: string; source: string; amount?: number }) {
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #F59E0B;">Тест трека ждёт модерации</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0;">
      <tr><td style="padding: 8px; color: #999;">Трек:</td><td style="padding: 8px;">${escapeHtml(data.trackTitle)}</td></tr>
      <tr><td style="padding: 8px; color: #999;">Артист:</td><td style="padding: 8px;">${escapeHtml(data.artistName)}</td></tr>
      <tr><td style="padding: 8px; color: #999;">Оплата:</td><td style="padding: 8px;">${escapeHtml(data.source)}${data.amount ? ` (${data.amount} ₽)` : ''}</td></tr>
    </table>
    <p style="color:#888;font-size:13px;margin-top:12px;">Деньги взяты — следующий шаг за админом: модерация → назначение экспертов.</p>
  `);
  notifyAdminTelegram(`🎧 <b>Тест трека ждёт модерации</b>\n\nТрек: <b>${stripHtml(data.trackTitle)}</b>\nАртист: <b>${stripHtml(data.artistName)}</b>\nОплата: ${stripHtml(data.source)}${data.amount ? ` (${data.amount} ₽)` : ''}\n\n→ <a href="https://promo-music.ru/ctrl-pm7k2f">Админка</a>`).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Тест трека ждёт модерации: ${escapeHtml(data.artistName)} — ${escapeHtml(data.trackTitle)}`, html });
}

/**
 * Digest SLA-свипа: заявки track-test, застрявшие дольше SLA своего
 * статуса (включая completed без отправленного артисту отчёта).
 */
export async function notifyTrackTestStalled(items: Array<{ id: string; trackTitle: string; artistName: string; status: string; hoursStuck: number }>) {
  if (!items.length) return;
  const rows = items.map(i =>
    `<tr><td style="padding:6px;">${escapeHtml(i.trackTitle)}</td><td style="padding:6px;">${escapeHtml(i.artistName)}</td><td style="padding:6px;color:#F87171;">${escapeHtml(i.status)}</td><td style="padding:6px;">${Math.round(i.hoursStuck)} ч</td></tr>`
  ).join('');
  const html = emailWrapper(`
    <h2 style="margin: 0 0 16px; color: #EF4444;">Track-test: ${items.length} застрявших заявок</h2>
    <table style="width: 100%; border-collapse: collapse; color: #e0e0e0; font-size: 13px;">
      <tr style="color:#999;"><td style="padding:6px;">Трек</td><td style="padding:6px;">Артист</td><td style="padding:6px;">Статус</td><td style="padding:6px;">Висит</td></tr>
      ${rows}
    </table>
    <p style="color:#888;font-size:13px;margin-top:12px;">Каждая строка — оплаченная заявка, по которой следующий шаг просрочен (модерация, эксперты, финализация или отправка отчёта артисту).</p>
  `);
  notifyAdminTelegram(`⚠️ <b>Track-test: ${items.length} застрявших заявок</b>\n\n${items.slice(0, 5).map(i => `• ${stripHtml(i.trackTitle)} — ${stripHtml(i.status)} (${Math.round(i.hoursStuck)} ч)`).join('\n')}${items.length > 5 ? `\n…и ещё ${items.length - 5}` : ''}\n\n→ <a href="https://promo-music.ru/ctrl-pm7k2f">Админка</a>`).catch(() => {});
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Track-test: ${items.length} застрявших заявок`, html });
}
