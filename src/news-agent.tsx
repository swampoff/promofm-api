/**
 * NEWS AGENT — автоматический сбор и обработка музыкальных новостей
 * Парсит HTML из русскоязычных источников, обрабатывает через Mistral
 */

import { newsPublicStore } from './db.tsx';

// ─── Source Configuration ───────────────────────────────

export interface NewsSource {
  id: string;
  name: string;
  url: string;
  category: string;
  parsingHint: string;
}

export const NEWS_SOURCES: NewsSource[] = [
  {
    id: 'intermedia',
    name: 'InterMedia',
    url: 'https://www.intermedia.ru/news',
    category: 'industry',
    parsingHint: 'Новостной сайт о шоу-бизнесе и музыкальной индустрии России. Извлеки заголовки новостей, краткое описание и дату публикации.',
  },
  {
    id: 'theflow',
    name: 'The Flow',
    url: 'https://the-flow.ru/',
    category: 'releases',
    parsingHint: 'Издание о хип-хоп и рэп культуре в России. Извлеки новости о релизах, артистах, клипах.',
  },
  {
    id: 'billboard-ru',
    name: 'Billboard Russia',
    url: 'https://billboard.ru/',
    category: 'charts',
    parsingHint: 'Российская версия Billboard. Извлеки новости о чартах, релизах и музыкальной индустрии.',
  },
  {
    id: 'zvuki',
    name: 'Звуки.ру',
    url: 'https://zvuki.ru/R/P/',
    category: 'releases',
    parsingHint: 'Музыкальный портал. Извлеки новости о музыкальных релизах, обзорах альбомов.',
  },
  {
    id: 'afisha-daily',
    name: 'Афиша Daily',
    url: 'https://daily.afisha.ru/music/',
    category: 'events',
    parsingHint: 'Раздел музыки Афиша Daily. Извлеки новости о музыкальных событиях, интервью, обзоры.',
  },
];

// ─── HTML Fetching ──────────────────────────────────────

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
      console.log(`[news-agent] Fetch failed for ${url}: HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();

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

    return cleanText.slice(0, 10000);
  } catch (error) {
    console.log(`[news-agent] Fetch error for ${url}: ${error}`);
    return null;
  }
}

// ─── Mistral Extraction ─────────────────────────────────

interface ParsedNewsItem {
  title: string;
  excerpt: string;
  content: string;
  category: string;
  tags: string[];
  sourceUrl: string;
  imageUrl: string;
  publishedAt: string;
}

async function extractNewsWithMistral(
  source: NewsSource,
  pageText: string,
): Promise<ParsedNewsItem[]> {
  const mistralKey = process.env.MISTRAL_API_KEY;
  if (!mistralKey) {
    console.log('[news-agent] MISTRAL_API_KEY not set');
    return [];
  }

  const systemPrompt = `Ты — парсер музыкальных новостей. Из текста HTML-страницы извлеки последние новости.
${source.parsingHint}

ВАЖНО:
- Верни ТОЛЬКО валидный JSON с полем "news" — массив объектов
- Каждый объект: {"title": "Заголовок", "excerpt": "Краткое описание 1-2 предложения", "content": "Переписанный текст новости 3-5 предложений", "category": "одна из: releases, artists, industry, events, charts, interviews", "tags": ["тег1", "тег2"], "publishedAt": "дата ISO или пустая строка"}
- Перепиши каждую новость своими словами (не копируй дословно)
- Максимум 5 новостей
- НЕ добавляй markdown-обёртку
- Если не удалось извлечь новости, верни {"news": []}`;

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
          { role: 'user', content: `Источник: "${source.name}" (${source.url})\n\nТекст страницы:\n${pageText}` },
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      console.log(`[news-agent] Mistral error for ${source.id}: ${await resp.text()}`);
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

    const rawNews = Array.isArray(parsed) ? parsed : (parsed.news || parsed.articles || []);
    if (!Array.isArray(rawNews)) return [];

    return rawNews
      .filter((n: any) => n.title && n.title.length > 5)
      .slice(0, 5)
      .map((n: any) => ({
        title: String(n.title).trim(),
        excerpt: String(n.excerpt || '').trim(),
        content: String(n.content || n.excerpt || '').trim(),
        category: n.category || source.category,
        tags: Array.isArray(n.tags) ? n.tags : [],
        sourceUrl: n.sourceUrl || source.url,
        imageUrl: n.imageUrl || '',
        publishedAt: n.publishedAt || new Date().toISOString(),
      }));
  } catch (error) {
    console.log(`[news-agent] Mistral extraction error for ${source.id}: ${error}`);
    return [];
  }
}

// ─── Deduplication ──────────────────────────────────────

function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().replace(/[^\wа-яё]/gi, ' ').split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().replace(/[^\wа-яё]/gi, ' ').split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.min(wordsA.size, wordsB.size);
}

// ─── Public API ─────────────────────────────────────────

export async function fetchNewsFromSource(source: NewsSource): Promise<{ added: number; errors: string[] }> {
  const errors: string[] = [];

  const pageText = await fetchPageText(source.url);
  if (!pageText) {
    errors.push(`Failed to fetch ${source.url}`);
    return { added: 0, errors };
  }

  const newsItems = await extractNewsWithMistral(source, pageText);
  if (newsItems.length === 0) {
    errors.push(`No news extracted from ${source.id}`);
    return { added: 0, errors };
  }

  // Load existing news for deduplication
  const existing = await newsPublicStore.getAll();
  const existingTitles = existing.map((n: any) => n.title || '');

  let added = 0;
  for (const item of newsItems) {
    // Check for duplicates
    const isDuplicate = existingTitles.some((t: string) => titleSimilarity(t, item.title) > 0.6);
    if (isDuplicate) continue;

    const id = `news-${source.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newsRecord = {
      id,
      ...item,
      source: source.name,
      sourceId: source.id,
      status: 'published' as const,
      createdAt: new Date().toISOString(),
    };

    await newsPublicStore.set(id, newsRecord);
    existingTitles.push(item.title);
    added++;

    // Small delay between saves
    await new Promise(r => setTimeout(r, 200));
  }

  return { added, errors };
}

export async function fetchAllNews(): Promise<{ totalAdded: number; results: Record<string, { added: number; errors: string[] }> }> {
  const results: Record<string, { added: number; errors: string[] }> = {};
  let totalAdded = 0;

  for (const source of NEWS_SOURCES) {
    console.log(`[news-agent] Fetching from ${source.name}...`);
    const result = await fetchNewsFromSource(source);
    results[source.id] = result;
    totalAdded += result.added;

    // Delay between sources to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }

  return { totalAdded, results };
}
