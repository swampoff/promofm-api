/**
 * TICKETS SYSTEM ROUTES
 * Система тикетов поддержки
 *
 * Uses support_tickets table via db.tsx helpers + direct pool queries.
 * Since migration 048 all top-level fields are native cols; only the
 * conversation thread (`messages`), `attachments`, and `tags` remain
 * jsonb arrays.
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { getTicketsByUser, upsertTicket, getVenueProfile, upsertNotification } from './db.tsx';
import { pool } from './db-client.tsx';
import { notifySupportTicket } from './email-helper.tsx';
import { getEffectiveVenueLimits } from './venue-plan-limits.tsx';

const app = new Hono();

// ── Видимость внутренних заметок (20.10.2026) ──
// Заметка команды (internal_note: true) видна только админам. Раньше API
// отдавал её автору тикета, а скрывал только фронт PROMO.AIR.
const isStaff = (role: unknown) => role === 'admin' || role === 'superadmin';
function visibleMessages(raw: unknown, staff: boolean): any[] {
  const list = Array.isArray(raw) ? raw : [];
  return staff ? list : list.filter((m: any) => !(m && m.internal_note === true));
}
function ticketForViewer<T extends Record<string, any>>(ticket: T, staff: boolean): T {
  if (!ticket || staff) return ticket;
  return { ...ticket, messages: visibleMessages(ticket.messages, false) };
}

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, urgent: 3 };

/**
 * Приоритет нового тикета. Заведение на тарифе с приоритетной поддержкой
 * (Бизнес, Сеть, корпоративный; в т. ч. пробный на них) получает не ниже
 * 'high' (SLA 24 ч) независимо от того, что прислал клиент. Остальные роли
 * и тарифы как раньше: значение клиента или 'medium'.
 */
async function ticketPriority(userId: string, role: unknown, asked: unknown): Promise<string> {
  if (role !== 'venue') return (asked || 'medium') as string; // как до 20.10.2026
  const client = typeof asked === 'string' && Object.prototype.hasOwnProperty.call(PRIORITY_RANK, asked) ? asked : 'medium';
  try {
    const profile = await getVenueProfile(userId);
    if (profile && getEffectiveVenueLimits(profile).prioritySupport) {
      return PRIORITY_RANK[client] >= PRIORITY_RANK.high ? client : 'high';
    }
  } catch (err: any) {
    console.warn('[tickets] venue priority lookup failed:', err?.message);
  }
  return client;
}

// ============================================
// TICKETS
// ============================================

/**
 * GET /user/:userId
 * Получить все тикеты пользователя
 */
app.get('/user/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  const authRole = c.get('userRole');
  if (userId !== authUserId && authRole !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  try {
    const tickets = await getTicketsByUser(userId);

    const staff = isStaff(authRole);
    const sorted = (tickets || [])
      .filter(Boolean)
      .map((t: any) => ticketForViewer(t, staff))
      .sort((a: any, b: any) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );

    return c.json({
      success: true,
      data: sorted
    });
  } catch (error) {
    console.error('Error loading tickets:', error);
    return c.json({
      success: true,
      data: []
    });
  }
});

/**
 * GET /:ticketId
 * Получить конкретный тикет
 */
app.get('/:ticketId', requireAuth, async (c) => {
  const ticketId = c.req.param('ticketId');

  try {
    // Native cols (migration 048) — row напрямую через pool.query.
    const _q = await pool.query(
      `SELECT id, user_id, subject, description, category, priority, status,
              assigned_to, attachments, tags, messages, rating, feedback,
              sla_due_date, resolved_at, closed_at, created_at, updated_at
         FROM support_tickets WHERE id = $1 LIMIT 1`,
      [ticketId]
    );
    const ticket = _q.rowCount ? _q.rows[0] : null;

    if (!ticket) {
      return c.json({
        success: false,
        error: 'Ticket not found'
      }, 404);
    }

    // 2026-06-18 IDOR-closure (mirror PUT /:ticketId block ниже): только
    // владелец тикета или admin может читать; раньше любой auth'd user
    // мог прочитать чужой тикет по угаданному UUID.
    const authUserId = c.get('userId');
    const authRole = c.get('userRole');
    if (authRole !== 'admin' && ticket.user_id !== authUserId) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    return c.json({
      success: true,
      data: ticketForViewer(ticket, isStaff(authRole))
    });
  } catch (error) {
    console.error('Error loading ticket:', error);
    return c.json({
      success: false,
      error: 'Failed to load ticket'
    }, 500);
  }
});

