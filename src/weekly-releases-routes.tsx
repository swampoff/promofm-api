/**
 * WEEKLY RELEASES ROUTES — "Пятница" (Friday Release System)
 * Public endpoints for weekly track releases with radio pickup indicators
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const app = new Hono();

// ── Helper: get DB pool ──
async function getPool() {
  const { pool } = await import('./db-client.tsx');
  return pool;
}

// ═══════════════════════════════════════════
// GET / — List weekly releases (public)
// ?page=1&limit=10
// ═══════════════════════════════════════════
app.get('/', async (c) => {
  try {
    const pool = await getPool();
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);
    const offset = (page - 1) * limit;

    const result = await pool.query(`
      SELECT id, title, week_number, year, release_date, track_ids,
             is_published, published_at, created_at
      FROM weekly_releases
      WHERE is_published = true
      ORDER BY release_date DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countResult = await pool.query(
      `SELECT count(*) FROM weekly_releases WHERE is_published = true`
    );

    return c.json({
      success: true,
      data: result.rows,
      total: parseInt(countResult.rows[0].count),
      page, limit,
    });
  } catch (error) {
    console.error('[weekly-releases] GET /:', error);
    return c.json({ success: true, data: [], total: 0 });
  }
});

// ═══════════════════════════════════════════
// GET /current — Current week release with full track data
// ═══════════════════════════════════════════
app.get('/current', async (c) => {
  try {
    const pool = await getPool();

    // Get latest published release
    const releaseResult = await pool.query(`
      SELECT * FROM weekly_releases
      WHERE is_published = true
      ORDER BY release_date DESC
      LIMIT 1
    `);

    if (releaseResult.rows.length === 0) {
      return c.json({ success: true, data: null });
    }

    const release = releaseResult.rows[0];
    const trackIds = release.track_ids;

    if (!trackIds || trackIds.length === 0) {
      return c.json({ success: true, data: { ...release, tracks: [] } });
    }

    // Get full track data with artist profiles.
    // Native cols only — migration 089 DROP'нет tracks.data. Frontend
    // weekly-releases-section читает только plain поля (title/artist_name/
    // cover_url/...), не track.data.* — grep подтверждён.
    const tracksResult = await pool.query(`
      SELECT
        t.id, t.title, t.artist_name, t.genre, t.duration,
        t.audio_url, t.cover_url, t.release_date,
        t.likes_count, t.plays_count, t.city,
        ap.id as artist_profile_id,
        ap.slug as artist_slug,
        ap.avatar_url as artist_avatar,
        ap.bio as artist_bio,
        ap.city as artist_city,
        ap.country as artist_country,
        ap.is_verified as artist_verified
      FROM tracks t
      LEFT JOIN artist_profiles ap ON ap.id = t.artist_id
      WHERE t.id = ANY($1)
      ORDER BY t.likes_count DESC
    `, [trackIds]);

    // Get radio pickups for all tracks
    const pickupsResult = await pool.query(`
      SELECT track_id,
        COUNT(DISTINCT station_name) as radio_count,
        COUNT(DISTINCT city) as city_count,
        array_agg(DISTINCT station_name) as stations,
        array_agg(DISTINCT city) as cities
      FROM track_radio_pickups
      WHERE track_id = ANY($1)
      GROUP BY track_id
    `, [trackIds]);

    const pickupsMap: Record<string, any> = {};
    for (const row of pickupsResult.rows) {
      pickupsMap[row.track_id] = {
        radioCount: parseInt(row.radio_count),
        cityCount: parseInt(row.city_count),
        stations: row.stations,
        cities: row.cities,
      };
    }

    // Merge tracks with pickups
    const tracks = tracksResult.rows.map((t: any) => ({
      ...t,
      radioPickups: pickupsMap[t.id] || { radioCount: 0, cityCount: 0, stations: [], cities: [] },
    }));

    return c.json({
      success: true,
      data: {
        ...release,
        tracks,
      },
    });
  } catch (error) {
    console.error('[weekly-releases] GET /current:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ═══════════════════════════════════════════
// GET /:id — Single release with full track data
// ═══════════════════════════════════════════
app.get('/:id', async (c) => {
  try {
    const pool = await getPool();
    const releaseId = c.req.param('id');

    const releaseResult = await pool.query(
      `SELECT * FROM weekly_releases WHERE id = $1`, [releaseId]
    );

    if (releaseResult.rows.length === 0) {
      return c.json({ success: false, error: 'Release not found' }, 404);
    }

    const release = releaseResult.rows[0];
    const trackIds = release.track_ids;

    // Native cols only — см. /current выше (migration 089).
    const tracksResult = await pool.query(`
      SELECT
        t.id, t.title, t.artist_name, t.genre, t.duration,
        t.audio_url, t.cover_url, t.release_date,
        t.likes_count, t.plays_count,
        ap.id as artist_profile_id,
        ap.slug as artist_slug,
        ap.avatar_url as artist_avatar,
        ap.is_verified as artist_verified
      FROM tracks t
      LEFT JOIN artist_profiles ap ON ap.id = t.artist_id
      WHERE t.id = ANY($1)
      ORDER BY t.likes_count DESC
    `, [trackIds]);

    const pickupsResult = await pool.query(`
      SELECT track_id,
        COUNT(DISTINCT station_name) as radio_count,
        COUNT(DISTINCT city) as city_count,
        array_agg(DISTINCT station_name) as stations,
        array_agg(DISTINCT city) as cities
      FROM track_radio_pickups
      WHERE track_id = ANY($1)
      GROUP BY track_id
    `, [trackIds]);

    const pickupsMap: Record<string, any> = {};
    for (const row of pickupsResult.rows) {
      pickupsMap[row.track_id] = {
        radioCount: parseInt(row.radio_count),
        cityCount: parseInt(row.city_count),
        stations: row.stations,
        cities: row.cities,
      };
    }

    const tracks = tracksResult.rows.map((t: any) => ({
      ...t,
      radioPickups: pickupsMap[t.id] || { radioCount: 0, cityCount: 0, stations: [], cities: [] },
    }));

    return c.json({ success: true, data: { ...release, tracks } });
  } catch (error) {
    console.error('[weekly-releases] GET /:id:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ═══════════════════════════════════════════
// POST /like/:trackId — Toggle like on a track (auth required)
// ═══════════════════════════════════════════
app.post('/like/:trackId', requireAuth, async (c) => {
  try {
    const pool = await getPool();
    const trackId = c.req.param('trackId');
    const userId = c.get('userId');

    // Check if already liked
    const existingLike = await pool.query(
      `SELECT id FROM likes WHERE user_id = $1 AND target_type = 'track' AND target_id = $2`,
      [userId, trackId]
    );

    if (existingLike.rows.length > 0) {
      // Unlike
      await pool.query(`DELETE FROM likes WHERE id = $1`, [existingLike.rows[0].id]);
      await pool.query(
        `UPDATE tracks SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1`,
        [trackId]
      );
      return c.json({ success: true, liked: false });
    } else {
      // Like
      await pool.query(
        `INSERT INTO likes (user_id, target_type, target_id) VALUES ($1, 'track', $2)`,
        [userId, trackId]
      );
      await pool.query(
        `UPDATE tracks SET likes_count = likes_count + 1 WHERE id = $1`,
        [trackId]
      );
      return c.json({ success: true, liked: true });
    }
  } catch (error) {
    console.error('[weekly-releases] POST /like:', error);
    return c.json({ success: false, error: 'Failed to toggle like' }, 500);
  }
});

// ═══════════════════════════════════════════
// GET /likes/check — Check which tracks user has liked
// ?trackIds=id1,id2,id3
// ═══════════════════════════════════════════
app.get('/likes/check', requireAuth, async (c) => {
  try {
    const pool = await getPool();
    const userId = c.get('userId');
    const trackIdsParam = c.req.query('trackIds') || '';
    const trackIds = trackIdsParam.split(',').filter(Boolean);

    if (trackIds.length === 0) {
      return c.json({ success: true, data: {} });
    }

    const result = await pool.query(
      `SELECT target_id FROM likes WHERE user_id = $1 AND target_type = 'track' AND target_id = ANY($2)`,
      [userId, trackIds]
    );

    const likedMap: Record<string, boolean> = {};
    for (const row of result.rows) {
      likedMap[row.target_id] = true;
    }

    return c.json({ success: true, data: likedMap });
  } catch (error) {
    console.error('[weekly-releases] GET /likes/check:', error);
    return c.json({ success: true, data: {} });
  }
});

// ═══════════════════════════════════════════
// POST / — Create new weekly release (admin only)
// ═══════════════════════════════════════════
app.post('/', requireAuth, requireAdmin, async (c) => {
  try {
    const pool = await getPool();
    const body = await c.req.json();
    const { title, week_number, year, release_date, track_ids } = body;

    if (!title || !week_number || !year || !track_ids?.length) {
      return c.json({ success: false, error: 'Missing required fields' }, 400);
    }

    const result = await pool.query(`
      INSERT INTO weekly_releases (title, week_number, year, release_date, track_ids, is_published, published_at)
      VALUES ($1, $2, $3, $4, $5, true, now())
      ON CONFLICT (week_number, year) DO UPDATE SET
        title = EXCLUDED.title,
        track_ids = EXCLUDED.track_ids,
        is_published = true,
        published_at = now()
      RETURNING *
    `, [title, week_number, year, release_date || new Date().toISOString(), track_ids]);

    return c.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('[weekly-releases] POST /:', error);
    return c.json({ success: false, error: 'Failed to create release' }, 500);
  }
});

// ═══════════════════════════════════════════
// GET /artist/:slug — Public artist profile with tracks
// ═══════════════════════════════════════════
app.get('/artist/:slug', async (c) => {
  try {
    const pool = await getPool();
    const slug = c.req.param('slug');

    const artistResult = await pool.query(
      `SELECT * FROM artist_profiles WHERE slug = $1`, [slug]
    );

    if (artistResult.rows.length === 0) {
      return c.json({ success: false, error: 'Artist not found' }, 404);
    }

    const artist = artistResult.rows[0];

    // Get all tracks by this artist
    const tracksResult = await pool.query(`
      SELECT t.*, 
        (SELECT COUNT(DISTINCT station_name) FROM track_radio_pickups WHERE track_id = t.id) as radio_count,
        (SELECT COUNT(DISTINCT city) FROM track_radio_pickups WHERE track_id = t.id) as city_count
      FROM tracks t
      WHERE t.artist_id = $1
      ORDER BY t.created_at DESC
    `, [artist.id]);

    return c.json({
      success: true,
      data: {
        ...artist,
        tracks: tracksResult.rows,
      },
    });
  } catch (error) {
    console.error('[weekly-releases] GET /artist/:slug:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});


// ═══════════════════════════════════════════
// POST /:id/add-track — Add track to release (admin)
// Body: { trackId: string }
// ═══════════════════════════════════════════
app.post('/:id/add-track', requireAuth, requireAdmin, async (c) => {
  try {
    const pool = await getPool();
    const releaseId = c.req.param('id');
    const { trackId } = await c.req.json();

    if (!trackId) return c.json({ success: false, error: 'trackId required' }, 400);

    // Verify track exists
    const trackCheck = await pool.query('SELECT id FROM tracks WHERE id = $1', [trackId]);
    if (trackCheck.rows.length === 0) {
      return c.json({ success: false, error: 'Track not found' }, 404);
    }

    const result = await pool.query(
      `UPDATE weekly_releases
       SET track_ids = array_append(track_ids, $1::uuid)
       WHERE id = $2 AND NOT ($1::uuid = ANY(track_ids))
       RETURNING *`,
      [trackId, releaseId]
    );

    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Release not found or track already in release' }, 404);
    }

    return c.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('[weekly-releases] POST /:id/add-track:', error);
    return c.json({ success: false, error: 'Failed to add track' }, 500);
  }
});

// ═══════════════════════════════════════════
// POST /:id/remove-track — Remove track from release (admin)
// Body: { trackId: string }
// ═══════════════════════════════════════════
app.post('/:id/remove-track', requireAuth, requireAdmin, async (c) => {
  try {
    const pool = await getPool();
    const releaseId = c.req.param('id');
    const { trackId } = await c.req.json();

    if (!trackId) return c.json({ success: false, error: 'trackId required' }, 400);

    const result = await pool.query(
      `UPDATE weekly_releases
       SET track_ids = array_remove(track_ids, $1::uuid)
       WHERE id = $2
       RETURNING *`,
      [trackId, releaseId]
    );

    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Release not found' }, 404);
    }

    return c.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('[weekly-releases] POST /:id/remove-track:', error);
    return c.json({ success: false, error: 'Failed to remove track' }, 500);
  }
});

// ═══════════════════════════════════════════
// POST /tracks/create — Create a new track (admin)
// Body: { title, artist_name, genre?, duration?, audio_url?, cover_url?, artist_id? }
// ═══════════════════════════════════════════
app.post('/tracks/create', requireAuth, requireAdmin, async (c) => {
  try {
    const pool = await getPool();
    const body = await c.req.json();
    const { title, artist_name, genre, duration, audio_url, cover_url, artist_id } = body;

    if (!title || !artist_name) {
      return c.json({ success: false, error: 'title and artist_name required' }, 400);
    }

    // Auto-find or create artist profile
    let finalArtistId = artist_id;
    if (!finalArtistId) {
      const artistCheck = await pool.query(
        'SELECT id FROM artist_profiles WHERE artist_name ILIKE $1 LIMIT 1',
        [artist_name]
      );
      if (artistCheck.rows.length > 0) {
        finalArtistId = artistCheck.rows[0].id;
      }
    }

    const result = await pool.query(
      `INSERT INTO tracks (title, artist_name, genre, duration, audio_url, cover_url, artist_id, moderation_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved')
       RETURNING *`,
      [title, artist_name, genre || null, duration || null, audio_url || null, cover_url || null, finalArtistId || null]
    );

    return c.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('[weekly-releases] POST /tracks/create:', error);
    return c.json({ success: false, error: 'Failed to create track' }, 500);
  }
});

// ═══════════════════════════════════════════
// POST /tracks/create-with-artist — Create track + artist profile (admin)
// Body: { title, artist_name, genre?, duration?, audio_url?, cover_url?, artist_bio?, artist_city?, artist_country? }
// ═══════════════════════════════════════════
app.post('/tracks/create-with-artist', requireAuth, requireAdmin, async (c) => {
  try {
    const pool = await getPool();
    const body = await c.req.json();
    const { title, artist_name, genre, duration, audio_url, cover_url, artist_bio, artist_city, artist_country } = body;

    if (!title || !artist_name) {
      return c.json({ success: false, error: 'title and artist_name required' }, 400);
    }

    // Create slug from artist_name
    const slug = artist_name
      .toLowerCase()
      .replace(/[а-яё]/g, (ch) => {
        const map: Record<string, string> = {
          'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y',
          'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
          'х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
        };
        return map[ch] || ch;
      })
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Upsert artist profile
    const artistResult = await pool.query(
      `INSERT INTO artist_profiles (artist_name, slug, genre, bio, city, country, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'system-admin')
       ON CONFLICT (slug) DO UPDATE SET
         artist_name = EXCLUDED.artist_name,
         genre = COALESCE(EXCLUDED.genre, artist_profiles.genre)
       RETURNING *`,
      [artist_name, slug, genre || null, artist_bio || null, artist_city || null, artist_country || null]
    );

    const artistId = artistResult.rows[0].id;

    // Create track
    const trackResult = await pool.query(
      `INSERT INTO tracks (title, artist_name, genre, duration, audio_url, cover_url, artist_id, moderation_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved')
       RETURNING *`,
      [title, artist_name, genre || null, duration || null, audio_url || null, cover_url || null, artistId]
    );

    return c.json({ success: true, data: { track: trackResult.rows[0], artist: artistResult.rows[0] } });
  } catch (error) {
    console.error('[weekly-releases] POST /tracks/create-with-artist:', error);
    return c.json({ success: false, error: 'Failed to create track with artist' }, 500);
  }
});

export default app;
