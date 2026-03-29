/**
 * PIPELINE API ROUTES
 *
 * Общие эндпоинты для:
 * 1. Аудит-лог — GET /pipeline/audit, /pipeline/audit/:itemId, /pipeline/timeline/:itemId
 * 2. SLA мониторинг — POST /pipeline/sla/check (batch)
 * 3. Аналитика — GET /pipeline/analytics, /pipeline/stats
 * 4. Состояние пайплайна — GET /pipeline/transitions, /pipeline/map/:pipelineType
 */

import { Hono } from 'npm:hono@4';
import {
  getAuditLog,
  getAuditForItem,
  getItemTimeline,
  computeAnalytics,
  computeGlobalStats,
  batchCheckSLA,
  getNextStatuses,
  getPipelineMap,
  statusLabel,
  isFinalStatus,
  CONTENT_TRANSITIONS,
  TRACK_TEST_TRANSITIONS,
  PITCHING_TRANSITIONS,
  MARKETING_TRANSITIONS,
  AUDIO_BRANDING_TRANSITIONS,
  PRODUCTION_360_TRANSITIONS,
} from './pipeline-engine.tsx';
import type { PipelineType } from './pipeline-engine.tsx';

const pipelineApi = new Hono();

// ============================================
// AUDIT LOG
// ============================================

/**
 * GET /pipeline/audit
 * Получить аудит-лог с фильтрами
 *
 * Query params:
 *   pipeline_type — content | track_test | pitching | marketing
 *   content_type — track | video | track_test | pitching | marketing
 *   actor_id — ID автора действия
 *   actor_role — admin | artist | expert | system
 *   action — конкретное действие
 *   item_id — фильтр по элементу
 *   from / to — ISO дата (диапазон)
 *   limit — кол-во записей (default 50)
 *   offset — смещение
 */
pipelineApi.get('/audit', (c) => {
  const filters = {
    pipeline_type: c.req.query('pipeline_type') as PipelineType | undefined,
    content_type: c.req.query('content_type'),
    actor_id: c.req.query('actor_id'),
    actor_role: c.req.query('actor_role') as any,
    action: c.req.query('action'),
    item_id: c.req.query('item_id'),
    from: c.req.query('from'),
    to: c.req.query('to'),
    limit: parseInt(c.req.query('limit') || '50'),
    offset: parseInt(c.req.query('offset') || '0'),
  };

  const result = getAuditLog(filters);

  return c.json({
    success: true,
    ...result,
    filters,
  });
});

/**
 * GET /pipeline/audit/:itemId
 * Получить аудит-лог для конкретного элемента (трек, клип, заявка)
 */
pipelineApi.get('/audit/:itemId', (c) => {
  const itemId = c.req.param('itemId');
  const entries = getAuditForItem(itemId);

  return c.json({
    success: true,
    item_id: itemId,
    entries,
    total: entries.length,
  });
});

/**
 * GET /pipeline/timeline/:itemId
 * Хронология переходов элемента с длительностью каждого шага
 */
pipelineApi.get('/timeline/:itemId', (c) => {
  const itemId = c.req.param('itemId');
  const timeline = getItemTimeline(itemId);

  return c.json({
    success: true,
    item_id: itemId,
    ...timeline,
  });
});

// ============================================
// ANALYTICS
// ============================================

/**
 * GET /pipeline/analytics
 * Аналитика пайплайна для всех типов контента
 */
pipelineApi.get('/analytics', (c) => {
  const contentType = c.req.query('content_type');

  if (contentType) {
    const analytics = computeAnalytics(contentType);
    return c.json({ success: true, content_type: contentType, ...analytics });
  }

  // Все типы контента
  const all = {
    track: computeAnalytics('track'),
    video: computeAnalytics('video'),
    track_test: computeAnalytics('track_test'),
    pitching: computeAnalytics('pitching'),
    marketing: computeAnalytics('marketing'),
    audio_branding: computeAnalytics('audio_branding'),
    production_360: computeAnalytics('production_360'),
  };

  const globalStats = computeGlobalStats();

  return c.json({ success: true, analytics: all, summary: globalStats });
});

/**
 * GET /pipeline/stats
 * Общая статистика по всем пайплайнам (быстрый endpoint для дашборда)
 */
pipelineApi.get('/stats', (c) => {
  return c.json({ success: true, ...computeGlobalStats() });
});

// ============================================
// STATE MACHINE — TRANSITIONS MAP
// ============================================

/**
 * GET /pipeline/transitions
 * Вернуть карту допустимых переходов для всех пайплайнов
 */
pipelineApi.get('/transitions', (c) => {
  return c.json({
    success: true,
    transitions: {
      content: CONTENT_TRANSITIONS,
      track_test: TRACK_TEST_TRANSITIONS,
      pitching: PITCHING_TRANSITIONS,
      marketing: MARKETING_TRANSITIONS,
      audio_branding: AUDIO_BRANDING_TRANSITIONS,
      production_360: PRODUCTION_360_TRANSITIONS,
    },
  });
});

/**
 * GET /pipeline/map/:pipelineType
 * Полная карта пайплайна с метаданными (labels, SLA, roles)
 */
pipelineApi.get('/map/:pipelineType', (c) => {
  const pipelineType = c.req.param('pipelineType') as PipelineType;
  const map = getPipelineMap(pipelineType);

  if (!map) {
    return c.json({ success: false, error: `Неизвестный тип пайплайна: "${pipelineType}"` }, 400);
  }

  return c.json({ success: true, pipeline_type: pipelineType, statuses: map });
});

/**
 * GET /pipeline/transitions/:pipelineType/:currentStatus
 * Следующие допустимые статусы
 */
pipelineApi.get('/transitions/:pipelineType/:currentStatus', (c) => {
  const pipelineType = c.req.param('pipelineType') as PipelineType;
  const currentStatus = c.req.param('currentStatus');

  const nextStatuses = getNextStatuses(pipelineType, currentStatus);

  return c.json({
    success: true,
    pipeline_type: pipelineType,
    current_status: currentStatus,
    current_label: statusLabel(currentStatus),
    next_statuses: nextStatuses.map(s => ({ status: s, label: statusLabel(s) })),
    is_final: isFinalStatus(pipelineType, currentStatus),
  });
});

// ============================================
// SLA MONITORING
// ============================================

/**
 * POST /pipeline/sla/check
 * Batch SLA проверка для списка элементов
 *
 * Body: { items: [{ pipeline_type, item_id, current_status, status_entered_at }] }
 */
pipelineApi.post('/sla/check', async (c) => {
  try {
    const body = await c.req.json();
    const { items } = body;

    if (!items || !Array.isArray(items)) {
      return c.json({ success: false, error: 'items array required' }, 400);
    }

    const { results, summary } = batchCheckSLA(items);

    return c.json({
      success: true,
      sla: results,
      summary,
    });
  } catch (error) {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export default pipelineApi;
