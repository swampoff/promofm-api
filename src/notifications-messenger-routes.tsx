/**
 * NOTIFICATIONS & MESSENGER ROUTES
 * Система уведомлений и мессенджера
 */

import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';
import {
  upsertNotification,
  getNotification,
  deleteNotification,
  getNotificationsByUser,
  dmConversationsStore,
  dmConvListStore,
  dmMessagesStore,
  dmUnreadCountsStore,
} from './db.tsx';
import { emitSSE } from './sse-routes.tsx';

const app = new Hono();

// ============================================
// NOTIFICATIONS
// ============================================

/**
 * GET /notifications/user/:userId
 * Получить все уведомления пользователя
 */
app.get('/user/:userId', requireAuth, async (c) => {
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
    const userId = body.user_id || c.req.query('user_id') || '';

    // If userId provided, do a direct lookup; otherwise search all notifications is not feasible.
    // The notification object itself contains user_id, so we need at least one lookup strategy.
    // Since the old code used notificationId as the full key, and getNotification needs userId,
    // we require user_id to be passed.
    if (!userId) {
      return c.json({
        success: false,
        error: 'user_id is required'
      }, 400);
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
    const { starred, user_id } = body;

    if (!user_id) {
      return c.json({
        success: false,
        error: 'user_id is required'
      }, 400);
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
    const userId = c.req.query('user_id') || '';

    if (!userId) {
      return c.json({
        success: false,
        error: 'user_id query param is required'
      }, 400);
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
 * GET /messenger/conversations/:userId
 * Получить все разговоры пользователя
 */
app.get('/conversations/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');

  try {
    // Get the list of conversation IDs for this user
    const conversationIds = await dmConvListStore.get(userId) || [];

    if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
      return c.json({ success: true, data: [] });
    }

    // Fetch each conversation by ID
    const conversations = await Promise.all(
      conversationIds.map((id: string) => dmConversationsStore.get(id))
    );

    const validConversations = conversations
      .filter(Boolean)
      .sort((a: any, b: any) =>
        new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
      );

    return c.json({
      success: true,
      data: validConversations
    });
  } catch (error) {
    console.error('Error loading conversations:', error);
    return c.json({
      success: true,
      data: []
    });
  }
});

/**
 * POST /messenger/conversation/create
 * Создать новый разговор
 */
app.post('/conversation/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const {
      participants, // array of user IDs
      subject,
      type, // 'support' | 'moderation' | 'admin' | 'user'
    } = body;

    if (!participants || participants.length < 2 || !subject) {
      return c.json({
        success: false,
        error: 'Missing required fields'
      }, 400);
    }

    const conversationId = `${crypto.randomUUID()}`;

    const conversation = {
      id: conversationId,
      participants,
      subject,
      type: type || 'user',
      last_message: '',
      last_message_at: new Date().toISOString(),
      unread_count: 0,
      created_at: new Date().toISOString(),
    };

    // Save the conversation
    await dmConversationsStore.set(conversationId, conversation);

    // Add conversation to each participant's list
    for (const participantId of participants) {
      const existingConversations = await dmConvListStore.get(participantId) || [];
      await dmConvListStore.set(participantId, [...existingConversations, conversationId]);
    }

    return c.json({
      success: true,
      data: conversation
    });
  } catch (error) {
    console.error('Error creating conversation:', error);
    return c.json({
      success: false,
      error: 'Failed to create conversation'
    }, 500);
  }
});

/**
 * GET /messenger/messages/:conversationId
 * Получить сообщения разговора
 */
app.get('/messages/:conversationId', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');

  try {
    // Messages for a conversation are stored as one array under conv_id
    const messages = await dmMessagesStore.get(conversationId) || [];

    const validMessages = (Array.isArray(messages) ? messages : [])
      .sort((a: any, b: any) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

    return c.json({
      success: true,
      data: validMessages
    });
  } catch (error) {
    console.error('Error loading messages:', error);
    return c.json({
      success: true,
      data: []
    });
  }
});

/**
 * POST /messenger/send
 * Отправить сообщение
 */
