/**
 * PROMO.AIR AI DJ — Живой эфир для заведений
 *
 * Gemini 3.1 Flash генерирует тексты ведущего:
 *   подводки к трекам, объявления времени, погода, анонсы,
 *   рекламные вставки, подкаст-сегменты.
 * ElevenLabs озвучивает (POST /generate-audio).
 *
 * Endpoints:
 *   POST /generate-script     — создать текст ведущего
 *   POST /generate-audio      — озвучить текст через ElevenLabs
 *   POST /generate-full       — текст + озвучка за один запрос
 *   GET  /scripts/:venueId    — история скриптов
 *   GET  /queue/:venueId      — очередь сегментов для плейера
 *   POST /settings            — настройки AI DJ (голос, стиль, частота)
 *   GET  /settings/:venueId   — текущие настройки
 */

import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';
import { callLLM } from './llm-router.tsx';
import { promoAirDjScriptsStore, promoAirDjSettingsStore, promoAirDjQueueStore } from './db.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

// ─── Stores ─────────────────────────────────────────────

const djScriptsStore = promoAirDjScriptsStore;
const djSettingsStore = promoAirDjSettingsStore;
const djQueueStore = promoAirDjQueueStore;

// ─── Constants ──────────────────────────────────────────

const GEMINI_MODEL = 'google/gemini-2.0-flash-001';

type SegmentType =
  | 'track_intro'      // подводка к треку
  | 'time_check'       // объявление времени
  | 'weather'          // погода
  | 'venue_announcement' // анонс заведения
  | 'ad_insert'        // рекламная вставка
  | 'podcast_segment'  // подкаст-фрагмент
  | 'greeting'         // приветствие
  | 'farewell'         // прощание
  | 'news_brief';      // короткие новости

interface DjSettings {
  venueId: string;
  voiceStyle: 'warm' | 'energetic' | 'calm' | 'professional';
  language: 'ru' | 'en';
  djName: string;
  enabledSegments: SegmentType[];
  trackIntroFrequency: number;   // каждые N треков
  timeCheckFrequency: number;    // каждые N минут
  weatherFrequency: number;      // каждые N минут
  customPrompt?: string;         // дополнительные инструкции
}

const DEFAULT_SETTINGS: Omit<DjSettings, 'venueId'> = {
  voiceStyle: 'warm',
  language: 'ru',
  djName: 'Промо FM',
  enabledSegments: ['track_intro', 'time_check', 'greeting'],
  trackIntroFrequency: 3,
  timeCheckFrequency: 30,
  weatherFrequency: 60,
};

// ─── System prompts по типам сегментов ──────────────────

function buildSystemPrompt(settings: DjSettings, venueName?: string): string {
  const styleMap: Record<string, string> = {
    warm: 'Говори тепло, дружелюбно, с лёгкой улыбкой в голосе. Как хороший знакомый.',
    energetic: 'Говори энергично и бодро, но без крика. Заряжай настроением.',
    calm: 'Говори спокойно и размеренно. Создавай атмосферу уюта.',
    professional: 'Говори чётко и уверенно, как на хорошем радио.',
  };

  return `Ты — ${settings.djName}, AI-ведущий на Промо FM.
${venueName ? `Сейчас ты ведёшь эфир в заведении «${venueName}».` : ''}
${styleMap[settings.voiceStyle] || styleMap.warm}

Правила:
- Пиши коротко: 1-3 предложения для подводок, до 5 для анонсов.
- Никакого пафоса, официоза или канцелярита. Живая разговорная речь.
- Не используй: «дорогие друзья», «уважаемые гости», «мы рады», «не пропустите», «погрузитесь».
- Не начинай с «А», «И», «Ну» каждый раз — варьируй.
- Используй разговорные обороты: «кстати», «между прочим», «а знаете что».
- Упоминай конкретику: название трека, артиста, время, день недели.
- Формат ответа: только текст для озвучки, без кавычек, скобок или пометок.
- Эфир ОДНОСТОРОННИЙ: НЕ задавай вопросы аудитории, НЕ предлагай что-то сделать прямо сейчас.
- Запрещены: «как вам», «как тебе», «как тебе такой вариант», «правда круто», «согласны?»,
  «что думаете», «пишите в чат», «звоните», «голосуйте», «дайте знать», «онлайн».
- «А знаете что» — допустимо только как риторический оборот без ожидания ответа.
${settings.customPrompt ? `\nДополнительно: ${settings.customPrompt}` : ''}`;
}

