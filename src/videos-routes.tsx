import { Hono } from 'hono';
import * as db from './db.tsx';
import { pool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { emitSSE } from './sse-routes.tsx';
import { getPlatformStats, setPlatformStats } from './db.tsx';
import { notifyVideoUpload, sendEmail, escapeHtml } from './email-helper.tsx';

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

    // Оплаченные промо-клипы артистов платформы (video promo-pipeline,
    // migration 122): пока promoted_until в будущем — идут ПЕРЕД
    // спарсенным чартом. Ошибка запроса (например, миграция ещё не
    // применена) не роняет секцию — остаётся чистый чарт.
    let promoted: any[] = [];
    try {
      const { rows } = await pool.query(
        `SELECT v.id, v.title, v.thumbnail_url, v.video_url,
                COALESCE(NULLIF(u.full_name, ''), NULLIF(u.display_name, ''), 'Артист') AS artist
           FROM videos v
           LEFT JOIN users u ON u.id::text = v.user_id::text
          WHERE v.promoted_until > NOW()
            AND COALESCE(v.is_hidden, false) = FALSE
          ORDER BY v.promoted_until DESC
          LIMIT 6`
      );
      promoted = rows.map((v: any) => ({
        id: String(v.id),
        videoId: '',
        title: v.title || 'Без названия',
        artist: v.artist,
        views: 0,
        thumbnail: v.thumbnail_url || '',
        thumbnail_url: v.thumbnail_url || '',
        url: v.video_url || '',
        source: 'promo_music',
        promoted: true,
      }));
    } catch (promoErr: any) {
      console.warn('[videos] promoted clips query skipped:', promoErr?.message);
    }

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
      return c.json({ success: true, clips: [...promoted, ...normalized].slice(0, limit) });
    }
    return c.json({ success: true, clips: promoted.slice(0, limit) });
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
    const row = await db.upsertVideo(userId, videoId, video);
    if (row?.id) {
      // Настоящий id строки БД — клиент хранит его для последующих
      // pipeline/moderation-действий (фиктивный video-<uuid> им не матчится).
      video.id = String(row.id);
      (video as any).status = row.moderation_status || 'pending';
    }

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

// ═══════════════════════════════════════════════════════════════
// VIDEO PROMO-PIPELINE — admin-действия из VideoModeration.tsx.
// Зеркалит track-test pipeline (track-test-routes.tsx /pipeline/*):
// платные действия выставляют артисту payment-link (ЮКасса), фулфилмент
// в webhook'е checkout-routes.tsx по metadata.type. Цены подтверждены
// продуктом 2026-07-02 (совпадают с копирайтом в VideoModeration.tsx).
// Требует migration 122 (promoted_until / pipeline / newsletter_*).
// ═══════════════════════════════════════════════════════════════

const VIDEO_PIPELINE_PROMOTE_PRICE = 10000;
const VIDEO_PIPELINE_EXCLUSIVE_PRICE = 15000;
const VIDEO_PROMOTE_DAYS = 14;

async function getVideoRow(videoId: string) {
  // videos.id — uuid, videoId приходит text'ом из тела запроса → ::text.
  // user_id в videos — text (пишется из JWT в upsertVideo) → users.id::text.
  const { rows } = await pool.query(
    `SELECT v.id, v.user_id, v.title, v.video_url, v.thumbnail_url,
            v.promoted_until, v.pipeline, v.newsletter_requested_at, v.newsletter_sent_at,
            COALESCE(NULLIF(u.full_name, ''), NULLIF(u.display_name, ''), 'Артист') AS artist_name
       FROM videos v
       LEFT JOIN users u ON u.id::text = v.user_id::text
      WHERE v.id::text = $1
      LIMIT 1`,
    [String(videoId)]
  );
  return rows[0] || null;
}

async function setVideoPipelineKey(videoId: string, key: string, value: Record<string, any>) {
  await pool.query(
    `UPDATE videos
        SET pipeline = jsonb_set(COALESCE(pipeline, '{}'::jsonb), $2::text[], $3::jsonb, true),
            updated_at = NOW()
      WHERE id::text = $1`,
    [String(videoId), `{${key}}`, JSON.stringify(value)]
  );
}

