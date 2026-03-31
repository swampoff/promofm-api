/**
 * AI DEPARTMENT ROUTES - автономная команда AI-агентов
 * Сессии, очередь задач, интеграция с DevLab
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import { agentQueueStore, agentSessionsIndexStore, agentSessionsStore } from './db.tsx';
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
    maxTokens: 2048,
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

async function updateSessionIndex(id: string, title: string, createdAt: string) {
  const idx: { id: string; title: string; createdAt: string }[] = (await agentSessionsIndexStore.get('singleton') as any) || [];
  const existing = idx.findIndex(s => s.id === id);
  if (existing !== -1) idx[existing] = { id, title, createdAt };
  else idx.unshift({ id, title, createdAt });
  await agentSessionsIndexStore.set('singleton', idx.slice(0, 100)); // keep last 100
}

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

    await agentSessionsStore.set(id, session);
    await updateSessionIndex(id, title, now);

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

    const session = await agentSessionsStore.get(id) as Session | null;
    if (!session) return c.json({ success: false, error: 'Session not found' }, 404);

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

    const updated: Session = {
      ...session,
      followUps: [...(session.followUps || []), result.messages],
      decisions: [...session.decisions, ...result.decisions],
      updatedAt: new Date().toISOString(),
    };

    await agentSessionsStore.set(id, updated);

    return c.json({ success: true, messages: result.messages, decisions: result.decisions });
  } catch (error) {
    console.log('POST /sessions/:id/continue error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /sessions - список сессий
agentsRoutes.get('/sessions', requireAuth, async (c) => {
  try {
    const idx = (await agentSessionsIndexStore.get('singleton') as any) || [];
    return c.json({ success: true, sessions: idx });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /sessions/:id - конкретная сессия
agentsRoutes.get('/sessions/:id', requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const session = await agentSessionsStore.get(id);
    if (!session) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, session });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /sessions/:id - удалить сессию
agentsRoutes.delete('/sessions/:id', requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    await agentSessionsStore.del(id);
    const idx: any[] = (await agentSessionsIndexStore.get('singleton') as any) || [];
    await agentSessionsIndexStore.set('singleton', idx.filter((s: any) => s.id !== id));
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /queue - очередь задач
agentsRoutes.get('/queue', requireAuth, async (c) => {
  try {
    const queue = (await agentQueueStore.get('singleton') as any) || [];
    return c.json({ success: true, queue });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /queue - добавить задачу в очередь
agentsRoutes.post('/queue', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const queue: QueueItem[] = (await agentQueueStore.get('singleton') as any) || [];
    const item: QueueItem = {
      id: `q-${crypto.randomUUID()}`,
      task: body.task?.trim(),
      priority: body.priority || 'normal',
      addedAt: new Date().toISOString(),
      status: 'pending',
    };
    if (!item.task) return c.json({ success: false, error: 'Task required' }, 400);
    queue.push(item);
    await agentQueueStore.set('singleton', queue.slice(0, 50));
    return c.json({ success: true, item });
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

    let queue: QueueItem[] = (await agentQueueStore.get('singleton') as any) || [];
    const pending = queue.filter(q => q.status === 'pending');

    if (pending.length === 0) return c.json({ success: true, processed: 0, sessions: [] });

    const toProcess = processAll ? pending : [pending[0]];
    const processedSessions: Session[] = [];

    for (const item of toProcess) {
      try {
        // Mark as processing
        queue = queue.map(q => q.id === item.id ? { ...q, status: 'processing' } : q);
        await agentQueueStore.set('singleton', queue);

        const fullTask = devlabContext ? `${item.task}\n\n[DevLab context:\n${devlabContext}]` : item.task;
        const result = await callAI([{ role: 'user', content: fullTask }]);

        const id = `s-${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        const session: Session = {
          id, title: item.task.slice(0, 80),
          task: item.task, messages: result.messages, decisions: result.decisions,
          status: 'completed', createdAt: now, updatedAt: now, followUps: [],
        };

        await agentSessionsStore.set(id, session);
        await updateSessionIndex(id, session.title, now);

        // Mark queue item as done
        queue = queue.map(q => q.id === item.id ? { ...q, status: 'done', sessionId: id } : q);
        await agentQueueStore.set('singleton', queue);

        processedSessions.push(session);
      } catch (err) {
        console.log(`Queue item ${item.id} failed:`, err);
        queue = queue.map(q => q.id === item.id ? { ...q, status: 'pending' } : q);
        await agentQueueStore.set('singleton', queue);
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
    const queue: any[] = (await agentQueueStore.get('singleton') as any) || [];
    await agentQueueStore.set('singleton', queue.filter((q: any) => q.id !== id));
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default agentsRoutes;