/**
 * ПРОМО.ГИД API ROUTES - KV-based
 * 
 * Публичные endpoints БЕЗ авторизации:
 * - GET  /public/guide/venues       - список заведений (фильтры: city, type, genre, onlyOpen, onlyWithMusic)
 * - GET  /public/guide/venues/:id   - детали заведения
 * - GET  /public/guide/live-feed    - что играет сейчас (все venue с now_playing)
 * - GET  /public/guide/cities       - доступные города
 * - GET  /public/guide/genres       - доступные жанры
 */

import { Hono } from 'hono';
import { guideDataStore } from './db.tsx';

const app = new Hono();

// Helper: загрузить все venue из KV
async function loadAllVenues(): Promise<any[]> {
  try {
    const idsRaw = await guideDataStore.get('guide:venue_ids');
    if (!idsRaw) return [];
    const ids: string[] = Array.isArray(idsRaw) ? idsRaw : (typeof idsRaw === 'string' ? JSON.parse(idsRaw) : []);
    if (!ids.length) return [];

    const values = await Promise.all(ids.map((id: string) => guideDataStore.get(`guide:venue:${id}`)));
    return values
      .filter((v: any) => v !== null && v !== undefined)
      .map((v: any) => typeof v === 'string' ? JSON.parse(v) : v);
  } catch (error) {
    console.error('Error loading guide venues from KV:', error);
    return [];
  }
}

// ==============================================
// GET /public/guide/venues
// ==============================================
app.get('/public/guide/venues', async (c) => {
  try {
    const city = c.req.query('city');
    const type = c.req.query('type');
    const genre = c.req.query('genre');
    const onlyWithMusic = c.req.query('onlyWithMusic') === 'true';
    const onlyOpen = c.req.query('onlyOpen') === 'true';
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    let venues = await loadAllVenues();

    // Filters
    if (city) venues = venues.filter(v => v.city === city);
    if (type) venues = venues.filter(v => v.type === type);
    if (genre) venues = venues.filter(v => v.genres?.includes(genre));
    if (onlyOpen) venues = venues.filter(v => v.isOpen);
    if (onlyWithMusic) venues = venues.filter(v => v.nowPlaying !== null);

    // Pagination
    const total = venues.length;
    venues = venues.slice(offset, offset + limit);

    return c.json({
      success: true,
      data: venues,
      meta: { total, limit, offset },
    });
  } catch (error) {
    console.error('Error in /public/guide/venues:', error);
    return c.json({ error: 'Internal server error', details: String(error) }, 500);
  }
});

// ==============================================
// GET /public/guide/venues/:id
// ==============================================
app.get('/public/guide/venues/:id', async (c) => {
  try {
    const venueId = c.req.param('id');
    const raw = await guideDataStore.get(`guide:venue:${venueId}`);
    if (!raw) {
      return c.json({ error: 'Venue not found' }, 404);
    }
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return c.json({ success: true, data });
  } catch (error) {
    console.error('Error in /public/guide/venues/:id:', error);
    return c.json({ error: 'Internal server error', details: String(error) }, 500);
  }
});

// ==============================================
// GET /public/guide/live-feed
// Что играет ПРЯМО СЕЙЧАС
// ==============================================
app.get('/public/guide/live-feed', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const venues = await loadAllVenues();

    const liveFeed = venues
      .filter(v => v.nowPlaying !== null && v.isOpen)
      .slice(0, limit)
      .map(v => ({
        venueId: v.id,
        venueName: v.name,
        venueType: v.type,
        city: v.city,
        genres: v.genres,
        rating: v.rating,
        verified: v.verified,
        premium: v.premium,
        nowPlaying: v.nowPlaying,
      }));

    return c.json({
      success: true,
      data: liveFeed,
      meta: { total: liveFeed.length, timestamp: new Date().toISOString() },
    });
  } catch (error) {
    console.error('Error in /public/guide/live-feed:', error);
    return c.json({ error: 'Internal server error', details: String(error) }, 500);
  }
});

// ==============================================
// GET /public/guide/cities
// Уникальные города
// ==============================================
app.get('/public/guide/cities', async (c) => {
  try {
    const venues = await loadAllVenues();
    const cityMap = new Map<string, number>();
    for (const v of venues) {
      cityMap.set(v.city, (cityMap.get(v.city) || 0) + 1);
    }
    const cities = Array.from(cityMap.entries()).map(([name, count]) => ({ name, count }));
    cities.sort((a, b) => b.count - a.count);

    return c.json({ success: true, data: cities });
  } catch (error) {
    return c.json({ error: 'Internal server error', details: String(error) }, 500);
  }
});

// ==============================================
// GET /public/guide/genres
// Уникальные жанры
// ==============================================
app.get('/public/guide/genres', async (c) => {
  try {
    const venues = await loadAllVenues();
    const genreMap = new Map<string, number>();
    for (const v of venues) {
      for (const g of (v.genres || [])) {
        genreMap.set(g, (genreMap.get(g) || 0) + 1);
      }
    }
    const genres = Array.from(genreMap.entries()).map(([name, count]) => ({ name, count }));
    genres.sort((a, b) => b.count - a.count);

    return c.json({ success: true, data: genres });
  } catch (error) {
    return c.json({ error: 'Internal server error', details: String(error) }, 500);
  }
});

export default app;