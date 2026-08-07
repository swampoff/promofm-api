/**
 * VENUE ROUTES - API для кабинета заведений
 * Авторизация через requireAuth middleware (JWT)
 * 
 * Хранение: SQL-таблицы (см. db.tsx):
 * - venue_profiles - профиль заведения
 * - аналитика - агрегируется из venue_ad_campaigns (отдельного стора нет)
 * - рекламные кампании - venue_ad_campaigns
 * - настройки - в составе venue_profiles
 * - notifications - уведомления
 * - bookings - список букингов
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
import { getBooking, getBookingsByUser, getNotification, getNotificationsByUser, getVenueProfile as dbGetVenueProfile, upsertNotification, upsertVenueProfile, getPlatformStats, setPlatformStats, getVenueRadioBrand, patchVenueRadioBrand, listRadioVenueRequestsByStation, listVenueAdCampaigns, insertVenueAdCampaign, updateVenueAdCampaign, insertRadioVenueRequest, insertRadioNotification, type VenueAdCampaignRow } from './db.tsx';
import { pool } from './db-client.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { notifyVenueRequest } from './email-helper.tsx';
import { safeErrorMessage } from './security.tsx';
import { splitRadioCampaignAmount } from './financial-constants.tsx';
import {
  getEffectiveVenuePlan,
  getEffectiveVenueLimits,
  featureBlocked,
  quotaExceeded,
} from './venue-plan-limits.tsx';
import { applyInitialTrial, expireTrialsOnce } from './venue-trial.tsx';

const app = new Hono();

// Fallback venue user ID
const FALLBACK_VENUE_USER_ID = 'anonymous';

// Helper: получить userId через единый хелпер авторизации
async function getUserId(c: any): Promise<string> {
  return c.get('userId') || FALLBACK_VENUE_USER_ID;
}

// Helper: safely parse a SQL row/value (may be a JSON string or already an object)
function parse(data: any): any {
  if (!data) return null;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data;
}

// Helper: load venue profile from the venue_profiles SQL table
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
        // Пробные 2 недели включаются ТОЛЬКО после привязки карты
        // (POST /venue-billing/attach-card → вебхук ставит 'trial').
        // Владелец 2026-08-07: «заведение обязано привязывать карту».
        // 'pending_card' не распознаётся getEffectiveVenuePlan → план 'free',
        // эфир не выдаётся авансом. Действующие 'trial' не трогаем.
        subscriptionStatus: 'pending_card',
        subscriptionPlan: 'start',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await upsertVenueProfile(userId, defaultProfile);
      // Уведомляем админа: раньше о новых заведениях никто не узнавал
      // (владелец 2026-08-07). Не блокируем ответ клиенту.
      import('./email-helper.tsx')
        .then((m: any) => m.notifyAdminNewVenue?.({
          venueName: defaultProfile.venueName || defaultProfile.name || '',
          city: defaultProfile.city,
          venueType: defaultProfile.venueType,
          email: defaultProfile.email,
          userId,
          stage: 'registered',
        }))
        .catch((e: any) => console.error('[venue] admin notify failed:', e?.message || e));
      return c.json({
        ...defaultProfile,
        effectivePlan: getEffectiveVenuePlan(defaultProfile),
        planLimits: getEffectiveVenueLimits(defaultProfile),
      });
    }

    // Surface the venue's resolved plan + limits so the cabinet can
    // gray out / lock features client-side without re-implementing
    // the entitlement logic. Backend remains the source of truth —
    // these are purely a hint for the UI.
    return c.json({
      ...profile,
      effectivePlan: getEffectiveVenuePlan(profile),
      planLimits: getEffectiveVenueLimits(profile),
    });
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
      // Skeleton-on-PUT path (client skipped initial GET). Mirror the
      // GET /profile default so the trial-expiry mechanic kicks in for
      // these venues too — without this they'd have no
      // subscriptionStatus and stay un-trial-able forever.
      profile = applyInitialTrial({
        id: `venue-${userId}`,
        userId,
        // Пробные 2 недели включаются ТОЛЬКО после привязки карты
        // (POST /venue-billing/attach-card → вебхук ставит 'trial').
        // Владелец 2026-08-07: «заведение обязано привязывать карту».
        // 'pending_card' не распознаётся getEffectiveVenuePlan → план 'free',
        // эфир не выдаётся авансом. Действующие 'trial' не трогаем.
        subscriptionStatus: 'pending_card',
        subscriptionPlan: 'start',
        createdAt: new Date().toISOString(),
      });
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

/**
 * POST /request-verification — venue submits a verification request.
 *
 * Mirrors artist's POST /artist-profile/request-verification (added
 * by migration 058). Admin then processes via POST /auth/admin/
 * verify-profile { role: 'venue', isVerified, rejectionReason? }.
 *
 * Idempotent: re-clicking refreshes verification_requested_at and
 * clears any previous rejection_reason — a venue that was rejected
 * can submit a corrected request without admin intervention.
 *
 * Migration 062 added the underlying columns.
 */
