/**
 * MESSAGING ROUTES — DM между всеми кабинетами
 *
 * Native SQL (PostgreSQL). KV store удалён 2026-04-29.
 *
 * Tables:
 *   dm_conversations (id, participant_ids text[], last_message_text, last_message_at, data jsonb)
 *   dm_messages (id, conversation_id, sender_id, content, message_type, is_read, read_at, created_at)
 *   dm_unread (user_id, conversation_id, unread_count, updated_at)
 *   dm_blocks (blocker_id, blocked_id, reason, created_at) — migration 022
 *   dm_reports (id, reporter_id, reported_id, message_id, category, details, status, ...) — migration 022
 *
 * Endpoints:
 *   GET    /conversations/:userId
 *   POST   /conversations
 *   GET    /messages/:conversationId
 *   POST   /messages/:conversationId
 *   PUT    /messages/:conversationId/read
 *   GET    /unread/:userId
 *   PUT    /messages/:messageId/edit
 *   DELETE /messages/:conversationId/:messageId
 *   POST   /typing/:conversationId
 *   GET    /presence/:userId
 *   GET    /rules
 *   POST   /presence
 *   GET    /search-contacts                   — radio out of graph,
 *                                                blocked users hidden
 *   GET    /blocks                            — list my blocks
 *   POST   /blocks/:userId                    — block (idempotent)
 *   DELETE /blocks/:userId                    — unblock
 *   POST   /reports                           — file abuse report
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { emitSSE } from './sse-routes.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { createLogger } from './logger.tsx';

const log = createLogger('messaging');

// ── Telegram forwarding for admin messages ──
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_LEAD_CHAT = process.env.TELEGRAM_LEAD_CHAT_ID || '';

async function forwardToTelegramIfAdmin(recipientRole: string, senderName: string, text: string): Promise<void> {
  if (recipientRole !== 'admin' || !TG_BOT_TOKEN || !TG_LEAD_CHAT) return;
  const preview = text.length > 300 ? text.slice(0, 300) + '...' : text;
  const msg = '✉️ promo-music.ru\n\n' + 'От: ' + senderName + '\n' + 'Сообщение: ' + preview;
  try {
    await fetch('https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_LEAD_CHAT, text: msg }),
    });
  } catch (err) {
    log.warn({ err }, 'telegram_forward_failed');
  }
}

const app = new Hono();

// ── Types ──

type CabinetRole = 'artist' | 'producer' | 'dj' | 'admin' | 'radio' | 'venue' | 'engineer' | 'label';

interface Participant {
  userId: string;
  userName: string;
  role: CabinetRole;
  avatar?: string;
}

// ── Communication Rules ──
//
// All cabinet roles are mutually addressable — this is the
// in-platform DM surface (the «соцсеть внутри платформы») that
// lets a DJ pitch a label, an artist DM a mastering engineer,
// a radio station reach out to a venue directly, etc.
//
// Two rounds of fixes on 2026-05-25:
//   1. `engineer` and `label` were missing from `CabinetRole`
//      entirely — `roles.tsx` knows them, the messaging surface
//      didn't, so they were dropped by the role allowlist on
//      `/search-contacts`.
//   2. `radio` was deliberately narrow («только admin + venue»,
//      rationale: radio↔creator goes through pitching) — but
//      product decision is that radio should also be reachable
//      from any cabinet and vice versa. Pitching is a structured
//      submission flow, not a substitute for a chat.
//
// Anything new: add the role to `CabinetRole` AND to every row
// below (it's a symmetric graph). The three FE declarations of
// `CabinetRole` must agree — see PRODUCT_FACTS.md.
const ALL_CABINET_ROLES: CabinetRole[] = [
  'artist', 'producer', 'dj', 'engineer', 'label', 'venue', 'radio', 'admin',
];
const ALLOWED_CONTACTS: Record<CabinetRole, CabinetRole[]> = {
  artist:   ALL_CABINET_ROLES,
  producer: ALL_CABINET_ROLES,
  dj:       ALL_CABINET_ROLES,
  engineer: ALL_CABINET_ROLES,
  label:    ALL_CABINET_ROLES,
  venue:    ALL_CABINET_ROLES,
  radio:    ALL_CABINET_ROLES,
  admin:    ALL_CABINET_ROLES,
};

function canCommunicate(roleA: CabinetRole, roleB: CabinetRole): boolean {
  return ALLOWED_CONTACTS[roleA]?.includes(roleB) ?? false;
}

function makeConvId(userA: string, userB: string): string {
  return [userA, userB].sort().join('::');
}

const ROLE_LABELS: Record<CabinetRole, string> = {
  artist: 'Артист',
  producer: 'Продюсер',
  dj: 'DJ',
  admin: 'Платформа',
  radio: 'Радио',
  venue: 'Заведение',
  engineer: 'Инженер',
  label: 'Лейбл',
};

// Map role from DB enum to client-facing role
function mapRole(role: string): CabinetRole {
  if (role === 'radio_station' || role === 'radio') return 'radio';
  if (role === 'admin' || role === 'superadmin') return 'admin';
  return (role as CabinetRole) || 'artist';
}

// Hydrate participant info from users + profiles tables
async function getParticipantInfo(userId: string): Promise<Participant> {
  try {
    const r = await pool.query(
      `SELECT u.id, u.full_name, u.role::text, u.avatar_url
       FROM users u WHERE u.id::text = $1 LIMIT 1`,
      [userId]
    );
    if (r.rows[0]) {
      const u = r.rows[0];
      return {
        userId,
        userName: u.full_name || u.id,
        role: mapRole(u.role),
        avatar: u.avatar_url || undefined,
      };
    }
  } catch (err) {
    // DB error: caller will see a default 'artist' role + raw userId as the name.
    // This can mis-classify role in communication rules, so we surface it loudly.
    log.error({ err, userId }, 'participant_info_db_error');
  }
  // Fallback for non-UUID synthetic ids (admin-1, demo users etc.)
  return { userId, userName: userId, role: 'artist' };
}

// ── Block lookups ──
//
// `dm_blocks` shape (migration 022): (blocker_id, blocked_id, reason,
// created_at). The block is one-directional in DB but applied
// symmetrically by every consumer — if A→B exists, neither side can
// initiate to the other or appear in each other's search results.
// Existing conversations remain readable so neither side loses
// history. See migration file for the full contract.

async function getBlockedPair(userA: string, userB: string): Promise<{ a_blocks_b: boolean; b_blocks_a: boolean }> {
  try {
    const r = await pool.query(
      `SELECT blocker_id, blocked_id FROM dm_blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)`,
      [userA, userB]
    );
    let a_blocks_b = false;
    let b_blocks_a = false;
    for (const row of r.rows) {
      if (row.blocker_id === userA) a_blocks_b = true;
      if (row.blocker_id === userB) b_blocks_a = true;
    }
    return { a_blocks_b, b_blocks_a };
  } catch (err) {
    log.error({ err, userA, userB }, 'block_lookup_failed');
    // Fail-open on DB hiccup; the alternative is blocking everyone
    // mid-outage. Worst case is one message reaches a blocked user.
    return { a_blocks_b: false, b_blocks_a: false };
  }
}

async function getBlocksTouching(userId: string): Promise<Set<string>> {
  // Returns every counterparty userId such that EITHER user blocked
  // the other. Used to filter search results in one pass.
  try {
    const r = await pool.query(
      `SELECT CASE WHEN blocker_id = $1 THEN blocked_id ELSE blocker_id END AS other
         FROM dm_blocks
        WHERE blocker_id = $1 OR blocked_id = $1`,
      [userId]
    );
    return new Set(r.rows.map((row: any) => String(row.other)));
  } catch (err) {
    log.error({ err, userId }, 'blocks_touching_lookup_failed');
    return new Set();
  }
}

// ── GET /conversations/:userId ──

app.get('/conversations/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  if (authUserId !== userId) {
    return c.json({ success: false, error: 'Access denied: not resource owner' }, 403);
  }
  try {
    const convs = await pool.query(
      `SELECT c.id, c.participant_ids, c.last_message_text, c.last_message_at, c.data, c.created_at,
              COALESCE(u.unread_count, 0) as unread_count
       FROM dm_conversations c
       LEFT JOIN dm_unread u ON u.conversation_id = c.id AND u.user_id = $1
       WHERE $1 = ANY(c.participant_ids)
       ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC`,
      [userId]
    );

    // Hydrate participants for each conversation
    const conversations = await Promise.all(
      convs.rows.map(async (row: any) => {
        const participants = await Promise.all(
          (row.participant_ids || []).map((uid: string) => getParticipantInfo(uid))
        );
        return {
          id: row.id,
          participants,
          source: row.data?.source || 'direct',
          collabOfferId: row.data?.collabOfferId,
          lastMessage: row.last_message_text || undefined,
          lastMessageAt: row.last_message_at?.toISOString?.() || row.last_message_at,
          createdAt: row.created_at?.toISOString?.() || row.created_at,
          unreadCount: parseInt(row.unread_count) || 0,
        };
      })
    );

    return c.json({ success: true, conversations });
  } catch (err: any) {
    console.error('GET /conversations error:', err);
    return c.json({ success: false, error: err.message || String(err) }, 500);
  }
});

// ── POST /conversations ──

app.post('/conversations', requireAuth, async (c) => {
  try {
    const { participants, source, collabOfferId } = await c.req.json() as {
      participants: Participant[];
      source?: 'direct' | 'collab' | 'support';
      collabOfferId?: string;
    };

    if (!participants || participants.length < 2) {
      return c.json({ success: false, error: 'At least 2 participants required' }, 400);
    }

    const authUserId = c.get('userId');
    if (!participants.some(p => p.userId === authUserId)) {
      return c.json({ success: false, error: 'Access denied: you must be a participant' }, 403);
    }

    const p1 = participants[0];
    const p2 = participants[1];

    // Block guard. Either side blocking the other denies new
    // conversations (existing convs stay readable). 403, neutral
    // error — don't leak which side did the blocking.
    const blockState = await getBlockedPair(p1.userId, p2.userId);
    if (blockState.a_blocks_b || blockState.b_blocks_a) {
      return c.json({
        success: false,
        error: 'Невозможно начать переписку с этим пользователем.',
        code: 'BLOCKED',
      }, 403);
    }

    if (!canCommunicate(p1.role, p2.role)) {
      const label1 = ROLE_LABELS[p1.role] || p1.role;
      const label2 = ROLE_LABELS[p2.role] || p2.role;
      return c.json({
        success: false,
        error: `${label1} не может отправлять сообщения роли ${label2}`,
        code: 'COMMUNICATION_RESTRICTED',
      }, 403);
    }

    const convId = makeConvId(p1.userId, p2.userId);
    const participantIds = participants.map(p => p.userId);

    // Try insert; if exists, return existing
    const existing = await pool.query(
      `SELECT id, participant_ids, last_message_text, last_message_at, data, created_at
       FROM dm_conversations WHERE id = $1`,
      [convId]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return c.json({
        success: true,
        conversation: {
          id: row.id, participants,
          source: row.data?.source || 'direct',
          collabOfferId: row.data?.collabOfferId,
          lastMessage: row.last_message_text,
          lastMessageAt: row.last_message_at,
          createdAt: row.created_at,
        },
        created: false,
      });
    }

    const dataJson = JSON.stringify({ source: source || 'direct', collabOfferId });
    await pool.query(
      `INSERT INTO dm_conversations (id, participant_ids, last_message_text, last_message_at, data, created_at)
       VALUES ($1, $2, '', NOW(), $3::jsonb, NOW())`,
      [convId, participantIds, dataJson]
    );

    return c.json({
      success: true,
      conversation: {
        id: convId, participants,
        source: source || 'direct', collabOfferId,
        createdAt: new Date().toISOString(),
      },
      created: true,
    });
  } catch (err: any) {
    console.error('POST /conversations error:', err);
    return c.json({ success: false, error: err.message || String(err) }, 500);
  }
});

// ── GET /messages/:conversationId ──

app.get('/messages/:conversationId', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  const authUserId = c.get('userId');
  try {
    const conv = await pool.query(
      `SELECT participant_ids FROM dm_conversations WHERE id = $1`,
      [conversationId]
    );
    if (conv.rows.length === 0) {
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    }
    if (!conv.rows[0].participant_ids.includes(authUserId)) {
      return c.json({ success: false, error: 'Access denied: not a participant' }, 403);
    }

    const msgs = await pool.query(
      `SELECT m.id, m.conversation_id, m.sender_id, m.content, m.message_type, m.is_read, m.created_at,
              u.full_name as sender_name, u.role::text as sender_role
       FROM dm_messages m
       LEFT JOIN users u ON u.id::text = m.sender_id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC`,
      [conversationId]
    );

    const messages = msgs.rows.map((m: any) => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      senderName: m.sender_name || m.sender_id,
      senderRole: mapRole(m.sender_role || 'artist'),
      text: m.content,
      type: m.message_type,
      isRead: m.is_read,
      createdAt: m.created_at?.toISOString?.() || m.created_at,
    }));

    return c.json({ success: true, messages });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || String(err) }, 500);
  }
});

// ── POST /messages/:conversationId ──

app.post('/messages/:conversationId', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  try {
    const { senderId, senderName, senderRole, text, attachment } = await c.req.json();
    const authUserId = c.get('userId');
    if (senderId !== authUserId) {
      return c.json({ success: false, error: 'Access denied: senderId mismatch' }, 403);
    }

    const conv = await pool.query(
      `SELECT participant_ids, data FROM dm_conversations WHERE id = $1`,
      [conversationId]
    );
    if (conv.rows.length === 0) {
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    }
    const participantIds: string[] = conv.rows[0].participant_ids || [];
    if (!participantIds.includes(authUserId)) {
      return c.json({ success: false, error: 'Access denied: not a participant' }, 403);
    }

    // Block guard for ongoing convs. Either side blocking the
    // other refuses new outbound messages (existing history stays
    // readable on both sides). Only checks the OTHER participant
    // — self-blocks are impossible by CHECK constraint, and group
    // chats (>2) skip this check since block semantics for groups
    // are ambiguous (block one, drop everyone?).
    if (participantIds.length === 2) {
      const otherId = participantIds.find(id => id !== authUserId);
      if (otherId) {
        const blockState = await getBlockedPair(authUserId, otherId);
        if (blockState.a_blocks_b || blockState.b_blocks_a) {
          return c.json({
            success: false,
            error: 'Невозможно отправить сообщение в эту переписку.',
            code: 'BLOCKED',
          }, 403);
        }
      }
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return c.json({ success: false, error: 'Empty message' }, 400);
    }

    const messageType = attachment ? 'attachment' : 'text';
    const ins = await pool.query(
      `INSERT INTO dm_messages (conversation_id, sender_id, content, message_type, is_read, created_at)
       VALUES ($1, $2, $3, $4, false, NOW())
       RETURNING id, created_at`,
      [conversationId, senderId, text.trim(), messageType]
    );
    const msgId = ins.rows[0].id;
    const createdAt = ins.rows[0].created_at;

    // Update conversation last_message
    await pool.query(
      `UPDATE dm_conversations SET last_message_text = $1, last_message_at = NOW() WHERE id = $2`,
      [text.trim().slice(0, 500), conversationId]
    );

    // Bump unread for all other participants
    for (const recipient of participantIds) {
      if (recipient === senderId) continue;
      await pool.query(
        `INSERT INTO dm_unread (user_id, conversation_id, unread_count, updated_at)
         VALUES ($1, $2, 1, NOW())
         ON CONFLICT (user_id, conversation_id) DO UPDATE SET
           unread_count = dm_unread.unread_count + 1, updated_at = NOW()`,
        [recipient, conversationId]
      );

      // SSE notify
      try {
        emitSSE(recipient, {
          type: 'dm_new_message',
          data: {
            conversationId, messageId: msgId,
            senderId, senderName: senderName || '',
            text: text.trim(),
            createdAt,
          },
        });
      } catch (err) {
        log.warn({ err, recipient, conversationId }, 'dm_sse_emit_failed');
      }
    }

    // Telegram forward if recipient is admin
    try {
      const otherIds = participantIds.filter(id => id !== senderId);
      for (const otherId of otherIds) {
        const u = await pool.query(`SELECT role::text FROM users WHERE id::text = $1`, [otherId]);
        if (u.rows[0]?.role === 'admin' || u.rows[0]?.role === 'superadmin') {
          await forwardToTelegramIfAdmin('admin', senderName || senderId, text);
          break;
        }
      }
    } catch (err) {
      log.warn({ err, conversationId }, 'admin_telegram_forward_failed');
    }

    return c.json({
      success: true,
      message: {
        id: msgId, conversationId,
        senderId, senderName, senderRole,
        text: text.trim(),
        attachment,
        createdAt,
      },
    });
  } catch (err: any) {
    console.error('POST /messages error:', err);
    return c.json({ success: false, error: err.message || String(err) }, 500);
  }
});

// ── PUT /messages/:conversationId/read ──

app.put('/messages/:conversationId/read', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  const authUserId = c.get('userId');
  try {
    // Verify membership
    const conv = await pool.query(
      `SELECT participant_ids FROM dm_conversations WHERE id = $1`,
      [conversationId]
    );
    if (conv.rows.length === 0) {
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    }
    if (!conv.rows[0].participant_ids.includes(authUserId)) {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }

    // Mark all messages from OTHERS as read
    await pool.query(
      `UPDATE dm_messages SET is_read = true, read_at = NOW()
       WHERE conversation_id = $1 AND sender_id != $2 AND is_read = false`,
      [conversationId, authUserId]
    );
    // Clear unread counter for this user/conv
    await pool.query(
      `UPDATE dm_unread SET unread_count = 0, updated_at = NOW()
       WHERE user_id = $1 AND conversation_id = $2`,
      [authUserId, conversationId]
    );

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || String(err) }, 500);
  }
});

// ── GET /unread/:userId ──

app.get('/unread/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const authUserId = c.get('userId');
  if (authUserId !== userId) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
  try {
    const r = await pool.query(
      `SELECT conversation_id, unread_count FROM dm_unread WHERE user_id = $1 AND unread_count > 0`,
      [userId]
    );
    const byConv: Record<string, number> = {};
    let total = 0;
    for (const row of r.rows) {
      byConv[row.conversation_id] = parseInt(row.unread_count);
      total += parseInt(row.unread_count);
    }
    return c.json({ success: true, total, byConv });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || String(err) }, 500);
  }
});

// ── PUT /messages/:messageId/edit (edit text) ──

app.put('/messages/:messageId/edit', requireAuth, async (c) => {
  const messageId = c.req.param('messageId');
  const authUserId = c.get('userId');
  try {
    const { text } = await c.req.json();
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return c.json({ success: false, error: 'Empty text' }, 400);
    }
    const r = await pool.query(
      `UPDATE dm_messages SET content = $1 WHERE id = $2 AND sender_id = $3 RETURNING id, conversation_id`,
      [text.trim(), messageId, authUserId]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Not found or not your message' }, 404);
    }
    return c.json({ success: true, messageId, conversationId: r.rows[0].conversation_id });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || String(err) }, 500);
  }
});

// ── DELETE /messages/:conversationId/:messageId ──

app.delete('/messages/:conversationId/:messageId', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  const messageId = c.req.param('messageId');
  const authUserId = c.get('userId');
  try {
    const r = await pool.query(
      `DELETE FROM dm_messages WHERE id = $1 AND conversation_id = $2 AND sender_id = $3 RETURNING id`,
      [messageId, conversationId, authUserId]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Not found or not your message' }, 404);
    }
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || String(err) }, 500);
  }
});

// ── POST /typing/:conversationId — fire-and-forget SSE ──

app.post('/typing/:conversationId', requireAuth, async (c) => {
  const conversationId = c.req.param('conversationId');
  const authUserId = c.get('userId');
  try {
    const conv = await pool.query(
      `SELECT participant_ids FROM dm_conversations WHERE id = $1`,
      [conversationId]
    );
    if (conv.rows[0]) {
      const others = (conv.rows[0].participant_ids || []).filter((id: string) => id !== authUserId);
      for (const other of others) {
        try {
          emitSSE(other, { type: 'dm_typing', data: { conversationId, userId: authUserId } });
        } catch (err) {
          log.warn({ err, other, conversationId }, 'typing_sse_emit_failed');
        }
      }
    }
  } catch (err) {
    log.warn({ err, conversationId }, 'typing_lookup_failed');
  }
  return c.json({ success: true });
});

// ── GET /presence/:userId ──

app.get('/presence/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  // Best-effort presence (no DB) — return basic shape so UI doesn't error
  return c.json({ success: true, userId, online: false, lastSeenAt: null });
});

// ── GET /rules — communication matrix for FE ──

app.get('/rules', (c) => {
  return c.json({ success: true, allowedContacts: ALLOWED_CONTACTS, roleLabels: ROLE_LABELS });
});

// ── POST /presence — heartbeat (no-op) ──

app.post('/presence', requireAuth, (c) => c.json({ success: true }));

// ── GET /search-contacts ──

app.get('/search-contacts', requireAuth, async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const role = c.req.query('role') || '';
  const authRole = c.get('userRole');
  const authUserId = c.get('userId');
  if (!q) return c.json({ success: true, contacts: [] });

  const contacts: Participant[] = [];
  try {
    const allowed = ALLOWED_CONTACTS[mapRole(authRole)] || [];
    const params: any[] = [`%${q}%`];
    let where = `(LOWER(u.full_name) LIKE $1 OR LOWER(u.email) LIKE $1)`;
    if (role && allowed.includes(role as CabinetRole)) {
      where += ` AND u.role::text = $2`;
      params.push(role === 'radio' ? 'radio_station' : role);
    } else {
      // Restrict to allowed roles
      const dbRoles = allowed.map(r => r === 'radio' ? 'radio_station' : r);
      if (dbRoles.length > 0) {
        where += ` AND u.role::text = ANY($2)`;
        params.push(dbRoles);
      }
    }
    const r = await pool.query(
      `SELECT u.id, u.full_name, u.role::text, u.avatar_url
       FROM users u WHERE ${where} AND u.status = 'active' LIMIT 25`,
      params
    );

    // Drop users who either blocked the searcher or were blocked by
    // them. Done in JS after the SELECT to keep the query plain — at
    // LIMIT 25 the post-filter is cheap; if results ever start
    // exceeding 100 rows we'd move this to a NOT EXISTS join.
    const blockedSet = await getBlocksTouching(String(authUserId));

    for (const u of r.rows) {
      if (blockedSet.has(String(u.id))) continue;
      contacts.push({
        userId: u.id,
        userName: u.full_name || u.id,
        role: mapRole(u.role),
        avatar: u.avatar_url || undefined,
      });
    }
  } catch (err: any) {
    console.error('search-contacts error:', err);
  }
  return c.json({ success: true, contacts });
});

// ── Blocks ──
//
// Schema in migration 022. Block semantics:
//   - One row per (blocker_id, blocked_id) pair (DB-level PK).
//   - Applied symmetrically by every consumer (search, create, send).
//   - History remains readable on both sides — `GET /conversations`
//     and `GET /messages/:id` still serve previously exchanged
//     messages. New outbound is what's gated.
//
// «Reports» (POST /reports) is intentionally separate: a user may
// want to file a report without blocking (e.g. flag a public
// figure), or block without escalating to admin.

// GET /blocks — list everyone the auth user has blocked.
app.get('/blocks', requireAuth, async (c) => {
  try {
    const authUserId = c.get('userId');
    const r = await pool.query(
      `SELECT blocked_id, reason, created_at
         FROM dm_blocks WHERE blocker_id = $1
        ORDER BY created_at DESC`,
      [String(authUserId)]
    );
    const blocks = await Promise.all(
      r.rows.map(async (row: any) => ({
        ...(await getParticipantInfo(String(row.blocked_id))),
        reason: row.reason || null,
        createdAt: row.created_at?.toISOString?.() || row.created_at,
      }))
    );
    return c.json({ success: true, blocks });
  } catch (err: any) {
    log.error({ err }, 'blocks_list_failed');
    return c.json({ success: false, error: 'Не удалось загрузить список блокировок' }, 500);
  }
});

// POST /blocks/:userId — block a counterparty. Idempotent.
app.post('/blocks/:userId', requireAuth, async (c) => {
  try {
    const authUserId = String(c.get('userId'));
    const blockedId = c.req.param('userId');
    if (!blockedId || blockedId === authUserId) {
      return c.json({ success: false, error: 'Нельзя заблокировать самого себя' }, 400);
    }
    const { reason } = await c.req.json().catch(() => ({})) as { reason?: string };
    await pool.query(
      `INSERT INTO dm_blocks (blocker_id, blocked_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id) DO UPDATE
         SET reason = COALESCE(EXCLUDED.reason, dm_blocks.reason)`,
      [authUserId, blockedId, reason || null]
    );
    log.info({ blockerId: authUserId, blockedId }, 'dm_block_created');
    return c.json({ success: true });
  } catch (err: any) {
    log.error({ err }, 'block_create_failed');
    return c.json({ success: false, error: 'Не удалось заблокировать' }, 500);
  }
});

// DELETE /blocks/:userId — unblock. Idempotent (no row → still 200).
app.delete('/blocks/:userId', requireAuth, async (c) => {
  try {
    const authUserId = String(c.get('userId'));
    const blockedId = c.req.param('userId');
    await pool.query(
      `DELETE FROM dm_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [authUserId, blockedId]
    );
    log.info({ blockerId: authUserId, blockedId }, 'dm_block_removed');
    return c.json({ success: true });
  } catch (err: any) {
    log.error({ err }, 'block_delete_failed');
    return c.json({ success: false, error: 'Не удалось снять блокировку' }, 500);
  }
});

// POST /reports — file an abuse report for admin review.
// Body: { reportedId, category?, details?, messageId? }
// Per-reporter rate limit: max 20 reports/hour.
app.post('/reports', requireAuth, async (c) => {
  try {
    const authUserId = String(c.get('userId'));
    const { reportedId, category, details, messageId } = await c.req.json() as {
      reportedId: string;
      category?: string;
      details?: string;
      messageId?: string;
    };
    if (!reportedId || reportedId === authUserId) {
      return c.json({ success: false, error: 'Некорректный отчёт' }, 400);
    }
    const allowedCategories = new Set(['spam', 'abuse', 'impersonation', 'other']);
    const cat = allowedCategories.has(String(category)) ? String(category) : 'other';

    // Rate limit — 20 reports per rolling hour
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM dm_reports
        WHERE reporter_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [authUserId]
    );
    if (Number(recent.rows[0]?.n) >= 20) {
      return c.json({ success: false, error: 'Слишком много жалоб за последний час' }, 429);
    }

    const ins = await pool.query(
      `INSERT INTO dm_reports (reporter_id, reported_id, message_id, category, details)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [authUserId, reportedId, messageId || null, cat, (details || '').slice(0, 2000) || null]
    );
    log.info({ reporterId: authUserId, reportedId, category: cat }, 'dm_report_filed');
    return c.json({
      success: true,
      report: { id: ins.rows[0].id, createdAt: ins.rows[0].created_at },
    });
  } catch (err: any) {
    log.error({ err }, 'report_create_failed');
    return c.json({ success: false, error: 'Не удалось отправить жалобу' }, 500);
  }
});

export default app;
