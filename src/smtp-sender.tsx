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
import { escapeHtml } from './email-helper.tsx';

const DEFAULT_SMTP_HOST = process.env.SMTP_HOST || 'localhost';
const DEFAULT_SMTP_PORT = Number(process.env.SMTP_PORT || '25');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
// FROM по умолчанию на ВЕРИФИЦИРОВАННОМ домене promo-music.ru — тот же,
// что использует транзакционный email-helper.tsx (FROM_EMAIL). Старый
// дефолт `noreply@promofm.org` — невалидный домен для Resend → даже при
// рабочем fallback'е письма bounce'ились. (2026-06-27)
const SMTP_FROM = process.env.SMTP_FROM || 'ПРОМО.МУЗЫКА <noreply@promo-music.ru>';
const SMTP_REPLY_TO = process.env.SMTP_REPLY_TO || 'noreply@promo-music.ru';
const SMTP_TLS = process.env.SMTP_TLS === 'true';
// Resend HTTP API fallback — тот же ключ/паттерн, что в email-helper.tsx.
// Bulk-sender раньше умел ТОЛЬКО nodemailer→localhost:25 без fallback'а,
// поэтому при недоступном Postfix кампании падали на 100% (а транзакционные
// письма выживали через Resend). Теперь bulk наследует тот же запасной канал.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// 2026-07-02: (а) домен выровнен на рабочий promo-music.ru — promofm.org не
// обслуживает SPA/API, все unsubscribe-клики уходили в никуда; (б) цель —
// API-эндпоинт, а не SPA-страница: RFC 8058 One-Click (Gmail/Yahoo) делает
// server-side POST по URL из List-Unsubscribe — SPA-страница JS не исполняет
// и POST не обрабатывает, One-Click был мёртв. Эндпоинт принимает и GET
// (человеческий клик), и POST (One-Click), параметры из query.
const PUBLIC_SITE_URL = process.env.PUBLIC_URL || 'https://promo-music.ru';
const UNSUBSCRIBE_URL = `${PUBLIC_SITE_URL}/server/api/email-campaigns/unsubscribe`;

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

// 11.10.2026: основной SMTP — reg.ru (см. email-helper.tsx). При его отказе (недоступен,
// суточный лимит 3000 писем, отказ получателю) пробуем местный exim → релей Soul FM.
const SMTP_IS_LOCAL = ['127.0.0.1', 'localhost', '::1'].includes(DEFAULT_SMTP_HOST);
let localTransporter: ReturnType<typeof nodemailer.createTransport> | null = null;
function getLocalTransporter() {
  if (!localTransporter) {
    localTransporter = nodemailer.createTransport({
      host: '127.0.0.1', port: 25, secure: false, tls: { rejectUnauthorized: false },
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000,
    });
  }
  return localTransporter;
}