app.post('/request-verification', requireAuth, async (c) => {
  const userId = c.get('userId' as never) as string | undefined;
  if (!userId) {
    return c.json({ success: false, error: 'Не авторизован' }, 401);
  }
  try {
    const { rows } = await pool.query(
      `SELECT is_verified FROM venue_profiles WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }
    if (rows[0].is_verified) {
      return c.json({ success: false, error: 'Профиль уже верифицирован' }, 400);
    }
    await pool.query(
      `UPDATE venue_profiles
          SET verification_requested_at     = NOW(),
              verification_rejection_reason = NULL
        WHERE user_id = $1`,
      [userId],
    );
    console.log(`[VenueProfile] Verification requested by ${userId}`);
    return c.json({
      success: true,
      message: 'Заявка на верификацию отправлена. Ожидайте рассмотрения администратором.',
    });
  } catch (error) {
    console.error('[VenueProfile] request-verification error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /profile/logo - Загрузить логотип (placeholder)
app.post('/profile/logo', requireAuth, async (c) => {
  try {
    return c.json({ 
      message: 'Logo upload endpoint - to be implemented with local storage',
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
      message: 'Cover upload endpoint - to be implemented with local storage',
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

    // venue_analytics — dead store, 0 writers. Return null-equivalent (всегда было null).
    const analytics: any = null;

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
    if (!getEffectiveVenueLimits(profile).analytics) {
      return c.json(featureBlocked('analytics', profile), 403);
    }

    // venue_analytics — dead store, 0 writers. Empty placeholder.
    const analytics: any = {};

    const campaigns = await listVenueAdCampaigns(profile.id);

    const activeCampaigns = campaigns.filter(c => c.status === 'active').length;
    const completedCampaigns = campaigns.filter(c => c.status === 'completed').length;
    const totalSpending = campaigns.reduce((sum, c) => sum + (c.spent || 0), 0);

    return c.json({
      success: true,
      period,
      data: {
        spending: {
          total: Math.round(totalSpending * 100) / 100,
          growth: analytics?.spendingGrowth ?? 0, // Audit: was || -5.2 — fake constant shown to every venue (analytics={} dead store)
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
          growth: analytics?.reachGrowth ?? 0, // Audit: was || 32.5 (fake)
          avgPerCampaign: campaigns.length ? Math.round((analytics?.totalImpressions || 0) / campaigns.length) : 0,
        },
        performance: {
          avgROI: analytics?.avgROI || 0,
          conversionRate: analytics?.conversionRate || 0,
          engagementRate: analytics?.engagementRate ?? 0, // Audit: was || 82.3 (fake)
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
    if (!getEffectiveVenueLimits(profile).analytics) {
      return c.json(featureBlocked('analytics', profile), 403);
    }

    const campaigns = await listVenueAdCampaigns(profile.id);

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
    if (!getEffectiveVenueLimits(profile).analytics) {
      return c.json(featureBlocked('analytics', profile), 403);
    }

    // venue_analytics — dead store, 0 writers. Empty placeholder.
    const spending: any[] = [];

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
    if (!getEffectiveVenueLimits(profile).analytics) {
      return c.json(featureBlocked('analytics', profile), 403);
    }

    // venue_analytics — dead store, 0 writers. Empty placeholder.
    const roi: any[] = [];

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
    if (!getEffectiveVenueLimits(profile).analytics) {
      return c.json(featureBlocked('analytics', profile), 403);
    }

    const compareRaw = await getPlatformStats(`venue_radio_compare:${profile.id}`);
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
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile || !getEffectiveVenueLimits(profile).analytics) {
      return c.json(featureBlocked('analytics', profile), 403);
    }

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

    // Получить уведомления пользователя из таблицы notifications
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

// venue_playlists row (row-per-playlist after migration 036) → API.
// API исторически camelCase: id=app_id, venueId, ownerId, contentItems,
// trackCount, totalDuration, isPublic, etc.
function mapPlaylistRow(row: any): Record<string, any> {
  const iso = (d: any) => d ? (d instanceof Date ? d.toISOString() : String(d)) : undefined;
  return {
    id: row.app_id,
    venueId: row.venue_id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    coverImageUrl: row.cover_image_url,
    contentItems: row.content_items || [],
    trackCount: row.track_count,
    totalDuration: row.total_duration,
    isPublic: row.is_public,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const PLAYLIST_COLS = `app_id, venue_id, owner_id, title, description, cover_image_url,
  content_items, track_count, total_duration, is_public, status, created_at, updated_at`;

// GET /playlists - Получить плейлисты заведения
app.get('/playlists', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, playlists: [] });
    }
    const r = await pool.query(
      `SELECT ${PLAYLIST_COLS} FROM venue_playlists
        WHERE venue_id = $1 ORDER BY created_at DESC`,
      [profile.id]
    );
    return c.json({ success: true, playlists: r.rows.map(mapPlaylistRow) });
  } catch (error: any) {
    console.error('Error fetching venue playlists:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /playlists - Создать плейлист (gated by VENUE_PLAN_LIMITS.maxPlaylists)
app.post('/playlists', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) {
      return c.json({ error: 'Venue profile not found' }, 404);
    }

    const limits = getEffectiveVenueLimits(profile);

    // Enforce the maxPlaylists quota for the venue's effective plan.
    // Trial → 'business' (20), Старт/free → 5, Сеть/enterprise → unlimited.
    if (limits.maxPlaylists !== -1) {
      const cnt = await pool.query(
        `SELECT COUNT(*)::int AS n FROM venue_playlists WHERE venue_id = $1`,
        [profile.id]
      );
      const current = cnt.rows[0]?.n ?? 0;
      if (current >= limits.maxPlaylists) {
        return c.json(quotaExceeded('playlists', current, limits.maxPlaylists, profile), 403);
      }
    }

    const body = await c.req.json();
    const contentItems = Array.isArray(body.contentItems) ? body.contentItems : [];

    // Enforce maxTracks BEFORE inserting — sum existing tracks across
    // venue + this new one. Considers contentItems.length, not trackCount,
    // so a hand-set figure can't bypass it.
    if (limits.maxTracks !== -1 && contentItems.length > 0) {
      const sumRes = await pool.query(
        `SELECT COALESCE(SUM(jsonb_array_length(content_items)), 0)::int AS n
           FROM venue_playlists WHERE venue_id = $1`,
        [profile.id]
      );
      const existingTotal = sumRes.rows[0]?.n ?? 0;
      const wouldBeTotal = existingTotal + contentItems.length;
      if (wouldBeTotal > limits.maxTracks) {
        return c.json(quotaExceeded('tracks', wouldBeTotal, limits.maxTracks, profile), 403);
      }
    }

    const appId = `pl-${crypto.randomUUID()}`;
    const r = await pool.query(
      `INSERT INTO venue_playlists
         (app_id, venue_id, owner_id, title, description, cover_image_url,
          content_items, track_count, total_duration, is_public, status,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NOW(), NOW())
       RETURNING ${PLAYLIST_COLS}`,
      [
        appId, profile.id, userId,
        body.title || 'Новый плейлист',
        body.description || null,
        body.coverImageUrl || null,
        JSON.stringify(contentItems),
        contentItems.length,
        body.totalDuration || 0,
        body.isPublic ?? true,
        body.status || 'draft',
      ]
    );
    return c.json({ success: true, playlist: mapPlaylistRow(r.rows[0]) });
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

    const cur = await pool.query(
      `SELECT app_id FROM venue_playlists WHERE app_id = $1 AND venue_id = $2`,
      [playlistId, profile.id]
    );
    if (cur.rowCount === 0) return c.json({ error: 'Playlist not found' }, 404);

    // Enforce maxTracks for new contentItems: SUM other playlists +
    // this update's length.
    const limits = getEffectiveVenueLimits(profile);
    if (limits.maxTracks !== -1 && Array.isArray(body.contentItems)) {
      const sumRes = await pool.query(
        `SELECT COALESCE(SUM(jsonb_array_length(content_items)), 0)::int AS n
           FROM venue_playlists WHERE venue_id = $1 AND app_id != $2`,
        [profile.id, playlistId]
      );
      const otherTotal = sumRes.rows[0]?.n ?? 0;
      const wouldBeTotal = otherTotal + body.contentItems.length;
      if (wouldBeTotal > limits.maxTracks) {
        return c.json(quotaExceeded('tracks', wouldBeTotal, limits.maxTracks, profile), 403);
      }
    }

    const sets: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    const push = (col: string, val: any) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (typeof body.title === 'string')              push('title',           body.title);
    if (body.description !== undefined)              push('description',     body.description);
    if (body.coverImageUrl !== undefined)            push('cover_image_url', body.coverImageUrl);
    if (Array.isArray(body.contentItems)) {
      push('content_items', JSON.stringify(body.contentItems));
      push('track_count',   body.contentItems.length);
    }
    if (body.totalDuration !== undefined)            push('total_duration',  Number(body.totalDuration) || 0);
    if (body.isPublic !== undefined)                 push('is_public',       Boolean(body.isPublic));
    if (typeof body.status === 'string')             push('status',          body.status);

    params.push(playlistId, profile.id);
    const idxA = params.length - 1;
    const idxB = params.length;
    const r = await pool.query(
      `UPDATE venue_playlists SET ${sets.join(', ')}
        WHERE app_id = $${idxA} AND venue_id = $${idxB}
       RETURNING ${PLAYLIST_COLS}`,
      params
    );
    return c.json({ success: true, playlist: mapPlaylistRow(r.rows[0]) });
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
    await pool.query(
      `DELETE FROM venue_playlists WHERE app_id = $1 AND venue_id = $2`,
      [playlistId, profile.id]
    );
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
    const raw = await getPlatformStats('venue_radio_catalog');
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

    const campaigns = await listVenueAdCampaigns(profile.id);
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
    if (!body.stationId) {
      return c.json({ success: false, error: 'stationId обязателен' }, 400);
    }

    // ── Server-side authoritative pricing (решение владельца 2026-07-03) ──
    // Источник истины цены = слоты станции (radio_ad_slots), которые радио
    // выставило само: body.timeSlots = массив slot id, бюджет считается на
    // сервере как SUM(slot.price) × durationDays (контракт задокументирован
    // в venue-facing каталоге GET /radio-profile/profile/:id/ad-slots).
    // body.budget ИГНОРИРУЕТСЯ — раньше он принимался как есть, и amount-gate
    // на /create-session сверял оплату с клиентской цифрой (1₽-кампания
    // проходила все проверки). Легаси-строки ('any_time', 'morning'…) слотами
    // не являются → 400.
    const requestedSlotIds: string[] = Array.isArray(body.timeSlots)
      ? body.timeSlots.filter((s: any) => typeof s === 'string' && s.trim())
      : [];
    if (requestedSlotIds.length === 0) {
      return c.json({ success: false, error: 'Выберите рекламные слоты станции — цена рассчитывается по ним' }, 400);
    }
    const { pool: slotPool } = await import('./db-client.tsx');
    const slotRes = await slotPool.query(
      `SELECT id, price FROM radio_ad_slots
        WHERE radio_id = $1 AND id = ANY($2::text[]) AND status = 'available'`,
      [String(body.stationId), requestedSlotIds]
    );
    if (slotRes.rows.length !== requestedSlotIds.length) {
      return c.json({ success: false, error: 'Некоторые слоты недоступны или не принадлежат этой станции' }, 400);
    }
    const startMs = body.startDate ? new Date(body.startDate).getTime() : Date.now();
    const endMs = body.endDate ? new Date(body.endDate).getTime() : startMs;
    const durationDays = Math.max(1, Math.ceil((endMs - startMs) / 86400000));
    const perDay = slotRes.rows.reduce((s: number, r: any) => s + Number(r.price || 0), 0);
    const authoritativeBudget = Math.round(perDay * durationDays);
    if (!(authoritativeBudget > 0)) {
      return c.json({ success: false, error: 'Цена выбранных слотов не задана станцией' }, 400);
    }

    const now = new Date().toISOString();
    const campaign: VenueAdCampaignRow = {
      id: `camp-${crypto.randomUUID()}`,
      venueId: profile.id,
      stationId: body.stationId,
      stationName: body.stationName || '',
      advertiserId: null,
      packageType: body.packageType || 'slot_15sec',
      status: 'pending',
      audioUrl: body.audioUrl || '',
      startDate: body.startDate,
      endDate: body.endDate,
      totalPlays: 0,
      // Информативная оценка: 1 выход в день на каждый выбранный слот.
      targetPlays: requestedSlotIds.length * durationDays,
      budget: authoritativeBudget,
      spent: 0,
      impressions: 0,
      ctr: 0,
      timeSlots: requestedSlotIds,
      extra: {},
      createdAt: now,
      updatedAt: now,
    };

    // Atomic INSERT — no race window vs legacy get-push-set.
    await insertVenueAdCampaign(campaign);

    // Push venue request to radio side so radio station sees it in orders
    if (campaign.stationId) {
      const venueRequest = {
        id: campaign.id,
        venueId: profile.id,
        venueName: profile.name || 'Unknown',
        venueCity: profile.city || '',
        packageType: campaign.packageType,
        audioUrl: campaign.audioUrl,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        targetPlays: campaign.targetPlays,
        playsPerDay: Math.ceil((campaign.targetPlays || 0) / Math.max(1, Math.ceil(((new Date(campaign.endDate || Date.now()).getTime()) - (new Date(campaign.startDate || Date.now()).getTime())) / 86400000))),
        durationDays: Math.ceil(((new Date(campaign.endDate || Date.now()).getTime()) - (new Date(campaign.startDate || Date.now()).getTime())) / 86400000) || 1,
        totalPrice: campaign.budget,
        platformFee: splitRadioCampaignAmount(campaign.budget || 0).platformFee,
        stationPayout: splitRadioCampaignAmount(campaign.budget || 0).stationPayout,
        timeSlots: campaign.timeSlots,
        // Платная кампания видна радио только ПОСЛЕ оплаты: создаём заявку
        // как 'pending_payment' (радио её не видит и не может одобрить),
        // webhook checkout radio_campaign переведёт в 'pending' после
        // успешной оплаты. Бесплатная (budget<=0) — сразу 'pending'.
        status: (Number(campaign.budget) || 0) > 0 ? 'pending_payment' : 'pending',
        submittedAt: new Date().toISOString(),
      };

      try {
        // Atomic INSERTs — race-free vs legacy get+push+set (которое могло
        // потерять concurrent venue request от другого канала).
        await insertRadioVenueRequest({ ...venueRequest, radioId: campaign.stationId });

        // Push notification to radio station.
        await insertRadioNotification({
          radioId: campaign.stationId,
          id: `notif-${Date.now()}`,
          type: 'venue_request',
          title: 'New ad campaign request',
          message: `${profile.name || 'A venue'} wants to run ads (${campaign.budget} RUB)`,
          priority: 'high',
          read: false,
          relatedId: campaign.id,
          createdAt: new Date().toISOString(),
        });
      } catch (e) {
        console.error('Error pushing venue request to radio:', e);
      }
    }

    // Email notification to admin
    notifyVenueRequest({
      venueName: profile?.name || 'Unknown',
      venueCity: profile?.city || '',
      packageType: campaign.packageType || '',
      totalPrice: campaign.budget || 0,
      stationId: campaign.stationId || '',
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

    // Atomic UPDATE — race-free vs legacy get→find→mutate→set.
    const updated = await updateVenueAdCampaign(campaignId, {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.audioUrl !== undefined ? { audioUrl: body.audioUrl } : {}),
      ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
      ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
      ...(body.targetPlays !== undefined ? { targetPlays: body.targetPlays } : {}),
      ...(body.totalPlays !== undefined ? { totalPlays: body.totalPlays } : {}),
      ...(body.budget !== undefined ? { budget: body.budget } : {}),
      ...(body.spent !== undefined ? { spent: body.spent } : {}),
      ...(body.impressions !== undefined ? { impressions: body.impressions } : {}),
      ...(body.timeSlots !== undefined ? { timeSlots: body.timeSlots } : {}),
      ...(body.packageType !== undefined ? { packageType: body.packageType } : {}),
    });
    if (!updated || updated.venueId !== profile.id) {
      return c.json({ error: 'Campaign not found' }, 404);
    }

    return c.json({ success: true, campaign: updated });
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

    const data = await getVenueRadioBrand(profile.id);
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
    // Atomic jsonb || merge — race-free vs legacy get+merge+set паттерн.
    const updated = await patchVenueRadioBrand(profile.id, body);

    return c.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Error updating radio brand:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================
// BOOKINGS LIST (for Venue cabinet)
// =====================================================


// -- Campaign Status (combined venue + radio side) --
app.get('/radio-campaigns/:id/status', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await getVenueProfile(userId);
    if (!profile) return c.json({ success: false, error: 'Venue profile not found' }, 404);
    const campaignId = c.req.param('id');
    const { getVenueAdCampaign } = await import('./db.tsx');
    const campaign = await getVenueAdCampaign(campaignId);
    if (!campaign || campaign.venueId !== profile.id) {
      return c.json({ success: false, error: 'Campaign not found' }, 404);
    }

    let radioStatus = null;
    let pricing = null;
    try {
      // Phase D KV→SQL closeout: Store facade удалён, использован
      // explicit listRadioVenueRequestsByStation. Same shape (array).
      const requests = await listRadioVenueRequestsByStation(campaign.stationId);
      const radioReq = requests.find((r: any) => r.campaignId === campaignId || r.id === campaignId);
      if (radioReq) {
        radioStatus = {
          status: radioReq.status || 'pending',
          reviewedAt: radioReq.reviewedAt || null,
          approvedAt: radioReq.approvedAt || null,
          completedAt: radioReq.completedAt || null,
          totalPlays: radioReq.totalPlays || 0,
          completedPlays: radioReq.completedPlays || 0,
          impressions: radioReq.impressions || 0,
          rejectionReason: radioReq.rejectionReason || null,
        };
        const baseAmount = radioReq.totalPrice || campaign.budget || 0;
        const discountAmount = radioReq.discountAmount || 0;
        const paymentAmount = baseAmount - discountAmount;
        // Commission applies on the post-discount paymentAmount, not the base.
        const {
          platformFee: commissionAmount,
          stationPayout: netAmountToRadio,
          rate: commissionRate,
        } = splitRadioCampaignAmount(paymentAmount);
        pricing = { baseAmount, discountAmount, paymentAmount, commissionAmount, netAmountToRadio, commissionRate };
      }
    } catch (_) { /* radio side may not exist yet */ }

    return c.json({
      success: true,
      campaignId,
      venueStatus: campaign.status || 'active',
      radioStatus,
      pricing,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

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

// ── POST /cron/expire-trials ──────────────────────────────────────
// Cron endpoint that processes venue 14-day-trial expirations and
// warnings. Same auth pattern as /subscriptions/charge-recurring:
// the caller (systemd timer / external scheduler) must send the
// CRON_SECRET via header `X-Cron-Secret` (or `Authorization: Bearer
// <secret>`). Without a configured CRON_SECRET env the endpoint
// refuses requests with 500 — never falls back to "open if no
// secret set".
app.post('/cron/expire-trials', async (c) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[venue/cron] CRON_SECRET env var not set');
    return c.json({ success: false, error: 'Server misconfiguration' }, 500);
  }
  const provided = c.req.header('X-Cron-Secret') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (provided !== expected) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  try {
    const result = await expireTrialsOnce();
    return c.json({ success: true, ...result });
  } catch (err: any) {
    console.error('[venue/cron] expire-trials failed:', err?.message);
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

export default app;
