/**
 * TRACKS ROUTES v2 — Uses typed `tracks` table
 * Artist CRUD for their own tracks
 */

import { Hono } from 'hono';
import * as typed from './db-typed.tsx';
import { getDbClient, pool } from './db-client.tsx';
import { resolveUserId } from './resolve-user-id.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { notifyTrackUpload } from './email-helper.tsx';

const tracksRoutes = new Hono();
// No demo fallback — all endpoints require auth

// GET / — Get all tracks for current user
tracksRoutes.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const tracks = await typed.getTracksByUser(userId);
    return c.json({ success: true, data: tracks });
  } catch (error) {
    console.error('Error in GET /tracks:', error);
    return c.json({ success: true, data: [] });
  }
});

// GET /:id — Get single track
tracksRoutes.get('/:id', async (c) => {
  try {
    const trackId = c.req.param('id');
    const track = await typed.getTrackById(trackId);
    if (!track) {
      return c.json({ success: false, error: 'Track not found' }, 404);
    }
    return c.json({ success: true, data: track });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST / — Create new track
tracksRoutes.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');

    // REQUIRE artist profile before track submission
    const profile = await getDbClient().from('artist_profiles').select('id').eq('user_id', userId).maybeSingle();
    if (!profile?.data) {
      return c.json({ success: false, error: 'Сначала заполните профиль артиста в личном кабинете', code: 'PROFILE_REQUIRED' }, 403);
    }

    const body = await c.req.json();

    const track = await typed.insertTrack({
      ...body,
      user_id: userId,
      artist_name: body.artist || body.artist_name || '',
      audio_url: body.audioUrl || body.audio_url || body.audio_file_url || body.audioFile || body.audio || '',
      cover_url: body.coverUrl || body.cover_url || body.cover_image_url || body.cover || '',
      moderation_status: body.status || 'draft',
    });

    if (!track) {
      return c.json({ success: false, error: 'Failed to create track' }, 500);
    }

    // Fire-and-forget: trigger Promo.check fingerprinting in background
    if (track.audio_url) {
      fetch(`http://127.0.0.1:3000/server/api/promo-check/process/${track.id}`, { method: 'POST' })
        .catch(() => {}); // non-blocking
    }

    // Notify admin (email + Telegram). Resolve email/name from users so
    // admins see a real identity instead of "anonymous". Fire-and-forget —
    // the upload itself must not fail because the SMTP / Telegram side is
    // down.
    (async () => {
      try {
        const { rows } = await pool.query(
          'SELECT email, full_name, display_name FROM users WHERE id = $1 LIMIT 1',
          [userId],
        );
        const u = rows[0] || {};
        await notifyTrackUpload({
          title: track.title || body.title || 'Без названия',
          artist: u.full_name || u.display_name || track.artist_name || body.artist || body.artist_name || 'Артист',
          genre: track.genre || body.genre,
          email: u.email || c.get('userEmail') || undefined,
          userId,
        });
      } catch (notifyErr) {
        console.error('[tracks] admin notify failed:', notifyErr);
      }
    })();

    return c.json({ success: true, data: track }, 201);
  } catch (error) {
    console.error('Error in POST /tracks:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /:id — Update track (ownership check: only track owner can edit)
tracksRoutes.put('/:id', requireAuth, async (c) => {
  try {
    const trackId = c.req.param('id');
    const userId = c.get('userId');
    const body = await c.req.json();

    // Ownership check
    const existing = await typed.getTrackById(trackId);
    if (!existing) {
      return c.json({ success: false, error: 'Track not found' }, 404);
    }
    if (existing.user_id && existing.user_id !== userId) {
      return c.json({ success: false, error: 'Not authorized to edit this track' }, 403);
    }

    const track = await typed.updateTrack(trackId, body);
    return c.json({ success: true, data: track });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /:id — Delete track (ownership check: only track owner can delete)
tracksRoutes.delete('/:id', requireAuth, async (c) => {
  try {
    const trackId = c.req.param('id');
    const userId = c.get('userId');

    // Ownership check
    const existing = await typed.getTrackById(trackId);
    if (!existing) {
      return c.json({ success: false, error: 'Track not found' }, 404);
    }
    if (existing.user_id && existing.user_id !== userId) {
      return c.json({ success: false, error: 'Not authorized to delete this track' }, 403);
    }

    await typed.deleteTrack(trackId);
    return c.json({ success: true, message: 'Track deleted' });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default tracksRoutes;

// GET /radio-stats — Radio pickup stats for user's tracks (station count + city count)
tracksRoutes.get('/radio-stats/all', async (c) => {
  try {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);
    const { pool } = await import('./db-client.tsx');
    
    // Get radio stats — try by user_id first, fallback to all tracks with pickups
    let result = await pool.query(`
      SELECT 
        t.id as track_id,
        COUNT(DISTINCT trp.station_name) as radio_count,
        COUNT(DISTINCT trp.city) as city_count
      FROM tracks t
      LEFT JOIN track_radio_pickups trp ON trp.track_id = t.id
      WHERE t.user_id = \$1
      GROUP BY t.id
      HAVING COUNT(DISTINCT trp.station_name) > 0
    `, [userId]);
    
    // Fallback: if no results by user_id, return all tracks with radio pickups
    if (result.rows.length === 0) {
      result = await pool.query(`
        SELECT 
          trp.track_id,
          COUNT(DISTINCT trp.station_name) as radio_count,
          COUNT(DISTINCT trp.city) as city_count
        FROM track_radio_pickups trp
        GROUP BY trp.track_id
      `);
    }
    
    // Convert to map: { trackId: { radioCount, cityCount } }
    const stats: Record<string, { radioCount: number; cityCount: number }> = {};
    for (const row of result.rows) {
      stats[row.track_id] = {
        radioCount: parseInt(row.radio_count) || 0,
        cityCount: parseInt(row.city_count) || 0,
      };
    }
    
    return c.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error in GET /tracks/radio-stats/all:', error);
    return c.json({ success: true, data: {} });
  }
});
