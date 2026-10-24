/**
 * CHARTS AGGREGATION ROUTES
 * Агрегация чартов из внешних источников (радиостанции и стриминги)
 * через Mistral для извлечения структурированных данных из HTML-страниц
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import { getChartAggregationStatus, upsertChartAggregationStatus, getChartSource, upsertChartSource, listChartSources, getPlatformStats, setPlatformStats, getTracksByUser } from './db.tsx';
import { getPublishedTracks } from './db-typed.tsx';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { isUrlSafe } from './security.tsx';
import { safeErrorMessage } from './security.tsx';

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';
async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) return next();
  return requireAuth(c, async () => { await requireAdmin(c, next); });
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
  url: 'https://api.music.yandex.net/landing3/chart/russia',
  logo: '🔴',
  type: 'streaming' as const,
  gradient: 'from-red-600/20 to-yellow-600/20',
  borderColor: 'border-red-600/30',
  maxTracks: 50,
};


// ─── Deezer Preview URL ─────────────────────────────────
// 30-sec MP3 preview via Deezer Search API (free, no key needed)
interface DeezerResult {
  preview: string;
  coverUrl: string;
  coverSmall: string;
}

async function fetchDeezerData(artist: string, title: string): Promise<DeezerResult> {
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const resp = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`);
    if (!resp.ok) return { preview: '', coverUrl: '', coverSmall: '' };
    const data = await resp.json() as any;
    const hit = data?.data?.[0];
    if (!hit) return { preview: '', coverUrl: '', coverSmall: '' };
    return {
      preview: hit.preview || '',
      coverUrl: hit.album?.cover_big || hit.album?.cover_medium || hit.album?.cover || '',
      coverSmall: hit.album?.cover_small || hit.album?.cover || '',
    };
  } catch { return { preview: '', coverUrl: '', coverSmall: '' }; }
}

// Backward compat wrapper
async function fetchDeezerPreview(artist: string, title: string): Promise<string> {
  const d = await fetchDeezerData(artist, title);
  return d.preview;
}

// Batch fetch previews for an array of tracks (max concurrency = 5)

// iTunes Search API — stable preview URLs (no expiration)
async function fetchITunesPreview(artist: string, title: string, countryCode: string = "us"): Promise<{preview: string; cover: string}> {
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&limit=3&country=${countryCode}`);
    if (!res.ok) return { preview: '', cover: '' };
    const data = await res.json() as any;
    const results = data.results || [];
    // Try to match by title
    const titleLower = title.toLowerCase().slice(0, 10);
    let best = results.find((r: any) => (r.trackName || '').toLowerCase().includes(titleLower));
    if (!best && results.length > 0) best = results[0];
    if (best) {
      return {
        preview: best.previewUrl || '',
        cover: (best.artworkUrl100 || '').replace('100x100', '500x500'),
      };
    }
    return { preview: '', cover: '' };
  } catch {
    return { preview: '', cover: '' };
  }
}

async function enrichWithPreviews(tracks: Array<{ artist: string; title: string; previewUrl?: string; coverUrl?: string; coverSmall?: string }>): Promise<void> {
  const batch = 5;
  for (let i = 0; i < tracks.length; i += batch) {
    const chunk = tracks.slice(i, i + batch);
    // Try iTunes first (stable URLs), then Deezer as fallback
    const [itunesResults, deezerResults] = await Promise.all([
      Promise.all(chunk.map(t => fetchITunesPreview(t.artist, t.title))),
      Promise.all(chunk.map(t => fetchDeezerData(t.artist, t.title))),
    ]);
    chunk.forEach((t, idx) => {
      const itunes = itunesResults[idx];
      const deezer = deezerResults[idx];
      // Prefer iTunes (stable) over Deezer (expiring tokens)
      t.previewUrl = itunes.preview || deezer.preview || t.previewUrl || '';
      if (!t.coverUrl) t.coverUrl = itunes.cover || deezer.coverUrl || '';
      if (!t.coverSmall) t.coverSmall = deezer.coverSmall || '';
    });
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
  coverUrl?: string;
  coverSmall?: string;
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
  parsedBy: 'mistral' | 'fallback' | 'html_parser' | 'json_api';
  error?: string;
}

// ─── HTML Fetching & Text Extraction ───────────────────────

async function fetchPageText(url: string): Promise<string | null> {
  // SSRF protection: validate URL before fetching
  const urlCheck = await isUrlSafe(url);
  if (!urlCheck.safe) {
    console.warn('[SSRF blocked] ' + url + ': ' + urlCheck.reason);
    return null;
  }

  // Try Firecrawl first (handles JS-rendered pages like radio charts)
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  if (firecrawlKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + firecrawlKey,
        },
        body: JSON.stringify({ url, formats: ['markdown'], waitFor: 5000 }),
      });
      clearTimeout(timeout);

      if (resp.ok) {
        const data: any = await resp.json();
        if (data.success && data.data?.markdown) {
          const md = data.data.markdown;
          console.log('[charts] Firecrawl got ' + md.length + ' chars for ' + url);
          return md.slice(0, 12000);
        }
      }
      console.log('[charts] Firecrawl failed for ' + url + ', falling back to plain fetch');
    } catch (err) {
      console.log('[charts] Firecrawl error for ' + url + ': ' + err);
    }
  }

  // Fallback: plain fetch
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
      console.log('Chart fetch failed for ' + url + ': HTTP ' + response.status);
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

    return cleanText.slice(0, 8000);
  } catch (error) {
    console.log('Chart fetch error for ' + url + ': ' + error);
    return null;
  }
}

// ─── Mistral Extraction ─────────────────────────────────────

async function extractChartWithMistral(
  sourceConfig: ChartSourceConfig,
  pageText: string,
): Promise<ChartTrackEntry[] | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const geminiProxyUrl = process.env.GEMINI_PROXY_URL;
  const geminiProxyKey = process.env.GEMINI_PROXY_KEY || '';
  if (!anthropicKey && !geminiKey) {
    console.log('No ANTHROPIC_API_KEY or GEMINI_API_KEY set, skipping chart extraction');
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
- Если трек содержит feat., оставь feat. в title
- НЕ ПРИДУМЫВАЙ треки. Возвращай ТОЛЬКО то, что реально есть на странице.
- Если нашёл меньше треков чем запрошено – верни только найденные, НЕ заполняй остальное плейсхолдерами`;

  const userText = 'Вот текст страницы чарта "' + sourceConfig.name + '" (' + sourceConfig.url + '):\n\n' + pageText;

  try {
    let content: string | undefined;

    if (anthropicKey) {
      // Claude (Anthropic) — основной парсер; Gemini free-tier обнулился 2026-06.
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_CHART_MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: 4000,
          temperature: 0.1,
          system: systemPrompt,
          messages: [{ role: 'user', content: userText }],
        }),
      });
      if (!resp.ok) {
        console.log(`Claude chart extraction error for ${sourceConfig.id}: ${await resp.text()}`);
        return null;
      }
      const data: any = await resp.json();
      content = data.content?.[0]?.text;
    } else {
      // Fallback: Gemini (если задан только GEMINI_API_KEY)
      const geminiModel = 'gemini-2.0-flash';
      const geminiUrl = geminiProxyUrl
        ? `${geminiProxyUrl}/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`;
      const resp = await fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(geminiProxyKey ? { 'x-proxy-key': geminiProxyKey } : {}),
        },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: systemPrompt + '\n\n---\n\n' + userText }] },
          ],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4000 },
        }),
      });
      if (!resp.ok) {
        console.log(`Gemini chart extraction error for ${sourceConfig.id}: ${await resp.text()}`);
        return null;
      }
      const data: any = await resp.json();
      content = data.candidates?.[0]?.content?.parts?.[0]?.text || data.choices?.[0]?.message?.content;
    }

    if (!content) {
      console.log(`Empty extraction content for ${sourceConfig.id}`);
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
        console.log(`Failed to parse Gemini response for ${sourceConfig.id}: ${content.slice(0, 200)}`);
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
    const prevData: any = await getChartSource(sourceConfig.id);
    const prevTracks: ChartTrackEntry[] = prevData?.tracks || [];
    const prevPositionMap = new Map<string, number>();
    prevTracks.forEach(t => {
      prevPositionMap.set(`${t.artist}|||${t.title}`.toLowerCase(), t.position);
    });

    // Map to our format with trend calculation
    const entries: ChartTrackEntry[] = rawTracks
      .filter((t: any) => t.title && t.artist)
      .filter((t: any) => {
        // Reject LLM-generated placeholder tracks
        const title = String(t.title).trim();
        const artist = String(t.artist).trim();
        if (/^Название песни\s*\d+$/i.test(title)) return false;
        if (/^Артист\s*\d+$/i.test(artist)) return false;
        if (/^Track\s*\d+$/i.test(title)) return false;
        if (/^Artist\s*\d+$/i.test(artist)) return false;
        if (/^Song\s*\d+$/i.test(title)) return false;
        return true;
      })
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

    console.log(`Extracted tracks via Gemini`);
    return entries;
  } catch (error) {
    console.log(`Gemini extraction error for ${sourceConfig.id}: ${error}`);
    return null;
  }
}


// --- Direct HTML parser for Russian Radio (no LLM needed) ---
async function parseRusskoeRadioHTML(html: string, prevTracks: ChartTrackEntry[]): Promise<ChartTrackEntry[]> {
  const titleRegex = /<div class="rus-hit-title">(.*?)<\/div>/g;
  const artistRegex = /<div class="rus-hit-artist">(.*?)<\/div>/g;

  const titles: string[] = [];
  const artists: string[] = [];
  let match;

  while ((match = titleRegex.exec(html)) !== null) {
    titles.push(match[1].trim());
  }
  while ((match = artistRegex.exec(html)) !== null) {
    artists.push(match[1].trim());
  }

  const prevPositionMap = new Map<string, number>();
  prevTracks.forEach(t => {
    prevPositionMap.set(`${t.artist}|||${t.title}`.toLowerCase(), t.position);
  });

  const entries: ChartTrackEntry[] = [];
  const len = Math.min(titles.length, artists.length);

  for (let i = 0; i < len; i++) {
    const title = titles[i];
    const artist = artists[i];

    // Skip placeholder/fake tracks
    if (/^\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u043f\u0435\u0441\u043d\u0438\s*\d+$/i.test(title)) continue;
    if (/^\u0410\u0440\u0442\u0438\u0441\u0442\s*\d+$/i.test(artist)) continue;
    if (!title || !artist) continue;

    const position = entries.length + 1;
    const key = `${artist}|||${title}`.toLowerCase();
    const prevPos = prevPositionMap.get(key);

    let trend: 'up' | 'down' | 'same' | 'new' = 'new';
    let trendValue = 0;

    if (prevPos !== undefined) {
      const diff = prevPos - position;
      if (diff > 0) { trend = 'up'; trendValue = diff; }
      else if (diff < 0) { trend = 'down'; trendValue = Math.abs(diff); }
      else { trend = 'same'; trendValue = 0; }
    }

    entries.push({ position, previousPosition: prevPos ?? 0, title, artist, trend, trendValue });
  }

  return entries;
}

// --- Shared helpers for deterministic HTML chart parsers (no LLM) ---

/** Strip tags + decode entities + collapse whitespace from an HTML fragment. */
function htmlFragmentText(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Turn ordered {artist,title} pairs into ChartTrackEntry[] with trend vs previous chart. */
function pairsToEntries(
  pairs: { artist: string; title: string }[],
  prevTracks: ChartTrackEntry[],
  maxTracks: number,
): ChartTrackEntry[] {
  const prevPositionMap = new Map<string, number>();
  prevTracks.forEach(t => prevPositionMap.set(`${t.artist}|||${t.title}`.toLowerCase(), t.position));

  const entries: ChartTrackEntry[] = [];
  for (const p of pairs) {
    const title = (p.title || '').trim();
    const artist = (p.artist || '').trim();
    if (!title || !artist) continue;
    if (entries.length >= maxTracks) break;

    const position = entries.length + 1;
    const prevPos = prevPositionMap.get(`${artist}|||${title}`.toLowerCase());
    let trend: ChartTrackEntry['trend'] = 'new';
    let trendValue = 0;
    if (prevPos !== undefined) {
      const diff = prevPos - position;
      if (diff > 0) { trend = 'up'; trendValue = diff; }
      else if (diff < 0) { trend = 'down'; trendValue = Math.abs(diff); }
      else { trend = 'same'; }
    }
    entries.push({ position, previousPosition: prevPos ?? 0, title, artist, trend, trendValue });
  }
  return entries;
}

/** DFM Top-30 (dfm.ru/charts/top-30) — server-rendered rows, artist then title text nodes. */
function parseDfmHTML(html: string, prevTracks: ChartTrackEntry[]): ChartTrackEntry[] {
  const rows = html.split('class="group flex cursor-pointer items-center gap-4 self-center"').slice(1);
  const pairs: { artist: string; title: string }[] = [];
  for (const r of rows.slice(0, 30)) {
    const tokens = r.slice(0, 1500)
      .split(/<[^>]+>/)
      .map(t => htmlFragmentText(t))
      .filter(t => /[A-Za-zА-Яа-яЁё]/.test(t));
    if (tokens.length >= 2) pairs.push({ artist: tokens[0], title: tokens[1] });
  }
  return pairsToEntries(pairs, prevTracks, 30);
}

/** Europa Plus Top-40 (europaplus.ru/programs/top40). */
function parseEuropaHTML(html: string, prevTracks: ChartTrackEntry[]): ChartTrackEntry[] {
  const blocks = html.split('class="track-and-artists"').slice(1, 41);
  const pairs: { artist: string; title: string }[] = [];
  for (const b of blocks) {
    const nm = b.match(/class="track-name"[^>]*>([\s\S]*?)</);
    const ar = b.match(/class="artist"[^>]*>([\s\S]*?)</);
    if (nm && ar) pairs.push({ artist: htmlFragmentText(ar[1]), title: htmlFragmentText(nm[1]) });
  }
  return pairsToEntries(pairs, prevTracks, 40);
}

/** Наше Радио «Чартова дюжина» (nashe.ru/chartova): <p class="chartova__track">ARTIST / <span class="chartova__track_song">TITLE</span></p>. */
function parseNasheHTML(html: string, prevTracks: ChartTrackEntry[]): ChartTrackEntry[] {
  const pairs: { artist: string; title: string }[] = [];
  const re = /class="chartova__track">([\s\S]*?)\/\s*<span class="chartova__track_song">([\s\S]*?)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    pairs.push({ artist: htmlFragmentText(m[1]), title: htmlFragmentText(m[2]) });
  }
  return pairsToEntries(pairs, prevTracks, 13);
}

