/**
 * NEWS BROADCAST — Голос ведущих в лайв promo.fm эфире
 *
 * Новость/текст → LLM script → Gemini TTS → PCM → AutoDJ inject → promo.fm стрим
 * Голос миксуется поверх музыки с ducking (как настоящее FM-радио).
 *
 * POST /speak           — текст → LLM скрипт → TTS → inject в эфир (бот)
 * POST /text            — готовый текст → TTS → inject (без LLM)
 * POST /broadcast/:id   — новость из БД → LLM → TTS → inject
 * GET  /queue           — очередь (admin)
 * GET  /status          — статистика
 */

import { Hono } from 'hono';
import { getDbClient } from './db-client.tsx';
import { callLLM } from './llm-router.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

const GEMINI_PROXY_URL = process.env.GEMINI_PROXY_URL || 'http://187.77.85.42:8088';
const GEMINI_PROXY_KEY = process.env.GEMINI_PROXY_KEY || 'promofm-gemini-2026';
const AUTODJ_URL = process.env.AUTODJ_URL || 'http://127.0.0.1:8087';
const SAMPLE_RATE = 24000;
const INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

const broadcastQueue: { newsId: string; addedAt: number }[] = [];
let isBroadcasting = false;
let currentBroadcast: { newsId: string; title: string; author: string; startedAt: number } | null = null;
let totalBroadcasts = 0;

const AUTHOR_STYLES: Record<string, string> = {
  'DJ Den': 'Энергичный ведущий клубной культуры. Говорит бодро, коротко, с драйвом.',
  'Сандра': 'Поп-музыкальный журналист. Лёгкий, позитивный тон.',
  'Лиана': 'Аналитик индустрии. Серьёзный, экспертный тон.',
  'Макс': 'Рок-музыкальный ведущий. Резкий, прямой стиль.',
  'Марк': 'Хип-хоп репортёр. Уличный, современный слэнг.',
  'Пабло': 'Ведущий мировой музыки. Тёплый, космополитичный.',
  'Нико': 'Классика и джаз эксперт. Утончённый, спокойный.',
  'РадКат': 'Технофутурист. Гиковский, восторженный стиль.',
  'Стелла': 'Социальный комментатор. Эмоциональный, остроумный.',
};

function cleanText(t: string): string {
  return t.replace(/<[^>]*>/g, '').replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim().slice(0, 3000);
}

async function makeScript(title: string, text: string, author: string): Promise<string> {
  const style = AUTHOR_STYLES[author] || AUTHOR_STYLES['DJ Den'];
  const prompt = `Ты — ${author}, радиоведущий ПРОМО.МУЗЫКА FM. ${style}
Перепиши эту новость как ЖИВОЙ радио-выход в FM-эфире. 3-5 предложений, разговорный стиль.
Начни с приветствия слушателей. Заканчивай фразой к следующему треку.
НЕ используй маркдаун, эмодзи, хэштеги. Только живая речь.

Заголовок: ${title}
Текст: ${text}`;

  const result = await callLLM({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    maxTokens: 300,
    tag: 'news-broadcast',
  });
  return (result?.content || title).trim();
}

// --- Core: TTS → collect PCM → inject into AutoDJ stream ---

async function ttsAndInject(text: string, author: string): Promise<{ok: boolean; bytes: number; duration: number; error?: string}> {
  // Step 1: Get PCM stream from Gemini TTS proxy
  const proxyResp = await fetch(`${GEMINI_PROXY_URL}/tts-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
    body: JSON.stringify({ text, author }),
  });

  if (!proxyResp.ok || !proxyResp.body) {
    return { ok: false, bytes: 0, duration: 0, error: `TTS proxy error: ${proxyResp.status}` };
  }

  // Step 2: Collect all PCM chunks
  const reader = proxyResp.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      chunks.push(value);
      totalBytes += value.length;
    }
  }

  if (totalBytes < 1000) {
    return { ok: false, bytes: totalBytes, duration: 0, error: 'TTS returned too little data' };
  }

  // Step 3: Combine chunks into single buffer
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const duration = (totalBytes / 2) / SAMPLE_RATE;
  console.log(`[broadcast] TTS collected: ${totalBytes} bytes (${duration.toFixed(1)}s), injecting into promo.fm...`);

  // Step 4: POST raw PCM to AutoDJ /api/inject (converts mono 24kHz → stereo 44.1kHz, sets overlay)
  try {
    const injectResp = await fetch(`${AUTODJ_URL}/api/inject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Internal-Key': INTERNAL_KEY,
      },
      body: combined,
    });
    const injectData = await injectResp.json();

    if (!injectResp.ok) {
      console.error(`[broadcast] AutoDJ inject error:`, injectData.error);
      return { ok: false, bytes: totalBytes, duration, error: injectData.error };
    }

    console.log(`[broadcast] Injected into promo.fm: ${injectData.duration}s overlay pending`);
    totalBroadcasts++;
    return { ok: true, bytes: totalBytes, duration: injectData.duration || duration };

  } catch (err: any) {
    console.error(`[broadcast] AutoDJ inject failed:`, err.message);
    return { ok: false, bytes: totalBytes, duration, error: err.message };
  }
}

// --- POST /speak --- текст → LLM скрипт → TTS → inject в эфир