/**
 * POST /create
 * Создать новый тикет
 */
app.post('/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const user_id = c.get('userId'); // IDOR fix: from JWT
    const {
      subject,
      description,
      category,
      attachments,
    } = body;

    if (!subject || !description || !category) {
      return c.json({
        success: false,
        error: 'Missing required fields'
      }, 400);
    }

    const ticketId = `TKT-${crypto.randomUUID()}`;
    // Приоритет решает сервер для заведений (приоритетная поддержка тарифа).
    const priority = await ticketPriority(user_id, c.get('userRole'), body.priority);

    // Создаём первое сообщение (описание проблемы)
    const firstMessageId = `msg-${crypto.randomUUID()}`;

    const firstMessage = {
      id: firstMessageId,
      ticket_id: ticketId,
      sender_id: user_id,
      sender_type: 'user',
      message: description,
      attachments: attachments || [],
      created_at: new Date().toISOString(),
      internal_note: false,
    };

    const ticket = {
      id: ticketId,
      user_id,
      subject,
      description,
      category, // 'technical' | 'billing' | 'content' | 'account' | 'other'
      priority: priority || 'medium', // 'low' | 'medium' | 'high' | 'urgent'
      status: 'open', // 'open' | 'in_progress' | 'waiting_response' | 'resolved' | 'closed'
      assigned_to: null,
      attachments: attachments || [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resolved_at: null,
      closed_at: null,
      sla_due_date: calculateSLADueDate(priority || 'medium'),
      tags: [],
      rating: null,
      feedback: null,
      messages: [firstMessage],
    };

    // Native cols (migration 048) — INSERT all promoted fields.
    try {
      await pool.query(
        `INSERT INTO support_tickets (
           id, user_id, subject, description, category, priority, status,
           attachments, tags, messages, sla_due_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'open',
                 $7::jsonb, '[]'::jsonb, $8::jsonb, $9)`,
        [
          ticketId, user_id, subject, description, category,
          priority || 'medium',
          JSON.stringify(attachments || []),
          JSON.stringify([firstMessage]),
          ticket.sla_due_date || null,
        ]
      );
    } catch (err: any) {
      console.error('[tickets] create ticket error:', err?.message);
    }

    // Notify admin (email + Telegram). Resolve user identity for the notification
    // so admins see real name/email instead of UUID.
    let userInfo: { email?: string; full_name?: string; display_name?: string } = {};
    try {
      const { rows } = await pool.query(
        'SELECT email, full_name, display_name FROM users WHERE id = $1 LIMIT 1',
        [user_id],
      );
      userInfo = rows[0] || {};
      await notifySupportTicket({
        ticketId,
        subject,
        description,
        category,
        priority: priority || 'medium',
        userName: userInfo.full_name || userInfo.display_name || undefined,
        userEmail: userInfo.email || undefined,
      });
    } catch (notifyErr) {
      console.error('[tickets] admin notify failed:', notifyErr);
    }

    // Bell-уведомление админам (cross_cabinet_notifications)
    try {
      const { notifyAllAdmins } = await import('./cross-cabinet-notify.tsx');
      const userLabel = userInfo.full_name || userInfo.display_name || userInfo.email || 'Пользователь';
      await notifyAllAdmins({
        sourceRole: 'artist',  // user role не всегда artist, но source-role здесь noise — это «не-админ»
        type: 'support_ticket_new',
        title: `Новый тикет: ${subject}`.slice(0, 200),
        message: `${userLabel} (${category}, ${priority || 'medium'}): ${description}`.slice(0, 400),
        link: `/ctrl-pm7k2f?tab=tickets&id=${ticketId}`,
        metadata: { ticketId, category, priority: priority || 'medium', userId: user_id },
      });
    } catch (bellErr) {
      console.error('[tickets] bell notify failed:', bellErr);
    }

    return c.json({
      success: true,
      data: ticket
    });
  } catch (error) {
    console.error('Error creating ticket:', error);
    return c.json({
      success: false,
      error: 'Failed to create ticket'
    }, 500);
  }
});

