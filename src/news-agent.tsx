/**
 * NEWS AGENT — автоматический сбор и обработка музыкальных новостей
 * Парсит HTML из русских и зарубежных источников, переводит и обрабатывает через OpenRouter (Gemini)
 * Каждый автор-персонаж имеет свой стиль и специализацию
 */

import { newsPublicStore } from './db.tsx';
import { isUrlSafe } from './security.tsx';


// ─── Poster Personas — у каждого свой стиль и специализация ────────
const POSTERS = [
  { name: 'DJ Den', avatar: '/avatars/avatar_dj_den.png', style: 'клубная культура, электроника, DJ-сцена. Пишет энергично и с инсайдерским знанием клубной жизни' },
  { name: 'Сандра', avatar: '/avatars/avatar_sandra.png', style: 'поп-музыка, мейнстрим, фестивали. Пишет ярко, эмоционально, с акцентом на тренды' },
  { name: 'Лиана', avatar: '/avatars/avatar_liana.png', style: 'аналитика, индустрия, бизнес музыки. Пишет вдумчиво, с цифрами и контекстом' },
  { name: 'Макс', avatar: '/avatars/avatar_max.png', style: 'рок, альтернатива, инди. Пишет дерзко, с юмором и рок-н-ролльным духом' },
  { name: 'Марк', avatar: '/avatars/avatar_mark.png', style: 'хип-хоп, рэп, R&B. Пишет в уличном стиле, знает культуру изнутри' },
  { name: 'Пабло', avatar: '/avatars/avatar_pablo.png', style: 'мировая музыка, латинская америка, африка, этно. Пишет с уважением к культурным корням' },
  { name: 'Нико', avatar: '/avatars/avatar_nico.png', style: 'европейская сцена, классика, джаз, авангард. Пишет изысканно, со знанием музыкальной теории' },
  { name: 'РадКат', avatar: '/avatars/avatar_radkat.png', style: 'технологии в музыке, AI, стриминг, цифровая индустрия. Пишет технично и футуристично' },
  { name: 'Стелла', avatar: '/avatars/avatar_stella.png', style: 'женщины в музыке, эмпауэрмент, социальные темы. Пишет вдохновляюще и глубоко' },
];
let posterIndex = 0;
function nextPoster() {
  const p = POSTERS[posterIndex % POSTERS.length];
  posterIndex++;
  return p;
}

// Подбор автора по источнику/тематике
function bestPosterForSource(sourceId: string): typeof POSTERS[number] {
  const map: Record<string, string[]> = {
    'pitchfork': ['Макс', 'Марк', 'DJ Den'],
    'nme': ['Макс', 'DJ Den', 'Нико'],
    'guardian-music': ['Нико', 'Сандра', 'Пабло'],
    'guardian-culture': ['Пабло', 'Нико', 'Лиана'],
    'rollingstone-us': ['Макс', 'DJ Den', 'Марк'],
    'billboard-us': ['Сандра', 'Марк', 'Лиана'],
    'consequence': ['Макс', 'Нико', 'DJ Den'],
    'stereogum': ['Нико', 'Макс', 'Лиана'],
    'djmag': ['DJ Den', 'Нико', 'Сандра'],
    'ok-africa': ['Пабло', 'DJ Den', 'Марк'],
    'remezcla': ['Пабло', 'Марк', 'Сандра'],
    'intermedia': ['DJ Den', 'Сандра', 'РадКат'],
    'theflow': ['Марк', 'Макс', 'Стелла'],
    'rollingstone-ru': ['Макс', 'Нико', 'Лиана'],
    'lenta-music': ['Лиана', 'Сандра', 'DJ Den'],
    'afisha-daily': ['Сандра', 'Лиана', 'Стелла'],
    'cnews-ai': ['РадКат', 'Лиана', 'Нико'],
  };
  const candidates = map[sourceId] || [];
  if (candidates.length > 0) {
    const name = candidates[Math.floor(Math.random() * candidates.length)];
    return POSTERS.find(p => p.name === name) || nextPoster();
  }
  return nextPoster();
}


