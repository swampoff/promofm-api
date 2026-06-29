/**
 * SMTP EMAIL SENDER — Node.js version using Nodemailer
 * Replaces Deno TCP implementation with standard Node.js nodemailer
 *
 * Features:
 * - Nodemailer transport (SMTP / local Postfix)
 * - STARTTLS support (port 587)
 * - AUTH LOGIN
 * - Connection pooling
 * - Per-email retry with exponential backoff
 * - List-Unsubscribe header (RFC 8058)
 * - Multi-part MIME (HTML + plain text fallback)
 * - Batch sending with rate limiting
 */

import nodemailer from 'nodemailer';
import { generateUnsubToken } from './unsub-token.tsx';

const DEFAULT_SMTP_HOST = process.env.SMTP_HOST || 'localhost';
const DEFAULT_SMTP_PORT = Number(process.env.SMTP_PORT || '25');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'ПРОМО.МУЗЫКА <noreply@promofm.org>';
const SMTP_TLS = process.env.SMTP_TLS === 'true';
const UNSUBSCRIBE_URL = 'https://promofm.org/unsubscribe';

interface SmtpSendOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
  listUnsubscribe?: boolean;
  campaignId?: string;
}

interface SmtpResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function createTransporter() {
  const opts: any = {
    host: DEFAULT_SMTP_HOST,
    port: DEFAULT_SMTP_PORT,
    secure: DEFAULT_SMTP_PORT === 465,
    connectionTimeout: 30000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };

  if (SMTP_TLS && DEFAULT_SMTP_PORT === 587) {
    opts.requireTLS = true;
  }

  if (SMTP_USER && SMTP_PASS) {
    opts.auth = { user: SMTP_USER, pass: SMTP_PASS };
  }

  // Local Postfix relay (and most providers) present a STARTTLS cert whose
  // CN/SAN does not match the connect host (e.g. 127.0.0.1). Skip verification,
  // mirroring email-helper.tsx (which sets this unconditionally and works).
  // Without it, port-25 + SMTP_USER sends die with "Hostname/IP does not match
  // certificate's altnames" and the entire campaign send path fails.
  opts.tls = { ...(opts.tls || {}), rejectUnauthorized: false };

  return nodemailer.createTransport(opts);
}

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!transporter) transporter = createTransporter();
  return transporter;
}

export async function smtpSendEmail(opts: SmtpSendOptions, retries = 2): Promise<SmtpResult> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await smtpSendEmailOnce(opts);
    if (result.success) return result;
    if (result.error?.includes('Invalid login') || result.error?.includes('rejected')) return result;
    if (attempt < retries) {
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`[SMTP] Retry ${attempt + 1}/${retries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return { success: false, error: 'Max retries exceeded' };
}

async function smtpSendEmailOnce(opts: SmtpSendOptions): Promise<SmtpResult> {
  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
  const from = opts.from || SMTP_FROM;

  try {
    const transport = getTransporter();
    const headers: Record<string, string> = {
      'X-Mailer': 'PromoMusic/2.0',
      'Precedence': 'bulk',
    };

    if (opts.listUnsubscribe !== false) {
      const email = recipients[0];
      // Audit B-7 (2026-05-31): подписываем unsub-URL HMAC-токеном чтобы
      // /unsubscribe endpoint мог отвергнуть mass-guess attack (POST с
      // чужим email без токена). Старые письма без token продолжают
      // работать в soft-режиме (см. STRICT_UNSUB_TOKEN ENV в endpoint).
      const { t, sig } = generateUnsubToken(email);
      const params = new URLSearchParams({ email, t: String(t), sig });
      if (opts.campaignId) params.set('campaign', opts.campaignId);
      const unsubUrl = `${UNSUBSCRIBE_URL}?${params.toString()}`;
      headers['List-Unsubscribe'] = `<${unsubUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    const info = await transport.sendMail({
      from,
      to: recipients.join(', '),
      subject: opts.subject,
      html: opts.html,
      text: htmlToPlainText(opts.html),
      replyTo: opts.replyTo,
      headers,
    });

    console.log(`[SMTP] Sent to ${recipients.join(', ')}, msgId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[SMTP] Failed to send to ${recipients.join(', ')}:`, errMsg);
    if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ECONNRESET') || errMsg.includes('timeout')) {
      transporter = null;
    }
    return { success: false, error: errMsg };
  }
}

export async function smtpSendBatch(
  recipients: { email: string; vars?: Record<string, string> }[],
  subject: string,
  htmlTemplate: string,
  options?: {
    from?: string;
    replyTo?: string;
    batchSize?: number;
    delayMs?: number;
    campaignId?: string;
  }
): Promise<{ total: number; sent: number; failed: number; errors: string[] }> {
  const batchSize = options?.batchSize || 50;
  const delayMs = options?.delayMs || 1000;
  const errors: string[] = [];
  let sent = 0;
  let failed = 0;

  const seen = new Set<string>();
  const validRecipients = recipients.filter(rcpt => {
    const email = rcpt.email.trim().toLowerCase();
    if (!email || !email.includes('@') || seen.has(email)) return false;
    seen.add(email);
    return true;
  });

  for (let i = 0; i < validRecipients.length; i += batchSize) {
    const batch = validRecipients.slice(i, i + batchSize);

    for (const rcpt of batch) {
      let html = htmlTemplate;
      if (rcpt.vars) {
        for (const [key, val] of Object.entries(rcpt.vars)) {
          html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
        }
      }

      const result = await smtpSendEmail({
        to: rcpt.email, subject, html,
        from: options?.from, replyTo: options?.replyTo,
        listUnsubscribe: true, campaignId: options?.campaignId,
      });

      if (result.success) sent++;
      else { failed++; errors.push(`${rcpt.email}: ${result.error}`); }
    }

    if (i + batchSize < validRecipients.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`[SMTP Batch] Total: ${validRecipients.length}, Sent: ${sent}, Failed: ${failed}`);
  return { total: validRecipients.length, sent, failed, errors };
}
