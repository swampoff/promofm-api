/**
 * MESSAGING ROUTES - Единая система личных сообщений для всех кабинетов
 * 
 * Правила коммуникации:
 * - Radio может общаться ТОЛЬКО с platform (admin) и venue
 * - Все остальные кабинеты могут общаться друг с другом
 * 
 * KV Keys:
 *   dm:conv:{conversationId}      -> DirectConversation
 *   dm:convlist:{userId}          -> string[] (conversationIds)
 *   dm:messages:{conversationId}  -> DirectMessage[]
 *   dm:unread:{userId}            -> Record<conversationId, number>
 * 
 * Endpoints:
 * GET    /conversations/:userId              - Список переписок
 * POST   /conversations                      - Создать/найти переписку
 * GET    /messages/:conversationId            - Сообщения
 * POST   /messages/:conversationId            - Отправить сообщение (+SSE)
 * PUT    /messages/:conversationId/read       - Отметить прочитанными
 * GET    /unread/:userId                      - Счётчик непрочитанных
 */

import { Hono } from 'hono';
import { dmConvListStore, dmConversationsStore, dmMessagesStore, dmUnreadCountsStore } from './db.tsx';
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

// ── Types ──

type CabinetRole = 'artist' | 'producer' | 'dj' | 'admin' | 'radio' | 'venue';

interface Participant {
  userId: string;
  userName: string;
  role: CabinetRole;
  avatar?: string;
}

interface DirectConversation {
  id: string;
  participants: Participant[];
  source: 'direct' | 'collab' | 'support';
  collabOfferId?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  createdAt: string;
}

interface DirectMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderRole: CabinetRole;
  text: string;
  attachment?: { type: string; name: string; url?: string };
  createdAt: string;
}

// ── Communication Rules ──

const ALLOWED_CONTACTS: Record<CabinetRole, CabinetRole[]> = {
  artist:   ['producer', 'dj', 'admin', 'venue'],
  producer: ['artist', 'dj', 'admin', 'venue'],
  dj:       ['artist', 'producer', 'admin', 'venue'],
  admin:    ['artist', 'producer', 'dj', 'radio', 'venue'],
  radio:    ['admin', 'venue'],
  venue:    ['artist', 'producer', 'dj', 'admin', 'radio'],
};

function canCommunicate(roleA: CabinetRole, roleB: CabinetRole): boolean {
  return ALLOWED_CONTACTS[roleA]?.includes(roleB) ?? false;
}

// ── Helpers ──

