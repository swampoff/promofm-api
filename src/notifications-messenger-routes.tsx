/**
 * NOTIFICATIONS & MESSENGER ROUTES
 * Система уведомлений и мессенджера
 */

import { Hono } from 'hono';
import { requireAuth, requireOwner } from './auth-middleware.tsx';
import {
  upsertNotification,
  getNotification,
  deleteNotification,
  getNotificationsByUser,
} from './db.tsx';
import { pool } from './db-client.tsx';
import { emitSSE } from './sse-routes.tsx';

const app = new Hono();

/**
 * Чьё уведомление правим: пользователь сессии. Переданный user_id (тело или
 * query, как в старом клиенте) допустим только свой; админ может указать
 * любой. До 20.10.2026 user_id брался из запроса без проверки, но getNotification
 * искал не тот id и ничего не находил; после починки поиска без этой проверки
 * любой вошедший менял бы чужие уведомления. null = 403.
 */
function ownUserId(c: any, asked: unknown): string | null {
  const me = String(c.get('userId') || '');
  const role = c.get('userRole');
  const want = typeof asked === 'string' && asked.trim() ? asked.trim() : '';
  if (!want) return me || null;
  if (want === me || role === 'admin' || role === 'superadmin') return want;
  return null;
}

// ============================================
// NOTIFICATIONS
// ============================================

/**
 * GET /notifications/user/:userId
 * Получить все уведомления пользователя
 */
app.get('/user/:userId', requireAuth, requireOwner('userId'), async (c) => {
  const userId = c.req.param('userId');

  try {
    // getNotificationsByUser returns all notifications for user, already sorted desc
    const notifications = await getNotificationsByUser(userId);

    return c.json({
      success: true,
      data: notifications || []
    });
  } catch (error) {
    console.error('Error loading notifications:', error);
    return c.json({
      success: true,
      data: []
    });
  }
});

/**
 * POST /notifications/send
 * Создать и отправить уведомление
 */
app.post('/send', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const {
      user_id,
      type,
      message,
      title,
      link,
      metadata,
    } = body;

    if (!user_id || !type || !message) {
      return c.json({
        success: false,
        error: 'Missing required fields'
      }, 400);
    }

    const notificationId = `${crypto.randomUUID()}`;

    const notification = {
      id: notificationId,
      user_id,
      type,
      message,
      title: title || '',
      link: link || '',
      read: false,
      starred: false,
      archived: false,
      created_at: new Date().toISOString(),
      metadata: metadata || {},
    };

    // Сохраняем уведомление в notifications table
    await upsertNotification(user_id, notificationId, notification);

    // No need to maintain a separate ID list — getNotificationsByUser queries by user_id column

    // Emit SSE event for real-time delivery
    emitSSE(user_id, {
      type: 'notification',
      data: {
        notificationId,
        type,
        title: title || '',
        message,
        link: link || '',
        metadata: metadata || {},
        createdAt: notification.created_at,
      },
    });

    return c.json({
      success: true,
      data: notification
    });
  } catch (error) {
    console.error('Error creating notification:', error);
    return c.json({
      success: false,
      error: 'Failed to create notification'
    }, 500);
  }
});

/**
 * PUT /notifications/:notificationId/read
 * Отметить уведомление как прочитанное
 */
app.put('/:notificationId/read', requireAuth, async (c) => {
  const notificationId = c.req.param('notificationId');

  try {
    // We need the userId to look up the notification.
    // Try to get it from query param or body.
    const body = await c.req.json().catch(() => ({}));
    const userId = ownUserId(c, body.user_id || c.req.query('user_id'));
    if (!userId) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const notification = await getNotification(userId, notificationId);

    if (!notification) {
      return c.json({
        success: false,
        error: 'Notification not found'
      }, 404);
    }

    notification.read = true;
    await upsertNotification(userId, notificationId, notification);

    return c.json({
      success: true,
      data: notification
    });
  } catch (error) {
    console.error('Error marking as read:', error);
    return c.json({
      success: false,
      error: 'Failed to mark as read'
    }, 500);
  }
});

/**
 * PUT /notifications/:notificationId/star
 * Переключить избранное
 */
