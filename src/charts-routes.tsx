/**
 * CHARTS AGGREGATION ROUTES
 * Агрегация чартов из внешних источников (радиостанции и стриминги)
 * через Mistral для извлечения структурированных данных из HTML-страниц
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import { chartAggregationStore, chartSourcesStore, platformStatsStore, getTracksByUser } from './db.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';
async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) return next();
  return requireAuth(c, () => requireAdmin(c, next));
}

const charts = new Hono();

// ─── Chart Source Configuration ────────────────────────────

interface ChartSourceConfig {
  id: string;
  name: string;
  url: string;
  logo: string;
  type: 'radio' | 'streaming';
  gradient: string;
  borderColor: string;
  maxTracks: number;
  /** Описание формата для Mistral */
  parsingHint: string;
}

const CHART_SOURCES: ChartSourceConfig[] = [
  {
    id: 'russkoe',
    name: 'Русское Радио',
    url: 'https://russkoeradiofm.ru/hitparad/',
    logo: '🇷🇺',
    type: 'radio',
    gradient: 'from-red-500/20 to-blue-500/20',
    borderColor: 'border-red-500/30',
    maxTracks: 20,
    parsingHint: 'Хит-парад недели "Золотой граммофон". Извлеки ТОП-20 треков с позициями, названиями и исполнителями.',
  },
  {
    id: 'nashe',
    name: 'Наше Радио',
    url: 'https://www.nashe.ru/chartova',
    logo: '🎸',
    type: 'radio',
    gradient: 'from-orange-500/20 to-red-500/20',
    borderColor: 'border-orange-500/30',
    maxTracks: 13,
    parsingHint: 'Недельный хит-парад "Чартова дюжина". Извлеки 13 треков с позициями, названиями и исполнителями.',
  },
  {
    id: 'dfm',
    name: 'DFM',
    url: 'https://dfm.ru/charts/top-30',
    logo: '🔊',
    type: 'radio',
    gradient: 'from-cyan-500/20 to-blue-500/20',
    borderColor: 'border-cyan-500/30',
    maxTracks: 30,
    parsingHint: 'Общий чарт DFM Top-30. Извлеки ТОП-30 треков с позициями, названиями и исполнителями.',
  },
  {
    id: 'europa',
    name: 'Europa Plus',
    url: 'https://europaplus.ru/programs/top40',
    logo: '🌟',
    type: 'radio',
    gradient: 'from-yellow-500/20 to-orange-500/20',
    borderColor: 'border-yellow-500/30',
    maxTracks: 40,
    parsingHint: 'Europa Plus Top-40. Извлеки ТОП-40 треков с позициями, названиями и исполнителями.',
  },
];

// Яндекс Музыка — отдельная логика через JSON API (не HTML)
const YANDEX_CHART_CONFIG = {
  id: 'yandex',
  name: 'Яндекс Музыка',
  url: 'https://music.yandex.ru/handlers/chart.jsx',
  logo: '🔴',
  type: 'streaming' as const,
  gradient: 'from-red-600/20 to-yellow-600/20',
  borderColor: 'border-red-600/30',
  maxTracks: 50,
};


// ─── Deezer Preview URL ─────────────────────────────────
// 30-sec MP3 preview via Deezer Search API (free, no key needed)
async function fetchDeezerPreview(artist: string, title: string): Promise<string> {
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const resp = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`);
    if (!resp.ok) return '';
    const data = await resp.json() as any;
    return data?.data?.[0]?.preview || '';
  } catch { return ''; }
}

// Batch fetch previews for an array of tracks (max concurrency = 5)
async function enrichWithPreviews(tracks: Array<{ artist: string; title: string; previewUrl?: string }>): Promise<void> {
  const batch = 5;
  for (let i = 0; i < tracks.length; i += batch) {
    const chunk = tracks.slice(i, i + batch);
    const previews = await Promise.all(
      chunk.map(t => fetchDeezerPreview(t.artist, t.title))
    );
    chunk.forEach((t, idx) => { t.previewUrl = previews[idx]; });
  }
}

// Shazam Russia — парсинг HTML (alt-теги изображений содержат artist + title)
const SHAZAM_CHART_CONFIG = {
  id: 'shazam',
  name: 'Shazam Россия',
  url: 'https://www.shazam.com/charts/top-200/russia',
  logo: '🎤',
  type: 'streaming' as const,
  gradient: 'from-blue-500/20 to-cyan-500/20',
  borderColor: 'border-blue-500/30',
  maxTracks: 100,
};

interface ChartTrackEntry {
  position: number;
  previewUrl?: string;
  previousPosition: number;
  title: string;
  artist: string;
  trend: 'up' | 'down' | 'same' | 'new';
  trendValue: number;
}

interface ExternalChartData {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  logo: string;
  type: 'radio' | 'streaming';
  gradient: string;
  borderColor: string;
  tracks: ChartTrackEntry[];
  fetchedAt: string;
  parsedBy: 'mistral' | 'fallback';
  error?: string;
}

// ─── HTML Fetching & Text Extraction ───────────────────────

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`Chart fetch failed for ${url}: HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Strip HTML tags, scripts, styles to get clean text
    const cleanText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Limit to ~8000 chars to fit in Mistral context
    return cleanText.slice(0, 8000);
  } catch (error) {
    console.log(`Chart fetch error for ${url}: ${error}`);
    return null;
  }
}

