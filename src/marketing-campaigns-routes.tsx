/**
 * MARKETING CAMPAIGNS ROUTES
 * Промо-кампании: артист создаёт → админ одобряет → запуск
 *
 * Endpoints:
 * GET    /campaigns/:userId              - кампании пользователя
 * GET    /campaigns/all                  - все кампании (админ)
 * GET    /campaigns/pending              - ожидающие модерации (админ)
 * GET    /campaigns/detail/:campaignId   - детали кампании
 * POST   /campaigns                      - создать кампанию (артист)
 * PATCH  /campaigns/:campaignId          - обновить кампанию
 * DELETE /campaigns/:campaignId          - удалить кампанию
 * POST   /campaigns/:campaignId/approve  - одобрить (админ)
 * POST   /campaigns/:campaignId/reject   - отклонить (админ)
 * POST   /campaigns/:campaignId/launch   - запустить (админ)
 */

import { Hono } from 'hono';
import { notificationCampaignsStore, getNotificationCampaignsByUser, upsertNotificationCampaign } from './db.tsx';
import { notifyAllAdmins } from './cross-cabinet-notify.tsx';
import { safeErrorMessage } from './security.tsx';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { notifyModerationSubmitted } from './email-helper.tsx';

const marketing = new Hono();

// ── GET /campaigns/:userId - кампании пользователя ──

