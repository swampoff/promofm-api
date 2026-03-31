/**
 * PROMOTION ROUTES - SQL VERSION
 * Полная система продвижения с PostgreSQL и валидацией
 */

import { Hono } from 'hono';
import { getDbClient } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth } from './auth-middleware.tsx';

const promotion = new Hono();

// Supabase client - используем singleton
const getDbClientLegacy = () => {
  return getDbClient();
};

// ============================================
// VALIDATION HELPERS
// ============================================

const VALID_PITCH_TYPES = ['standard', 'premium_direct_to_editor'];
const VALID_STATUSES = ['draft', 'pending_payment', 'pending_review', 'in_progress', 'completed', 'rejected', 'cancelled'];
const VALID_PRODUCTION_TYPES = ['video_shooting', 'video_editing', 'cover_design', 'full_package'];
const VALID_MARKETING_TYPES = ['social_ads', 'influencer', 'email', 'content', 'full_package'];
const VALID_MEDIA_TYPES = ['press_release', 'interview', 'feature', 'podcast', 'full_pr'];
const VALID_EVENT_TYPES = ['concert', 'festival', 'club_show', 'online_event', 'tour'];
const VALID_EXPERIMENT_TYPES = ['ai_targeting', 'viral_challenge', 'nft_drop', 'meta_collab', 'custom'];

