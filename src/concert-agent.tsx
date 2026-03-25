/**
 * CONCERT AGENT — автоматический сбор концертов из российских источников
 *
 * Источники:
 * 1. KudaGo API (JSON) — основной, ~200 концертов, Москва + СПб + другие города
 * 2. Яндекс.Афиша (HTML → Mistral) — крупные концерты
 * 3. MTS Live / Ponominalu (HTML → Mistral) — популярные концерты и фестивали
 * 4. Kassir.ru (HTML → Mistral) — билетный оператор
 */

// ─── Types ──────────────────────────────────────────────

export interface ConcertSource {
  id: string;
  name: string;
  urls: string[]; // может быть несколько URL (по городам)
  type: 'json_api' | 'html_parser';
  logo: string;
}

export interface ParsedConcert {
  title: string;
  artist: string;
  venue: string;
  city: string;
  date: string; // ISO date
  time: string; // HH:MM
  price: string;
  ticketUrl: string;
  imageUrl: string;
  description: string;
  genre: string;
  source: string;
  sourceId: string;
}

// ─── Source Configuration ───────────────────────────────

export const CONCERT_SOURCES: ConcertSource[] = [
  {
    id: 'kudago',
    name: 'KudaGo',
    urls: [
      'https://kudago.com/public-api/v1.4/events/?fields=id,title,dates,place,price,site_url,images,tags,description,short_title&categories=concert&location=msk&page_size=30&actual_since={timestamp}&order_by=-publication_date&expand=place&text_format=text',
      'https://kudago.com/public-api/v1.4/events/?fields=id,title,dates,place,price,site_url,images,tags,description,short_title&categories=concert&location=spb&page_size=20&actual_since={timestamp}&order_by=-publication_date&expand=place&text_format=text',
    ],
    type: 'json_api',
    logo: '📍',
  },
  {
    id: 'afisha-yandex',
    name: 'Яндекс.Афиша',
    urls: [
      'https://afisha.yandex.ru/moscow/concert',
      'https://afisha.yandex.ru/saint-petersburg/concert',
    ],
    type: 'html_parser',
    logo: '🎪',
  },
  {
    id: 'mts-live',
    name: 'MTS Live',
    urls: [
      'https://live.mts.ru/moscow/concerts',
      'https://live.mts.ru/sankt-peterburg/concerts',
    ],
    type: 'html_parser',
    logo: '🎫',
  },
  {
    id: 'kassir',
    name: 'Kassir.ru',
    urls: [
      'https://www.kassir.ru/koncerty/moskva',
      'https://www.kassir.ru/koncerty/sankt-peterburg',
    ],
    type: 'html_parser',
    logo: '🎟️',
  },
];

// ─── KudaGo API Parser ─────────────────────────────────

