import { Hono } from 'hono';
import * as db from './db.tsx';
import { pool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { getPlatformStats, setPlatformStats } from './db.tsx';
import { notifyVideoUpload } from './email-helper.tsx';

const videosRoutes = new Hono();

// ─── Clip sources config ─────────────────
const CLIP_SOURCES = {
  youtube_charts: {
    url: 'https://charts.youtube.com/charts/TopVideos/ru',
    waitFor: 8000,
  },
  muz_tv: {
    url: 'https://muz-tv.ru/charts/',
    waitFor: 5000,
  },
};

// ─── Parse YouTube Charts Russia markdown ─────────────────
function parseYouTubeCharts(md: string): Array<{
  rank: number; videoId: string; title: string; artist: string;
  views: number; thumbnail: string; releaseDate: string; source: string;
}> {
  const clips: any[] = [];
  const lines = md.split('\n');

  // Find entry start points: rank number followed within 3 lines by movement indicator
  const entryStarts: number[] = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const line = lines[i].trim();
    if (/^\d{1,3}$/.test(line)) {
      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        const next = lines[j].trim();
        if (/^[●▲▼]/.test(next) || next === 'NEW') {
          entryStarts.push(i);
          break;
        }
      }
    }
  }

  for (let e = 0; e < entryStarts.length && clips.length < 30; e++) {
    const startIdx = entryStarts[e];
    const endIdx = e + 1 < entryStarts.length ? entryStarts[e + 1] : startIdx + 40;
    const block = lines.slice(startIdx, endIdx).map(l => l.trim()).filter(l => l !== '');

    const rank = parseInt(block[0]);
    if (rank > 30) break;

    // Find video ID from thumbnail
    let videoId = '';
    let thumbIdx = -1;
    for (let i = 0; i < block.length; i++) {
      const m = block[i].match(/i\.ytimg\.com\/vi\/([a-zA-Z0-9_-]{11})/);
      if (m) {
        videoId = m[1];
        thumbIdx = i;
        break;
      }
    }
    if (!videoId || thumbIdx < 0) continue;

    // Title: first line after thumbnail
    const title = (thumbIdx + 1 < block.length) ? block[thumbIdx + 1] : '';
    if (!title || title.startsWith('|') || title === 'Currently unavailable') continue;

    // Artists: lines after title until date pattern
    const artistParts: string[] = [];
    let dateStr = '';
    for (let i = thumbIdx + 2; i < block.length; i++) {
      const l = block[i];
      if (/^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}$/.test(l)) {
        dateStr = l;
        break;
      }
      if (l === '&' || l === ',') continue;
      if (l.startsWith('|') || l === 'Share promo card' || l === 'View all Shorts') break;
      artistParts.push(l);
    }
    const artist = artistParts.join(', ');

    // Views: last large number (>1000) in block
    let views = 0;
    for (const l of block) {
      const vm = l.match(/^([\d,]+)$/);
      if (vm) {
        const num = parseInt(vm[1].replace(/,/g, ''));
        if (num > 1000) views = num;
      }
    }

    // Skip non-music content
    if (/behind the scenes|making of|interview|reaction/i.test(title)) continue;

    clips.push({
      rank,
      videoId,
      title,
      artist,
      views,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      releaseDate: dateStr,
      source: 'youtube_charts_ru',
    });
  }

  return clips;
}

