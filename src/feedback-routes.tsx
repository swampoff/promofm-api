/**
 * FEEDBACK ROUTES — user feedback collection + admin management
 * POST /report — user submits feedback (bug, idea, ux_issue, question)
 * GET /reports — admin list with filters
 * PUT /reports/:id/resolve — mark resolved
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { classifyAndLog } from './error-classifier.ts';

const feedbackRoutes = new Hono();

// ─── POST /report ─────────────────────────────────────────────────────────────

feedbackRoutes.post('/report', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.message) {
      return c.json({ error: 'message is required' }, 400);
    }

    const {
      type = 'idea',
      message,
      page,
      userId,
      context: extraContext,
    } = body;

    // Store in feedback_reports
    const res = await pool.query(
      `INSERT INTO feedback_reports (type, message, page_url, user_id, context)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [type, message, page || null, userId || null, extraContext ? JSON.stringify(extraContext) : null]
    );

    const reportId = res.rows[0].id;

    // Also classify into memory_errors for the error system
    if (type === 'bug' || type === 'ux_issue' || type === 'inactive_ui') {
      await classifyAndLog(message, page, userId, { source: 'user_feedback', reportId }).catch(() => {});
    }

    // Store ideas in memory_creative
    if (type === 'idea') {
      await pool.query(
        `INSERT INTO memory_creative (category, title, content, source)
         VALUES ('user_idea', $1, $2, 'user_feedback')`,
        [message.slice(0, 100), JSON.stringify({ message, page, userId, reportId })]
      ).catch(() => {});
    }

    return c.json({
      id: reportId,
      message: 'Спасибо! Ваш вклад помогает платформе расти.',
      type,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── GET /reports ─────────────────────────────────────────────────────────────

feedbackRoutes.get('/reports', async (c) => {
  try {
    const type = c.req.query('type');
    const resolved = c.req.query('resolved');
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
    const offset = parseInt(c.req.query('offset') || '0');

    let sql = 'SELECT * FROM feedback_reports WHERE 1=1';
    const params: any[] = [];

    if (type) {
      params.push(type);
      sql += ` AND type = $${params.length}`;
    }
    if (resolved !== undefined) {
      params.push(resolved === 'true');
      sql += ` AND resolved = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
    params.push(offset);
    sql += ` OFFSET $${params.length}`;

    const res = await pool.query(sql, params);

    // Count total
    let countSql = 'SELECT COUNT(*) FROM feedback_reports WHERE 1=1';
    const countParams: any[] = [];
    if (type) { countParams.push(type); countSql += ` AND type = $${countParams.length}`; }
    if (resolved !== undefined) { countParams.push(resolved === 'true'); countSql += ` AND resolved = $${countParams.length}`; }
    const countRes = await pool.query(countSql, countParams);

    return c.json({
      data: res.rows,
      total: parseInt(countRes.rows[0].count),
      limit,
      offset,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── PUT /reports/:id/resolve ─────────────────────────────────────────────────

feedbackRoutes.put('/reports/:id/resolve', async (c) => {
  const id = c.req.param('id');
  try {
    const body = await c.req.json().catch(() => ({}));
    const res = await pool.query(
      `UPDATE feedback_reports SET resolved = true, resolution = $2, resolved_at = NOW()
       WHERE id = $1 RETURNING id, type, message`,
      [id, body.resolution || null]
    );

    if (!res.rows.length) return c.json({ error: 'Report not found' }, 404);

    // Also resolve related memory_errors
    await pool.query(
      `UPDATE memory_errors SET resolved = true WHERE message = $1 AND resolved = false`,
      [res.rows[0].message]
    ).catch(() => {});

    return c.json({ data: res.rows[0], resolved: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export { feedbackRoutes };