app.put('/:notificationId/star', requireAuth, async (c) => {
  const notificationId = c.req.param('notificationId');

  try {
    const body = await c.req.json();
    const { starred } = body;
    const user_id = ownUserId(c, body.user_id);
    if (!user_id) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const notification = await getNotification(user_id, notificationId);

    if (!notification) {
      return c.json({
        success: false,
        error: 'Notification not found'
      }, 404);
    }

    notification.starred = starred;
    await upsertNotification(user_id, notificationId, notification);

    return c.json({
      success: true,
      data: notification
    });
  } catch (error) {
    console.error('Error toggling star:', error);
    return c.json({
      success: false,
      error: 'Failed to toggle star'
    }, 500);
  }
});

/**
 * DELETE /notifications/:notificationId
 * Удалить уведомление
 */
app.delete('/:notificationId', requireAuth, async (c) => {
  const notificationId = c.req.param('notificationId');

  try {
    const userId = ownUserId(c, c.req.query('user_id'));
    if (!userId) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    const notification = await getNotification(userId, notificationId);

    if (!notification) {
      return c.json({
        success: false,
        error: 'Notification not found'
      }, 404);
    }

    // Удаляем уведомление из notifications
    await deleteNotification(userId, notificationId);

    // No need to maintain a separate ID list — getNotificationsByUser queries by user_id column

    return c.json({
      success: true
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    return c.json({
      success: false,
      error: 'Failed to delete notification'
    }, 500);
  }
});

// ============================================
// MESSENGER
// ============================================

/**
 * GET /messenger/conversations/:userId — все разговоры (SQL)
 */
app.get('/conversations/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  try {
    const r = await pool.query(
      `SELECT c.id, c.participant_ids, c.last_message_text, c.last_message_at, c.data, c.created_at,
              COALESCE(u.unread_count, 0) as unread_count
       FROM dm_conversations c
       LEFT JOIN dm_unread u ON u.conversation_id = c.id AND u.user_id = $1
       WHERE $1 = ANY(c.participant_ids)
       ORDER BY c.last_message_at DESC NULLS LAST`,
      [userId]
    );
    const data = r.rows.map((row: any) => ({
      id: row.id,
      participants: row.participant_ids || [],
      subject: row.data?.subject || '',
      type: row.data?.type || 'user',
      last_message: row.last_message_text || '',
      last_message_at: row.last_message_at,
      unread_count: parseInt(row.unread_count) || 0,
      created_at: row.created_at,
    }));
    return c.json({ success: true, data });
  } catch (error) {
    console.error('Error loading conversations:', error);
    return c.json({ success: true, data: [] });
  }
});

/**
 * POST /messenger/conversation/create — создать разговор (SQL)
 */
app.post('/conversation/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { participants, subject, type } = body;
    if (!participants || participants.length < 2 || !subject) {
      return c.json({ success: false, error: 'Missing required fields' }, 400);
    }
    const conversationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const dataJson = JSON.stringify({ subject, type: type || 'user' });
    await pool.query(
      `INSERT INTO dm_conversations (id, participant_ids, last_message_text, last_message_at, data, created_at)
       VALUES ($1, $2, '', $3, $4::jsonb, $3)`,
      [conversationId, participants, now, dataJson]
    );
    return c.json({
      success: true,
      data: {
        id: conversationId, participants, subject,
        type: type || 'user',
        last_message: '', last_message_at: now,
        unread_count: 0, created_at: now,
      },
    });
  } catch (error) {
    console.error('Error creating conversation:', error);
    return c.json({ success: false, error: 'Failed to create conversation' }, 500);
  }
});

/**
 * GET /messenger/messages/:conversationId — сообщения (SQL)
 */
