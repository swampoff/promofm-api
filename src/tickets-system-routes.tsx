/**
 * TICKETS SYSTEM ROUTES
 * Система тикетов поддержки
 *
 * Uses support_tickets table via db.tsx functions + PostgreSQL queries.
 * Messages are stored as an array inside ticket.data.messages.
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { getTicketsByUser, upsertTicket } from './db.tsx';
import { getDbClient } from './db-client.tsx';

const app = new Hono();

const supaDb = () => getDbClient();

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

    const sorted = (tickets || [])
      .filter(Boolean)
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
    const { data: row, error } = await supaDb()
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .maybeSingle();

    if (error) console.error('[tickets] get ticket error:', error);

    const ticket = row ? (row.data ?? row) : null;

    if (!ticket) {
      return c.json({
        success: false,
        error: 'Ticket not found'
      }, 404);
    }

    return c.json({
      success: true,
      data: ticket
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
      priority,
      attachments,
    } = body;

    if (!subject || !description || !category) {
      return c.json({
        success: false,
        error: 'Missing required fields'
      }, 400);
    }

    const ticketId = `TKT-${crypto.randomUUID()}`;

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

    // Save ticket with user_id as a top-level column for getTicketsByUser queries
    const { error } = await supaDb()
      .from('support_tickets')
      .upsert({
        id: ticketId,
        user_id,
        data: ticket,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) console.error('[tickets] create ticket error:', error);

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

    // Fetch existing ticket
    const { data: row, error: fetchErr } = await supaDb()
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .maybeSingle();

    if (fetchErr) console.error('[tickets] fetch for update error:', fetchErr);

    const ticket = row ? (row.data ?? row) : null;

    if (!ticket) {
      return c.json({
        success: false,
        error: 'Ticket not found'
      }, 404);
    }

    const updatedTicket = {
      ...ticket,
      ...body,
      updated_at: new Date().toISOString(),
    };

    // Preserve messages array if body doesn't include it
    if (!body.messages && ticket.messages) {
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
      data: updatedTicket
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
    // Fetch ticket to verify it exists
    const { data: row, error: fetchErr } = await supaDb()
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .maybeSingle();

    if (fetchErr) console.error('[tickets] fetch for delete error:', fetchErr);

    const ticket = row ? (row.data ?? row) : null;

    if (!ticket) {
      return c.json({
        success: false,
        error: 'Ticket not found'
      }, 404);
    }

    // Delete ticket from support_tickets table
    const { error: delErr } = await supaDb()
      .from('support_tickets')
      .delete()
      .eq('id', ticketId);

    if (delErr) console.error('[tickets] delete ticket error:', delErr);

    // Messages are stored inside ticket.data.messages — deleted along with the row

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
    const { data: row, error } = await supaDb()
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .maybeSingle();

    if (error) console.error('[tickets] get messages error:', error);

    const ticket = row ? (row.data ?? row) : null;
    const messages = (ticket?.messages || [])
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

    // Fetch existing ticket
    const { data: row, error: fetchErr } = await supaDb()
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .maybeSingle();

    if (fetchErr) console.error('[tickets] fetch for add message error:', fetchErr);

    const ticket = row ? (row.data ?? row) : null;

    if (!ticket) {
      return c.json({
        success: false,
        error: 'Ticket not found'
      }, 404);
    }

    const messageId = `msg-${crypto.randomUUID()}`;

    const messageData = {
      id: messageId,
      ticket_id: ticketId,
      sender_id,
      sender_type,
      message,
      attachments: attachments || [],
      internal_note: internal_note || false,
      created_at: new Date().toISOString(),
    };

    // Append message to ticket's messages array
    const messages = ticket.messages || [];
    messages.push(messageData);

    // Update ticket
    ticket.messages = messages;
    ticket.updated_at = new Date().toISOString();

    // Если ответ от поддержки и тикет в статусе waiting_response
    if (sender_type === 'support' || sender_type === 'admin') {
      if (ticket.status === 'waiting_response') {
        ticket.status = 'in_progress';
      }
    }

    await upsertTicket(ticketId, ticket);

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

    const { data: row, error: fetchErr } = await supaDb()
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .maybeSingle();

    if (fetchErr) console.error('[tickets] fetch for rate error:', fetchErr);

    const ticket = row ? (row.data ?? row) : null;

    if (!ticket) {
      return c.json({
        success: false,
        error: 'Ticket not found'
      }, 404);
    }

    ticket.rating = rating;
    ticket.feedback = feedback || null;
    ticket.rated_at = new Date().toISOString();

    await upsertTicket(ticketId, ticket);

    return c.json({
      success: true,
      data: ticket
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

    // Fetch all tickets from support_tickets table
    const { data: rows, error } = await supaDb()
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) console.error('[tickets] admin/all error:', error);

    let tickets = (rows || [])
      .map((r: any) => r.data ?? r)
      .filter(Boolean);

    // Фильтрация
    if (statusFilter && statusFilter !== 'all') {
      tickets = tickets.filter((t: any) => t.status === statusFilter);
    }
    if (priorityFilter && priorityFilter !== 'all') {
      tickets = tickets.filter((t: any) => t.priority === priorityFilter);
    }
    if (categoryFilter && categoryFilter !== 'all') {
      tickets = tickets.filter((t: any) => t.category === categoryFilter);
    }
    if (search) {
      const s = search.toLowerCase();
      tickets = tickets.filter((t: any) =>
        t.subject?.toLowerCase().includes(s) ||
        t.description?.toLowerCase().includes(s) ||
        t.id?.toLowerCase().includes(s) ||
        t.user_id?.toLowerCase().includes(s)
      );
    }

    // Сортировка: сначала новые
    tickets.sort((a: any, b: any) =>
      new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime()
    );

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
    // Fetch all tickets from support_tickets table
    const { data: rows, error } = await supaDb()
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) console.error('[tickets] admin/stats error:', error);

    const tickets = (rows || [])
      .map((r: any) => r.data ?? r)
      .filter(Boolean);

    const stats = {
      total: tickets.length,
      open: tickets.filter((t: any) => t.status === 'open').length,
      in_progress: tickets.filter((t: any) => t.status === 'in_progress').length,
      waiting_response: tickets.filter((t: any) => t.status === 'waiting_response').length,
      resolved: tickets.filter((t: any) => t.status === 'resolved').length,
      closed: tickets.filter((t: any) => t.status === 'closed').length,
      by_priority: {
        low: tickets.filter((t: any) => t.priority === 'low').length,
        medium: tickets.filter((t: any) => t.priority === 'medium').length,
        high: tickets.filter((t: any) => t.priority === 'high').length,
        urgent: tickets.filter((t: any) => t.priority === 'urgent').length,
      },
      by_category: {} as Record<string, number>,
      overdue: tickets.filter((t: any) => {
        if (t.status === 'resolved' || t.status === 'closed') return false;
        return t.sla_due_date && new Date(t.sla_due_date) < new Date();
      }).length,
      avg_resolution_time: calculateAvgResolutionTime(tickets),
      avg_rating: calculateAvgRating(tickets),
    };

    // Category breakdown
    for (const t of tickets) {
      const cat = t.category || 'other';
      stats.by_category[cat] = (stats.by_category[cat] || 0) + 1;
    }

    return c.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error loading admin ticket stats:', error);
    return c.json({ success: false, error: 'Failed to load admin stats' }, 500);
  }
});

export default app;
