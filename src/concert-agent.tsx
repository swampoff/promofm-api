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

import {
  listConcertAgentItems, upsertConcertAgentItem, deleteConcertAgentItem,
} from './db.tsx';
import { isUrlSafe } from './security.tsx';

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

  // Load existing for dedup (native cols since migration 061).
  const existing = await listConcertAgentItems();
  const existingKeys = new Set(existing.map((c: any) => concertKey(c)));

  let added = 0;
  for (const concert of concerts) {
    const key = concertKey(concert);
    if (existingKeys.has(key)) continue;

    const id = `concert-${sourceId}-${crypto.randomUUID()}`;
    const record = {
      id,
      ...concert,
      status: 'published' as const,
      createdAt: new Date().toISOString(),
    };

    await upsertConcertAgentItem(id, record);
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
  // Native indexes (idx_concerts_published_date / idx_concerts_city_date) —
  // SQL push filter + ORDER BY вместо .getAll() + JS filter+sort.
  const today = new Date().toISOString().split('T')[0];
  let concerts = await listConcertAgentItems({
    status: 'published',
    dateFrom: today,
  });
  if (city) {
    const cityLower = city.toLowerCase();
    concerts = concerts.filter((c: any) => (c.city || '').toLowerCase().includes(cityLower));
  }
  return concerts;
}

export async function clearOldConcerts(): Promise<number> {
  // Single SQL DELETE через native event_date col. Раньше — getAll() +
  // loop per-id del'ы.
  const { pool } = await import('./db-client.tsx');
  const today = new Date().toISOString().split('T')[0];
  const r = await pool.query(
    `DELETE FROM concert_agent_data WHERE event_date IS NOT NULL AND event_date < $1::date`,
    [today]
  );
  return r.rowCount || 0;
}


// ─── Telegram Channel Parser (@maingig format) ──────────

/**
 * Парсит публичную веб-версию Telegram-канала (t.me/s/<channel>).
 * Формат @maingig:
 *   – Город –
 *   7 апреля (вт):
 *   • Артист (Площадка)
 *
 * Также туровый формат:
 *   24 апреля — Город (Площадка)
 *
 * ВАЖНО: источник НЕ указывается как @maingig — source = "parsed".
 */