marketing.get('/campaigns/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  const userRole = c.get('userRole');
  if (userId !== authUserId && userRole !== 'admin') return c.json({ success: false, error: 'Access denied' }, 403);
  try {
    const campaigns = await getNotificationCampaignsByUser(userId);
    const valid = (campaigns || []).filter(Boolean);
    // Sort by created_at desc
    valid.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return c.json({ success: true, data: valid });
  } catch (error) {
    console.log('Marketing GET /campaigns/:userId error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── GET /campaigns/all - все кампании (админ) ──

marketing.get('/campaigns/all', requireAuth, requireAdmin, async (c) => {
  try {
    const campaigns = await notificationCampaignsStore.getAll();
    const valid = (campaigns || []).filter(Boolean);
    valid.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return c.json({ success: true, data: valid });
  } catch (error) {
    console.log('Marketing GET /campaigns/all error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── GET /campaigns/pending - ожидающие модерации (админ) ──

marketing.get('/campaigns/pending', requireAuth, requireAdmin, async (c) => {
  try {
    const campaigns = await notificationCampaignsStore.getAll();
    const pending = (campaigns || []).filter((c: any) => c && c.status === 'pending_review');
    pending.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return c.json({ success: true, data: pending, count: pending.length });
  } catch (error) {
    console.log('Marketing GET /campaigns/pending error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── GET /campaigns/detail/:campaignId ──

marketing.get('/campaigns/detail/:campaignId', requireAuth, async (c) => {
  const campaignId = c.req.param('campaignId');
  try {
    const campaign = await notificationCampaignsStore.get(campaignId);
    if (!campaign) return c.json({ success: false, error: 'Кампания не найдена' }, 404);
    return c.json({ success: true, data: campaign });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /campaigns - создать кампанию (артист) ──

marketing.post('/campaigns', requireAuth, async (c) => {
  try {
    // authUserId был использован ниже но не определён в scope POST-handler'а
    // (GET handler выше его объявляет, POST — нет). ReferenceError на runtime
    // — все запросы возвращали 500. Видно в логах: «Marketing POST /campaigns
    // error: ReferenceError: authUserId is not defined».
    const authUserId = c.get('userId') as string;
    const userRole = c.get('userRole') as string | undefined;

    const body = await c.req.json();
    if (!body.campaign_name || !body.user_id) {
      return c.json({ success: false, error: 'Обязательные поля: campaign_name, user_id' }, 400);
    }
    // Артист может создавать кампанию только для себя; admin для любого.
    if (body.user_id !== authUserId && userRole !== 'admin' && userRole !== 'superadmin') {
      return c.json({ success: false, error: 'Нельзя создавать кампанию от чужого имени' }, 403);
    }

    const campaignId = `campaign-${crypto.randomUUID()}`;

    const campaign = {
      id: campaignId,
      campaign_name: body.campaign_name,
      // body.user_id уже верифицирован выше (= authUserId либо admin override).
      user_id: body.user_id,
      artist_name: body.artist_name || 'Артист',
      description: body.description || '',
      content_ids: body.content_ids || [],
      start_date: body.start_date || null,
      end_date: body.end_date || null,
      channels: body.channels || [],
      target_audience: body.target_audience || {
        age_range: '18-45',
        gender: 'all',
        geography: ['Россия'],
        interests: [],
      },
      budget_preference: body.budget_preference || 'medium',
      custom_budget: body.custom_budget || 0,
      base_price: body.base_price || 0,
      final_price: body.final_price || 0,
      discount_applied: body.discount_applied || 0,
      status: 'pending_review',
      rejection_reason: null,
      additional_materials: body.additional_materials || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await upsertNotificationCampaign(body.user_id, campaignId, campaign);

    // Cross-cabinet: notify ALL admins about new campaign (role-based broadcast).
    try {
      await notifyAllAdmins({
        sourceRole: 'artist',
        type: 'admin_action',
        title: 'Новая промо-кампания',
        message: `Артист «${campaign.artist_name}» создал кампанию «${campaign.campaign_name}» - ожидает модерации`,
        link: 'moderation',
        metadata: { campaignId, artistName: campaign.artist_name },
      });
      // Email notification to admin (info@promofm.ru)
      notifyModerationSubmitted({
        kind: 'промо-кампания',
        title: campaign.campaign_name,
        artist: campaign.artist_name,
        userId: campaign.user_id,
        plan: String(campaign.budget_preference || ''),
        extra: {
          'Каналы': Array.isArray(campaign.channels) ? campaign.channels.join(', ') : '',
          'Бюджет': campaign.final_price ? String(campaign.final_price) + ' ₽' : '',
        },
        adminPath: '/ctrl-pm7k2f/marketing-moderation',
      }).catch((err: any) => console.error('[marketing-campaigns] email notify failed:', err?.message));
    } catch (e) {
      console.log('Notify admin error (non-critical):', e);
    }

    return c.json({ success: true, data: campaign }, 201);
  } catch (error) {
    console.log('Marketing POST /campaigns error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── PATCH /campaigns/:campaignId ──

marketing.patch('/campaigns/:campaignId', requireAuth, async (c) => {
  const campaignId = c.req.param('campaignId');
  try {
    const body = await c.req.json();
    const campaign = await notificationCampaignsStore.get(campaignId) as any;
    if (!campaign) return c.json({ success: false, error: 'Кампания не найдена' }, 404);

    const updated = { ...campaign, ...body, updated_at: new Date().toISOString() };
    await upsertNotificationCampaign(updated.user_id, campaignId, updated);
    return c.json({ success: true, data: updated });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── DELETE /campaigns/:campaignId ──

marketing.delete('/campaigns/:campaignId', requireAuth, async (c) => {
  const campaignId = c.req.param('campaignId');
  try {
    const campaign = await notificationCampaignsStore.get(campaignId) as any;
    if (!campaign) return c.json({ success: false, error: 'Кампания не найдена' }, 404);

    await notificationCampaignsStore.del(campaignId);

    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /campaigns/:campaignId/approve - одобрить (админ) ──

marketing.post('/campaigns/:campaignId/approve', requireAuth, requireAdmin, async (c) => {
  const campaignId = c.req.param('campaignId');
  try {
    const body = await c.req.json().catch(() => ({}));
    const campaign = await notificationCampaignsStore.get(campaignId) as any;
    if (!campaign) return c.json({ success: false, error: 'Кампания не найдена' }, 404);

    campaign.status = 'approved';
    if (body.final_price) campaign.final_price = body.final_price;
    campaign.approved_at = new Date().toISOString();
    campaign.updated_at = new Date().toISOString();
    await upsertNotificationCampaign(campaign.user_id, campaignId, campaign);

    // Cross-cabinet: notify artist
    try {
      await notifyCrossCabinet({
        targetUserId: campaign.user_id,
        targetRole: 'artist',
        sourceRole: 'admin',
        type: 'admin_action',
        title: 'Кампания одобрена',
        message: `Ваша промо-кампания «${campaign.campaign_name}» одобрена администратором и готова к запуску`,
        link: 'campaigns',
        metadata: { campaignId, status: 'approved' },
      });
    } catch (e) {
      console.log('Notify artist (approve) error:', e);
    }

    return c.json({ success: true, data: campaign });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /campaigns/:campaignId/reject - отклонить (админ) ──

marketing.post('/campaigns/:campaignId/reject', requireAuth, requireAdmin, async (c) => {
  const campaignId = c.req.param('campaignId');
  try {
    const body = await c.req.json().catch(() => ({}));
    const campaign = await notificationCampaignsStore.get(campaignId) as any;
    if (!campaign) return c.json({ success: false, error: 'Кампания не найдена' }, 404);

    campaign.status = 'rejected';
    campaign.rejection_reason = body.reason || 'Не указана';
    campaign.rejected_at = new Date().toISOString();
    campaign.updated_at = new Date().toISOString();
    await upsertNotificationCampaign(campaign.user_id, campaignId, campaign);

    // Cross-cabinet: notify artist
    try {
      await notifyCrossCabinet({
        targetUserId: campaign.user_id,
        targetRole: 'artist',
        sourceRole: 'admin',
        type: 'admin_action',
        title: 'Кампания отклонена',
        message: `Промо-кампания «${campaign.campaign_name}» отклонена. Причина: ${campaign.rejection_reason}`,
        link: 'campaigns',
        metadata: { campaignId, status: 'rejected', reason: campaign.rejection_reason },
      });
    } catch (e) {
      console.log('Notify artist (reject) error:', e);
    }

    return c.json({ success: true, data: campaign });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /campaigns/:campaignId/launch - запустить кампанию (админ) ──

marketing.post('/campaigns/:campaignId/launch', requireAuth, requireAdmin, async (c) => {
  const campaignId = c.req.param('campaignId');
  try {
    const campaign = await notificationCampaignsStore.get(campaignId) as any;
    if (!campaign) return c.json({ success: false, error: 'Кампания не найдена' }, 404);

    if (campaign.status !== 'approved') {
      return c.json({ success: false, error: 'Кампания должна быть одобрена перед запуском' }, 400);
    }

    campaign.status = 'active';
    campaign.launched_at = new Date().toISOString();
    campaign.updated_at = new Date().toISOString();
    await upsertNotificationCampaign(campaign.user_id, campaignId, campaign);

    // Cross-cabinet: notify artist about launch
    try {
      await notifyCrossCabinet({
        targetUserId: campaign.user_id,
        targetRole: 'artist',
        sourceRole: 'admin',
        type: 'admin_action',
        title: 'Кампания запущена!',
        message: `Ваша промо-кампания «${campaign.campaign_name}» успешно запущена. Отслеживайте результаты в личном кабинете.`,
        link: 'campaigns',
        metadata: { campaignId, status: 'active' },
      });
    } catch (e) {
      console.log('Notify artist (launch) error:', e);
    }

    return c.json({ success: true, data: campaign });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ═══════════════════════════════════════
// MARKETING ANALYTICS ENDPOINTS
// ═══════════════════════════════════════

// GET /analytics/performance/:artistId
marketing.get('/analytics/performance/:artistId', requireAuth, async (c) => {
  try {
    const artistId = c.req.param('artistId');
    const range = c.req.query('range') || '30d';
    const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { rows } = await pool.query(
      `SELECT id, campaign_name, campaign_type, status, metrics, roi, started_at, ended_at, created_at
       FROM marketing_campaigns
       WHERE artist_id = $1 AND created_at >= $2
       ORDER BY created_at DESC`,
      [artistId, since]
    );

    // Aggregate metrics
    let totalImpressions = 0, totalClicks = 0, totalConversions = 0, totalSpent = 0;
    for (const row of rows) {
      const m = row.metrics || {};
      totalImpressions += m.impressions || 0;
      totalClicks += m.clicks || 0;
      totalConversions += m.conversions || 0;
      totalSpent += m.spent || row.budget || 0;
    }

    return c.json({
      success: true,
      data: {
        campaigns: rows.length,
        impressions: totalImpressions,
        clicks: totalClicks,
        conversions: totalConversions,
        spent: totalSpent,
        ctr: totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : '0.00',
        conversionRate: totalClicks > 0 ? ((totalConversions / totalClicks) * 100).toFixed(2) : '0.00',
        timeline: rows.map(r => ({
          id: r.id,
          name: r.campaign_name,
          type: r.campaign_type,
          status: r.status,
          metrics: r.metrics,
          roi: r.roi,
          startedAt: r.started_at,
          createdAt: r.created_at,
        })),
      },
    });
  } catch (error) {
    console.error('Error in GET /analytics/performance:', error);
    return c.json({ success: true, data: { campaigns: 0, impressions: 0, clicks: 0, conversions: 0, spent: 0, ctr: '0.00', conversionRate: '0.00', timeline: [] } });
  }
});

// GET /analytics/channels/:artistId
marketing.get('/analytics/channels/:artistId', requireAuth, async (c) => {
  try {
    const artistId = c.req.param('artistId');
    const range = c.req.query('range') || '30d';
    const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { rows } = await pool.query(
      `SELECT platforms, metrics, budget FROM marketing_campaigns WHERE artist_id = $1 AND created_at >= $2`,
      [artistId, since]
    );

    // Aggregate by platform/channel
    const channels: Record<string, { impressions: number; clicks: number; spent: number; campaigns: number }> = {};
    for (const row of rows) {
      const platforms = Array.isArray(row.platforms) ? row.platforms : [];
      const m = row.metrics || {};
      for (const platform of platforms) {
        if (!channels[platform]) channels[platform] = { impressions: 0, clicks: 0, spent: 0, campaigns: 0 };
        channels[platform].impressions += Math.round((m.impressions || 0) / (platforms.length || 1));
        channels[platform].clicks += Math.round((m.clicks || 0) / (platforms.length || 1));
        channels[platform].spent += Math.round((m.spent || row.budget || 0) / (platforms.length || 1));
        channels[platform].campaigns += 1;
      }
      if (platforms.length === 0) {
        if (!channels['other']) channels['other'] = { impressions: 0, clicks: 0, spent: 0, campaigns: 0 };
        channels['other'].impressions += m.impressions || 0;
        channels['other'].clicks += m.clicks || 0;
        channels['other'].spent += m.spent || row.budget || 0;
        channels['other'].campaigns += 1;
      }
    }

    return c.json({
      success: true,
      data: Object.entries(channels).map(([name, stats]) => ({
        channel: name,
        ...stats,
        ctr: stats.impressions > 0 ? ((stats.clicks / stats.impressions) * 100).toFixed(2) : '0.00',
      })),
    });
  } catch (error) {
    console.error('Error in GET /analytics/channels:', error);
    return c.json({ success: true, data: [] });
  }
});

// GET /analytics/summary/:artistId
marketing.get('/analytics/summary/:artistId', requireAuth, async (c) => {
  try {
    const artistId = c.req.param('artistId');
    const range = c.req.query('range') || '30d';
    const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { rows } = await pool.query(
      `SELECT status, COUNT(*) as cnt, SUM(budget) as total_budget, AVG(roi) as avg_roi
       FROM marketing_campaigns
       WHERE artist_id = $1 AND created_at >= $2
       GROUP BY status`,
      [artistId, since]
    );

    const summary: Record<string, any> = { total: 0, active: 0, completed: 0, draft: 0, pending: 0, totalBudget: 0, avgRoi: 0 };
    let totalRoi = 0, roiCount = 0;
    for (const row of rows) {
      const cnt = parseInt(row.cnt);
      summary.total += cnt;
      summary[row.status] = (summary[row.status] || 0) + cnt;
      summary.totalBudget += parseInt(row.total_budget || '0');
      if (row.avg_roi) { totalRoi += parseFloat(row.avg_roi) * cnt; roiCount += cnt; }
    }
    summary.avgRoi = roiCount > 0 ? (totalRoi / roiCount).toFixed(2) : '0.00';

    return c.json({ success: true, data: summary });
  } catch (error) {
    console.error('Error in GET /analytics/summary:', error);
    return c.json({ success: true, data: { total: 0, active: 0, completed: 0, draft: 0, pending: 0, totalBudget: 0, avgRoi: '0.00' } });
  }
});

export default marketing;
