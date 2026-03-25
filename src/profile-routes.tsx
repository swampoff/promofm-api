import { Hono } from 'hono';
import * as db from './db.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { safeErrorMessage } from './security.tsx';

const profileRoutes = new Hono();
const FALLBACK_USER = 'anonymous';

// GET /profile
profileRoutes.get('/', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const profile = await db.getProfile(userId);
    return c.json({
      success: true,
      data: profile || {
        userId,
        name: 'New Artist',
        subscribers: 0,
        totalPlays: 0,
        totalTracks: 0,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /profile
profileRoutes.put('/', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const body = await c.req.json();
    const existing = await db.getProfile(userId);
    const updated = {
      ...(existing || { userId, subscribers: 0, totalPlays: 0, totalTracks: 0 }),
      ...body,
      userId,
      updatedAt: new Date().toISOString(),
    };
    await db.upsertProfile(userId, updated);
    return c.json({ success: true, data: updated });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default profileRoutes;