// ─── Mistral Extraction ─────────────────────────────────────

async function extractChartWithMistral(
  sourceConfig: ChartSourceConfig,
  pageText: string,
): Promise<ChartTrackEntry[] | null> {
  const mistralKey = process.env.MISTRAL_API_KEY;
  if (!mistralKey) {
    console.log('MISTRAL_API_KEY not set, skipping chart extraction');
    return null;
  }

  const systemPrompt = `Ты - парсер музыкальных чартов. Из текста HTML-страницы извлеки список треков чарта.
${sourceConfig.parsingHint}

ВАЖНО:
- Верни ТОЛЬКО валидный JSON-массив
- Каждый элемент: {"position": число, "title": "Название трека", "artist": "Исполнитель"}
- Позиции начинаются с 1
- Максимум ${sourceConfig.maxTracks} треков
- Если не удалось извлечь чарт, верни пустой массив []
- НЕ добавляй markdown-обёртку, только чистый JSON
- Если трек содержит feat., оставь feat. в title`;

  try {
    const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mistralKey}`,
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Вот текст страницы чарта "${sourceConfig.name}" (${sourceConfig.url}):\n\n${pageText}` },
        ],
        temperature: 0.1,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      console.log(`Mistral chart extraction error for ${sourceConfig.id}: ${await resp.text()}`);
      return null;
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.log(`Mistral returned empty content for ${sourceConfig.id}`);
      return null;
    }

    // Parse the JSON response
    let parsed: any;
    try {
      // Try direct parse
      parsed = JSON.parse(content);
    } catch {
      // Try to extract JSON array from text
      const match = content.match(/\[[\s\S]*\]/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        console.log(`Failed to parse Mistral response for ${sourceConfig.id}: ${content.slice(0, 200)}`);
        return null;
      }
    }

    // Normalize: handle both {tracks: [...]} and [...] formats
    const rawTracks = Array.isArray(parsed) ? parsed : (parsed.tracks || parsed.chart || parsed.entries || []);

    if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
      console.log(`No tracks parsed for ${sourceConfig.id}`);
      return null;
    }

    // Load previous chart to calculate trends
    const prevData: any = await chartSourcesStore.get(sourceConfig.id);
    const prevTracks: ChartTrackEntry[] = prevData?.tracks || [];
    const prevPositionMap = new Map<string, number>();
    prevTracks.forEach(t => {
      prevPositionMap.set(`${t.artist}|||${t.title}`.toLowerCase(), t.position);
    });

    // Map to our format with trend calculation
    const entries: ChartTrackEntry[] = rawTracks
      .filter((t: any) => t.title && t.artist)
      .slice(0, sourceConfig.maxTracks)
      .map((t: any, idx: number) => {
        const position = t.position || idx + 1;
        const key = `${t.artist}|||${t.title}`.toLowerCase();
        const prevPos = prevPositionMap.get(key);

        let trend: ChartTrackEntry['trend'] = 'new';
        let trendValue = 0;

        if (prevPos !== undefined) {
          const diff = prevPos - position;
          if (diff > 0) {
            trend = 'up';
            trendValue = diff;
          } else if (diff < 0) {
            trend = 'down';
            trendValue = Math.abs(diff);
          } else {
            trend = 'same';
            trendValue = 0;
          }
        }

        return {
          position,
          previousPosition: prevPos ?? 0,
          title: String(t.title).trim(),
          artist: String(t.artist).trim(),
          trend,
          trendValue,
        };
      });

    console.log(`Extracted ${entries.length} tracks for ${sourceConfig.id} via Mistral`);
    return entries;
  } catch (error) {
    console.log(`Mistral extraction error for ${sourceConfig.id}: ${error}`);
    return null;
  }
}

// ─── Aggregation Logic ──────────────────────────────────────

async function aggregateSource(source: ChartSourceConfig): Promise<ExternalChartData> {
  const now = new Date().toISOString();

  // Step 1: Fetch page text
  const pageText = await fetchPageText(source.url);

  if (!pageText) {
    // Try to return cached data
    const cached: any = await chartSourcesStore.get(source.id);
    if (cached && cached.tracks?.length > 0) {
      console.log(`Using cached chart data for ${source.id} (fetch failed)`);
      return { ...cached, error: 'Не удалось загрузить страницу, используются кэшированные данные' };
    }
    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.url,
      logo: source.logo,
      type: source.type,
      gradient: source.gradient,
      borderColor: source.borderColor,
      tracks: [],
      fetchedAt: now,
      parsedBy: 'fallback',
      error: 'Не удалось загрузить страницу чарта',
    };
  }

  // Step 2: Extract chart with Mistral
  const tracks = await extractChartWithMistral(source, pageText);

  if (!tracks || tracks.length === 0) {
    // Return cached data if available
    const cached: any = await chartSourcesStore.get(source.id);
    if (cached && cached.tracks?.length > 0) {
      console.log(`Using cached chart data for ${source.id} (extraction failed)`);
      return { ...cached, error: 'Извлечение не удалось, используются кэшированные данные' };
    }
    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.url,
      logo: source.logo,
      type: source.type,
      gradient: source.gradient,
      borderColor: source.borderColor,
      tracks: [],
      fetchedAt: now,
      parsedBy: 'fallback',
      error: 'Не удалось извлечь данные чарта',
    };
  }

  // Step 3: Build result
  const result: ExternalChartData = {
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.url,
    logo: source.logo,
    type: source.type,
    gradient: source.gradient,
    borderColor: source.borderColor,
    tracks,
    fetchedAt: now,
    parsedBy: 'mistral',
  };

  // Step 4: Save to KV
  await chartSourcesStore.set(source.id, result);
  console.log(`Chart saved for ${source.id}: ${tracks.length} tracks`);

  return result;
}

