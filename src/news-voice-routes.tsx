/**
 * NEWS VOICE ROUTES — стриминг озвучка через Gemini 3.1 Flash Live
 *
 * Голосовой помощник: нажал play → аудио начинает играть через 1-2 сек.
 * PCM чанки стримятся напрямую из Gemini в браузер.
 *
 * Endpoints:
 *   GET  /stream/:newsId  — стрим аудио (audio/L16, chunked)
 *   POST /preview-stream  — стрим произвольного текста
 *   GET  /status           — статистика
 */

import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { getDbClient } from './db-client.tsx';
import { callLLM } from './llm-router.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL || 'http://187.77.85.42:8088';
const GEMINI_PROXY_KEY = process.env.GEMINI_PROXY_KEY || 'promofm-gemini-2026';
const SAMPLE_RATE = 24000;

// LLM script cache (skip 3-4s LLM call on repeat plays)
const scriptCache = new Map<string, { script: string; author: string; ts: number }>();
const SCRIPT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

const AUTHOR_STYLES: Record<string, string> = {
  'DJ Den': 'Энергичный ведущий клубной культуры. Говорит бодро.',
  'Сандра': 'Яркая ведущая поп-музыки. Говорит эмоционально.',
  'Лиана': 'Аналитик индустрии. Говорит вдумчиво.',
  'Макс': 'Рок-ведущий. Говорит дерзко.',
  'Марк': 'Хип-хоп ведущий. Уличный стиль.',
  'Пабло': 'Эксперт мировой музыки.',
  'Нико': 'Знаток классики и джаза.',
  'РэдКэт': 'Технофутурист.',
  'Стелла': 'Вдохновляющая ведущая.',
};

function cleanText(raw: string): string {
  let t = raw.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > 800) {
    const cut = t.lastIndexOf('.', 800);
    t = cut > 300 ? t.slice(0, cut + 1) : t.slice(0, 800) + '.';
  }
  return t;
}

async function makeScript(title: string, text: string, author: string): Promise<string> {
  const style = AUTHOR_STYLES[author] || '';
  try {
    const r = await callLLM({
      system: `Ты — ${author}, ведущий на радио ПРОМО FM. ${style}
Перепиши текст как радио-подводку: 3-5 предложений, живо, без пафоса.
Никаких «дорогие слушатели», смайликов, скобок — чистый текст для озвучки.
ВАЖНО: эфир ОДНОСТОРОННИЙ — слушатели не отвечают, чата нет, звонки не принимаем.
СТРОГО ЗАПРЕЩЕНО задавать вопросы слушателям и предлагать им что-то сделать в реальном времени.
Запрещённые фразы и аналоги: «как вам», «как тебе», «как вам такой вариант», «правда круто», «согласны?»,
«что думаете», «пишите в чат», «напишите», «звоните», «голосуйте», «угадайте», «дайте знать», «онлайн».
Только утверждения и описания — ни одной вопросительной конструкции, обращённой к аудитории.`,
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

// ─── GET /stream/:newsId — стрим озвучки новости ────────

app.get('/stream/:newsId', async (c) => {
  const newsId = c.req.param('newsId');

  try {
    // Load news
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

    // Generate radio script via LLM (with cache)
    let script: string;
    const cached = scriptCache.get(newsId);
    if (cached && Date.now() - cached.ts < SCRIPT_CACHE_TTL) {
      script = cached.script;
      console.log(`[news-voice] Script cache hit: ${newsId}`);
    } else {
      const rawText = cleanText(content || excerpt || title);
      script = await makeScript(title, rawText, author);
      scriptCache.set(newsId, { script, author, ts: Date.now() });
    }

    console.log(`[news-voice] Stream: "${title.slice(0, 40)}" by ${author}`);

    // Stream from Gemini proxy
    const proxyResp = await fetch(`${GEMINI_PROXY_URL}/tts-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
      body: JSON.stringify({ text: script, author }),
    });

    if (!proxyResp.ok || !proxyResp.body) {
      const errText = await proxyResp.text().catch(() => '');
      return c.json({ error: `TTS proxy error: ${errText.slice(0, 200)}` }, 500);
    }

    // Pipe PCM stream to client
    c.header('Content-Type', `audio/L16;rate=${SAMPLE_RATE};channels=1`);
    c.header('Transfer-Encoding', 'chunked');
    c.header('Cache-Control', 'no-cache');
    c.header('Access-Control-Allow-Origin', '*');
    c.header('X-Sample-Rate', String(SAMPLE_RATE));

    return stream(c, async (s) => {
      const reader = proxyResp.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(value);
        }
      } catch (e) {
        // Client disconnected or proxy error
      } finally {
        reader.releaseLock();
      }
    });
  } catch (err) {
    console.error('[news-voice] stream error:', err);
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});

// ─── POST /preview-stream — стрим произвольного текста ───

app.post('/preview-stream', async (c) => {
  const { text, author } = await c.req.json().catch(() => ({ text: '', author: 'DJ Den' }));
  if (!text || text.length < 3) return c.json({ error: 'Text too short' }, 400);

  try {
    const proxyResp = await fetch(`${GEMINI_PROXY_URL}/tts-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
      body: JSON.stringify({ text: text.slice(0, 2000), author: author || 'DJ Den' }),
    });

    if (!proxyResp.ok || !proxyResp.body) {
      return c.json({ error: 'TTS proxy error' }, 500);
    }

    c.header('Content-Type', `audio/L16;rate=${SAMPLE_RATE};channels=1`);
    c.header('Transfer-Encoding', 'chunked');
    c.header('Cache-Control', 'no-cache');
    c.header('Access-Control-Allow-Origin', '*');

    return stream(c, async (s) => {
      const reader = proxyResp.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(value);
        }
      } catch {} finally { reader.releaseLock(); }
    });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});

// ─── POST /warmup/:newsId — pre-cache LLM script (no TTS) ──

app.post("/warmup/:newsId", async (c) => {
  const newsId = c.req.param("newsId");
  try {
    const cached = scriptCache.get(newsId);
    if (cached && Date.now() - cached.ts < SCRIPT_CACHE_TTL) {
      return c.json({ ok: true, cached: true });
    }

    const { data: row } = await getDbClient().from("news_public").select("*").eq("id", newsId)
      .maybeSingle();
    if (!row) return c.json({ error: "Not found" }, 404);

    const d = row.data ?? row;
    const title = d.title || "";
    const content = d.content || "";
    const excerpt = d.excerpt || d.summary || "";
    const author = d.authorName || d.author_name || "DJ Den";
    const rawText = cleanText(content || excerpt || title);
    const script = await makeScript(title, rawText, author);
    scriptCache.set(newsId, { script, author, ts: Date.now() });
    console.log(`[news-voice] Warmup cached script for ${newsId}`);
    return c.json({ ok: true, cached: false, scriptLen: script.length });
  } catch (err) {
    console.error("[news-voice] warmup error:", err);
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});

// ─── GET /status ────────────────────────────────────────

app.get('/status', async (c) => {
  return c.json({
    success: true,
    mode: 'streaming',
    model: 'gemini-3.1-flash-live-preview',
    sampleRate: SAMPLE_RATE,
    proxyUrl: GEMINI_PROXY_URL,
    voices: Object.keys(AUTHOR_STYLES),
  });
});

export default app;
