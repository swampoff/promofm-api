/**
 * PROMO PIPELINE ROUTES — track promotion state machine
 * States: draft → strategy → content → trend_check → published → analytics → optimized
 * Each transition triggers an ecosystem agent via runAgent()
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { runAgent } from './ecosystem-modes.ts';

const promoPipelineRoutes = new Hono();

const STATES = ['draft', 'strategy', 'content', 'trend_check', 'published', 'analytics', 'optimized'] as const;
type PipelineState = typeof STATES[number];

const STATE_AGENTS: Record<string, string> = {
  'draft→strategy': 'promo_agent',
  'strategy→content': 'artist_assistant',
  'content→trend_check': 'community_agent',
  'trend_check→published': 'promo_agent',
  'published→analytics': 'product_optimizer',
  'analytics→optimized': 'improvement_agent',
};

// ─── POST /start — Create pipeline for a track ────────────────────────────────

promoPipelineRoutes.post('/start', async (c) => {
  try {
    const body = await c.req.json();
    const { trackId, genre, goal, artistId } = body;
    if (!trackId) return c.json({ error: 'trackId is required' }, 400);

    // Check if pipeline already exists
    const existing = await pool.query(
      `SELECT id, state FROM promo_pipelines WHERE track_id = $1 AND state != 'optimized'`,
      [trackId]
    );
    if (existing.rows.length) {
      return c.json({
        id: existing.rows[0].id,
        state: existing.rows[0].state,
        message: 'Pipeline already exists',
      });
    }

    const res = await pool.query(
      `INSERT INTO promo_pipelines (track_id, artist_id, genre, goal, state, history)
       VALUES ($1, $2, $3, $4, 'draft', $5) RETURNING id, state, created_at`,
      [trackId, artistId || null, genre || null, goal || null, JSON.stringify([{ state: 'draft', at: new Date().toISOString() }])]
    );

    return c.json({
      id: res.rows[0].id,
      state: 'draft',
      created_at: res.rows[0].created_at,
      next_state: 'strategy',
      message: 'Pipeline created. Call /advance to move to strategy phase.',
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── POST /advance/:id — Advance pipeline to next state ──────────────────────

promoPipelineRoutes.post('/advance/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const pipeline = await pool.query(`SELECT * FROM promo_pipelines WHERE id = $1`, [id]);
    if (!pipeline.rows.length) return c.json({ error: 'Pipeline not found' }, 404);

    const p = pipeline.rows[0];
    const currentIdx = STATES.indexOf(p.state as PipelineState);
    if (currentIdx === -1 || currentIdx >= STATES.length - 1) {
      return c.json({ state: p.state, message: 'Pipeline is already at final state' });
    }

    const nextState = STATES[currentIdx + 1];
    const transitionKey = `${p.state}→${nextState}`;
    const agentName = STATE_AGENTS[transitionKey];

    let agentResult = null;
    if (agentName) {
      try {
        agentResult = await runAgent(agentName, {
          trackId: p.track_id,
          genre: p.genre,
          goal: p.goal,
          currentState: p.state,
          nextState,
          previousResults: p.agent_results,
        });
      } catch (agentErr: any) {
        agentResult = { error: agentErr.message };
      }
    }

    // Update pipeline
    const history = Array.isArray(p.history) ? p.history : [];
    history.push({ state: nextState, at: new Date().toISOString(), agent: agentName });

    const agentResults = p.agent_results || {};
    if (agentResult) agentResults[transitionKey] = agentResult;

    await pool.query(
      `UPDATE promo_pipelines
       SET state = $1, history = $2, agent_results = $3, updated_at = NOW()
       WHERE id = $4`,
      [nextState, JSON.stringify(history), JSON.stringify(agentResults), id]
    );

    const hasNext = STATES.indexOf(nextState as PipelineState) < STATES.length - 1;

    return c.json({
      id,
      state: nextState,
      previous_state: p.state,
      agent: agentName,
      agent_result: agentResult,
      next_state: hasNext ? STATES[STATES.indexOf(nextState as PipelineState) + 1] : null,
      message: hasNext ? `Advanced to ${nextState}. Call /advance to continue.` : 'Pipeline complete!',
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── GET /status/:id — Get pipeline status ────────────────────────────────────

promoPipelineRoutes.get('/status/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const res = await pool.query(`SELECT * FROM promo_pipelines WHERE id = $1`, [id]);
    if (!res.rows.length) return c.json({ error: 'Pipeline not found' }, 404);

    const p = res.rows[0];
    const currentIdx = STATES.indexOf(p.state as PipelineState);

    return c.json({
      id: p.id,
      track_id: p.track_id,
      state: p.state,
      progress: `${currentIdx + 1}/${STATES.length}`,
      percent: Math.round(((currentIdx + 1) / STATES.length) * 100),
      history: p.history,
      agent_results: p.agent_results,
      created_at: p.created_at,
      updated_at: p.updated_at,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── GET /list — List all pipelines ───────────────────────────────────────────

promoPipelineRoutes.get('/list', async (c) => {
  try {
    const artistId = c.req.query('artist_id');
    const state = c.req.query('state');
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

    let sql = 'SELECT id, track_id, artist_id, state, genre, goal, created_at, updated_at FROM promo_pipelines WHERE 1=1';
    const params: any[] = [];

    if (artistId) { params.push(artistId); sql += ` AND artist_id = $${params.length}`; }
    if (state) { params.push(state); sql += ` AND state = $${params.length}`; }

    sql += ' ORDER BY updated_at DESC';
    params.push(limit);
    sql += ` LIMIT $${params.length}`;

    const res = await pool.query(sql, params);
    return c.json({ data: res.rows, count: res.rows.length });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export { promoPipelineRoutes };
