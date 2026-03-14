/**
 * CONTENT HEALTH MONITORING
 * Агрегированный мониторинг здоровья новостного pipeline и чартов
 * 
 * Endpoints:
 * - GET  /health          - полная сводка здоровья контента
 * - POST /telegram        - отправка произвольного алерта в Telegram
 * - POST /telegram-report - отправка форматированного отчёта в Telegram
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import { chartAggregationStore, chartSourcesStore, newsPipelineStore, newsPublicStore } from './db.tsx';

const contentHealth = new Hono();

// ── Types ────────────────────────────────────────────

interface SourceError {
  sourceId: string;
  sourceName: string;
  error: string;
  lastFetchAt: string;
}

interface NewsHealth {
  collectedToday: number;
  pending: number;
  published: number;
  rejected: number;
  total: number;
  lastPipelineRun: string | null;
  pipelineStale: boolean;
  pendingAlert: boolean;
  sourcesTotal: number;
  sourcesWithErrors: SourceError[];
  sourcesNeverFetched: string[];
}

interface ChartSourceHealth {
  sourceId: string;
  sourceName: string;
  tracksCount: number;
  fetchedAt: string | null;
  parsedBy: 'mistral' | 'fallback' | 'error' | null;
  status: 'ok' | 'stale' | 'error' | 'fallback' | 'empty';
  error?: string;
  ageHours: number | null;
}

interface ChartsHealth {
  lastAggregation: string | null;
  aggregationStale: boolean;
  sources: ChartSourceHealth[];
  totalTracksAcrossAll: number;
}

interface ContentHealthData {
  timestamp: string;
  news: NewsHealth;
  charts: ChartsHealth;
  alerts: AlertItem[];
}

interface AlertItem {
  level: 'critical' | 'warning' | 'info';
  category: 'news' | 'charts';
  message: string;
  detail?: string;
}

// ── Source IDs (mirror of ai-agent.ts & charts-routes.tsx configs) ──

const NEWS_SOURCE_IDS = [
  'intermedia', 'the-flow', 'tass-culture', 'fontanka-culture', 'rbc-style-music',
  'zvuki-ru', 'afisha-daily', 'colta-music', 'sadwave', 'rap-ru',
  'muzkarta', 'lenta-culture', 'kp-showbiz',
];

const CHART_SOURCE_CONFIGS = [
  { id: 'russkoe', name: 'Русское Радио' },
  { id: 'nashe', name: 'Наше Радио' },
  { id: 'maximum', name: 'Радио Maximum' },
  { id: 'dfm', name: 'DFM' },
  { id: 'europa', name: 'Europa Plus' },
  { id: 'yandex', name: 'Яндекс Музыка' },
  { id: 'vk', name: 'VK Музыка' },
];

// ── Helpers ──────────────────────────────────────────

function hoursAgo(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const diff = Date.now() - new Date(isoDate).getTime();
  return Math.round(diff / (1000 * 60 * 60) * 10) / 10;
}

function isToday(isoDate: string): boolean {
  const d = new Date(isoDate);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}

// ── Core health data collector (shared by /health and /telegram-report) ──

async function collectHealthData(): Promise<ContentHealthData> {
  const alerts: AlertItem[] = [];

  // ═══════════════ NEWS HEALTH ═══════════════

  const allNews = await newsPublicStore.getAll();
  let pending = 0, published = 0, rejected = 0, collectedToday = 0;

  for (const item of allNews) {
    const news = item as any;
    if (!news?.status) continue;
    if (news.status === 'pending') pending++;
    else if (news.status === 'published') published++;
    else if (news.status === 'rejected') rejected++;
    if (news.processedAt && isToday(news.processedAt)) {
      collectedToday++;
    }
  }

  const pipelineStats = await newsPipelineStore.get('news:pipeline:stats') as any;
  const lastPipelineRun = pipelineStats?.lastRunAt || null;
  const pipelineHoursAgo = hoursAgo(lastPipelineRun);
  const pipelineStale = pipelineHoursAgo === null || pipelineHoursAgo > 24;
  const pendingAlert = pending > 50;

  if (pipelineStale) {
    alerts.push({
      level: 'critical',
      category: 'news',
      message: 'Pipeline новостей не запускался более 24 часов',
      detail: lastPipelineRun
        ? `Последний запуск: ${Math.round(pipelineHoursAgo!)}ч назад`
        : 'Pipeline ещё не запускался',
    });
  }
  if (pendingAlert) {
    alerts.push({
      level: 'warning',
      category: 'news',
      message: `Накопилось ${pending} новостей на модерации`,
      detail: 'Рекомендуется обработать очередь',
    });
  }
  if (collectedToday === 0 && !pipelineStale) {
    alerts.push({
      level: 'warning',
      category: 'news',
      message: '0 новостей собрано сегодня',
      detail: 'Возможно, источники недоступны',
    });
  }

  const sourcesWithErrors: SourceError[] = [];
  const sourcesNeverFetched: string[] = [];

  for (const sourceId of NEWS_SOURCE_IDS) {
    const status = await newsPipelineStore.get(`news:pipeline:source:${sourceId}`) as any;
    if (!status) {
      sourcesNeverFetched.push(sourceId);
      continue;
    }
    if (status.lastFetchStatus === 'error') {
      sourcesWithErrors.push({
        sourceId: status.sourceId || sourceId,
        sourceName: status.sourceName || sourceId,
        error: status.lastError || 'Unknown error',
        lastFetchAt: status.lastFetchAt || '',
      });
    }
  }

  if (sourcesWithErrors.length > 0) {
    alerts.push({
      level: sourcesWithErrors.length >= 5 ? 'critical' : 'warning',
      category: 'news',
      message: `${sourcesWithErrors.length} источник(ов) с ошибками`,
      detail: sourcesWithErrors.map(s => s.sourceName).join(', '),
    });
  }

  const newsHealth: NewsHealth = {
    collectedToday,
    pending,
    published,
    rejected,
    total: allNews.length,
    lastPipelineRun,
    pipelineStale,
    pendingAlert,
    sourcesTotal: NEWS_SOURCE_IDS.length,
    sourcesWithErrors,
    sourcesNeverFetched,
  };

  // ═══════════════ CHARTS HEALTH ═══════════════

  const aggStatus = await chartAggregationStore.get('last') as any;
  const lastAggregation = aggStatus?.timestamp || null;
  const aggHoursAgo = hoursAgo(lastAggregation);
  const aggregationStale = aggHoursAgo === null || aggHoursAgo > (7 * 24);

  if (aggregationStale) {
    alerts.push({
      level: 'critical',
      category: 'charts',
      message: 'Чарты не обновлялись более 7 дней',
      detail: lastAggregation
        ? `Последняя агрегация: ${Math.round(aggHoursAgo! / 24)}д назад`
        : 'Чарты ещё не агрегировались',
    });
  }

  const chartSources: ChartSourceHealth[] = [];
  let totalTracksAcrossAll = 0;

  for (const cfg of CHART_SOURCE_CONFIGS) {
    const data = await chartSourcesStore.get(cfg.id) as any;

    if (!data) {
      chartSources.push({
        sourceId: cfg.id,
        sourceName: cfg.name,
        tracksCount: 0,
        fetchedAt: null,
        parsedBy: null,
        status: 'empty',
        ageHours: null,
      });
      continue;
    }

    const tracksCount = data.tracks?.length || 0;
    const fetchedAt = data.fetchedAt || null;
    const parsedBy = data.parsedBy || null;
    const ageH = hoursAgo(fetchedAt);
    totalTracksAcrossAll += tracksCount;

    let status: ChartSourceHealth['status'] = 'ok';
    if (tracksCount === 0) {
      status = 'error';
    } else if (data.error || parsedBy === 'error') {
      status = 'error';
    } else if (parsedBy === 'fallback') {
      status = 'fallback';
    } else if (ageH !== null && ageH > 7 * 24) {
      status = 'stale';
    }

    if (status === 'error') {
      alerts.push({
        level: 'warning',
        category: 'charts',
        message: `Чарт "${cfg.name}" - ошибка`,
        detail: data.error || `${tracksCount} треков, parsedBy: ${parsedBy}`,
      });
    } else if (status === 'fallback') {
      alerts.push({
        level: 'info',
        category: 'charts',
        message: `Чарт "${cfg.name}" - fallback (без Mistral)`,
        detail: `${tracksCount} треков`,
      });
    }

    chartSources.push({
      sourceId: cfg.id,
      sourceName: cfg.name,
      tracksCount,
      fetchedAt,
      parsedBy,
      status,
      error: data.error,
      ageHours: ageH,
    });
  }

  const chartsHealth: ChartsHealth = {
    lastAggregation,
    aggregationStale,
    sources: chartSources,
    totalTracksAcrossAll,
  };

  return {
    timestamp: new Date().toISOString(),
    news: newsHealth,
    charts: chartsHealth,
    alerts: alerts.sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2 };
      return order[a.level] - order[b.level];
    }),
  };
}

// ── Routes ───────────────────────────────────────────

/**
 * GET /health
 * Полная сводка здоровья контента
 */
