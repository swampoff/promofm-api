/**
 * SSE ROUTES - Server-Sent Events для real-time уведомлений
 * 
 * Endpoints:
 * GET /stream/:userId - SSE-стрим уведомлений
 * POST /emit/:userId  - Отправить событие в стрим (внутренний вызов)
 */

import { Hono } from 'hono';
import * as db from './db.tsx';

const app = new Hono();

// CORS headers for SSE responses (raw Response bypasses Hono middleware).
// Allow-list of trusted origins — wildcard '*' previously let any site read
// authenticated event streams, so a malicious page could subscribe a victim's
// SSE channel and intercept their notifications.
import { requireAuth, requireOwner, requireAdmin } from './auth-middleware.tsx';
import { ALLOWED_ORIGINS, SITE_ORIGIN } from './site-origin.tsx';

const SSE_ALLOWED_ORIGINS = new Set(ALLOWED_ORIGINS);

function sseCorsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = origin && SSE_ALLOWED_ORIGINS.has(origin) ? origin : SITE_ORIGIN.music;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id, Cache-Control, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  };
}

// Хранилище активных SSE-подключений (userId -> controller[])
const connections = new Map<string, Set<ReadableStreamDefaultController>>();

// Track closed controllers to avoid writing to dead streams
const closedControllers = new WeakSet<ReadableStreamDefaultController>();

// Глобальный event bus для отправки событий
export function emitSSE(userId: string, event: { type: string; data: any }) {
  const userConns = connections.get(userId);
  if (!userConns || userConns.size === 0) return;
  
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  
  const deadControllers: ReadableStreamDefaultController[] = [];
  for (const controller of userConns) {
    if (closedControllers.has(controller)) {
      deadControllers.push(controller);
      continue;
    }
    try {
      controller.enqueue(new TextEncoder().encode(payload));
    } catch {
      closedControllers.add(controller);
      deadControllers.push(controller);
    }
  }
  
  // Очистка мёртвых подключений
  for (const dc of deadControllers) {
    userConns.delete(dc);
  }
  if (userConns.size === 0) connections.delete(userId);
}

// SSE Stream endpoint
app.get('/stream/:userId', requireAuth, requireOwner('userId'), (c) => {
  const userId = c.req.param('userId');
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let controllerRef: ReadableStreamDefaultController | null = null;
  let closed = false;
  
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (controllerRef) {
      closedControllers.add(controllerRef);
      const userConns = connections.get(userId);
      if (userConns) {
        userConns.delete(controllerRef);
        if (userConns.size === 0) connections.delete(userId);
      }
      try { controllerRef.close(); } catch { /* already closed */ }
      controllerRef = null;
    }
  };

  // Safe enqueue helper — never throws
  const safeEnqueue = (controller: ReadableStreamDefaultController, data: Uint8Array): boolean => {
    if (closed || closedControllers.has(controller)) return false;
    try {
      controller.enqueue(data);
      return true;
    } catch {
      cleanup();
      return false;
    }
  };
  
  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      
      // Регистрация подключения
      if (!connections.has(userId)) {
        connections.set(userId, new Set());
      }
      connections.get(userId)!.add(controller);
      
      // Heartbeat каждые 25 сек
      heartbeatTimer = setInterval(() => {
        if (!safeEnqueue(controller, new TextEncoder().encode(': heartbeat\n\n'))) {
          cleanup();
        }
      }, 25000);
      
      // Отправляем initial event
      const initPayload = `event: connected\ndata: ${JSON.stringify({ userId, timestamp: new Date().toISOString() })}\n\n`;
      safeEnqueue(controller, new TextEncoder().encode(initPayload));
      
      // Cleanup при закрытии — listen to both abort and close
      const signal = c.req.raw.signal;
      if (signal) {
        signal.addEventListener('abort', () => cleanup());
      }
    },
    cancel() {
      // Called when the consumer (Deno HTTP runtime) cancels the stream
      // because the client disconnected
      cleanup();
    },
  });
  
  return new Response(stream, {
    headers: {
      ...sseCorsHeaders(c.req.header('origin')),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// POST /emit/:userId - отправить событие в свой SSE-стрим.
// Только владелец стрима или админ — иначе любой авторизованный пользователь
// мог бы спуфить уведомления другим юзерам ("платёж принят", "вы заблокированы").
app.post('/emit/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  const authRole = c.get('userRole');
  if (userId !== authUserId && authRole !== 'admin') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  try {
    const body = await c.req.json();
    emitSSE(userId, { type: body.type || 'notification', data: body.data || body });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 400);
  }
});

// GET /connections - статистика активных подключений.
// requireAdmin (2026-07-02): раньше ЛЮБОЙ залогиненный видел карту «кто сейчас
// онлайн» (все userId с числом подключений) — presence-разведка чужих юзеров.
app.get('/connections', requireAuth, requireAdmin, (c) => {
  const stats: Record<string, number> = {};
  for (const [userId, conns] of connections) {
    stats[userId] = conns.size;
  }
  return c.json({ success: true, totalUsers: connections.size, connections: stats });
});

export default app;
export { connections };