// ─── Aggregation Logic ──────────────────────────────────────

async function aggregateSource(source: ChartSourceConfig): Promise<ExternalChartData> {
  const now = new Date().toISOString();

  // Step 1: SSRF check + fetch raw HTML (deterministic parsers need the markup)
  const urlCheck = await isUrlSafe(source.url);
  if (!urlCheck.safe) {
    const cached: any = await getChartSource(source.id);
    if (cached && cached.tracks?.length > 0) return { ...cached, error: 'SSRF blocked, используются кэшированные данные' };
    return {
      sourceId: source.id, sourceName: source.name, sourceUrl: source.url, logo: source.logo,
      type: source.type, gradient: source.gradient, borderColor: source.borderColor,
      tracks: [], fetchedAt: now, parsedBy: 'fallback', error: 'SSRF blocked: ' + urlCheck.reason,
    };
  }

  let rawHtml: string | null = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const rawResp = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timeout);
    if (rawResp.ok) rawHtml = await rawResp.text();
    else console.log(`[charts] ${source.id} fetch failed: HTTP ${rawResp.status}`);
  } catch (e) {
    console.log(`[charts] ${source.id} fetch error: ${e}`);
  }

  if (!rawHtml) {
    const cached: any = await getChartSource(source.id);
    if (cached && cached.tracks?.length > 0) {
      return { ...cached, error: 'Не удалось загрузить страницу, используются кэшированные данные' };
    }
    return {
      sourceId: source.id, sourceName: source.name, sourceUrl: source.url, logo: source.logo,
      type: source.type, gradient: source.gradient, borderColor: source.borderColor,
      tracks: [], fetchedAt: now, parsedBy: 'fallback', error: 'Не удалось загрузить страницу чарта',
    };
  }

  // Step 2: Deterministic per-source HTML parser (no LLM)
  const prevData: any = await getChartSource(source.id);
  const prevTracks: ChartTrackEntry[] = prevData?.tracks || [];
  let tracks: ChartTrackEntry[] = [];
  switch (source.id) {
    case 'russkoe': tracks = await parseRusskoeRadioHTML(rawHtml, prevTracks); break;
    case 'dfm':     tracks = parseDfmHTML(rawHtml, prevTracks); break;
    case 'europa':  tracks = parseEuropaHTML(rawHtml, prevTracks); break;
    case 'nashe':   tracks = parseNasheHTML(rawHtml, prevTracks); break;
    default:        tracks = [];
  }

  if (!tracks || tracks.length === 0) {
    // Return cached data if available
    const cached: any = await getChartSource(source.id);
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
    parsedBy: 'html_parser',
  };

  // Step 4: Upsert into chart_sources (Postgres)
  await upsertChartSource({ id: source.id, ...result } as any);
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
      const cached: any = await getChartSource(cfg.id);
      if (cached?.tracks?.length) return { ...cached, error: 'API failed, cached data' };
      return emptyChart(cfg, 'Не удалось загрузить чарт Яндекс Музыки');
    }

    const json: any = await resp.json();

    // Парсим структуру landing3/chart/russia:
    // result.chart.tracks[] = [{ track: { title, artists[] }, chart: { position, progress, shift, listeners } }]
    const chartTracks: any[] = json?.result?.chart?.tracks || [];

    // Загружаем предыдущий чарт для трендов
    const prevData: any = await getChartSource(cfg.id);
    const prevTracks: ChartTrackEntry[] = prevData?.tracks || [];
    const prevPosMap = new Map<string, number>();
    prevTracks.forEach(t => prevPosMap.set(`${t.artist}|||${t.title}`.toLowerCase(), t.position));

    // Порядок массива = порядок чарта
    const entries: ChartTrackEntry[] = [];

    for (const item of chartTracks.slice(0, cfg.maxTracks)) {
      const track = item.track || item;
      if (!track) continue;

      const artist = extractYandexArtist(track);
      const title = track.title || '';
      if (!artist || !title) continue;

      // Позиция/тренд из chart-объекта позиции в чарте
      const chartInfo = item.chart || track.chart || {};
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
      const cached: any = await getChartSource(cfg.id);
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

    await upsertChartSource({ id: cfg.id, ...result } as any);
    console.log(`[charts] Yandex chart: ${entries.length} tracks from API`);
    return result;
  } catch (error) {
    console.log(`[charts] Yandex chart error: ${error}`);
    const cached: any = await getChartSource(cfg.id);
    if (cached?.tracks?.length) return { ...cached, error: safeErrorMessage(error) };
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
      const cached: any = await getChartSource(cfg.id);
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
      const cached: any = await getChartSource(cfg.id);
      if (cached?.tracks?.length) return { ...cached, error: 'Parsing failed, cached data' };
      return emptyChart(cfg, 'No tracks found in HTML');
    }

    // Load previous chart for trends
    const prevData: any = await getChartSource(cfg.id);
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

    await upsertChartSource({ id: cfg.id, ...result } as any);
    console.log(`[charts] Shazam chart: ${entries.length} tracks from HTML`);
    return result;
  } catch (error) {
    console.log(`[charts] Shazam chart error: ${error}`);
    const cached: any = await getChartSource(cfg.id);
    if (cached?.tracks?.length) return { ...cached, error: safeErrorMessage(error) };
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
        const data: any = await getChartSource(source.id);
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
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /all
 * Возвращает данные всех чартов из таблицы chart_sources (кэшированные)
 */
charts.get('/all', async (c) => {
  try {
    const allCharts: ExternalChartData[] = [];

    // Radio sources
    for (const source of CHART_SOURCES) {
      const data: any = await getChartSource(source.id);
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
    const yandexData: any = await getChartSource('yandex');
    if (yandexData?.tracks?.length > 0) {
      allCharts.push(yandexData);
    } else {
      allCharts.push(emptyChart(YANDEX_CHART_CONFIG, 'No data'));
    }

    // Shazam
    const shazamData: any = await getChartSource('shazam');
    if (shazamData?.tracks?.length > 0) {
      allCharts.push(shazamData);
    } else {
      allCharts.push(emptyChart(SHAZAM_CHART_CONFIG, 'No data'));
    }

    // ── Enrich tracks with iTunes preview URLs (with platform_stats cache) ──
    try {
      // 1. Load cached iTunes preview map from platform_stats
      const cachedMap: any = await getPlatformStats('itunes:preview_cache') || {};
      const itunesMap = new Map<string, string>(Object.entries(cachedMap.urls || {}));

      // 2. Add entries from chart:promofm
      const chartData: any = await getPlatformStats('chart:promofm');
      if (chartData?.entries?.length) {
        for (const e of chartData.entries) {
          if (e.previewUrl && e.previewUrl.includes('itunes.apple.com')) {
            itunesMap.set((e.title + '|' + e.artist).toLowerCase().trim(), e.previewUrl);
          }
        }
      }

      // 3. Match tracks from cache, collect unmatched
      const unmatchedTracks: { track: any; key: string }[] = [];
      for (const chart of allCharts) {
        for (const track of (chart.tracks || [])) {
          const key = (track.title + '|' + track.artist).toLowerCase().trim();
          const cached = itunesMap.get(key);
          if (cached) {
            (track as any).previewUrl = cached;
          } else {
            unmatchedTracks.push({ track, key });
          }
        }
      }

      // 4. iTunes Search API for unmatched (max 50 per request, background)
      let newFound = 0;
      if (unmatchedTracks.length > 0) {
        const batch = unmatchedTracks.slice(0, 50);
        const lookups = batch.map(({ track, key }) =>
          fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(track.title + ' ' + track.artist)}&media=music&limit=1`)
            .then((r) => r.json())
            .then((data: any) => {
              if (data.results?.[0]?.previewUrl) {
                (track as any).previewUrl = data.results[0].previewUrl;
                itunesMap.set(key, data.results[0].previewUrl);
                newFound++;
              }
            })
            .catch(() => {})
        );
        await Promise.allSettled(lookups);
        // Apply to remaining unmatched
        for (const { track, key } of unmatchedTracks.slice(50)) {
          const found = itunesMap.get(key);
          if (found) (track as any).previewUrl = found;
        }
      }

      // 5. Save updated cache back to platform_stats (if new URLs found)
      if (newFound > 0) {
        const urlsObj: Record<string, string> = {};
        for (const [k, v] of itunesMap) urlsObj[k] = v;
        await setPlatformStats('itunes:preview_cache', { urls: urlsObj, updatedAt: new Date().toISOString(), count: itunesMap.size });
      }
    } catch (enrichErr) {
      // Non-critical, continue without enrichment
    }

    return c.json({ success: true, data: allCharts });
  } catch (error) {
    console.log(`Error fetching all charts: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /source/:id
 * Возвращает данные конкретного чарта из таблицы chart_sources
 */
charts.get('/source/:id', async (c) => {
  try {
    const sourceId = c.req.param('id');
    const source = CHART_SOURCES.find(s => s.id === sourceId);
    const isYandex = sourceId === 'yandex';
    if (!source && !isYandex) {
      return c.json({ success: false, error: `Chart source "${sourceId}" not found` }, 404);
    }

    const data: any = await getChartSource(sourceId);
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
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
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

    // Save aggregation timestamp (atomic UPSERT через native cols).
    await upsertChartAggregationStatus({
      timestamp: new Date().toISOString(),
      sourcesProcessed: results.length,
      totalTracks: results.reduce((sum, r) => sum + r.tracksFound, 0),
      results,
    });

    console.log(`Chart aggregation complete: ${results.length} sources processed`);

    return c.json({ success: true, data: { results } });
  } catch (error) {
    console.log(`Chart aggregation error: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /aggregation-status
 * Возвращает статус последней агрегации
 */
charts.get('/aggregation-status', async (c) => {
  try {
    const status = await getChartAggregationStatus();
    return c.json({ success: true, data: status || null });
  } catch (error) {
    console.log(`Error fetching aggregation status: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
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
  previewUrl?: string;
  coverUrl?: string;
  coverSmall?: string;
}


// Треки, которые слишком долго на первых местах — понижаем или исключаем
const CHART_DEMOTED_TRACKS: Record<string, number> = {
  // key: normalizeTrackKey(artist, title) → penalty multiplier (0 = excluded, 0.3 = 70% penalty)
  'hollyflame|||тону': 0,           // убрать
  'uncleflexxx|||sms': 0,           // убрать
  'сдп|||сыпь, гармоника!': 0,       // убрать
  'sqwoz bab|||купер': 0,           // убрать
};

/**
 * Нейросетевые проекты, которых не должно быть в чарте.
 *
 * Владелец 2026-08-13: «убери везде трек Шадэ, Мот и т.д., это нейронка».
 * Такие проекты реально попадают в Яндекс и на радио, поэтому парсеры
 * тянут их честно — фильтровать надо на нашей стороне, иначе крон вернёт
 * их при следующей пересборке.
 *
 * Матчим по ПОДСТРОКЕ в артисте или названии, а не по точной паре: у
 * разных источников артист пишется по-разному, а проект выпустит
 * следующий трек и снова пролезет.
 *
 * ⚠️ Список ведём вручную, по решению владельца. Автоматически по вердикту
 * ИИ-детектора сюда НИЧЕГО не добавляем: он даёт ложные срабатывания на
 * живых артистах (инцидент 2026-08-07, пострадали Подиум, Заботина,
 * Маккартни и другие).
 */
const CHART_AI_BLOCKED: { artist?: string; title?: string; note: string }[] = [
  { artist: 'by индия', note: 'нейросетевой проект (Шадэ)' },
];

function isAiBlocked(artist: string, title: string): string | null {
  const a = (artist || '').toLowerCase();
  const t = (title || '').toLowerCase();
  for (const rule of CHART_AI_BLOCKED) {
    const artistHit = rule.artist ? a.includes(rule.artist) : false;
    const titleHit  = rule.title  ? t.includes(rule.title)  : false;
    if (artistHit || titleHit) return rule.note;
  }
  return null;
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

  const FRESH_MS = 4 * 24 * 60 * 60 * 1000; // источники старше 4 дней не учитываем — чтобы недоступные не лили старьё
  for (const source of allSourceIds) {
    const data: any = await getChartSource(source.id);
    if (!data?.tracks?.length) continue;
    const fetchedMs = data.fetchedAt ? Date.parse(data.fetchedAt) : 0;
    if (!fetchedMs || (Date.now() - fetchedMs) > FRESH_MS) {
      console.log(`[charts] skip stale source ${source.id} (fetchedAt=${data.fetchedAt})`);
      continue;
    }

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

      // Один источник засчитывается треку один раз: версии вроде «BAD TIMES» и
      // «BAD TIMES (Long Version)» сливаются в один ключ и давали источнику двойные очки
      // (23.10.2026, то же исправлено в promofm-charts-agent.py). Списки идут по возрастанию
      // позиции, поэтому остаётся лучшая.
      if (trackScores[key].sources.some(s => s.id === source.id)) continue;

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
  const prevChart: any = await getPlatformStats('chart:promofm');
  const prevEntries: PromoFMChartEntry[] = prevChart?.entries || [];
  const prevPosMap = new Map<string, number>();
  prevEntries.forEach(e => {
    prevPosMap.set(normalizeTrackKey(e.artist, e.title), e.position);
  });

  // 4. Сортируем и берём TOP-50
  // Apply demotion penalties
  for (const key of Object.keys(trackScores)) {
    const penalty = CHART_DEMOTED_TRACKS[key];
    if (penalty !== undefined) {
      trackScores[key].score *= penalty; // 0 = removed
    }
    const blocked = isAiBlocked(trackScores[key].artist, trackScores[key].title);
    if (blocked) {
      console.log(`[charts] исключён: ${trackScores[key].artist} – ${trackScores[key].title} (${blocked})`);
      trackScores[key].score = 0;
    }
  }

  const sorted = Object.values(trackScores)
    .filter(t => t.score > 0) // remove excluded (score=0)
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

    // Preserve existing covers from previous chart
    const prevChart: any = await getPlatformStats('chart:promofm');
    const prevCoverMap = new Map<string, { coverUrl: string; coverSmall: string; previewUrl: string }>();
    if (prevChart?.entries) {
      for (const pe of prevChart.entries) {
        const key = (pe.artist + '|||' + pe.title).toLowerCase();
        if (pe.coverUrl || pe.previewUrl) {
          prevCoverMap.set(key, { coverUrl: pe.coverUrl || '', coverSmall: pe.coverSmall || '', previewUrl: pe.previewUrl || '' });
        }
      }
    }
    // Apply previous covers first
    for (const e of entries) {
      const key = (e.artist + '|||' + e.title).toLowerCase();
      const prev = prevCoverMap.get(key);
      if (prev) {
        if (prev.coverUrl) (e as any).coverUrl = prev.coverUrl;
        if (prev.coverSmall) (e as any).coverSmall = prev.coverSmall;
        if (prev.previewUrl) (e as any).previewUrl = prev.previewUrl;
      }
    }
    // Enrich missing covers from Deezer
    const missingCovers = entries.filter(e => !(e as any).coverUrl);
    if (missingCovers.length > 0) {
      console.log('[charts] Enriching ' + missingCovers.length + ' entries missing covers...');
      await enrichWithPreviews(missingCovers as any);
    }

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
    await setPlatformStats('chart:promofm', chartData);

    // Также обновляем chart:weekly:top20 для лендинга
    await setPlatformStats('chart:weekly:top20', {
      entries: entries.slice(0, 20),
      updatedAt: new Date().toISOString(),
    });

    console.log(`[charts] PromoFM chart: ${entries.length} tracks, ${Object.keys(sourceStats).length} sources`);

    return c.json({ success: true, data: chartData });
  } catch (error) {
    console.error('[charts] PromoFM chart error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /promofm
 * Сводный чарт PromoFM (кэшированный)
 */
/**
 * GET /billboard — Billboard Hot 100, вся сотня.
 *
 * Владелец 2026-08-14: «добавим на главную чарт Billboard HOT 100, куда
 * будем парсить всю сотню каждую неделю».
 *
 * Данные кладёт `billboard-agent.py` (крон), здесь только отдача. Сам
 * агент отказывается перезаписывать чарт, если разобрал меньше 90
 * позиций — вёрстка Billboard меняется, и лучше отдать прошлую неделю,
 * чем огрызок.
 */
charts.get('/billboard', async (c) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '100', 10) || 100));
    const data: any = await getPlatformStats('chart:billboard_hot100');
    if (!data?.entries?.length) {
      return c.json({ success: true, data: { entries: [], chartDate: null, source: 'Billboard Hot 100' } });
    }
    return c.json({
      success: true,
      data: {
        source: data.source || 'Billboard Hot 100',
        chartDate: data.chartDate || null,
        updatedAt: data.fetchedAt || null,
        total: data.entries.length,
        entries: data.entries.slice(0, limit),
      },
    });
  } catch (err: any) {
    console.error('[charts/billboard] failed:', err?.message || err);
    return c.json({ success: false, error: 'Не удалось получить чарт' }, 500);
  }
});

charts.get('/promofm', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50');
    const chart: any = await getPlatformStats('chart:promofm');

    if (!chart?.entries?.length) {
      return c.json({ success: true, data: { entries: [], updatedAt: null } });
    }

    // RULE: отдаём только проигрываемые записи чарта (есть previewUrl).
    const playable = chart.entries.filter((e: any) => e.previewUrl);
    return c.json({
      success: true,
      data: {
        ...chart,
        entries: playable.slice(0, limit),
      },
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
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

    // Priority 1: Our platform tracks (published, last 30 days)
    const platformTracks = await getPublishedTracks(100, 'created_at');
    if (platformTracks && platformTracks.length > 0) {
      const monthAgo = Date.now() - 30 * 24 * 3600_000;
      const recent = platformTracks
        .filter((t: any) => new Date(t.created_at).getTime() > monthAgo)
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
            audioUrl: t.audio_url || '',
            trackId: t.id,
            stationsCount: 0,
            broadcastCitiesCount: 0,
          });
        }
      }
    }

    // Priority 2: "new" entries from external charts
    const allCharts: any[] = [];
    for (const src of ['shazam', 'nashe', 'dfm', 'europa', 'russkoe', 'yandex']) {
      const chartData = await getChartSource(src);
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

    // Enrich platform tracks with radio detection stats
    const platformIds = tracks.filter((t: any) => t.isOurArtist).map((t: any) => t.trackId).filter(Boolean);
    if (platformIds.length > 0) {
      try {
        const { rows } = await pool.query(
          `SELECT d.track_id,
                  COUNT(DISTINCT d.station_id) AS stations_count,
                  COALESCE(SUM(array_length(rs.broadcast_cities, 1)), 0) AS broadcast_cities_count
           FROM promo_check_detections d
           LEFT JOIN radio_stations rs ON rs.id = d.station_id
           WHERE d.track_id = ANY($1::uuid[])
           GROUP BY d.track_id`,
          [platformIds]
        );
        for (const row of rows) {
          const track = tracks.find((t: any) => t.trackId === row.track_id);
          if (track) {
            track.stationsCount = parseInt(row.stations_count) || 0;
            track.broadcastCitiesCount = parseInt(row.broadcast_cities_count) || 0;
          }
        }
      } catch (e) { /* promo_check_detections may not exist */ }
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

    await setPlatformStats('weekly:new_releases', data);

    console.log(`[charts] New releases: ${tracks.length} tracks (${data.totalPlatform} platform, ${data.totalExternal} external, ${withPreview} with audio)`);

    return c.json({ success: true, data });
  } catch (error) {
    console.error('[charts] Build new releases error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
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

    // Save aggregation log (atomic UPSERT через native cols).
    await upsertChartAggregationStatus({
      timestamp: new Date().toISOString(),
      sourcesProcessed: results.length,
      totalTracks: results.reduce((sum: any, r: any) => sum + r.tracksFound, 0),
      results,
    });

    // Step 2: Сводный чарт PromoFM
    const entries = await buildPromoFMChart();

    // Step 2b: Enrich chart entries with Deezer previews + cover art
    console.log('[charts] Enriching chart entries with Deezer data...');
    await enrichWithPreviews(entries as any);
    const enriched = entries.filter(e => (e as any).previewUrl || (e as any).coverUrl).length;
    console.log('[charts] Enriched ' + enriched + '/' + entries.length + ' chart entries with audio/covers');

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

    await setPlatformStats('chart:promofm', chartData);
    await setPlatformStats('chart:weekly:top20', {
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
          top5: entries.slice(0, 5).map(e => `${e.position}. ${e.artist} – ${e.title} (${e.score})`),
        },
      },
    });
  } catch (error) {
    console.error('[charts] Full update error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});


// ─── Public: Weekly Chart for landing page ─────────────
charts.get('/weekly', async (c) => {
  try {
    const cached: any = await getPlatformStats('chart:weekly:top20');
    if (cached?.entries?.length) {
      // RULE: только проигрываемые записи (есть previewUrl).
      const playable = cached.entries.filter((e: any) => e.previewUrl);
      return c.json({ success: true, data: { ...cached, entries: playable } });
    }
    return c.json({ success: true, data: { entries: [], updatedAt: null } });
  } catch (error) {
    console.error('Error fetching weekly chart:', error);
    return c.json({ success: true, data: { entries: [], updatedAt: null } });
  }
});


// ─── Cron: Refresh preview URLs (iTunes → Deezer fallback) ─────────
charts.post('/refresh-previews', async (c) => {
  try {
    const cached: any = await getPlatformStats('chart:weekly:top20');
    if (!cached?.entries?.length) {
      return c.json({ success: false, error: 'No chart data' }, 404);
    }

    const entries = cached.entries;
    let updated = 0;
    let failed = 0;

    for (const entry of entries) {
      // Check if current previewUrl still works
      let needsRefresh = !entry.previewUrl;
      if (entry.previewUrl) {
        try {
          const res = await fetch(entry.previewUrl, { method: 'HEAD' });
          if (res.status === 403 || res.status === 404 || res.status >= 500) {
            needsRefresh = true;
          }
        } catch {
          needsRefresh = true;
        }
      }

      if (needsRefresh) {
        const result = await fetchITunesPreview(entry.artist, entry.title);
        if (result.preview) {
          entry.previewUrl = result.preview;
          if (result.cover && !entry.coverUrl) entry.coverUrl = result.cover;
          updated++;
        } else {
          failed++;
        }
      }
    }

    // Save updated data back
    cached.updatedAt = new Date().toISOString();
    await setPlatformStats('chart:weekly:top20', cached);

    // Also update full chart
    const full: any = await getPlatformStats('chart:promofm');
    if (full?.entries?.length) {
      for (const fe of full.entries) {
        const match = entries.find((e: any) => e.artist === fe.artist && e.title === fe.title);
        if (match?.previewUrl) fe.previewUrl = match.previewUrl;
      }
      full.updatedAt = new Date().toISOString();
      await setPlatformStats('chart:promofm', full);
    }

    console.log();
    return c.json({ success: true, updated, failed, total: entries.length });
  } catch (error) {
    console.error('[charts] Preview refresh error:', error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});



// ═══════════════════════════════════════════════════════════════
// INTERNATIONAL CHARTS — Apple Music, Deezer, Shazam multi, Last.fm
// ═══════════════════════════════════════════════════════════════

const INTERNATIONAL_COUNTRIES = [
  { code: 'de', name: 'Germany', nameRu: 'Германия', flag: '🇩🇪', shazamSlug: 'germany' },
  { code: 'fr', name: 'France', nameRu: 'Франция', flag: '🇫🇷', shazamSlug: 'france' },
  { code: 'gb', name: 'United Kingdom', nameRu: 'Великобритания', flag: '🇬🇧', shazamSlug: 'united-kingdom' },
  { code: 'es', name: 'Spain', nameRu: 'Испания', flag: '🇪🇸', shazamSlug: 'spain' },
  { code: 'it', name: 'Italy', nameRu: 'Италия', flag: '🇮🇹', shazamSlug: 'italy' },
  { code: 'nl', name: 'Netherlands', nameRu: 'Нидерланды', flag: '🇳🇱', shazamSlug: 'netherlands' },
  { code: 'pl', name: 'Poland', nameRu: 'Польша', flag: '🇵🇱', shazamSlug: 'poland' },
  { code: 'se', name: 'Sweden', nameRu: 'Швеция', flag: '🇸🇪', shazamSlug: 'sweden' },
  { code: 'br', name: 'Brazil', nameRu: 'Бразилия', flag: '🇧🇷', shazamSlug: 'brazil' },
  { code: 'mx', name: 'Mexico', nameRu: 'Мексика', flag: '🇲🇽', shazamSlug: 'mexico' },
  { code: 'co', name: 'Colombia', nameRu: 'Колумбия', flag: '🇨🇴', shazamSlug: 'colombia' },
  { code: 'ar', name: 'Argentina', nameRu: 'Аргентина', flag: '🇦🇷', shazamSlug: 'argentina' },
  { code: 'cl', name: 'Chile', nameRu: 'Чили', flag: '🇨🇱', shazamSlug: 'chile' },
  { code: 'pe', name: 'Peru', nameRu: 'Перу', flag: '🇵🇪', shazamSlug: 'peru' },
  { code: 'ng', name: 'Nigeria', nameRu: 'Нигерия', flag: '🇳🇬', shazamSlug: 'nigeria' },
  { code: 'za', name: 'South Africa', nameRu: 'ЮАР', flag: '🇿🇦', shazamSlug: 'south-africa' },
  { code: 'ke', name: 'Kenya', nameRu: 'Кения', flag: '🇰🇪', shazamSlug: 'kenya' },
  { code: 'gh', name: 'Ghana', nameRu: 'Гана', flag: '🇬🇭', shazamSlug: 'ghana' },
  { code: 'eg', name: 'Egypt', nameRu: 'Египет', flag: '🇪🇬', shazamSlug: 'egypt' },
  { code: 'us', name: 'United States', nameRu: 'США', flag: '🇺🇸', shazamSlug: 'united-states' },
];

const INTL_REGIONS = [
  { id: 'europe', name: 'Europe', nameRu: 'Европа', flag: '🇪🇺',
    sources: ['apple', 'deezer', 'shazam'],
    countries: INTERNATIONAL_COUNTRIES.filter(c => ['de','fr','gb','es','it','nl','pl','se'].includes(c.code))
      .map(c => ({ code: c.code, name: c.name, nameRu: c.nameRu, flag: c.flag })),
  },
  { id: 'latam', name: 'Latin America', nameRu: 'Лат. Америка', flag: '🌎',
    sources: ['apple', 'deezer', 'shazam'],
    countries: INTERNATIONAL_COUNTRIES.filter(c => ['br','mx','co','ar','cl','pe'].includes(c.code))
      .map(c => ({ code: c.code, name: c.name, nameRu: c.nameRu, flag: c.flag })),
  },
  { id: 'africa', name: 'Africa', nameRu: 'Африка', flag: '🌍',
    sources: ['apple', 'shazam'],
    countries: INTERNATIONAL_COUNTRIES.filter(c => ['ng','za','ke','gh','eg'].includes(c.code))
      .map(c => ({ code: c.code, name: c.name, nameRu: c.nameRu, flag: c.flag })),
  },
  { id: 'global', name: 'Global', nameRu: 'Глобальный', flag: '🌐',
    sources: ['deezer', 'lastfm', 'apple'],
    countries: [{ code: 'us', name: 'United States', nameRu: 'США', flag: '🇺🇸' }],
  },
];

interface IntlChartEntry {
  position: number;
  title: string;
  artist: string;
  coverUrl?: string;
  previewUrl?: string;
  sourceUrl?: string;
}

// ─── Fetchers ─────────────────────────────────

async function fetchAppleMusicChart(countryCode: string, limit = 25): Promise<IntlChartEntry[]> {
  try {
    const url = `https://rss.marketingtools.apple.com/api/v2/${countryCode}/music/most-played/${limit}/songs.json`;
    const resp = await fetch(url);
    if (!resp.ok) { console.error(`[charts] Apple Music ${countryCode}: ${resp.status}`); return []; }
    const json = await resp.json() as any;
    const results = json?.feed?.results || [];
    return results.map((r: any, i: number) => ({
      position: i + 1,
      title: r.name || '',
      artist: r.artistName || '',
      coverUrl: r.artworkUrl100?.replace('100x100', '200x200') || '',
      sourceUrl: r.url || '',
    }));
  } catch (e) { console.error(`[charts] Apple Music ${countryCode} error:`, e); return []; }
}

async function fetchDeezerGlobalChart(limit = 50): Promise<IntlChartEntry[]> {
  try {
    const resp = await fetch(`https://api.deezer.com/chart/0?limit=${limit}`);
    if (!resp.ok) { console.error(`[charts] Deezer: ${resp.status}`); return []; }
    const json = await resp.json() as any;
    const tracks = json?.tracks?.data || [];
    return tracks.map((t: any, i: number) => ({
      position: i + 1,
      title: t.title || '',
      artist: t.artist?.name || '',
      coverUrl: t.album?.cover_medium || t.album?.cover || '',
      previewUrl: t.preview || '',
    }));
  } catch (e) { console.error('[charts] Deezer error:', e); return []; }
}

async function fetchShazamCountryChart(shazamSlug: string, limit = 50): Promise<IntlChartEntry[]> {
  try {
    const url = `https://www.shazam.com/charts/top-200/${shazamSlug}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!resp.ok) { console.error(`[charts] Shazam ${shazamSlug}: ${resp.status}`); return []; }
    const html = await resp.text();
    const entries: IntlChartEntry[] = [];
    const regex = /alt="([^"]+)\s*-\s*([^"]+)"/g;
    let match;
    while ((match = regex.exec(html)) !== null && entries.length < limit) {
      entries.push({
        position: entries.length + 1,
        title: match[2]?.trim() || '',
        artist: match[1]?.trim() || '',
      });
    }
    return entries;
  } catch (e) { console.error(`[charts] Shazam ${shazamSlug} error:`, e); return []; }
}

async function fetchLastFmChart(limit = 50): Promise<IntlChartEntry[]> {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) { console.warn('[charts] LASTFM_API_KEY not set'); return []; }
  try {
    const resp = await fetch(`https://ws.audioscrobbler.com/2.0/?method=chart.gettoptracks&api_key=${apiKey}&format=json&limit=${limit}`);
    if (!resp.ok) return [];
    const json = await resp.json() as any;
    const tracks = json?.tracks?.track || [];
    return tracks.map((t: any, i: number) => ({
      position: i + 1,
      title: t.name || '',
      artist: t.artist?.name || '',
    }));
  } catch (e) { console.error('[charts] Last.fm error:', e); return []; }
}

// ─── International chart helpers (chart_sources table) ─────────────────────────────────

async function saveIntlChart(platform: string, countryCode: string, entries: IntlChartEntry[]) {
  const key = `intl:${platform}:${countryCode}`;
  // International chart shape отличается от русских (platform/countryCode
  // вместо sourceName/logo/etc). Записываем компактно — tracks хранит
  // entries[], остальные поля минимальные (type='streaming').
  await upsertChartSource({
    id: key,
    sourceName: `${platform} ${countryCode.toUpperCase()}`,
    sourceUrl: '',
    type: 'streaming',
    tracks: entries as any,
    fetchedAt: new Date().toISOString(),
    parsedBy: 'json_api',
  });
}

async function getIntlChart(platform: string, countryCode: string) {
  const key = `intl:${platform}:${countryCode}`;
  return await getChartSource(key) as any;
}


// ─── International Preview Enrichment ─────────────────────────
// Enrich international chart entries with preview URLs from iTunes/Deezer
// Same approach as enrichWithPreviews but for IntlChartEntry[]
async function enrichIntlWithPreviews(entries: IntlChartEntry[], countryCode: string = "us"): Promise<void> {
  // 1. Load cached preview map
  const cachedMap: any = await getPlatformStats('itunes:intl_preview_cache') || {};
  const previewMap = new Map<string, { preview: string; cover: string }>(
    Object.entries(cachedMap.urls || {}).map(([k, v]: [string, any]) => [k, v])
  );

  // 2. Match from cache, collect unmatched
  const unmatched: { entry: IntlChartEntry; key: string }[] = [];
  for (const entry of entries) {
    if (entry.previewUrl) continue; // already has preview (e.g. Deezer)
    const key = (entry.title + '|' + entry.artist).toLowerCase().trim();
    const cached = previewMap.get(key);
    if (cached) {
      entry.previewUrl = cached.preview;
      if (!entry.coverUrl && cached.cover) entry.coverUrl = cached.cover;
    } else {
      unmatched.push({ entry, key });
    }
  }

  if (unmatched.length === 0) return;

  // 3. Fetch from iTunes + Deezer for unmatched (max 25 per batch, concurrency 5)
  let newFound = 0;
  const batchSize = 5;
  const toFetch = unmatched.slice(0, 25); // limit API calls
  for (let i = 0; i < toFetch.length; i += batchSize) {
    const chunk = toFetch.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      chunk.map(async ({ entry, key }) => {
        // Try iTunes first (stable URLs)
        const itunes = await fetchITunesPreview(entry.artist, entry.title, countryCode);
        if (itunes.preview) {
          entry.previewUrl = itunes.preview;
          if (!entry.coverUrl && itunes.cover) entry.coverUrl = itunes.cover;
          previewMap.set(key, { preview: itunes.preview, cover: itunes.cover });
          newFound++;
          return;
        }
        // Fallback to Deezer
        const deezer = await fetchDeezerData(entry.artist, entry.title);
        if (deezer.preview) {
          entry.previewUrl = deezer.preview;
          if (!entry.coverUrl && deezer.coverUrl) entry.coverUrl = deezer.coverUrl;
          previewMap.set(key, { preview: deezer.preview, cover: deezer.coverUrl });
          newFound++;
        }
      })
    );
  }

  // 4. Save updated cache
  if (newFound > 0) {
    const urlsObj: Record<string, { preview: string; cover: string }> = {};
    for (const [k, v] of previewMap) urlsObj[k] = v;
    await setPlatformStats('itunes:intl_preview_cache', {
      urls: urlsObj, updatedAt: new Date().toISOString(), count: previewMap.size,
    });
  }
}

// ─── International Endpoints ─────────────────────────────────

// GET /regions — all regions with countries
charts.get('/regions', async (c) => {
  try {
    const regions = [
      { id: 'ru', name: 'Россия', nameRu: 'Россия', flag: '🇷🇺',
        sources: ['yandex', 'shazam', 'radio'],
        countries: [{ code: 'ru', name: 'Russia', nameRu: 'Россия', flag: '🇷🇺' }],
      },
      ...INTL_REGIONS,
    ];
    return c.json({ success: true, data: regions });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// GET /country/:code — chart for a specific country
charts.get('/country/:code', async (c) => {
  try {
    const code = c.req.param('code')?.toLowerCase();
    const platform = c.req.query('platform') || 'apple';
    const limit = parseInt(c.req.query('limit') || '25', 10);

    // Russia → return PromoFM unified chart
    if (code === 'ru' && !c.req.query('platform')) {
      const promofm: any = await getPlatformStats('chart:promofm');
      if (promofm?.entries?.length) {
        return c.json({ success: true, data: {
          platform: 'promofm', countryCode: 'ru',
          entries: promofm.entries.slice(0, limit),
          fetchedAt: promofm.updatedAt || new Date().toISOString(),
          tracksCount: promofm.entries.length,
        }});
      }
    }

    // Check cache
    const cached = await getIntlChart(platform, code);
    if (cached?.entries?.length) {
      // Enrich cached entries that might be missing previews
      const cachedEntries = cached.entries.slice(0, limit);
      const missingPreviews = cachedEntries.some((e: any) => !e.previewUrl);
      if (missingPreviews) {
        await enrichIntlWithPreviews(cachedEntries, code);
      }
      return c.json({ success: true, data: {
        ...cached,
        entries: cachedEntries,
      }});
    }

    // Live fetch if no cache
    let entries: IntlChartEntry[] = [];
    if (platform === 'apple') {
      entries = await fetchAppleMusicChart(code, limit);
    } else if (platform === 'deezer') {
      entries = await fetchDeezerGlobalChart(limit);
    } else if (platform === 'shazam') {
      const country = INTERNATIONAL_COUNTRIES.find(c2 => c2.code === code);
      if (country?.shazamSlug) entries = await fetchShazamCountryChart(country.shazamSlug, limit);
    } else if (platform === 'lastfm') {
      entries = await fetchLastFmChart(limit);
    }

    if (entries.length) {
      // Enrich with preview URLs from iTunes/Deezer before saving
      await enrichIntlWithPreviews(entries, code);
      await saveIntlChart(platform, code, entries);
    }

    return c.json({ success: true, data: {
      platform, countryCode: code, entries: entries.slice(0, limit),
      fetchedAt: new Date().toISOString(), tracksCount: entries.length,
    }});
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// POST /fetch-international — batch update all international charts
charts.post('/fetch-international', requireAdminOrKey, async (c) => {
  try {
    const results: any[] = [];
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

    // 1) Deezer Global
    const deezer = await fetchDeezerGlobalChart(50);
    if (deezer.length) {
      await saveIntlChart('deezer', 'global', deezer);
      results.push({ platform: 'deezer', country: 'global', tracks: deezer.length });
    }
    await delay(500);

    // 2) Last.fm Global (with preview enrichment)
    const lastfm = await fetchLastFmChart(50);
    if (lastfm.length) {
      await enrichIntlWithPreviews(lastfm);
      await saveIntlChart('lastfm', 'global', lastfm);
      results.push({ platform: 'lastfm', country: 'global', tracks: lastfm.length });
    }
    await delay(500);

    // 3) Apple Music for all countries (with preview enrichment)
    for (const country of INTERNATIONAL_COUNTRIES) {
      const apple = await fetchAppleMusicChart(country.code, 25);
      if (apple.length) {
        await enrichIntlWithPreviews(apple, country.code);
        await saveIntlChart('apple', country.code, apple);
        results.push({ platform: 'apple', country: country.code, tracks: apple.length });
      }
      await delay(300);
    }

    // 4) Shazam for key countries
    const shazamCountries = INTERNATIONAL_COUNTRIES.filter(c2 => c2.shazamSlug);
    for (const country of shazamCountries.slice(0, 8)) {
      const shazam = await fetchShazamCountryChart(country.shazamSlug, 25);
      if (shazam.length) {
        await enrichIntlWithPreviews(shazam, country.code);
        await saveIntlChart('shazam', country.code, shazam);
        results.push({ platform: 'shazam', country: country.code, tracks: shazam.length });
      }
      await delay(1000);
    }

    return c.json({ success: true, data: { results, totalSources: results.length, timestamp: new Date().toISOString() }});
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// ─── Превью чартов с нашего домена (25.09.2026) ─────────────
// Ссылки Deezer подписаны примерно на 15 минут, а чарты пересобираются раз в
// несколько дней — к моменту клика превью протухали. Вдобавок плеер ведёт
// звук через Web Audio анализатор, и чужой домен без crossOrigin даёт в нём
// тишину. Поэтому в момент нажатия находим свежее превью (iTunes, затем
// Deezer), один раз сохраняем файл у себя и отдаём его с promo-music.ru.
const PREVIEW_DIR = '/var/www/promofm/uploads/chart-previews';
const PREVIEW_PUBLIC = '/server/uploads/chart-previews';
const PREVIEW_MAX_BYTES = 6 * 1024 * 1024;
const PREVIEW_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(mzstatic\.com|itunes\.apple\.com|dzcdn\.net)\//i;
const previewInflight = new Map<string, Promise<string | null>>();
const previewMiss = new Map<string, number>();

function previewNorm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
}

async function findITunesPreviewStrict(artist: string, title: string): Promise<string> {
  const want = previewNorm(title).slice(0, 12);
  for (const cc of ['ru', 'us']) {
    try {
      const q = encodeURIComponent(`${artist} ${title}`);
      const r = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=5&country=${cc}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = await r.json() as any;
      const hit = (data.results || []).find((x: any) => x.previewUrl && want && previewNorm(x.trackName || '').includes(want));
      if (hit) return hit.previewUrl;
    } catch { /* следующая страна */ }
  }
  return '';
}

async function resolveChartPreview(artist: string, title: string): Promise<string | null> {
  const { createHash } = await import('crypto');
  const { existsSync, mkdirSync, writeFileSync } = await import('fs');
  const key = createHash('sha1').update(`${previewNorm(artist)}|${previewNorm(title)}`).digest('hex').slice(0, 24);
  for (const ext of ['m4a', 'mp3']) {
    if (existsSync(`${PREVIEW_DIR}/${key}.${ext}`)) return `${PREVIEW_PUBLIC}/${key}.${ext}`;
  }
  const missAt = previewMiss.get(key);
  if (missAt && Date.now() - missAt < 6 * 3600_000) return null;
  const running = previewInflight.get(key);
  if (running) return running;
  const job = (async () => {
    const candidates: string[] = [];
    const it = await findITunesPreviewStrict(artist, title);
    if (it) candidates.push(it);
    const dz = await fetchDeezerData(artist, title);
    if (dz.preview) candidates.push(dz.preview);
    for (const url of candidates) {
      if (!PREVIEW_HOSTS.test(url)) continue;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || !/^audio\//i.test(ct)) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 10_000 || buf.length > PREVIEW_MAX_BYTES) continue;
        const ext = /mpeg|mp3/i.test(ct) ? 'mp3' : 'm4a';
        mkdirSync(PREVIEW_DIR, { recursive: true });
        writeFileSync(`${PREVIEW_DIR}/${key}.${ext}`, buf);
        return `${PREVIEW_PUBLIC}/${key}.${ext}`;
      } catch { /* следующий кандидат */ }
    }
    previewMiss.set(key, Date.now());
    return null;
  })().finally(() => previewInflight.delete(key));
  previewInflight.set(key, job);
  return job;
}

// GET /charts/preview?artist=&title= → 302 на закешированный файл превью.
charts.get('/preview', async (c) => {
  const artist = (c.req.query('artist') || '').slice(0, 200).trim();
  const title = (c.req.query('title') || '').slice(0, 200).trim();
  if (!artist || !title) return c.json({ success: false, error: 'artist и title обязательны' }, 400);
  try {
    const url = await resolveChartPreview(artist, title);
    if (!url) return c.json({ success: false, error: 'Превью не найдено' }, 404);
    c.header('Cache-Control', 'public, max-age=86400');
    return c.redirect(url, 302);
  } catch (e: any) {
    return c.json({ success: false, error: safeErrorMessage(e) }, 500);
  }
});

export default charts;