// ─── Яндекс Музыка: прямой JSON API (100% точные данные) ─────

async function aggregateYandexChart(): Promise<ExternalChartData> {
  const now = new Date().toISOString();
  const cfg = YANDEX_CHART_CONFIG;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(cfg.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'X-Retpath-Y': 'https://music.yandex.ru/chart',
      },
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      console.log(`[charts] Yandex API failed: HTTP ${resp.status}`);
      const cached: any = await chartSourcesStore.get(cfg.id);
      if (cached?.tracks?.length) return { ...cached, error: 'API failed, cached data' };
      return emptyChart(cfg, 'Не удалось загрузить чарт Яндекс Музыки');
    }

    const json = await resp.json();

    // Парсим структуру Яндекс API
    // handlers/chart.jsx возвращает: { trackIds: string[], tracksById: Record<string, Track>, tracks: Track[] }
    // Каждый Track имеет: id, title, artists[], chart: { position, listeners, progress, shift }
    const trackIds: string[] = json.trackIds || [];
    const tracksMap: Record<string, any> = {};

    // tracksById — самый надёжный источник (ID → полные данные трека)
    if (json.tracksById) {
      for (const [id, t] of Object.entries(json.tracksById)) {
        tracksMap[id] = t;
      }
    }
    // Fallback: массив tracks (те же данные, но в массиве)
    if (Object.keys(tracksMap).length === 0 && json.tracks) {
      for (const t of json.tracks) {
        if (t.id) tracksMap[String(t.id)] = t;
      }
    }

    // Загружаем предыдущий чарт для трендов
    const prevData: any = await chartSourcesStore.get(cfg.id);
    const prevTracks: ChartTrackEntry[] = prevData?.tracks || [];
    const prevPosMap = new Map<string, number>();
    prevTracks.forEach(t => prevPosMap.set(`${t.artist}|||${t.title}`.toLowerCase(), t.position));

    // Собираем треки — trackIds задаёт порядок чарта
    const entries: ChartTrackEntry[] = [];

    for (const tid of trackIds.slice(0, cfg.maxTracks)) {
      const track = tracksMap[String(tid)];
      if (!track) continue;

      const artist = extractYandexArtist(track);
      const title = track.title || '';
      if (!artist || !title) continue;

      // Позиция из chart объекта трека (точная) или порядковый номер
      const chartInfo = track.chart || track.chartPosition || {};
      const position = chartInfo.position || (entries.length + 1);
      const progress = chartInfo.progress || 'new'; // 'up' | 'down' | 'same' | 'new'
      const shift = chartInfo.shift || 0;
      const listeners = chartInfo.listeners || 0;

      const key = `${artist}|||${title}`.toLowerCase();
      const prevPos = prevPosMap.get(key);

      // Используем progress из Яндекс API для точных трендов
      let trend: ChartTrackEntry['trend'] = 'new';
      let trendValue = 0;
      if (prevPos !== undefined) {
        const diff = prevPos - position;
        if (diff > 0) { trend = 'up'; trendValue = diff; }
        else if (diff < 0) { trend = 'down'; trendValue = Math.abs(diff); }
        else { trend = 'same'; }
      } else if (progress === 'up') {
        trend = 'up'; trendValue = Math.abs(shift);
      } else if (progress === 'down') {
        trend = 'down'; trendValue = Math.abs(shift);
      } else if (progress === 'same') {
        trend = 'same';
      }

      entries.push({ position, previousPosition: prevPos ?? 0, title, artist, trend, trendValue, previewUrl: '' });
    }

    // Если всё ещё 0 — попробуем через Mistral как fallback
    if (entries.length === 0) {
      console.log(`[charts] Yandex API: no tracks parsed from JSON, raw keys: ${Object.keys(json).join(', ')}`);
      const cached: any = await chartSourcesStore.get(cfg.id);
      if (cached?.tracks?.length) return { ...cached, error: 'Parsing failed, cached data' };
      return emptyChart(cfg, 'Не удалось распарсить ответ Яндекс API');
    }

    const result: ExternalChartData = {
      sourceId: cfg.id,
      sourceName: cfg.name,
      sourceUrl: 'https://music.yandex.ru/chart',
      logo: cfg.logo,
      type: cfg.type,
      gradient: cfg.gradient,
      borderColor: cfg.borderColor,
      tracks: entries,
      fetchedAt: now,
      parsedBy: 'json_api' as any,
    };

    await chartSourcesStore.set(cfg.id, result);
    console.log(`[charts] Yandex chart: ${entries.length} tracks from API`);
    return result;
  } catch (error) {
    console.log(`[charts] Yandex chart error: ${error}`);
    const cached: any = await chartSourcesStore.get(cfg.id);
    if (cached?.tracks?.length) return { ...cached, error: String(error) };
    return emptyChart(cfg, String(error));
  }
}

