/**
 * AI CHARTS ROUTES — чарты AI-музыки (Suno, Udio и др.)
 *
 * Хранение: platform_stats
 *   id = 'ai_charts:{sourceId}'    — данные одного источника
 *   id = 'ai_charts:promofm'       — агрегированный композитный чарт
 *
 * Endpoints:
 *   GET  /sources         — данные всех AI-источников (публично)
 *   GET  /chart           — агрегированный PROMO.AI чарт (публично)
 *   POST /refresh         — пересобрать данные источников (admin/internal-key)
 *   POST /manual-update   — admin вручную обновляет любой источник
 *
 * Pipeline:
 *   /refresh → fetchSunoChart() + fetchUdioChart() + ... → store per-source
 *            → aggregateAiChart() → composite ranking → store ai_charts:promofm
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const app = new Hono();

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';
const requireAdminOrKey = async (c: any, next: () => Promise<void>) => {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && internalKey === ADMIN_INTERNAL_KEY) {
    await next();
    return;
  }
  return requireAuth(c, () => requireAdmin(c, next));
};


// iTunes Search API — preview clip + cover
async function fetchITunesPreview(artist: string, title: string): Promise<{ preview: string; cover: string }> {
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&limit=3&country=us`);
    if (!res.ok) return { preview: '', cover: '' };
    const data = (await res.json()) as any;
    const results = data.results || [];
    const titleLower = title.toLowerCase().slice(0, 10);
    let best = results.find((r: any) => (r.trackName || '').toLowerCase().includes(titleLower));
    if (!best && results.length > 0) best = results[0];
    if (best) {
      return {
        preview: best.previewUrl || '',
        cover: (best.artworkUrl100 || '').replace('100x100', '500x500'),
      };
    }
  } catch {}
  return { preview: '', cover: '' };
}

async function enrichTracksWithPreviews(tracks: any[]): Promise<void> {
  const batch = 5;
  for (let i = 0; i < tracks.length; i += batch) {
    const chunk = tracks.slice(i, i + batch);
    const results = await Promise.all(chunk.map((t) => fetchITunesPreview(t.artist, t.title)));
    chunk.forEach((t, idx) => {
      const r = results[idx];
      if (!t.audioUrl && r.preview) t.audioUrl = r.preview;
      if (!t.cover && r.cover) t.cover = r.cover;
    });
  }
}

// ── Source registry ──────────────────────────────────────────────────────

interface AiChartSource {
  id: string;
  name: string;
  url: string;
  logo?: string;
  description?: string;
  gradient: string;
  borderColor: string;
}

const AI_CHART_SOURCES: AiChartSource[] = [
  {
    id: 'suno',
    name: 'Suno AI',
    url: 'https://suno.com/home',
    logo: 'https://suno.com/favicon.ico',
    description: 'Лидирующая платформа AI-генерации песен',
    gradient: 'from-purple-500 to-pink-500',
    borderColor: 'border-purple-500/30',
  },
  {
    id: 'udio',
    name: 'Udio',
    url: 'https://www.udio.com/explore',
    description: 'AI-музыка от создателей Google DeepMind',
    gradient: 'from-blue-500 to-cyan-500',
    borderColor: 'border-blue-500/30',
  },
  {
    id: 'mubert',
    name: 'Mubert AI',
    url: 'https://mubert.com/',
    description: 'AI-саундтреки и адаптивная музыка',
    gradient: 'from-orange-500 to-red-500',
    borderColor: 'border-orange-500/30',
  },
  {
    id: 'promofm_ai',
    name: 'ПРОМО.МУЗЫКА AI',
    url: 'https://promo-music.ru/charts/ai',
    description: 'AI-треки артистов нашей платформы',
    gradient: 'from-fuchsia-500 to-purple-600',
    borderColor: 'border-fuchsia-500/30',
  },
];

// ── Internal AI source: native cols (migration 062 + 089) ──
// Migration 062 промоутнула is_ai_generated; 089 промоутнула ai_tool +
// backfill'нула is_ai_generated для legacy is_ai/isAi/aiTool/aiSource rows.
async function refreshInternalAiSource(): Promise<number> {
  const r = await pool.query(
    `SELECT id, title, artist_name, cover_url, audio_url, plays_count, likes_count,
            ai_tool, created_at
     FROM tracks
     WHERE moderation_status = 'published'
       AND is_ai_generated = TRUE
       AND audio_url IS NOT NULL AND audio_url <> ''
     ORDER BY (COALESCE(plays_count,0) * 0.1 + COALESCE(likes_count,0)) DESC
     LIMIT 30`
  );
  const trks = r.rows.map((t, idx) => ({
    title: t.title,
    artist: t.artist_name,
    plays: t.plays_count || 0,
    likes: t.likes_count || 0,
    cover: t.cover_url || null,
    url: `https://promo-music.ru/tracks/${t.id}`,
    audioUrl: t.audio_url || null,
    position: idx + 1,
    aiTool: t.ai_tool || null,
  }));
  await saveSourceData('promofm_ai', { sourceId: 'promofm_ai', sourceName: 'ПРОМО.МУЗЫКА AI', tracks: trks, lastUpdated: new Date().toISOString() });
  return trks.length;
}

// ── Storage helpers ──────────────────────────────────────────────────────

async function getStoredSource(sourceId: string): Promise<any | null> {
  const r = await pool.query(
    `SELECT data, updated_at FROM platform_stats WHERE id = $1`,
    [`ai_charts:${sourceId}`]
  );
  return r.rows[0] ? { ...(r.rows[0].data || {}), updatedAt: r.rows[0].updated_at } : null;
}

async function saveSourceData(sourceId: string, data: any): Promise<void> {
  await pool.query(
    `INSERT INTO platform_stats (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [`ai_charts:${sourceId}`, JSON.stringify(data)]
  );
}

// ── Endpoints ────────────────────────────────────────────────────────────

// GET /sources — список AI-источников с последними чартами
app.get('/sources', async (c) => {
  try {
    const enriched = await Promise.all(
      AI_CHART_SOURCES.map(async (s) => {
        const stored = await getStoredSource(s.id);
        return {
          ...s,
          tracks: stored?.tracks || [],
          fetchedAt: stored?.fetchedAt || stored?.updatedAt || null,
          parsedBy: stored?.parsedBy || null,
        };
      })
    );
    return c.json({ success: true, sources: enriched });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// GET /chart — агрегированный PROMO.AI чарт
app.get('/chart', async (c) => {
  try {
    const r = await pool.query(
      `SELECT data, updated_at FROM platform_stats WHERE id = 'ai_charts:promofm'`
    );
    const data = r.rows[0]?.data || { tracks: [], totalTracks: 0 };
    return c.json({
      success: true,
      chart: {
        ...data,
        updatedAt: r.rows[0]?.updated_at || data.updatedAt || null,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// POST /refresh — пересобрать данные через scraper'ы.
// Возвращает результаты по каждому источнику. Scraping выполняется через
// внешний скрипт (Playwright) — здесь только обновление меты через polling
// existing data. Реальный scraper триггерится cron'ом / админом локально.
app.post('/refresh', requireAdminOrKey, async (c) => {
  try {
    const stats: any[] = [];
    for (const s of AI_CHART_SOURCES) {
      const stored = await getStoredSource(s.id);
      stats.push({
        sourceId: s.id,
        sourceName: s.name,
        tracks: stored?.tracks?.length || 0,
        lastUpdated: stored?.fetchedAt || stored?.updatedAt || null,
      });
    }
    await rebuildCompositeChart();
    return c.json({
      success: true,
      sources: stats,
      message: 'Composite chart rebuilt. To pull fresh data from external sources, run the playwright scraper script.',
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// POST /manual-update — админ вручную загружает чарт по источнику.
// body: { sourceId, tracks: [{ title, artist, plays?, likes?, cover? }] }
app.post('/manual-update', requireAdminOrKey, async (c) => {
  try {
    const body = await c.req.json();
    const { sourceId, tracks } = body;
    const source = AI_CHART_SOURCES.find((s) => s.id === sourceId);
    if (!source) return c.json({ success: false, error: 'Unknown sourceId' }, 400);
    if (!Array.isArray(tracks)) return c.json({ success: false, error: 'tracks must be array' }, 400);

    const data = {
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.url,
      logo: source.logo,
      gradient: source.gradient,
      borderColor: source.borderColor,
      tracks: tracks.slice(0, 100).map((t: any, i: number) => ({
        position: i + 1,
        title: String(t.title || ''),
        artist: String(t.artist || ''),
        plays: Number(t.plays) || 0,
        likes: Number(t.likes) || 0,
        cover: t.cover || null,
        url: t.url || null,
        audioUrl: t.audioUrl || t.audio_url || null,
      })),
      fetchedAt: new Date().toISOString(),
      parsedBy: 'manual_admin',
    };

    // Enrich with iTunes preview + cover (best effort, non-blocking failures OK)
    try {
      await enrichTracksWithPreviews(data.tracks);
    } catch (e) {
      console.warn('[ai-charts] enrichment failed:', (e as any)?.message);
    }

    await saveSourceData(sourceId, data);
    await rebuildCompositeChart();
    return c.json({ success: true, sourceId, tracksAdded: data.tracks.length });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Compose PROMO.AI chart from all sources (weighted by plays + likes).
async function rebuildCompositeChart() {
  // Refresh internal source first (pulls fresh data from tracks)
  try { await refreshInternalAiSource(); } catch (e) { console.warn('[ai-charts] internal refresh failed:', e); }
  const allEntries: any[] = [];
  for (const s of AI_CHART_SOURCES) {
    const stored = await getStoredSource(s.id);
    if (stored?.tracks) {
      for (const t of stored.tracks) {
        // score = plays * 0.1 + likes * 1 (likes weight 10x plays since likes signal stronger preference)
        const score = (Number(t.plays) || 0) * 0.1 + (Number(t.likes) || 0);
        allEntries.push({
          title: t.title,
          artist: t.artist,
          source: s.id,
          sourceName: s.name,
          position: t.position,
          plays: t.plays || 0,
          likes: t.likes || 0,
          cover: t.cover || null,
          url: t.url || null,
          audioUrl: t.audioUrl || null,
          score,
        });
      }
    }
  }

  // Group by title+artist; sum scores across sources
  const grouped = new Map<string, any>();
  for (const e of allEntries) {
    const key = `${e.title.toLowerCase()}|${e.artist.toLowerCase()}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.score += e.score;
      if (!existing.sources.includes(e.source)) existing.sources.push(e.source);
      existing.plays += e.plays;
      existing.likes += e.likes;
      if (!existing.audioUrl && e.audioUrl) existing.audioUrl = e.audioUrl;
      if (!existing.cover && e.cover) existing.cover = e.cover;
    } else {
      grouped.set(key, {
        title: e.title,
        artist: e.artist,
        sources: [e.source],
        bestPosition: e.position,
        plays: e.plays,
        likes: e.likes,
        cover: e.cover,
        url: e.url,
        audioUrl: e.audioUrl || null,
        score: e.score,
      });
    }
  }

  const tracks = Array.from(grouped.values()).sort((a, b) => b.score - a.score);
  tracks.forEach((t, i) => { t.position = i + 1; });

  const sourceStats: Record<string, number> = {};
  for (const s of AI_CHART_SOURCES) {
    const stored = await getStoredSource(s.id);
    sourceStats[s.id] = stored?.tracks?.length || 0;
  }

  const composite = {
    totalTracks: tracks.length,
    sourceStats,
    tracks: tracks.slice(0, 50),
    updatedAt: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO platform_stats (id, data, updated_at)
     VALUES ('ai_charts:promofm', $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [JSON.stringify(composite)]
  );
}

export default app;
