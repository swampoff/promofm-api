/**
 * EMAIL SYSTEM ROUTES
 * Система управления email-уведомлениями и подписками
 */

import { Hono } from 'hono';
import { publishEmailPrefsStore, emailHistoryStore, emailTemplatesStore } from './db.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { smtpSendEmail } from './smtp-sender.tsx';

const app = new Hono();

// No more KV prefixes — all data access goes through typed stores from db.tsx

// ============================================
// EMAIL SUBSCRIPTIONS
// ============================================

/**
 * GET /subscriptions/:userId
 * Получить настройки email-подписок пользователя
 */
app.get('/subscriptions/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  
  try {
    const subscriptions = await publishEmailPrefsStore.get(userId);

    // Если настроек нет, возвращаем дефолтные
    if (!subscriptions) {
      const defaultSubscriptions = {
        user_id: userId,
        notifications: {
          new_message: true,
          new_follower: true,
          new_donation: true,
          track_approved: true,
          track_rejected: true,
          concert_approved: true,
          payment_success: true,
          payment_failed: true,
          pitching_response: true,
          marketing_started: false,
          marketing_completed: true,
        },
        newsletter: {
          weekly_digest: true,
          monthly_report: true,
          product_updates: true,
          promotional: false,
        },
        frequency: 'realtime', // realtime | daily | weekly
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await publishEmailPrefsStore.set(userId, defaultSubscriptions);
      return c.json({ success: true, data: defaultSubscriptions });
    }

    return c.json({ success: true, data: subscriptions });
  } catch (error) {
    console.error('Error loading email subscriptions:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to load subscriptions' 
    }, 500);
  }
});

/**
 * PUT /subscriptions/:userId
 * Обновить настройки email-подписок
 */
app.put('/subscriptions/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  
  try {
    const body = await c.req.json();
    const existingSubscriptions = await publishEmailPrefsStore.get(userId);

    const updatedSubscriptions = {
      ...existingSubscriptions,
      ...body,
      user_id: userId,
      updated_at: new Date().toISOString(),
    };

    await publishEmailPrefsStore.set(userId, updatedSubscriptions);
    
    return c.json({ success: true, data: updatedSubscriptions });
  } catch (error) {
    console.error('Error updating email subscriptions:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to update subscriptions' 
    }, 500);
  }
});

// ============================================
// EMAIL HISTORY
// ============================================

/**
 * GET /history/:userId
 * Получить историю отправленных email
 */
app.get('/history/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  
  try {
    const emails = await emailHistoryStore.getByCol('user_id', userId);

    emails.sort((a: any, b: any) =>
      new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime()
    );

    return c.json({ success: true, data: emails });
  } catch (error) {
    console.error('Error loading email history:', error);
    return c.json({ 
      success: true,
      data: [] 
    });
  }
});

/**
 * POST /send
 * Отправить email (сохраняет в историю)
 */
app.post('/send', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const {
      user_id,
      to_email,
      subject,
      template,
      content,
      type, // 'notification' | 'newsletter' | 'transactional'
      metadata,
    } = body;

    if (!user_id || !to_email || !subject || !content) {
      return c.json({ 
        success: false, 
        error: 'Missing required fields' 
      }, 400);
    }

    const emailId = `${crypto.randomUUID()}`;

    const emailData = {
      id: emailId,
      user_id,
      to_email,
      subject,
      template: template || null,
      content,
      type: type || 'notification',
      status: 'sent', // sent | failed | pending
      sent_at: new Date().toISOString(),
      opened: false,
      clicked: false,
      metadata: metadata || {},
    };

    // Отправляем через SMTP
    try {
      const sendResult = await smtpSendEmail({
        to: to_email,
        subject,
        html: content,
      });
      emailData.status = sendResult.ok ? 'sent' : 'failed';
      if (!sendResult.ok) {
        emailData.metadata = { ...emailData.metadata, sendError: sendResult.error };
      }
    } catch (sendErr) {
      console.error('[Email] SMTP send error:', sendErr);
      emailData.status = 'failed';
      emailData.metadata = { ...emailData.metadata, sendError: String(sendErr) };
    }

    await emailHistoryStore.set(emailId, emailData, { user_id });

    return c.json({ 
      success: emailData.status === 'sent', 
      data: emailData 
    });
  } catch (error) {
    console.error('Error sending email:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to send email' 
    }, 500);
  }
});

/**
 * PUT /history/:emailId/opened
 * Отметить email как открытый (tracking pixel)
 */
