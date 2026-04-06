#!/usr/bin/env node
/**
 * ПРОМО.МУЗЫКА — Голосовой помощник (Telegram Bot → Live FM Stream)
 *
 * Кидаешь текст в чат → бот озвучивает через Gemini 3.1 Flash Live →
 * аудио летит в лайв-эфир всем слушателям /server/api/broadcast/live.
 *
 * Вся тяжёлая работа (LLM + TTS + broadcast) — на бэкенде через /speak.
 * Бот — тонкий клиент, только Telegram polling + UI.
 *
 * Команды: /start, /author, /authors, /listeners, /status
 */

const BOT_TOKEN = process.env.VOICE_BOT_TOKEN || '';
const RAW_ALLOWED = process.env.VOICE_BOT_ALLOWED_CHATS || '';
const ALLOWED_CHATS = RAW_ALLOWED === 'ALL' ? []
  : (RAW_ALLOWED || process.env.TELEGRAM_LEAD_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const NEWS_CHANNEL_ID = process.env.TELEGRAM_NEWS_CHANNEL_ID || '-1001185230485';

if (!BOT_TOKEN) { console.error('[voice-bot] No TELEGRAM_BOT_TOKEN'); process.exit(1); }

const userAuthors = new Map();
let totalBroadcasts = 0;
const startedAt = Date.now();

const AUTHORS = {
  'DJ Den':  'Энергичный ведущий клубной культуры',
  'Сандра':  'Поп-музыкальный журналист',
  'Лиана':   'Аналитик индустрии',
  'Макс':    'Рок-ведущий',
  'Марк':    'Хип-хоп репортёр',
  'Пабло':   'Ведущий мировой музыки',
  'Нико':    'Классика и джаз',
  'РадКат':  'Технофутурист',
  'Стелла':  'Социальный комментатор',
};

// --- Telegram helpers ---

async function tg(method, body) {
  const r = await fetch(`${TG_API}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!d.ok) console.error(`[tg] ${method}:`, d.description);
  return d;
}
const send = (chatId, text, extra) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
const edit = (chatId, msgId, text) => tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML' });

// --- Backend /speak call ---

async function broadcastSpeak(text, author) {
  const r = await fetch(`${API_BASE}/server/api/broadcast/speak`, {
    method: 'POST',
    signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_KEY },
    body: JSON.stringify({ text, author }),
  });
  if (!r.ok) {
    const e = await r.text().catch(() => '');
    throw new Error(`${r.status}: ${e.slice(0, 100)}`);
  }
  return await r.json();
}

async function getStatus() {
  const r = await fetch(`${API_BASE}/server/api/broadcast/status`, { signal: AbortSignal.timeout(5000) });
  return await r.json();
}

// --- Message handler ---

async function handle(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const name = msg.from?.first_name || 'User';

  if (ALLOWED_CHATS.length > 0 && !ALLOWED_CHATS.includes(String(chatId))) {
    await send(chatId, 'Доступ ограничен.');
    return;
  }

  if (text === '/start') {
    const a = userAuthors.get(chatId) || 'DJ Den';
    await send(chatId,
      `Привет, ${name}!\nКинь текст — я озвучу в прямой эфир.\n\n` +
      `Ведущий: <b>${a}</b>\n\n/authors /listeners /status`
    );
    return;
  }

  if (text === '/authors') {
    const list = Object.entries(AUTHORS).map(([n, d]) => `<b>${n}</b> — ${d}`).join('\n');
    await send(chatId, `Ведущие:\n\n${list}\n\n/author Имя`);
    return;
  }

  if (text.startsWith('/author')) {
    const arg = text.replace(/^\/author\s*/, '').trim();
    if (!arg) {
      await send(chatId, `Ведущий: <b>${userAuthors.get(chatId) || 'DJ Den'}</b>`);
      return;
    }
    const match = Object.keys(AUTHORS).find(a =>
      a.toLowerCase() === arg.toLowerCase() || a.toLowerCase().startsWith(arg.toLowerCase())
    );
    if (match) {
      userAuthors.set(chatId, match);
      await send(chatId, `Ведущий: <b>${match}</b>`);
    } else {
      await send(chatId, `"${arg}" не найден. /authors`);
    }
    return;
  }

  if (text === '/listeners') {
    try {
      const s = await getStatus();
      await send(chatId,
        `В эфире: <b>${s.listeners || 0}</b>\n` +
        (s.currentBroadcast ? `Сейчас: ${s.currentBroadcast.author}` : 'Эфир свободен')
      );
    } catch { await send(chatId, 'Ошибка получения статуса.'); }
    return;
  }

  if (text === '/status') {
    const up = Math.round((Date.now() - startedAt) / 60000);
    try {
      const s = await getStatus();
      await send(chatId,
        `Бот: ${totalBroadcasts} озвучек, uptime ${up} мин\n` +
        `Эфир: ${s.totalBroadcasts || 0} бродкастов, ${s.listeners || 0} слушателей`
      );
    } catch { await send(chatId, `Озвучек: ${totalBroadcasts}, uptime: ${up} мин`); }
    return;
  }

  if (text.startsWith('/')) return;

  // --- Speak to broadcast ---
  if (text.length < 5) { await send(chatId, 'Минимум 5 символов.'); return; }

  const author = userAuthors.get(chatId) || 'DJ Den';
  const statusMsg = await send(chatId, `${author} готовит эфир...`);
  const mid = statusMsg?.result?.message_id;

  try {
    console.log(`[voice-bot] ${name}: "${text.slice(0, 50)}..." -> ${author}`);
    const result = await broadcastSpeak(text, author);
    totalBroadcasts++;

    const dur = result.duration ? `${result.duration.toFixed(1)}s` : '';
    const lc = result.listeners || 0;
    

    if (mid) {
      await edit(chatId, mid, `${author} в эфире ${dur}\nСлушателей: ${lc}`);
    }
    console.log(`[voice-bot] Done: ${dur}, ${lc} listeners`);

  } catch (err) {
    console.error(`[voice-bot] Error:`, err.message);
    if (mid) await edit(chatId, mid, `Ошибка: ${err.message}`);
  }
}

// --- Channel auto-voice (posts from @promofm channel) ---

async function handleChannelPost(post) {
  const chatId = String(post.chat?.id || '');
  // Only process posts from our news channel
  if (chatId !== NEWS_CHANNEL_ID) return;

  const text = (post.text || '').trim();
  if (!text || text.length < 30) return; // Skip short posts (buttons, links only)

  // Only voice Russian-language posts (>40% Cyrillic characters)
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) || []).length;
  const letters = (text.match(/[a-zA-ZЀ-ӿ]/g) || []).length;
  if (letters > 0 && cyrillic / letters < 0.4) {
    console.log(`[channel] Skipping non-Russian post: ${(cyrillic/letters*100).toFixed(0)}% cyrillic`);
    return;
  }

  // Extract clean text: remove emoji, hashtags at end, URLs
  let cleanText = text
    .replace(/https?:\/\/\S+/g, '')  // remove URLs
    .replace(/#\S+/g, '')              // remove hashtags
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '') // remove emoji
    .replace(/\u2014/g, '. ')  // em-dash to period+space
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleanText.length < 20) return;

  // Detect author from post (format: "\u270d\ufe0f AuthorName | Source")
  let author = 'DJ Den';
  const knownAuthors = Object.keys(AUTHORS);
  const authorLine = text.match(/\u270d\ufe0f\s*([^|\n]+)/);
  if (authorLine) {
    const name = authorLine[1].trim();
    const found = knownAuthors.find(a => name.includes(a));
    if (found) author = found;
  }

  // Limit text length for TTS
  if (cleanText.length > 2000) cleanText = cleanText.slice(0, 2000);

  console.log(`[channel] Auto-voice from @promofm: "${cleanText.slice(0, 60)}..." -> ${author}`);

  try {
    const result = await broadcastSpeak(cleanText, author);
    totalBroadcasts++;
    const dur = result.duration ? `${result.duration.toFixed(1)}s` : '?';
    console.log(`[channel] Voiced: ${dur}`);
  } catch (err) {
    console.error(`[channel] Voice error: ${err.message}`);
  }
}

// --- Polling ---

let offset = 0;

async function poll() {
  try {
    const r = await fetch(
      `${TG_API}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message","channel_post"]`,
      { signal: AbortSignal.timeout(35000) }
    );
    const d = await r.json();
    if (d.ok && d.result?.length) {
      for (const u of d.result) {
        offset = u.update_id + 1;
        if (u.message) handle(u.message).catch(e => console.error('[bot]', e));
        if (u.channel_post) handleChannelPost(u.channel_post).catch(e => console.error('[channel]', e));
      }
    }
  } catch (e) {
    if (e.name !== 'TimeoutError' && e.name !== 'AbortError') {
      console.error('[poll]', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function main() {
  const me = await tg('getMe', {});
  if (!me.ok) { console.error('[voice-bot] Bad token'); process.exit(1); }
  console.log(`[voice-bot] @${me.result.username} started`);
  console.log(`[voice-bot] API: ${API_BASE}`);
  console.log(`[voice-bot] Allowed: ${ALLOWED_CHATS.length ? ALLOWED_CHATS.join(', ') : 'ALL'}`);
  await tg('deleteWebhook', { drop_pending_updates: false });
  while (true) await poll();
}

main().catch(e => { console.error('[fatal]', e); process.exit(1); });