export async function smtpSendEmail(opts: SmtpSendOptions, retries = 2): Promise<SmtpResult> {
  let lastError = 'Max retries exceeded';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await smtpSendEmailOnce(opts);
    if (result.success) return result;
    lastError = result.error || lastError;
    if (result.error?.includes('Invalid login') || result.error?.includes('rejected')) return result;
    if (attempt < retries) {
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`[SMTP] Retry ${attempt + 1}/${retries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // 2026-07-02: возвращаем ПОСЛЕДНЮЮ реальную ошибку, а не «Max retries
  // exceeded» — иначе campaign.stats.errors превращался в N бесполезных копий.
  return { success: false, error: lastError };
}

async function smtpSendEmailOnce(opts: SmtpSendOptions): Promise<SmtpResult> {
  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
  const from = opts.from || SMTP_FROM;

  // Заголовки строим ДО try, чтобы fallback (Resend) в catch'е переиспользовал
  // те же List-Unsubscribe заголовки.
  const headers: Record<string, string> = {
    'X-Mailer': 'PromoMusic/2.0',
    'Precedence': 'bulk',
  };
  let unsubLinkUrl = '';
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

    // Видимая ссылка в теле письма. Раньше адрес отписки жил ТОЛЬКО в
    // заголовке: почтовые клиенты показывали кнопку, но в самом письме
    // ссылки не было — а подписи в наших рассылках обещали «отпишитесь
    // ссылкой ниже» (замечено владельцем 2026-08-17). Обещание без ссылки
    // это и обман получателя, и повод пожаловаться на спам.
    //
    // Шаблон письма ставит {{unsubscribe_url}} там, где нужна ссылка. Если
    // подстановки в шаблоне нет — дописываем строку в конец, чтобы ни одна
    // массовая рассылка не ушла без возможности отписаться.
    unsubLinkUrl = unsubUrl;
  }

  let mailOpts: any = null;
  try {
    const transport = getTransporter();

    let finalHtml = opts.html;
    if (unsubLinkUrl) {
      const link = `<a href="${unsubLinkUrl}" style="color:#8a8aa0;text-decoration:underline;">Отписаться от рассылки</a>`;
      if (finalHtml.includes('{{unsubscribe_url}}')) {
        finalHtml = finalHtml.split('{{unsubscribe_url}}').join(unsubLinkUrl);
      } else if (!finalHtml.includes(UNSUBSCRIBE_URL)) {
        finalHtml += `<div style="text-align:center;padding:14px 10px;font-family:Arial,sans-serif;font-size:12px;color:#8a8aa0;">${link}</div>`;
      }
    }

    mailOpts = {
      from,
      to: recipients.join(', '),
      subject: opts.subject,
      html: finalHtml,
      text: htmlToPlainText(opts.html),
      replyTo: opts.replyTo || SMTP_REPLY_TO,
      headers,
    };
    const info = await transport.sendMail(mailOpts);

    console.log(`[SMTP] Sent to ${recipients.join(', ')}, msgId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[SMTP] Failed to send to ${recipients.join(', ')}:`, errMsg);
    if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ECONNRESET') || errMsg.includes('timeout')) {
      transporter = null;
    }

    if (!SMTP_IS_LOCAL && mailOpts) {
      try {
        const info = await getLocalTransporter().sendMail(mailOpts);
        console.log(`[SMTP] Sent via local relay (fallback) to ${recipients.join(', ')}, msgId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
      } catch (e2) {
        console.error(`[SMTP] local relay fallback failed for ${recipients.join(', ')}:`, e2 instanceof Error ? e2.message : String(e2));
      }
    }

    // Перманентный SMTP-отказ (auth misconfig / 550 rejected) — НЕ маскируем
    // fallback'ом: retry-цикл выше должен увидеть маркер в error и прерваться,
    // иначе на каждого получателя крутились 3 полных цикла SMTP(30s)+Resend,
    // а реальная причина терялась (2026-07-02).
    if (errMsg.includes('Invalid login') || errMsg.includes('rejected')) {
      return { success: false, error: errMsg };
    }

    // Fallback: Resend HTTP API (port 443) — мирроринг email-helper.tsx.
    // Срабатывает когда Postfix/localhost:25 недоступен. List-Unsubscribe
    // и прочие заголовки сохраняются (Resend принимает `headers`).
    // SMTP-ошибку сохраняем в итоговом сообщении — иначе диагностика теряется.
    const resendResult = await resendSendOnce({ ...opts, from, headers });
    if (resendResult) {
      if (resendResult.success) return resendResult;
      return { success: false, error: `SMTP: ${errMsg}; ${resendResult.error}` };
    }

    return { success: false, error: errMsg };
  }
}

/**
 * Resend HTTP API send — запасной транспорт для bulk-рассылок.
 * Возвращает null если RESEND_API_KEY не задан (тогда вызывающий код
 * отдаёт исходную SMTP-ошибку), иначе — результат Resend-попытки.
 */
async function resendSendOnce(
  opts: SmtpSendOptions & { from: string; headers: Record<string, string> }
): Promise<SmtpResult | null> {
  if (!RESEND_API_KEY) return null;
  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: opts.from,
        reply_to: opts.replyTo || SMTP_REPLY_TO,
        to: recipients,
        subject: opts.subject,
        html: opts.html,
        text: htmlToPlainText(opts.html),
        headers: opts.headers,
      }),
    });
    const result = await resp.json().catch(() => ({})) as { id?: string; message?: string };
    if (!resp.ok) {
      const detail = result?.message || `HTTP ${resp.status}`;
      console.error(`[SMTP→Resend] API error for ${recipients.join(', ')}:`, detail);
      return { success: false, error: `Resend: ${detail}` };
    }
    console.log(`[SMTP→Resend] Sent to ${recipients.join(', ')}, id: ${result.id}`);
    return { success: true, messageId: result.id };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[SMTP→Resend] Fallback failed for ${recipients.join(', ')}:`, errMsg);
    return { success: false, error: `Resend fallback: ${errMsg}` };
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
          // escapeHtml: vars (full_name юзера) — user-controlled, без экранирования
          // это HTML-инъекция в письмо. Функция-замена вместо строки — иначе
          // `$&`/`$'` в имени ломают replace (2026-07-02).
          html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => escapeHtml(String(val ?? '')));
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