app.get('/messages/:conversationId', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  try {
    const r = await pool.query(
      `SELECT id, conversation_id, sender_id, content, message_type, is_read, read_at, created_at
       FROM dm_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId]
    );
    const data = r.rows.map((m: any) => ({
      id: m.id,
      conversation_id: m.conversation_id,
      from_user_id: m.sender_id,
      message: m.content,
      read: m.is_read,
      created_at: m.created_at,
      metadata: {},
    }));
    return c.json({ success: true, data });
  } catch (error) {
    console.error('Error loading messages:', error);
    return c.json({ success: true, data: [] });
  }
});

/**
 * POST /messenger-send — отправить сообщение (SQL + SSE + notification)
 */
app.post('/messenger-send', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { conversation_id, from_user_id, message, metadata } = body;
    if (!conversation_id || !from_user_id || !message) {
      return c.json({ success: false, error: 'Missing required fields' }, 400);
    }

    // Insert message
    const ins = await pool.query(
      `INSERT INTO dm_messages (conversation_id, sender_id, content, message_type, is_read, created_at)
       VALUES ($1, $2, $3, 'text', false, NOW())
       RETURNING id, created_at`,
      [conversation_id, from_user_id, message]
    );
    const messageId = ins.rows[0].id;
    const createdAt = ins.rows[0].created_at;

    // Update conversation
    const convRes = await pool.query(
      `UPDATE dm_conversations
       SET last_message_text = $1, last_message_at = $2
       WHERE id = $3 RETURNING participant_ids, data`,
      [message.length > 500 ? message.slice(0, 500) : message, createdAt, conversation_id]
    );
    if (convRes.rows.length === 0) {
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    }
    const participantIds: string[] = convRes.rows[0].participant_ids || [];
    const convType = convRes.rows[0].data?.type || 'user';
    const convSubject = convRes.rows[0].data?.subject || '';

    // Bump unread + notify each recipient
    const recipients = participantIds.filter((id: string) => id !== from_user_id);
    const senderName = metadata?.sender_name || 'Новое сообщение';

    for (const recipientId of recipients) {
      await pool.query(
        `INSERT INTO dm_unread (user_id, conversation_id, unread_count, updated_at)
         VALUES ($1, $2, 1, NOW())
         ON CONFLICT (user_id, conversation_id) DO UPDATE SET
           unread_count = dm_unread.unread_count + 1, updated_at = NOW()`,
        [recipientId, conversation_id]
      );

      const notifId = crypto.randomUUID();
      try {
        await upsertNotification(recipientId, notifId, {
          id: notifId, user_id: recipientId,
          type: 'new_message',
          title: senderName,
          message: message.length > 100 ? message.slice(0, 100) + '...' : message,
          link: `/notifications?tab=messenger&conversation=${conversation_id}`,
          read: false, starred: false, archived: false,
          created_at: new Date().toISOString(),
          metadata: {
            conversation_id, sender_id: from_user_id, message_id: messageId,
            conversation_type: convType, conversation_subject: convSubject,
          },
        });
      } catch {}

      try {
        emitSSE(recipientId, {
          type: 'new_direct_message',
          data: {
            conversationId: conversation_id,
            senderId: from_user_id,
            senderName: metadata?.sender_name || '',
            senderRole: metadata?.sender_role || '',
            text: message.length > 200 ? message.slice(0, 200) + '...' : message,
            messageId,
            conversationType: convType,
            source: convType === 'support' ? 'support' : 'direct',
          },
        });
      } catch {}
    }

    return c.json({
      success: true,
      data: {
        id: messageId,
        conversation_id, from_user_id, message,
        read: false, created_at: createdAt,
        metadata: metadata || {},
      },
    });
  } catch (error) {
    console.error('Error sending message:', error);
    return c.json({ success: false, error: 'Failed to send message' }, 500);
  }
});

/**
 * PUT /messenger/conversations/:conversationId/read — пометить прочитанным (SQL)
 */
app.put('/conversations/:conversationId/read', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  const userId = c.get('userId');
  try {
    const conv = await pool.query(
      `SELECT id, participant_ids, last_message_text, last_message_at, data
       FROM dm_conversations WHERE id = $1`,
      [conversationId]
    );
    if (conv.rows.length === 0) {
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    }

    await pool.query(
      `UPDATE dm_messages SET is_read = true, read_at = NOW()
       WHERE conversation_id = $1 AND sender_id != $2 AND is_read = false`,
      [conversationId, userId]
    );
    await pool.query(
      `UPDATE dm_unread SET unread_count = 0, updated_at = NOW()
       WHERE user_id = $1 AND conversation_id = $2`,
      [userId, conversationId]
    );

    const r = conv.rows[0];
    return c.json({
      success: true,
      data: {
        id: r.id,
        participants: r.participant_ids || [],
        last_message: r.last_message_text || '',
        last_message_at: r.last_message_at,
        unread_count: 0,
      },
    });
  } catch (error) {
    console.error('Error marking conversation as read:', error);
    return c.json({ success: false, error: 'Failed' }, 500);
  }
});

export default app;