// ─── Parse MUZ-TV Chart markdown ─────────────────
function parseMuzTVChart(md: string): Array<{
  rank: number; title: string; artist: string; thumbnail: string; source: string;
}> {
  const clips: any[] = [];
  const resultsIdx = md.indexOf('Результаты чарта');
  const section = resultsIdx >= 0 ? md.slice(resultsIdx) : md;
  const lines = section.split('\n').map(l => l.trim());

  let i = 0;
  while (i < lines.length) {
    const rankMatch = lines[i].match(/^(\d{1,2})$/);
    if (!rankMatch) { i++; continue; }
    const rank = parseInt(rankMatch[1]);
    if (rank > 20) break;

    let thumb = '';
    let title = '';
    let artist = '';

    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const line = lines[j];

      // Thumbnail with alt text "ARTIST - TITLE"
      const thumbMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (thumbMatch && !thumb) {
        thumb = thumbMatch[2];
        const alt = thumbMatch[1];
        if (alt.includes('\u2014')) {
          const parts = alt.split('\u2014').map((s: string) => s.trim());
          artist = parts[0];
          title = parts.slice(1).join(' \u2014 ');
        }
        continue;
      }

      const titleMatch = line.match(/^###\s+(.+)$/);
      if (titleMatch && !title) {
        title = titleMatch[1];
        continue;
      }

      if (title && !artist && line && !line.startsWith('#') && !line.startsWith('!')
          && !line.startsWith('[') && line !== '\u0433\u043e\u043b\u043e\u0441\u043e\u0432\u0430\u0442\u044c'
          && !line.startsWith('\u0412\u044b\u043f\u0443\u0441\u043a')) {
        artist = line;
        break;
      }
    }

    if (title && artist) {
      clips.push({ rank, title, artist, thumbnail: thumb, source: 'muz_tv' });
    }
    i++;
  }

  return clips;
}

// ─── Public: New Clips for landing page ─────────────────
videosRoutes.get('/newClips', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const cached: any = await getPlatformStats('videos:new_clips');
    if (cached?.clips?.length) {
      // Normalize field names and proxy YouTube thumbnails (YouTube CDN blocked in Russia)
      const normalized = cached.clips
        .map((clip: any) => {
          const vid = clip.videoId || clip.youtubeId || (clip.id || '').replace('yt-', '');
          const rawThumb = clip.thumbnail || clip.thumbnailUrl || clip.thumbnail_url || '';
          // Rewrite to local thumbnails (i.ytimg.com blocked in Russia)
          const localThumb = vid ? '/thumbnails/thumb_' + vid + '.jpg' : rawThumb;
          return {
            ...clip,
            videoId: vid,
            id: clip.id || vid,
            thumbnail: localThumb,
            thumbnail_url: localThumb,
          };
        })
        .filter((clip: any) => clip.thumbnail && clip.videoId);
      return c.json({ success: true, clips: normalized.slice(0, limit) });
    }
    return c.json({ success: true, clips: [] });
  } catch (error) {
    console.error('Error fetching new clips:', error);
    return c.json({ success: true, clips: [] });
  }
});