function extractYandexArtist(track: any): string {
  if (track.artists?.length > 0) {
    return track.artists.map((a: any) => a.name).filter(Boolean).join(', ');
  }
  return track.artist || '';
}

function emptyChart(cfg: typeof YANDEX_CHART_CONFIG | typeof SHAZAM_CHART_CONFIG, error: string): ExternalChartData {
  return {
    sourceId: cfg.id, sourceName: cfg.name, sourceUrl: cfg.url,
    logo: cfg.logo, type: cfg.type, gradient: cfg.gradient, borderColor: cfg.borderColor,
    tracks: [], fetchedAt: new Date().toISOString(), parsedBy: 'fallback', error,
  };
}

// ─── Shazam Chart Aggregation (HTML parsing) ─────────────────

async function aggregateShazamChart(): Promise<ExternalChartData> {
  const now = new Date().toISOString();
  const cfg = SHAZAM_CHART_CONFIG;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s for large page

    const resp = await fetch(cfg.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      console.log(`[charts] Shazam failed: HTTP ${resp.status}`);
      const cached: any = await chartSourcesStore.get(cfg.id);
      if (cached?.tracks?.length) return { ...cached, error: 'HTTP error, cached data' };
      return emptyChart(cfg, `HTTP ${resp.status}`);
    }

    const html = await resp.text();
    console.log(`[charts] Shazam HTML: ${html.length} bytes`);

    // Extract tracks from alt tags:
    // Pattern 1: alt="Album artwork for album titled {TITLE} by {ARTIST}"
    // Pattern 2: alt="Listen to {TITLE} by {ARTIST}"
    // Both in regular HTML and escaped JSON (RSC format)
    const trackMap = new Map<string, { artist: string; title: string }>();

    // Regular HTML alt tags
    const altRegex = /alt="(?:Album artwork for )?(?:album titled |Listen to )(.+?) by (.+?)"/g;
    let match;
    while ((match = altRegex.exec(html)) !== null) {
      const title = decodeHtmlEntities(match[1]);
      const artist = decodeHtmlEntities(match[2]);
      const key = title.toLowerCase().trim();
      if (!trackMap.has(key) && title.length > 0 && artist.length > 0) {
        trackMap.set(key, { artist, title });
      }
    }

    // Escaped JSON alt tags (RSC streaming format)
    const escapedHtml = html.replace(/\\"/g, '"');
    const altRegex2 = /alt":"(?:Album artwork for )?(?:album titled |Listen to )(.+?) by (.+?)"/g;
    while ((match = altRegex2.exec(escapedHtml)) !== null) {
      const title = decodeHtmlEntities(match[1]);
      const artist = decodeHtmlEntities(match[2]);
      const key = title.toLowerCase().trim();
      if (!trackMap.has(key) && title.length > 0 && artist.length > 0) {
        trackMap.set(key, { artist, title });
      }
    }

    if (trackMap.size === 0) {
      console.log(`[charts] Shazam: no tracks parsed from HTML`);
      const cached: any = await chartSourcesStore.get(cfg.id);
      if (cached?.tracks?.length) return { ...cached, error: 'Parsing failed, cached data' };
      return emptyChart(cfg, 'No tracks found in HTML');
    }

    // Load previous chart for trends
    const prevData: any = await chartSourcesStore.get(cfg.id);
    const prevTracks: ChartTrackEntry[] = prevData?.tracks || [];
    const prevPosMap = new Map<string, number>();
    prevTracks.forEach(t => prevPosMap.set(`${t.artist}|||${t.title}`.toLowerCase(), t.position));

    // Build entries (order from HTML = chart order)
    const entries: ChartTrackEntry[] = [];
    for (const [_key, { artist, title }] of trackMap) {
      if (entries.length >= cfg.maxTracks) break;

      const position = entries.length + 1;
      const normKey = `${artist}|||${title}`.toLowerCase();
      const prevPos = prevPosMap.get(normKey);

      let trend: ChartTrackEntry['trend'] = 'new';
      let trendValue = 0;
      if (prevPos !== undefined) {
        const diff = prevPos - position;
        if (diff > 0) { trend = 'up'; trendValue = diff; }
        else if (diff < 0) { trend = 'down'; trendValue = Math.abs(diff); }
        else { trend = 'same'; }
      }

      entries.push({ position, previousPosition: prevPos ?? 0, title, artist, trend, trendValue, previewUrl: '' });
    }

    const result: ExternalChartData = {
      sourceId: cfg.id,
      sourceName: cfg.name,
      sourceUrl: cfg.url,
      logo: cfg.logo,
      type: cfg.type,
      gradient: cfg.gradient,
      borderColor: cfg.borderColor,
      tracks: entries,
      fetchedAt: now,
      parsedBy: 'html_parser' as any,
    };

    await chartSourcesStore.set(cfg.id, result);
    console.log(`[charts] Shazam chart: ${entries.length} tracks from HTML`);
    return result;
  } catch (error) {
    console.log(`[charts] Shazam chart error: ${error}`);
    const cached: any = await chartSourcesStore.get(cfg.id);
    if (cached?.tracks?.length) return { ...cached, error: String(error) };
    return emptyChart(cfg, String(error));
  }
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\\u0026/g, '&')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>');
}

