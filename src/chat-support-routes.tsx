/**
 * CHAT-SUPPORT ROUTES — live chat between site visitor and admin operator.
 *
 * Endpoints mounted at /server/api/chat-support:
 *
 *   Public (no auth, identified by guest_token in cookie + body):
 *     POST   /init                                — create session, return token
 *     POST   /:sessionId/identify                 — set guest_name / guest_email
 *     GET    /:sessionId/messages                 — fetch history
 *     POST   /:sessionId/messages                 — send guest message
 *     POST   /:sessionId/read                     — mark admin messages seen
 *     GET    /:sessionId/stream                   — SSE stream of new admin messages
 *
 *   Admin (requireAuth + requireAdmin):
 *     GET    /admin/sessions                      — list active sessions
 *     GET    /admin/sessions/:sessionId           — full session detail + messages
 *     POST   /admin/sessions/:sessionId/reply     — send admin message
 *     POST   /admin/sessions/:sessionId/assign    — take session ownership
 *     POST   /admin/sessions/:sessionId/close     — close session
 *     POST   /admin/sessions/:sessionId/read      — mark guest messages seen
 *
 * Persistence: PostgreSQL tables `chat_sessions` and `chat_messages`
 * (see src/migrations/012_chat_support.sql).
 *
 * Real-time delivery: existing src/sse-routes.tsx `emitSSE()` keyed on
 * `guest:${guestToken}` for guests and on `admin:chat` for the admin
 * dashboard (broadcast — all admins watching the dashboard see new
 * sessions / new messages).
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { emitSSE, connections } from './sse-routes.tsx';
import { notifyChatNewSession, sendChatGuestReplyEmail } from './email-helper.tsx';

const app = new Hono();

// ── helpers ──────────────────────────────────────────────────────

const GUEST_SSE_PREFIX = 'guest:';
const ADMIN_BROADCAST_KEY = 'admin:chat-support';

function newGuestToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function safeErr(err: any): string {
  return err?.message || String(err) || 'Unknown error';
}

// CORS for the public SSE stream (raw Response bypasses Hono CORS).
const ALLOWED_ORIGINS = new Set([
  'https://promo-music.ru',
  'https://www.promo-music.ru',
  'https://promofm.org',
  'https://www.promofm.org',
  'https://promofm.ru',
  'https://www.promofm.ru',
]);

function sseCorsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://promo-music.ru';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cache-Control, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  };
}

async function loadSessionByToken(token: string): Promise<{ id: string; status: string; guest_email: string | null; guest_name: string | null } | null> {
  const r = await pool.query(
    `SELECT id, status, guest_email, guest_name FROM chat_sessions WHERE guest_token = $1`,
    [token]
  );
  return r.rows[0] || null;
}

async function loadSessionByIdAndToken(sessionId: string, token: string): Promise<{ id: string; status: string; guest_email: string | null; guest_name: string | null } | null> {
  const r = await pool.query(
    `SELECT id, status, guest_email, guest_name
       FROM chat_sessions
      WHERE id::text = $1 AND guest_token = $2`,
    [sessionId, token]
  );
  return r.rows[0] || null;
}

function extractGuestToken(c: any, fallbackFromBody?: string | null): string | null {
  // Prefer header (set by widget via X-Chat-Guest-Token), then cookie, then body.
  const header = c.req.header('x-chat-guest-token');
  if (header) return header;
  const cookieHeader: string = c.req.header('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)chat_guest_token=([a-f0-9]{48})/);
  if (match) return match[1];
  return fallbackFromBody || null;
}

function setGuestTokenCookie(token: string): string {
  // 1 year lifetime, httpOnly off — the widget reads it from JS too.
  // SameSite=Lax so it survives redirects from email-back links.
  return `chat_guest_token=${token}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
}

function hasActiveGuestStream(token: string): boolean {
  const set = connections.get(GUEST_SSE_PREFIX + token);
  return !!set && set.size > 0;
}

// ── PUBLIC: POST /init ────────────────────────────────────────────
// Creates a new chat session OR returns the existing one if the
// browser already has a guest_token (to avoid stacking phantom sessions
// on page reload).
app.post('/init', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const existing = extractGuestToken(c, body.guestToken);
    const guestName: string | null = typeof body.guestName === 'string' ? body.guestName.slice(0, 100) : null;
    const guestEmail: string | null = typeof body.guestEmail === 'string' ? body.guestEmail.slice(0, 200) : null;
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null;
    const ua = c.req.header('user-agent') || null;

    if (existing) {
      const row = await loadSessionByToken(existing);
      if (row && row.status !== 'closed') {
        c.header('Set-Cookie', setGuestTokenCookie(existing));
        return c.json({ success: true, sessionId: row.id, guestToken: existing, status: row.status, existing: true });
      }
    }

    const token = newGuestToken();
    const r = await pool.query(
      `INSERT INTO chat_sessions (guest_token, guest_name, guest_email, source, ip_addr, user_agent)
       VALUES ($1, $2, $3, 'widget', $4, $5)
       RETURNING id`,
      [token, guestName, guestEmail, ip, ua]
    );
    const sessionId = r.rows[0].id;

    // Notify admins about a new live-chat session
    notifyChatNewSession({
      sessionId,
      guestName: guestName || undefined,
      guestEmail: guestEmail || undefined,
    }).catch((e) => console.warn('[chat-support] notifyChatNewSession failed:', safeErr(e)));

    emitSSE(ADMIN_BROADCAST_KEY, { type: 'chat_session_new', data: { sessionId, guestName, guestEmail, createdAt: new Date().toISOString() } });

    c.header('Set-Cookie', setGuestTokenCookie(token));
    return c.json({ success: true, sessionId, guestToken: token, status: 'open', existing: false });
  } catch (err: any) {
    console.error('[chat-support] init error:', err);
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── PUBLIC: POST /:sessionId/identify ─────────────────────────────
// Visitor fills in name/email after starting a chat (or updates them).
app.post('/:sessionId/identify', async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json().catch(() => ({} as any));
    const token = extractGuestToken(c, body.guestToken);
    if (!token) return c.json({ success: false, error: 'Missing guest token' }, 401);

    const session = await loadSessionByIdAndToken(sessionId, token);
    if (!session) return c.json({ success: false, error: 'Session not found' }, 404);
    if (session.status === 'closed') return c.json({ success: false, error: 'Session closed' }, 410);

    const guestName: string | null = typeof body.guestName === 'string' ? body.guestName.slice(0, 100) : null;
    const guestEmail: string | null = typeof body.guestEmail === 'string' ? body.guestEmail.slice(0, 200) : null;

    await pool.query(
      `UPDATE chat_sessions
          SET guest_name  = COALESCE($2, guest_name),
              guest_email = COALESCE($3, guest_email),
              updated_at  = NOW()
        WHERE id::text = $1`,
      [sessionId, guestName, guestEmail]
    );

    emitSSE(ADMIN_BROADCAST_KEY, { type: 'chat_session_updated', data: { sessionId, guestName, guestEmail } });

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── PUBLIC: GET /:sessionId/messages ──────────────────────────────
app.get('/:sessionId/messages', async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const token = extractGuestToken(c, null);
    if (!token) return c.json({ success: false, error: 'Missing guest token' }, 401);

    const session = await loadSessionByIdAndToken(sessionId, token);
    if (!session) return c.json({ success: false, error: 'Session not found' }, 404);

    const r = await pool.query(
      `SELECT id::text AS id, sender_type, sender_id, sender_name, body, attachments,
              created_at, read_at
         FROM chat_messages
        WHERE session_id::text = $1
        ORDER BY created_at ASC`,
      [sessionId]
    );

    return c.json({ success: true, messages: r.rows, session: { status: session.status, guestName: session.guest_name, guestEmail: session.guest_email } });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── PUBLIC: POST /:sessionId/messages ─────────────────────────────
// Guest sends a message into the session.
app.post('/:sessionId/messages', async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json().catch(() => ({} as any));
    const token = extractGuestToken(c, body.guestToken);
    if (!token) return c.json({ success: false, error: 'Missing guest token' }, 401);

    const session = await loadSessionByIdAndToken(sessionId, token);
    if (!session) return c.json({ success: false, error: 'Session not found' }, 404);
    if (session.status === 'closed') return c.json({ success: false, error: 'Session closed' }, 410);

    const text: string = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) return c.json({ success: false, error: 'Empty message' }, 400);
    if (text.length > 4000) return c.json({ success: false, error: 'Message too long' }, 413);

    const ins = await pool.query(
      `INSERT INTO chat_messages (session_id, sender_type, sender_name, body)
       VALUES ($1, 'guest', $2, $3)
       RETURNING id::text AS id, created_at`,
      [sessionId, session.guest_name, text]
    );
    const msg = ins.rows[0];

    const payload = {
      id: msg.id,
      sessionId,
      sender_type: 'guest',
      sender_name: session.guest_name,
      body: text,
      created_at: msg.created_at,
    };

    // Push to admin dashboard
    emitSSE(ADMIN_BROADCAST_KEY, { type: 'chat_message_new', data: payload });

    return c.json({ success: true, message: payload });
  } catch (err: any) {
    console.error('[chat-support] guest send error:', err);
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── PUBLIC: POST /:sessionId/read ─────────────────────────────────
app.post('/:sessionId/read', async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const token = extractGuestToken(c, null);
    if (!token) return c.json({ success: false, error: 'Missing guest token' }, 401);

    const session = await loadSessionByIdAndToken(sessionId, token);
    if (!session) return c.json({ success: false, error: 'Session not found' }, 404);

    const now = new Date();
    await pool.query(
      `UPDATE chat_sessions SET last_guest_read_at = $2 WHERE id::text = $1`,
      [sessionId, now]
    );
    await pool.query(
      `UPDATE chat_messages SET read_at = $2
        WHERE session_id::text = $1 AND sender_type = 'admin' AND read_at IS NULL`,
      [sessionId, now]
    );

    emitSSE(ADMIN_BROADCAST_KEY, { type: 'chat_session_read_by_guest', data: { sessionId, at: now.toISOString() } });

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── PUBLIC: GET /:sessionId/stream ────────────────────────────────
// SSE channel. Guest authenticates via guest_token in query/cookie.
app.get('/:sessionId/stream', async (c) => {
  const sessionId = c.req.param('sessionId');
  const token = extractGuestToken(c, c.req.query('token'));
  if (!token) return c.json({ success: false, error: 'Missing guest token' }, 401);

  const session = await loadSessionByIdAndToken(sessionId, token);
  if (!session) return c.json({ success: false, error: 'Session not found' }, 404);

  const sseKey = GUEST_SSE_PREFIX + token;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let controllerRef: ReadableStreamDefaultController | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (controllerRef) {
      const set = connections.get(sseKey);
      if (set) {
        set.delete(controllerRef);
        if (set.size === 0) connections.delete(sseKey);
      }
      try { controllerRef.close(); } catch { /* already closed */ }
      controllerRef = null;
    }
  };

  const safeEnqueue = (ctrl: ReadableStreamDefaultController, bytes: Uint8Array): boolean => {
    if (closed) return false;
    try {
      ctrl.enqueue(bytes);
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      if (!connections.has(sseKey)) connections.set(sseKey, new Set());
      connections.get(sseKey)!.add(controller);

      heartbeat = setInterval(() => {
        if (!safeEnqueue(controller, new TextEncoder().encode(': heartbeat\n\n'))) cleanup();
      }, 25000);

      const init = `event: connected\ndata: ${JSON.stringify({ sessionId, status: session.status })}\n\n`;
      safeEnqueue(controller, new TextEncoder().encode(init));

      const signal = c.req.raw.signal;
      if (signal) signal.addEventListener('abort', () => cleanup());
    },
    cancel() {
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

// ── ADMIN: GET /admin/sessions ────────────────────────────────────
// Lists sessions for the admin live-chat dashboard. Filterable by status.
app.get('/admin/sessions', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'open,assigned';
    const allowed = ['open', 'assigned', 'closed'];
    const statuses = status.split(',').map((s) => s.trim()).filter((s) => allowed.includes(s));
    if (statuses.length === 0) return c.json({ success: true, sessions: [] });

    const r = await pool.query(
      `SELECT s.id::text AS id, s.guest_name, s.guest_email, s.user_id, s.status,
              s.assigned_admin_id, s.source, s.last_message_at,
              s.last_admin_read_at, s.created_at,
              (
                SELECT body FROM chat_messages m
                 WHERE m.session_id = s.id
                 ORDER BY m.created_at DESC
                 LIMIT 1
              ) AS last_message_body,
              (
                SELECT sender_type FROM chat_messages m
                 WHERE m.session_id = s.id
                 ORDER BY m.created_at DESC
                 LIMIT 1
              ) AS last_message_sender,
              (
                SELECT COUNT(*) FROM chat_messages m
                 WHERE m.session_id = s.id
                   AND m.sender_type = 'guest'
                   AND (s.last_admin_read_at IS NULL OR m.created_at > s.last_admin_read_at)
              )::int AS unread_for_admin
         FROM chat_sessions s
        WHERE s.status = ANY($1::text[])
        ORDER BY s.last_message_at DESC NULLS LAST, s.created_at DESC
        LIMIT 200`,
      [statuses]
    );

    return c.json({ success: true, sessions: r.rows });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── ADMIN: GET /admin/sessions/:sessionId ─────────────────────────
app.get('/admin/sessions/:sessionId', requireAuth, requireAdmin, async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const sr = await pool.query(
      `SELECT id::text AS id, guest_name, guest_email, user_id, status,
              assigned_admin_id, source, last_message_at, last_admin_read_at,
              last_guest_read_at, ip_addr, user_agent, created_at, updated_at
         FROM chat_sessions WHERE id::text = $1`,
      [sessionId]
    );
    if (sr.rows.length === 0) return c.json({ success: false, error: 'Session not found' }, 404);

    const mr = await pool.query(
      `SELECT id::text AS id, sender_type, sender_id, sender_name, body,
              attachments, created_at, read_at
         FROM chat_messages
        WHERE session_id::text = $1
        ORDER BY created_at ASC`,
      [sessionId]
    );

    return c.json({ success: true, session: sr.rows[0], messages: mr.rows });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── ADMIN: POST /admin/sessions/:sessionId/reply ──────────────────
app.post('/admin/sessions/:sessionId/reply', requireAuth, requireAdmin, async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json().catch(() => ({} as any));
    const text: string = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) return c.json({ success: false, error: 'Empty message' }, 400);
    if (text.length > 4000) return c.json({ success: false, error: 'Message too long' }, 413);

    const adminId = String(c.get('userId') || '');
    // Pull admin display name from users table (admins occasionally need
    // to appear by name; default keeps the bubble human-readable).
    let adminName = 'Поддержка';
    try {
      const nr = await pool.query(`SELECT name FROM users WHERE id::text = $1`, [adminId]);
      if (nr.rows[0]?.name) adminName = nr.rows[0].name;
    } catch { /* keep default */ }

    const sr = await pool.query(
      `SELECT id::text AS id, guest_token, guest_email, guest_name, status
         FROM chat_sessions WHERE id::text = $1`,
      [sessionId]
    );
    if (sr.rows.length === 0) return c.json({ success: false, error: 'Session not found' }, 404);
    const session = sr.rows[0];
    if (session.status === 'closed') return c.json({ success: false, error: 'Session closed' }, 410);

    const ins = await pool.query(
      `INSERT INTO chat_messages (session_id, sender_type, sender_id, sender_name, body)
       VALUES ($1, 'admin', $2, $3, $4)
       RETURNING id::text AS id, created_at`,
      [sessionId, adminId, adminName, text]
    );
    const msg = ins.rows[0];

    // Auto-assign on first reply
    if (session.status === 'open') {
      await pool.query(
        `UPDATE chat_sessions
            SET status = 'assigned', assigned_admin_id = $2, updated_at = NOW()
          WHERE id::text = $1`,
        [sessionId, adminId]
      );
    }

    const payload = {
      id: msg.id,
      sessionId,
      sender_type: 'admin',
      sender_name: adminName,
      body: text,
      created_at: msg.created_at,
    };

    // Push to guest SSE channel if connected
    emitSSE(GUEST_SSE_PREFIX + session.guest_token, { type: 'chat_message_new', data: payload });

    // Also fan-out to other admins watching the dashboard
    emitSSE(ADMIN_BROADCAST_KEY, { type: 'chat_message_new', data: payload });

    // Email fallback: if no active guest SSE stream, fire an email so the
    // visitor sees the reply when they come back. Requires guest_email.
    if (session.guest_email && !hasActiveGuestStream(session.guest_token)) {
      sendChatGuestReplyEmail({
        toEmail: session.guest_email,
        toName: session.guest_name || undefined,
        adminName,
        body: text,
        sessionId,
        guestToken: session.guest_token,
      }).catch((e) => console.warn('[chat-support] guest reply email failed:', safeErr(e)));
    }

    return c.json({ success: true, message: payload });
  } catch (err: any) {
    console.error('[chat-support] admin reply error:', err);
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── ADMIN: POST /admin/sessions/:sessionId/assign ─────────────────
app.post('/admin/sessions/:sessionId/assign', requireAuth, requireAdmin, async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const adminId = String(c.get('userId') || '');

    const r = await pool.query(
      `UPDATE chat_sessions
          SET status = 'assigned', assigned_admin_id = $2, updated_at = NOW()
        WHERE id::text = $1 AND status <> 'closed'
        RETURNING id::text AS id, guest_token`,
      [sessionId, adminId]
    );
    if (r.rows.length === 0) return c.json({ success: false, error: 'Session not found or closed' }, 404);

    emitSSE(ADMIN_BROADCAST_KEY, { type: 'chat_session_assigned', data: { sessionId, adminId } });

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── ADMIN: POST /admin/sessions/:sessionId/close ──────────────────
app.post('/admin/sessions/:sessionId/close', requireAuth, requireAdmin, async (c) => {
  try {
    const sessionId = c.req.param('sessionId');

    const r = await pool.query(
      `UPDATE chat_sessions
          SET status = 'closed', updated_at = NOW()
        WHERE id::text = $1
        RETURNING id::text AS id, guest_token`,
      [sessionId]
    );
    if (r.rows.length === 0) return c.json({ success: false, error: 'Session not found' }, 404);

    emitSSE(GUEST_SSE_PREFIX + r.rows[0].guest_token, { type: 'chat_session_closed', data: { sessionId } });
    emitSSE(ADMIN_BROADCAST_KEY, { type: 'chat_session_closed', data: { sessionId } });

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── ADMIN: POST /admin/sessions/:sessionId/read ───────────────────
app.post('/admin/sessions/:sessionId/read', requireAuth, requireAdmin, async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const now = new Date();
    await pool.query(
      `UPDATE chat_sessions SET last_admin_read_at = $2 WHERE id::text = $1`,
      [sessionId, now]
    );
    await pool.query(
      `UPDATE chat_messages SET read_at = $2
        WHERE session_id::text = $1 AND sender_type = 'guest' AND read_at IS NULL`,
      [sessionId, now]
    );
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── ADMIN: GET /admin/stream ──────────────────────────────────────
// SSE channel for the admin dashboard — receives chat_session_new,
// chat_message_new, chat_session_assigned, chat_session_closed events
// for ALL chat sessions on the platform. Implemented by hooking the
// admin user's SSE bus to the broadcast key.
app.get('/admin/stream', requireAuth, requireAdmin, async (c) => {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let controllerRef: ReadableStreamDefaultController | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (controllerRef) {
      const set = connections.get(ADMIN_BROADCAST_KEY);
      if (set) {
        set.delete(controllerRef);
        if (set.size === 0) connections.delete(ADMIN_BROADCAST_KEY);
      }
      try { controllerRef.close(); } catch { /* already closed */ }
      controllerRef = null;
    }
  };

  const safeEnqueue = (ctrl: ReadableStreamDefaultController, bytes: Uint8Array): boolean => {
    if (closed) return false;
    try { ctrl.enqueue(bytes); return true; } catch { cleanup(); return false; }
  };

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      if (!connections.has(ADMIN_BROADCAST_KEY)) connections.set(ADMIN_BROADCAST_KEY, new Set());
      connections.get(ADMIN_BROADCAST_KEY)!.add(controller);

      heartbeat = setInterval(() => {
        if (!safeEnqueue(controller, new TextEncoder().encode(': heartbeat\n\n'))) cleanup();
      }, 25000);

      const init = `event: connected\ndata: ${JSON.stringify({ admin: true })}\n\n`;
      safeEnqueue(controller, new TextEncoder().encode(init));

      const signal = c.req.raw.signal;
      if (signal) signal.addEventListener('abort', () => cleanup());
    },
    cancel() { cleanup(); },
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

// ── POST /webhook/telegram — admin's reply-in-TG → chat_messages ─
//
// Bridge admin Telegram replies back into the chat. The new-session
// notification (notifyChatNewSession in email-helper.tsx) embeds
// `[session:<UUID>]` into the TG message. When admin presses Reply
// in Telegram on that message and sends text — Telegram invokes
// this webhook with update.message.reply_to_message.text containing
// the original text (including the marker). We extract the session_id,
// insert a chat_messages row with sender_type='admin', and push it
// into the guest's SSE stream.
//
// Auth: shared secret in URL path (the webhook URL itself is the
// secret). Telegram supports setWebhook with a `secret_token` header,
// but path-secret is the most reliable cross-version pattern. The
// webhook path is `/webhook/telegram/:secret` where :secret matches
// process.env.TELEGRAM_WEBHOOK_SECRET; the same secret must be
// configured via setWebhook on the bot side (manual deploy step).
//
// No DB schema change required — we reuse `chat_messages` and
// `chat_sessions` tables shipped in migration 012.

const SESSION_TAG_RE = /\[session:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

async function telegramReply(chatId: number | string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e: any) {
    console.warn('[chat-support/tg-bridge] sendMessage failed:', e?.message);
  }
}

app.post('/webhook/telegram/:secret', async (c) => {
  try {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected) {
      console.error('[chat-support/tg-bridge] TELEGRAM_WEBHOOK_SECRET not configured');
      return c.json({ ok: false }, 500);
    }
    if (c.req.param('secret') !== expected) {
      // Don't leak — quiet 200 OK so attackers can't fingerprint
      // (Telegram itself ignores response body).
      return c.json({ ok: true });
    }

    const update: any = await c.req.json().catch(() => null);
    if (!update?.message) {
      // Other update types (callback_query, edited_message, etc.) — ignore.
      return c.json({ ok: true });
    }

    const msg = update.message;
    const replyTo = msg.reply_to_message;
    const fromChatId = msg.chat?.id;

    // Special command: /start — gentle ack so the admin knows the
    // webhook is wired.
    if (typeof msg.text === 'string' && msg.text.trim() === '/start') {
      if (fromChatId) {
        await telegramReply(fromChatId,
          '👋 Бот моста live-чат ↔ Telegram активен.\n\n'
          + 'Когда придёт уведомление «Новый live-чат на сайте» — нажмите '
          + '<b>Reply</b> на него и пришлите текст. Ответ доставится посетителю.'
        );
      }
      return c.json({ ok: true });
    }

    // Must be a reply to a previous bot message containing the session tag.
    if (!replyTo || typeof replyTo.text !== 'string') {
      if (fromChatId) {
        await telegramReply(fromChatId,
          '⚠️ Чтобы доставить ответ — сделайте <b>Reply</b> на уведомление '
          + '«Новый live-чат на сайте». Без Reply бот не знает в какую сессию слать.'
        );
      }
      return c.json({ ok: true });
    }

    const m = replyTo.text.match(SESSION_TAG_RE);
    if (!m) {
      if (fromChatId) {
        await telegramReply(fromChatId,
          '⚠️ В исходном сообщении нет метки сессии. Ответьте на свежее '
          + 'уведомление «Новый live-чат на сайте» — там должна быть строка '
          + '<code>[session:UUID]</code>.'
        );
      }
      return c.json({ ok: true });
    }
    const sessionId = m[1];

    const replyText: string = String(msg.text || '').trim();
    if (!replyText) {
      // Media-only replies — skip silently.
      return c.json({ ok: true });
    }
    if (replyText.length > 4000) {
      if (fromChatId) {
        await telegramReply(fromChatId, '⚠️ Слишком длинный ответ (>4000 символов), не доставлен.');
      }
      return c.json({ ok: true });
    }

    // Verify session is still active.
    const sr = await pool.query(
      `SELECT id::text AS id, guest_token, guest_email, guest_name, status
         FROM chat_sessions WHERE id::text = $1`,
      [sessionId],
    );
    if (sr.rows.length === 0) {
      if (fromChatId) {
        await telegramReply(fromChatId, `⚠️ Сессия <code>${sessionId.slice(0, 8)}…</code> не найдена.`);
      }
      return c.json({ ok: true });
    }
    const session = sr.rows[0];
    if (session.status === 'closed') {
      if (fromChatId) {
        await telegramReply(fromChatId,
          `⚠️ Чат <code>${sessionId.slice(0, 8)}…</code> завершён, ответ не доставлен.`
        );
      }
      return c.json({ ok: true });
    }

    // Admin display name — fall back to «Поддержка» since we don't
    // have a clean way to map TG user → platform admin user_id yet.
    // Future: if the bot stores TG user_id ↔ platform user_id in a
    // mapping table, we can use the real admin name here.
    const adminName = msg.from?.first_name
      ? `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`
      : 'Поддержка';

    const ins = await pool.query(
      `INSERT INTO chat_messages (session_id, sender_type, sender_id, sender_name, body)
       VALUES ($1, 'admin', NULL, $2, $3)
       RETURNING id::text AS id, created_at`,
      [sessionId, adminName, replyText],
    );
    const newMsg = ins.rows[0];

    // Auto-assign on first TG reply (status='open' → 'assigned')
    if (session.status === 'open') {
      await pool.query(
        `UPDATE chat_sessions
            SET status = 'assigned', updated_at = NOW()
          WHERE id::text = $1`,
        [sessionId],
      );
    }

    const payload = {
      id: newMsg.id,
      sessionId,
      sender_type: 'admin',
      sender_name: adminName,
      body: replyText,
      created_at: newMsg.created_at,
    };

    // Push to guest's SSE stream
    emitSSE(GUEST_SSE_PREFIX + session.guest_token, { type: 'chat_message_new', data: payload });
    // Also fan-out to admin dashboard so other admins watching see it
    emitSSE(ADMIN_BROADCAST_KEY, { type: 'chat_message_new', data: payload });

    // Email-back fallback: if guest isn't connected via SSE, send email
    if (session.guest_email && !hasActiveGuestStream(session.guest_token)) {
      sendChatGuestReplyEmail({
        toEmail: session.guest_email,
        toName: session.guest_name || undefined,
        adminName,
        body: replyText,
        sessionId,
        guestToken: session.guest_token,
      }).catch((e) => console.warn('[chat-support/tg-bridge] guest email fallback failed:', safeErr(e)));
    }

    // ACK to the admin in TG
    if (fromChatId) {
      await telegramReply(fromChatId,
        `✅ Ответ доставлен посетителю.\n`
        + (session.guest_email && !hasActiveGuestStream(session.guest_token)
            ? `(дублировано на email ${session.guest_email})`
            : '(посетитель в чате прямо сейчас)')
      );
    }

    return c.json({ ok: true });
  } catch (err: any) {
    console.error('[chat-support/tg-bridge] webhook error:', err);
    // Always respond 200 to Telegram so they don't retry-spam — internal
    // failures are logged for our side.
    return c.json({ ok: false, error: safeErr(err) }, 200);
  }
});

export default app;
