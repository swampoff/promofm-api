/**
 * AI DEPARTMENT ROUTES - автономная команда AI-агентов
 * Сессии, очередь задач, интеграция с DevLab
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
// agent_sessions — native cols since migration 081. agent_sessions_index
// DROPPED — derived list через indexed SELECT (см. listAgentSessionSummaries).
import {
  getAgentSession, listAgentSessionSummaries, insertAgentSession,
  appendAgentSessionFollowUp, deleteAgentSession,
  type AgentSessionRow,
} from './db.tsx';
import { pool } from './db-client.tsx';
import { callLLM, getLLMStatus } from './llm-router.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const agentsRoutes = new Hono();

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentMsg {
  agent: 'ARCH' | 'DEV' | 'SEC' | 'OPS' | 'QA';
  message: string;
  type: 'analysis' | 'suggestion' | 'concern' | 'question' | 'agreement';
  ts: string;
}

interface Decision {
  action: string;
  agent: string;
  priority: 'high' | 'medium' | 'low';
  applied?: boolean;
}

interface Session {
  id: string;
  title: string;
  task: string;
  messages: AgentMsg[];
  decisions: Decision[];
  status: 'active' | 'completed';
  createdAt: string;
  updatedAt: string;
  followUps?: AgentMsg[][];
}

interface QueueItem {
  id: string;
  task: string;
  priority: 'high' | 'normal' | 'low';
  addedAt: string;
  status: 'pending' | 'processing' | 'done';
  sessionId?: string;
}

// ─── Agents definition ──────────────────────────────���─────────────────────────

const AGENTS = [
  { id: 'ARCH', role: 'System Architect',  specialty: 'architecture, system design, scalability, API contracts, component structure', personality: 'analytical, precise, thinks in systems and abstractions' },
  { id: 'DEV',  role: 'Senior Developer',  specialty: 'React, TypeScript, Tailwind v4, Node.js API, PostgreSQL, code implementation', personality: 'pragmatic, loves clean code, hates unnecessary complexity, writes examples' },
  { id: 'SEC',  role: 'Security Engineer', specialty: 'auth flows, data exposure, API security, input validation, rate limiting', personality: 'paranoid in a good way, always finds edge cases and attack vectors' },
  { id: 'OPS',  role: 'DevOps Engineer',   specialty: 'CI/CD, performance, caching, monitoring, infrastructure, build optimization', personality: 'automation obsessed, uptime fanatic, thinks about scale' },
  { id: 'QA',   role: 'QA Lead',           specialty: 'testing strategies, UX edge cases, accessibility, error states, user flows', personality: 'skeptical, methodical, breaks things professionally, asks "what if"' },
];

const SYSTEM_PROMPT = `You simulate an expert IT department team for ПРОМО.МУЗЫКА — a music marketing ecosystem.

Tech stack: React + TypeScript, Tailwind CSS v4, React Router v7 (package: react-router), Motion (motion/react), PostgreSQL, JWT Auth, Node.js API, KV key-value store (no SQL), Hono web server.

Team agents:
${AGENTS.map(a => `- ${a.id} (${a.role}): ${a.specialty}. Personality: ${a.personality}`).join('\n')}

Given a task or question, simulate a realistic expert discussion. Each agent speaks from their unique specialty.

Return ONLY this exact JSON (no markdown, no explanation):
{
  "messages": [
    {"agent": "ARCH|DEV|SEC|OPS|QA", "message": "their response", "type": "analysis|suggestion|concern|question|agreement"}
  ],
  "decisions": [
    {"action": "concrete agreed action item", "agent": "who leads implementation", "priority": "high|medium|low"}
  ]
}

Rules:
- 6-12 messages total
- Each message: 2-4 sentences, specific and technical
- Agents naturally refer to each other, build on points or push back
- decisions: 1-4 concrete next steps the team converged on
- ARCH always opens or closes with system-level view
- DEV gives code-level insights
- SEC flags any security concerns (even minor ones)
- OPS thinks about deployment and performance implications
- QA questions edge cases and user scenarios`;

// ─── Helpers ───────────────────────────────────────────────────────────���──────

async function callAI(messages: { role: 'user' | 'assistant'; content: string }[]): Promise<{ messages: AgentMsg[]; decisions: Decision[] }> {
  const res = await callLLM({
    system: SYSTEM_PROMPT,
    messages: messages.map(m => ({ ...m, role: m.role as 'user' | 'assistant' })),
    // Capped to 1024 — see comment in ecosystem-modes.ts: OpenRouter free-tier
    // models reject 2048-token requests with 402 when balance is low.
    maxTokens: 1024,
    tag: 'agents-discuss',
  });

  const text = res.text.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
  let parsed: { messages?: any[]; decisions?: any[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else parsed = { messages: [], decisions: [] };
  }

  const ts = new Date().toISOString();
  return {
    messages: (parsed.messages || []).map(m => ({ ...m, ts })),
    decisions: parsed.decisions || [],
  };
}

// updateSessionIndex — REMOVED. Migration 081 DROP'нула agent_sessions_index.
// List теперь derived через listAgentSessionSummaries() (ORDER BY created_at DESC).

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /discuss - новая дискуссия агентов
agentsRoutes.post('/discuss', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const task: string = body.task?.trim();
    const devlabContext: string = body.devlabContext || '';

    if (!task) return c.json({ success: false, error: 'Task is required' }, 400);

    const fullTask = devlabContext
      ? `${task}\n\n[Current DevLab board context:\n${devlabContext}]`
      : task;

    const result = await callAI([{ role: 'user', content: fullTask }]);

    const id = `s-${crypto.randomUUID()}`;
    const title = task.slice(0, 80) + (task.length > 80 ? '...' : '');
    const now = new Date().toISOString();

    const session: Session = {
      id, title, task,
      messages: result.messages,
      decisions: result.decisions,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
      followUps: [],
    };

    // Native INSERT — derived index list builds itself через next SELECT.
    await insertAgentSession({
      id, title, task,
      status: session.status,
      messages: session.messages,
      decisions: session.decisions,
      followUps: session.followUps || [],
      createdAt: now,
      updatedAt: now,
    } as AgentSessionRow);

    return c.json({ success: true, session });
  } catch (error) {
    console.log('POST /discuss error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /sessions/:id/continue - продолжение дискуссии
agentsRoutes.post('/sessions/:id/continue', requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const followUp: string = body.message?.trim();

    if (!followUp) return c.json({ success: false, error: 'Message required' }, 400);

    const sessionRow = await getAgentSession(id);
    if (!sessionRow) return c.json({ success: false, error: 'Session not found' }, 404);
    const session = sessionRow as unknown as Session;

    // Build conversation history
    const history: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: session.task },
      { role: 'assistant', content: JSON.stringify({ messages: session.messages, decisions: session.decisions }) },
    ];
    for (const fu of (session.followUps || [])) {
      history.push({ role: 'assistant', content: JSON.stringify({ messages: fu, decisions: [] }) });
    }
    history.push({ role: 'user', content: followUp });

    const result = await callAI(history);

    // Atomic append через jsonb || concatenation. Race-free vs legacy
    // get→mutate→set паттерн — 2 concurrent /continue calls oba сохранятся.
    await appendAgentSessionFollowUp(id, result.messages, result.decisions);

    return c.json({ success: true, messages: result.messages, decisions: result.decisions });
  } catch (error) {
    console.log('POST /sessions/:id/continue error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /sessions - список сессий (derived через ORDER BY created_at DESC LIMIT)
agentsRoutes.get('/sessions', requireAuth, async (c) => {
  try {
    const sessions = await listAgentSessionSummaries(100);
    return c.json({ success: true, sessions });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /sessions/:id - конкретная сессия
agentsRoutes.get('/sessions/:id', requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const session = await getAgentSession(id);
    if (!session) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, session });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /sessions/:id - удалить сессию (single statement, no index sync).
agentsRoutes.delete('/sessions/:id', requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    await deleteAgentSession(id);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// Row mapper для agent_tasks → внешний API контракт (id строкой, camelCase).
function mapTaskRow(row: any): QueueItem {
  return {
    id: row.app_id,
    task: row.task,
    priority: row.priority,
    addedAt: row.added_at instanceof Date ? row.added_at.toISOString() : String(row.added_at),
    status: row.status,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
  };
}

// GET /queue - очередь задач
agentsRoutes.get('/queue', requireAuth, async (c) => {
  try {
    const r = await pool.query(
      `SELECT app_id, task, priority, status, session_id, added_at
         FROM agent_tasks
        ORDER BY added_at ASC
        LIMIT 50`
    );
    return c.json({ success: true, queue: r.rows.map(mapTaskRow) });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /queue - добавить задачу в очередь
agentsRoutes.post('/queue', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const task = body.task?.trim();
    if (!task) return c.json({ success: false, error: 'Task required' }, 400);

    const priority = body.priority || 'normal';
    const appId = `q-${crypto.randomUUID()}`;

    const r = await pool.query(
      `INSERT INTO agent_tasks (app_id, task, priority, status, added_at)
       VALUES ($1, $2, $3, 'pending', NOW())
       RETURNING app_id, task, priority, status, session_id, added_at`,
      [appId, task, priority]
    );
    return c.json({ success: true, item: mapTaskRow(r.rows[0]) });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /queue/process - обработать одну или все задачи из очереди
agentsRoutes.post('/queue/process', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const processAll: boolean = body.all ?? false;
    const devlabContext: string = body.devlabContext || '';

    const pendingRes = await pool.query(
      `SELECT app_id, task, priority, status, added_at
         FROM agent_tasks
        WHERE status = 'pending'
        ORDER BY added_at ASC
        ${processAll ? '' : 'LIMIT 1'}`
    );
    const pending = pendingRes.rows.map(mapTaskRow);
    if (pending.length === 0) return c.json({ success: true, processed: 0, sessions: [] });

    const processedSessions: Session[] = [];

    for (const item of pending) {
      try {
        await pool.query(
          `UPDATE agent_tasks SET status='processing', updated_at=NOW() WHERE app_id=$1`,
          [item.id]
        );

        const fullTask = devlabContext ? `${item.task}\n\n[DevLab context:\n${devlabContext}]` : item.task;
        const result = await callAI([{ role: 'user', content: fullTask }]);

        const id = `s-${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        const session: Session = {
          id, title: item.task.slice(0, 80),
          task: item.task, messages: result.messages, decisions: result.decisions,
          status: 'completed', createdAt: now, updatedAt: now, followUps: [],
        };

        await insertAgentSession({
          id, title: session.title, task: session.task,
          status: session.status,
          messages: session.messages,
          decisions: session.decisions,
          followUps: session.followUps || [],
          createdAt: now,
          updatedAt: now,
        } as AgentSessionRow);

        await pool.query(
          `UPDATE agent_tasks
              SET status='done', session_id=$2, completed_at=NOW(), updated_at=NOW()
            WHERE app_id=$1`,
          [item.id, id]
        );

        processedSessions.push(session);
      } catch (err) {
        console.log(`Queue item ${item.id} failed:`, err);
        await pool.query(
          `UPDATE agent_tasks SET status='pending', updated_at=NOW() WHERE app_id=$1`,
          [item.id]
        );
      }
    }

    return c.json({ success: true, processed: processedSessions.length, sessions: processedSessions });
  } catch (error) {
    console.log('POST /queue/process error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /queue/:id - удалить из очереди
agentsRoutes.delete('/queue/:id', requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    await pool.query(`DELETE FROM agent_tasks WHERE app_id=$1`, [id]);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default agentsRoutes;