function validateRequired(fields: Record<string, any>, requiredFields: string[]) {
  const missing = requiredFields.filter(field => !fields[field]);
  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing required fields: ${missing.join(', ')}`
    };
  }
  return { valid: true };
}

function sanitizeString(str: string, maxLength: number = 1000): string {
  return str.trim().slice(0, maxLength);
}

function validateBudget(budget: number): boolean {
  return budget >= 0 && budget <= 10000000 && Number.isInteger(budget);
}

/**
 * Универсальная обработка ошибок БД с graceful degradation
 * Возвращает данные для пустого ответа с метаданными
 */
function getEmptyResponseWithMeta(tableName: string, error?: any) {
  if (error) {
    const errorMessage = error.message || '';
    const errorCode = error.code || '';
    
    const isTableNotFound = 
      errorMessage.includes('does not exist') ||
      errorMessage.includes('relation') ||
      errorMessage.includes(tableName) ||
      errorMessage.includes('schema cache') ||
      errorCode === '42P01' ||
      errorCode === 'PGRST204';
    
    // Логируем только если это НЕ ошибка "таблица не найдена"
    if (!isTableNotFound) {
      console.error(`Database query error for ${tableName}:`, errorMessage);
    }
    
    return {
      success: true,
      data: [],
      _meta: {
        tableExists: !isTableNotFound,
        needsSetup: isTableNotFound
      }
    };
  }
  
  return {
    success: true,
    data: [],
    _meta: {
      tableExists: false,
      needsSetup: true
    }
  };
}

// ============================================
// ПИТЧИНГ (Радио и Плейлисты)
// ============================================

/**
 * GET /promotion/pitching
 * Получить все питчинг-запросы текущего пользователя
 */
promotion.get('/pitching', requireAuth, async (c) => {
  try {
    const dbClient = getDbClient();
    
    const { data, error } = await dbClient
      .from('pitching_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return c.json(getEmptyResponseWithMeta('pitching_requests', error));
    }
    
    return c.json({ 
      success: true, 
      requests: data || [],
      _meta: { 
        tableExists: true, 
        needsSetup: false,
        storage: 'sql' 
      }
    });
  } catch (error) {
    console.error('Pitching list error:', error);
    return c.json({ 
      success: true, 
      requests: [],
      _meta: { 
        tableExists: false, 
        needsSetup: true,
        storage: 'sql' 
      }
    });
  }
});

/**
 * POST /promotion/pitching
 * Создать новую заявку на питчинг
 */
promotion.post('/pitching', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { track_title, pitch_type, target_channels, message, total_price } = body;

    // Валидация
    if (!track_title || !pitch_type) {
      return c.json({ 
        success: false, 
        error: 'track_title and pitch_type are required' 
      }, 400);
    }

    if (!VALID_PITCH_TYPES.includes(pitch_type)) {
      return c.json({ 
        success: false, 
        error: `Invalid pitch_type. Must be one of: ${VALID_PITCH_TYPES.join(', ')}` 
      }, 400);
    }

    const dbClient = getDbClient();
    const requestId = `pitch-${crypto.randomUUID()}`;
    const userId = c.get('userId');

    const requestData = {
      id: requestId,
      artist_id: userId,
      track_id: body.track_id || requestId,
      track_title: sanitizeString(track_title, 200),
      pitch_type,
      target_channels: target_channels || [],
      message: message ? sanitizeString(message, 2000) : '',
      budget: total_price || 0,
      status: 'pending_payment',
      responses_count: 0,
      interested_count: 0,
      added_to_rotation_count: 0,
    };

    // Сохраняем в SQL таблицу
    const { data, error } = await dbClient
      .from('pitching_requests')
      .insert(requestData)
      .select()
      .single();

    if (error) {
      console.error('Pitching creation error:', error);
      return c.json({ 
        success: false, 
        error: safeErrorMessage(error) || 'Failed to create pitching request' 
      }, 500);
    }

    return c.json({ success: true, data });
  } catch (error) {
    console.error('Pitching creation error:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Internal server error' 
    }, 500);
  }
});

/**
 * POST /promotion/pitching/submit
 * Отправить трек на питчинг с валидацией (старый маршрут для совместимости)
 */
promotion.post('/pitching/submit', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { artist_id, track_id, track_title, pitch_type, target_channels, message, budget } = body;

    // 1. Валидация обязательных полей
    const validation = validateRequired(body, ['artist_id', 'track_id', 'track_title', 'pitch_type']);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    // 2. Валидация типа питчинга
    if (!VALID_PITCH_TYPES.includes(pitch_type)) {
      return c.json({ 
        success: false, 
        error: `Invalid pitch_type. Must be one of: ${VALID_PITCH_TYPES.join(', ')}` 
      }, 400);
    }

    // 3. Валидация длины строк
    if (track_title.length > 200) {
      return c.json({ success: false, error: 'track_title too long (max 200 chars)' }, 400);
    }

    if (message && message.length > 2000) {
      return c.json({ success: false, error: 'message too long (max 2000 chars)' }, 400);
    }

    // 4. Валидация бюджета
    if (budget && !validateBudget(budget)) {
      return c.json({ success: false, error: 'Invalid budget (must be 0-10000000)' }, 400);
    }

    // 5. Rate limiting - проверяем количество заявок за последние 24 часа
    const dbClient = getDbClient();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const { data: recentRequests, error: countError } = await dbClient
      .from('pitching_requests')
      .select('id')
      .eq('artist_id', artist_id)
      .gte('created_at', yesterday);

    if (countError) {
      console.error('Rate limit check error:', countError);
    } else if (recentRequests && recentRequests.length >= 20) {
      return c.json({ 
        success: false, 
        error: 'Rate limit exceeded. Maximum 20 requests per 24 hours.' 
      }, 429);
    }

    // 6. Санитизация данных
    const sanitizedTitle = sanitizeString(track_title, 200);
    const sanitizedMessage = message ? sanitizeString(message, 2000) : '';

    // 7. Создаём заявку в БД
    const requestId = `pitch-${crypto.randomUUID()}`;
    
    const { data, error } = await dbClient
      .from('pitching_requests')
      .insert({
        id: requestId,
        artist_id,
        track_id,
        track_title: sanitizedTitle,
        pitch_type,
        target_channels: target_channels || [],
        message: sanitizedMessage,
        budget: budget || 0,
        status: 'draft', // Сначала draft, потом оплата переведёт в pending_review
        responses_count: 0,
        interested_count: 0,
        added_to_rotation_count: 0,
      })
      .select()
      .single();

    if (error) {
      console.error('Database insert error:', error);
      return c.json({ success: false, error: 'Failed to create pitching request' }, 500);
    }

    return c.json({ success: true, data });
  } catch (error) {
    console.error('Pitching submit error:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Internal server error' 
    }, 500);
  }
});

/**
 * GET /promotion/pitching/:artistId
 * Получить все питчинг-запросы артиста с пагинацией
 */
promotion.get('/pitching/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const status = c.req.query('status');
  
  try {
    const dbClient = getDbClient();
    const offset = (page - 1) * limit;

    // Строим запрос
    let query = dbClient
      .from('pitching_requests')
      .select('*', { count: 'exact' })
      .eq('artist_id', artistId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Фильтр по статусу (если указан)
    if (status && VALID_STATUSES.includes(status)) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;

    if (error) {
      return c.json(getEmptyResponseWithMeta('pitching_requests', error));
    }

    const totalPages = count ? Math.ceil(count / limit) : 0;

    return c.json({ 
      success: true, 
      data: data || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      _meta: {
        tableExists: true,
        needsSetup: false
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Pitching list error:', errorMessage);
    
    // ВСЕГДА возвращаем успешный ответ с пустым массивом
    console.log('Returning empty array due to exception');
    return c.json({ 
      success: true, 
      data: [],
      pagination: {
        page: 1,
        limit,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
      _meta: {
        tableExists: false,
        needsSetup: true
      }
    });
  }
});

/**
 * POST /promotion/pitching/:requestId/response
 * Редактор отвечает на питчинг
 */
promotion.post('/pitching/:requestId/response', requireAuth, async (c) => {
  const requestId = c.req.param('requestId');
  
  try {
    const body = await c.req.json();
    const { editor_id, editor_name, editor_type, response_type, notes } = body;

    // Валидация
    const validation = validateRequired(body, ['editor_id', 'editor_name', 'response_type']);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    const validResponseTypes = ['interested', 'not_interested', 'added_to_rotation', 'need_more_info'];
    if (!validResponseTypes.includes(response_type)) {
      return c.json({ success: false, error: 'Invalid response_type' }, 400);
    }

    const dbClient = getDbClient();

    // 1. Создаём ответ редактора
    const responseId = `resp-${crypto.randomUUID()}`;
    
    const { error: insertError } = await dbClient
      .from('editor_responses')
      .insert({
        id: responseId,
        pitching_request_id: requestId,
        editor_id,
        editor_name: sanitizeString(editor_name, 100),
        editor_type: editor_type || 'radio',
        response_type,
        notes: notes ? sanitizeString(notes, 1000) : '',
      });

    if (insertError) {
      console.error('Response insert error:', insertError);
      return c.json({ success: false, error: 'Failed to save response' }, 500);
    }

    // 2. Обновляем счётчики в запросе
    const { data: request } = await dbClient
      .from('pitching_requests')
      .select('responses_count, interested_count, added_to_rotation_count')
      .eq('id', requestId)
      .single();

    if (request) {
      const updates: any = {
        responses_count: (request.responses_count || 0) + 1,
        updated_at: new Date().toISOString(),
      };

      if (response_type === 'interested') {
        updates.interested_count = (request.interested_count || 0) + 1;
      }
      if (response_type === 'added_to_rotation') {
        updates.added_to_rotation_count = (request.added_to_rotation_count || 0) + 1;
        updates.status = 'completed'; // Если добавлено в ротацию - успех!
      }

      await dbClient
        .from('pitching_requests')
        .update(updates)
        .eq('id', requestId);
    }

    return c.json({ success: true, message: 'Response saved successfully' });
  } catch (error) {
    console.error('Response submit error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /promotion/pitching/:requestId/responses
 * Получить все ответы редакторов по заявке
 */
promotion.get('/pitching/:requestId/responses', requireAuth, async (c) => {
  const requestId = c.req.param('requestId');
  
  try {
    const dbClient = getDbClient();
    
    const { data, error } = await dbClient
      .from('editor_responses')
      .select('*')
      .eq('pitching_request_id', requestId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Responses query error:', error);
      return c.json({ success: false, error: 'Failed to load responses' }, 500);
    }

    return c.json({ success: true, responses: data || [] });
  } catch (error) {
    console.error('Responses list error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PATCH /promotion/pitching/:requestId/status
 * Обновить статус заявки (после оплаты)
 */
promotion.patch('/pitching/:requestId/status', requireAuth, async (c) => {
  const requestId = c.req.param('requestId');
  
  try {
    const body = await c.req.json();
    const { status } = body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return c.json({ success: false, error: 'Invalid status' }, 400);
    }

    const dbClient = getDbClient();
    
    const { data, error } = await dbClient
      .from('pitching_requests')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .select()
      .single();

    if (error) {
      console.error('Status update error:', error);
      return c.json({ success: false, error: 'Failed to update status' }, 500);
    }

    return c.json({ success: true, data });
  } catch (error) {
    console.error('Status patch error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================
// 360° PRODUCTION (Видео, дизайн, контент)
// ============================================

promotion.post('/production360/submit', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { artist_id, service_type, project_title, description, budget, deadline } = body;

    // Валидация
    const validation = validateRequired(body, ['artist_id', 'service_type', 'project_title']);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    if (!VALID_PRODUCTION_TYPES.includes(service_type)) {
      return c.json({ success: false, error: 'Invalid service_type' }, 400);
    }

    const dbClient = getDbClient();
    const requestId = `prod-${crypto.randomUUID()}`;

    const { data, error } = await dbClient
      .from('production_360_requests')
      .insert({
        id: requestId,
        artist_id,
        service_type,
        project_title: sanitizeString(project_title, 200),
        description: description ? sanitizeString(description, 2000) : '',
        budget: budget || 0,
        deadline: deadline || null,
        status: 'draft',
        progress: 0,
      })
      .select()
      .single();

    if (error) throw error;

    return c.json({ success: true, data });
  } catch (error) {
    console.error('Production360 submit error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

promotion.get('/production360/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  
  try {
    const dbClient = getDbClient();
    const offset = (page - 1) * limit;

    const { data, error, count } = await dbClient
      .from('production_360_requests')
      .select('*', { count: 'exact' })
      .eq('artist_id', artistId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return c.json(getEmptyResponseWithMeta('production_360_requests', error));
    }

    return c.json({ 
      success: true, 
      data: data || [],
      pagination: {
        page,
        total: count || 0,
        totalPages: count ? Math.ceil(count / limit) : 0,
      },
      _meta: {
        tableExists: true,
        needsSetup: false
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Production360 list error:', errorMessage);
    
    console.log('Returning empty array due to exception');
    return c.json({ 
      success: true, 
      data: [],
      pagination: {
        page: 1,
        total: 0,
        totalPages: 0,
      },
      _meta: {
        tableExists: false,
        needsSetup: true
      }
    });
  }
});

// ============================================
// MARKETING CAMPAIGNS (Маркетинг)
// ============================================

promotion.post('/marketing/submit', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { artist_id, campaign_name, campaign_type, budget, duration_days, platforms, target_audience } = body;

    const validation = validateRequired(body, ['artist_id', 'campaign_name', 'campaign_type', 'budget']);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    if (!VALID_MARKETING_TYPES.includes(campaign_type)) {
      return c.json({ success: false, error: 'Invalid campaign_type' }, 400);
    }

    const dbClient = getDbClient();
    const campaignId = `mkt-${crypto.randomUUID()}`;

    const { data, error } = await dbClient
      .from('marketing_campaigns')
      .insert({
        id: campaignId,
        artist_id,
        campaign_name: sanitizeString(campaign_name, 200),
        campaign_type,
        budget,
        duration_days: duration_days || 30,
        platforms: platforms || [],
        target_audience: target_audience || {},
        status: 'draft',
        metrics: {},
        roi: 0,
      })
      .select()
      .single();

    if (error) throw error;

    return c.json({ success: true, data });
  } catch (error) {
    console.error('Marketing submit error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

promotion.get('/marketing/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  
  try {
    const dbClient = getDbClient();

    const { data, error } = await dbClient
      .from('marketing_campaigns')
      .select('*')
      .eq('artist_id', artistId)
      .order('created_at', { ascending: false });

    if (error) {
      console.log(`[Marketing] Table check error for artist ${artistId}:`, error.message);
      return c.json(getEmptyResponseWithMeta('marketing_campaigns', error));
    }

    return c.json({ 
      success: true, 
      data: data || [],
      _meta: {
        tableExists: true,
        needsSetup: false
      }
    });
  } catch (error) {
    console.error('Marketing list error:', error);
    return c.json(getEmptyResponseWithMeta('marketing_campaigns', error));
  }
});

// ============================================
// MEDIA OUTREACH (PR и СМИ)
// ============================================

promotion.post('/media/submit', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { artist_id, outreach_type, topic, angle, target_media, budget } = body;

    const validation = validateRequired(body, ['artist_id', 'outreach_type', 'topic']);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    if (!VALID_MEDIA_TYPES.includes(outreach_type)) {
      return c.json({ success: false, error: 'Invalid outreach_type' }, 400);
    }

    const dbClient = getDbClient();
    const requestId = `media-${crypto.randomUUID()}`;

    const { data, error } = await dbClient
      .from('media_outreach_requests')
      .insert({
        id: requestId,
        artist_id,
        outreach_type,
        topic: sanitizeString(topic, 200),
        angle: angle ? sanitizeString(angle, 500) : '',
        target_media: target_media || [],
        budget: budget || 0,
        status: 'draft',
        publications: [],
        reach_total: 0,
      })
      .select()
      .single();

    if (error) throw error;

    return c.json({ success: true, data });
  } catch (error) {
    console.error('Media submit error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

promotion.get('/media/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  
  try {
    const dbClient = getDbClient();

    const { data, error } = await dbClient
      .from('media_outreach_requests')
      .select('*')
      .eq('artist_id', artistId)
      .order('created_at', { ascending: false });

    if (error) {
      return c.json(getEmptyResponseWithMeta('media_outreach_requests', error));
    }

    return c.json({ 
      success: true, 
      data: data || [],
      _meta: {
        tableExists: true,
        needsSetup: false
      }
    });
  } catch (error) {
    console.error('Media list error:', error);
    return c.json(getEmptyResponseWithMeta('media_outreach_requests', error));
  }
});

// ============================================
// EVENTS (Концерты и события)
// ============================================

promotion.post('/event/submit', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { artist_id, event_type, event_name, city, venue, event_date, budget } = body;

    const validation = validateRequired(body, ['artist_id', 'event_type', 'event_name']);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    if (!VALID_EVENT_TYPES.includes(event_type)) {
      return c.json({ success: false, error: 'Invalid event_type' }, 400);
    }

    const dbClient = getDbClient();
    const eventId = `event-${crypto.randomUUID()}`;

    const { data, error } = await dbClient
      .from('event_requests')
      .insert({
        id: eventId,
        artist_id,
        event_type,
        event_name: sanitizeString(event_name, 200),
        city: city ? sanitizeString(city, 100) : null,
        venue: venue ? sanitizeString(venue, 200) : null,
        event_date: event_date || null,
        budget: budget || 0,
        status: 'planning',
        tickets_sold: 0,
        revenue: 0,
        team: {},
      })
      .select()
      .single();

    if (error) throw error;

    return c.json({ success: true, data });
  } catch (error) {
    console.error('Event submit error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

promotion.get('/event/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  
  try {
    const dbClient = getDbClient();

    const { data, error } = await dbClient
      .from('event_requests')
      .select('*')
      .eq('artist_id', artistId)
      .order('event_date', { ascending: true });

    if (error) {
      return c.json(getEmptyResponseWithMeta('event_requests', error));
    }

    return c.json({ 
      success: true, 
      data: data || [],
      _meta: {
        tableExists: true,
        needsSetup: false
      }
    });
  } catch (error) {
    console.error('Event list error:', error);
    return c.json(getEmptyResponseWithMeta('event_requests', error));
  }
});

// ============================================
// PROMO LAB (Экспериментальное продвижение)
// ============================================

promotion.post('/promolab/submit', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { artist_id, experiment_name, experiment_type, hypothesis, description, budget, duration_days } = body;

    const validation = validateRequired(body, ['artist_id', 'experiment_name', 'experiment_type', 'hypothesis']);
    if (!validation.valid) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    if (!VALID_EXPERIMENT_TYPES.includes(experiment_type)) {
      return c.json({ success: false, error: 'Invalid experiment_type' }, 400);
    }

    const dbClient = getDbClient();
    const experimentId = `lab-${crypto.randomUUID()}`;

    const { data, error } = await dbClient
      .from('promo_lab_experiments')
      .insert({
        id: experimentId,
        artist_id,
        experiment_name: sanitizeString(experiment_name, 200),
        experiment_type,
        hypothesis: sanitizeString(hypothesis, 500),
        description: description ? sanitizeString(description, 2000) : '',
        budget: budget || 0,
        duration_days: duration_days || 14,
        status: 'draft',
        metrics: {},
        results: {},
        learning: '',
      })
      .select()
      .single();

    if (error) throw error;

    return c.json({ success: true, data });
  } catch (error) {
    console.error('PromoLab submit error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

promotion.get('/promolab/:artistId', requireAuth, async (c) => {
  const artistId = c.req.param('artistId');
  
  try {
    const dbClient = getDbClient();

    const { data, error } = await dbClient
      .from('promo_lab_experiments')
      .select('*')
      .eq('artist_id', artistId)
      .order('created_at', { ascending: false});

    if (error) {
      return c.json(getEmptyResponseWithMeta('promo_lab_experiments', error));
    }

    return c.json({ 
      success: true, 
      data: data || [],
      _meta: {
        tableExists: true,
        needsSetup: false
      }
    });
  } catch (error) {
    console.error('PromoLab list error:', error);
    return c.json(getEmptyResponseWithMeta('promo_lab_experiments', error));
  }
});

export default promotion;