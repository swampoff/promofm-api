/**
 * MEMORY ROUTES — 6-layer agent memory API
 * POST /:layer/store, GET /:layer/search, GET /:layer/:key, GET /context, DELETE /short/expired
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { apiError } from './error-codes.tsx';
import { pool } from './db-client.tsx';

const memoryRoutes = new Hono();

const LAYERS = ['short', 'long', 'shared', 'user', 'errors', 'creative'] as const;
type Layer = typeof LAYERS[number];

const TABLE_MAP: Record<Layer, string> = {
  short: 'memory_short',
  long: 'memory_long',
  shared: 'memory_shared',
  user: 'memory_user',
  errors: 'memory_errors',
  creative: 'memory_creative',
};

function validLayer(layer: string): layer is Layer {
  return LAYERS.includes(layer as Layer);
}

// ─── POST /:layer/store ───────────────────────────────────────────────────────

memoryRoutes.post('/:layer/store', requireAuth, requireAdmin, async (c) => {
  const layer = c.req.param('layer');
  if (!validLayer(layer)) return apiError(c, 'VALIDATION_INVALID_LAYER', `Invalid layer: ${layer}`);

  const body = await c.req.json().catch(() => null);
  if (!body) return apiError(c, 'VALIDATION_INVALID_BODY');

  try {
    const table = TABLE_MAP[layer];

    if (layer === 'short') {
      const { key, value, namespace, agent_name, ttl_minutes } = body;
      if (!key || !value) return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'key and value required');
      const ttl = Math.max(1, Math.min(Math.floor(Number(ttl_minutes) || 60), 10080)); // 1 min to 7 days, integer only
      const res = await pool.query(
        `INSERT INTO ${table} (key, value, namespace, agent_name, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5)) RETURNING id`,
        [key, JSON.stringify(value), namespace || 'global', agent_name || null, ttl]
      );
      return c.json({ id: res.rows[0].id, layer, key });
    }

    if (layer === 'long') {
      const { key, value, namespace, importance } = body;
      if (!key || !value) return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'key and value required');
      const res = await pool.query(
        `INSERT INTO ${table} (key, value, namespace, importance)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key, namespace) DO UPDATE SET value = $2, importance = $4, last_accessed_at = NOW()
         RETURNING id`,
        [key, JSON.stringify(value), namespace || 'global', importance || 0.5]
      );
      return c.json({ id: res.rows[0].id, layer, key });
    }

    if (layer === 'shared') {
      const { key, value, owner_agent } = body;
      if (!key || !value) return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'key and value required');
      const res = await pool.query(
        `INSERT INTO ${table} (key, value, owner_agent)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, owner_agent = $3, updated_at = NOW()
         RETURNING id`,
        [key, JSON.stringify(value), owner_agent || null]
      );
      return c.json({ id: res.rows[0].id, layer, key });
    }

    if (layer === 'user') {
      const { user_id, preferences, interaction_style, promo_context } = body;
      if (!user_id) return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'user_id required');
      const res = await pool.query(
        `INSERT INTO ${table} (user_id, preferences, interaction_style, promo_context)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           preferences = COALESCE($2, memory_user.preferences),
           interaction_style = COALESCE($3, memory_user.interaction_style),
           promo_context = COALESCE($4, memory_user.promo_context),
           last_updated = NOW()
         RETURNING user_id`,
        [user_id, JSON.stringify(preferences || {}), JSON.stringify(interaction_style || {}), JSON.stringify(promo_context || {})]
      );
      return c.json({ user_id: res.rows[0].user_id, layer });
    }

    if (layer === 'errors') {
      const { error_type, message, context, user_id, endpoint, stack, severity, fix_suggestion } = body;
      if (!error_type || !message) return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'error_type and message required');
      const res = await pool.query(
        `INSERT INTO ${table} (error_type, message, context, user_id, endpoint, stack, severity, fix_suggestion)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [error_type, message, context ? JSON.stringify(context) : null, user_id || null, endpoint || null, stack || null, severity || 'medium', fix_suggestion || null]
      );
      return c.json({ id: res.rows[0].id, layer });
    }

    if (layer === 'creative') {
      const { category, title, content, source, quality_score } = body;
      if (!category || !content) return apiError(c, 'VALIDATION_REQUIRED_FIELDS', 'category and content required');
      const res = await pool.query(
        `INSERT INTO ${table} (category, title, content, source, quality_score)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [category, title || null, JSON.stringify(content), source || null, quality_score || 0.0]
      );
      return c.json({ id: res.rows[0].id, layer });
    }
  } catch (err: any) {
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// ─── GET /:layer/search ───────────────────────────────────────────────────────

memoryRoutes.get('/:layer/search', requireAuth, requireAdmin, async (c) => {
  const layer = c.req.param('layer');
  if (!validLayer(layer)) return apiError(c, 'VALIDATION_INVALID_LAYER', `Invalid layer: ${layer}`);

  const q = c.req.query('q') || '';
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const table = TABLE_MAP[layer];

  try {
    let res;
    if (layer === 'errors') {
      res = await pool.query(
        `SELECT * FROM ${table} WHERE message ILIKE $1 OR error_type ILIKE $1
         ORDER BY created_at DESC LIMIT $2`,
        [`%${q}%`, limit]
      );
    } else if (layer === 'user') {
      res = await pool.query(`SELECT * FROM ${table} LIMIT $1`, [limit]);
    } else if (layer === 'creative') {
      res = await pool.query(
        `SELECT * FROM ${table} WHERE title ILIKE $1 OR category ILIKE $1
         ORDER BY quality_score DESC, created_at DESC LIMIT $2`,
        [`%${q}%`, limit]
      );
    } else {
      // short, long, shared — search by key
      res = await pool.query(
        `SELECT * FROM ${table} WHERE key ILIKE $1 OR value::text ILIKE $1
         ORDER BY created_at DESC LIMIT $2`,
        [`%${q}%`, limit]
      );
    }
    return c.json({ data: res.rows, count: res.rows.length });
  } catch (err: any) {
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// ─── GET /:layer/:key ─────────────────────────────────────────────────────────

memoryRoutes.get('/:layer/:key', requireAuth, requireAdmin, async (c) => {
  const layer = c.req.param('layer');
  const key = c.req.param('key');
  if (!validLayer(layer)) return apiError(c, 'VALIDATION_INVALID_LAYER', `Invalid layer: ${layer}`);

  const table = TABLE_MAP[layer];

  try {
    let res;
    if (layer === 'user') {
      res = await pool.query(`SELECT * FROM ${table} WHERE user_id = $1`, [key]);
    } else if (layer === 'errors' || layer === 'creative') {
      res = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [key]);
    } else {
      res = await pool.query(`SELECT * FROM ${table} WHERE key = $1`, [key]);
      // Auto-increment access_count for long-term
      if (layer === 'long' && res.rows.length) {
        await pool.query(
          `UPDATE ${table} SET access_count = access_count + 1, last_accessed_at = NOW() WHERE key = $1`,
          [key]
        );
      }
    }
    return c.json({ data: res.rows[0] || null });
  } catch (err: any) {
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// ─── GET /context ─────────────────────────────────────────────────────────────

memoryRoutes.get('/context', requireAuth, requireAdmin, async (c) => {
  const agent = c.req.query('agent') || '';
  const task = c.req.query('task') || '';
  const userId = c.req.query('user_id');

  try {
    // Gather context from ALL layers in parallel
    const [longRes, errRes, creativeRes, sharedRes, userRes] = await Promise.all([
      // Long-term: relevant experience by key/namespace search
      pool.query(
        `SELECT key, value, importance FROM memory_long
         WHERE (key ILIKE $1 OR value::text ILIKE $1) AND importance > 0.3
         ORDER BY importance DESC, access_count DESC LIMIT 10`,
        [`%${task || agent}%`]
      ),
      // Errors: recent unresolved
      pool.query(
        `SELECT error_type, message, severity, fix_suggestion, created_at FROM memory_errors
         WHERE resolved = false ORDER BY created_at DESC LIMIT 10`
      ),
      // Creative: top patterns
      pool.query(
        `SELECT category, title, content, quality_score FROM memory_creative
         ORDER BY quality_score DESC, usage_count DESC LIMIT 5`
      ),
      // Shared: relevant cross-agent data
      pool.query(
        `SELECT key, value FROM memory_shared
         WHERE key ILIKE $1 OR value::text ILIKE $1 LIMIT 5`,
        [`%${task || agent}%`]
      ),
      // User: preferences if userId provided
      userId
        ? pool.query(`SELECT * FROM memory_user WHERE user_id = $1`, [userId])
        : Promise.resolve({ rows: [] }),
    ]);

    return c.json({
      agent,
      task,
      context: {
        experience: longRes.rows,
        errors: errRes.rows,
        creative: creativeRes.rows,
        shared: sharedRes.rows,
        user: userRes.rows[0] || null,
      },
    });
  } catch (err: any) {
    return apiError(c, 'INTERNAL_ERROR');
  }
});

// ─── DELETE /short/expired ────────────────────────────────────────────────────

memoryRoutes.delete('/short/expired', requireAuth, requireAdmin, async (c) => {
  try {
    const res = await pool.query(
      `DELETE FROM memory_short WHERE expires_at < NOW() RETURNING id`
    );
    return c.json({ deleted: res.rowCount });
  } catch (err: any) {
    return apiError(c, 'INTERNAL_ERROR');
  }
});

export { memoryRoutes };