async function createVideoPipelinePayment(
  video: any,
  type: 'video_promote' | 'video_exclusive',
  amount: number,
  description: string,
): Promise<{ orderId: string; confirmationUrl: string } | { error: string }> {
  if (!video.user_id) return { error: 'У клипа нет владельца — payment-link невозможен' };

  const { getGateway } = await import('./payment-gateway.tsx');
  const { upsertPaymentSession } = await import('./db.tsx');
  const orderId = crypto.randomUUID();
  const returnUrl = 'https://promo-music.ru/cabinet/artist?tab=video';

  try {
    const gw = getGateway('yookassa');
    const result = await gw.createPayment({
      amount, currency: 'RUB', description,
      gateway: 'yookassa',
      userId: video.user_id,
      orderId,
      returnUrl,
      metadata: {
        type,
        videoId: String(video.id),
        videoTitle: video.title,
      },
      savePaymentMethod: false,
      type: 'purchase',
    });

    await upsertPaymentSession(orderId, {
      orderId, userId: video.user_id,
      gateway: 'yookassa',
      gatewayPaymentId: result.sessionId,
      amount, currency: 'RUB', status: 'pending',
      type: 'purchase', description,
      metadata: {
        type,
        videoId: String(video.id),
        videoTitle: video.title,
      },
      savePaymentMethod: false,
      confirmationUrl: result.confirmationUrl,
      returnUrl,
      createdAt: new Date().toISOString(),
    });

    return { orderId, confirmationUrl: result.confirmationUrl };
  } catch (e: any) {
    return { error: `YooKassa: ${e?.message || 'unknown'}` };
  }
}