/**
 * PUT /:ticketId
 * Обновить тикет
 */
app.put('/:ticketId', requireAuth, async (c) => {
  const ticketId = c.req.param('ticketId');

  try {
    const body = await c.req.json();

    // Fetch existing ticket — native cols (migration 048).
    const _f = await pool.query(
      `SELECT id, user_id, subject, description, category, priority, status,
              assigned_to, attachments, tags, messages, rating, feedback,
              sla_due_date, resolved_at, closed_at, created_at, updated_at
         FROM support_tickets WHERE id = $1 LIMIT 1`,
      [ticketId]
    );
    const ticket = _f.rowCount ? _f.rows[0] : null;

    if (!ticket) {
      return c.json({
        success: false,
        error: 'Ticket not found'
      }, 404);
    }

    // 2026-06-18: owner-check добавлен. Раньше любой authenticated юзер
    // мог обновить/закрыть/изменить priority/category/status чужого
    // тикета по угаданному UUID — IDOR-вектор. Admin сохраняет полный
    // доступ (поддержка работает с тикетами всех юзеров).
    const userId = c.get('userId');
    const role = c.get('userRole');
    if (role !== 'admin' && ticket.user_id !== userId) {
      console.warn(`[tickets-system] PUT IDOR: userId=${userId} tried to update ticketId=${ticketId} owned by ${ticket.user_id}`);
      return c.json({ success: false, error: 'Нельзя редактировать чужой тикет' }, 403);
    }

    // Не админ не переписывает ленту сообщений (иначе мог бы стереть заметки
    // команды или вписать ответ «от поддержки») и не меняет владельца. У
    // заведения приоритет назначает сервер (ticketPriority).
    const patch: Record<string, any> = body && typeof body === 'object' ? { ...body } : {};
    if (!isStaff(role)) {
      delete patch.messages;
      delete patch.user_id;
      delete patch.id;
      if (role === 'venue') delete patch.priority;
    }
    const updatedTicket = {
      ...ticket,
      ...patch,
      updated_at: new Date().toISOString(),
    };

    // Preserve messages array if body doesn't include it
    if (!patch.messages && ticket.messages) {
      updatedTicket.messages = ticket.messages;
    }

    // Если статус изменился на resolved/closed, устанавливаем дату
    if (body.status === 'resolved' && !ticket.resolved_at) {
      updatedTicket.resolved_at = new Date().toISOString();
    }
    if (body.status === 'closed' && !ticket.closed_at) {
      updatedTicket.closed_at = new Date().toISOString();
    }

    await upsertTicket(ticketId, updatedTicket);

    return c.json({
      success: true,
      data: ticketForViewer(updatedTicket, isStaff(role))
    });
  } catch (error) {
    console.error('Error updating ticket:', error);
    return c.json({
      success: false,
      error: 'Failed to update ticket'
    }, 500);
  }
});

/**
 * DELETE /:ticketId
 * Удалить тикет
 */
