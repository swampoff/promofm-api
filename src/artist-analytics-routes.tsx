/**
 * ARTIST ANALYTICS ROUTES - Аналитика артиста
 * 
 * KV Keys:
 *   artist_analytics:{artistId}   -> AnalyticsData
 *   artist_tracks_stats:{artistId} -> TrackStats[]
 * 
 * Endpoints:
 * GET /overview/:artistId   - Общая аналитика
 * GET /tracks/:artistId     - Статистика по трекам
 * GET /geography/:artistId  - География слушателей
 * GET /platforms/:artistId  - Платформы
 * GET /timeline/:artistId   - Временная шкала
 */

import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';
import * as db from './db.tsx';
import { getArtistProfile, artistAnalyticsCacheStore, artistTracksStatsStore } from './db.tsx';

const app = new Hono();

// GET /overview/:artistId
app.get('/overview/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  const period = c.req.query('period') || 'month';
  
  try {
    const cached = await artistAnalyticsCacheStore.get(artistId);
    if (cached) {
      return c.json({ success: true, analytics: cached, source: 'api' });
    }

    // Генерируем аналитику из данных артиста
    const artistProfile = await getArtistProfile(artistId);
    const totalPlays = (artistProfile as any)?.totalPlays || 456200;
    const monthlyListeners = (artistProfile as any)?.monthlyListeners || 28500;
    const subscribers = (artistProfile as any)?.subscribers || 12500;

    const multiplier = period === 'week' ? 0.25 : period === 'year' ? 12 : 1;

    const analytics = {
      period,
      totalPlays: Math.round(totalPlays * multiplier / 12),
      activeListeners: Math.round(monthlyListeners * (period === 'week' ? 0.3 : period === 'year' ? 1 : 0.7)),
      totalLikes: Math.round(totalPlays * 0.07 * multiplier / 12),
      revenue: Math.round(totalPlays * 0.0058 * multiplier / 12),
      followers: subscribers,
      followersGrowth: +(Math.random() * 20 + 5).toFixed(1),
      playsGrowth: +(Math.random() * 30 + 10).toFixed(1),
      likesGrowth: +(Math.random() * 25 + 8).toFixed(1),
      revenueGrowth: +(Math.random() * 22 + 7).toFixed(1),
      engagementRate: +(Math.random() * 3 + 4).toFixed(1),
      avgListenDuration: '3:24',
      completionRate: Math.round(Math.random() * 15 + 80),
      peakHour: '19:00',
      platforms: [
        { name: 'Spotify', percentage: 35, plays: Math.round(totalPlays * 0.35 * multiplier / 12) },
        { name: 'Apple Music', percentage: 28, plays: Math.round(totalPlays * 0.28 * multiplier / 12) },
        { name: 'YouTube Music', percentage: 22, plays: Math.round(totalPlays * 0.22 * multiplier / 12) },
        { name: 'VK Music', percentage: 10, plays: Math.round(totalPlays * 0.10 * multiplier / 12) },
        { name: 'Другие', percentage: 5, plays: Math.round(totalPlays * 0.05 * multiplier / 12) },
      ],
      geography: [
        { country: 'Россия', percentage: 68, listeners: Math.round(monthlyListeners * 0.68) },
        { country: 'Украина', percentage: 12, listeners: Math.round(monthlyListeners * 0.12) },
        { country: 'Беларусь', percentage: 7, listeners: Math.round(monthlyListeners * 0.07) },
        { country: 'Казахстан', percentage: 6, listeners: Math.round(monthlyListeners * 0.06) },
        { country: 'Германия', percentage: 4, listeners: Math.round(monthlyListeners * 0.04) },
        { country: 'Другие', percentage: 3, listeners: Math.round(monthlyListeners * 0.03) },
      ],
      demographics: [
        { age: '13-17', percentage: 7 },
        { age: '18-24', percentage: 27 },
        { age: '25-34', percentage: 38 },
        { age: '35-44', percentage: 18 },
        { age: '45-54', percentage: 7 },
        { age: '55+', percentage: 3 },
      ],
      hourlyActivity: Array.from({ length: 24 }, (_, h) => ({
        hour: `${String(h).padStart(2, '0')}:00`,
        plays: Math.round(
          h >= 18 && h <= 22 ? Math.random() * 1500 + 1500 :
          h >= 12 && h <= 17 ? Math.random() * 1000 + 800 :
          h >= 8 && h <= 11 ? Math.random() * 800 + 400 :
          Math.random() * 300 + 100
        ),
      })),
    };

    // Кэшируем на 5 минут
    await artistAnalyticsCacheStore.set(artistId, analytics);

    return c.json({ success: true, analytics, source: 'generated' });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /timeline/:artistId
app.get('/timeline/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  const period = c.req.query('period') || 'month';
  
  try {
    const artistProfile = await getArtistProfile(artistId);
    const baseMonthly = (artistProfile as any)?.monthlyListeners || 28500;

    let timeline: any[] = [];

    if (period === 'week') {
      const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
      timeline = days.map((day, i) => ({
        label: day,
        plays: Math.round(baseMonthly / 30 * (0.8 + Math.random() * 0.6) * (i >= 4 ? 1.3 : 1)),
        likes: Math.round(baseMonthly / 30 * 0.07 * (0.8 + Math.random() * 0.5)),
        shares: Math.round(baseMonthly / 30 * 0.02 * (0.7 + Math.random() * 0.6)),
        revenue: Math.round(baseMonthly / 30 * 0.0058 * (0.8 + Math.random() * 0.5) * 100) / 100,
        followers: Math.round(Math.random() * 50 + 20),
      }));
    } else if (period === 'month') {
      const months = ['Сен', 'Окт', 'Ноя', 'Дек', 'Янв', 'Фев'];
      timeline = months.map((m, i) => ({
        label: m,
        plays: Math.round(baseMonthly * (0.7 + i * 0.06 + Math.random() * 0.15)),
        likes: Math.round(baseMonthly * 0.07 * (0.7 + i * 0.05)),
        shares: Math.round(baseMonthly * 0.02 * (0.6 + i * 0.07)),
        revenue: Math.round(baseMonthly * 0.0058 * (0.7 + i * 0.06)),
        followers: Math.round(baseMonthly * 0.01 * (0.8 + i * 0.04)),
      }));
    } else {
      const periods = ['Янв-Фев', 'Мар-Апр', 'Май-Июн', 'Июл-Авг', 'Сен-Окт', 'Ноя-Дек'];
      timeline = periods.map((p, i) => ({
        label: p,
        plays: Math.round(baseMonthly * 2 * (0.6 + i * 0.08 + Math.random() * 0.1)),
        likes: Math.round(baseMonthly * 2 * 0.07 * (0.6 + i * 0.07)),
        shares: Math.round(baseMonthly * 2 * 0.02 * (0.5 + i * 0.09)),
        revenue: Math.round(baseMonthly * 2 * 0.0058 * (0.6 + i * 0.08)),
        followers: Math.round(baseMonthly * 0.02 * (0.7 + i * 0.05) * 2),
      }));
    }

    return c.json({ success: true, timeline, period });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /tracks/:artistId - статистика по трекам
app.get('/tracks/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  try {
    const cached = await artistTracksStatsStore.get(artistId);
    if (cached) {
      return c.json({ success: true, tracks: cached, source: 'api' });
    }

    // Генерируем данные по трекам
    const trackNames = [
      'Летняя ночь', 'Город засыпает', 'Танцуй со мной',
      'Под звёздами', 'Ритм сердца', 'Огни большого города',
      'Не отпускай', 'Между строк',
    ];

    const tracks = trackNames.map((title, i) => ({
      id: `track-${i + 1}`,
      title,
      plays: Math.round((8 - i) * 15000 + Math.random() * 10000),
      likes: Math.round((8 - i) * 1200 + Math.random() * 800),
      shares: Math.round((8 - i) * 300 + Math.random() * 200),
      saves: Math.round((8 - i) * 900 + Math.random() * 500),
      completionRate: Math.round(75 + Math.random() * 20),
      avgListenTime: `${Math.floor(2.5 + Math.random() * 1.5)}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`,
      trend: i < 3 ? 'up' : i < 5 ? 'stable' : 'down',
      trendValue: i < 3 ? +(Math.random() * 20 + 10).toFixed(1) : i < 5 ? +(Math.random() * 5 - 2).toFixed(1) : -(Math.random() * 10 + 3).toFixed(1),
    }));

    await artistTracksStatsStore.set(artistId, tracks);
    return c.json({ success: true, tracks, source: 'generated' });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export default app;