function genId(): string {
  return `dm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeConvId(userA: string, userB: string): string {
  return [userA, userB].sort().join('::');
}

const ROLE_LABELS: Record<CabinetRole, string> = {
  artist: 'Артист',
  producer: 'Продюсер',
  dj: 'DJ',
  admin: 'Платформа',
  radio: 'Радио',
  venue: 'Заведение',
};

// ── GET /conversations/:userId ──

app.get('/conversations/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  if (authUserId !== userId) {
    return c.json({ success: false, error: 'Access denied: not resource owner' }, 403);
  }
  try {
    const convIds: string[] = (await dmConvListStore.get(userId)) || [];
    const conversations: DirectConversation[] = [];

    for (const cid of convIds) {
      const conv: DirectConversation | null = await dmConversationsStore.get(cid);
      if (conv) conversations.push(conv);
    }

    // Сортировка: последнее сообщение сверху
    conversations.sort((a, b) => {
      const ta = a.lastMessageAt || a.createdAt;
      const tb = b.lastMessageAt || b.createdAt;
      return tb.localeCompare(ta);
    });

    // Непрочитанные
    const unreadMap: Record<string, number> = (await dmUnreadCountsStore.get(userId)) || {};

    return c.json({
      success: true,
      conversations: conversations.map(conv => ({
        ...conv,
        unreadCount: unreadMap[conv.id] || 0,
      })),
    });
  } catch (err) {
    console.log('Error fetching conversations:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── POST /conversations ──

app.post('/conversations', requireAuth, async (c) => {
  try {
    const { participants, source, collabOfferId } = await c.req.json() as {
      participants: Participant[];
      source?: 'direct' | 'collab' | 'support';
      collabOfferId?: string;
    };

    if (!participants || participants.length < 2) {
      return c.json({ success: false, error: 'At least 2 participants required' }, 400);
    }

    // Verify auth user is one of the participants (the initiator)
    const authUserId = c.get('userId');
    const isParticipant = participants.some(p => p.userId === authUserId);
    if (!isParticipant) {
      return c.json({ success: false, error: 'Access denied: you must be a participant' }, 403);
    }

    // Enforce communication rules
    const p1 = participants[0];
    const p2 = participants[1];
    if (!canCommunicate(p1.role, p2.role)) {
      const label1 = ROLE_LABELS[p1.role] || p1.role;
      const label2 = ROLE_LABELS[p2.role] || p2.role;
      return c.json({
        success: false,
        error: `${label1} не может отправлять сообщения роли ${label2}`,
        code: 'COMMUNICATION_RESTRICTED',
      }, 403);
    }

    // Check if conversation already exists
    const convId = makeConvId(p1.userId, p2.userId);
    const existing: DirectConversation | null = await dmConversationsStore.get(convId);

    if (existing) {
      return c.json({ success: true, conversation: existing, created: false });
    }

    // Create new conversation
    const conv: DirectConversation = {
      id: convId,
      participants,
      source: source || 'direct',
      collabOfferId,
      createdAt: new Date().toISOString(),
    };

    await dmConversationsStore.set(convId, conv);

    // Add to both users' conversation lists
    for (const p of participants) {
      const list: string[] = (await dmConvListStore.get(p.userId)) || [];
      if (!list.includes(convId)) {
        list.unshift(convId);
        await dmConvListStore.set(p.userId, list);
      }
    }

    return c.json({ success: true, conversation: conv, created: true });
  } catch (err) {
    console.log('Error creating conversation:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /messages/:conversationId ──

app.get('/messages/:conversationId', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  const authUserId = c.get('userId');
  try {
    // Verify auth user is a participant of this conversation
    const conv: DirectConversation | null = await dmConversationsStore.get(conversationId);
    if (!conv) {
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    }
    if (!conv.participants.some(p => p.userId === authUserId)) {
      return c.json({ success: false, error: 'Access denied: not a participant' }, 403);
    }

    const messages: DirectMessage[] = (await dmMessagesStore.get(conversationId)) || [];
    return c.json({ success: true, messages });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── POST /messages/:conversationId ──

app.post('/messages/:conversationId', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  try {
    const { senderId, senderName, senderRole, text, attachment } = await c.req.json() as {
      senderId: string;
      senderName: string;
      senderRole: CabinetRole;
      text: string;
      attachment?: { type: string; name: string; url?: string };
    };

    if (!senderId || !text) {
      return c.json({ success: false, error: 'senderId and text required' }, 400);
    }

    // Prevent spoofing: senderId must match authenticated user
    const authUserId = c.get('userId');
    if (authUserId !== senderId) {
      return c.json({ success: false, error: 'Access denied: senderId does not match authenticated user' }, 403);
    }

    // Verify conversation exists
    const conv: DirectConversation | null = await dmConversationsStore.get(conversationId);
    if (!conv) {
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    }

    // Verify sender is a participant
    const senderParticipant = conv.participants.find(p => p.userId === senderId);
    if (!senderParticipant) {
      return c.json({ success: false, error: 'Sender is not a participant' }, 403);
    }

    const message: DirectMessage = {
      id: genId(),
      conversationId,
      senderId,
      senderName: senderName || senderParticipant.userName,
      senderRole: senderRole || senderParticipant.role,
      text,
      attachment,
      createdAt: new Date().toISOString(),
    };

    // Save message
    const messages: DirectMessage[] = (await dmMessagesStore.get(conversationId)) || [];
    messages.push(message);
    // Keep last 200 messages per conversation
    if (messages.length > 200) messages.splice(0, messages.length - 200);
    await dmMessagesStore.set(conversationId, messages);

    // Update conversation's lastMessage
    conv.lastMessage = text.length > 100 ? text.slice(0, 100) + '...' : text;
    conv.lastMessageAt = message.createdAt;
    await dmConversationsStore.set(conversationId, conv);

    // Update unread count for recipient(s)
    for (const p of conv.participants) {
      if (p.userId === senderId) continue;

      const unreadMap: Record<string, number> = (await dmUnreadCountsStore.get(p.userId)) || {};
      unreadMap[conversationId] = (unreadMap[conversationId] || 0) + 1;
      await dmUnreadCountsStore.set(p.userId, unreadMap);

      // SSE notification to recipient
      emitSSE(p.userId, {
        type: 'new_direct_message',
        data: {
          conversationId,
          messageId: message.id,
          senderId,
          senderName: message.senderName,
          senderRole: message.senderRole,
          text: text.length > 80 ? text.slice(0, 80) + '...' : text,
          source: conv.source,
          collabOfferId: conv.collabOfferId,
        },
      });
    }

    return c.json({ success: true, message });
  } catch (err) {
    console.log('Error sending message:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── PUT /messages/:conversationId/read ──

app.put('/messages/:conversationId/read', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  try {
    const { userId } = await c.req.json() as { userId: string };
    if (!userId) {
      return c.json({ success: false, error: 'userId required' }, 400);
    }

    // Verify auth user matches the reader
    const authUserId = c.get('userId');
    if (authUserId !== userId) {
      return c.json({ success: false, error: 'Access denied: cannot mark read for another user' }, 403);
    }

    const unreadMap: Record<string, number> = (await dmUnreadCountsStore.get(userId)) || {};
    delete unreadMap[conversationId];
    await dmUnreadCountsStore.set(userId, unreadMap);

    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /unread/:userId ──

app.get('/unread/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  if (authUserId !== userId) {
    return c.json({ success: false, error: 'Access denied: not resource owner' }, 403);
  }
  try {
    const unreadMap: Record<string, number> = (await dmUnreadCountsStore.get(userId)) || {};
    const total = Object.values(unreadMap).reduce((s, n) => s + n, 0);
    return c.json({ success: true, total, byConversation: unreadMap });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ── GET /rules - Communication rules (for UI) ──

app.get('/rules', (c) => {
  return c.json({
    success: true,
    rules: ALLOWED_CONTACTS,
    labels: ROLE_LABELS,
    description: 'Правила коммуникации между кабинетами',
  });
});


// ── POST /presence - Online presence heartbeat ──
app.post('/presence', requireAuth, async (c) => {
  return c.json({ success: true });
});

export default app;