// ─── IndexNow + Sitemap Ping ────────────────────────────
async function pingIndexNow(newsId: string) {
  const DOMAIN = 'https://promo-music.ru';
  const KEY = 'be3b1945c60d606211ccb819caebe3fb';
  const url = `${DOMAIN}/news/${newsId}`;
  const urls = [
    `https://yandex.com/indexnow?url=${encodeURIComponent(url)}&key=${KEY}`,
    `https://api.indexnow.org/indexnow?url=${encodeURIComponent(url)}&key=${KEY}`,
    `https://www.bing.com/indexnow?url=${encodeURIComponent(url)}&key=${KEY}`,
  ];
  for (const u of urls) {
    try { await fetch(u, { method: 'GET' }); } catch {}
  }
  // Ping sitemap
  try { await fetch(`https://yandex.com/ping?sitemap=${DOMAIN}/sitemap.xml`); } catch {}
  console.log(`[news-agent] IndexNow pinged for ${newsId}`);
}

// --- Telegram Channel Posting ---
async function postToTelegram(article: { id: string; title: string; excerpt: string; authorName: string; source: string; tags?: string[]; category?: string }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_NEWS_CHANNEL_ID;
  if (!botToken || !channelId) return;

  const link = `https://promo-music.ru/news/${article.id}`;
  const tags = (article.tags || [])
    .slice(0, 4)
    .map((t: string) => '#' + t.replace(/[^\wа-яёА-ЯЁ]/g, '').slice(0, 20))
    .filter((t: string) => t.length > 1)
    .join(' ');

  const text = [
    `<b>${escapeHtml(article.title)}</b>`,
    '',
    escapeHtml((article.excerpt || '').replace(/<[^>]*>/g, '')),
    '',
    `\u270d\ufe0f ${escapeHtml(article.authorName)} | ${escapeHtml(article.source)}`,
    '',
    `\ud83d\udc49 <a href="${link}">\u0427\u0438\u0442\u0430\u0442\u044c \u043d\u0430 \u041f\u0420\u041e\u041c\u041e.\u041c\u0423\u0417\u042b\u041a\u0410</a>`,
    '',
    tags,
  ].filter(Boolean).join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });
    console.log(`[news-agent] Posted to Telegram: ${article.title.slice(0, 50)}...`);
  } catch (err) {
    console.log(`[news-agent] Telegram post failed: ${err}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


// ─── Source Configuration ───────────────────────────────

export interface NewsSource {
  id: string;
  name: string;
  url: string;
  category: string;
  parsingHint: string;
}

export const NEWS_SOURCES: NewsSource[] = [
  // ── РОССИЯ ──
  {
    id: 'intermedia',
    name: 'InterMedia',
    url: 'https://www.intermedia.ru/',
    category: 'industry',
    parsingHint: 'Главная страница InterMedia — новостной сайт о шоу-бизнесе и музыкальной индустрии России. Извлеки заголовки новостей о музыке, краткое описание и дату публикации. Игнорируй новости о кино и ТВ.',
  },
  {
    id: 'theflow',
    name: 'The Flow',
    url: 'https://the-flow.ru/',
    category: 'releases',
    parsingHint: 'Издание о хип-хоп и рэп культуре в России. Извлеки новости о релизах, артистах, клипах.',
  },
  {
    id: 'rollingstone-ru',
    name: 'Rolling Stone Russia',
    url: 'https://www.rollingstone.ru/',
    category: 'industry',
    parsingHint: 'Российская версия Rolling Stone. Извлеки новости о музыке, артистах, релизах, интервью. Игнорируй новости о кино.',
  },
  {
    id: 'lenta-music',
    name: 'Lenta.ru Музыка',
    url: 'https://lenta.ru/rubrics/culture/music/',
    category: 'industry',
    parsingHint: 'Раздел музыки Lenta.ru. Извлеки новости о музыкальных событиях, артистах, релизах.',
  },
  {
    id: 'afisha-daily',
    name: 'Афиша Daily',
    url: 'https://daily.afisha.ru/music/',
    category: 'events',
    parsingHint: 'Раздел музыки Афиша Daily. Извлеки новости о музыкальных событиях, интервью, обзоры.',
  },

  // ── США ──
  {
    id: 'pitchfork',
    name: 'Pitchfork',
    url: 'https://pitchfork.com/news/',
    category: 'releases',
    parsingHint: 'Pitchfork — ведущее музыкальное издание (США). Извлеки новости о релизах, обзорах альбомов, интервью с артистами. ПЕРЕВЕДИ НА РУССКИЙ.',
  },
  {
    id: 'nme',
    name: 'NME',
    url: 'https://www.nme.com/news/music',
    category: 'industry',
    parsingHint: 'NME — британское музыкальное издание. Извлеки новости о рок-музыке, инди, фестивалях, турах. ПЕРЕВЕДИ НА РУССКИЙ.',
  },
  {
    id: 'rollingstone-us',
    name: 'Rolling Stone',
    url: 'https://www.rollingstone.com/music/music-news/',
    category: 'industry',
    parsingHint: 'Rolling Stone (USA) — легендарное музыкальное издание. Новости о музыкальной индустрии, артистах, релизах. ПЕРЕВЕДИ НА РУССКИЙ.',
  },
  {
    id: 'consequence',
    name: 'Consequence of Sound',
    url: 'https://consequence.net/',
    category: 'releases',
    parsingHint: 'Consequence of Sound — американское музыкальное издание. Новости, рецензии, анонсы туров. ПЕРЕВЕДИ НА РУССКИЙ.',
  },

  // ── ЕВРОПА ──
  {
    id: 'guardian-music',
    name: 'The Guardian Music',
    url: 'https://www.theguardian.com/music',
    category: 'industry',
    parsingHint: 'The Guardian Music — раздел музыки британской газеты. Интервью, обзоры, новости индустрии. ПЕРЕВЕДИ НА РУССКИЙ.',
  },
  {
    id: 'djmag',
    name: 'DJ Mag',
    url: 'https://djmag.com/news',
    category: 'industry',
    parsingHint: 'DJ Mag — ведущий мировой журнал о DJ-культуре и электронной музыке. Новости, интервью, обзоры. ПЕРЕВЕДИ НА РУССКИЙ.',
  },
  {
    id: 'stereogum',
    name: 'Stereogum',
    url: 'https://www.stereogum.com/',
    category: 'releases',
    parsingHint: 'Stereogum — инди-музыкальное издание. Новые релизы, рецензии, инди и альтернатива. ПЕРЕВЕДИ НА РУССКИЙ.',
  },

  // ── ЛАТИНСКАЯ АМЕРИКА ──
  {
    id: 'remezcla',
    name: 'Remezcla',
    url: 'https://remezcla.com/music/',
    category: 'releases',
    parsingHint: 'Remezcla — латиноамериканская культура и музыка: reggaetón, Latin trap, cumbia, Brazilian funk. ПЕРЕВЕДИ НА РУССКИЙ.',
  },

  // ── АФРИКА ──
  {
    id: 'ok-africa',
    name: 'OkayAfrica',
    url: 'https://www.okayafrica.com/music',
    category: 'releases',
    parsingHint: 'OkayAfrica — африканская музыка и культура: afrobeats, amapiano, Afropop, Afrohouse. ПЕРЕВЕДИ НА РУССКИЙ.',
  },

  // ── ТЕХНОЛОГИИ В МУЗЫКЕ ──
  {
    id: 'cnews-ai',
    name: 'CNews AI',
    url: 'https://www.cnews.ru/',
    category: 'industry',
    parsingHint: 'CNews — технологические новости России. Извлеки ТОЛЬКО новости связанные с AI и музыкой, стримингом, музыкальными технологиями. Игнорируй всё остальное.',
  },
];

// ─── HTML Fetching ──────────────────────────────────────

async function fetchPageText(url: string): Promise<string | null> {
  // SSRF protection: validate URL before fetching
  const urlCheck = await isUrlSafe(url);
  if (!urlCheck.safe) {
    console.warn(`[SSRF blocked] ${url}: ${urlCheck.reason}`);
    return null;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

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

// ─── LLM Extraction (OpenRouter + Gemini) ───────────────

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

async function extractNewsWithLLM(
  source: NewsSource,
  pageText: string,
  poster: typeof POSTERS[number],
): Promise<ParsedNewsItem[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log('[news-agent] OPENROUTER_API_KEY not set');
    return [];
  }

  const isInternational = ['pitchfork', 'nme', 'rollingstone-us', 'consequence', 'guardian-music', 'clash-magazine', 'stereogum', 'remezcla', 'ok-africa'].includes(source.id);

  const systemPrompt = `Ты — ${poster.name}, автор-журналист на музыкальной платформе ПРОМО.МУЗЫКА (promo-music.ru).
Твой стиль: ${poster.style}.

Из текста страницы извлеки последние МУЗЫКАЛЬНЫЕ новости и переработай каждую в уникальную статью в своём стиле.

ЗАПРЕЩЁННЫЕ ТЕМЫ — НЕ ВКЛЮЧАЙ статьи про:
- Политику, выборы, протесты, митинги, санкции
- Войну, военные действия, армию, мобилизацию
- Криминал, суды, аресты, уголовные дела
- Скандалы с насилием, домогательствами, наркотиками
- Pussy Riot, Навальный и любые политические фигуры
Если новость смешивает музыку с политикой — НЕ БЕРИ ЕЁ. Мы — музыкальный и культурный портал.
${source.parsingHint}
${isInternational ? '\n⚠️ ИСТОЧНИК НА АНГЛИЙСКОМ. Ты ОБЯЗАН перевести ВСЁ на русский язык. Заголовок, excerpt, content — всё на русском. Названия артистов, альбомов и песен можно оставить на оригинальном языке.' : ''}

ВАЖНО — СТРУКТУРА КАЖДОЙ СТАТЬИ:
- Верни ТОЛЬКО валидный JSON с полем "news" — массив объектов
- Каждый объект: {"title": "SEO-заголовок (60-80 символов, с ключевым словом)", "excerpt": "Meta description 150-160 символов с CTA", "content": "HTML-статья (см. правила ниже)", "category": "одна из: releases, artists, industry, events, charts, interviews, clips", "tags": ["тег1", "тег2", "тег3", "тег4", "тег5"], "publishedAt": "дата ISO или пустая строка"}

ПРАВИЛА КОНТЕНТА (content — HTML):
1. Структура: <h2>Подзаголовок</h2> + абзацы <p> + списки <ul><li> где уместно
2. Минимум 5-8 предложений, разбитых на 2-3 блока с подзаголовками <h2>
3. ПИШИ В СВОЁМ СТИЛЕ (${poster.name}) — у тебя есть характер, мнение, уникальная подача
4. В каждой статье ОБЯЗАТЕЛЬНО 2-3 внутренние ссылки на разделы платформы:
   - <a href="/register">зарегистрироваться на ПРОМО.МУЗЫКА</a>
   - <a href="/promo-air">ПРОМО.ЭИР</a> — радио, ротации, эфир
   - <a href="/marketplace">маркетплейс</a> — продажа музыки, биты
   - <a href="/for-venues">музыка для заведений</a>
   - <a href="/marketplace">каталог треков</a> — релизы
   - <a href="/for-djs">раздел для диджеев</a>
   - <a href="/djs">каталог DJ</a>
   - <a href="/radio-stations">радиостанции</a>
   - <a href="/concerts">афиша концертов</a>
   - <a href="/news">новости</a>
5. В конце каждой статьи CTA-блок:
   <h3>Следите за новостями музыкальной индустрии</h3>
   <p><a href="/register"><strong>Присоединяйтесь к ПРОМО.МУЗЫКА</strong></a> — платформе, где артисты, диджеи и продюсеры развивают карьеру вместе.</p>
6. Выделяй <strong>ключевые слова</strong> (2-3 на статью)
7. Перепиши каждую новость СВОИМИ СЛОВАМИ в стиле ${poster.name} — НЕ копируй дословно
8. ОБЯЗАТЕЛЬНО пиши заголовок (title) и весь текст ТОЛЬКО НА РУССКОМ ЯЗЫКЕ

SEO-ПРАВИЛА:
- title: ключевое слово в начало, год если уместно
- excerpt: законченное предложение с призывом, 150-160 символов
- tags: 5 тегов (жанр, артист, тип новости, "музыка 2026", "ПРОМО.МУЗЫКА")
- Один тег ВСЕГДА "ПРОМО.МУЗЫКА"

- Максимум 5 новостей
- НЕ добавляй markdown-обёртку (\`\`\`json)
- Если не удалось извлечь новости, верни {"news": []}`;

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://promo-music.ru',
        'X-Title': 'PromoFM News Agent',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Источник: "${source.name}" (${source.url})\n\nТекст страницы:\n${pageText}` },
        ],
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!resp.ok) {
      console.log(`[news-agent] LLM error for ${source.id}: ${await resp.text()}`);
      return [];
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];

    let parsed: any;
    // Strip markdown code fences if present
    let cleanContent = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    // Fix trailing commas before } or ]
    cleanContent = cleanContent.replace(/,\s*([}\]])/g, '$1');
    try {
      parsed = JSON.parse(cleanContent);
    } catch {
      // Try to extract the outermost JSON object
      const match = cleanContent.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0].replace(/,\s*([}\]])/g, '$1'));
        } catch {
          console.log('[news-agent] JSON fallback also failed, extracting titles only');
          const items = [...cleanContent.matchAll(/"title"\s*:\s*"([^"]+)"/g)];
          if (items.length > 0) {
            parsed = { news: items.map(m => ({ title: m[1], excerpt: '', content: '', category: 'industry', tags: [], sourceUrl: '', imageUrl: '', publishedAt: '' })) };
          } else return [];
        }
      } else return [];
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
    console.log(`[news-agent] LLM extraction error for ${source.id}: ${error}`);
    return [];
  }
}


// ─── Content Policy Filter ────────────────────────────
// ПРОМО.МУЗЫКА — музыкальный и культурный портал.
// НЕ публикуем политику, войну, криминал, скандалы.

const BLOCKED_KEYWORDS = [
  // Политика
  'политик', 'политич', 'protest', 'протест', 'митинг', 'sanctions', 'санкци',
  'выборы', 'election', 'голосовани', 'парламент', 'оппозици', 'депутат',
  // Война / военное
  'война', 'военн', 'армия', 'оружие', 'бомб', 'ракет', 'танк', 'снаряд',
  'обстрел', 'вторжен', 'оккупац', 'мобилизац', 'СВО', 'ВСУ', 'НАТО',
  // Персоны / организации  
  'Pussy Riot', 'Навальн', 'Путин', 'Putin', 'Зеленск', 'Zelensky',
  'Трамп', 'Trump', 'Biden', 'Байден',
  // Криминал / скандалы
  'педофил', 'изнасилов', 'домогательств', 'розыск', 'арест', 'уголовн',
  'наркотик', 'передозир', 'суицид', 'самоубий',
  // Геополитика
  'Израил', 'Палестин', 'Украин', 'ДНР', 'ЛНР', 'Крым', 'аннекс',
  'Тайван', 'Сирия',
];

function isBlockedContent(title: string, content: string): boolean {
  const text = (title + ' ' + content).toLowerCase();
  return BLOCKED_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
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

  // Pick the best-fit persona for this source
  const poster = bestPosterForSource(source.id);
  console.log(`[news-agent] ${source.name} → автор: ${poster.name}`);

  const newsItems = await extractNewsWithLLM(source, pageText, poster);
  if (newsItems.length === 0) {
    errors.push(`No news extracted from ${source.id}`);
    return { added: 0, errors };
  }

  // Load existing news for deduplication
  const existing = await newsPublicStore.getAll();
  const existingTitles = existing.map((n: any) => n.title || '');

  let added = 0;
  for (const item of newsItems) {
    // Content policy filter
    if (isBlockedContent(item.title, item.content || item.excerpt || '')) {
      console.log(`[news-agent] BLOCKED: ${item.title} (content policy)`);
      continue;
    }

    // Check for duplicates
    const isDuplicate = existingTitles.some((t: string) => titleSimilarity(t, item.title) > 0.6);
    if (isDuplicate) continue;

    const id = `news-${source.id}-${crypto.randomUUID()}`;
    const newsRecord = {
      id,
      ...item,
      source: source.name,
      sourceId: source.id,
      authorName: poster.name,
      authorAvatar: poster.avatar,
      status: 'published' as const,
      createdAt: new Date().toISOString(),
    };

    await newsPublicStore.set(id, newsRecord);
    pingIndexNow(id).catch(() => {});
    postToTelegram({ id, title: item.title, excerpt: item.excerpt, authorName: poster.name, source: source.name, tags: item.tags, category: item.category }).catch(() => {});
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