// ─── Routes ──────────────────────────────────────────────────

/**
 * GET /sources
 * Возвращает конфигурацию всех источников чартов
 */
charts.get('/sources', async (c) => {
  try {
    const allSources = [
      ...CHART_SOURCES.map(s => ({ ...s })),
      {
        id: YANDEX_CHART_CONFIG.id, name: YANDEX_CHART_CONFIG.name,
        url: 'https://music.yandex.ru/chart', logo: YANDEX_CHART_CONFIG.logo,
        type: YANDEX_CHART_CONFIG.type, gradient: YANDEX_CHART_CONFIG.gradient,
        borderColor: YANDEX_CHART_CONFIG.borderColor, maxTracks: YANDEX_CHART_CONFIG.maxTracks,
      },
      {
        id: SHAZAM_CHART_CONFIG.id, name: SHAZAM_CHART_CONFIG.name,
        url: SHAZAM_CHART_CONFIG.url, logo: SHAZAM_CHART_CONFIG.logo,
        type: SHAZAM_CHART_CONFIG.type, gradient: SHAZAM_CHART_CONFIG.gradient,
        borderColor: SHAZAM_CHART_CONFIG.borderColor, maxTracks: SHAZAM_CHART_CONFIG.maxTracks,
      },
    ];

    const sourcesWithData = await Promise.all(
      allSources.map(async (source: any) => {
        const data: any = await chartSourcesStore.get(source.id);
        return {
          id: source.id,
          name: source.name,
          url: source.url,
          logo: source.logo,
          type: source.type,
          gradient: source.gradient,
          borderColor: source.borderColor,
          maxTracks: source.maxTracks,
          hasCachedData: !!(data?.tracks?.length > 0),
          tracksCount: data?.tracks?.length || 0,
          lastFetched: data?.fetchedAt || null,
          parsedBy: data?.parsedBy || null,
        };
      })
    );
    return c.json({ success: true, data: sourcesWithData });
  } catch (error) {
    console.log(`Error fetching chart sources: ${error}`);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

/**
 * GET /all
 * Возвращает данные всех чартов из KV (кэшированные)
 */
charts.get('/all', async (c) => {
  try {
    const allCharts: ExternalChartData[] = [];

    // Radio sources
    for (const source of CHART_SOURCES) {
      const data: any = await chartSourcesStore.get(source.id);
      if (data && data.tracks?.length > 0) {
        allCharts.push(data);
      } else {
        allCharts.push({
          sourceId: source.id, sourceName: source.name, sourceUrl: source.url,
          logo: source.logo, type: source.type, gradient: source.gradient,
          borderColor: source.borderColor, tracks: [], fetchedAt: '', parsedBy: 'fallback',
        });
      }
    }

    // Yandex
    const yandexData: any = await chartSourcesStore.get('yandex');
    if (yandexData?.tracks?.length > 0) {
      allCharts.push(yandexData);
    } else {
      allCharts.push(emptyChart(YANDEX_CHART_CONFIG, 'No data'));
    }

    // Shazam
    const shazamData: any = await chartSourcesStore.get('shazam');
    if (shazamData?.tracks?.length > 0) {
      allCharts.push(shazamData);
    } else {
      allCharts.push(emptyChart(SHAZAM_CHART_CONFIG, 'No data'));
    }

    return c.json({ success: true, data: allCharts });
  } catch (error) {
    console.log(`Error fetching all charts: ${error}`);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

/**
 * GET /source/:id
 * Возвращает данные конкретного чарта из KV
 */
charts.get('/source/:id', async (c) => {
  try {
    const sourceId = c.req.param('id');
    const source = CHART_SOURCES.find(s => s.id === sourceId);
    const isYandex = sourceId === 'yandex';
    if (!source && !isYandex) {
      return c.json({ success: false, error: `Chart source "${sourceId}" not found` }, 404);
    }

    const data: any = await chartSourcesStore.get(sourceId);
    if (data && data.tracks?.length > 0) {
      return c.json({ success: true, data });
    }

    if (isYandex) {
      return c.json({ success: true, data: emptyChart(YANDEX_CHART_CONFIG, 'No cached data') });
    }

    return c.json({
      success: true,
      data: {
        sourceId: source!.id,
        sourceName: source!.name,
        sourceUrl: source!.url,
        logo: source!.logo,
        type: source!.type,
        gradient: source!.gradient,
        borderColor: source!.borderColor,
        tracks: [],
        fetchedAt: '',
        parsedBy: 'fallback',
      },
    });
  } catch (error) {
    console.log(`Error fetching chart source: ${error}`);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

/**
 * POST /aggregate
 * Запускает агрегацию данных из внешних источников
 * Можно указать sourceIds для агрегации конкретных источников
 */
charts.post('/aggregate', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const requestedIds: string[] = body.sourceIds || [];

    const sourcesToProcess = requestedIds.length > 0
      ? CHART_SOURCES.filter(s => requestedIds.includes(s.id))
      : CHART_SOURCES;

    if (sourcesToProcess.length === 0) {
      return c.json({ success: false, error: 'No valid source IDs provided' }, 400);
    }

    console.log(`Starting chart aggregation for ${sourcesToProcess.length} sources: ${sourcesToProcess.map(s => s.id).join(', ')}`);

    // Process sources sequentially to avoid rate limiting
    const results: Array<{
      sourceId: string;
      sourceName: string;
      tracksFound: number;
      parsedBy: string;
      error?: string;
    }> = [];

    for (const source of sourcesToProcess) {
      try {
        const result = await aggregateSource(source);
        results.push({
          sourceId: result.sourceId,
          sourceName: result.sourceName,
          tracksFound: result.tracks.length,
          parsedBy: result.parsedBy,
          error: result.error,
        });
      } catch (err) {
        results.push({
          sourceId: source.id,
          sourceName: source.name,
          tracksFound: 0,
          parsedBy: 'error',
          error: String(err),
        });
      }

      // Small delay between sources to be polite
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Save aggregation timestamp
    await chartAggregationStore.set('last', {
      timestamp: new Date().toISOString(),
      sourcesProcessed: results.length,
      totalTracks: results.reduce((sum, r) => sum + r.tracksFound, 0),
      results,
    });

    console.log(`Chart aggregation complete: ${results.length} sources processed`);

    return c.json({ success: true, data: { results } });
  } catch (error) {
    console.log(`Chart aggregation error: ${error}`);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

/**
 * GET /aggregation-status
 * Возвращает статус последней агрегации
 */
charts.get('/aggregation-status', async (c) => {
  try {
    const status: any = await chartAggregationStore.get('last');
    return c.json({ success: true, data: status || null });
  } catch (error) {
    console.log(`Error fetching aggregation status: ${error}`);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// ─── PromoFM Unified Chart ────────────────────────────────────

/** Вес источника при формировании сводного чарта */
const SOURCE_WEIGHTS: Record<string, number> = {
  yandex:   4,   // основной стриминг РФ, данные из JSON API
  shazam:   3,   // Shazam Россия — что реально шазамят (200 треков)
  europa:   2,   // крупнейшее радио
  dfm:      2,   // танцевальное радио
  russkoe:  2,   // русская музыка
  nashe:    1.5, // рок
  platform: 1,   // треки на платформе PromoFM
};

interface PromoFMChartEntry {
  position: number;
  previousPosition: number;
  artist: string;
  title: string;
  score: number;
  sources: { id: string; name: string; position: number }[];
  trend: 'up' | 'down' | 'same' | 'new';
  trendValue: number;
  onPlatform: boolean;
}

async function buildPromoFMChart(): Promise<PromoFMChartEntry[]> {
  // 1. Собираем все треки из внешних чартов (радио + Яндекс)
  const trackScores: Record<string, {
    artist: string;
    title: string;
    score: number;
    sources: { id: string; name: string; position: number }[];
  }> = {};

  // Все источники: радио + Яндекс + Shazam
  const allSourceIds = [
    ...CHART_SOURCES.map(s => ({ id: s.id, name: s.name })),
    { id: YANDEX_CHART_CONFIG.id, name: YANDEX_CHART_CONFIG.name },
    { id: SHAZAM_CHART_CONFIG.id, name: SHAZAM_CHART_CONFIG.name },
  ];

  for (const source of allSourceIds) {
    const data: any = await chartSourcesStore.get(source.id);
    if (!data?.tracks?.length) continue;

    const weight = SOURCE_WEIGHTS[source.id] || 1;
    const maxPos = data.tracks.length;

    for (const track of data.tracks) {
      if (!track.artist || !track.title) continue;

      // Нормализуем ключ для дедупликации
      const key = normalizeTrackKey(track.artist, track.title);

      if (!trackScores[key]) {
        trackScores[key] = {
          artist: track.artist,
          title: track.title,
          score: 0,
          sources: [],
        };
      }

      // Очки = вес × (maxPos - позиция + 1) / maxPos × 100
      const positionScore = ((maxPos - (track.position || 1) + 1) / maxPos) * 100;
      trackScores[key].score += weight * positionScore;
      trackScores[key].sources.push({
        id: source.id,
        name: source.name,
        position: track.position || 0,
      });
    }
  }

  // 2. Добавляем треки платформы (user_id="public")
  const platformTracks = await getTracksByUser('public');
  const platformWeight = SOURCE_WEIGHTS.platform || 1;

  for (const pt of platformTracks) {
    if (!(pt as any)?.title || !(pt as any)?.artist) continue;
    const key = normalizeTrackKey((pt as any).artist, (pt as any).title);

    if (!trackScores[key]) {
      trackScores[key] = {
        artist: (pt as any).artist,
        title: (pt as any).title,
        score: 0,
        sources: [],
      };
    }

    // Очки за прослушивания на платформе: log(plays+1) × weight × 10
    const plays = (pt as any).plays || 0;
    const playScore = Math.log10(plays + 1) * platformWeight * 10;
    trackScores[key].score += playScore;
    trackScores[key].sources.push({
      id: 'platform',
      name: 'ПРОМО.МУЗЫКА',
      position: 0,
    });
  }

  // 3. Загружаем предыдущий чарт для трендов
  const prevChart: any = await platformStatsStore.get('chart:promofm');
  const prevEntries: PromoFMChartEntry[] = prevChart?.entries || [];
  const prevPosMap = new Map<string, number>();
  prevEntries.forEach(e => {
    prevPosMap.set(normalizeTrackKey(e.artist, e.title), e.position);
  });

  // 4. Сортируем и берём TOP-50
  const sorted = Object.values(trackScores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  // 5. Формируем чарт с трендами
  const platformKeys = new Set(
    platformTracks
      .filter((t: any) => t?.title && t?.artist)
      .map((t: any) => normalizeTrackKey(t.artist, t.title))
  );

  const entries: PromoFMChartEntry[] = sorted.map((t, idx) => {
    const position = idx + 1;
    const key = normalizeTrackKey(t.artist, t.title);
    const prevPos = prevPosMap.get(key);

    let trend: PromoFMChartEntry['trend'] = 'new';
    let trendValue = 0;
    if (prevPos !== undefined) {
      const diff = prevPos - position;
      if (diff > 0) { trend = 'up'; trendValue = diff; }
      else if (diff < 0) { trend = 'down'; trendValue = Math.abs(diff); }
      else { trend = 'same'; }
    }

    return {
      position,
      previousPosition: prevPos ?? 0,
      artist: t.artist,
      title: t.title,
      score: Math.round(t.score * 10) / 10,
      sources: t.sources,
      trend,
      trendValue,
      onPlatform: platformKeys.has(key),
    };
  });

  return entries;
}

/** Нормализация ключа трека для дедупликации (artist|||title → lowercase, strip feat/ft) */
function normalizeTrackKey(artist: string, title: string): string {
  const a = artist.toLowerCase().trim()
    .replace(/\s*feat\.?\s*/gi, ' feat ')
    .replace(/\s*ft\.?\s*/gi, ' feat ')
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ');
  const t = title.toLowerCase().trim()
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ');
  return `${a}|||${t}`;
}

/**
 * POST /aggregate-promofm
 * Агрегирует все внешние чарты + треки платформы → сводный чарт PromoFM TOP-50
 */
charts.post('/aggregate-promofm', requireAdminOrKey, async (c) => {
  try {
    console.log('[charts] Building PromoFM unified chart...');

    const entries = await buildPromoFMChart();

    // Считаем статистику источников
    const sourceStats: Record<string, number> = {};
    for (const e of entries) {
      for (const s of e.sources) {
        sourceStats[s.id] = (sourceStats[s.id] || 0) + 1;
      }
    }

    const chartData = {
      entries,
      updatedAt: new Date().toISOString(),
      totalTracks: entries.length,
      sourceStats,
      onPlatformCount: entries.filter(e => e.onPlatform).length,
    };

    // Сохраняем сводный чарт
    await platformStatsStore.set('chart:promofm', chartData);

    // Также обновляем chart:weekly:top20 для лендинга
    await platformStatsStore.set('chart:weekly:top20', {
      entries: entries.slice(0, 20),
      updatedAt: new Date().toISOString(),
    });

    console.log(`[charts] PromoFM chart: ${entries.length} tracks, ${Object.keys(sourceStats).length} sources`);

    return c.json({ success: true, data: chartData });
  } catch (error) {
    console.error('[charts] PromoFM chart error:', error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

/**
 * GET /promofm
 * Сводный чарт PromoFM (кэшированный)
 */
charts.get('/promofm', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50');
    const chart: any = await platformStatsStore.get('chart:promofm');

    if (!chart?.entries?.length) {
      return c.json({ success: true, data: { entries: [], updatedAt: null } });
    }

    return c.json({
      success: true,
      data: {
        ...chart,
        entries: chart.entries.slice(0, limit),
      },
    });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});


/**
 * POST /build-new-releases
 * Собирает "Новинки недели": приоритет наши артисты, затем Shazam/Yandex новинки
 */
charts.post('/build-new-releases', requireAdminOrKey, async (c) => {
  try {
    console.log('[charts] Building weekly new releases...');
    const tracks: any[] = [];
    const seen = new Set<string>();

    // Priority 1: Our platform tracks (published, last 7 days)
    const platformTracks = await getTracksByUser('*');
    if (platformTracks && platformTracks.length > 0) {
      const weekAgo = Date.now() - 7 * 24 * 3600_000;
      const recent = platformTracks
        .filter((t: any) => t.moderation_status === 'published' && new Date(t.created_at).getTime() > weekAgo)
        .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      for (const t of recent.slice(0, 10)) {
        const key = `${t.artist_name}:${t.title}`.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          tracks.push({
            position: tracks.length + 1,
            title: t.title,
            artist: t.artist_name,
            source: 'platform',
            sourceLabel: 'ПРОМО.МУЗЫКА',
            isOurArtist: true,
            genre: t.genre || '',
            coverUrl: t.cover_url || '',
          });
        }
      }
    }

    // Priority 2: "new" entries from external charts
    const allCharts: any[] = [];
    for (const src of ['shazam', 'nashe', 'dfm', 'europa', 'russkoe', 'yandex']) {
      const chartData = await chartSourcesStore.get(src);
      if (chartData?.tracks) {
        allCharts.push({ sourceId: src, tracks: chartData.tracks });
      }
    }

    // Collect "new" and "up" trending tracks from external sources
    const newExternal: any[] = [];
    const upExternal: any[] = [];

    for (const chart of allCharts) {
      for (const t of chart.tracks) {
        const key = `${t.artist}:${t.title}`.toLowerCase();
        if (seen.has(key)) continue;

        const entry = {
          title: t.title,
          artist: t.artist,
          source: chart.sourceId,
          sourceLabel: t.sourceName || chart.sourceId,
          isOurArtist: false,
          genre: '',
          coverUrl: '',
          position: t.position,
        };

        if (t.trend === 'new') {
          newExternal.push(entry);
        } else if (t.trend === 'up') {
          upExternal.push(entry);
        }
      }
    }

    // Fill with "new" first, then "up" trending
    for (const t of newExternal) {
      if (tracks.length >= 10) break;
      const key = `${t.artist}:${t.title}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tracks.push({ ...t, position: tracks.length + 1 });
      }
    }

    // Priority 3: Top tracks from Yandex/Shazam (fill remaining slots)
    if (tracks.length < 10) {
      for (const chart of allCharts) {
        if (!['yandex', 'shazam'].includes(chart.sourceId)) continue;
        for (const t of chart.tracks) {
          if (tracks.length >= 10) break;
          const key = `${t.artist}:${t.title}`.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          tracks.push({
            position: tracks.length + 1,
            title: t.title,
            artist: t.artist,
            source: chart.sourceId,
            sourceLabel: chart.sourceId === 'yandex' ? 'Яндекс Музыка' : 'Shazam',
            isOurArtist: false,
            genre: '',
            coverUrl: '',
          });
        }
      }
    }

    // Enrich tracks with Deezer 30-sec preview URLs
    console.log('[charts] Fetching Deezer preview URLs for new releases...');
    await enrichWithPreviews(tracks);
    const withPreview = tracks.filter((t: any) => t.previewUrl).length;
    console.log('[charts] Deezer previews: ' + withPreview + '/' + tracks.length + ' tracks have audio');

    const data = {
      tracks,
      updatedAt: new Date().toISOString(),
      totalPlatform: tracks.filter((t: any) => t.isOurArtist).length,
      totalExternal: tracks.filter((t: any) => !t.isOurArtist).length,
    };

    await platformStatsStore.set('weekly:new_releases', data);

    console.log(`[charts] New releases: ${tracks.length} tracks (${data.totalPlatform} platform, ${data.totalExternal} external, ${withPreview} with audio)`);

    return c.json({ success: true, data });
  } catch (error) {
    console.error('[charts] Build new releases error:', error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

/**
 * POST /full-update
 * Полный цикл: агрегация внешних чартов → сводный PromoFM чарт
 */
charts.post('/full-update', requireAdminOrKey, async (c) => {
  try {
    console.log('[charts] Starting full chart update...');

    // Step 1: Агрегация радио-источников (HTML + Mistral)
    const results: any[] = [];
    for (const source of CHART_SOURCES) {
      try {
        const result = await aggregateSource(source);
        results.push({
          sourceId: result.sourceId,
          sourceName: result.sourceName,
          tracksFound: result.tracks.length,
          parsedBy: result.parsedBy,
          error: result.error,
        });
      } catch (err) {
        results.push({ sourceId: source.id, tracksFound: 0, error: String(err) });
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // Step 1b: Яндекс Музыка (прямой JSON API)
    try {
      const yandexResult = await aggregateYandexChart();
      results.push({
        sourceId: yandexResult.sourceId,
        sourceName: yandexResult.sourceName,
        tracksFound: yandexResult.tracks.length,
        parsedBy: 'json_api',
        error: yandexResult.error,
      });
    } catch (err) {
      results.push({ sourceId: 'yandex', tracksFound: 0, error: String(err) });
    }

    // Step 1c: Shazam Россия (HTML парсинг)
    try {
      const shazamResult = await aggregateShazamChart();
      results.push({
        sourceId: shazamResult.sourceId,
        sourceName: shazamResult.sourceName,
        tracksFound: shazamResult.tracks.length,
        parsedBy: 'html_parser',
        error: shazamResult.error,
      });
    } catch (err) {
      results.push({ sourceId: 'shazam', tracksFound: 0, error: String(err) });
    }

    // Save aggregation log
    await chartAggregationStore.set('last', {
      timestamp: new Date().toISOString(),
      sourcesProcessed: results.length,
      totalTracks: results.reduce((sum: any, r: any) => sum + r.tracksFound, 0),
      results,
    });

    // Step 2: Сводный чарт PromoFM
    const entries = await buildPromoFMChart();
    const sourceStats: Record<string, number> = {};
    for (const e of entries) {
      for (const s of e.sources) {
        sourceStats[s.id] = (sourceStats[s.id] || 0) + 1;
      }
    }

    const chartData = {
      entries,
      updatedAt: new Date().toISOString(),
      totalTracks: entries.length,
      sourceStats,
      onPlatformCount: entries.filter(e => e.onPlatform).length,
    };

    await platformStatsStore.set('chart:promofm', chartData);
    await platformStatsStore.set('chart:weekly:top20', {
      entries: entries.slice(0, 20),
      updatedAt: new Date().toISOString(),
    });

    console.log(`[charts] Full update done: ${results.length} sources, ${entries.length} chart entries`);

    return c.json({
      success: true,
      data: {
        aggregation: results,
        promofmChart: {
          totalTracks: entries.length,
          sourceStats,
          onPlatformCount: chartData.onPlatformCount,
          top5: entries.slice(0, 5).map(e => `${e.position}. ${e.artist} — ${e.title} (${e.score})`),
        },
      },
    });
  } catch (error) {
    console.error('[charts] Full update error:', error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default charts;
