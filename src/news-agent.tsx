/**
 * NEWS AGENT — автоматический сбор и обработка музыкальных новостей
 * Парсит HTML из русских и зарубежных источников, переводит и обрабатывает через OpenRouter (Gemini)
 * Каждый автор-персонаж имеет свой стиль и специализацию
 */

import { listAllNewsPublic, upsertNewsPublic } from './db.tsx';
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
  { name: 'РэдКэт', avatar: '/avatars/avatar_radkat.png', style: 'технологии в музыке, AI, стриминг, цифровая индустрия. Пишет технично и футуристично' },
  { name: 'Стелла', avatar: '/avatars/avatar_stella.png', style: 'женщины в музыке, эмпауэрмент, социальные темы. Пишет вдохновляюще и глубоко' },
];
const MAX_BROADCAST_PER_CYCLE = 3; // max news voiced per source fetch
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
    'intermedia': ['DJ Den', 'Сандра', 'РэдКэт'],
    'theflow': ['Марк', 'Макс', 'Стелла'],
    'rollingstone-ru': ['Макс', 'Нико', 'Лиана'],
    'lenta-music': ['Лиана', 'Сандра', 'DJ Den'],
    'afisha-daily': ['Сандра', 'Лиана', 'Стелла'],
    'cnews-ai': ['РэдКэт', 'Лиана', 'Нико'],
  };
  const candidates = map[sourceId] || [];
  if (candidates.length > 0) {
    const name = candidates[Math.floor(Math.random() * candidates.length)];
    return POSTERS.find(p => p.name === name) || nextPoster();
  }
  return nextPoster();
}


// ─── Live Broadcast: автоозвучка в FM-эфир при публикации ───
async function broadcastNewsLive(newsId: string) {
  try {
    const key = process.env.VPS_INTERNAL_KEY || "";
    const resp = await fetch("http://localhost:3000/server/api/broadcast/broadcast/" + newsId, {
      method: "POST",
      headers: { "X-Internal-Key": key },
    });
    const data: any = await resp.json();
    console.log(`[news-agent] Broadcast queued: ${newsId}, listeners: ${data.listeners || 0}`);
  } catch (e: any) {
    console.warn(`[news-agent] Broadcast failed: ${e.message}`);
  }
}

// ─── IndexNow + Sitemap Ping ────────────────────────────
async function pingIndexNow(newsId: string) {
  const DOMAIN = 'https://promo-music.ru';
  const KEY = 'be3b1945c60d606211ccb819caebe3fb';
  const pageUrl = `${DOMAIN}/news/${newsId}`;

  // IndexNow POST (Bing/Yandex/IndexNow.org)
  const body = JSON.stringify({
    host: 'promo-music.ru',
    key: KEY,
    keyLocation: `${DOMAIN}/${KEY}.txt`,
    urlList: [pageUrl],
  });
  const endpoints = [
    'https://api.indexnow.org/indexnow',
    'https://yandex.com/indexnow',
    'https://www.bing.com/indexnow',
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
      });
      console.log(`[indexnow] ${ep} -> ${r.status}`);
    } catch (e: any) {
      console.log(`[indexnow] ${ep} -> error: ${e.message}`);
    }
  }
  // Ping sitemap
  try { await fetch(`https://yandex.com/ping?sitemap=${DOMAIN}/sitemap.xml`); } catch {}
  console.log(`[news-agent] IndexNow pinged for ${newsId}`);
}

