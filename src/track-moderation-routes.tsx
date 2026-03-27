/**
 * TRACK MODERATION ROUTES v2 — Uses typed `tracks` table
 * Approve → status='published' + award coins (REAL)
 * One table, one row per track. No separate moderation store.
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import * as typed from './db-typed.tsx';

const app = new Hono();

const GENRES = [
  'Pop', 'Rock', 'Hip-Hop', 'R&B', 'Electronic', 'Dance',
  'House', 'Techno', 'Trance', 'Dubstep', 'Drum & Bass',
  'Jazz', 'Blues', 'Classical', 'Country', 'Folk',
  'Reggae', 'Afrobeat', 'Metal', 'Punk', 'Indie', 'Alternative',
  'Soul', 'Funk', 'Disco', 'Gospel', 'Latin', 'World'
];

const COINS_ON_APPROVE = 50;

// POST /submitTrack — Submit track for moderation
app.post('/submitTrack', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();

    const track = await typed.insertTrack({
      title: body.title || '',
      artist_name: body.artist || '',
      genre: body.genre || '',
      duration: body.duration || 0,
      audio_url: body.audio_file_url || body.audio_url || '',
      cover_url: body.cover_image_url || body.cover_url || '',
      yandex_music_url: body.yandex_music_url || '',
      youtube_url: body.youtube_url || '',
      spotify_url: body.spotify_url || '',
      uploaded_by_email: body.uploaded_by_email || '',
      user_id: body.uploaded_by_user_id || body.user_id || null,
      moderation_status: 'pending',
    });

    if (!track) {
      return c.json({ error: 'Failed to create track' }, 500);
    }

    return c.json({
      success: true,
      pending_track_id: track.id,
      message: 'Трек отправлен на модерацию'
    });
  } catch (error) {
    console.error('Error in submitTrack:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /pendingTracks — Get tracks by status with filters
app.get('/pendingTracks', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'pending';
    const genre = c.req.query('genre');
    const search = c.req.query('search');

    const tracks = await typed.getAllTracksForModeration({
      status: status === 'all' ? undefined : status,
      genre: genre || undefined,
      search: search || undefined,
    });

    // Map to frontend-expected format
    const mapped = tracks.map((t: any) => ({
      id: t.id,
      title: t.title,
      artist: t.artist_name || '',
      cover_image_url: t.cover_url || '',
      audio_file_url: t.audio_url || '',
      duration: t.duration || 0,
      genre: t.genre || '',
      yandex_music_url: t.yandex_music_url || '',
      youtube_url: t.youtube_url || '',
      spotify_url: t.spotify_url || '',
      uploaded_by_email: t.uploaded_by_email || '',
      uploaded_by_user_id: t.user_id || '',
      moderation_status: t.moderation_status,
      overall_score: t.data?.overall_score || null,
      moderator_notes: t.moderation_comment || null,
      rejection_reason: t.rejection_reason || null,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    return c.json({ tracks: mapped });
  } catch (error) {
    console.error('Error in pendingTracks:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /manageTrackModeration — Approve or reject a track
app.post('/manageTrackModeration', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { pendingTrackId, action, moderator_notes, rejection_reason, overall_score } = body;

    const track = await typed.getTrackById(pendingTrackId);
    if (!track) {
      return c.json({ error: 'Track not found' }, 404);
    }

    const now = new Date().toISOString();

    if (action === 'approve') {
      // Update track status to published (visible on public pages!)
      await typed.updateTrack(pendingTrackId, {
        moderation_status: 'published',
        moderation_comment: moderator_notes || 'Трек одобрен',
        moderated_at: now,
        is_hidden: false,
        data: { ...(track.data || {}), overall_score: overall_score || null },
      });

      // REAL coin award
      let coinsAwarded = 0;
      if (track.user_id) {
        const newBalance = await typed.awardCoins(
          track.user_id,
          COINS_ON_APPROVE,
          `Трек "${track.title}" одобрен модерацией`
        );
        coinsAwarded = COINS_ON_APPROVE;
        console.log(`[moderation] Track ${pendingTrackId} approved. ${coinsAwarded} coins awarded to ${track.user_id}`);
      }

      return c.json({
        success: true,
        message: 'Трек одобрен и опубликован',
        trackId: pendingTrackId,
        coinsAwarded,
        published: true,
      });

    } else if (action === 'reject') {
      await typed.updateTrack(pendingTrackId, {
        moderation_status: 'rejected',
        rejection_reason: rejection_reason || '',
        moderation_comment: moderator_notes || null,
        moderated_at: now,
      });

      return c.json({
        success: true,
        message: 'Трек отклонён'
      });

    } else {
      return c.json({ error: 'Invalid action' }, 400);
    }
  } catch (error) {
    console.error('Error in manageTrackModeration:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /batchModeration — Batch approve/reject
app.post('/batchModeration', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { trackIds, action } = body;
    const now = new Date().toISOString();

    const results = [];
    for (const trackId of trackIds) {
      const track = await typed.getTrackById(trackId);
      if (!track) {
        results.push({ trackId, success: false, message: 'Not found' });
        continue;
      }

      if (action === 'approve') {
        await typed.updateTrack(trackId, {
          moderation_status: 'published',
          moderated_at: now,
          is_hidden: false,
        });
        // Award coins
        if (track.user_id) {
          await typed.awardCoins(track.user_id, COINS_ON_APPROVE, `Трек "${track.title}" одобрен`);
        }
      } else {
        await typed.updateTrack(trackId, {
          moderation_status: 'rejected',
          moderated_at: now,
        });
      }

      results.push({ trackId, success: true, message: `${action} successful` });
    }

    return c.json({
      success: true,
      message: `Processed ${trackIds.length} tracks`,
      results
    });
  } catch (error) {
    console.error('Error in batchModeration:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /genres
app.get('/genres', requireAuth, requireAdmin, async (c) => {
  return c.json({ genres: GENRES });
});

// GET /uploadStats
app.get('/uploadStats', requireAuth, requireAdmin, async (c) => {
  try {
    return c.json({
      current: 0,
      limit: 10,
      remaining: 10,
      subscription: 'artist_pro'
    });
  } catch (error) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /stats — Moderation statistics
app.get('/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const stats = await typed.getTrackModerationStats();
    return c.json(stats);
  } catch (error) {
    console.error('Error in stats:', error);
    return c.json({ total: 0, pending: 0, approved: 0, rejected: 0 });
  }
});


// ─── Public: New Releases with YouTube playback ─────────────
app.get('/newReleases', requireAuth, requireAdmin, async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '25');
    const { platformStatsStore } = await import('./db.tsx');
    const cached: any = await platformStatsStore.get('tracks:new_releases');
    if (cached?.tracks?.length) {
      return c.json({ success: true, releases: cached.tracks.slice(0, limit) });
    }
    return c.json({ success: true, releases: [] });
  } catch (error) {
    console.error('Error fetching new releases:', error);
    return c.json({ success: true, releases: [] });
  }
});

export default app;