// A) Промо в секцию «Новые клипы» на главной (10 000 ₽, 14 дней).
videosRoutes.post('/promoteToNovelty', requireAuth, requireAdmin, async (c) => {
  try {
    const { videoId } = await c.req.json().catch(() => ({} as any));
    if (!videoId) return c.json({ success: false, error: 'videoId required' }, 400);
    const video = await getVideoRow(videoId);
    if (!video) return c.json({ success: false, error: 'Video not found' }, 404);
    if (video?.pipeline?.promote?.paid_at) {
      return c.json({ success: false, error: 'Этот клип уже промоутится' }, 409);
    }
    if (video.promoted_until && new Date(video.promoted_until) > new Date()) {
      return c.json({ success: false, error: 'Промо этого клипа ещё активно' }, 409);
    }

    const payment = await createVideoPipelinePayment(
      video,
      'video_promote',
      VIDEO_PIPELINE_PROMOTE_PRICE,
      `Клип «${video.title}» — секция «Новые клипы» на главной, ${VIDEO_PROMOTE_DAYS} дней`,
    );
    if ('error' in payment) return c.json({ success: false, error: payment.error }, 400);

    await setVideoPipelineKey(video.id, 'promote', {
      payment_order_id: payment.orderId,
      requested_at: new Date().toISOString(),
      requested_by_admin: c.get('userEmail') || c.get('userId'),
      paid_at: null,
    });

    const { upsertNotification } = await import('./db.tsx');
    const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await upsertNotification(video.user_id, notifId, {
      type: 'video_promote_invoice',
      title: 'Продвижение клипа в «Новые клипы»',
      message: `Админ предлагает разместить клип «${video.title}» на ${VIDEO_PROMOTE_DAYS} дней в секции «Новые клипы» на главной. Стоимость: ${VIDEO_PIPELINE_PROMOTE_PRICE} ₽.`,
      link: payment.confirmationUrl,
      metadata: { video_id: String(video.id), order_id: payment.orderId, amount: VIDEO_PIPELINE_PROMOTE_PRICE },
      created_at: new Date().toISOString(),
      read: false,
    });
    emitSSE(video.user_id, {
      type: 'notification',
      data: { title: 'Предложение от ПРОМО.МУЗЫКА', comment: `Продвинуть клип «${video.title}» за ${VIDEO_PIPELINE_PROMOTE_PRICE} ₽` },
    });

    return c.json({
      success: true,
      message: 'Артисту отправлено уведомление с payment-link',
      payment_order_id: payment.orderId,
      confirmation_url: payment.confirmationUrl,
    });
  } catch (error) {
    console.error('video promoteToNovelty error:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// B) Включение в понедельничный weekly-дайджест для ТВ и радио (бесплатно).
// Ничего не шлёт сразу — ставит клип в очередь radio-digest /run-weekly
// (курсор newsletter_requested_at → newsletter_sent_at).
videosRoutes.post('/addToNewsletter', requireAuth, requireAdmin, async (c) => {
  try {
    const { videoId } = await c.req.json().catch(() => ({} as any));
    if (!videoId) return c.json({ success: false, error: 'videoId required' }, 400);
    const video = await getVideoRow(videoId);
    if (!video) return c.json({ success: false, error: 'Video not found' }, 404);
    if (video.newsletter_sent_at) {
      return c.json({ success: false, error: 'Клип уже уходил в рассылку' }, 409);
    }
    if (video.newsletter_requested_at) {
      return c.json({ success: false, error: 'Клип уже в очереди ближайшей рассылки' }, 409);
    }

    await pool.query(
      `UPDATE videos SET newsletter_requested_at = NOW(), updated_at = NOW() WHERE id::text = $1`,
      [String(video.id)]
    );
    await setVideoPipelineKey(video.id, 'newsletter', {
      requested_at: new Date().toISOString(),
      requested_by_admin: c.get('userEmail') || c.get('userId'),
    });

    return c.json({
      success: true,
      message: 'Клип попадёт в ближайший понедельничный дайджест для ТВ и радио',
    });
  } catch (error) {
    console.error('video addToNewsletter error:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// C) Эксклюзив-pitch ТВ/радио-редакторам (15 000 ₽). Рассылка уходит
// после оплаты (webhook checkout-routes, metadata.type='video_exclusive')
// по той же базе, что и weekly-дайджест (getWeeklyRecipients).
videosRoutes.post('/exclusivePitch', requireAuth, requireAdmin, async (c) => {
  try {
    const { videoId } = await c.req.json().catch(() => ({} as any));
    if (!videoId) return c.json({ success: false, error: 'videoId required' }, 400);
    const video = await getVideoRow(videoId);
    if (!video) return c.json({ success: false, error: 'Video not found' }, 404);
    if (video?.pipeline?.exclusive?.paid_at) {
      return c.json({ success: false, error: 'Эксклюзив уже отправлен' }, 409);
    }

    const { getWeeklyRecipients } = await import('./radio-digest-routes.tsx');
    const recipients = await getWeeklyRecipients(pool);
    const editors_count = recipients.length;
    if (editors_count === 0) {
      return c.json({ success: false, error: 'Нет получателей ТВ/радио-базы' }, 400);
    }

    const payment = await createVideoPipelinePayment(
      video,
      'video_exclusive',
      VIDEO_PIPELINE_EXCLUSIVE_PRICE,
      `Эксклюзив-pitch клипа «${video.title}» — ${editors_count} ТВ/радио-редакторам`,
    );
    if ('error' in payment) return c.json({ success: false, error: payment.error }, 400);

    await setVideoPipelineKey(video.id, 'exclusive', {
      payment_order_id: payment.orderId,
      requested_at: new Date().toISOString(),
      requested_by_admin: c.get('userEmail') || c.get('userId'),
      planned_recipients_count: editors_count,
      paid_at: null,
    });

    const { upsertNotification } = await import('./db.tsx');
    const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await upsertNotification(video.user_id, notifId, {
      type: 'video_exclusive_invoice',
      title: 'Эксклюзив-pitch клипа ТВ и радио',
      message: `Админ предлагает отправить клип «${video.title}» ${editors_count} ТВ/радио-редакторам. Стоимость: ${VIDEO_PIPELINE_EXCLUSIVE_PRICE} ₽.`,
      link: payment.confirmationUrl,
      metadata: { video_id: String(video.id), order_id: payment.orderId, amount: VIDEO_PIPELINE_EXCLUSIVE_PRICE, editors_count },
      created_at: new Date().toISOString(),
      read: false,
    });
    emitSSE(video.user_id, {
      type: 'notification',
      data: { title: 'Предложение от ПРОМО.МУЗЫКА', comment: `Эксклюзив-pitch клипа «${video.title}» за ${VIDEO_PIPELINE_EXCLUSIVE_PRICE} ₽` },
    });

    return c.json({
      success: true,
      message: 'Артисту отправлено уведомление с payment-link',
      editors_count,
      payment_order_id: payment.orderId,
      confirmation_url: payment.confirmationUrl,
    });
  } catch (error) {
    console.error('video exclusivePitch error:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN MODERATION — реальная очередь модерации для VideoModeration.tsx
// (до 2026-07-02 админка жила на локальном DataContext-демо и ничего
// не писала на сервер). Требует migration 123 (moderation_*).
// ═══════════════════════════════════════════════════════════════

// GET /admin/list — все видимые видео для admin-очереди.
videosRoutes.get('/admin/list', requireAuth, requireAdmin, async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit') || '500', 10) || 500, 1000);
    const { rows } = await pool.query(
      `SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
              v.category, v.tags,
              v.created_at, v.moderation_status, v.moderation_note,
              v.promoted_until, v.newsletter_requested_at, v.newsletter_sent_at, v.pipeline,
              COALESCE(NULLIF(u.full_name, ''), NULLIF(u.display_name, ''), 'Артист') AS artist_name
         FROM videos v
         LEFT JOIN users u ON u.id::text = v.user_id::text
        WHERE COALESCE(v.is_hidden, false) = FALSE
        ORDER BY v.created_at DESC
        LIMIT $1`,
      [limit]
    );
    return c.json({
      success: true,
      videos: rows.map((r: any) => ({
        id: String(r.id),
        userId: r.user_id ? String(r.user_id) : '',
        title: r.title || 'Без названия',
        artist: r.artist_name,
        description: r.description || '',
        videoUrl: r.video_url || '',
        thumbnailUrl: r.thumbnail_url || '',
        category: r.category || '',
        tags: Array.isArray(r.tags) ? r.tags : [],
        createdAt: r.created_at,
        status: r.moderation_status || 'pending',
        moderationNote: r.moderation_note || '',
        promotedUntil: r.promoted_until,
        newsletterRequestedAt: r.newsletter_requested_at,
        newsletterSentAt: r.newsletter_sent_at,
        pipeline: r.pipeline || {},
      })),
    });
  } catch (error) {
    console.error('videos admin/list error:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// POST /:id/moderate — решение админа: approved | rejected (+ note).
// Регистрируется ПОСЛЕ всех статических POST'ов (promoteToNovelty и
// т.д.) — Hono route ordering, см. память проекта про /subscriptions/plans.
videosRoutes.post('/:id/moderate', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({} as any));
    const status = String(body.status || '');
    if (status !== 'approved' && status !== 'rejected') {
      return c.json({ success: false, error: "status must be 'approved' or 'rejected'" }, 400);
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
    if (status === 'rejected' && !note) {
      return c.json({ success: false, error: 'Причина отклонения обязательна' }, 400);
    }

    const { rows } = await pool.query(
      `UPDATE videos
          SET moderation_status = $2,
              moderation_note = NULLIF($3, ''),
              moderated_at = NOW(),
              moderated_by = $4,
              updated_at = NOW()
        WHERE id::text = $1
        RETURNING id, title, user_id`,
      [String(id), status, note, String(c.get('userEmail') || c.get('userId') || '')]
    );
    if (rows.length === 0) return c.json({ success: false, error: 'Video not found' }, 404);
    const video = rows[0];

    // Реальное уведомление артисту (тексты зеркалят прежние демо-тосты UI).
    if (video.user_id) {
      try {
        const { upsertNotification } = await import('./db.tsx');
        const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await upsertNotification(video.user_id, notifId, {
          type: status === 'approved' ? 'video_approved' : 'video_rejected',
          title: status === 'approved' ? '✅ Видео одобрено!' : '❌ Видео отклонено',
          message: status === 'approved'
            ? `Ваше видео «${video.title}» успешно прошло модерацию и опубликовано.`
            : `Ваше видео «${video.title}» не прошло модерацию. Причина: ${note}`,
          metadata: { video_id: String(video.id) },
          created_at: new Date().toISOString(),
          read: false,
        });
        emitSSE(video.user_id, {
          type: 'notification',
          data: {
            title: status === 'approved' ? 'Видео одобрено' : 'Видео отклонено',
            comment: `«${video.title}»${status === 'rejected' ? ` — ${note}` : ''}`,
          },
        });
      } catch (notifyErr) {
        console.error('[videos] moderate notify failed:', notifyErr);
      }

      // Письмо артисту. Раньше решение модератора жило только внутри
      // платформы: уведомление в колокольчике было, письма не было вовсе -
      // артист узнавал об одобрении, только если сам зашёл в кабинет.
      try {
        const u = await pool.query(
          'SELECT email, COALESCE(NULLIF(full_name, \'\'), NULLIF(display_name, \'\'), \'артист\') AS name FROM users WHERE id::text = $1',
          [String(video.user_id)]
        );
        const to = u.rows[0]?.email;
        const isPlaceholder = typeof to === 'string' && to.endsWith('@promo-music.ru');
        if (to && !isPlaceholder) {
          const title = escapeHtml(String(video.title || 'Без названия'));
          const head = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a14;color:#e5e5e5;border-radius:12px;overflow:hidden;">'
            + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px 32px;text-align:center;border-bottom:1px solid #2a2a4a;">'
            + '<img src="https://promo-music.ru/logo.png" alt="Промо.Музыка" style="height:36px;" />'
            + '<p style="margin:8px 0 0;color:#888;font-size:13px;">Платформа для музыкантов и лейблов</p></div><div style="padding:32px;">';
          const foot = '<p style="color:#888;">С уважением,<br/>Команда Промо.Музыка</p></div>'
            + '<div style="background:#0d0d1a;padding:20px 32px;border-top:1px solid #2a2a4a;text-align:center;font-size:12px;color:#666;">'
            + '<p style="margin:0 0 8px;">Промо.Музыка — <a href="https://promo-music.ru" style="color:#FF577F;text-decoration:none;">promo-music.ru</a></p>'
            + '<p style="margin:0 0 8px;">info@promofm.ru · Москва, Россия</p>'
            + '<p style="margin:0;color:#555;">Вы получили это письмо, так как загрузили клип на модерацию</p></div></div>';
          const cta = '<p style="text-align:center;margin:28px 0;"><a href="https://promo-music.ru/artist/video" style="display:inline-block;padding:12px 32px;background:#FF577F;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Открыть мои клипы</a></p>';

          const subject = status === 'approved' ? `Клип одобрен — ${video.title}` : `Клип отклонён — ${video.title}`;
          const html = status === 'approved'
            ? head + '<p>Добрый день!</p><p>Мы посмотрели ваш клип и с радостью сообщаем, что он прошёл модерацию.</p>'
                + `<p>Клип <strong>«${title}»</strong> одобрен к размещению на Промо.Музыка.</p>`
                + (note ? `<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ${escapeHtml(note)}</p>` : '')
                + '<p>Спасибо за ваше творчество и доверие к платформе.</p>' + cta + foot
            : head + '<p>Добрый день!</p>'
                + `<p>К сожалению, клип <strong>«${title}»</strong> не прошёл модерацию.</p>`
                + `<p style="padding:12px;background:#1a1a2e;border-left:3px solid #EF4444;border-radius:4px;">Причина: ${escapeHtml(note)}</p>`
                + '<p>Вы можете устранить замечания и отправить клип повторно.</p>' + cta + foot;

          const ok = await sendEmail({ to, subject, html });
          console.log(`[videos] письмо о модерации (${status}) -> ${to}: ${ok ? 'отправлено' : 'НЕ отправлено'}`);

          // Копия на админскую почту: решение модератора должно быть видно
          // в общем ящике, а не только в кабинете (просьба владельца 19.09.2026).
          const adminTo = process.env.ADMIN_EMAIL || 'info@promofm.ru';
          const adminHtml = head
            + `<p>Клип <strong>«${title}»</strong> — <strong>${status === 'approved' ? 'одобрен' : 'отклонён'}</strong>.</p>`
            + `<p>Артист: ${escapeHtml(String(u.rows[0]?.name || '-'))} (${escapeHtml(String(to))})</p>`
            + (note ? `<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ${escapeHtml(note)}</p>` : '')
            + foot;
          await sendEmail({
            to: adminTo,
            subject: `[ПРОМО] Клип ${status === 'approved' ? 'одобрен' : 'отклонён'}: ${video.title}`,
            html: adminHtml,
          });
        } else {
          console.log(`[videos] письмо не отправлено: ${isPlaceholder ? 'плейсхолдерный email (вход через VK)' : 'email не найден'}`);
        }
      } catch (mailErr: any) {
        console.error('[videos] ошибка письма о модерации:', mailErr?.message);
      }
    }

    return c.json({ success: true, id: String(video.id), status });
  } catch (error) {
    console.error('videos moderate error:', error);
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

export default videosRoutes;
