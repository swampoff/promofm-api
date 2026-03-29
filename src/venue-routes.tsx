/**
 * VENUE ROUTES - API для кабинета заведений
 * Авторизация через requireAuth middleware (JWT)
 * 
 * KV ключи:
 * - venue_profile:{userId} - профиль заведения
 * - venue_analytics:{venueId} - аналитика
 * - venue_campaigns:{venueId} - рекламные кампании
 * - venue_settings:{venueId} - настройки
 * - venue_notifications:{venueId} - уведомления (JSON массив)
 * - venue_bookings:{venueId} - список букингов (JSON массив ID)
 * 
 * Endpoints:
 * - GET /profile - Профиль заведения
 * - PUT /profile - Обновить профиль
 * - GET /stats - Статистика заведения
 * - GET /analytics/overview - Общая сводка аналитики
 * - GET /analytics/campaigns - Рекламные кампании
 * - GET /analytics/spending - График затрат
 * - GET /analytics/roi - ROI аналитика
 * - GET /analytics/radio-compare - Сравнение радиостанций
 * - POST /analytics/export - Экспорт отчетов
 * - GET /notifications - Уведомления заведения
 * - PUT /notifications/:id/read - Отметить уведомление прочитанным
 * - GET /bookings - Список букингов заведения
 */

import { Hono } from 'hono';
import { getBooking, getBookingsByUser, getNotification, getNotificationsByUser, getVenueProfile as dbGetVenueProfile, upsertNotification, upsertVenueProfile, platformStatsStore, venueAdCampaignsStore, venueAnalyticsStore, venuePlaylists, venueRadioBrandStore } from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { notifyVenueRequest } from './email-helper.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

// Fallback venue user ID
const FALLBACK_VENUE_USER_ID = 'anonymous';

// Helper: получить userId через единый хелпер авторизации
async function getUserId(c: any): Promise<string> {
  return c.get('userId') || FALLBACK_VENUE_USER_ID;
}

// Helper: safely parse kv.get result (may be string or object)
function parse(data: any): any {
  if (!data) return null;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data;
}

// Helper: Get or create venue profile from KV
async function getVenueProfile(userId: string) {
  const data = await dbGetVenueProfile(userId);
  return parse(data);
}

// =====================================================
// PROFILE ENDPOINTS
// =====================================================