contentHealth.get('/health', async (c) => {
  try {
    const data = await collectHealthData();
    return c.json({ success: true, data });
  } catch (error) {
    console.log(`[Content Health] Error: ${error}`);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

/**
 * POST /telegram
 * Отправка произвольного текстового алерта в Telegram
 * Body: { message: string }
 */
contentHealth.post('/telegram', async (c) => {
  try {
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    if (!telegramBotToken || !telegramChatId) {
      return c.json({
        success: false,
        error: 'TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID не настроены. Добавьте их в секреты Supabase.',
      }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const message = body.message as string;

    if (!message) {
      return c.json({ success: false, error: 'Поле message обязательно' }, 400);
    }

    const resp = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.log(`[Telegram Alert] API error: ${resp.status} ${errText}`);
      return c.json({ success: false, error: `Telegram API: ${resp.status}` }, 500);
    }

    const result = await resp.json();
    console.log(`[Telegram Alert] Sent successfully, message_id: ${result.result?.message_id}`);

    return c.json({ success: true, messageId: result.result?.message_id });
  } catch (error) {
    console.log(`[Telegram Alert] Error: ${error}`);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

/**
 * POST /telegram-report
 * Собирает данные здоровья и отправляет форматированный отчёт в Telegram
 */
contentHealth.post('/telegram-report', async (c) => {
  try {
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    if (!telegramBotToken || !telegramChatId) {
      return c.json({
        success: false,
        error: 'TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID не настроены',
      }, 400);
    }

    // Collect health data directly (no self-referencing HTTP call)
    const healthData = await collectHealthData();
    const { news, charts, alerts } = healthData;

    // Build Telegram message
    let msg = `<b>ПРОМО.МУЗЫКА - Здоровье контента</b>\n`;
    msg += `<i>${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</i>\n\n`;

    // News section
    msg += `<b>Новости</b>\n`;
    msg += `Сегодня собрано: ${news.collectedToday}\n`;
    msg += `На модерации: ${news.pending}${news.pendingAlert ? ' !!!' : ''}\n`;
    msg += `Опубликовано: ${news.published}\n`;
    msg += `Pipeline: ${news.pipelineStale ? 'УСТАРЕЛ' : 'актуален'}\n`;

    if (news.sourcesWithErrors.length > 0) {
      msg += `\n<b>Ошибки источников:</b>\n`;
      for (const src of news.sourcesWithErrors) {
        msg += `x ${src.sourceName} - ${src.error.slice(0, 50)}\n`;
      }
    }

    // Charts section
    msg += `\n<b>Чарты</b>\n`;
    msg += `Агрегация: ${charts.aggregationStale ? 'УСТАРЕЛА' : 'актуальна'}\n`;
    for (const src of charts.sources) {
      const icon = src.status === 'ok' ? '+' : src.status === 'fallback' ? '~' : src.status === 'stale' ? '?' : 'x';
      msg += `[${icon}] ${src.sourceName}: ${src.tracksCount} треков\n`;
    }

    // Alerts summary
    const criticals = alerts.filter(a => a.level === 'critical');
    const warnings = alerts.filter(a => a.level === 'warning');
    if (criticals.length > 0 || warnings.length > 0) {
      msg += `\n<b>Алерты: ${criticals.length} крит., ${warnings.length} предупр.</b>`;
    } else {
      msg += `\nАлертов нет`;
    }

    // Send to Telegram
    const resp = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return c.json({ success: false, error: `Telegram API: ${resp.status} ${errText}` }, 500);
    }

    const result = await resp.json();
    console.log(`[Telegram Report] Sent, message_id: ${result.result?.message_id}`);
    return c.json({ success: true, messageId: result.result?.message_id });
  } catch (error) {
    console.log(`[Telegram Report] Error: ${error}`);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

export default contentHealth;