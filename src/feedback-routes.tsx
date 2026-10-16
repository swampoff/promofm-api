/**
 * FEEDBACK ROUTES — user feedback collection + admin management
 * POST /report — user submits feedback (bug, idea, ux_issue, question)
 * GET /reports — admin list with filters
 * PUT /reports/:id/resolve — mark resolved
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { classifyAndLog } from './error-classifier.ts';
import { requireAuth, requireAdmin, optionalAuth } from './auth-middleware.tsx';
import { apiError } from './error-codes.tsx';
import { knownHostFromRequest } from './site-origin.tsx';

const feedbackRoutes = new Hono();

// ─── POST /report ─────────────────────────────────────────────────────────────

feedbackRoutes.post('/report', requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.message) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'message is required');
    }

    const {
      type = 'idea',
      message,
      page,
      userId,
      context: extraContext,
    } = body;

    // Store in feedback_reports
    const res = await pool.query(
      `INSERT INTO feedback_reports (type, message, page_url, user_id, context)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [type, message, page || null, userId || null, extraContext ? JSON.stringify(extraContext) : null]
    );

    const reportId = res.rows[0].id;

    // Also classify into memory_errors for the error system
    if (type === 'bug' || type === 'ux_issue' || type === 'inactive_ui') {
      await classifyAndLog(message, page, userId, { source: 'user_feedback', reportId }).catch(() => {});
    }

    // Store ideas in memory_creative
    if (type === 'idea') {
      await pool.query(
        `INSERT INTO memory_creative (category, title, content, source)
         VALUES ('user_idea', $1, $2, 'user_feedback')`,
        [message.slice(0, 100), JSON.stringify({ message, page, userId, reportId })]
      ).catch(() => {});
    }

    return c.json({
      id: reportId,
      message: 'Спасибо! Ваш вклад помогает платформе расти.',
      type,
    });
  } catch (err: any) {
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// ─── GET /reports ─────────────────────────────────────────────────────────────

feedbackRoutes.get('/reports', requireAuth, requireAdmin, async (c) => {
  try {
    const type = c.req.query('type');
    const resolved = c.req.query('resolved');
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
    const offset = parseInt(c.req.query('offset') || '0');

    let sql = 'SELECT * FROM feedback_reports WHERE 1=1';
    const params: any[] = [];

    if (type) {
      params.push(type);
      sql += ` AND type = $${params.length}`;
    }
    if (resolved !== undefined) {
      params.push(resolved === 'true');
      sql += ` AND resolved = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
    params.push(offset);
    sql += ` OFFSET $${params.length}`;

    const res = await pool.query(sql, params);

    // Count total
    let countSql = 'SELECT COUNT(*) FROM feedback_reports WHERE 1=1';
    const countParams: any[] = [];
    if (type) { countParams.push(type); countSql += ` AND type = $${countParams.length}`; }
    if (resolved !== undefined) { countParams.push(resolved === 'true'); countSql += ` AND resolved = $${countParams.length}`; }
    const countRes = await pool.query(countSql, countParams);

    return c.json({
      data: res.rows,
      total: parseInt(countRes.rows[0].count),
      limit,
      offset,
    });
  } catch (err: any) {
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// ─── PUT /reports/:id/resolve ─────────────────────────────────────────────────

feedbackRoutes.put('/reports/:id/resolve', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.json().catch(() => ({}));
    const res = await pool.query(
      `UPDATE feedback_reports SET resolved = true, resolution = $2, resolved_at = NOW()
       WHERE id = $1 RETURNING id, type, message`,
      [id, body.resolution || null]
    );

    if (!res.rows.length) return apiError(c, 'NOT_FOUND', 'Report not found');

    // Also resolve related memory_errors
    await pool.query(
      `UPDATE memory_errors SET resolved = true WHERE message = $1 AND resolved = false`,
      [res.rows[0].message]
    ).catch(() => {});

    return c.json({ data: res.rows[0], resolved: true });
  } catch (err: any) {
    return apiError(c, 'INTERNAL_ERROR');
  }
});

export { feedbackRoutes };

// ─── Telegram notification helper ─────────────────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_LEAD_CHAT_ID || '';

async function notifyTelegram(text: string) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch (_) {}
}

// ─── POST /bug-report (PUBLIC — no auth required) ─────────────────────────────
// Плашка «Заметили ошибку? Напишите нам» на всех страницах (BugReportWidget).
// 12.10.2026: раньше сообщение попадало только в feedback_reports и Telegram —
// владелец не видел его ни в почте, ни в поддержке. Теперь ещё:
//  - тикет в поддержке на аккаунт автора, если он вошёл на сайт (по сессии).
//    Гостю тикет не создаём: по одной лишь почте из формы нельзя подкладывать
//    обращения в чужой кабинет, а у тикета обязателен user_id;
//  - колокольчик админам и письмо на info@promofm.ru, «Ответить» — автору.

feedbackRoutes.post('/bug-report', optionalAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.message || body.message.trim().length < 3) {
      return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'message is required (min 3 chars)');
    }

    const message = body.message.trim().slice(0, 2000);
    const page = body.page || 'login';
    // С какого сайта (promo-music.ru / promoair.ru): в page только путь.
    const host = knownHostFromRequest(c);
    const rawEmail = typeof body.email === 'string' ? body.email.trim().slice(0, 200) : '';
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;

    // Rate limit: max 5 per IP per hour (simple check via DB)
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const rateCheck = await pool.query(
      `SELECT COUNT(*) FROM feedback_reports
       WHERE context->>'ip' = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [ip]
    ).catch(() => ({ rows: [{ count: '0' }] }));
    if (parseInt(rateCheck.rows[0].count) >= 5) {
      return c.json({ error: 'Слишком много сообщений. Попробуйте позже.' }, 429);
    }

    // Автор — только вошедший пользователь (сессия).
    let author: { id: string; email: string | null; name: string | null } | null = null;
    try {
      const sessionUserId = c.get('userId') as string | undefined;
      if (sessionUserId) {
        const r = await pool.query(
          `SELECT id::text AS id, email, COALESCE(NULLIF(full_name, ''), NULLIF(display_name, '')) AS name
             FROM users WHERE id::text = $1 LIMIT 1`,
          [String(sessionUserId)]
        );
        author = r.rows[0] || null;
      }
    } catch (e: any) {
      console.error('[bug-report] author lookup failed:', e?.message);
    }
    // vk<id>@promo-music.ru — заглушки VK-входа, ответить на них нельзя.
    const accountEmail = author?.email && !/@promo-music\.ru$/i.test(author.email) ? author.email : null;
    const replyEmail = email || accountEmail;

    // Тикет в поддержке
    let ticketId: string | null = null;
    if (author) {
      ticketId = `TKT-${crypto.randomUUID()}`;
      const firstMessage = {
        id: `msg-${crypto.randomUUID()}`, ticket_id: ticketId, sender_id: author.id, sender_type: 'user',
        message, attachments: [], created_at: new Date().toISOString(), internal_note: false,
      };
      try {
        await pool.query(
          `INSERT INTO support_tickets (id, user_id, subject, description, category, priority, status,
                                        attachments, tags, messages, sla_due_date)
           VALUES ($1, $2, $3, $4, 'technical', 'medium', 'open',
                   '[]'::jsonb, '["bug-report"]'::jsonb, $5::jsonb, NOW() + INTERVAL '48 hours')`,
          [ticketId, author.id, `Ошибка на сайте: ${message.split('\n')[0].slice(0, 80)}`, message, JSON.stringify([firstMessage])]
        );
      } catch (e: any) {
        console.error('[bug-report] ticket create failed:', e?.message);
        ticketId = null;
      }
    }

    // Store in DB
    const res = await pool.query(
      `INSERT INTO feedback_reports (type, message, page_url, user_id, user_email, context)
       VALUES ('bug', $1, $2, $3, $4, $5) RETURNING id, created_at`,
      [message, page, author?.id || null, replyEmail,
       JSON.stringify({ ip, email, source: 'test_mode_banner', ticketId, host })]
    );

    const reportId = res.rows[0].id;

    // Classify into memory_errors
    classifyAndLog(message, page, null, { source: 'test_mode_banner', reportId }).catch(() => {});

    // Send to Telegram
    const tgText = `<b>🐛 Баг-репорт #${reportId}</b>\n\n` +
      `<b>Сообщение:</b> ${message}\n` +
      (replyEmail ? `<b>Email:</b> ${replyEmail}\n` : '') +
      (author ? `<b>Аккаунт:</b> ${author.name || author.email || author.id}\n` : '') +
      (ticketId ? `<b>Тикет:</b> ${ticketId} (поддержка в админке)\n` : '') +
      (host ? `<b>Сайт:</b> ${host}\n` : '') +
      `<b>Страница:</b> ${page}\n` +
      `<b>IP:</b> ${ip}\n` +
      `<b>Время:</b> ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
    notifyTelegram(tgText).catch(() => {});

    // Письмо на info@promofm.ru и колокольчик админам — не задерживают ответ.
    import('./email-helper.tsx')
      .then((m) => m.notifyBugReport({ reportId, ticketId, message, page, email: replyEmail, userName: author?.name || null, host }))
      .catch((e) => console.error('[bug-report] admin email failed:', e?.message));
    import('./cross-cabinet-notify.tsx')
      .then((m) => m.notifyAllAdmins({
        sourceRole: 'artist',
        type: 'support_ticket_new',
        title: `Ошибка на сайте: ${message.split('\n')[0].slice(0, 120)}`,
        message: `${author?.name || replyEmail || 'Гость'}: ${message}`.slice(0, 400),
        link: ticketId ? `/ctrl-pm7k2f?tab=tickets&id=${ticketId}` : '/ctrl-pm7k2f',
        metadata: { ticketId, reportId, source: 'bug_report' },
      }))
      .catch((e) => console.error('[bug-report] bell notify failed:', e?.message));

    return c.json({
      success: true,
      id: reportId,
      message: 'Спасибо! Мы получили ваше сообщение.',
    });
  } catch (err: any) {
    return apiError(c, 'INTERNAL_ERROR');
  }
});