app.delete('/:ticketId', requireAuth, async (c) => {
  const ticketId = c.req.param('ticketId');

  try {
    // 2026-06-18 IDOR-closure: WHERE id AND (user_id = jwt OR admin).
    // Раньше DELETE WHERE id = $1 — любой auth'd user мог удалить
    // чужой тикет по угаданному UUID. Atomic: одной query + owner-check
    // + 404 неразличим от 403 (это minor; main goal — не пускать).
    const authUserId = c.get('userId');
    const authRole = c.get('userRole');
    const del = await pool.query(
      `DELETE FROM support_tickets WHERE id = $1 AND ($3::text = 'admin' OR user_id = $2)`,
      [ticketId, authUserId, authRole],
    );
    if (del.rowCount === 0) {
      return c.json({
        success: false,
        error: 'Ticket not found or access denied'
      }, 404);
    }

    // Messages live in ticket.messages jsonb — deleted along with the row.

    return c.json({
      success: true
    });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    return c.json({
      success: false,
      error: 'Failed to delete ticket'
    }, 500);
  }
});

// ============================================
// TICKET MESSAGES
// ============================================

/**
 * GET /:ticketId/messages
 * Получить все сообщения тикета
 */
app.get('/:ticketId/messages', requireAuth, async (c) => {
  const ticketId = c.req.param('ticketId');

  try {
    // 2026-06-18 IDOR-closure: SELECT user_id + messages atomically;
    // если ticket существует но не свой — 403. Раньше любой auth'd user
    // мог читать чужие сообщения support-чата (включая PII).
    const _q = await pool.query(
      `SELECT user_id, messages FROM support_tickets WHERE id = $1 LIMIT 1`,
      [ticketId]
    );
    if (!_q.rowCount) {
      return c.json({ success: false, error: 'Ticket not found' }, 404);
    }
    const authUserId = c.get('userId');
    const authRole = c.get('userRole');
    if (authRole !== 'admin' && _q.rows[0].user_id !== authUserId) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    const raw = _q.rows[0].messages || [];
    const messages = visibleMessages(raw, isStaff(authRole))
      .sort((a: any, b: any) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

    return c.json({
      success: true,
      data: messages
    });
  } catch (error) {
    console.error('Error loading ticket messages:', error);
    return c.json({
      success: true,
      data: []
    });
  }
});

/**
 * POST /:ticketId/messages
 * Добавить сообщение в тикет
 */
app.post('/:ticketId/messages', requireAuth, async (c) => {
  const ticketId = c.req.param('ticketId');

  try {
    const body = await c.req.json();
    const sender_id = c.get('userId'); // IDOR fix: from JWT
    const authRole = c.get('userRole');
    const {
      sender_type, // 'user' | 'support' | 'admin'
      message,
      attachments,
      internal_note,
    } = body;

    if (!sender_type || !message) {
      return c.json({
        success: false,
        error: 'Missing required fields'
      }, 400);
    }

    // 2026-06-18 IDOR-closure: sender_type='admin'|'support' доступен
    // только admin'у; обычный user может писать только как 'user' и
    // только в свой тикет.
    if ((sender_type === 'admin' || sender_type === 'support') && authRole !== 'admin') {
      return c.json({ success: false, error: 'Только admin может писать как support/admin' }, 403);
    }
    if (sender_type === 'user' && authRole !== 'admin') {
      const own = await pool.query(
        `SELECT user_id FROM support_tickets WHERE id = $1 LIMIT 1`,
        [ticketId]
      );
      if (!own.rowCount) {
        return c.json({ success: false, error: 'Ticket not found' }, 404);
      }
      if (own.rows[0].user_id !== sender_id) {
        return c.json({ success: false, error: 'Нельзя писать в чужой тикет' }, 403);
      }
    }

    const messageId = `msg-${crypto.randomUUID()}`;
    const messageData = {
      id: messageId,
      ticket_id: ticketId,
      sender_id,
      sender_type,
      message,
      attachments: attachments || [],
      // Заметку «только для команды» может оставить только админ.
      internal_note: isStaff(authRole) ? internal_note === true : false,
      created_at: new Date().toISOString(),
    };

    // Atomic append + auto-status-transition. Single UPDATE avoids the
    // get-modify-set race that lost concurrent messages in the old impl.
    //  - messages = messages || [new]   appends to jsonb array
    //  - status moves waiting_response → in_progress when support/admin
    //    posts; user posts leave status alone.
    const bumpStatus = (sender_type === 'support' || sender_type === 'admin');
    const upd = await pool.query(
      `UPDATE support_tickets SET
         messages   = COALESCE(messages, '[]'::jsonb) || $2::jsonb,
         status     = CASE
                        WHEN $3::boolean AND status = 'waiting_response' THEN 'in_progress'
                        ELSE status
                      END,
         updated_at = NOW()
       WHERE id = $1
       RETURNING user_id, subject`,
      [ticketId, JSON.stringify([messageData]), bumpStatus]
    );
    if (upd.rowCount === 0) {
      return c.json({
        success: false,
        error: 'Ticket not found'
      }, 404);
    }

    // Bell-уведомление автору тикета, когда отвечает поддержка/админ.
    // internal_note пропускаем — это заметка для команды, юзер её не видит.
    if (bumpStatus && !messageData.internal_note) {
      const ticket = upd.rows[0] as { user_id: string; subject: string };
      if (ticket?.user_id && ticket.user_id !== sender_id) {
        try {
          const ur = await pool.query(
            'SELECT role::text AS role FROM users WHERE id::text = $1 LIMIT 1',
            [ticket.user_id]
          );
          const userRole = (ur.rows[0]?.role || 'artist') as
            'artist' | 'dj' | 'admin' | 'radio' | 'venue' | 'producer' | 'label';
          const preview = String(message).trim();
          const short = preview.length > 200 ? preview.slice(0, 197) + '...' : preview;
          // Кабинет заведения читает колокольчик из notifications
          // (/api/venue/notifications), а не из cross_cabinet_notifications:
          // без этой строки заведение не узнавало об ответе поддержки
          // (20.10.2026). Отдельно от ccn: сбой одного не отменяет другое.
          if (userRole === 'venue') {
            const notifId = `notif_ticket_reply_${crypto.randomUUID()}`;
            await upsertNotification(ticket.user_id, notifId, {
              id: notifId,
              userId: ticket.user_id,
              type: 'support',
              title: `Ответ поддержки: ${ticket.subject || 'обращение'}`.slice(0, 200),
              message: short,
              actionUrl: `/venue/support?ticket=${encodeURIComponent(ticketId)}`,
              link: `/venue/support?ticket=${encodeURIComponent(ticketId)}`,
              read: false,
              createdAt: new Date().toISOString(),
            }).catch((e: any) => console.error('[tickets] venue reply notification failed:', e?.message));
          }
          const { notifyCrossCabinet } = await import('./cross-cabinet-notify.tsx');
          await notifyCrossCabinet({
            targetUserId: ticket.user_id,
            targetRole: userRole,
            sourceRole: 'admin',
            type: 'support_ticket_new',
            title: `Ответ на тикет: ${ticket.subject || 'обращение'}`.slice(0, 200),
            message: short,
            link: `/profile?tab=support&ticket=${ticketId}`,
            metadata: { ticketId, replyFromAdmin: true },
          });
        } catch (bellErr) {
          console.error('[tickets] user-reply bell notify failed:', bellErr);
        }
      }
    }

    return c.json({
      success: true,
      data: messageData
    });
  } catch (error) {
    console.error('Error adding ticket message:', error);
    return c.json({
      success: false,
      error: 'Failed to add message'
    }, 500);
  }
});

// ============================================
// TICKET RATING
// ============================================

/**
 * POST /:ticketId/rate
 * Оценить решение тикета
 */
app.post('/:ticketId/rate', requireAuth, async (c) => {
  const ticketId = c.req.param('ticketId');

  try {
    const body = await c.req.json();
    const { rating, feedback } = body;

    if (!rating || rating < 1 || rating > 5) {
      return c.json({
        success: false,
        error: 'Invalid rating (must be 1-5)'
      }, 400);
    }

    // 2026-06-18 IDOR-closure: владелец тикета или admin. Ratings — это
    // user-feedback после resolution, чужой человек не должен ставить
    // оценку чужому тикету.
    const authUserId = c.get('userId');
    const authRole = c.get('userRole');

    // Atomic rating write — single UPDATE, owner-check встроен в WHERE.
    const upd = await pool.query(
      `UPDATE support_tickets SET
         rating     = $2,
         feedback   = $3,
         updated_at = NOW()
       WHERE id = $1 AND ($5::text = 'admin' OR user_id = $4)
       RETURNING id, user_id, subject, description, category, priority, status,
                 assigned_to, attachments, tags, messages, rating, feedback,
                 sla_due_date, resolved_at, closed_at, created_at, updated_at`,
      [ticketId, rating, feedback || null, authUserId, authRole]
    );
    if (upd.rowCount === 0) {
      return c.json({
        success: false,
        error: 'Ticket not found'
      }, 404);
    }

    return c.json({
      success: true,
      data: ticketForViewer(upd.rows[0], isStaff(authRole))
    });
  } catch (error) {
    console.error('Error rating ticket:', error);
    return c.json({
      success: false,
      error: 'Failed to rate ticket'
    }, 500);
  }
});

// ============================================
// STATS
// ============================================

/**
 * GET /stats/:userId
 * Получить статистику тикетов пользователя
 */
app.get('/stats/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  const authRole = c.get('userRole');
  if (userId !== authUserId && authRole !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }

  try {
    const tickets = await getTicketsByUser(userId);
    const validTickets = (tickets || []).filter(Boolean);

    if (validTickets.length === 0) {
      return c.json({
        success: true,
        data: {
          total: 0,
          open: 0,
          in_progress: 0,
          resolved: 0,
          closed: 0,
          avg_resolution_time: 0,
          by_category: {},
          by_priority: {},
          avg_rating: 0,
        }
      });
    }

    // Подсчёт статистики
    const stats = {
      total: validTickets.length,
      open: validTickets.filter((t: any) => t.status === 'open').length,
      in_progress: validTickets.filter((t: any) => t.status === 'in_progress').length,
      waiting_response: validTickets.filter((t: any) => t.status === 'waiting_response').length,
      resolved: validTickets.filter((t: any) => t.status === 'resolved').length,
      closed: validTickets.filter((t: any) => t.status === 'closed').length,

      by_category: {
        technical: validTickets.filter((t: any) => t.category === 'technical').length,
        billing: validTickets.filter((t: any) => t.category === 'billing').length,
        content: validTickets.filter((t: any) => t.category === 'content').length,
        account: validTickets.filter((t: any) => t.category === 'account').length,
        other: validTickets.filter((t: any) => t.category === 'other').length,
      },

      by_priority: {
        low: validTickets.filter((t: any) => t.priority === 'low').length,
        medium: validTickets.filter((t: any) => t.priority === 'medium').length,
        high: validTickets.filter((t: any) => t.priority === 'high').length,
        urgent: validTickets.filter((t: any) => t.priority === 'urgent').length,
      },

      avg_resolution_time: calculateAvgResolutionTime(validTickets),
      avg_rating: calculateAvgRating(validTickets),

      overdue: validTickets.filter((t: any) => {
        if (t.status === 'resolved' || t.status === 'closed') return false;
        return new Date(t.sla_due_date) < new Date();
      }).length,
    };

    return c.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error loading ticket stats:', error);
    return c.json({
      success: false,
      error: 'Failed to load stats'
    }, 500);
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function calculateSLADueDate(priority: string): string {
  const now = new Date();
  let hoursToAdd = 24; // default

  switch (priority) {
    case 'low':
      hoursToAdd = 72; // 3 days
      break;
    case 'medium':
      hoursToAdd = 48; // 2 days
      break;
    case 'high':
      hoursToAdd = 24; // 1 day
      break;
    case 'urgent':
      hoursToAdd = 4; // 4 hours
      break;
  }

  now.setHours(now.getHours() + hoursToAdd);
  return now.toISOString();
}

function calculateAvgResolutionTime(tickets: any[]): number {
  const resolvedTickets = tickets.filter((t: any) => t.resolved_at);

  if (resolvedTickets.length === 0) return 0;

  const totalTime = resolvedTickets.reduce((sum: number, ticket: any) => {
    const created = new Date(ticket.created_at).getTime();
    const resolved = new Date(ticket.resolved_at).getTime();
    return sum + (resolved - created);
  }, 0);

  // Возвращаем среднее время в часах
  return Math.round(totalTime / resolvedTickets.length / (1000 * 60 * 60));
}

function calculateAvgRating(tickets: any[]): number {
  const ratedTickets = tickets.filter((t: any) => t.rating);

  if (ratedTickets.length === 0) return 0;

  const totalRating = ratedTickets.reduce((sum: number, ticket: any) => {
    return sum + ticket.rating;
  }, 0);

  return parseFloat((totalRating / ratedTickets.length).toFixed(1));
}

// ============================================
// ADMIN ENDPOINTS
// ============================================

/**
 * GET /admin/all - Все тикеты для админки (без привязки к userId)
 */
app.get('/admin/all', requireAuth, requireAdmin, async (c) => {
  try {
    const statusFilter = c.req.query('status');
    const priorityFilter = c.req.query('priority');
    const categoryFilter = c.req.query('category');
    const search = c.req.query('search');

    // Native cols (migration 048) — push status/priority/category filters
    // into SQL; keep `search` in JS since it spans 6 fields incl. user_name
    // which is joined from users below.
    const whereClauses: string[] = [];
    const params: any[] = [];
    if (statusFilter && statusFilter !== 'all') {
      params.push(statusFilter);
      whereClauses.push(`status = $${params.length}`);
    }
    if (priorityFilter && priorityFilter !== 'all') {
      params.push(priorityFilter);
      whereClauses.push(`priority = $${params.length}`);
    }
    if (categoryFilter && categoryFilter !== 'all') {
      params.push(categoryFilter);
      whereClauses.push(`category = $${params.length}`);
    }
    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT id, user_id, subject, description, category, priority, status,
              assigned_to, attachments, tags, messages, rating, feedback,
              sla_due_date, resolved_at, closed_at, created_at, updated_at
         FROM support_tickets
         ${where}
         ORDER BY COALESCE(updated_at, created_at) DESC`,
      params
    );

    let tickets: any[] = rows;

    // Enrich tickets with user_name / user_email / user_avatar from users table
    // so the admin UI doesn't have to fall back to showing the raw user UUID.
    const userIds = Array.from(new Set(tickets.map((t: any) => t.user_id).filter(Boolean)));
    const usersById = new Map<string, { name: string | null; email: string | null; avatar: string | null }>();
    if (userIds.length > 0) {
      try {
        const { rows: userRows } = await pool.query(
          `SELECT id, email, full_name, display_name, avatar_url
             FROM users
            WHERE id = ANY($1::uuid[])`,
          [userIds],
        );
        for (const u of userRows) {
          usersById.set(u.id, {
            name: u.full_name || u.display_name || null,
            email: u.email || null,
            avatar: u.avatar_url || null,
          });
        }
      } catch (joinErr) {
        console.error('[tickets] admin/all user join failed:', joinErr);
      }
    }
    tickets = tickets.map((t: any) => {
      const u = usersById.get(t.user_id);
      return {
        ...t,
        user_name: u?.name || null,
        user_email: u?.email || null,
        user_avatar: u?.avatar || null,
      };
    });

    // `search` spans user_name/user_email (joined above), keep in JS.
    if (search) {
      const s = search.toLowerCase();
      tickets = tickets.filter((t: any) =>
        t.subject?.toLowerCase().includes(s) ||
        t.description?.toLowerCase().includes(s) ||
        t.id?.toLowerCase().includes(s) ||
        t.user_id?.toLowerCase().includes(s) ||
        t.user_name?.toLowerCase().includes(s) ||
        t.user_email?.toLowerCase().includes(s)
      );
    }

    return c.json({
      success: true,
      data: tickets,
      total: tickets.length
    });
  } catch (error) {
    console.error('Error loading all tickets for admin:', error);
    return c.json({
      success: true,
      data: [],
      total: 0
    });
  }
});

/**
 * GET /admin/stats - Общая статистика по всем тикетам для админки
 */
app.get('/admin/stats', requireAuth, requireAdmin, async (c) => {
  try {
    // Native cols (migration 048) — aggregate in SQL via conditional COUNTs.
    // EPOCH math gives avg resolution in hours; rating is plain AVG.
    const aggQuery = pool.query(
      `SELECT
         COUNT(*)                                                            AS total,
         COUNT(*) FILTER (WHERE status = 'open')                             AS open,
         COUNT(*) FILTER (WHERE status = 'in_progress')                      AS in_progress,
         COUNT(*) FILTER (WHERE status = 'waiting_response')                 AS waiting_response,
         COUNT(*) FILTER (WHERE status = 'resolved')                         AS resolved,
         COUNT(*) FILTER (WHERE status = 'closed')                           AS closed,
         COUNT(*) FILTER (WHERE priority = 'low')                            AS p_low,
         COUNT(*) FILTER (WHERE priority = 'medium')                         AS p_medium,
         COUNT(*) FILTER (WHERE priority = 'high')                           AS p_high,
         COUNT(*) FILTER (WHERE priority = 'urgent')                         AS p_urgent,
         COUNT(*) FILTER (
           WHERE status NOT IN ('resolved','closed')
             AND sla_due_date IS NOT NULL
             AND sla_due_date < NOW()
         )                                                                   AS overdue,
         COALESCE(
           AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0)
             FILTER (WHERE resolved_at IS NOT NULL),
           0
         )                                                                   AS avg_resolution_hours,
         COALESCE(AVG(rating::numeric) FILTER (WHERE rating IS NOT NULL), 0) AS avg_rating
       FROM support_tickets`
    );
    const catQuery = pool.query(
      `SELECT COALESCE(category, 'other') AS category, COUNT(*) AS n
         FROM support_tickets
        GROUP BY COALESCE(category, 'other')`
    );
    const [aggRes, catRes] = await Promise.all([aggQuery, catQuery]);
    const a = aggRes.rows[0] || {};

    const by_category: Record<string, number> = {};
    for (const r of catRes.rows) by_category[r.category] = Number(r.n);

    const stats = {
      total: Number(a.total || 0),
      open: Number(a.open || 0),
      in_progress: Number(a.in_progress || 0),
      waiting_response: Number(a.waiting_response || 0),
      resolved: Number(a.resolved || 0),
      closed: Number(a.closed || 0),
      by_priority: {
        low: Number(a.p_low || 0),
        medium: Number(a.p_medium || 0),
        high: Number(a.p_high || 0),
        urgent: Number(a.p_urgent || 0),
      },
      by_category,
      overdue: Number(a.overdue || 0),
      avg_resolution_time: Math.round(Number(a.avg_resolution_hours || 0)),
      avg_rating: parseFloat(Number(a.avg_rating || 0).toFixed(1)),
    };

    return c.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error loading admin ticket stats:', error);
    return c.json({ success: false, error: 'Failed to load admin stats' }, 500);
  }
});

export default app;
