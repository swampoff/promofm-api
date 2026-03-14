/**
 * TRACKS ROUTES v2 — Uses typed `tracks` table
 * Artist CRUD for their own tracks
 */

import { Hono } from 'hono';
import * as typed from './db-typed.tsx';
import { resolveUserId } from './resolve-user-id.tsx';

const tracksRoutes = new Hono();
const FALLBACK_USER = 'anonymous';

// GET / — Get all tracks for current user
tracksRoutes.get('/', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
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
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// POST / — Create new track
tracksRoutes.post('/', async (c) => {
  try {
    const userId = await resolveUserId(c, FALLBACK_USER);
    const body = await c.req.json();

    const track = await typed.insertTrack({
      ...body,
      user_id: userId,
      artist_name: body.artist || body.artist_name || '',
      audio_url: body.audioUrl || body.audio_url || body.audio_file_url || '',
      cover_url: body.coverUrl || body.cover_url || body.cover_image_url || '',
      moderation_status: body.status || 'draft',
    });

    if (!track) {
      return c.json({ success: false, error: 'Failed to create track' }, 500);
    }

    return c.json({ success: true, data: track }, 201);
  } catch (error) {
    console.error('Error in POST /tracks:', error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// PUT /:id — Update track
tracksRoutes.put('/:id', async (c) => {
  try {
    const trackId = c.req.param('id');
    const body = await c.req.json();

    const track = await typed.updateTrack(trackId, body);
    if (!track) {
      return c.json({ success: false, error: 'Track not found' }, 404);
    }

    return c.json({ success: true, data: track });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// DELETE /:id — Delete track
tracksRoutes.delete('/:id', async (c) => {
  try {
    const trackId = c.req.param('id');
    await typed.deleteTrack(trackId);
    return c.json({ success: true, message: 'Track deleted' });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default tracksRoutes;