async function fetchTelegramChannelConcerts(channelName: string): Promise<ParsedConcert[]> {
  // Proxy through Hostinger VPS (t.me blocked from Russian IP)
  const url = `http://187.77.85.42/tg-proxy/${channelName}`;
  const concerts: ParsedConcert[] = [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.log(`[concert-agent] Telegram ${channelName}: HTTP ${resp.status}`);
      return [];
    }

    const html = await resp.text();

    // Extract message texts from Telegram widget HTML
    const messageRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let match;
    const posts: string[] = [];
    while ((match = messageRegex.exec(html)) !== null) {
      const text = match[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#\d+;/g, '')
        .trim();
      if (text.length > 30) posts.push(text);
    }

    console.log(`[concert-agent] Telegram ${channelName}: ${posts.length} posts found`);

    // Russian month parser
    const currentYear = new Date().getFullYear();
    const monthMap: Record<string, number> = {
      'январ': 0, 'феврал': 1, 'март': 2, 'апрел': 3, 'мая': 4, 'май': 4, 'июн': 5,
      'июл': 6, 'август': 7, 'сентябр': 8, 'октябр': 9, 'ноябр': 10, 'декабр': 11,
    };

    function parseRussianDate(dateStr: string): string {
      const m = dateStr.match(/(\d{1,2})\s+(\S+)/);
      if (!m) return '';
      const day = parseInt(m[1]);
      const monthWord = m[2].toLowerCase();
      let monthNum = -1;
      for (const [prefix, num] of Object.entries(monthMap)) {
        if (monthWord.startsWith(prefix.slice(0, 3))) {
          monthNum = num;
          break;
        }
      }
      if (monthNum < 0) return '';
      const d = new Date(currentYear, monthNum, day);
      if (d.getTime() < Date.now() - 30 * 86400000) d.setFullYear(currentYear + 1);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }

    for (const post of posts) {
      const lines = post.split('\n').map(l => l.trim()).filter(Boolean);
      let currentCity = '';
      let currentDate = '';

      for (const line of lines) {
        // City header: – Город –  or  — Город —
        const cityMatch = line.match(/^[\u2013\u2014\u2012\u002D]+\s*(.+?)\s*[\u2013\u2014\u2012\u002D]+$/);
        if (cityMatch && !cityMatch[1].match(/^\d/)) {
          currentCity = cityMatch[1].trim();
          continue;
        }

        // Date line: "7 апреля (вт):" or "10 апреля (пт):"
        const dateMatch = line.match(/^(\d{1,2}\s+\S+)\s*\([а-яё]{2}\)\s*:?\s*$/i);
        if (dateMatch) {
          currentDate = parseRussianDate(dateMatch[1]);
          continue;
        }

        // Concert line: • Артист (Площадка) or • Артист [клаб-шоу] (Площадка)
        const concertMatch = line.match(/^[•\u2022\-\*]\s*(.+?)\s*\(([^)]+)\)\s*(?:,\s*#.*)?$/);
        if (concertMatch && currentCity && currentDate) {
          const rawArtist = concertMatch[1]
            .replace(/\[.*?\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          const venue = concertMatch[2].trim();

          concerts.push({
            title: `${rawArtist} \u2014 ${venue}`,
            artist: rawArtist,
            venue,
            city: currentCity,
            date: currentDate,
            time: '',
            price: '',
            ticketUrl: '',
            imageUrl: '',
            description: '',
            genre: 'other',
            source: 'parsed',
            sourceId: 'telegram-curated',
          });
          continue;
        }

        // Tour format: "24 апреля — Город (Площадка)"
        const tourMatch = line.match(/^(\d{1,2}\s+\S+)\s*[\u2013\u2014\u002D]+\s*(.+?)\s*\(([^)]+)\)$/);
        if (tourMatch) {
          const tourDate = parseRussianDate(tourMatch[1]);
          const tourCity = tourMatch[2].trim();
          const tourVenue = tourMatch[3].trim();
          // Find artist name from post context (first non-structural line)
          const artistLine = lines.find(l =>
            !l.startsWith('\u2013') && !l.startsWith('\u2014') && !l.startsWith('-') &&
            !l.match(/^\d/) && !l.startsWith('\u2022') && !l.startsWith('#') &&
            l.length > 3 && l.length < 100
          );
          const tourArtist = artistLine
            ? artistLine.replace(/\s*(едут|в свой|тур|по стране|который).*/i, '').trim()
            : '';

          if (tourDate && tourCity) {
            concerts.push({
              title: tourArtist ? `${tourArtist} \u2014 ${tourVenue}` : tourVenue,
              artist: tourArtist,
              venue: tourVenue,
              city: tourCity,
              date: tourDate,
              time: '',
              price: '',
              ticketUrl: '',
              imageUrl: '',
              description: '',
              genre: 'other',
              source: 'parsed',
              sourceId: 'telegram-curated',
            });
          }
        }
      }
    }

    console.log(`[concert-agent] Telegram ${channelName}: ${concerts.length} concerts parsed`);
    return concerts;
  } catch (error) {
    console.log(`[concert-agent] Telegram ${channelName} error: ${error}`);
    return [];
  }
}

// ─── New Sources: Ticketland, concert.ru ────────────────

const EXTRA_SOURCES: ConcertSource[] = [
  {
    id: 'ticketland',
    name: 'Ticketland',
    urls: [
      'https://www.ticketland.ru/koncerty/moskva/',
      'https://www.ticketland.ru/koncerty/sankt-peterburg/',
    ],
    type: 'html_parser',
    logo: '\uD83C\uDFAB',
  },
  {
    id: 'concert-ru',
    name: 'Concert.ru',
    urls: [
      'https://www.concert.ru/Moscow/Schedule',
      'https://www.concert.ru/Saint-Petersburg/Schedule',
    ],
    type: 'html_parser',
    logo: '\uD83C\uDFB5',
  },
];

// Register extra sources
for (const s of EXTRA_SOURCES) {
  if (!CONCERT_SOURCES.find(x => x.id === s.id)) {
    CONCERT_SOURCES.push(s);
  }
}

// ─── Extended fetchAll: includes Telegram channels ──────

const TELEGRAM_CHANNELS = ['maingig'];

export async function fetchAllConcertsExtended(): Promise<{
  totalAdded: number;
  results: Record<string, { added: number; total: number; errors: string[] }>;
}> {
  // 1. Fetch from all registered sources (KudaGo, Afisha, MTS, Kassir, Ticketland, concert.ru)
  const baseResult = await fetchAllConcerts();

  // 2. Fetch from Telegram channels (hidden source — NOT attributed)
  for (const channel of TELEGRAM_CHANNELS) {
    console.log(`[concert-agent] === Telegram (curated data) ===`);
    const tgConcerts = await fetchTelegramChannelConcerts(channel);

    if (tgConcerts.length === 0) {
      baseResult.results[`curated`] = { added: 0, total: 0, errors: ['No concerts parsed'] };
      continue;
    }

    // Dedup against existing (native cols since migration 061).
    const existing = await listConcertAgentItems();
    const existingKeys = new Set(existing.map((c: any) => concertKey(c)));

    let added = 0;
    for (const concert of tgConcerts) {
      const key = concertKey(concert);
      if (existingKeys.has(key)) continue;

      const id = `concert-curated-${crypto.randomUUID()}`;
      await upsertConcertAgentItem(id, {
        id,
        ...concert,
        status: 'published',
        createdAt: new Date().toISOString(),
      });
      existingKeys.add(key);
      added++;
    }

    baseResult.results['curated'] = { added, total: tgConcerts.length, errors: [] };
    baseResult.totalAdded += added;
    console.log(`[concert-agent] Curated data: added=${added}, total=${tgConcerts.length}`);
  }

  return baseResult;
}