function buildUserPrompt(
  segmentType: SegmentType,
  context: Record<string, any>,
): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  const dayStr = now.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: 'Europe/Moscow' });

  switch (segmentType) {
    case 'track_intro':
      return `Подведи к треку: «${context.trackTitle}» от ${context.artistName}.${
        context.genre ? ` Жанр: ${context.genre}.` : ''
      }${context.nextTrack ? ` После него будет ${context.nextTrack}.` : ''} Время: ${timeStr}.`;

    case 'time_check':
      return `Объяви время. Сейчас ${timeStr}, ${dayStr}. Скажи что-нибудь уместное для этого времени суток.`;

    case 'weather':
      return `Расскажи о погоде.${context.city ? ` Город: ${context.city}.` : ''}${
        context.temperature ? ` Температура: ${context.temperature}°C.` : ''
      }${context.conditions ? ` Условия: ${context.conditions}.` : ''} Коротко, 1-2 предложения.`;

    case 'venue_announcement':
      return `Сделай анонс для заведения: ${context.announcement || 'сегодня отличное настроение и хорошая музыка'}. Коротко и естественно.`;

    case 'ad_insert':
      return `Рекламная вставка. Продукт/услуга: ${context.adText || context.product || 'Промо FM — музыка для бизнеса'}. Длительность: ${context.duration || 15} секунд. Читай как нативную рекомендацию, а не как объявление.`;

    case 'podcast_segment':
      return `Короткий подкаст-сегмент на тему: ${context.topic || 'музыкальные новости'}. 3-5 предложений. Интересно и по делу.`;

    case 'greeting':
      return `Поприветствуй слушателей. Время: ${timeStr}, ${dayStr}.${
        context.venueName ? ` Заведение: «${context.venueName}».` : ''
      } Тепло, коротко, без штампов.`;

    case 'farewell':
      return `Попрощайся со слушателями на сегодня. Время: ${timeStr}. Тепло и коротко.`;

    case 'news_brief':
      return `Короткая музыкальная новость.${context.newsText ? ` Основа: ${context.newsText}` : ' Придумай актуальную музыкальную новость.'} 2-3 предложения.`;

    default:
      return context.prompt || 'Скажи что-нибудь приятное слушателям.';
  }
}

// ─── POST /generate-script ──────────────────────────────