app.put('/history/:emailId/opened', requireAuth, async (c) => {
  const emailId = c.req.param('emailId');
  
  try {
    const userId = c.req.query('userId');
    if (!userId) {
      return c.json({ success: false, error: 'Missing userId' }, 400);
    }
    
    const email = await emailHistoryStore.get(emailId);

    if (!email) {
      return c.json({ success: false, error: 'Email not found' }, 404);
    }

    email.opened = true;
    email.opened_at = new Date().toISOString();
    await emailHistoryStore.set(emailId, email, { user_id: userId });

    return c.json({ success: true, data: email });
  } catch (error) {
    console.error('Error marking email as opened:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to mark as opened' 
    }, 500);
  }
});

// ============================================
// EMAIL TEMPLATES
// ============================================

/**
 * GET /templates
 * Получить все шаблоны email
 */
app.get('/templates', requireAuth, async (c) => {
  try {
    const templateList = await emailTemplatesStore.getAll();

    // Если шаблонов нет, создаём дефолтные
    if (templateList.length === 0) {
      const defaultTemplates = [
        {
          id: 'welcome',
          name: 'Приветственное письмо',
          subject: 'Добро пожаловать в ПРОМО.МУЗЫКА!',
          content: '<h1>Добро пожаловать!</h1><p>Рады видеть вас на платформе.</p>',
          type: 'transactional',
          variables: ['user_name'],
          created_at: new Date().toISOString(),
        },
        {
          id: 'new_follower',
          name: 'Новый подписчик',
          subject: 'У вас новый подписчик!',
          content: '<h1>Новый фанат!</h1><p>{{follower_name}} подписался на ваши обновления.</p>',
          type: 'notification',
          variables: ['follower_name', 'follower_avatar'],
          created_at: new Date().toISOString(),
        },
        {
          id: 'track_approved',
          name: 'Трек одобрен',
          subject: 'Ваш трек одобрен модерацией',
          content: '<h1>Поздравляем!</h1><p>Трек "{{track_name}}" успешно прошёл модерацию.</p>',
          type: 'notification',
          variables: ['track_name', 'track_url'],
          created_at: new Date().toISOString(),
        },
        {
          id: 'weekly_digest',
          name: 'Еженедельный дайджест',
          subject: 'Ваши достижения за неделю',
          content: '<h1>Ваша статистика</h1><p>Прослушиваний: {{plays}}</p>',
          type: 'newsletter',
          variables: ['plays', 'likes', 'followers_count'],
          created_at: new Date().toISOString(),
        },
      ];
      
      for (const template of defaultTemplates) {
        await emailTemplatesStore.set(template.id, template);
      }
      
      return c.json({ success: true, data: defaultTemplates });
    }
    
    return c.json({ success: true, data: templateList });
  } catch (error) {
    console.error('Error loading email templates:', error);
    return c.json({ 
      success: true,
      data: [] 
    });
  }
});

/**
 * GET /templates/:templateId
 * Получить конкретный шаблон
 */
app.get('/templates/:templateId', requireAuth, async (c) => {
  const templateId = c.req.param('templateId');
  
  try {
    const template = await emailTemplatesStore.get(templateId);
    
    if (!template) {
      return c.json({ success: false, error: 'Template not found' }, 404);
    }
    
    return c.json({ success: true, data: template });
  } catch (error) {
    console.error('Error loading email template:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to load template' 
    }, 500);
  }
});

// ============================================
// STATS
// ============================================

/**
 * GET /stats/:userId
 * ��олучить статистику email
 */
app.get('/stats/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  
  try {
    const emails = await emailHistoryStore.getByCol('user_id', userId);
    
    const stats = {
      total_sent: emails.length,
      total_opened: emails.filter((e: any) => e.opened).length,
      total_clicked: emails.filter((e: any) => e.clicked).length,
      open_rate: emails.length > 0 
        ? ((emails.filter((e: any) => e.opened).length / emails.length) * 100).toFixed(1)
        : '0',
      click_rate: emails.length > 0
        ? ((emails.filter((e: any) => e.clicked).length / emails.length) * 100).toFixed(1)
        : '0',
      by_type: {
        notification: emails.filter((e: any) => e.type === 'notification').length,
        newsletter: emails.filter((e: any) => e.type === 'newsletter').length,
        transactional: emails.filter((e: any) => e.type === 'transactional').length,
      },
      last_30_days: emails.filter((e: any) => {
        const sentDate = new Date(e.sent_at);
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        return sentDate >= thirtyDaysAgo;
      }).length,
    };
    
    return c.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error loading email stats:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to load stats' 
    }, 500);
  }
});

export default app;