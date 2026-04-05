/**
 * NEWS BROADCAST — Лайв FM-эфир с дикторами
 * 
 * Когда публикуется новость -> LLM script -> Gemini TTS -> PCM стрим ->
 * все подключённые слушатели слышат диктора в реальном времени.
 * 
 * GET  /live          — подключиться к эфиру (audio/L16 chunked)
 * POST /broadcast/:id — поставить новость в очередь озвучки
 * GET  /queue         — текущая очередь (admin)
 * GET  /status        — статистика
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
const INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

// --- Broadcast Hub ---

interface Listener {
  id: string;
  write: (chunk: Uint8Array) => Promise<void>;
  connectedAt: number;
}

const listeners = new Map<string, Listener>();
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

// Broadcast PCM chunk to all listeners
function broadcastChunk(chunk: Uint8Array) {
  const dead: string[] = [];
  for (const [id, listener] of listeners) {
    listener.write(chunk).catch(() => dead.push(id));
  }
  for (const id of dead) {
    listeners.delete(id);
    console.log(`[broadcast] Listener disconnected: ${id} (${listeners.size} remaining)`);
  }
}

// Process single news item
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

  console.log(`[broadcast] Starting: "${title.slice(0, 50)}" by ${author} -> ${listeners.size} listeners`);
  currentBroadcast = { newsId, title, author, startedAt: Date.now() };

  if (listeners.size === 0) {
    console.log(`[broadcast] No listeners, skipping TTS`);
    currentBroadcast = null;
    return true;
  }

  // Generate radio script
  const rawText = cleanText(content || excerpt || title);
  const script = await makeScript(title, rawText, author);
  console.log(`[broadcast] Script (${script.length} chars): ${script.slice(0, 80)}...`);

  // Stream TTS to all listeners
  try {
    const proxyResp = await fetch(`${GEMINI_PROXY_URL}/tts-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-proxy-key': GEMINI_PROXY_KEY },
      body: JSON.stringify({ text: script, author }),
    });

    if (!proxyResp.ok || !proxyResp.body) {
      console.error(`[broadcast] TTS proxy error: ${proxyResp.status}`);
      currentBroadcast = null;
      return false;
    }

    const reader = proxyResp.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        broadcastChunk(value);
        totalBytes += value.length;
      }
    }

    const duration = ((totalBytes / 2) / SAMPLE_RATE).toFixed(1);
    console.log(`[broadcast] Done: ${totalBytes} bytes (${duration}s audio) -> ${listeners.size} listeners`);
    totalBroadcasts++;

  } catch (err) {
    console.error(`[broadcast] TTS stream error:`, err);
  }

  currentBroadcast = null;
  return true;
}

// Queue processor
async function processQueue() {
  if (isBroadcasting || broadcastQueue.length === 0) return;
  isBroadcasting = true;

  while (broadcastQueue.length > 0) {
    const item = broadcastQueue.shift()!;
    try {
      await broadcastNews(item.newsId);
    } catch (err) {
      console.error(`[broadcast] Queue error:`, err);
    }
    // 2 sec silence gap between news items
    if (broadcastQueue.length > 0) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  isBroadcasting = false;
}

// --- GET /live --- подключиться к лайв-эфиру

app.get('/live', async (c) => {
  const listenerId = `l-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  c.header('Content-Type', `audio/L16;rate=${SAMPLE_RATE};channels=1`);
  c.header('Transfer-Encoding', 'chunked');
  c.header('Cache-Control', 'no-cache, no-store');
  c.header('Connection', 'keep-alive');
  c.header('Access-Control-Allow-Origin', '*');
  c.header('X-Sample-Rate', String(SAMPLE_RATE));
  c.header('X-Listener-Id', listenerId);

  return stream(c, async (s) => {
    const listener: Listener = {
      id: listenerId,
      write: async (chunk) => { await s.write(chunk); },
      connectedAt: Date.now(),
    };

    listeners.set(listenerId, listener);
    console.log(`[broadcast] Listener connected: ${listenerId} (${listeners.size} total)`);

    // Keep alive -- send silence every 30s to prevent timeout
    const keepAlive = setInterval(() => {
      if (!listeners.has(listenerId)) {
        clearInterval(keepAlive);
        return;
      }
      // 480 bytes = 10ms of silence at 24kHz mono 16-bit
      const silence = new Uint8Array(480);
      s.write(silence).catch(() => {
        clearInterval(keepAlive);
        listeners.delete(listenerId);
      });
    }, 30000);

    // Wait until client disconnects
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!listeners.has(listenerId)) {
          clearInterval(check);
          resolve();
        }
      }, 5000);

      c.req.raw.signal?.addEventListener('abort', () => {
        clearInterval(check);
        listeners.delete(listenerId);
        resolve();
      });
    });

    clearInterval(keepAlive);
    listeners.delete(listenerId);
    console.log(`[broadcast] Listener left: ${listenerId} (${listeners.size} remaining)`);
  });
});

// --- POST /broadcast/:newsId --- поставить в очередь

app.post('/broadcast/:newsId', async (c) => {
  const newsId = c.req.param('newsId');

  // Auth: internal key
  const key = c.req.header('X-Internal-Key') || '';
  if (INTERNAL_KEY && key !== INTERNAL_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Check if already in queue
  if (broadcastQueue.some(q => q.newsId === newsId)) {
    return c.json({ ok: true, already_queued: true, position: broadcastQueue.findIndex(q => q.newsId === newsId) + 1 });
  }

  broadcastQueue.push({ newsId, addedAt: Date.now() });
  console.log(`[broadcast] Queued: ${newsId} (position ${broadcastQueue.length})`);

  // Start processing
  processQueue().catch(console.error);

  return c.json({
    ok: true,
    queued: true,
    position: broadcastQueue.length,
    listeners: listeners.size,
  });
});

// --- GET /queue --- текущая очередь (admin)

app.get('/queue', async (c) => {
  return c.json({
    current: currentBroadcast,
    queue: broadcastQueue.map((q, i) => ({ ...q, position: i + 1 })),
    queueLength: broadcastQueue.length,
    isBroadcasting,
  });
});


// --- POST /text --- озвучить произвольный текст в эфир (для бота)

app.post("/text", async (c) => {
  const key = c.req.header("X-Internal-Key") || "";
  if (INTERNAL_KEY && key !== INTERNAL_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { text, author } = await c.req.json().catch(() => ({ text: "", author: "DJ Den" }));
  if (!text || text.length < 3) return c.json({ error: "Text too short" }, 400);

  const speakerAuthor = author || "DJ Den";
  console.log(`[broadcast] Text broadcast: "${text.slice(0, 50)}..." by ${speakerAuthor} -> ${listeners.size} listeners`);

  if (listeners.size === 0) {
    return c.json({ ok: true, listeners: 0, skipped: true, reason: "no listeners" });
  }

  currentBroadcast = { newsId: "bot-text", title: text.slice(0, 60), author: speakerAuthor, startedAt: Date.now() };

  try {
    const proxyResp = await fetch(`${GEMINI_PROXY_URL}/tts-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-proxy-key": GEMINI_PROXY_KEY },
      body: JSON.stringify({ text: text.slice(0, 3000), author: speakerAuthor }),
    });

    if (!proxyResp.ok || !proxyResp.body) {
      currentBroadcast = null;
      return c.json({ error: "TTS proxy error" }, 500);
    }

    const reader = proxyResp.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        broadcastChunk(value);
        totalBytes += value.length;
      }
    }

    const duration = (totalBytes / 2) / SAMPLE_RATE;
    console.log(`[broadcast] Text done: ${totalBytes} bytes (${duration.toFixed(1)}s) -> ${listeners.size} listeners`);
    totalBroadcasts++;
    currentBroadcast = null;

    return c.json({ ok: true, listeners: listeners.size, bytes: totalBytes, duration });

  } catch (err) {
    console.error("[broadcast] Text broadcast error:", err);
    currentBroadcast = null;
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});
// --- POST /speak --- full pipeline: raw text → LLM script → TTS → broadcast

app.post("/speak", async (c) => {
  const key = c.req.header("X-Internal-Key") || "";
  if (INTERNAL_KEY && key !== INTERNAL_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { text, author } = await c.req.json().catch(() => ({ text: "", author: "DJ Den" }));
  if (!text || text.length < 5) return c.json({ error: "Text too short" }, 400);

  const speakerAuthor = author || "DJ Den";

  // Step 1: Generate radio script via LLM
  const rawText = cleanText(text);
  let script: string;
  try {
    script = await makeScript(rawText.slice(0, 100), rawText, speakerAuthor);
  } catch (e) {
    console.warn(`[broadcast] LLM failed, using raw text:`, e);
    script = rawText;
  }

  console.log(`[broadcast] Speak: "${script.slice(0, 50)}..." by ${speakerAuthor} -> ${listeners.size} listeners`);

  if (listeners.size === 0) {
    return c.json({ ok: true, listeners: 0, skipped: true, reason: "no listeners", script: script.slice(0, 200) });
  }

  currentBroadcast = { newsId: "bot-speak", title: text.slice(0, 60), author: speakerAuthor, startedAt: Date.now() };

  try {
    const proxyResp = await fetch(`${GEMINI_PROXY_URL}/tts-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-proxy-key": GEMINI_PROXY_KEY },
      body: JSON.stringify({ text: script, author: speakerAuthor }),
    });

    if (!proxyResp.ok || !proxyResp.body) {
      currentBroadcast = null;
      return c.json({ error: "TTS proxy error" }, 500);
    }

    const reader = proxyResp.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        broadcastChunk(value);
        totalBytes += value.length;
      }
    }

    const duration = (totalBytes / 2) / SAMPLE_RATE;
    console.log(`[broadcast] Speak done: ${totalBytes} bytes (${duration.toFixed(1)}s) -> ${listeners.size} listeners`);
    totalBroadcasts++;
    currentBroadcast = null;

    return c.json({ ok: true, listeners: listeners.size, bytes: totalBytes, duration, script: script.slice(0, 200) });

  } catch (err) {
    console.error("[broadcast] Speak error:", err);
    currentBroadcast = null;
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});
// --- GET /status ---

app.get('/status', async (c) => {
  return c.json({
    success: true,
    mode: 'live-broadcast',
    listeners: listeners.size,
    listenerDetails: [...listeners.entries()].map(([id, l]) => ({
      id, connectedAt: new Date(l.connectedAt).toISOString(),
      uptime: Math.round((Date.now() - l.connectedAt) / 1000),
    })),
    currentBroadcast,
    queueLength: broadcastQueue.length,
    totalBroadcasts,
    model: 'gemini-3.1-flash-live-preview',
    sampleRate: SAMPLE_RATE,
  });
});

export default app;
