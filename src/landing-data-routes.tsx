/**
 * LANDING DATA ROUTES v2
 * Публичные API endpoints для данных лендинга
 * Треки, концерты, поиск — из typed SQL tables
 * Артисты, новости, чарты, продюсеры — из хранилища
 */

import { Hono } from 'hono';
import * as typed from './db-typed.tsx';
import { pool } from './db-client.tsx';
import { getAllArtistProfiles, getAllProducerProfiles, getArtistProfile, getProducerProfile, getBeats, artistAnalyticsCacheStore, beatReviewsStore, chartSourcesStore, concertAgentStore, contactFormsStore, investorInquiriesStore, newsPublicStore, paymentBalancesStore, platformStatsStore, producerServicesStore, radioAnalyticsStore, serviceOrdersByProducerStore } from './db.tsx';
import { reseedDemoData } from './demo-seed.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { sanitizeString, sanitizeUrl } from './security.tsx';
import { safeErrorMessage } from './security.tsx';

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

/** Admin auth: either JWT admin or X-Internal-Key header */
async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) {
    return next();
  }
  return requireAuth(c, () => requireAdmin(c, next));
}


// ── Auto-create artist profiles for chart/release artists ──
async function ensureArtistProfile(artistName: string, coverUrl?: string, extra?: Record<string, any>) {
  if (!artistName || artistName.length < 2) return;
  try {
    const { getDbClient } = await import('./db-client.tsx');
    const dbClient = getDbClient();
    
    // Check if profile exists
    const { data: existing } = await dbClient
      .from('artist_profiles')
      .select('user_id')
      .ilike('artist_name', artistName)
      .limit(1);
    
    if (existing && existing.length > 0) return existing[0].user_id;
    
    // Check artists table
    const { data: artistRow } = await dbClient
      .from('artists')
      .select('id')
      .ilike('full_name', artistName)
      .limit(1);
    
    const userId = artistRow?.[0]?.id || crypto.randomUUID();
    const slug = artistName.toLowerCase().replace(/[^a-zа-яёa-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '-' + String(userId).slice(0, 8);
    
    await dbClient.from('artist_profiles').insert({
      user_id: String(userId),
      slug,
      artist_name: artistName,
      avatar_url: coverUrl || '',
      is_verified: false,
      country: 'Россия',
      data: JSON.stringify(extra || {}),
    });
    
    console.log(`[auto-profile] Created: ${artistName}`);
    return String(userId);
  } catch (err) {
    // Ignore duplicates
  }
}

const landing = new Hono();

// ============================================
// POPULAR ARTISTS (KV — unchanged)
// ============================================

landing.get('/popular-artists', async (c) => {
  try {
    const raw = await platformStatsStore.get('artists:popular');
    return c.json({ success: true, data: raw || [] });
  } catch (error) {
    console.error('Error fetching popular artists:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

landing.get('/artists/:idOrSlug', async (c) => {
  try {
    const param = c.req.param('idOrSlug');
    const { getDbClient } = await import('./db-client.tsx');
    const dbClient = getDbClient();

    // Try multiple lookup strategies
    let profile: any = null;
    let userId = param;

    // 1. Try by artist_profiles.id (UUID)
    profile = await getArtistProfile(param);

    // 2. Try by user_id (artists.id → artist_profiles.user_id)
    if (!profile) {
      const { data: byUserId } = await dbClient
        .from('artist_profiles')
        .select('*')
        .eq('user_id', param)
        .maybeSingle();
      if (byUserId) {
        profile = byUserId.data || byUserId;
        userId = byUserId.user_id || param;
      }
    }

    // 3. Try by slug
    if (!profile) {
      const { data: bySlug } = await dbClient
        .from('artist_profiles')
        .select('*')
        .eq('slug', param)
        .maybeSingle();
      if (bySlug) {
        profile = bySlug.data || bySlug;
        userId = bySlug.user_id || param;
      }
    }

    if (!profile) {
      return c.json({ success: false, error: 'Artist not found' }, 404);
    }

    // Normalize profile to standard format
    const artistData = {
      id: profile.user_id || profile.id || userId,
      slug: profile.slug || '',
      name: profile.artist_name || profile.fullName || profile.name || '',
      fullName: profile.artist_name || profile.fullName || profile.name || '',
      genre: profile.genre || '',
      genres: profile.sub_genres || profile.genres || [],
      city: profile.city || '',
      country: profile.country || 'Россия',
      bio: profile.bio || '',
      avatarUrl: profile.avatar_url || profile.avatarUrl || '',
      coverUrl: profile.cover_url || profile.coverUrl || '',
      website: profile.website || '',
      socialLinks: profile.social_links || profile.socials || {},
      streamingLinks: profile.streaming_links || {},
      monthlyListeners: profile.monthly_listeners || 0,
      totalPlays: profile.total_plays || 0,
      totalFollowers: profile.total_followers || 0,
      isVerified: profile.is_verified || false,
    };

    // Get artist's published tracks by artist_id (FK from tracks table)
    const { data: artistTracks } = await dbClient
      .from('tracks')
      .select('*')
      .eq('artist_id', userId)
      .order('created_at', { ascending: false });

    const publishedTracks = (artistTracks || [])
      .filter((t: any) => ['approved', 'published'].includes(t.moderation_status))
      .map((t: any) => ({
        id: t.id,
        title: t.title,
        artist: t.artist_name || artistData.name,
        artistId: t.artist_id,
        genre: t.genre || artistData.genre,
        audioUrl: t.audio_url || '',
        coverUrl: t.cover_url || '',
        duration: t.duration || '',
        plays: t.plays_count || 0,
        likes: t.likes_count || 0,
      }));

    return c.json({
      success: true,
      data: {
        ...artistData,
        tracks: publishedTracks,
        trackCount: publishedTracks.length,
      },
    });
  } catch (error) {
    console.error('Error fetching artist:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});


// Search artist by exact name match (for track → profile linking)
landing.get('/artist-by-name/:name', async (c) => {
  try {
    const name = decodeURIComponent(c.req.param('name'));
    const { getDbClient } = await import('./db-client.tsx');
    const dbClient = getDbClient();
    
    // Search in artist_profiles by artist_name (case-insensitive)
    const { data } = await dbClient
      .from('artist_profiles')
      .select('user_id, slug, artist_name, avatar_url, genre, city, total_plays, is_verified')
      .ilike('artist_name', name)
      .limit(1);
    
    if (data && data.length > 0) {
      const a = data[0];
      return c.json({
        success: true,
        data: {
          id: a.user_id,
          slug: a.slug,
          name: a.artist_name,
          avatarUrl: a.avatar_url || '',
          genre: a.genre || '',
          city: a.city || '',
          totalPlays: a.total_plays || 0,
          isVerified: a.is_verified || false,
        },
      });
    }
    
    return c.json({ success: false, error: 'Artist not found' }, 404);
  } catch (error) {
    console.error('Error searching artist by name:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

landing.get('/artists', async (c) => {
  try {
    const genre = c.req.query('genre');
    const search = c.req.query('search')?.toLowerCase();
    const limit = parseInt(c.req.query('limit') || '50');

    const allArtistData = await getAllArtistProfiles();
    let artists = allArtistData.filter((a: any) => a && a.id);

    if (genre) {
      artists = artists.filter((a: any) => a.genre === genre);
    }

    if (search) {
      artists = artists.filter((a: any) =>
        a.name?.toLowerCase().includes(search) ||
        a.genre?.toLowerCase().includes(search) ||
        a.city?.toLowerCase().includes(search)
      );
    }

    artists.sort((a: any, b: any) => (b.monthlyListeners || 0) - (a.monthlyListeners || 0));

    return c.json({
      success: true,
      data: artists.slice(0, limit),
      total: artists.length,
    });
  } catch (error) {
    console.error('Error fetching artists list:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ============================================
// CHARTS (KV — unchanged)
// ============================================

landing.get('/charts/weekly', async (c) => {
  try {
    // Read from canonical chart:promofm (has covers from Deezer enrichment)
    const raw: any = await platformStatsStore.get('chart:promofm');
    if (raw?.entries) {
      // Lazy-create profiles for chart artists (fire & forget)
      Promise.allSettled(raw.entries.slice(0, 20).map((e: any) => 
        ensureArtistProfile(e.artist, e.coverUrl || e.cover, { chart_position: e.position, source: 'chart:promofm' })
      )).catch(() => {});
      return c.json({ success: true, data: { entries: raw.entries.slice(0, 20), updatedAt: raw.updatedAt } });
    }
    // Fallback to chart:weekly:top20
    const fallback = await platformStatsStore.get('chart:weekly:top20');
    return c.json({ success: true, data: fallback || { entries: [] } });
  } catch (error) {
    console.error('Error fetching weekly chart:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /new-releases — Новинки недели (10 треков)
 * Приоритет: наши артисты → Shazam/Yandex новинки
 */
landing.get('/new-releases', async (c) => {
  try {
    const cached = await platformStatsStore.get('weekly:new_releases');
    if (cached && cached.tracks?.length) {
      // Enrich with iTunes preview URLs (Deezer previews expire after ~24h)
      try {
        const chartData: any = await platformStatsStore.get('chart:promofm');
        if (chartData?.entries?.length) {
          const itunesMap = new Map<string, string>();
          for (const e of chartData.entries) {
            if (e.previewUrl && e.previewUrl.includes('itunes.apple.com')) {
              const key = (e.title + '|' + e.artist).toLowerCase().trim();
              itunesMap.set(key, e.previewUrl);
            }
          }
          const fetchPromises: Promise<void>[] = [];
          for (const track of cached.tracks) {
            const key = (track.title + '|' + track.artist).toLowerCase().trim();
            const itunesUrl = itunesMap.get(key);
            if (itunesUrl) {
              track.previewUrl = itunesUrl;
            } else if (!track.previewUrl || track.previewUrl.includes('dzcdn.net')) {
              // Fallback: search iTunes for preview URL
              fetchPromises.push(
                fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(track.title + ' ' + track.artist)}&media=music&limit=1`)
                  .then(r => r.json())
                  .then(data => {
                    const url = data.results?.[0]?.previewUrl;
                    if (url) {
                      track.previewUrl = url;
                    }
                  })
                  .catch(() => {})
              );
            }
          }
          if (fetchPromises.length > 0) {
            await Promise.allSettled(fetchPromises);
          }
        }
      } catch {}
      return c.json({ success: true, data: cached });
    }
    return c.json({ success: true, data: { tracks: [], updatedAt: null } });
  } catch (error) {
    console.error('Error fetching new releases:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ============================================
// TRACKS (PUBLIC) — NOW FROM TYPED SQL TABLE!
// ============================================

/**
 * GET /tracks/new — Published tracks, newest first
 * Reads from `tracks` WHERE moderation_status IN ('approved','published')
 */
landing.get('/tracks/new', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '10');
    const tracks = await typed.getPublishedTracks(limit, 'created_at');

    // Fetch radio detections for these tracks
    const trackIds = tracks.map((t: any) => t.id).filter(Boolean);
    let radioMap: Record<string, { stations: string[]; stationsCount: number; broadcastCitiesCount: number }> = {};
    if (trackIds.length > 0) {
      try {
        const { rows } = await pool.query(
          `SELECT d.track_id,
                  array_agg(DISTINCT d.station_name ORDER BY d.station_name) AS stations,
                  COUNT(DISTINCT d.station_id) AS stations_count,
                  COALESCE(SUM(array_length(rs.broadcast_cities, 1)), 0) AS broadcast_cities_count
           FROM promo_check_detections d
           LEFT JOIN radio_stations rs ON rs.id = d.station_id
           WHERE d.track_id = ANY($1::uuid[])
           GROUP BY d.track_id`,
          [trackIds]
        );
        for (const row of rows) {
          radioMap[row.track_id] = {
            stations: row.stations || [],
            stationsCount: parseInt(row.stations_count) || 0,
            broadcastCitiesCount: parseInt(row.broadcast_cities_count) || 0,
          };
        }
      } catch (e) { /* promo_check_detections may not exist yet */ }
    }

    // Map to frontend-expected format
    const mapped = tracks.map((t: any) => ({
      id: t.id,
      title: t.title || '',
      artist: t.artist_name || '',
      artist_name: t.artist_name || '',
      genre: t.genre || '',
      duration: t.duration || 0,
      audioUrl: t.audio_url || '',
      audio_url: t.audio_url || '',
      coverUrl: t.cover_url || '',
      cover_url: t.cover_url || '',
      plays: t.plays_count || 0,
      likes: t.likes_count || 0,
      artistId: t.user_id || t.artist_id || '',
      createdAt: t.created_at,
      created_at: t.created_at,
      yandex_music_url: t.yandex_music_url || '',
      youtube_url: t.youtube_url || '',
      spotify_url: t.spotify_url || '',
      city: t.city || '',
      radio_stations: radioMap[t.id]?.stations || [],
      stationsCount: radioMap[t.id]?.stationsCount || 0,
      broadcastCitiesCount: radioMap[t.id]?.broadcastCitiesCount || 0,
    }));

    // If no real tracks, fallback to chart data with covers
    if (mapped.length === 0) {
      const chartData: any = await platformStatsStore.get('chart:promofm');
      if (chartData?.entries?.length) {
        const chartTracks = chartData.entries.slice(0, limit).map((e: any, i: number) => ({
          id: 'chart-' + (i + 1),
          title: e.title || '',
          artist: e.artist || '',
          artist_name: e.artist || '',
          genre: '',
          duration: 30,
          audioUrl: e.previewUrl || '',
          audio_url: e.previewUrl || '',
          coverUrl: e.coverUrl || '',
          cover_url: e.coverUrl || '',
          coverSmall: e.coverSmall || '',
          plays: 0,
          likes: 0,
          artistId: '',
          createdAt: chartData.updatedAt || new Date().toISOString(),
          created_at: chartData.updatedAt || new Date().toISOString(),
          chartPosition: e.position,
          source: 'chart',
        }));
        return c.json({ success: true, data: chartTracks, source: 'chart' });
      }
    }

    return c.json({ success: true, data: mapped });
  } catch (error) {
    console.error('Error fetching new tracks:', error);
    return c.json({ success: true, data: [] });
  }
});

/**
 * GET /tracks/trending — Published tracks sorted by plays
 */
landing.get('/tracks/trending', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '10');
    const tracks = await typed.getPublishedTracks(limit, 'plays_count');

    const mapped = tracks.map((t: any) => ({
      id: t.id,
      title: t.title || '',
      artist: t.artist_name || '',
      genre: t.genre || '',
      duration: t.duration || 0,
      audioUrl: t.audio_url || '',
      coverUrl: t.cover_url || '',
      plays: t.plays_count || 0,
      likes: t.likes_count || 0,
      artistId: t.user_id || t.artist_id || '',
      createdAt: t.created_at,
    }));

    return c.json({ success: true, data: mapped });
  } catch (error) {
    console.error('Error fetching trending tracks:', error);
    return c.json({ success: true, data: [] });
  }
});

/**
 * GET /tracks/by-genre/:genre — Published tracks filtered by genre
 */
landing.get('/tracks/by-genre/:genre', async (c) => {
  try {
    const genre = c.req.param('genre');
    const limit = parseInt(c.req.query('limit') || '20');
    const tracks = await typed.getPublishedTracksByGenre(genre, limit);

    const mapped = tracks.map((t: any) => ({
      id: t.id,
      title: t.title || '',
      artist: t.artist_name || '',
      genre: t.genre || '',
      duration: t.duration || 0,
      audioUrl: t.audio_url || '',
      coverUrl: t.cover_url || '',
      plays: t.plays_count || 0,
      artistId: t.user_id || t.artist_id || '',
    }));

    return c.json({ success: true, data: mapped });
  } catch (error) {
    console.error('Error fetching tracks by genre:', error);
    return c.json({ success: true, data: [] });
  }
});

// ============================================
// NEWS (PUBLIC — KV, unchanged)
// ============================================


/** Normalize news item fields for frontend compatibility */

// Auto-ping search engines after news publish (IndexNow + Yandex)
async function pingSitemapAsync(newsId?: string) {
  const INDEXNOW_KEY = 'be3b1945c60d606211ccb819caebe3fb';
  const urls = ['https://promo-music.ru/sitemap.xml'];
  if (newsId) urls.push(`https://promo-music.ru/news/${newsId}`);
  
  try {
    await Promise.allSettled([
      // Yandex sitemap ping
      fetch(`https://webmaster.yandex.ru/ping?sitemap=${encodeURIComponent('https://promo-music.ru/sitemap.xml')}`),
      // IndexNow (Bing + Yandex)
      fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: 'promo-music.ru',
          key: INDEXNOW_KEY,
          keyLocation: `https://promo-music.ru/${INDEXNOW_KEY}.txt`,
          urlList: urls,
        }),
      }),
      fetch('https://yandex.com/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: 'promo-music.ru',
          key: INDEXNOW_KEY,
          keyLocation: `https://promo-music.ru/${INDEXNOW_KEY}.txt`,
          urlList: urls,
        }),
      }),
    ]);
    console.log('[sitemap] Pinged Yandex + IndexNow for', urls);
  } catch (e) {
    console.error('[sitemap] Ping error:', e);
  }
}

function normalizeNews(n: any): any {
  let c = n.content || n.excerpt || '';
  // Strip markdown code fences (```html ... ```)
  c = c.replace(/^\s*```html\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  return {
    ...n,
    artistName: n.artistName || n.authorName || 'ПРОМО.МУЗЫКА',
    artistAvatar: n.artistAvatar || n.authorAvatar || '/logo-promo.svg',
    coverImage: n.coverImage || n.imageUrl || n.banner || '',
    content: c,
  };
}

landing.get('/news', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '10');
    const tag = c.req.query('tag');

    const allNews = await newsPublicStore.getAll();
    let news = allNews.filter((n: any) => {
      if (!n || !n.id || n.status !== 'published') return false;
      // Filter out English-only titles (platform is Russian)
      const title = n.title || '';
      const cyrillic = (title.match(/[а-яА-ЯёЁ]/g) || []).length;
      const latin = (title.match(/[a-zA-Z]/g) || []).length;
      const total = cyrillic + latin;
      if (total > 10 && latin / total > 0.8) return false; // >80% Latin = English title
      return true;
    });

    if (tag) {
      news = news.filter((n: any) => n.tag === tag);
    }

    news.sort((a: any, b: any) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

    return c.json({ success: true, data: news.slice(0, limit).map(normalizeNews) });
  } catch (error) {
    console.error('Error fetching news:', error);
    return c.json({ success: true, data: [] });
  }
});

landing.get('/news/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const raw = await newsPublicStore.get(id);
    if (!raw) {
      return c.json({ success: false, error: 'News not found' }, 404);
    }
    return c.json({ success: true, data: normalizeNews(raw) });
  } catch (error) {
    console.error('Error fetching news item:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ============================================
// CONCERTS (PUBLIC) — NOW FROM TYPED SQL TABLE!
// Still merges with concert-agent data (KudaGo etc.)
// ============================================

landing.get('/concerts', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50');
    const city = c.req.query('city') || '';

    // 1. Published concerts from typed SQL table
    const sqlConcerts = await typed.getPublishedConcerts(300);
    let concerts = sqlConcerts.map((c: any) => ({
      id: c.id,
      title: c.title || '',
      artist: c.artist_name || '',
      artistId: c.user_id || c.artist_id || '',
      venue: c.venue_name || '',
      city: c.city || '',
      date: c.event_date instanceof Date ? c.event_date.toISOString().split('T')[0] : (c.event_date || ''),
      time: c.event_time || '',
      capacity: c.ticket_capacity || 0,
      ticketsSold: c.tickets_sold || 0,
      ticketPriceFrom: c.ticket_price_min || '',
      ticketPriceTo: c.ticket_price_max || '',
      status: 'published',
      views: c.views_count || 0,
      clicks: c.clicks_count || 0,
      coverImage: c.banner_image_url || '',
      banner: c.banner_image_url || '',
      description: c.description || '',
      source: c.source || 'promo_artist',
      genre: '',
      ticketUrl: c.ticket_link || '',
      ticketLink: c.ticket_link || '',
      type: c.concert_type || c.type || 'Концерт',
    }));

    // 2. External concerts from concert-agent (KudaGo etc.)
    try {
      const agentConcerts = await concertAgentStore.getAll();
      const mapped = agentConcerts
        .filter((c: any) => c && c.status === 'published')
        .map((c: any) => ({
          id: c.id,
          title: c.title || '',
          artist: c.artist || '',
          artistId: '',
          artistAvatar: '',
          venue: c.venue || '',
          city: c.city || '',
          date: c.date || '',
          time: c.time || '',
          capacity: 0,
          ticketsSold: 0,
          ticketPriceFrom: ((c.price || '').match(/\d+/) || [''])[0],
          ticketPriceTo: '',
          status: 'published',
          views: 0,
          coverImage: c.imageUrl || '',
          description: c.description || '',
          source: c.source || 'external',
          type: c.type || 'Концерт',
          clicks: 0,
          banner: c.imageUrl || '',
          ticketLink: c.ticketUrl || '',
          genre: c.genre || '',
          ticketUrl: c.ticketUrl || '',
        }));
      concerts = [...concerts, ...mapped];
    } catch (e) {
      console.log('[landing] concert-agent data error:', e);
    }

    // Filter by city
    if (city) {
      concerts = concerts.filter((item: any) =>
        item.city?.toLowerCase().includes(city.toLowerCase())
      );
    }

    // Only future events
    const now = new Date().toISOString().split('T')[0];
    concerts = concerts
      .filter((item: any) => item.date >= now)
      .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Deduplicate by title + date
    const seen = new Set<string>();
    const deduped = concerts.filter((item: any) => {
      const key = `${item.title?.toLowerCase().trim()}::${item.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Priority: big-name artists first, then by date
    const BIG_ARTISTS = [
      'баста','ленинград','руки вверх','лазарев','гагарина','ваенга','noize mc',
      'feduk','звери','uma2rman','cream soda','saluki','элвин грей','линда',
      'nina kraviz','toxi','дайте танк','dabro','zivert','miyagi','нервы',
      'мот','jony','ramil','hammali','burito','макс корж','скриптонит',
      'oxxxymiron','тимати','егор крид','macan','matrang','мияги','andy panda',
      'грибы','каста','guf','гуф','markul','pharaoh','face (рэпер)','lsp','big baby tape',
      'kizaru','gone.fludd','boulevar depo','thomas mraz','obladaet',
      'хаски','aigel','aikko','lovv66','bushido zho','instasamka','клава кока',
      'ёлка','дора','niletto','anna asti','мари краймбрери','artik & asti',
      'три дня дождя','пошлая молли','аигел','ssshhhiiittt','i61','платина',
      'бамбинтон','тима белорусских','rasa','мот (рэпер)','jah khalib','джа халиб',
      'ария','кипелов','би-2','сплин','мумий тролль','земфира','пикник',
      'ддт','алиса','группа кино','аквариум','агата кристи','король и шут',
      'слот','lumen','louna','amatory','stigmata','jane air',
      'полина гагарина','сергей лазарев','филипп киркоров','валерия','леприконсы',
      'дискотека авария','иванушки','на-на','стас михайлов','григорий лепс',
      'loboda','светлана лобода','елена темникова','нюша','ани лорак',
      'monatik','монатик','время и стекло','потап','alekseev',
      'little big','ic3peak','shortparis','molchat doma','мальбэк',
      'casta','каспийский груз','триагрутрика','mnogoznaal','масло чёрного тмина'
    ];
    
    const getPriority = (c: any): number => {
      const name = ((c.artist || '') + ' ' + (c.title || '')).toLowerCase();
      for (const big of BIG_ARTISTS) {
        if (name.includes(big)) return 0;
      }
      // Deprioritize organ/classical/choir/stale content
      const lowPriority = ['орган','при свечах','хор','хоровые','оркестр','реквием','литературн','стендап','камерн','при свечах','дудук','флейт','скрипк','виолончел','саундтрек','кино','шукшин','годенко','валаам','фламенко','опера','сказка с','анатомия звука'];
      for (const lp of lowPriority) {
        if (name.includes(lp)) return 2;
      }
      return 1;
    };

    deduped.sort((a: any, b: any) => {
      const pa = getPriority(a);
      const pb = getPriority(b);
      if (pa !== pb) return pa - pb;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });

    const promoCount = deduped.filter((c: any) => c.source === 'promo_artist').length;
    const externalCount = deduped.filter((c: any) => c.source !== 'promo_artist').length;

    return c.json({
      success: true,
      data: deduped.slice(0, limit),
      meta: {
        total: deduped.length,
        sources: { promo: promoCount, external: externalCount },
        city: city || 'all',
      },
    });
  } catch (error) {
    console.error('Error fetching concerts:', error);
    return c.json({ success: true, data: [] });
  }
});

// ============================================
// PLATFORM STATS (KV — unchanged)
// ============================================

landing.get('/radio-partners', async (c) => {
  try {
    const allStations = await radioAnalyticsStore.getAll();
    const stations = allStations
      .filter((s: any) => s && s.stationName)
      .map((s: any) => ({
        id: s.id,
        stationName: s.stationName,
        description: s.description || '',
        frequency: s.frequency || '',
        city: s.city || '',
        country: s.country || 'Россия',
        formats: s.formats || [],
        audienceSize: s.audienceSize || 0,
        logoUrl: s.logoUrl || '',
        isOnline: s.isOnline ?? true,
        createdAt: s.createdAt,
      }));
    stations.sort((a: any, b: any) => (b.audienceSize || 0) - (a.audienceSize || 0));

    return c.json({
      success: true,
      data: stations,
      meta: {
        total: stations.length,
        totalAudience: stations.reduce((sum: number, s: any) => sum + (s.audienceSize || 0), 0),
      },
    });
  } catch (error) {
    console.error('Error fetching radio partners:', error);
    return c.json({ success: true, data: [] });
  }
});

landing.get('/stats', async (c) => {
  try {
    // Mix KV stats with real SQL counts
    const raw = await platformStatsStore.get('platform');
    const baseStats = raw || {};

    // Track counts from SQL
    const trackStats = await typed.getTrackModerationStats();

    // Count registered users from DB
    const { getDbClient } = await import('./db-client.tsx');
    const dbClient = getDbClient();
    const { count: userCount } = await dbClient
      .from('users')
      .select('*', { count: 'exact', head: true })
      .is('deleted_at', null);

    // Base 329 + new registrations beyond initial 22 seed users
    const ARTIST_BASE = 329;
    const realUsers = userCount ?? 0;
    const totalArtists = Math.max(ARTIST_BASE, ARTIST_BASE + (realUsers - 22));

    return c.json({
      success: true,
      data: {
        ...baseStats,
        totalTracks: trackStats.total || baseStats.totalTracks || 0,
        publishedTracks: trackStats.approved || 0,
        pendingTracks: trackStats.pending || 0,
        totalArtists,
        totalUsers: realUsers,
      },
    });
  } catch (error) {
    console.error('Error fetching platform stats:', error);
    return c.json({ success: true, data: {} });
  }
});

landing.get('/genres', async (c) => {
  try {
    const raw = await platformStatsStore.get('genres');
    return c.json({ success: true, data: raw || {} });
  } catch (error) {
    return c.json({ success: true, data: {} });
  }
});

// ============================================
// SEARCH — NOW USES TYPED SQL TABLE FOR TRACKS!
// ============================================

landing.get('/search', async (c) => {
  try {
    const query = c.req.query('q')?.toLowerCase();
    if (!query || query.length < 2) {
      return c.json({ success: true, data: { artists: [], tracks: [] } });
    }

    // Search artists (KV)
    const allArtists = await getAllArtistProfiles();
    const matchedArtists = allArtists
      .filter((a: any) => a && a.name &&
        (a.name.toLowerCase().includes(query) ||
         a.genre?.toLowerCase().includes(query) ||
         a.city?.toLowerCase().includes(query))
      )
      .slice(0, 5);

    // Search tracks (typed SQL!)
    const matchedTracks = await typed.searchPublishedTracks(query, 10);
    const mappedTracks = matchedTracks.map((t: any) => ({
      id: t.id,
      title: t.title || '',
      artist: t.artist_name || '',
      genre: t.genre || '',
      audioUrl: t.audio_url || '',
      coverUrl: t.cover_url || '',
      plays: t.plays_count || 0,
    }));

    return c.json({
      success: true,
      data: {
        artists: matchedArtists,
        tracks: mappedTracks,
      },
    });
  } catch (error) {
    console.error('Error searching:', error);
    return c.json({ success: true, data: { artists: [], tracks: [] } });
  }
});

// ============================================
// BEATS MARKETPLACE (KV — unchanged)
// ============================================

landing.get('/beats', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const genre = c.req.query('genre');
    const sort = c.req.query('sort') || 'newest';

    const allBeats = await getBeats();
    let beats = allBeats.filter((b: any) => b && b.id && b.status === 'active');

    if (genre) {
      beats = beats.filter((b: any) => b.genre?.toLowerCase() === genre.toLowerCase());
    }

    switch (sort) {
      case 'popular': beats.sort((a: any, b: any) => (b.plays || 0) - (a.plays || 0)); break;
      case 'rating': beats.sort((a: any, b: any) => (b.rating || 0) - (a.rating || 0)); break;
      case 'price_asc': beats.sort((a: any, b: any) => (a.price || 0) - (b.price || 0)); break;
      case 'price_desc': beats.sort((a: any, b: any) => (b.price || 0) - (a.price || 0)); break;
      default: beats.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    return c.json({ success: true, data: beats.slice(0, limit) });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// ============================================
// PRODUCER SERVICES (KV — unchanged)
// ============================================

landing.get('/producer-services', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const type = c.req.query('type');

    const allServices = await producerServicesStore.getAll();
    let services = allServices.filter((s: any) => s && s.id && s.status === 'active');

    if (type) {
      services = services.filter((s: any) => s.type === type);
    }

    services.sort((a: any, b: any) => (b.orders || 0) - (a.orders || 0));

    return c.json({ success: true, data: services.slice(0, limit) });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

landing.get('/portfolio', async (c) => {
  try {
    const raw = await platformStatsStore.get('portfolio:public:all');
    return c.json({ success: true, data: raw || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

landing.get('/producer-profiles', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const specialization = c.req.query('specialization');

    const allProfiles = await getAllProducerProfiles();
    let profiles = allProfiles.filter((p: any) => p && p.id);

    if (specialization) {
      profiles = profiles.filter((p: any) => p.specializations?.includes(specialization));
    }

    profiles.sort((a: any, b: any) => (b.averageRating || 0) - (a.averageRating || 0));

    return c.json({ success: true, data: profiles.slice(0, limit) });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

landing.get('/producer-profile/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const raw = await getProducerProfile(id);
    if (!raw) {
      return c.json({ success: false, error: 'Producer profile not found' }, 404);
    }
    return c.json({ success: true, data: raw });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

landing.get('/producer-reviews/:producerId', async (c) => {
  try {
    const allReviews = await beatReviewsStore.getAll();
    const reviews = allReviews.filter((r: any) => r && r.id)
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ success: true, data: reviews });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

landing.get('/producer-orders/:producerId', async (c) => {
  try {
    const producerId = c.req.param('producerId');
    const status = c.req.query('status');
    const allOrders = await serviceOrdersByProducerStore.get(producerId);

    let orders = allOrders.filter((o: any) => o && o.id);

    if (status) {
      if (status === 'active') {
        orders = orders.filter((o: any) => o.status !== 'completed' && o.status !== 'cancelled');
      } else {
        orders = orders.filter((o: any) => o.status === status);
      }
    }

    orders.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({ success: true, data: orders });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

landing.get('/producer-wallet/:producerId', async (c) => {
  try {
    const producerId = c.req.param('producerId');
    const raw = await paymentBalancesStore.get(producerId);
    if (!raw) {
      return c.json({ success: false, error: 'Wallet not found' }, 404);
    }
    return c.json({ success: true, data: raw });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ============================================
// ADMIN: RESEED
// ============================================

landing.post('/reseed', async (c) => {
  try {
    const result = await reseedDemoData();
    return c.json({ success: true, ...result });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ============================================
// CONTACT FORM (KV — unchanged)
// ============================================

landing.post('/contact', async (c) => {
  try {
    const body = await c.req.json();
    const { name, email, subject, message } = body;

    if (!name || !email || !subject || !message) {
      return c.json({ success: false, error: 'Все поля обязательны для заполнения' }, 400);
    }

    const id = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await contactFormsStore.set(id, {
      id, name, email, subject, message,
      createdAt: new Date().toISOString(),
      status: 'new',
    });

    return c.json({ success: true, message: 'Сообщение успешно отправлено' });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

landing.post('/investor-inquiry', async (c) => {
  try {
    const body = await c.req.json();
    const { name, email, company, message } = body;

    if (!name || !email) {
      return c.json({ success: false, error: 'Имя и email обязательны' }, 400);
    }

    const id = `investor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await investorInquiriesStore.set(id, {
      id, name, email,
      company: company || '',
      message: message || 'Прошу направить инвестиционную презентацию.',
      createdAt: new Date().toISOString(),
      status: 'new',
    });

    return c.json({ success: true, message: 'Запрос успешно отправлен' });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ============================================
// ADMIN: SEED LIVE DATA
// ============================================

landing.post('/seed-live', requireAdminOrKey, async (c) => {
  try {
    const results: Record<string, any> = {};

    // 1. Popular Artists
    const allArtists = await getAllArtistProfiles();
    const validArtists = allArtists
      .filter((a: any) => a && a.id && a.name)
      .sort((a: any, b: any) => (b.monthlyListeners || b.plays || 0) - (a.monthlyListeners || a.plays || 0))
      .slice(0, 20)
      .map((a: any) => ({
        id: a.id, name: a.name, genre: a.genre || '', city: a.city || '',
        avatar: a.avatar || a.avatarUrl || '',
        monthlyListeners: a.monthlyListeners || 0, plays: a.plays || 0,
        verified: a.verified || false,
      }));
    await platformStatsStore.set('artists:popular', validArtists);
    results.popularArtists = validArtists.length;

    // 2. Platform Stats — use real SQL counts
    const trackStats = await typed.getTrackModerationStats();
    const radioStations = await radioAnalyticsStore.getAll();
    const publishedTracks = await typed.getPublishedTracks(999);
    const stats = {
      totalArtists: allArtists.length,
      totalTracks: trackStats.total,
      publishedTracks: trackStats.approved,
      totalPlays: publishedTracks.reduce((sum: number, t: any) => sum + (t?.plays_count || 0), 0),
      totalRadioStations: radioStations.length,
      updatedAt: new Date().toISOString(),
    };
    await platformStatsStore.set('platform', stats);
    results.platformStats = stats;

    // 3. Genres
    const genreMap: Record<string, number> = {};
    for (const a of allArtists) {
      if ((a as any)?.genre) { const g = (a as any).genre; genreMap[g] = (genreMap[g] || 0) + 1; }
    }
    for (const t of publishedTracks) {
      if ((t as any)?.genre) { const g = (t as any).genre; genreMap[g] = (genreMap[g] || 0) + 1; }
    }
    await platformStatsStore.set('genres', genreMap);
    results.genres = Object.keys(genreMap).length;

    // 4. Weekly Chart TOP-20
    const chartSources = await chartSourcesStore.getAll();
    const trackScores: Record<string, { artist: string; title: string; score: number; sources: string[] }> = {};
    for (const src of chartSources) {
      const tracks = (src as any)?.tracks || [];
      const sourceMax = tracks.length;
      for (const t of tracks) {
        if (!t.artist || !t.title) continue;
        const key = `${t.artist.toLowerCase()}|||${t.title.toLowerCase()}`;
        if (!trackScores[key]) {
          trackScores[key] = { artist: t.artist, title: t.title, score: 0, sources: [] };
        }
        trackScores[key].score += (sourceMax - (t.position || 0) + 1);
        trackScores[key].sources.push((src as any).sourceId || 'unknown');
      }
    }
    const top20 = Object.values(trackScores)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((t, idx) => ({
        position: idx + 1, artist: t.artist, title: t.title,
        score: t.score, sources: [...new Set(t.sources)],
      }));
    await platformStatsStore.set('chart:weekly:top20', { entries: top20, updatedAt: new Date().toISOString() });
    results.weeklyChart = top20.length;

    // Auto-create profiles for chart artists
    for (const entry of top20) {
      if (entry.artist) {
        await ensureArtistProfile(entry.artist, (entry as any).coverUrl, { chart_position: entry.position, source: 'chart:promofm' });
      }
    }

    return c.json({ success: true, results });
  } catch (error) {
    console.error('[seed-live] Error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ============================================
// ADMIN: NEWS CRUD (KV — unchanged)
// ============================================

landing.post('/admin/news', requireAdminOrKey, async (c) => {
  try {
    const body = await c.req.json();
    const id = body.id || `news-manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newsItem = {
      id, title: body.title || '', excerpt: body.excerpt || '',
      content: body.content || '', category: body.category || 'industry',
      tags: body.tags || [], source: body.source || 'admin', sourceId: body.sourceId || 'manual',
      sourceUrl: sanitizeString(body.sourceUrl, 2000), imageUrl: sanitizeString(body.imageUrl, 2000),
      authorName: body.authorName || '', authorAvatar: body.authorAvatar || '',
      publishedAt: body.publishedAt || new Date().toISOString(),
      status: body.status || 'published', createdAt: new Date().toISOString(),
    };
    await newsPublicStore.set(id, newsItem);
    // Auto-ping search engines
    pingSitemapAsync(id).catch(() => {});
    return c.json({ success: true, data: newsItem });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

landing.put('/admin/news/:id', requireAdminOrKey, async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await newsPublicStore.get(id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    const body = await c.req.json();
    const updated = { ...existing, ...body, id, updatedAt: new Date().toISOString() };
    await newsPublicStore.set(id, updated);
    // Auto-ping search engines
    pingSitemapAsync(id).catch(() => {});
    return c.json({ success: true, data: updated });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

landing.delete('/admin/news/:id', requireAdminOrKey, async (c) => {
  try {
    const id = c.req.param('id');
    await newsPublicStore.del(id);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

landing.get('/admin/news', requireAdminOrKey, async (c) => {
  try {
    const all = await newsPublicStore.getAll();
    return c.json({ success: true, data: all });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

// ============================================
// ADMIN: TRACKS — now uses typed SQL table
// No more manual "publish to public namespace" needed!
// Tracks become public when moderation_status='published'
// ============================================

/** GET /admin/tracks — all published tracks from SQL */
landing.get('/admin/tracks', requireAdminOrKey, async (c) => {
  try {
    const tracks = await typed.getPublishedTracks(500);
    return c.json({ success: true, data: tracks });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

/** POST /admin/tracks — insert directly into typed tracks table */
landing.post('/admin/tracks', requireAdminOrKey, async (c) => {
  try {
    const body = await c.req.json();
    const track = await typed.insertTrack({
      title: body.title || 'Untitled',
      artist_name: body.artist || '',
      genre: body.genre || '',
      duration: body.duration || 0,
      audio_url: body.audioUrl || body.audio_url || '',
      cover_url: body.coverUrl || body.cover_url || '',
      moderation_status: 'published', // admin publishes directly
    });
    return c.json({ success: true, data: track });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/** PUT /admin/tracks/:id — update track */
landing.put('/admin/tracks/:id', requireAdminOrKey, async (c) => {
  try {
    const trackId = c.req.param('id');
    const body = await c.req.json();
    const track = await typed.updateTrack(trackId, body);
    if (!track) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: track });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/** DELETE /admin/tracks/:id — delete track */
landing.delete('/admin/tracks/:id', requireAdminOrKey, async (c) => {
  try {
    const trackId = c.req.param('id');
    await typed.deleteTrack(trackId);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /admin/tracks/publish — NO LONGER NEEDED (kept for backward compat)
 * Moderation now sets status='published' directly. This is a no-op redirect.
 */
landing.post('/admin/tracks/publish', requireAdminOrKey, async (c) => {
  try {
    const { trackId } = await c.req.json();
    if (!trackId) {
      return c.json({ success: false, error: 'trackId required' }, 400);
    }
    const track = await typed.getTrackById(trackId);
    if (!track) return c.json({ success: false, error: 'Track not found' }, 404);

    // Just ensure it's published
    const updated = await typed.updateTrack(trackId, { moderation_status: 'published', is_hidden: false });
    return c.json({ success: true, data: updated });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default landing;