app.post('/send', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const {
      conversation_id,
      from_user_id,
      message,
      metadata,
    } = body;

    if (!conversation_id || !from_user_id || !message) {
      return c.json({
        success: false,
        error: 'Missing required fields'
      }, 400);
    }

    const messageId = `${crypto.randomUUID()}`;

    const messageData = {
      id: messageId,
      conversation_id,
      from_user_id,
      message,
      read: false,
      created_at: new Date().toISOString(),
      metadata: metadata || {},
    };

    // Append message to the conversation's message array
    const existingMessages = await dmMessagesStore.get(conversation_id) || [];
    await dmMessagesStore.set(conversation_id, [...(Array.isArray(existingMessages) ? existingMessages : []), messageData]);

    // Обновляем разговор
    const conversation = await dmConversationsStore.get(conversation_id);

    if (conversation) {
      conversation.last_message = message;
      conversation.last_message_at = new Date().toISOString();

      // Увеличиваем счетчик непрочитанных для других участников
      conversation.participants.forEach((participantId: string) => {
        if (participantId !== from_user_id) {
          conversation.unread_count = (conversation.unread_count || 0) + 1;
        }
      });

      await dmConversationsStore.set(conversation_id, conversation);

      // Создаём уведомление для каждого получателя
      const recipients = conversation.participants.filter((id: string) => id !== from_user_id);

      for (const recipientId of recipients) {
        const notificationId = `${crypto.randomUUID()}`;

        // Получаем имя отправителя (если есть в metadata)
        const senderName = metadata?.sender_name || 'Новое сообщение';

        const notification = {
          id: notificationId,
          user_id: recipientId,
          type: 'new_message',
          title: senderName,
          message: message.length > 100 ? message.substring(0, 100) + '...' : message,
          link: `/notifications?tab=messenger&conversation=${conversation_id}`,
          read: false,
          starred: false,
          archived: false,
          created_at: new Date().toISOString(),
          metadata: {
            conversation_id,
            sender_id: from_user_id,
            message_id: messageId,
            conversation_type: conversation.type,
            conversation_subject: conversation.subject,
          },
        };

        // Save notification to notifications table
        await upsertNotification(recipientId, notificationId, notification);

        // No need to maintain a separate ID list — getNotificationsByUser queries by user_id column
      }

      // Emit SSE events to all recipients for real-time delivery
      for (const recipientId of recipients) {
        emitSSE(recipientId, {
          type: 'new_direct_message',
          data: {
            conversationId: conversation_id,
            senderId: from_user_id,
            senderName: metadata?.sender_name || '',
            senderRole: metadata?.sender_role || '',
            text: message.length > 200 ? message.substring(0, 200) + '...' : message,
            messageId,
            conversationType: conversation.type,
            source: conversation.type === 'support' ? 'support' : 'direct',
          },
        });
      }
    }

    return c.json({
      success: true,
      data: messageData
    });
  } catch (error) {
    console.error('Error sending message:', error);
    return c.json({
      success: false,
      error: 'Failed to send message'
    }, 500);
  }
});

/**
 * PUT /messenger/conversations/:conversationId/read
 * Отметить разговор как прочитанный
 */
app.put('/conversations/:conversationId/read', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');

  try {
    const conversation = await dmConversationsStore.get(conversationId);

    if (!conversation) {
      return c.json({
        success: false,
        error: 'Conversation not found'
      }, 404);
    }

    conversation.unread_count = 0;
    await dmConversationsStore.set(conversationId, conversation);

    // Отмечаем все сообщения как прочитанные
    const messages = await dmMessagesStore.get(conversationId) || [];

    if (Array.isArray(messages)) {
      let changed = false;
      for (const msg of messages) {
        if (!msg.read) {
          msg.read = true;
          changed = true;
        }
      }
      if (changed) {
        await dmMessagesStore.set(conversationId, messages);
      }
    }

    return c.json({
      success: true,
      data: conversation
    });
  } catch (error) {
    console.error('Error marking conversation as read:', error);
    return c.json({
      success: false,
      error: 'Failed to mark as read'
    }, 500);
  }
});

export default app;
