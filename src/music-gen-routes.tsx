/**
 * MUSIC GENERATION ROUTES
 * Proxy to ACE-Step music generation service (via RunPod Serverless)
 * Endpoints for generating background music, jingles, and managing the generated library.
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const MUSIC_GEN_URL = process.env.MUSIC_GEN_URL || 'http://127.0.0.1:8084';

const musicGen = new Hono();

// ─── Health check ────────────────────────────

musicGen.get('/health', async (c) => {
  try {
    const resp = await fetch(`${MUSIC_GEN_URL}/health`);
    const data = await resp.json();
    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: 'Music generation service unavailable' }, 503);
  }
});

// ─── Generate music ────────────────────────────

musicGen.post('/generate', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { prompt, genre, mood, lyrics, duration, seed } = body;

    if (!prompt && !genre) {
      return c.json({ success: false, error: 'Prompt or genre required' }, 400);
    }

    const resp = await fetch(`${MUSIC_GEN_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt || '',
        genre: genre || '',
        mood: mood || '',
        lyrics: lyrics || '',
        duration: Math.min(Math.max(duration || 30, 5), 240),
        seed: seed ?? -1,
      }),
    });

    const data = await resp.json();
    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: 'Generation request failed' }, 500);
  }
});

// ─── Check job status ────────────────────────────

musicGen.get('/status/:jobId', requireAuth, async (c) => {
  try {
    const jobId = c.req.param('jobId');
    const resp = await fetch(`${MUSIC_GEN_URL}/status/${jobId}`);
    if (resp.status === 404) {
      return c.json({ success: false, error: 'Job not found' }, 404);
    }
    const data = await resp.json();
    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: 'Status check failed' }, 500);
  }
});

// ─── Generated music library ────────────────────────────

musicGen.get('/library', async (c) => {
  try {
    const genre = c.req.query('genre') || '';
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    const url = new URL(`${MUSIC_GEN_URL}/library`);
    if (genre) url.searchParams.set('genre', genre);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const resp = await fetch(url.toString());
    const data = await resp.json();
    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: 'Library fetch failed' }, 500);
  }
});

// ─── Available genres ────────────────────────────

musicGen.get('/genres', async (c) => {
  const genres = [
    { id: 'ambient', name: 'Ambient', desc: 'Спокойная атмосферная музыка' },
    { id: 'jazz', name: 'Jazz', desc: 'Джаз для ресторанов и кафе' },
    { id: 'lounge', name: 'Lounge', desc: 'Лаундж для баров и отелей' },
    { id: 'chill', name: 'Chill', desc: 'Расслабленная фоновая музыка' },
    { id: 'electronic', name: 'Electronic', desc: 'Электронная музыка' },
    { id: 'classical', name: 'Classical', desc: 'Классика для элитных заведений' },
    { id: 'bossa', name: 'Bossa Nova', desc: 'Бразильская бossa nova' },
    { id: 'soul', name: 'Soul', desc: 'Соул и R&B' },
    { id: 'funk', name: 'Funk', desc: 'Фанк и грув' },
    { id: 'jingle', name: 'Jingle', desc: 'Радио-джинглы и бамперы' },
    { id: 'news', name: 'News', desc: 'Новостные заставки' },
    { id: 'transition', name: 'Transition', desc: 'Переходы между треками' },
  ];
  return c.json({ success: true, data: genres });
});

export default musicGen;