// --- Telegram Channel Posting ---
async function postToTelegram(article: { id: string; title: string; excerpt: string; authorName: string; source: string; tags?: string[]; category?: string; imageUrl?: string }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_NEWS_CHANNEL_ID;
  if (!botToken || !channelId) return;

  const link = `https://promo-music.ru/news/${article.id}`;
  const tags = (article.tags || [])
    .slice(0, 4)
    .map((t: string) => '#' + t.replace(/[^\wа-яёА-ЯЁ]/g, '').slice(0, 20))
    .filter((t: string) => t.length > 1)
    .join(' ');

  const excerptClean = (article.excerpt || '').replace(/<[^>]*>/g, '').trim();

  // Build caption ensuring the URL link is NEVER truncated by 1024 char limit
  const titleLine = `<b>${escapeHtml(article.title)}</b>`;
  const authorLine = `\u270d\ufe0f ${escapeHtml(article.authorName)} | ${escapeHtml(article.source)}`;
  const linkLine = `\ud83d\udc49 <a href="${link}">\u0427\u0438\u0442\u0430\u0442\u044c \u043d\u0430 \u041f\u0420\u041e\u041c\u041e.\u041c\u0423\u0417\u042b\u041a\u0410</a>`;

  // Calculate fixed parts length (title + author + link + tags + newlines)
  const fixedParts = [titleLine, '', authorLine, '', linkLine, '', tags].filter(Boolean).join('\n');
  const fixedLen = fixedParts.length;
  // Reserve space for excerpt + 2 newlines around it
  const maxExcerptLen = Math.max(0, 1024 - fixedLen - 4);
  const truncatedExcerpt = excerptClean
    ? escapeHtml(excerptClean.length > maxExcerptLen ? excerptClean.slice(0, maxExcerptLen - 1) + '\u2026' : excerptClean)
    : '';

  const caption = [
    titleLine,
    '',
    truncatedExcerpt || undefined,
    truncatedExcerpt ? '' : undefined,
    authorLine,
    '',
    linkLine,
    '',
    tags,
  ].filter((x): x is string => x !== undefined).join('\n');

  try {
    // If we have an image, send as photo with caption
    if (article.imageUrl && article.imageUrl.startsWith('http')) {
      const photoResp = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: channelId,
          photo: article.imageUrl,
          caption: caption.slice(0, 1024), // safety net, caption already fits
          parse_mode: 'HTML',
        }),
      });
      const photoResult: any = await photoResp.json();
      if (photoResult.ok) {
        console.log(`[news-agent] Posted photo to Telegram: ${article.title.slice(0, 50)}...`);
        return;
      }
      // Photo failed (URL might be invalid/blocked), fall back to text
      console.log(`[news-agent] Photo send failed, falling back to text: ${JSON.stringify(photoResult.description || '')}`);
    }

    // Fallback: send as text message with link preview
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        text: caption,
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
  {
    id: 'zvuki-ru',
    name: 'Звуки.Ру',
    url: 'https://zvuki.ru/',
    category: 'releases',
    parsingHint: 'Звуки.Ру — одно из старейших музыкальных изданий России. Новинки, релизы, интервью, новости российской музыкальной индустрии.',
  },
  {
    id: 'music-in-africa',
    name: 'Music In Africa',
    url: 'https://www.musicinafrica.net/magazine/news',
    category: 'industry',
    parsingHint: 'Music In Africa — панафриканский музыкальный портал. Новости индустрии, артисты и релизы со всей Африки (afrobeats, amapiano, highlife, gqom). ПЕРЕВЕДИ НА РУССКИЙ.',
  },
  {
    id: 'notjustok',
    name: 'Notjustok',
    url: 'https://notjustok.com/',
    category: 'releases',
    parsingHint: 'Notjustok — ведущее нигерийское издание об афробитс и африканской поп-музыке. Новые релизы, чарты, артисты, премьеры. ПЕРЕВЕДИ НА РУССКИЙ.',
  },
  {
    id: 'les-inrocks',
    name: 'Les Inrockuptibles',
    url: 'https://www.lesinrocks.com/musique/',
    category: 'releases',
    parsingHint: 'Les Inrockuptibles — культовое французское музыкальное издание. Новинки, премьеры, европейская инди, шансон, электроника. ПЕРЕВЕДИ НА РУССКИЙ.',
  },
  {
    id: 'factmag',
    name: 'FACT Magazine',
    url: 'https://www.factmag.com/',
    category: 'releases',
    parsingHint: 'FACT Magazine — британско-европейское издание об электронной и андеграунд-музыке. Новинки, премьеры, миксы, европейская клубная сцена. ПЕРЕВЕДИ НА РУССКИЙ.',
  },
];