// ─── POST /build-clips ─────────────────
videosRoutes.post('/build-clips', async (c) => {
  const internalKey = c.req.header('x-internal-key');
  if (internalKey !== process.env.VPS_INTERNAL_KEY) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  if (!firecrawlKey) {
    return c.json({ success: false, error: 'FIRECRAWL_API_KEY not set' }, 500);
  }

  const results: any = { sources: {}, errors: [] };
  const startTime = Date.now();

  const fetchSource = async (name: string, url: string, waitFor: number): Promise<string> => {
    try {
      const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${firecrawlKey}`,
        },
        body: JSON.stringify({ url, formats: ['markdown'], waitFor }),
      });
      if (!resp.ok) {
        results.errors.push(`${name}: HTTP ${resp.status}`);
        return '';
      }
      const data: any = await resp.json();
      if (data.success && data.data?.markdown) {
        return data.data.markdown;
      }
      results.errors.push(`${name}: no markdown`);
      return '';
    } catch (err: any) {
      results.errors.push(`${name}: ${err.message}`);
      return '';
    }
  };

  const [ytMarkdown, muzMarkdown] = await Promise.all([
    fetchSource('youtube_charts', CLIP_SOURCES.youtube_charts.url, CLIP_SOURCES.youtube_charts.waitFor),
    fetchSource('muz_tv', CLIP_SOURCES.muz_tv.url, CLIP_SOURCES.muz_tv.waitFor),
  ]);

  const ytClips = ytMarkdown ? parseYouTubeCharts(ytMarkdown) : [];
  const muzClips = muzMarkdown ? parseMuzTVChart(muzMarkdown) : [];

  results.sources.youtube_charts = ytClips.length;
  results.sources.muz_tv = muzClips.length;

  // Deduplicate YouTube clips by title+artist (keep highest views)
  const seen = new Map<string, typeof ytClips[0]>();
  for (const yt of ytClips) {
    const key = `${yt.title.toLowerCase()}|||${yt.artist.toLowerCase()}`;
    const existing = seen.get(key);
    if (!existing || yt.views > existing.views) {
      seen.set(key, yt);
    }
  }
  const dedupedYT = Array.from(seen.values());

  // Build unified clips list
  const clips: Array<{
    videoId: string; id: string; title: string; artist: string;
    views: number; thumbnail: string; thumbnail_url: string;
    rank: number; source: string; releaseDate: string; onMuzTV: boolean;
  }> = [];

  for (const yt of dedupedYT) {
    const onMuzTV = muzClips.some(m => {
      const mTitle = m.title.toLowerCase();
      const yTitle = yt.title.toLowerCase();
      const mArtists = m.artist.toLowerCase().split(/[,&]/).map((a: string) => a.trim());
      const yArtists = yt.artist.toLowerCase();
      return (mTitle.length > 5 && yTitle.length > 5 && mTitle.slice(0, 6) === yTitle.slice(0, 6)) ||
        mArtists.some((a: string) => a.length > 3 && yArtists.includes(a));
    });

    clips.push({
      videoId: yt.videoId,
      id: yt.videoId,
      title: yt.title,
      artist: yt.artist,
      views: yt.views,
      thumbnail: yt.thumbnail,
      thumbnail_url: yt.thumbnail,
      rank: yt.rank,
      source: onMuzTV ? 'youtube+muz_tv' : 'youtube_charts_ru',
      releaseDate: yt.releaseDate,
      onMuzTV,
    });
  }

  // Sort: MUZ-TV matches boosted, then by rank
  clips.sort((a, b) => {
    if (a.onMuzTV && !b.onMuzTV) return -1;
    if (!a.onMuzTV && b.onMuzTV) return 1;
    return a.rank - b.rank;
  });

  // Filter out entries without valid videoId or thumbnail
  const finalClips = clips.filter(c => c.videoId && c.thumbnail).slice(0, 20);

  await setPlatformStats('videos:new_clips', {
    clips: finalClips,
    updatedAt: new Date().toISOString(),
    sourceCounts: results.sources,
    totalClips: finalClips.length,
  });

  results.totalClips = finalClips.length;
  results.top5 = finalClips.slice(0, 5).map((c: any) => `${c.rank}. ${c.artist} \u2014 ${c.title} (${c.views} views)`);
  results.durationMs = Date.now() - startTime;

  return c.json({ success: true, ...results });
});

// ─── Download thumbnails (YouTube blocked in Russia) ─────────────────
// Audit 2026-06-03: hardening на трёх векторах.
//
//  (1) PATH TRAVERSAL: t.videoId шёл в `/var/www/.../thumb_${videoId}.jpg`
//      без валидации. videoId="../../../etc/cron.d/evil" писал в /etc/...
//      Защита: regex на YT-ID shape ([A-Za-z0-9_-]{11}) + path.resolve
//      + startsWith проверка финального пути в THUMBS_DIR.
//
//  (2) SSRF: t.url fetched без allowlist. Атакующий писал
//      url=http://localhost:5432 → fetch к Postgres'у. Защита: hostname
//      whitelist на i.ytimg.com / img.youtube.com (единственные хосты
//      где живут YT-обложки).
//
//  (3) NO SIZE CAP: 10GB ответ → диск-залив. Защита: 512KB-cap через
//      Content-Length + ReadableStream byte-counter (Content-Length
//      может быть подделан или отсутствовать).
//
// Auth: x-internal-key (env), но defense-in-depth — даже при leak
// ключа эти три гейта блокируют exploit.
const THUMBS_DIR = '/var/www/promofm/html/thumbnails';
const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_THUMB_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com']);
const MAX_THUMB_BYTES = 512 * 1024;

videosRoutes.post('/download-thumbnails', async (c) => {
  const internalKey = c.req.header('x-internal-key');
  if (internalKey !== process.env.VPS_INTERNAL_KEY) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  try {
    const body = await c.req.json();
    const thumbnails: Array<{ videoId: string; url: string }> = body.thumbnails || [];
    if (thumbnails.length === 0) {
      return c.json({ success: false, error: 'No thumbnails provided' }, 400);
    }

    const fs = await import('node:fs');
    const nodePath = await import('node:path');
    const resolvedRoot = nodePath.resolve(THUMBS_DIR);

    let downloaded = 0;
    const errors: string[] = [];

    for (const t of thumbnails) {
      try {
        // (1) videoId shape — иначе никаких "../" в имени.
        if (typeof t.videoId !== 'string' || !YT_VIDEO_ID_RE.test(t.videoId)) {
          errors.push(`${String(t.videoId).slice(0, 32)}: invalid videoId`);
          continue;
        }

        // (2) URL allowlist — никаких internal-network/localhost/IP.
        let parsed: URL;
        try { parsed = new URL(t.url); } catch {
          errors.push(`${t.videoId}: invalid url`);
          continue;
        }
        if (parsed.protocol !== 'https:' || !YT_THUMB_HOSTS.has(parsed.hostname)) {
          errors.push(`${t.videoId}: url host not allowed (${parsed.hostname})`);
          continue;
        }

        const resp = await fetch(parsed.toString(), { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) { errors.push(`${t.videoId}: HTTP ${resp.status}`); continue; }

        // (3) size cap — Content-Length fast-fail, потом byte-counter
        // на body (cl может быть подделан или отсутствовать).
        const cl = Number(resp.headers.get('content-length') || 0);
        if (cl > MAX_THUMB_BYTES) {
          errors.push(`${t.videoId}: too large (${cl})`);
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.byteLength > MAX_THUMB_BYTES) {
          errors.push(`${t.videoId}: too large (${buffer.byteLength})`);
          continue;
        }

        // Final path containment — videoId уже прошёл shape-проверку,
        // это belt-and-suspenders defense на случай если regex когда-то
        // ослабят (например для длинных YT-ID).
        const targetPath = nodePath.resolve(THUMBS_DIR, `thumb_${t.videoId}.jpg`);
        if (!targetPath.startsWith(resolvedRoot + nodePath.sep)) {
          errors.push(`${t.videoId}: path escape`);
          continue;
        }
        fs.writeFileSync(targetPath, buffer);
        downloaded++;
      } catch (e: any) {
        errors.push(`${t.videoId || '?'}: ${e.message}`);
      }
    }

    return c.json({ success: true, downloaded, total: thumbnails.length, errors });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ─── Authenticated routes ─────────────────
videosRoutes.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const videos = await db.getVideosByUser(userId);
    return c.json({ success: true, data: videos || [] });
  } catch (error) {
    return c.json({ success: true, data: [] });
  }
});

videosRoutes.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const videoId = body.id || `video-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const video = {
      id: videoId, views: 0, likes: 0,
      ...body, userId,
      createdAt: body.createdAt || now, updatedAt: now,
    };
    await db.upsertVideo(userId, videoId, video);

    // Notify admin (email + Telegram). Resolve email/name from users so the
    // alert carries real identity. Fire-and-forget — the upload mustn't fail
    // because SMTP / Telegram is down.
    (async () => {
      try {
        const { rows } = await pool.query(
          'SELECT email, full_name, display_name FROM users WHERE id = $1 LIMIT 1',
          [userId],
        );
        const u = rows[0] || {};
        await notifyVideoUpload({
          title: body.title || body.name || 'Без названия',
          artist: u.full_name || u.display_name || body.artist || body.artistName || 'Автор',
          category: body.category || body.videoCategory,
          videoUrl: body.videoUrl || body.url,
          email: u.email || c.get('userEmail') || undefined,
          userId,
        });
      } catch (notifyErr) {
        console.error('[videos] admin notify failed:', notifyErr);
      }
    })();

    return c.json({ success: true, data: video }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default videosRoutes;