app.post("/speak", async (c) => {
  const key = c.req.header("X-Internal-Key") || "";
  if (INTERNAL_KEY && key !== INTERNAL_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { text, author } = await c.req.json().catch(() => ({ text: "", author: "DJ Den" }));
  if (!text || text.length < 5) return c.json({ error: "Text too short" }, 400);

  const speakerAuthor = author || "DJ Den";
  const rawText = cleanText(text);

  // LLM radio script
  let script: string;
  try {
    script = await makeScript(rawText.slice(0, 100), rawText, speakerAuthor);
  } catch (e) {
    console.warn(`[broadcast] LLM failed, using raw text:`, e);
    script = rawText;
  }

  console.log(`[broadcast] Speak: "${script.slice(0, 50)}..." by ${speakerAuthor}`);
  currentBroadcast = { newsId: "bot-speak", title: text.slice(0, 60), author: speakerAuthor, startedAt: Date.now() };

  try {
    const result = await ttsAndInject(script, speakerAuthor);
    currentBroadcast = null;

    if (!result.ok) {
      return c.json({ error: result.error || "Inject failed" }, 500);
    }

    return c.json({ ok: true, bytes: result.bytes, duration: result.duration, script: script.slice(0, 200) });
  } catch (err) {
    currentBroadcast = null;
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});

// --- POST /text --- готовый текст → TTS → inject (без LLM)

app.post("/text", async (c) => {
  const key = c.req.header("X-Internal-Key") || "";
  if (INTERNAL_KEY && key !== INTERNAL_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { text, author } = await c.req.json().catch(() => ({ text: "", author: "DJ Den" }));
  if (!text || text.length < 3) return c.json({ error: "Text too short" }, 400);

  const speakerAuthor = author || "DJ Den";
  console.log(`[broadcast] Text inject: "${text.slice(0, 50)}..." by ${speakerAuthor}`);
  currentBroadcast = { newsId: "bot-text", title: text.slice(0, 60), author: speakerAuthor, startedAt: Date.now() };

  try {
    const result = await ttsAndInject(text.slice(0, 3000), speakerAuthor);
    currentBroadcast = null;

    if (!result.ok) {
      return c.json({ error: result.error || "Inject failed" }, 500);
    }

    return c.json({ ok: true, bytes: result.bytes, duration: result.duration });
  } catch (err) {
    currentBroadcast = null;
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});

// --- Process single news from DB ---

async function broadcastNews(newsId: string): Promise<boolean> {
  const db = getDbClient();
  const { data: row } = await db.from('news_public').select('*').eq('id', newsId).maybeSingle();
  if (!row) {
    console.warn(`[broadcast] News not found: ${newsId}`);
    return false;
  }

  const d = row.data ?? row;
  const title = d.title || '';
  const content = d.content || '';
  const excerpt = d.excerpt || d.summary || '';
  const author = d.authorName || d.author_name || 'DJ Den';

  console.log(`[broadcast] News: "${title.slice(0, 50)}" by ${author}`);
  currentBroadcast = { newsId, title, author, startedAt: Date.now() };

  const rawText = cleanText(content || excerpt || title);
  let script: string;
  try {
    script = await makeScript(title, rawText, author);
  } catch {
    script = rawText;
  }

  const result = await ttsAndInject(script, author);
  currentBroadcast = null;
  return result.ok;
}

// --- POST /broadcast/:newsId --- поставить новость в очередь

app.post('/broadcast/:newsId', async (c) => {
  const newsId = c.req.param('newsId');
  const key = c.req.header('X-Internal-Key') || '';
  if (INTERNAL_KEY && key !== INTERNAL_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (broadcastQueue.some(q => q.newsId === newsId)) {
    return c.json({ ok: true, already_queued: true });
  }

  broadcastQueue.push({ newsId, addedAt: Date.now() });
  console.log(`[broadcast] Queued: ${newsId} (position ${broadcastQueue.length})`);

  // Process queue
  if (!isBroadcasting) {
    isBroadcasting = true;
    (async () => {
      while (broadcastQueue.length > 0) {
        const item = broadcastQueue.shift()!;
        try { await broadcastNews(item.newsId); } catch (err) { console.error(`[broadcast] Queue error:`, err); }
        if (broadcastQueue.length > 0) await new Promise(r => setTimeout(r, 2000));
      }
      isBroadcasting = false;
    })().catch(console.error);
  }

  return c.json({ ok: true, queued: true, position: broadcastQueue.length });
});

// --- GET /queue ---

app.get('/queue', async (c) => {
  return c.json({
    current: currentBroadcast,
    queue: broadcastQueue.map((q, i) => ({ ...q, position: i + 1 })),
    queueLength: broadcastQueue.length,
    isBroadcasting,
  });
});

// --- GET /status ---

app.get('/status', async (c) => {
  // Also fetch AutoDJ status for listener count
  let autoDjStatus: any = null;
  try {
    const r = await fetch(`${AUTODJ_URL}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) autoDjStatus = await r.json();
  } catch { /* silent */ }

  return c.json({
    success: true,
    mode: 'autodj-inject',
    streamUrl: 'https://promo-music.ru/air/live/promo.fm',
    autoDj: autoDjStatus ? {
      status: autoDjStatus.status,
      currentTrack: autoDjStatus.current_track,
      listeners: autoDjStatus.listeners,
    } : null,
    currentBroadcast,
    queueLength: broadcastQueue.length,
    totalBroadcasts,
    model: 'gemini-3.1-flash-live-preview',
  });
});

export default app;