// ─── HTML Fetching ──────────────────────────────────────

interface FetchResult {
  text: string;
  images: string[];
}

async function fetchPageText(url: string): Promise<FetchResult | null> {
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

    // Extract images BEFORE stripping HTML
    const images: string[] = [];
    // OG image (highest priority)
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]) images.push(ogMatch[1]);
    // Twitter card image
    const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (twMatch?.[1] && !images.includes(twMatch[1])) images.push(twMatch[1]);
    // Article images (from <img> tags in main content, skip tiny icons)
    const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*/gi)];
    for (const m of imgMatches) {
      const src = m[0];
      const url = m[1];
      if (!url || images.length >= 10) break;
      // Skip tracking pixels, icons, ads, svgs
      if (url.includes('1x1') || url.includes('pixel') || url.includes('.svg')
        || url.includes('logo') || url.includes('icon') || url.includes('avatar')
        || url.includes('ad-') || url.includes('banner') || url.length < 20) continue;
      // Skip tiny images (width/height < 100)
      const widthMatch = src.match(/width=["']?(\d+)/i);
      const heightMatch = src.match(/height=["']?(\d+)/i);
      if (widthMatch && parseInt(widthMatch[1]) < 100) continue;
      if (heightMatch && parseInt(heightMatch[1]) < 100) continue;
      if (!images.includes(url)) images.push(url);
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

    // Resolve relative image URLs to absolute
    const baseUrl = new URL(url);
    const resolvedImages = images.map(img => {
      if (img.startsWith('http')) return img;
      if (img.startsWith('//')) return baseUrl.protocol + img;
      if (img.startsWith('/')) return baseUrl.origin + img;
      return baseUrl.origin + '/' + img;
    }).filter(img => {
      // Filter out tiny theme icons and tracking pixels
      if (img.includes('favicon') || img.includes('sprite')) return false;
      // Must be a reasonable image URL
      return img.match(/\.(jpg|jpeg|png|webp|gif)/i) || img.includes('image') || img.includes('photo') || img.includes('upload');
    });
    return { text: cleanText.slice(0, 10000), images: resolvedImages.slice(0, 5) };
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
  pageImages: string[] = [],
): Promise<ParsedNewsItem[]> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY;
  const useGeminiDirect = !!process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('[news-agent] GEMINI_API_KEY / OPENROUTER_API_KEY not set');
    return [];
  }

  const isInternational = ['pitchfork', 'nme', 'rollingstone-us', 'consequence', 'guardian-music', 'stereogum', 'remezcla', 'ok-africa', 'music-in-africa', 'notjustok', 'les-inrocks', 'factmag'].includes(source.id);

  const systemPrompt = `Ты — ${poster.name}, автор-журналист на музыкальной платформе ПРОМО.МУЗЫКА (promo-music.ru).
Твой стиль: ${poster.style}.

Из текста страницы извлеки последние МУЗЫКАЛЬНЫЕ новости и переработай каждую в уникальную статью в своём стиле.

АКТУАЛЬНОСТЬ — КРИТИЧЕСКИ ВАЖНО:
- Сейчас 2026 год. НЕ публикуй новости о событиях 2024 и ранее как свежие.
- Если статья описывает событие прошлых лет (например, "фестиваль 2024", "тур 2023"), ПРОПУСТИ ЕЁ.
- Если в тексте есть даты — проверь, что событие актуально (2025-2026).
- Допускается ретроспектива/обзор, но заголовок ДОЛЖЕН отражать что это ретро.

ЗАПРЕЩЁННЫЕ ТЕМЫ — НЕ ВКЛЮЧАЙ статьи про:
- Политику, выборы, протесты, митинги, санкции
- Войну, военные действия, армию, мобилизацию
- Криминал, суды, аресты, уголовные дела
- Скандалы с насилием, домогательствами, наркотиками
- Pussy Riot, Навальный и любые политические фигуры
Если новость смешивает музыку с политикой — НЕ БЕРИ ЕЁ. Мы — музыкальный и культурный портал.
${source.parsingHint}
${isInternational ? '\n⚠️ ИСТОЧНИК НЕ НА РУССКОМ ЯЗЫКЕ (может быть английский, испанский, французский, португальский и т.д.). Ты ОБЯЗАН перевести ВСЁ на русский язык — независимо от исходного языка. Заголовок, excerpt, content — всё на русском. Названия артистов, альбомов и песен можно оставить на оригинальном языке.' : ''}

АНТИПАТТЕРНЫ AI-ТЕКСТА — ЗАПРЕЩЕНО:
1. Пафосные составные заголовки через двоеточие: "Культурный Ренессанс:", "Симфония Единства:", "Индустриальный Разум:", "Звуковая Революция:" — НЕЛЬЗЯ
2. Эмодзи в заголовках — НЕЛЬЗЯ (только в тексте TG, не в title)
3. Канцеляризмы и книжный стиль: "являет собой", "представляет интерес", "знаменует собой", "свидетельствует о"
4. Конструкция "Не просто X, но и Y" / "Не только X, но и Y"
5. Тройки через запятую: "мастерство, страсть и инновации"
6. Причастные нагромождения: "открывающий новые горизонты"
7. Слова-маркеры AI: "уникальный", "инновационный", "революционный", "знаковый", "грандиозный", "потрясающий", "беспрецедентный", "неповторимый"
8. Избыточные метафоры: "мост между прошлым и будущим", "ткань звукового полотна"
9. Дефисные неологизмы: "арт-революция", "звуко-пространство"

КАК НАДО — пиши как живой журналист:
- Заголовок = конкретный факт или событие, без пафоса: "Oxxxymiron выпустил новый альбом", "Фестиваль Alfa Future People перенесли на август"
- Предложения короткие (12-20 слов), чередуй длинные с короткими
- Начинай с факта, не с оценки. Мнение — в середине или конце
- Используй разговорные обороты своего персонажа (${poster.name})

ОБЯЗАТЕЛЬНАЯ КОНКРЕТИКА — самое важное правило:
Каждая статья ОБЯЗАНА содержать минимум 3 конкретных факта из источника
(не общие фразы, а реальные данные). Подходящие виды фактов:
- Название релиза (альбома / EP / сингла / трека) с годом
- Дата релиза / концерта / тура / премии
- Лейбл, продюсер, фичеринги, авторы треков
- Цифры: позиция в чартах, тираж, количество стримов, кассовые сборы
- Цитата артиста (короткая, 1-2 предложения)
- Конкретный город / площадка / страна / фестиваль
- Сравнение с предыдущей работой (тоже с названием/датой)

ЗАПРЕЩЕНО писать «общими словами»:
- «продолжает радовать поклонников своим мастерством» — НЕТ
- «не перестаёт удивлять техникой» — НЕТ
- «один из самых ярких артистов» — НЕТ
- «его музыка по-прежнему полна энергии» — НЕТ
Это пустые фразы. Их можно вставить ТОЛЬКО если они подкреплены
конкретным фактом рядом («продолжает удивлять — в феврале 2026
выпустил альбом X на лейбле Y»).

ЕСЛИ ИЗ ИСТОЧНИКА НЕ УДАЛОСЬ ВЫТАЩИТЬ 3+ ФАКТА — пропусти эту
новость целиком, не выдумывай и не разводи воды. Лучше 2 статьи с
фактами, чем 5 общих.

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
5. ПЕРЕД CTA-блоком ОБЯЗАТЕЛЬНО укажи источник:
   <p class="news-source">Источник: <a href="URL_ИСТОЧНИКА" target="_blank" rel="noopener">ИМЯ_ИСТОЧНИКА</a></p>
   Где ИМЯ_ИСТОЧНИКА — название издания из поля "Источник" (например, Lenta.ru Музыка, Pitchfork, NME и т.д.), а URL_ИСТОЧНИКА — его URL.
6. В конце каждой статьи CTA-блок:
   <h3>Следите за новостями музыкальной индустрии</h3>
   <p><a href="/register"><strong>Присоединяйтесь к ПРОМО.МУЗЫКА</strong></a> — платформе, где артисты, диджеи и продюсеры развивают карьеру вместе.</p>
7. Выделяй <strong>ключевые слова</strong> (2-3 на статью)
8. Перепиши каждую новость СВОИМИ СЛОВАМИ в стиле ${poster.name} — НЕ копируй дословно
9. ОБЯЗАТЕЛЬНО пиши заголовок (title) и весь текст ТОЛЬКО НА РУССКОМ ЯЗЫКЕ

SEO-ПРАВИЛА:
- title: ключевое слово в начало, год если уместно
- excerpt: законченное предложение с призывом, 150-160 символов
- tags: 5 тегов (жанр, артист, тип новости, "музыка 2026", "ПРОМО.МУЗЫКА")
- Один тег ВСЕГДА "ПРОМО.МУЗЫКА"

- Максимум 5 новостей
- НЕ добавляй markdown-обёртку (\`\`\`json)
- Если не удалось извлечь новости, верни {"news": []}

ИЗОБРАЖЕНИЯ — КРИТИЧЕСКИ ВАЖНО:
- Для каждой новости ты ДОЛЖЕН указать в поле "imageUrl" правильный URL изображения
- Выбирай фото из списка доступных изображений (ниже), которое СООТВЕТСТВУЕТ теме конкретной новости
- Сопоставляй по артисту, событию, контексту — НЕ бери случайное фото
- НЕ используй одно фото для разных новостей без необходимости
- Если подходящего фото нет — оставь пустую строку ""
` + (pageImages.length > 0 ? `\n\nДоступные изображения со страницы (выбери подходящее для каждой новости):\n` + pageImages.map((url: string, i: number) => `[${i+1}] ${url}`).join("\n") : "") + ``;

  try {
    let llmContent: string | undefined;

    if (useGeminiDirect) {
      // Google Gemini API via proxy (Hostinger VPS, bypasses Russia geo-restriction)
      const geminiModel = 'gemini-2.5-flash';
      const proxyUrl = process.env.GEMINI_PROXY_URL;
      const proxyKey = process.env.GEMINI_PROXY_KEY || '';
      const geminiUrl = proxyUrl
        ? `${proxyUrl}/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
      const resp = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(proxyKey ? { 'x-proxy-key': proxyKey } : {}) },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: systemPrompt + '\n\n---\n\n' + `Источник: "${source.name}" (${source.url})\n\nТекст страницы:\n${pageText}` }] },
          ],
          generationConfig: { temperature: 0.3, maxOutputTokens: 16000 },
        }),
      });
      if (!resp.ok) {
        // Квота Gemini кончилась (free-tier) — новости молча переставали
        // извлекаться со ВСЕХ источников: «No news extracted», эфир без
        // новостных блоков (инцидент 2026-08-07). Уходим на llm-router:
        // он сам выберет OpenRouter, а при отказе — оплаченный Anthropic.
        const geminiErr = (await resp.text()).slice(0, 160);
        console.log(`[news-agent] Gemini недоступен для ${source.id} (${geminiErr}) → фолбэк на llm-router`);
        try {
          const { quickLLM } = await import('./llm-router.tsx');
          llmContent = await quickLLM(
            systemPrompt,
            `Источник: "${source.name}" (${source.url})\n\nТекст страницы:\n${pageText}`,
            { maxTokens: 8000, tag: 'news-agent' },
          );
          console.log(`[news-agent] фолбэк отработал для ${source.id}: ${llmContent?.length || 0} символов`);
        } catch (e: any) {
          console.log(`[news-agent] фолбэк тоже упал для ${source.id}: ${e?.message || e}`);
          return [];
        }
      } else {
        const data: any = await resp.json();
        llmContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
      }
    } else {
      // OpenRouter fallback
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://promo-music.ru',
          'X-Title': 'PromoFM News Agent',
        },
        body: JSON.stringify({
          model: 'google/gemini-3-flash-preview',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Источник: "${source.name}" (${source.url})\n\nТекст страницы:\n${pageText}` },
          ],
          temperature: 0.3,
          max_tokens: 8000,
        }),
      });
      if (!resp.ok) {
        const orErr = (await resp.text()).slice(0, 160);
        console.log(`[news-agent] OpenRouter недоступен для ${source.id} (${orErr}) → фолбэк на llm-router`);
        try {
          const { quickLLM } = await import('./llm-router.tsx');
          llmContent = await quickLLM(
            systemPrompt,
            `Источник: "${source.name}" (${source.url})\n\nТекст страницы:\n${pageText}`,
            { maxTokens: 8000, tag: 'news-agent' },
          );
        } catch (e: any) {
          console.log(`[news-agent] фолбэк тоже упал для ${source.id}: ${e?.message || e}`);
          return [];
        }
      } else {
        const data: any = await resp.json();
        llmContent = data.choices?.[0]?.message?.content;
      }
    }

    const rawContent = llmContent;
    if (!rawContent) return [];

    let parsed: any;
    // Strip markdown code fences anywhere in text (not just start/end)
    let cleanContent = rawContent.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    // Fix trailing commas before } or ]
    cleanContent = cleanContent.replace(/,\s*([}\]])/g, '$1');
    try {
      parsed = JSON.parse(cleanContent);
    } catch {
      // Try to extract JSON between first { and last }
      const firstBrace = cleanContent.indexOf('{');
      const lastBrace = cleanContent.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const jsonStr = cleanContent.slice(firstBrace, lastBrace + 1).replace(/,\s*([}\]])/g, '$1');
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          // Try to find a JSON array
          const firstBracket = cleanContent.indexOf('[');
          const lastBracket = cleanContent.lastIndexOf(']');
          if (firstBracket !== -1 && lastBracket > firstBracket) {
            try {
              const arr = JSON.parse(cleanContent.slice(firstBracket, lastBracket + 1).replace(/,\s*([}\]])/g, '$1'));
              parsed = { news: arr };
            } catch {
              console.log(`[news-agent] All JSON parse attempts failed for ${source.id}, raw length: ${rawContent.length}`);
              console.log(`[news-agent] First 300 chars: ${rawContent.slice(0, 300)}`);
              return [];
            }
          } else {
            console.log(`[news-agent] No JSON structure found for ${source.id}`);
            return [];
          }
        }
      } else {
        console.log(`[news-agent] No braces found in LLM response for ${source.id}`);
        return [];
      }
    }

    const rawNews = Array.isArray(parsed) ? parsed : (parsed.news || parsed.articles || []);
    if (!Array.isArray(rawNews)) return [];

    const results = rawNews
      .filter((n: any) => n.title && n.title.length > 5)
      .slice(0, 5)
      .map((n: any, idx: number) => ({
        title: String(n.title).trim(),
        excerpt: String(n.excerpt || '').trim(),
        content: String(n.content || '').trim(),
        category: n.category || source.category,
        tags: Array.isArray(n.tags) ? n.tags : [],
        sourceUrl: n.sourceUrl || source.url,
        // Use LLM-selected image (LLM picks correct image per article from prompt)
        imageUrl: n.imageUrl && n.imageUrl.startsWith('http') ? n.imageUrl : '',
        publishedAt: n.publishedAt || new Date().toISOString(),
      }))
      .map((n: any) => {
        // Guarantee source attribution in content (post-processing)
        let c = n.content as string;
        const srcLink = `<p class="news-source">\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a: <a href="${source.url}" target="_blank" rel="noopener">${source.name}</a></p>`;
        if (!c.includes('class="news-source"') && !c.includes('\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a:')) {
          const ctaIdx = c.indexOf('<h3>\u0421\u043b\u0435\u0434\u0438\u0442\u0435 \u0437\u0430 \u043d\u043e\u0432\u043e\u0441\u0442\u044f\u043c\u0438');
          if (ctaIdx !== -1) {
            c = c.slice(0, ctaIdx) + srcLink + '\n' + c.slice(ctaIdx);
          } else {
            c = c + '\n' + srcLink;
          }
        }
        return { ...n, content: c };
      });

    // Skip articles with empty content (title-only articles are useless)
    const valid = results.filter(r => r.content.length >= 50);
    if (valid.length < results.length) {
      console.log(`[news-agent] Skipped ${results.length - valid.length} empty-content articles from ${source.id}`);
    }
    return valid;
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

