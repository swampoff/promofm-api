/**
 * CROSS-CABINET NOTIFICATIONS — REST API
 * GET/POST endpoints for notification bell in all cabinets
 */

import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';
import {
  getAllNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
} from './cross-cabinet-notify.tsx';

const app = new Hono();

// GET /user/:userId — all notifications (with limit)
app.get('/user/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    const limit = parseInt(c.req.query('limit') || '30');
    const notifications = await getAllNotifications(userId, limit);
    return c.json({ success: true, data: notifications });
  } catch (err) {
    return c.json({ success: false, error: 'Failed to fetch notifications' }, 500);
  }
});

// GET /user/:userId/unread-count
app.get('/user/:userId/unread-count', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    const count = await getUnreadCount(userId);
    return c.json({ success: true, count });
  } catch (err) {
    return c.json({ success: false, error: 'Failed to get unread count' }, 500);
  }
});

// POST /user/:userId/read/:notifId — mark one as read
app.post('/user/:userId/read/:notifId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    const notifId = c.req.param('notifId');
    await markAsRead(userId, notifId);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: 'Failed to mark as read' }, 500);
  }
});

// POST /user/:userId/read-all — mark all as read
app.post('/user/:userId/read-all', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    const count = await markAllAsRead(userId);
    return c.json({ success: true, marked: count });
  } catch (err) {
    return c.json({ success: false, error: 'Failed to mark all as read' }, 500);
  }
});

export default app;