app.post('/generate-script', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const {
      venueId,
      venueName,
      segmentType = 'greeting',
      context = {},
    } = body;

    if (!venueId) {
      return c.json({ success: false, error: 'venueId is required' }, 400);
    }

    // Загружаем настройки
    const savedSettings = await djSettingsStore.get(venueId);
    const settings: DjSettings = {
      ...DEFAULT_SETTINGS,
      ...(savedSettings || {}),
      venueId,
    };

    const systemPrompt = buildSystemPrompt(settings, venueName);
    const userPrompt = buildUserPrompt(segmentType as SegmentType, { ...context, venueName });

    const llmResponse = await callLLM({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      model: GEMINI_MODEL,
      maxTokens: 300,
      temperature: 0.8,
      tag: 'promo-air-dj',
    });

    const script = {
      id: `dj-${crypto.randomUUID()}`,
      venueId,
      segmentType,
      text: llmResponse.text.trim(),
      generatedAt: new Date().toISOString(),
      model: llmResponse.model,
      latencyMs: llmResponse.latencyMs,
      audioUrl: null,
      status: 'text_ready',
    };

    // Сохраняем в историю
    const existing: any[] = (await djScriptsStore.get(venueId)) || [];
    existing.unshift(script);
    if (existing.length > 100) existing.length = 100; // keep last 100
    await djScriptsStore.set(venueId, existing);

    return c.json({ success: true, script });
  } catch (error: any) {
    console.error('[promo-air-dj] generate-script error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ─── POST /generate-audio ───────────────────────────────

app.post('/generate-audio', requireAuth, async (c) => {
  try {
    const { text, voiceType = 'neutral', style = 'professional' } = await c.req.json();

    if (!text) {
      return c.json({ success: false, error: 'text is required' }, 400);
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return c.json({ success: false, error: 'ElevenLabs API key not configured' }, 500);
    }

    const VOICE_IDS: Record<string, string> = {
      neutral: '21m00Tcm4TlvDq8ikWAM',
      professional: 'AZnzlk1XvdvUeBnXmlld',
      energetic: 'EXAVITQu4vr4xnSDxMaL',
      calm: 'ErXwobaYiN019PkySvjV',
      friendly: 'MF3mGyEYCl7XYWbV9V6O',
    };

    const STYLE_SETTINGS: Record<string, any> = {
      professional: { stability: 0.75, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
      energetic: { stability: 0.5, similarity_boost: 0.8, style: 0.7, use_speaker_boost: true },
      calm: { stability: 0.9, similarity_boost: 0.7, style: 0.3, use_speaker_boost: true },
      friendly: { stability: 0.65, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true },
    };

    const voiceId = VOICE_IDS[voiceType] || VOICE_IDS.neutral;
    const voiceSettings = STYLE_SETTINGS[style] || STYLE_SETTINGS.professional;

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: voiceSettings,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return c.json({ success: false, error: `ElevenLabs: ${response.status} ${errText.slice(0, 200)}` }, 500);
    }

    const audioData = await response.arrayBuffer();
    const fileName = `dj_${Date.now()}.mp3`;
    const filePath = `/opt/promofm-api/public/audio/dj/${fileName}`;

    // Сохраняем на диск
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, Buffer.from(audioData));

    const audioUrl = `/server/audio/dj/${fileName}`;

    return c.json({
      success: true,
      audioUrl,
      size: audioData.byteLength,
      fileName,
    });
  } catch (error: any) {
    console.error('[promo-air-dj] generate-audio error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ─── POST /generate-full ────────────────────────────────

app.post('/generate-full', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const {
      venueId,
      venueName,
      segmentType = 'greeting',
      context = {},
      voiceType = 'neutral',
      style = 'professional',
    } = body;

    if (!venueId) {
      return c.json({ success: false, error: 'venueId is required' }, 400);
    }

    // 1. Генерируем текст
    const savedSettings = await djSettingsStore.get(venueId);
    const settings: DjSettings = {
      ...DEFAULT_SETTINGS,
      ...(savedSettings || {}),
      venueId,
    };

    const systemPrompt = buildSystemPrompt(settings, venueName);
    const userPrompt = buildUserPrompt(segmentType as SegmentType, { ...context, venueName });

    const llmResponse = await callLLM({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      model: GEMINI_MODEL,
      maxTokens: 300,
      temperature: 0.8,
      tag: 'promo-air-dj',
    });

    const scriptText = llmResponse.text.trim();

    // 2. Озвучиваем (если есть ElevenLabs ключ)
    let audioUrl: string | null = null;
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (apiKey) {
      try {
        const VOICE_IDS: Record<string, string> = {
          neutral: '21m00Tcm4TlvDq8ikWAM',
          professional: 'AZnzlk1XvdvUeBnXmlld',
          energetic: 'EXAVITQu4vr4xnSDxMaL',
          calm: 'ErXwobaYiN019PkySvjV',
          friendly: 'MF3mGyEYCl7XYWbV9V6O',
        };

        const voiceId = VOICE_IDS[voiceType] || VOICE_IDS.neutral;

        const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
          },
          body: JSON.stringify({
            text: scriptText,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
              stability: 0.7,
              similarity_boost: 0.75,
              style: 0.5,
              use_speaker_boost: true,
            },
          }),
        });

        if (ttsResponse.ok) {
          const audioData = await ttsResponse.arrayBuffer();
          const fileName = `dj_${Date.now()}.mp3`;
          const filePath = `/opt/promofm-api/public/audio/dj/${fileName}`;

          const fs = await import('node:fs');
          const path = await import('node:path');
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(filePath, Buffer.from(audioData));
          audioUrl = `/server/audio/dj/${fileName}`;
        }
      } catch (ttsErr) {
        console.warn('[promo-air-dj] TTS failed, text-only:', ttsErr);
      }
    }

    // 3. Сохраняем
    const script = {
      id: `dj-${crypto.randomUUID()}`,
      venueId,
      segmentType,
      text: scriptText,
      audioUrl,
      generatedAt: new Date().toISOString(),
      model: llmResponse.model,
      latencyMs: llmResponse.latencyMs,
      status: audioUrl ? 'ready' : 'text_only',
    };

    const existing: any[] = (await djScriptsStore.get(venueId)) || [];
    existing.unshift(script);
    if (existing.length > 100) existing.length = 100;
    await djScriptsStore.set(venueId, existing);

    // Добавляем в очередь
    const queue: any[] = (await djQueueStore.get(venueId)) || [];
    queue.push({
      scriptId: script.id,
      segmentType,
      text: scriptText,
      audioUrl,
      scheduledAt: new Date().toISOString(),
      played: false,
    });
    if (queue.length > 50) queue.shift();
    await djQueueStore.set(venueId, queue);

    return c.json({ success: true, script });
  } catch (error: any) {
    console.error('[promo-air-dj] generate-full error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ─── GET /scripts/:venueId ──────────────────────────────

app.get('/scripts/:venueId', requireAuth, async (c) => {
  try {
    const venueId = c.req.param('venueId');
    const limit = parseInt(c.req.query('limit') || '20');
    const scripts: any[] = (await djScriptsStore.get(venueId)) || [];
    return c.json({ success: true, scripts: scripts.slice(0, limit) });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ─── GET /queue/:venueId ────────────────────────────────

app.get('/queue/:venueId', requireAuth, async (c) => {
  try {
    const venueId = c.req.param('venueId');
    const queue: any[] = (await djQueueStore.get(venueId)) || [];
    const pending = queue.filter((q: any) => !q.played);
    return c.json({ success: true, queue: pending });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ─── POST /settings ─────────────────────────────────────

app.post('/settings', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { venueId, ...settingsUpdate } = body;

    if (!venueId) {
      return c.json({ success: false, error: 'venueId is required' }, 400);
    }

    const existing = (await djSettingsStore.get(venueId)) || {};
    const updated = { ...DEFAULT_SETTINGS, ...existing, ...settingsUpdate, venueId };
    await djSettingsStore.set(venueId, updated);

    return c.json({ success: true, settings: updated });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ─── GET /settings/:venueId ─────────────────────────────

app.get('/settings/:venueId', requireAuth, async (c) => {
  try {
    const venueId = c.req.param('venueId');
    const settings = (await djSettingsStore.get(venueId)) || { ...DEFAULT_SETTINGS, venueId };
    return c.json({ success: true, settings });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
