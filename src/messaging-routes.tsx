/**
 * MESSAGING ROUTES — DM между всеми кабинетами
 *
 * Native SQL (PostgreSQL). KV store удалён 2026-04-29.
 *
 * Tables:
 *   dm_conversations (id, participant_ids text[], last_message_text, last_message_at, data jsonb)
 *   dm_messages (id, conversation_id, sender_id, content, message_type, is_read, read_at, created_at)
 *   dm_unread (user_id, conversation_id, unread_count, updated_at)
 *   dm_message_reactions (message_id, user_id, emoji, created_at)  — migration 024
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
 *   GET    /search-contacts
 *   POST   /messages/:messageId/reactions             — toggle emoji
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { emitSSE } from './sse-routes.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { createLogger } from './logger.tsx';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import crypto from 'node:crypto';

const log = createLogger('messaging');

// ── Attachment storage ──
//
// Uploaded files land under /opt/promofm-api/uploads/dm/{convId}/
// (configurable via UPLOADS_DIR), exposed as
// https://promo-music.ru/server/uploads/dm/{convId}/{file}.
//
// Per-conversation folder so the admin can spot which thread an
// orphan file belongs to without scanning the DB.
const DM_UPLOADS_BASE = process.env.UPLOADS_DIR || '/opt/promofm-api/uploads';
const DM_PUBLIC_BASE  = process.env.PUBLIC_UPLOADS_BASE_URL || 'https://promo-music.ru/server/uploads';
const DM_MAX_FILE_BYTES  = 50 * 1024 * 1024;   // 50 MiB — generous for audio + small video
const DM_MAX_VOICE_BYTES = 10 * 1024 * 1024;   // 10 MiB for voice (≈10 min webm/opus)
const DM_ALLOWED_MIME_PREFIXES = [
  'image/', 'audio/', 'video/', 'application/pdf',
  'application/zip', 'application/x-zip',
  'application/vnd.openxmlformats-officedocument',
  'application/msword', 'text/plain',
];

function pickExt(filename: string, mime: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename || '');
  if (m) return m[1].toLowerCase();
  // Fallbacks by MIME for files that arrived without a sane name
  // (looking at MediaRecorder blobs especially).
  if (mime === 'audio/webm') return 'webm';
  if (mime === 'audio/mp4' || mime === 'audio/aac') return 'm4a';
  if (mime === 'audio/ogg') return 'ogg';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'application/pdf') return 'pdf';
  return 'bin';
}

function classifyMessageType(mime: string, isVoice: boolean): string {
  if (isVoice) return 'voice';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

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
// All music-supply-chain cabinet roles are mutually addressable
// (artist ↔ producer ↔ dj ↔ engineer ↔ label ↔ venue ↔ admin).
// The DM surface is the «соцсеть внутри платформы».
//
// **Radio is intentionally NOT in the DM graph.** Radio-station
// communication with creators flows through the pitching pipeline
// (`pitching-routes.tsx`), which carries the track + cover + rate
// + structured reply state — a proper submission flow, not a raw
// chat. Radio users still have an inbox for legacy threads, but
// new conversations involving radio cannot be created and radio
// users cannot find anyone in `/search-contacts`.
//
// History of this rule:
//   1. Initial launch: `radio: ['admin', 'venue']`, others didn't
//      list radio.
//   2. 2026-05-25 morning: opened radio fully ('симметричная
//      соцсеть') under a misread of the brief.
//   3. 2026-05-25 evening (this commit): reverted — radio fully
//      out of the graph per explicit product direction
//      («Радио — НЕ в графе»).
const DM_GRAPH_ROLES: CabinetRole[] = [
  'artist', 'producer', 'dj', 'engineer', 'label', 'venue', 'admin',
];
const ALLOWED_CONTACTS: Record<CabinetRole, CabinetRole[]> = {
  artist:   DM_GRAPH_ROLES,
  producer: DM_GRAPH_ROLES,
  dj:       DM_GRAPH_ROLES,
  engineer: DM_GRAPH_ROLES,
  label:    DM_GRAPH_ROLES,
  venue:    DM_GRAPH_ROLES,
  admin:    DM_GRAPH_ROLES,
  // Empty list = radio cannot initiate new DMs and is filtered
  // out of every other role's allowed set. The pitching pipeline
  // is the supported channel for radio↔creator communication.
  radio:    [],
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
              u.full_name as sender_name, u.role::text as sender_role,
              -- Aggregate reactions per emoji into the shape the FE
              -- already expects (Message.reactions on messages-page.tsx):
              --   [{ emoji, count, users: [userId, ...] }]
              -- LEFT JOIN + json_agg keeps the query plan flat; at
              -- typical message volumes (<5k per conv) the overhead
              -- is single-digit ms.
              COALESCE((
                SELECT json_agg(json_build_object(
                  'emoji', re.emoji,
                  'count', re.cnt,
                  'users', re.users
                ))
                FROM (
                  SELECT emoji, COUNT(*)::int AS cnt, json_agg(user_id) AS users
                    FROM dm_message_reactions
                   WHERE message_id = m.id::text
                  GROUP BY emoji
                ) re
              ), '[]'::json) AS reactions
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
      reactions: m.reactions || [],
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
    // Empty allowlist (currently: radio) → return nothing instead
    // of falling through to a name-only LIKE that would expose every
    // user on the platform. Caught when radio was reverted out of
    // the DM graph on 2026-05-25 — the old code had no else-branch
    // for the empty case.
    if (allowed.length === 0) {
      return c.json({ success: true, contacts: [] });
    }
    const params: any[] = [`%${q}%`];
    let where = `(LOWER(u.full_name) LIKE $1 OR LOWER(u.email) LIKE $1)`;
    if (role && allowed.includes(role as CabinetRole)) {
      where += ` AND u.role::text = $2`;
      params.push(role === 'radio' ? 'radio_station' : role);
    } else {
      // Restrict to allowed roles. Always emit the ANY($2) filter so
      // a searcher who hasn't picked a role chip still can't see
      // anyone outside their allowed set.
      const dbRoles = allowed.map(r => r === 'radio' ? 'radio_station' : r);
      where += ` AND u.role::text = ANY($2)`;
      params.push(dbRoles);
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

// ── Message reactions ──
//
// Schema in migration 024. Reactions are toggled per (message,
// user, emoji): POSTing the same emoji twice on the same message
// removes it (Telegram/WA behaviour). The full emoji set is open
// — backend accepts anything ≤16 chars (covers ZWJ sequences like
// 👨‍🦰 which can hit ~14 bytes). FE pickers gate the menu down to
// a curated set.

// POST /messages/:messageId/reactions — toggle one emoji.
// Body: { emoji }
//
// Verifies the caller is a participant of the message's
// conversation before accepting the reaction (no «reacting from
// outside»).
app.post('/messages/:messageId/reactions', requireAuth, async (c) => {
  const messageId = c.req.param('messageId');
  try {
    const authUserId = String(c.get('userId'));
    const { emoji } = await c.req.json() as { emoji: string };
    if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 16) {
      return c.json({ success: false, error: 'Invalid emoji' }, 400);
    }

    // 1. Find the message + its conv to verify access.
    const m = await pool.query(
      `SELECT m.id::text AS id, m.conversation_id, c.participant_ids
         FROM dm_messages m
         JOIN dm_conversations c ON c.id = m.conversation_id
        WHERE m.id::text = $1
        LIMIT 1`,
      [messageId]
    );
    if (m.rows.length === 0) {
      return c.json({ success: false, error: 'Message not found' }, 404);
    }
    const participantIds: string[] = m.rows[0].participant_ids || [];
    if (!participantIds.includes(authUserId)) {
      return c.json({ success: false, error: 'Access denied: not a participant' }, 403);
    }
    const conversationId = m.rows[0].conversation_id;
    const normMessageId = m.rows[0].id;

    // 2. Toggle: DELETE returns count, INSERT only if nothing
    //    deleted. Two round-trips but each is sub-ms.
    const del = await pool.query(
      `DELETE FROM dm_message_reactions
        WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [normMessageId, authUserId, emoji]
    );
    let action: 'added' | 'removed';
    if (del.rowCount && del.rowCount > 0) {
      action = 'removed';
    } else {
      await pool.query(
        `INSERT INTO dm_message_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [normMessageId, authUserId, emoji]
      );
      action = 'added';
    }

    // 3. Re-aggregate this message's reactions so the FE can hot-
    //    swap without re-fetching the entire message list.
    const agg = await pool.query(
      `SELECT json_agg(json_build_object(
                'emoji', emoji, 'count', cnt, 'users', users
              )) AS reactions
         FROM (
           SELECT emoji, COUNT(*)::int AS cnt, json_agg(user_id) AS users
             FROM dm_message_reactions
            WHERE message_id = $1
           GROUP BY emoji
         ) re`,
      [normMessageId]
    );
    const reactions = agg.rows[0]?.reactions || [];

    log.info({ messageId: normMessageId, userId: authUserId, emoji, action }, 'dm_reaction_toggled');

    // 4. Push SSE so other tabs / participants see the bump live.
    for (const pid of participantIds) {
      emitSSE(pid, {
        type: 'dm_reaction_updated',
        data: { conversationId, messageId: normMessageId, reactions },
      });
    }

    return c.json({ success: true, action, reactions });
  } catch (err: any) {
    log.error({ err, messageId }, 'reaction_toggle_failed');
    return c.json({ success: false, error: 'Не удалось сохранить реакцию' }, 500);
  }
});

export default app;
