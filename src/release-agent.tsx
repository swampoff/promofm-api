/**
 * RELEASE AGENT — автоматический сбор upcoming releases (пресейвы)
 * Парсит HTML из международных источников, обрабатывает через OpenRouter
 * Данные для секции "Скоро" на лендинге
 */

import * as typed from './db-typed.tsx';

export interface ReleaseSource {
  id: string;
  name: string;
  url: string;
  parsingHint: string;
}

export const RELEASE_SOURCES: ReleaseSource[] = [
  {
    id: 'lineofbestfit',
    name: 'The Line of Best Fit',
    url: 'https://www.thelineofbestfit.com/new-music',
    parsingHint: 'UK music blog with upcoming album announcements and release dates. Extract album/single announcements with artist name, album title, release date, genre, and cover image URL (look for img tags near album names). Focus on items with future release dates.',
  },
  {
    id: 'wikipedia-albums',
    name: 'Wikipedia Albums 2026',
    url: 'https://en.wikipedia.org/wiki/List_of_2026_albums',
    parsingHint: 'Wikipedia list of albums released or announced for 2026. Each entry has a release date, artist name, album title, and sometimes genre/label. Extract future releases only. There are NO cover images on Wikipedia – leave cover_image_url empty.',
  },
];

async function fetchPageHTML(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[release-agent] Fetch failed for ${url}: HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();

    if (url.includes('wikipedia.org')) {
      const cleaned = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/class="[^"]*"/gi, '')
        .replace(/style="[^"]*"/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      return cleaned.slice(0, 30000);
    }

    const cleaned = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    return cleaned.slice(0, 25000);
  } catch (error) {
    console.log(`[release-agent] Fetch error for ${url}: ${error}`);
    return null;
  }
}

interface ParsedRelease {
  artist: string;
  title: string;
  release_date: string;
  genre: string;
  cover_image_url: string;
  release_type: string;
}

async function extractReleasesWithLLM(
  source: ReleaseSource,
  pageContent: string,
): Promise<ParsedRelease[]> {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    console.log('[release-agent] OPENROUTER_API_KEY not set');
    return [];
  }

  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are a music release calendar parser. Extract upcoming music releases from the page content.

${source.parsingHint}

RULES:
- Return ONLY valid JSON with field "releases" – array of objects
- Each object: {"artist": "Artist Name", "title": "Album/Single Title", "release_date": "YYYY-MM-DD", "genre": "genre or empty string", "cover_image_url": "full URL to cover image or empty string", "release_type": "album or single or ep"}
- ONLY include releases with release_date >= "${today}" (future or today)
- If the date is approximate or you only know the month, use the 1st of that month
- Maximum 20 releases
- Do NOT add markdown wrapping
- If you cannot extract releases, return {"releases": []}`;

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openrouterKey}`,
        'HTTP-Referer': 'https://promo-music.ru',
        'X-Title': 'PromoFM Release Agent',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Source: "${source.name}" (${source.url})\n\nPage content:\n${pageContent}` },
        ],
        temperature: 0.2,
        max_tokens: 6000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.log(`[release-agent] OpenRouter error for ${source.id}: ${errText}`);
      return [];
    }

    const data: any = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else return [];
    }

    const rawReleases = Array.isArray(parsed) ? parsed : (parsed.releases || []);
    if (!Array.isArray(rawReleases)) return [];

    return rawReleases
      .filter((r: any) => r.artist && r.title && r.release_date)
      .filter((r: any) => r.release_date >= today)
      .slice(0, 20)
      .map((r: any) => ({
        artist: String(r.artist).trim(),
        title: String(r.title).trim(),
        release_date: String(r.release_date).trim(),
        genre: String(r.genre || '').trim(),
        cover_image_url: String(r.cover_image_url || '').trim(),
        release_type: String(r.release_type || 'album').trim().toLowerCase(),
      }));
  } catch (error) {
    console.log(`[release-agent] LLM extraction error for ${source.id}: ${error}`);
    return [];
  }
}

export async function fetchReleasesFromSource(
  source: ReleaseSource,
): Promise<{ added: number; updated: number; errors: string[] }> {
  const errors: string[] = [];

  const pageContent = await fetchPageHTML(source.url);
  if (!pageContent) {
    errors.push(`Failed to fetch ${source.url}`);
    return { added: 0, updated: 0, errors };
  }

  const releases = await extractReleasesWithLLM(source, pageContent);
  if (releases.length === 0) {
    errors.push(`No releases extracted from ${source.id}`);
    return { added: 0, updated: 0, errors };
  }

  let added = 0;
  let updated = 0;

  for (const release of releases) {
    const result = await typed.upsertUpcomingRelease({
      title: release.title,
      artist_name: release.artist,
      release_date: release.release_date,
      cover_url: release.cover_image_url,
      genre: release.genre,
      release_type: release.release_type,
      source: source.id,
      source_url: source.url,
    });

    if (result) added++;
    await new Promise(r => setTimeout(r, 100));
  }

  return { added, updated, errors };
}

export async function fetchAllReleases(): Promise<{
  totalAdded: number;
  archived: number;
  results: Record<string, { added: number; updated: number; errors: string[] }>;
}> {
  const results: Record<string, { added: number; updated: number; errors: string[] }> = {};
  let totalAdded = 0;

  const archived = await typed.archivePastReleases();
  console.log(`[release-agent] Archived ${archived.length} past releases`);

  for (const source of RELEASE_SOURCES) {
    console.log(`[release-agent] Fetching from ${source.name}...`);
    const result = await fetchReleasesFromSource(source);
    results[source.id] = result;
    totalAdded += result.added;

    await new Promise(r => setTimeout(r, 3000));
  }

  return { totalAdded, archived: archived.length, results };
}
