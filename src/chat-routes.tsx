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
import { publishChatsStore, publishOrdersStore } from './db.tsx';
import { emitSSE } from './sse-routes.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { getDbClient } from './db-client.tsx';

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
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// GET /messages/:orderId
app.get('/messages/:orderId', requireAuth, async (c) => {
  const orderId = c.req.param('orderId');
  try {
    const messages: ChatMessage[] = (await publishChatsStore.get(orderId)) || [];
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

    const messages: ChatMessage[] = (await publishChatsStore.get(orderId)) || [];
    messages.push(message);
    await publishChatsStore.set(orderId, messages);

    // Определяем получателя для SSE
    // Ищем заказ чтобы узнать userId артиста
    const order: any = await publishOrdersStore.get(orderId);
    if (order) {
      const recipientId = senderRole === 'artist' ? 'admin-moderator' : order.userId;
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
    const messages: any[] = (await publishChatsStore.get(orderId)) || [];
    let updated = 0;
    for (const msg of messages) {
      if (msg.senderId !== userId && !msg.read) {
        msg.read = true;
        msg.readAt = new Date().toISOString();
        updated++;
      }
    }
    if (updated > 0) {
      await publishChatsStore.set(orderId, messages);
    }
    return c.json({ success: true, updated });
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

    for (const orderId of userOrderIds) {
      const messages: ChatMessage[] = (await publishChatsStore.get(orderId)) || [];
      const unread = messages.filter(m => !m.read && m.senderRole !== 'artist').length;
      if (unread > 0) {
        unreadByOrder[orderId] = unread;
        totalUnread += unread;
      }
    }

    return c.json({ success: true, totalUnread, unreadByOrder });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export default app;
