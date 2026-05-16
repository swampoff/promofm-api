/**
 * EMAIL HELPER — Отправка email через SMTP (Reg.ru) с fallback на Resend HTTP API
 */
import nodemailer from 'nodemailer';

const ADMIN_EMAIL = 'info@promofm.ru';
const FROM_EMAIL = '"ПРОМО.МУЗЫКА" <noreply@promo-music.ru>';
const REPLY_TO = 'noreply@promo-music.ru';
const SITE_URL = 'https://promo-music.ru';
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

export async function notifyNewUser(data: { email: string; name: string; role: string; via?: string; needsApproval?: boolean; }) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 600px;"><h2 style="color: ${data.needsApproval ? '#F59E0B' : '#3B82F6'};">${data.needsApproval ? 'Заявка — требует одобрения' : 'Новый пользователь'}</h2><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 8px;">Имя:</td><td>${escapeHtml(data.name)}</td></tr><tr><td style="padding: 8px;">Email:</td><td>${escapeHtml(data.email)}</td></tr><tr><td style="padding: 8px;">Роль:</td><td>${escapeHtml(data.role)}</td></tr>${data.via ? `<tr><td style="padding: 8px;">Через:</td><td>${escapeHtml(data.via)}</td></tr>` : ''}</table></div>`;
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

