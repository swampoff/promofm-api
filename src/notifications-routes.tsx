/**
 * NOTIFICATIONS & REMINDERS API ROUTES
 * Маршруты для управления уведомлениями, напоминаниями и рассылками
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth, requireOwner } from './auth-middleware.tsx';

const notifications = new Hono();

export interface Notification {
  id: string;
  userId: string;
  concertId: string;
  type: 'reminder' | 'announcement' | 'ticket_update' | 'promotion';
  title: string;
  message: string;
  scheduledFor: string;
  status: 'pending' | 'sent' | 'failed';
  channel: 'email' | 'push' | 'both';
  createdAt: string;
  sentAt?: string;
  metadata?: Record<string, any>;
}

export interface EmailCampaign {
  id: string;
  artistId: string;
  concertId?: string;
  subject: string;
  content: string;
  recipientCount: number;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';
  scheduledFor?: string;
  sentAt?: string;
  openRate?: number;
  clickRate?: number;
  createdAt: string;
}

export interface NotificationSettings {
  userId: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
  reminderDaysBefore: number[];
  announcements: boolean;
  promotions: boolean;
  ticketUpdates: boolean;
}

// Получить все уведомления пользователя
notifications.get('/user/:userId', requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param('userId');
    const notifs = await db.getNotificationsByUser(userId);

    return c.json({
      success: true,
      data: notifs.sort((a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch notifications'
    }, 500);
  }
});

// Получить настройки уведомлений
notifications.get('/settings/:userId', requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param('userId');
    const settings = await db.getNotificationSettings(userId);

    if (!settings) {
      const defaultSettings: NotificationSettings = {
        userId,
        emailEnabled: true,
        pushEnabled: true,
        reminderDaysBefore: [7, 3, 1],
        announcements: true,
        promotions: true,
        ticketUpdates: true,
      };

      await db.upsertNotificationSettings(userId, defaultSettings);
      return c.json({ success: true, data: defaultSettings });
    }

    return c.json({ success: true, data: settings });
  } catch (error) {
    console.error('Error fetching notification settings:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch settings'
    }, 500);
  }
});

// Обновить настройки уведомлений
notifications.put('/settings/:userId', requireAuth, requireOwner('userId'), async (c) => {
  try {
    const userId = c.req.param('userId');
    const body = await c.req.json();

    const settings: NotificationSettings = {
      userId,
      emailEnabled: body.emailEnabled ?? true,
      pushEnabled: body.pushEnabled ?? true,
      reminderDaysBefore: body.reminderDaysBefore ?? [7, 3, 1],
      announcements: body.announcements ?? true,
      promotions: body.promotions ?? true,
      ticketUpdates: body.ticketUpdates ?? true,
    };

    await db.upsertNotificationSettings(userId, settings);

    return c.json({ success: true, data: settings });
  } catch (error) {
    console.error('Error updating notification settings:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update settings'
    }, 500);
  }
});

// Создать напоминание о концерте
notifications.post('/reminder', requireAuth, async (c) => {
  try {
    const body = await c.req.json();

    // Target = сам аутентифицированный юзер (2026-07-02). Раньше body.userId
    // позволял любому залогиненному ЗАПИСАТЬ уведомление в ЧУЖУЮ ленту с
    // произвольным title/message — stored-фишинг («Аккаунт заблокирован,
    // подтвердите: evil.link»). Админ может указать target явно.
    const authUserId = c.get('userId');
    const userRole = c.get('userRole');
    const isAdmin = userRole === 'admin' || userRole === 'superadmin';
    const targetUserId = isAdmin && body.userId ? body.userId : authUserId;

    const notification: Notification = {
      id: `notif-${crypto.randomUUID()}`,
      userId: targetUserId,
      concertId: body.concertId,
      type: 'reminder',
      title: body.title || 'Напоминание о концерте',
      message: body.message,
      scheduledFor: body.scheduledFor,
      status: 'pending',
      channel: body.channel || 'both',
      createdAt: new Date().toISOString(),
      metadata: body.metadata || {},
    };

    await db.upsertNotification(notification.userId, notification.id, notification);

    return c.json({ success: true, data: notification });
  } catch (error) {
    console.error('Error creating reminder:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create reminder'
    }, 500);
  }
});

// Автоматическое создание напоминаний для концерта
notifications.post('/auto-reminders/:concertId', requireAuth, async (c) => {
  try {
    const concertId = c.req.param('concertId');
    const body = await c.req.json();

    const concert = body.concert;
    // Target = сам аутентифицированный юзер (2026-07-02): body.artistId
    // позволял писать напоминания в чужую ленту (см. /reminder выше).
    const authUserId = c.get('userId');
    const userRole = c.get('userRole');
    const isAdmin = userRole === 'admin' || userRole === 'superadmin';
    const artistId = isAdmin && body.artistId ? body.artistId : authUserId;

    const settings = await db.getNotificationSettings(artistId) as NotificationSettings | null;
    const reminderDays = settings?.reminderDaysBefore || [7, 3, 1];

    const concertDate = new Date(concert.date);
    const createdNotifications: Notification[] = [];

    for (const days of reminderDays) {
      const reminderDate = new Date(concertDate);
      reminderDate.setDate(reminderDate.getDate() - days);

      if (reminderDate > new Date()) {
        const notification: Notification = {
          id: `notif-${crypto.randomUUID()}`,
          userId: artistId,
          concertId,
          type: 'reminder',
          title: `Концерт через ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`,
          message: `Напоминаем: ${concert.title} состоится ${concertDate.toLocaleDateString('ru-RU')} в ${concert.city}`,
          scheduledFor: reminderDate.toISOString(),
          status: 'pending',
          channel: 'both',
          createdAt: new Date().toISOString(),
          metadata: { concert },
        };

        await db.upsertNotification(artistId, notification.id, notification);
        createdNotifications.push(notification);
      }
    }

    return c.json({
      success: true,
      data: createdNotifications,
      message: `Создано ${createdNotifications.length} напоминаний`
    });
  } catch (error) {
    console.error('Error creating auto-reminders:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create auto-reminders'
    }, 500);
  }
});

// Получить email-кампании артиста
notifications.get('/campaigns/:artistId', requireAuth, async (c) => {
  try {
    const artistId = c.req.param('artistId');
    // Owner-or-admin (2026-07-02): раньше любой залогиненный читал ЧУЖИЕ
    // кампании по artistId из URL (тема/контент — IDOR-read).
    const userRole = c.get('userRole');
    if (artistId !== c.get('userId') && userRole !== 'admin' && userRole !== 'superadmin') {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    const campaigns = await db.getEmailCampaigns(artistId);

    return c.json({
      success: true,
      data: campaigns.sort((a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch campaigns'
    }, 500);
  }
});

// Создать email-кампанию
notifications.post('/campaigns', requireAuth, async (c) => {
  try {
    const body = await c.req.json();

    const campaign: EmailCampaign = {
      id: `campaign-${crypto.randomUUID()}`,
      artistId: body.artistId,
      concertId: body.concertId,
      subject: body.subject,
      content: body.content,
      recipientCount: body.recipientCount || 0,
      status: 'draft',
      scheduledFor: body.scheduledFor,
      createdAt: new Date().toISOString(),
    };

    await db.upsertEmailCampaign(campaign.id, campaign);

    return c.json({ success: true, data: campaign });
  } catch (error) {
    console.error('Error creating campaign:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create campaign'
    }, 500);
  }
});

// Отправить email-кампанию
// Отправка кампаний — только через /api/email-campaigns/campaigns/:id/send (admin)
notifications.post('/campaigns/:campaignId/send', requireAuth, async (c) => {
  return c.json({
    success: false,
    error: 'Отправка кампаний доступна через панель администратора'
  }, 400);
});

// Удалить уведомление
notifications.delete('/:userId/:notificationId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    const notificationId = c.req.param('notificationId');

    await db.deleteNotification(userId, notificationId);

    return c.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete notification'
    }, 500);
  }
});

// Отметить уведомление как прочитанное
notifications.put('/:userId/:notificationId/read', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    const notificationId = c.req.param('notificationId');

    const notification = await db.getNotification(userId, notificationId) as Notification;

    if (notification) {
      notification.status = 'sent';
      notification.sentAt = new Date().toISOString();
      await db.upsertNotification(userId, notificationId, notification);
    }

    return c.json({ success: true, data: notification });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to mark as read'
    }, 500);
  }
});

// Получить статистику уведомлений
notifications.get('/stats/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    const allNotifications = await db.getNotificationsByUser(userId);

    const stats = {
      total: allNotifications.length,
      pending: allNotifications.filter((n: any) => n.status === 'pending').length,
      sent: allNotifications.filter((n: any) => n.status === 'sent').length,
      failed: allNotifications.filter((n: any) => n.status === 'failed').length,
      byType: {
        reminder: allNotifications.filter((n: any) => n.type === 'reminder').length,
        announcement: allNotifications.filter((n: any) => n.type === 'announcement').length,
        ticket_update: allNotifications.filter((n: any) => n.type === 'ticket_update').length,
        promotion: allNotifications.filter((n: any) => n.type === 'promotion').length,
      },
    };

    return c.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error fetching notification stats:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch stats'
    }, 500);
  }
});

export default notifications;
