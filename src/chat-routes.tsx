/**
 * CHAT ROUTES - In-app чат артист-модератор по заказам публикации
 * 
 * KV Keys:
 *   publish_chat:{orderId} -> ChatMessage[]
 * 
 * Endpoints:
 * GET  /messages/:orderId       - Получить сообщения чата
 * POST /messages/:orderId       - Отправить сообщение
 * GET  /unread/:userId          - Непрочитанные по всем заказам
 */

import { Hono } from 'hono';
import { publishOrdersStore } from './db.tsx';
import { emitSSE } from './sse-routes.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { getDbClient, pool } from './db-client.tsx';

// ── Auth Helper ──

async function getAuthUser(c: any) {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await getDbClient().auth.getUser(token);
  return error ? null : user;
}

const app = new Hono();

interface ChatMessage {
  id: string;
  orderId: string;
  senderId: string;
  senderName: string;
  senderRole: 'artist' | 'moderator';
  text: string;
  attachment?: { type: string; name: string; url?: string };
  read: boolean;
  createdAt: string;
}

function genId(): string {
  return `chat-${crypto.randomUUID()}`;
}

// GET /messages/:orderId
app.get('/messages/:orderId', requireAuth, async (c) => {
  const orderId = c.req.param('orderId');
  try {
    const r = await pool.query(
      `SELECT app_id, order_id, sender_id, sender_name, sender_role,
              body, attachment, is_read, created_at
         FROM publish_chats
        WHERE order_id = $1
        ORDER BY created_at ASC`,
      [orderId]
    );
    const messages: ChatMessage[] = r.rows.map((row: any) => ({
      id: row.app_id,
      orderId: row.order_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderRole: row.sender_role as 'artist' | 'moderator',
      text: row.body,
      attachment: row.attachment || undefined,
      read: row.is_read,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
    return c.json({ success: true, messages });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// POST /messages/:orderId
app.post('/messages/:orderId', requireAuth, async (c) => {
  const orderId = c.req.param('orderId');
  try {
    const { senderId, senderName, senderRole, text, attachment } = await c.req.json();
    if (!senderId || !text) {
      return c.json({ success: false, error: 'senderId and text required' }, 400);
    }

    // Prevent spoofing: senderId must match authenticated user
    const authUserId = c.get('userId');
    if (authUserId !== senderId) {
      return c.json({ success: false, error: 'Access denied: senderId does not match authenticated user' }, 403);
    }

    const message: ChatMessage = {
      id: genId(),
      orderId,
      senderId,
      senderName: senderName || (senderRole === 'moderator' ? 'Модератор' : 'Артист'),
      senderRole: senderRole || 'artist',
      text,
      attachment,
      read: false,
      createdAt: new Date().toISOString(),
    };

    // row-per-message (migration 038): INSERT без race conditions.
    await pool.query(
      `INSERT INTO publish_chats
         (app_id, order_id, sender_id, sender_name, sender_role,
          body, attachment, is_read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, FALSE, $8)
       ON CONFLICT (order_id, app_id) DO NOTHING`,
      [
        message.id, orderId, senderId, message.senderName, message.senderRole,
        text, attachment ? JSON.stringify(attachment) : null, message.createdAt,
      ]
    );

    // Определяем получателя для SSE
    // Ищем заказ чтобы узнать userId артиста
    const order: any = await publishOrdersStore.get(orderId);
    if (order) {
      // 'admin' is the shared broadcast channel all admin UIs subscribe to.
      // Previous 'admin-moderator' was a phantom channel — no one listened to
      // it, so artist-side chat messages never reached moderators in realtime.
      const recipientId = senderRole === 'artist' ? 'admin' : order.userId;
      emitSSE(recipientId, {
        type: 'chat_message',
        data: {
          orderId,
          senderName: message.senderName,
          senderRole,
          text: text.length > 80 ? text.slice(0, 80) + '...' : text,
          message: `Новое сообщение по заказу "${order.title || orderId}"`,
        },
      });
    }

    return c.json({ success: true, message });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /unread/:userId

// -- Mark chat messages as read --
app.put('/messages/:orderId/read', requireAuth, async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const userId = c.get('userId');
    // Помечаем как прочитанные все сообщения в заказе, написанные
    // другим пользователем (свои сообщения остаются is_read=false
    // относительно отправителя — это не его задача отмечать).
    const r = await pool.query(
      `UPDATE publish_chats
          SET is_read = TRUE, read_at = NOW()
        WHERE order_id = $1 AND sender_id != $2 AND is_read = FALSE`,
      [orderId, userId]
    );
    return c.json({ success: true, updated: r.rowCount ?? 0 });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// -- Typing indicator (fire-and-forget) --
app.post('/typing/:orderId', requireAuth, async (c) => {
  return c.json({ success: true });
});

app.get('/unread/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  if (authUserId !== userId) {
    return c.json({ success: false, error: 'Access denied: not resource owner' }, 403);
  }
  try {
    // Получаем все заказы пользователя
    const allOrders = await publishOrdersStore.getAll();
    const userOrderIds: string[] = [];
    
    for (const order of allOrders) {
      if (order && typeof order === 'object' && (order as any).userId === userId) {
        userOrderIds.push((order as any).id);
      }
    }

    let totalUnread = 0;
    const unreadByOrder: Record<string, number> = {};

    if (userOrderIds.length > 0) {
      // Один SELECT вместо N round-trip'ов. Считаем только сообщения
      // от модератора (артисту неинтересны свои unread'ы у себя).
      const r = await pool.query(
        `SELECT order_id, COUNT(*)::int AS n
           FROM publish_chats
          WHERE order_id = ANY($1::text[])
            AND is_read = FALSE
            AND sender_role != 'artist'
          GROUP BY order_id`,
        [userOrderIds]
      );
      for (const row of r.rows) {
        unreadByOrder[row.order_id] = row.n;
        totalUnread += row.n;
      }
    }

    return c.json({ success: true, totalUnread, unreadByOrder });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export default app;