// GET /profile - Получить профиль заведения
app.get('/profile', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      // Создаем дефолтный профиль, если не найден
      const defaultProfile = {
        id: `venue-${userId}`,
        userId,
        venueName: 'Мое заведение',
        description: null,
        venueType: 'bar',
        address: '',
        city: 'Москва',
        country: 'Россия',
        capacity: null,
        logoUrl: null,
        coverImageUrl: null,
        genres: [],
        socialLinks: {},
        workingHours: null,
        status: 'active',
        verified: false,
        subscriptionStatus: 'trial',
        subscriptionPlan: 'start',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await upsertVenueProfile(userId, defaultProfile);
      return c.json(defaultProfile);
    }

    return c.json(profile);
  } catch (error: any) {
    console.error('Error in GET /venue/profile:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// PUT /profile - Обновить профиль заведения
app.put('/profile', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const body = await c.req.json();
    let profile = await getVenueProfile(userId);

    if (!profile) {
      profile = {
        id: `venue-${userId}`,
        userId,
        createdAt: new Date().toISOString(),
      };
    }

    // Обновляем поля
    if (body.venueName !== undefined) profile.venueName = body.venueName;
    if (body.description !== undefined) profile.description = body.description;
    if (body.venueType !== undefined) profile.venueType = body.venueType;
    if (body.address !== undefined) profile.address = body.address;
    if (body.city !== undefined) profile.city = body.city;
    if (body.country !== undefined) profile.country = body.country;
    if (body.capacity !== undefined) profile.capacity = body.capacity;
    if (body.genres !== undefined) profile.genres = body.genres;
    if (body.logoUrl !== undefined) profile.logoUrl = body.logoUrl;
    if (body.coverImageUrl !== undefined) profile.coverImageUrl = body.coverImageUrl;
    if (body.socialLinks !== undefined) profile.socialLinks = body.socialLinks;
    if (body.workingHours !== undefined) profile.workingHours = body.workingHours;
    if (body.settings !== undefined) profile.settings = body.settings;
    profile.updatedAt = new Date().toISOString();

    await upsertVenueProfile(userId, profile);
    return c.json(profile);
  } catch (error: any) {
    console.error('Error in PUT /venue/profile:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /profile/logo - Загрузить логотип (placeholder)
app.post('/profile/logo', requireAuth, async (c) => {
  try {
    return c.json({ 
      message: 'Logo upload endpoint - to be implemented with Supabase Storage',
    });
  } catch (error: any) {
    console.error('Error in POST /venue/profile/logo:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /profile/cover - Загрузить обложку (placeholder)
app.post('/profile/cover', requireAuth, async (c) => {
  try {
    return c.json({ 
      message: 'Cover upload endpoint - to be implemented with Supabase Storage',
    });
  } catch (error: any) {
    console.error('Error in POST /venue/profile/cover:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// =====================================================
// STATS ENDPOINT
// =====================================================

app.get('/stats', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({
        totalPlaylists: 0, totalTracks: 0, totalPlaytime: 0,
        activeBookings: 0, completedBookings: 0,
        averageRating: 0, totalReviews: 0, connectedRadios: 0,
      });
    }

    // Получить ан��литику из KV
    const analyticsRaw = await venueAnalyticsStore.get(profile.id);
    const analytics = parse(analyticsRaw);

    // Получить букинги для подсчёта
    const bookingIdsRaw = await getBookingsByUser(userId);
    const bookingIds: string[] = parse(bookingIdsRaw) || [];
    
    let activeBookings = 0;
    let completedBookings = 0;
    
    if (bookingIds.length > 0) {
      const bookingValues = await Promise.all(bookingIds.slice(0, 50).map((id: string) => getBooking(id)));
      for (const val of bookingValues) {
        if (val) {
          const b = parse(val);
          if (b && ['pending', 'accepted', 'deposit_paid', 'confirmed'].includes(b.status)) {
            activeBookings++;
          }
          if (b && b.status === 'completed') {
            completedBookings++;
          }
        }
      }
    }

    return c.json({
      totalPlaylists: analytics?.totalPlaylists || 0,
      totalTracks: analytics?.totalTracks || 0,
      totalPlaytime: analytics?.totalPlaytime || 0,
      activeBookings,
      completedBookings,
      averageRating: analytics?.averageRating || 0,
      totalReviews: analytics?.totalReviews || 0,
      connectedRadios: analytics?.connectedRadios || 0,
    });
  } catch (error: any) {
    console.error('Error in GET /venue/stats:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// =====================================================
// ANALYTICS ENDPOINTS
// =====================================================

// GET /analytics/overview
app.get('/analytics/overview', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const period = c.req.query('period') || 'month';
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({
        success: true, period,
        data: {
          spending: { total: 0, growth: 0, thisMonth: 0 },
          campaigns: { active: 0, total: 0, completed: 0, successRate: 0 },
          reach: { totalImpressions: 0, uniqueListeners: 0, growth: 0, avgPerCampaign: 0 },
          performance: { avgROI: 0, conversionRate: 0, engagementRate: 0 },
        },
      });
    }

    // Получить аналитику из KV
    const analyticsRaw = await venueAnalyticsStore.get(profile.id);
    const analytics = parse(analyticsRaw) || {};

    // Получить кампании
    const campaignsRaw = await venueAdCampaignsStore.get(profile.id);
    const campaigns = parse(campaignsRaw) || [];

    const activeCampaigns = campaigns.filter((c: any) => c.status === 'active').length;
    const completedCampaigns = campaigns.filter((c: any) => c.status === 'completed').length;
    const totalSpending = campaigns.reduce((sum: number, c: any) => sum + (c.totalSpent || 0), 0);

    return c.json({
      success: true,
      period,
      data: {
        spending: {
          total: Math.round(totalSpending * 100) / 100,
          growth: analytics?.spendingGrowth || -5.2,
          thisMonth: Math.round((analytics?.monthlySpending || totalSpending) * 100) / 100,
        },
        campaigns: {
          active: activeCampaigns,
          total: campaigns.length,
          completed: completedCampaigns,
          successRate: campaigns.length ? Math.round((completedCampaigns / campaigns.length) * 100 * 10) / 10 : 0,
        },
        reach: {
          totalImpressions: analytics?.totalImpressions || 0,
          uniqueListeners: analytics?.uniqueListeners || 0,
          growth: analytics?.reachGrowth || 32.5,
          avgPerCampaign: campaigns.length ? Math.round((analytics?.totalImpressions || 0) / campaigns.length) : 0,
        },
        performance: {
          avgROI: analytics?.avgROI || 0,
          conversionRate: analytics?.conversionRate || 0,
          engagementRate: analytics?.engagementRate || 82.3,
        },
      },
    });
  } catch (error: any) {
    console.error('Error fetching venue analytics:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /analytics/campaigns
app.get('/analytics/campaigns', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, campaigns: [] });
    }

    const campaignsRaw = await venueAdCampaignsStore.get(profile.id);
    const campaigns = parse(campaignsRaw) || [];

    return c.json({ success: true, campaigns });
  } catch (error: any) {
    console.error('Error fetching campaigns:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /analytics/spending
app.get('/analytics/spending', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const period = c.req.query('period') || 'month';
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, period, data: [] });
    }

    // Получить историю расходов из KV
    const spendingRaw = await venueAnalyticsStore.get(profile.id);
    const spending = parse(spendingRaw) || [];

    return c.json({ success: true, period, data: spending });
  } catch (error: any) {
    console.error('Error fetching spending data:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /analytics/roi
app.get('/analytics/roi', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, data: [] });
    }

    const roiRaw = await venueAnalyticsStore.get(profile.id);
    const roi = parse(roiRaw) || [];

    return c.json({ success: true, data: roi });
  } catch (error: any) {
    console.error('Error fetching ROI data:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /analytics/radio-compare
app.get('/analytics/radio-compare', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, data: [] });
    }

    const compareRaw = await platformStatsStore.get(`venue_radio_compare:${profile.id}`);
    const comparison = parse(compareRaw) || [];

    return c.json({ success: true, data: comparison });
  } catch (error: any) {
    console.error('Error fetching radio comparison:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /analytics/export
app.post('/analytics/export', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { format, period } = body;

    return c.json({
      success: true,
      message: `Export in ${format || 'CSV'} format will be sent to your email`,
      format: format || 'CSV',
      period: period || 'month',
    });
  } catch (error: any) {
    console.error('Error exporting analytics:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// NOTIFICATIONS ENDPOINTS
// =====================================================

// GET /notifications
app.get('/notifications', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);

    // Получить уведомления из KV по prefix
    const notificationsData = await getNotificationsByUser(userId);
    const notifications = (notificationsData || [])
      .map((n: any) => {
        try {
          const val = typeof n === 'object' && n.value !== undefined ? n.value : n;
          return parse(val);
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({ success: true, notifications });
  } catch (error: any) {
    console.error('Error fetching notifications:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /notifications/:id/read
app.put('/notifications/:id/read', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const notifId = c.req.param('id');
    const notifRaw = await getNotification(userId, notifId);
    
    if (notifRaw) {
      const notif = parse(notifRaw);
      if (notif) {
        notif.read = true;
        await upsertNotification(userId, notifId, notif);
      }
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error marking notification as read:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// PLAYLISTS ENDPOINTS (for MusicSection)
// =====================================================

// GET /playlists - Получить плейлисты заведения
app.get('/playlists', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, playlists: [] });
    }

    const raw = await venuePlaylists.get(profile.id);
    const playlists = parse(raw) || [];

    return c.json({ success: true, playlists });
  } catch (error: any) {
    console.error('Error fetching venue playlists:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /playlists - Создать плейлист
app.post('/playlists', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ error: 'Venue profile not found' }, 404);
    }

    const body = await c.req.json();
    const now = new Date().toISOString();
    const playlist = {
      id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      venueId: profile.id,
      ownerId: userId,
      title: body.title || 'Новый плейлист',
      description: body.description || null,
      coverImageUrl: body.coverImageUrl || null,
      contentItems: body.contentItems || [],
      trackCount: body.trackCount || 0,
      totalDuration: body.totalDuration || 0,
      isPublic: body.isPublic ?? true,
      status: body.status || 'draft',
      createdAt: now,
      updatedAt: now,
    };

    const raw = await venuePlaylists.get(profile.id);
    const playlists = parse(raw) || [];
    playlists.push(playlist);
    await venuePlaylists.set(profile.id, playlists);

    return c.json({ success: true, playlist });
  } catch (error: any) {
    console.error('Error creating playlist:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /playlists/:id - Обновить плейлист
app.put('/playlists/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ error: 'Venue profile not found' }, 404);
    }

    const playlistId = c.req.param('id');
    const body = await c.req.json();

    const raw = await venuePlaylists.get(profile.id);
    const playlists: any[] = parse(raw) || [];
    const idx = playlists.findIndex((p: any) => p.id === playlistId);
    if (idx === -1) {
      return c.json({ error: 'Playlist not found' }, 404);
    }

    playlists[idx] = { ...playlists[idx], ...body, updatedAt: new Date().toISOString() };
    await venuePlaylists.set(profile.id, playlists);

    return c.json({ success: true, playlist: playlists[idx] });
  } catch (error: any) {
    console.error('Error updating playlist:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /playlists/:id - Удалить плейлист
app.delete('/playlists/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ error: 'Venue profile not found' }, 404);
    }

    const playlistId = c.req.param('id');
    const raw = await venuePlaylists.get(profile.id);
    const playlists: any[] = parse(raw) || [];
    const filtered = playlists.filter((p: any) => p.id !== playlistId);
    await venuePlaylists.set(profile.id, filtered);

    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting playlist:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// RADIO CATALOG ENDPOINTS (for RadioSection)
// =====================================================

// GET /radio-catalog - Каталог радиостанций для рекламы
app.get('/radio-catalog', requireAuth, async (c) => {
  try {
    const raw = await platformStatsStore.get('venue_radio_catalog');
    const stations = parse(raw) || [];
    return c.json({ success: true, stations });
  } catch (error: any) {
    console.error('Error fetching radio catalog:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /radio-campaigns - Рекламные кампании заведения
app.get('/radio-campaigns', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, campaigns: [] });
    }

    const raw = await venueAdCampaignsStore.get(profile.id);
    const campaigns = parse(raw) || [];
    return c.json({ success: true, campaigns });
  } catch (error: any) {
    console.error('Error fetching radio campaigns:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /radio-campaigns - Создать рекламную кампанию
app.post('/radio-campaigns', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ error: 'Venue profile not found' }, 404);
    }

    const body = await c.req.json();
    const campaign = {
      id: `camp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      stationId: body.stationId,
      stationName: body.stationName || '',
      packageType: body.packageType || 'slot_15sec',
      status: 'pending',
      audioUrl: body.audioUrl || '',
      startDate: body.startDate,
      endDate: body.endDate,
      totalPlays: 0,
      targetPlays: body.targetPlays || 0,
      budget: body.budget || 0,
      spent: 0,
      impressions: 0,
      ctr: 0,
      timeSlots: body.timeSlots || [],
      createdAt: new Date().toISOString(),
    };

    const raw = await venueAdCampaignsStore.get(profile.id);
    const campaigns = parse(raw) || [];
    campaigns.push(campaign);
    await venueAdCampaignsStore.set(profile.id, campaigns);

    // Email notification to admin
    notifyVenueRequest({
      venueName: campaign.venueName || profile?.name || 'Unknown',
      venueCity: campaign.venueCity || profile?.city || '',
      packageType: campaign.packageType || campaign.type || '',
      totalPrice: campaign.budget || campaign.totalPrice || 0,
      stationId: campaign.stationId || campaign.radioId || '',
    }).catch(() => {});

    return c.json({ success: true, campaign });
  } catch (error: any) {
    console.error('Error creating radio campaign:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /radio-campaigns/:id - Обновить кампанию (пауза/возобновление/отмена)
app.put('/radio-campaigns/:id', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ error: 'Venue profile not found' }, 404);
    }

    const campaignId = c.req.param('id');
    const body = await c.req.json();

    const raw = await venueAdCampaignsStore.get(profile.id);
    const campaigns: any[] = parse(raw) || [];
    const idx = campaigns.findIndex((c: any) => c.id === campaignId);
    if (idx === -1) {
      return c.json({ error: 'Campaign not found' }, 404);
    }

    campaigns[idx] = { ...campaigns[idx], ...body, updatedAt: new Date().toISOString() };
    await venueAdCampaignsStore.set(profile.id, campaigns);

    return c.json({ success: true, campaign: campaigns[idx] });
  } catch (error: any) {
    console.error('Error updating radio campaign:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// RADIO BRAND ENDPOINTS (for RadioBrandSection)
// =====================================================

// GET /radio-brand - Настройки радиобренда заведения
app.get('/radio-brand', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, data: null });
    }

    const raw = await venueRadioBrandStore.get(profile.id);
    const data = parse(raw);
    return c.json({ success: true, data });
  } catch (error: any) {
    console.error('Error fetching radio brand:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /radio-brand - Обновить настройки радиобренда
app.put('/radio-brand', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ error: 'Venue profile not found' }, 404);
    }

    const body = await c.req.json();
    const raw = await venueRadioBrandStore.get(profile.id);
    const current = parse(raw) || {};
    const updated = { ...current, ...body, updatedAt: new Date().toISOString() };
    await venueRadioBrandStore.set(profile.id, updated);

    return c.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Error updating radio brand:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// BOOKINGS LIST (for Venue cabinet)
// =====================================================

app.get('/bookings', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const statusFilter = c.req.query('status');
    const indexRaw = await getBookingsByUser(userId);
    const bookingIds: string[] = parse(indexRaw) || [];

    if (bookingIds.length === 0) {
      return c.json({ success: true, bookings: [] });
    }

    const bookingValues = await Promise.all(bookingIds.map((id: string) => getBooking(id)));

    let bookings = bookingValues
      .filter(v => v !== null)
      .map(v => parse(v))
      .filter(b => b && b.requesterId === userId); // only as requester (venue)

    if (statusFilter) {
      bookings = bookings.filter(b => b.status === statusFilter);
    }

    bookings.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({ success: true, bookings });
  } catch (error: any) {
    console.error('Error fetching venue bookings:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
