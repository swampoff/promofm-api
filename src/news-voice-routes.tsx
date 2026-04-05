/**
 * NEWS VOICE ROUTES — живая озвучка новостей через Gemini TTS
 *
 * Голосовой помощник: каждый автор читает свои новости в реальном времени.
 * Нажал play → Gemini генерирует → аудио стримится в браузер. Без хранения файлов.
 *
 * Endpoints:
 *   GET  /play/:newsId   — сгенерировать и отдать аудио (audio/wav)
 *   POST /preview        — озвучить произвольный текст
 *   GET  /status         — статистика
 */

import { Hono } from 'hono';
import { getDbClient } from './db-client.tsx';
import { callLLM } from './llm-router.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL || 'http://187.77.85.42:8088';
const GEMINI_PROXY_KEY = process.env.GEMINI_PROXY_KEY || 'promofm-gemini-2026';

// Стили авторов для генерации скрипта
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

/** WAV header для PCM L16 mono 24000Hz */
function wavHeader(pcmLen: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcmLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcmLen, 40);
  return h;
}

/** Подготовить текст для чтения */
function cleanText(raw: string): string {
  let t = raw.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > 800) {
    const cut = t.lastIndexOf('.', 800);
    t = cut > 300 ? t.slice(0, cut + 1) : t.slice(0, 800) + '.';
  }
  return t;
}

/** Скрипт для чтения вслух — LLM перепишет как радио-подводку */
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

/** Вызов Gemini TTS прокси → PCM → WAV buffer */
async function tts(text: string, author: string): Promise<Buffer> {
  const resp = await fetch(`${GEMINI_PROXY_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
    body: JSON.stringify({ text, authorName: author }),
  });
  if (!resp.ok) throw new Error(`TTS proxy ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const d: any = await resp.json();
  if (!d.success || !d.audioBase64) throw new Error(d.error || 'No audio');
  const pcm = Buffer.from(d.audioBase64, 'base64');
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

// Простой in-memory кэш (LRU, макс 50 записей, TTL 30 мин)
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

// ─── GET /play/:newsId — живая озвучка новости ─────────

app.get('/play/:newsId', async (c) => {
  const newsId = c.req.param('newsId');

  try {
    // Проверяем кэш
    const cached = cacheGet(newsId);
    if (cached) {
      console.log(`[news-voice] Cache hit: ${newsId}`);
      c.header('Content-Type', 'audio/wav');
      c.header('Content-Length', String(cached.length));
      c.header('Cache-Control', 'public, max-age=1800');
      c.header('Access-Control-Allow-Origin', '*');
      return c.body(cached);
    }

    // Загружаем новость
    const { data: row } = await getDbClient()
      .from('news_public')
      .select('*')
      .eq('id', newsId)
      .maybeSingle();

    if (!row) return c.json({ error: 'News not found' }, 404);

    const d = row.data ?? row;
    const title = d.title || '';
    const content = d.content || '';
    const excerpt = d.excerpt || d.summary || '';
    const author = d.authorName || d.author_name || 'DJ Den';

    // Готовим и озвучиваем
    const rawText = cleanText(content || excerpt || title);
    const script = await makeScript(title, rawText, author);
    console.log(`[news-voice] Live TTS: "${title.slice(0, 40)}" by ${author}`);

    const wav = await tts(script, author);

    // Кэшируем
    cacheSet(newsId, wav);

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

// ─── POST /preview — озвучить произвольный текст ────────

app.post('/preview', async (c) => {
  const { text, authorName } = await c.req.json().catch(() => ({ text: '', authorName: 'DJ Den' }));
  if (!text || text.length < 3) return c.json({ error: 'Text too short' }, 400);

  try {
    const wav = await tts(text.slice(0, 2000), authorName || 'DJ Den');
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
    cacheSize: cache.size,
    cacheMaxSize: CACHE_MAX,
    cacheTtlMin: CACHE_TTL / 60000,
    proxyUrl: GEMINI_PROXY_URL,
    voices: Object.keys(AUTHOR_STYLES),
  });
});

export default app;