async function fetchKudaGoConcerts(): Promise<ParsedConcert[]> {
  const concerts: ParsedConcert[] = [];
  const now = Math.floor(Date.now() / 1000);
  const source = CONCERT_SOURCES.find(s => s.id === 'kudago')!;

  for (const urlTemplate of source.urls) {
    const url = urlTemplate.replace('{timestamp}', String(now));
    const cityMatch = url.match(/location=(\w+)/);
    const cityCode = cityMatch ? cityMatch[1] : 'msk';
    const cityName = cityCode === 'msk' ? 'Москва' : cityCode === 'spb' ? 'Санкт-Петербург' : cityCode;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        console.log(`[concert-agent] KudaGo ${cityCode} error: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const events = data.results || [];

      for (const ev of events) {
        // Find next future date
        const futureDates = (ev.dates || [])
          .filter((d: any) => d.start > now)
          .sort((a: any, b: any) => a.start - b.start);

        if (futureDates.length === 0) continue;

        const startTs = futureDates[0].start;
        const dateObj = new Date(startTs * 1000);
        const dateStr = dateObj.toISOString().split('T')[0];
        const timeStr = dateObj.toTimeString().slice(0, 5);

        const place = ev.place || {};
        const placeName = typeof place === 'object' ? (place.title || '') : '';
        const placeAddr = typeof place === 'object' ? (place.address || '') : '';

        const imgs = ev.images || [];
        const imageUrl = imgs.length > 0 ? imgs[0].image : '';

        // Extract artist from title (often "концерт ARTIST_NAME")
        const title = ev.title || ev.short_title || '';
        const artist = extractArtistFromTitle(title);

        // Detect genre from tags
        const tags: string[] = ev.tags || [];
        const genre = detectGenre(tags);

        concerts.push({
          title: cleanTitle(title),
          artist,
          venue: placeName + (placeAddr ? ` (${placeAddr})` : ''),
          city: cityName,
          date: dateStr,
          time: timeStr,
          price: ev.price || '',
          ticketUrl: ev.site_url || '',
          imageUrl,
          description: (ev.description || '').slice(0, 500),
          genre,
          source: 'KudaGo',
          sourceId: 'kudago',
        });
      }

      console.log(`[concert-agent] KudaGo ${cityName}: ${events.length} events → ${concerts.length} concerts`);
    } catch (error) {
      console.log(`[concert-agent] KudaGo ${cityCode} fetch error: ${error}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return concerts;
}

// ─── HTML Parser (Mistral) ──────────────────────────────

async function fetchPageText(url: string): Promise<string | null> {
  // SSRF protection: validate URL before fetching
  const urlCheck = await isUrlSafe(url);
  if (!urlCheck.safe) {
    console.warn(`[SSRF blocked] ${url}: ${urlCheck.reason}`);
    return null;
  }
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
      console.log(`[concert-agent] Fetch failed for ${url}: HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Check for captcha
    if (html.includes('checkcaptcha') || html.includes('captcha-image')) {
      console.log(`[concert-agent] CAPTCHA detected for ${url}`);
      return null;
    }

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

    return cleanText.slice(0, 12000);
  } catch (error) {
    console.log(`[concert-agent] Fetch error for ${url}: ${error}`);
    return null;
  }
}

async function extractConcertsWithMistral(
  source: ConcertSource,
  pageText: string,
  cityHint: string,
): Promise<ParsedConcert[]> {
  const mistralKey = process.env.MISTRAL_API_KEY;
  if (!mistralKey) {
    console.log('[concert-agent] MISTRAL_API_KEY not set');
    return [];
  }

  const systemPrompt = `Ты — парсер концертных афиш. Из текста HTML-страницы извлеки предстоящие концерты.

ВАЖНО:
- Верни ТОЛЬКО валидный JSON: {"concerts": [...]}
- Каждый объект: {"title": "Название концерта/шоу", "artist": "Исполнитель", "venue": "Площадка", "city": "${cityHint}", "date": "YYYY-MM-DD", "time": "HH:MM", "price": "от X руб.", "ticketUrl": "ссылка для покупки или пустая строка", "genre": "pop/rock/hip-hop/electronic/jazz/classical/folk/other"}
- Извлекай ТОЛЬКО музыкальные концерты (не театр, не стендап, не цирк)
- Максимум 15 концертов
- Если дата неизвестна, используй пустую строку
- НЕ добавляй markdown-обёртку
- Если не удалось — верни {"concerts": []}`;

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
          { role: 'user', content: `Источник: "${source.name}" (${cityHint})\n\nТекст страницы:\n${pageText}` },
        ],
        temperature: 0.2,
        max_tokens: 6000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      console.log(`[concert-agent] Mistral error for ${source.id}: ${await resp.text()}`);
      return [];
    }

    const data = await resp.json();
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

    const rawConcerts = Array.isArray(parsed) ? parsed : (parsed.concerts || parsed.events || []);
    if (!Array.isArray(rawConcerts)) return [];

    return rawConcerts
      .filter((c: any) => c.title && c.title.length > 3)
      .slice(0, 15)
      .map((c: any) => ({
        title: String(c.title || '').trim(),
        artist: String(c.artist || '').trim(),
        venue: String(c.venue || '').trim(),
        city: String(c.city || cityHint).trim(),
        date: String(c.date || '').trim(),
        time: String(c.time || '').trim(),
        price: String(c.price || '').trim(),
        ticketUrl: String(c.ticketUrl || c.ticket_url || '').trim(),
        imageUrl: '',
        description: String(c.description || '').trim(),
        genre: String(c.genre || 'other').trim(),
        source: source.name,
        sourceId: source.id,
      }));
  } catch (error) {
    console.log(`[concert-agent] Mistral error for ${source.id}: ${error}`);
    return [];
  }
}

async function fetchHtmlSourceConcerts(source: ConcertSource): Promise<ParsedConcert[]> {
  const all: ParsedConcert[] = [];

  for (const url of source.urls) {
    // Determine city from URL
    const cityHint = url.includes('moscow') || url.includes('moskva') || url.includes('/msk')
      ? 'Москва'
      : url.includes('peter') || url.includes('spb') || url.includes('peterburg')
        ? 'Санкт-Петербург'
        : 'Россия';

    console.log(`[concert-agent] Fetching ${source.name} (${cityHint})...`);

    const pageText = await fetchPageText(url);
    if (!pageText) {
      console.log(`[concert-agent] ${source.name} (${cityHint}): no content (captcha/blocked)`);
      continue;
    }

    const concerts = await extractConcertsWithMistral(source, pageText, cityHint);
    all.push(...concerts);
    console.log(`[concert-agent] ${source.name} (${cityHint}): ${concerts.length} concerts extracted`);

    await new Promise(r => setTimeout(r, 2000));
  }

  return all;
}

// ─── Helpers ────────────────────────────────────────────

function cleanTitle(title: string): string {
  return title
    .replace(/^концерт\s+/i, '')
    .replace(/^шоу\s+/i, '')
    .replace(/^выступление\s+/i, '')
    .replace(/[«»]/g, '')
    .trim();
}

function extractArtistFromTitle(title: string): string {
  // "концерт Артиста" → "Артист"
  const patterns = [
    /^концерт\s+[«"]?(.+?)[»"]?\s*$/i,
    /^шоу\s+[«"]?(.+?)[»"]?\s*$/i,
    /^(.+?)\s+(?:с программой|представляет|live|в|на)\s/i,
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return m[1].trim();
  }
  // If title contains quotes, extract them
  const quoted = title.match(/[«"](.+?)[»"]/);
  if (quoted) {
    // The part before quotes is likely the artist
    const before = title.slice(0, title.indexOf(quoted[0])).trim();
    if (before.length > 2) return before;
    return quoted[1];
  }
  return '';
}

function detectGenre(tags: string[]): string {
  const tagStr = tags.join(' ').toLowerCase();
  if (/рок|rock|metal|панк|punk|альтернатив/.test(tagStr)) return 'rock';
  if (/хип-хоп|hip.hop|рэп|rap/.test(tagStr)) return 'hip-hop';
  if (/поп|pop/.test(tagStr)) return 'pop';
  if (/электрон|edm|techno|house|транс|dj|клубн/.test(tagStr)) return 'electronic';
  if (/джаз|jazz|блюз|blues/.test(tagStr)) return 'jazz';
  if (/классич|classical|симфон|оркестр|орган|фортепиан|камерн/.test(tagStr)) return 'classical';
  if (/народн|folk|балалайк|этно/.test(tagStr)) return 'folk';
  if (/шансон|авторск|бард/.test(tagStr)) return 'chanson';
  return 'other';
}

// ─── Deduplication ──────────────────────────────────────

function concertKey(c: ParsedConcert): string {
  const artist = (c.artist || c.title).toLowerCase().replace(/[^\wа-яё]/gi, '').slice(0, 30);
  const date = c.date || '';
  const city = c.city.toLowerCase().slice(0, 3);
  return `${artist}:${date}:${city}`;
}

function deduplicateConcerts(concerts: ParsedConcert[]): ParsedConcert[] {
  const seen = new Map<string, ParsedConcert>();

  for (const c of concerts) {
    const key = concertKey(c);
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, c);
    } else {
      // Prefer the one with more data (image, ticket URL, etc.)
      const score = (c: ParsedConcert) =>
        (c.imageUrl ? 2 : 0) + (c.ticketUrl ? 2 : 0) + (c.price ? 1 : 0) + (c.description ? 1 : 0);
      if (score(c) > score(existing)) {
        seen.set(key, { ...c, ticketUrl: c.ticketUrl || existing.ticketUrl });
      }
    }
  }

  return Array.from(seen.values());
}

// ─── Public API ─────────────────────────────────────────

import { concertAgentStore } from './db.tsx';
import { isUrlSafe } from './security.tsx';

function getConcertStore() {
  return concertAgentStore;
}

export async function fetchConcertsFromSource(sourceId: string): Promise<{ added: number; total: number; errors: string[] }> {
  const source = CONCERT_SOURCES.find(s => s.id === sourceId);
  if (!source) return { added: 0, total: 0, errors: [`Unknown source: ${sourceId}`] };

  const errors: string[] = [];
  let concerts: ParsedConcert[] = [];

  if (source.type === 'json_api' && source.id === 'kudago') {
    concerts = await fetchKudaGoConcerts();
  } else {
    concerts = await fetchHtmlSourceConcerts(source);
  }

  if (concerts.length === 0) {
    errors.push(`No concerts from ${source.name}`);
    return { added: 0, total: 0, errors };
  }

  // Load existing for dedup
  const store = getConcertStore();
  const existing = await store.getAll();
  const existingKeys = new Set(existing.map((c: any) => concertKey(c)));

  let added = 0;
  for (const concert of concerts) {
    const key = concertKey(concert);
    if (existingKeys.has(key)) continue;

    const id = `concert-${sourceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      ...concert,
      status: 'published' as const,
      createdAt: new Date().toISOString(),
    };

    await store.set(id, record);
    existingKeys.add(key);
    added++;

    await new Promise(r => setTimeout(r, 100));
  }

  return { added, total: concerts.length, errors };
}

export async function fetchAllConcerts(): Promise<{
  totalAdded: number;
  results: Record<string, { added: number; total: number; errors: string[] }>;
}> {
  const results: Record<string, { added: number; total: number; errors: string[] }> = {};
  let totalAdded = 0;

  for (const source of CONCERT_SOURCES) {
    console.log(`[concert-agent] === ${source.name} ===`);
    const result = await fetchConcertsFromSource(source.id);
    results[source.id] = result;
    totalAdded += result.added;
    console.log(`[concert-agent] ${source.name}: added=${result.added}, total=${result.total}, errors=${result.errors.length}`);

    await new Promise(r => setTimeout(r, 1000));
  }

  return { totalAdded, results };
}

export async function getPublishedConcerts(city?: string): Promise<any[]> {
  const store = getConcertStore();
  const all = await store.getAll();
  let concerts = all.filter((c: any) => c.status === 'published');

  if (city) {
    concerts = concerts.filter((c: any) =>
      (c.city || '').toLowerCase().includes(city.toLowerCase())
    );
  }

  // Sort by date ascending (nearest first)
  concerts.sort((a: any, b: any) => {
    const da = a.date || '9999';
    const db = b.date || '9999';
    return da.localeCompare(db);
  });

  // Filter out past concerts
  const today = new Date().toISOString().split('T')[0];
  concerts = concerts.filter((c: any) => !c.date || c.date >= today);

  return concerts;
}

export async function clearOldConcerts(): Promise<number> {
  const store = getConcertStore();
  const all = await store.getAll();
  const today = new Date().toISOString().split('T')[0];
  let deleted = 0;

  for (const c of all) {
    if ((c as any).date && (c as any).date < today) {
      await store.del((c as any).id);
      deleted++;
    }
  }

  return deleted;
}
