/**
 * ПРОМО.ГИД API ROUTES
 *
 * promo_guide_data table — dead store (0 writers anywhere в codebase). Все
 * endpoints возвращают empty results, как и до cleanup. Сохранены для API
 * compatibility; реактивируются после implementation реального data writer
 * (Promo.Guide feature roadmap TBD).
 *
 * Публичные endpoints БЕЗ авторизации:
 * - GET  /public/guide/venues       - список заведений (пока пусто)
 * - GET  /public/guide/venues/:id   - детали заведения (404)
 * - GET  /public/guide/live-feed    - что играет сейчас (пока пусто)
 * - GET  /public/guide/cities       - доступные города (пусто)
 * - GET  /public/guide/genres       - доступные жанры (пусто)
 */

import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';

const app = new Hono();

app.get('/public/guide/venues', requireAuth, async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  return c.json({ success: true, data: [], meta: { total: 0, limit, offset } });
});

app.get('/public/guide/venues/:id', requireAuth, async (c) => {
  return c.json({ error: 'Venue not found' }, 404);
});

app.get('/public/guide/live-feed', requireAuth, async (c) => {
  return c.json({
    success: true, data: [],
    meta: { total: 0, timestamp: new Date().toISOString() },
  });
});

app.get('/public/guide/cities', requireAuth, async (c) => {
  return c.json({ success: true, data: [] });
});

app.get('/public/guide/genres', requireAuth, async (c) => {
  return c.json({ success: true, data: [] });
});

export default app;
