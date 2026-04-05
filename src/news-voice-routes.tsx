/**
 * NEWS VOICE ROUTES — живая озвучка новостей через Gemini 3.1 Flash Live
 *
 * Голосовой помощник: каждый автор читает свои новости.
 * Play → LLM генерирует радио-скрипт → Gemini TTS → WAV стримится в браузер.
 *
 * Endpoints:
 *   GET  /play/:newsId   — сгенерировать и отдать аудио (audio/wav)
 *   POST /preview        — озвучить произвольный текст
 *   POST /warmup/:newsId — прогреть кэш (вызывается автоматически при публикации)
 *   GET  /status         — статистика
 */

import { Hono } from 'hono';
import { getDbClient } from './db-client.tsx';
import { callLLM } from './llm-router.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL || 'http://187.77.85.42:8088';
const GEMINI_PROXY_KEY = process.env.GEMINI_PROXY_KEY || 'promofm-gemini-2026';

// Стили авторов для LLM-скрипта
const AUTHOR_STYLES: Record<string, string> = {
  'DJ Den': 'Энергичный ведущий клубной культуры. Говорит бодро, с инсайдерским знанием.',
  'Сандра': 'Яркая ведущая поп-музыки. Говорит эмоционально, с акцентом на тренды.',
  'Лиана': 'Аналитик индустрии. Говорит вдумчиво, с цифрами и контекстом.',
  'Макс': 'Рок-ведущий. Говорит дерзко, с юмором.',
  'Марк': 'Хип-хоп ведущий. Уличный стиль, знает культуру.',
  'Пабло': 'Эксперт мировой музыки. С уважением к культурам.',
  'Нико': 'Знаток классики и джаза. Говорит изысканно.',
  'РадКат': 'Технофутурист. О технологиях в музыке.',
  'Стелла': 'Вдохновляющая ведущая о женщинах в музыке.',
};

/** Подготовить текст для чтения */
function cleanText(raw: string): string {
  let t = raw.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > 800) {
    const cut = t.lastIndexOf('.', 800);
    t = cut > 300 ? t.slice(0, cut + 1) : t.slice(0, 800) + '.';
  }
  return t;
}

/** LLM перепишет текст как радио-подводку */
async function makeScript(title: string, text: string, author: string): Promise<string> {
  const style = AUTHOR_STYLES[author] || '';
  const sys = `Ты — ${author}, ведущий на радио ПРОМО FM. ${style}
Перепиши текст как радио-подводку: 3-5 предложений, живо, без пафоса.
Никаких «дорогие слушатели», смайликов, скобок — чистый текст для озвучки.
Начни с сути, упоминай факты. Только текст для чтения вслух.`;

  try {
    const r = await callLLM({
      system: sys,
      messages: [{ role: 'user', content: `Новость: «${title}»\n\n${text}\n\nРадио-подводка:` }],
      model: 'openai/gpt-4o-mini',
      maxTokens: 400,
      temperature: 0.7,
      tag: 'news-voice',
    });
    return r.text.trim();
  } catch {
    return text;
  }
}

/** Вызов Gemini TTS прокси → WAV buffer (бинарный ответ) */
async function tts(text: string, author: string): Promise<Buffer> {
  const resp = await fetch(`${GEMINI_PROXY_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
    body: JSON.stringify({ text, author }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`TTS proxy ${resp.status}: ${errText.slice(0, 200)}`);
  }
  // Прокси возвращает бинарный WAV (audio/wav)
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// In-memory LRU кэш (макс 50 записей, TTL 30 мин)
const cache = new Map<string, { wav: Buffer; ts: number }>();
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 50;

function cacheGet(key: string): Buffer | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.wav;
}

function cacheSet(key: string, wav: Buffer) {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { wav, ts: Date.now() });
}

/** Загрузить новость и подготовить данные для TTS */
async function loadNewsForTTS(newsId: string) {
  const { data: row } = await getDbClient()
    .from('news_public')
    .select('*')
    .eq('id', newsId)
    .maybeSingle();
  if (!row) return null;
  const d = row.data ?? row;
  return {
    title: d.title || '',
    content: d.content || '',
    excerpt: d.excerpt || d.summary || '',
    author: d.authorName || d.author_name || 'DJ Den',
  };
}

/** Сгенерировать аудио для новости (с кэшем) */
async function generateVoice(newsId: string): Promise<Buffer | null> {
  const cached = cacheGet(newsId);
  if (cached) return cached;

  const news = await loadNewsForTTS(newsId);
  if (!news) return null;

  const rawText = cleanText(news.content || news.excerpt || news.title);
  const script = await makeScript(news.title, rawText, news.author);
  console.log(`[news-voice] Generating: "${news.title.slice(0, 40)}" by ${news.author}`);

  const wav = await tts(script, news.author);
  cacheSet(newsId, wav);
  return wav;
}

// ─── GET /play/:newsId — живая озвучка новости ─────────

app.get('/play/:newsId', async (c) => {
  const newsId = c.req.param('newsId');
  try {
    const wav = await generateVoice(newsId);
    if (!wav) return c.json({ error: 'News not found' }, 404);

    c.header('Content-Type', 'audio/wav');
    c.header('Content-Length', String(wav.length));
    c.header('Cache-Control', 'public, max-age=1800');
    c.header('Access-Control-Allow-Origin', '*');
    return c.body(wav);
  } catch (err) {
    console.error('[news-voice] play error:', err);
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});

// ─── POST /warmup/:newsId — прогреть кэш (авто при публикации) ───

app.post('/warmup/:newsId', async (c) => {
  const newsId = c.req.param('newsId');
  // Генерируем в фоне, не блокируя ответ
  generateVoice(newsId)
    .then(() => console.log(`[news-voice] Warmup OK: ${newsId}`))
    .catch((e) => console.error(`[news-voice] Warmup FAIL: ${newsId}`, e.message));
  return c.json({ success: true, message: 'Voice warmup started' });
});

// ─── POST /preview — озвучить произвольный текст ────────

app.post('/preview', async (c) => {
  const { text, author } = await c.req.json().catch(() => ({ text: '', author: 'DJ Den' }));
  if (!text || text.length < 3) return c.json({ error: 'Text too short' }, 400);

  try {
    const wav = await tts(text.slice(0, 2000), author || 'DJ Den');
    c.header('Content-Type', 'audio/wav');
    c.header('Content-Length', String(wav.length));
    c.header('Access-Control-Allow-Origin', '*');
    return c.body(wav);
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});

// ─── GET /status ────────────────────────────────────────

app.get('/status', async (c) => {
  return c.json({
    success: true,
    mode: 'live',
    model: 'gemini-3.1-flash-live-preview',
    cacheSize: cache.size,
    cacheMaxSize: CACHE_MAX,
    cacheTtlMin: CACHE_TTL / 60000,
    proxyUrl: GEMINI_PROXY_URL,
    voices: Object.keys(AUTHOR_STYLES),
  });
});

export default app;
