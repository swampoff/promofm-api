/**
 * EMAIL HELPER — Отправка email через SMTP (Reg.ru) с fallback на Resend HTTP API
 */
import nodemailer from 'nodemailer';

const ADMIN_EMAIL = 'info@promofm.ru';
const FROM_EMAIL = '"ПРОМО.МУЗЫКА" <noreply@promo-music.ru>';
const REPLY_TO = 'noreply@promo-music.ru';
const SITE_URL = 'https://promo-music.ru';
const API_BASE = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/server` : 'https://promo-music.ru/server';


// HTML entity escaping for safe email template interpolation
function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

// SMTP transport (Reg.ru mail hosting)
const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'mail.hosting.reg.ru',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'noreply@promo-music.ru',
    pass: process.env.SMTP_PASS || '',
  },
  tls: { rejectUnauthorized: false },
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
});

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
  // Try SMTP first
  if (process.env.SMTP_PASS) {
    try {
      const info = await smtpTransport.sendMail({
        from: opts.from || FROM_EMAIL,
        replyTo: REPLY_TO,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        headers: {
          'List-Unsubscribe': '<mailto:unsubscribe@promo-music.ru>',
          'X-Mailer': 'PROMO.MUSIC Platform',
          'Precedence': 'bulk',
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
      const result = await resp.json();
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

const emailWrapper = (content: string) => `
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
        <tr><td style="padding: 20px 40px 32px; color: #666; font-size: 12px; border-top: 1px solid #2a2a3e;">
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

export async function notifyArtistRequest(data: { artistName: string; trackTitle: string; genre?: string; stationName?: string; stationId: string; }) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: #FF577F;">Новая заявка артиста на радио</h2><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 8px; font-weight: bold;">Артист:</td><td>${escapeHtml(data.artistName)}</td></tr><tr><td style="padding: 8px; font-weight: bold;">Трек:</td><td>${escapeHtml(data.trackTitle)}</td></tr>${data.genre ? `<tr><td style="padding: 8px; font-weight: bold;">Жанр:</td><td>${data.genre}</td></tr>` : ''}<tr><td style="padding: 8px; font-weight: bold;">Радиостанция:</td><td>${escapeHtml(data.stationName || data.stationId)}</td></tr></table></div>`;
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Заявка: ${escapeHtml(data.artistName)} — ${escapeHtml(data.trackTitle)}`, html });
}

export async function notifyVenueRequest(data: { venueName: string; venueCity?: string; packageType?: string; totalPrice?: number; stationName?: string; stationId: string; }) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: #7C3AED;">Заявка заведения</h2><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 8px;">Заведение:</td><td>${escapeHtml(data.venueName)}</td></tr>${data.venueCity ? `<tr><td style="padding: 8px;">Город:</td><td>${data.venueCity}</td></tr>` : ''}${data.totalPrice ? `<tr><td style="padding: 8px;">Сумма:</td><td>${data.totalPrice}</td></tr>` : ''}<tr><td style="padding: 8px;">Станция:</td><td>${escapeHtml(data.stationName || data.stationId)}</td></tr></table></div>`;
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Заведение: ${escapeHtml(data.venueName)}`, html });
}

export async function notifyBookingRequest(data: { venueName: string; performerName?: string; eventTitle: string; eventDate: string; offeredPrice?: number; }) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: #10B981;">Новое бронирование</h2><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 8px;">Заведение:</td><td>${escapeHtml(data.venueName)}</td></tr>${data.performerName ? `<tr><td style="padding: 8px;">Артист:</td><td>${escapeHtml(data.performerName || "")}</td></tr>` : ''}<tr><td style="padding: 8px;">Событие:</td><td>${escapeHtml(data.eventTitle)}</td></tr><tr><td style="padding: 8px;">Дата:</td><td>${escapeHtml(data.eventDate)}</td></tr></table></div>`;
  await sendEmail({ to: ADMIN_EMAIL, subject: `[ПРОМО] Бронирование: ${escapeHtml(data.eventTitle)} — ${escapeHtml(data.eventDate)}`, html });
}

export async function notifyNewUser(data: { email: string; name: string; role: string; via?: string; needsApproval?: boolean; }) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: ${data.needsApproval ? '#F59E0B' : '#3B82F6'};">${data.needsApproval ? 'Заявка — требует одобрения' : 'Новый пользователь'}</h2><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 8px;">Имя:</td><td>${escapeHtml(data.name)}</td></tr><tr><td style="padding: 8px;">Email:</td><td>${escapeHtml(data.email)}</td></tr><tr><td style="padding: 8px;">Роль:</td><td>${escapeHtml(data.role)}</td></tr>${data.via ? `<tr><td style="padding: 8px;">Через:</td><td>${data.via}</td></tr>` : ''}</table></div>`;
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