function isBlockedContent(title: string, content: string): string | false {
  const text = (title + ' ' + content).toLowerCase();
  for (const kw of BLOCKED_KEYWORDS) {
    const kwLow = kw.toLowerCase();
    // Short keywords (<=4 chars) need word boundary to avoid false positives
    // e.g. "СВО" must not match "своих", "своего" etc.
    if (kwLow.length <= 4) {
      const regex = new RegExp(`(?:^|[\\s.,!?;:()\\[\\]"'«»—-])${kwLow.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:$|[\\s.,!?;:()\\[\\]"'«»—-])`, 'i');
      if (regex.test(text)) return kw;
    } else {
      // Longer keywords (>=5 chars) are specific enough for substring match
      if (text.includes(kwLow)) return kw;
    }
  }
  return false;
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

export async function fetchNewsFromSource(source: NewsSource, overridePoster?: typeof POSTERS[number]): Promise<{ added: number; errors: string[] }> {
  const errors: string[] = [];

  const fetchResult = await fetchPageText(source.url);
  if (!fetchResult) {
    errors.push(`Failed to fetch ${source.url}`);
    return { added: 0, errors };
  }

  // Use override poster (single host per cron cycle) or pick best-fit
  const poster = overridePoster || bestPosterForSource(source.id);
  console.log(`[news-agent] ${source.name} → автор: ${poster.name} (${fetchResult.images.length} images found)`);

  const newsItems = await extractNewsWithLLM(source, fetchResult.text, poster, fetchResult.images);
  if (newsItems.length === 0) {
    errors.push(`No news extracted from ${source.id}`);
    return { added: 0, errors };
  }

  // Load existing news for deduplication
  const existing = await listAllNewsPublic();
  const existingTitles = existing.map((n: any) => n.title || '');

  let added = 0;
  for (const item of newsItems) {
    // Content policy filter
    const blockedBy = isBlockedContent(item.title, item.content || item.excerpt || '');
    if (blockedBy) {
      console.log(`[news-agent] BLOCKED: ${item.title} (keyword: "${blockedBy}")`);
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

    await upsertNewsPublic(newsRecord as any);
    pingIndexNow(id).catch(() => {});
    postToTelegram({ id, title: item.title, excerpt: item.excerpt, authorName: poster.name, source: source.name, tags: item.tags, category: item.category, imageUrl: item.imageUrl }).catch(() => {});

    // Broadcast limit: max 3 per fetch cycle, rest are text-only
    if (added < MAX_BROADCAST_PER_CYCLE) {
      broadcastNewsLive(id).catch(() => {});
    } else {
      console.log(`[news-agent] Broadcast limit reached, skipping voice for: ${item.title.slice(0, 40)}`);
    }

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

  // Single host for entire cycle — like real radio, one DJ per shift
  const cycleHost = POSTERS[Math.floor(Math.random() * POSTERS.length)];
  console.log(`[news-agent] Cycle host: ${cycleHost.name} — ведёт весь выпуск`);

  for (const source of NEWS_SOURCES) {
    console.log(`[news-agent] Fetching from ${source.name}...`);
    const result = await fetchNewsFromSource(source, cycleHost);
    results[source.id] = result;
    totalAdded += result.added;

    // Delay between sources to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }

  return { totalAdded, results };
}
