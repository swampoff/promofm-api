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
 *   PUT    /conversations/:id                          — rename group (creator)
 *   DELETE /conversations/:id/participants/me         — leave group
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
 *   GET    /admin/reports                              — admin queue
 *   POST   /admin/reports/:id/resolve                  — admin close
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { emitSSE } from './sse-routes.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
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
          isGroup: Boolean(row.data?.isGroup) || (participants.length > 2),
          title: row.data?.title || null,
          creatorId: row.data?.creatorId || null,
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
    const { participants, source, collabOfferId, title } = await c.req.json() as {
      participants: Participant[];
      source?: 'direct' | 'collab' | 'support';
      collabOfferId?: string;
      title?: string;
    };

    if (!participants || participants.length < 2) {
      return c.json({ success: false, error: 'At least 2 participants required' }, 400);
    }

    const authUserId = c.get('userId');
    if (!participants.some(p => p.userId === authUserId)) {
      return c.json({ success: false, error: 'Access denied: you must be a participant' }, 403);
    }

    // Two-party conversation: keep the deterministic «userA::userB»
    // ID so repeated creates collapse to the same row, the original
    // behaviour. Three-or-more participants → group chat, gets a
    // fresh UUID per creation (groups aren't deduplicated by member
    // set — calling «create group» twice with the same people
    // makes two distinct groups, matching every other messenger).
    const isGroup = participants.length > 2;
    const groupTitle = isGroup ? String(title || '').slice(0, 120).trim() || undefined : undefined;

    // Every pair must be allowed to communicate. For 2-party this
    // is one check; for groups every initiator↔member pair gates.
    // Returns the FIRST offending pair so the FE can surface a
    // useful message.
    //
    // Block-list checks live in the chat-blocks branch
    // (`getBlockedPair` / `getBlocksTouching`) — when both branches
    // are on main the check applies here too. For groups it's
    // intentionally not applied between two non-initiator members
    // (X+Y+Z is allowed if the initiator X hasn't blocked Y or Z,
    // even if Y has blocked Z — Y just stays quiet), matching
    // Telegram/WhatsApp group semantics.
    for (let i = 0; i < participants.length; i++) {
      const a = participants[i];
      for (let j = i + 1; j < participants.length; j++) {
        const b = participants[j];
        if (!canCommunicate(a.role, b.role)) {
          const labelA = ROLE_LABELS[a.role] || a.role;
          const labelB = ROLE_LABELS[b.role] || b.role;
          return c.json({
            success: false,
            error: `${labelA} не может отправлять сообщения роли ${labelB}`,
            code: 'COMMUNICATION_RESTRICTED',
          }, 403);
        }
      }
    }

    const participantIds = participants.map(p => p.userId);

    if (!isGroup) {
      // 2-party: deterministic ID, dedupe via existing-row check.
      const convId = makeConvId(participants[0].userId, participants[1].userId);
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
            isGroup: false,
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
          isGroup: false,
        },
        created: true,
      });
    }

    // Group chat: fresh UUID, store title in `data` jsonb. Cap at 50
    // participants — generous default, prevents pathological invites
    // until we ship proper invite-link infra.
    if (participants.length > 50) {
      return c.json({
        success: false,
        error: 'Группа не может содержать более 50 участников',
      }, 400);
    }
    const groupId = crypto.randomUUID();
    const groupData = {
      source: source || 'direct',
      collabOfferId,
      isGroup: true,
      title: groupTitle || null,
      creatorId: authUserId,
    };
    await pool.query(
      `INSERT INTO dm_conversations (id, participant_ids, last_message_text, last_message_at, data, created_at)
       VALUES ($1, $2, '', NOW(), $3::jsonb, NOW())`,
      [groupId, participantIds, JSON.stringify(groupData)]
    );
    log.info({ groupId, creatorId: authUserId, count: participants.length }, 'dm_group_created');

    return c.json({
      success: true,
      conversation: {
        id: groupId, participants,
        source: source || 'direct',
        collabOfferId,
        createdAt: new Date().toISOString(),
        isGroup: true,
        title: groupTitle || null,
        creatorId: authUserId,
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

    // Bell-уведомления для всех non-sender участников + Telegram forward к админам.
    // Симметрично: artist→dj, admin→artist, etc. — у каждого recipient
    // загорится колокольчик. Dedup-окно 5 мин по (target+type+title)
    // гасит spam при шквале сообщений в одной беседе.
    try {
      const otherIds = participantIds.filter(id => id !== senderId);
      const { notifyCrossCabinet, notifyAllAdmins } = await import('./cross-cabinet-notify.tsx');
      const preview = text.trim().length > 120 ? text.trim().slice(0, 117) + '...' : text.trim();
      let adminFound = false;
      for (const otherId of otherIds) {
        const u = await pool.query(`SELECT role::text FROM users WHERE id::text = $1`, [otherId]);
        const role = (u.rows[0]?.role || 'artist') as
          'artist' | 'dj' | 'admin' | 'radio' | 'venue' | 'producer' | 'label';
        if (role === 'admin' || (u.rows[0]?.role === 'superadmin')) {
          adminFound = true;
          await forwardToTelegramIfAdmin('admin', senderName || senderId, text);
          // Админам — через notifyAllAdmins (он выбирает всех с role admin/superadmin)
          continue;
        }
        // Обычные кабинеты — точечно
        try {
          await notifyCrossCabinet({
            targetUserId: otherId,
            targetRole: role,
            sourceRole: (senderRole as any) || 'artist',
            type: 'new_direct_message',
            title: `Сообщение от ${senderName || 'пользователя'}`.slice(0, 200),
            message: preview,
            link: `/profile?tab=messages&conversation=${conversationId}`,
            metadata: { conversationId, messageId: msgId, senderId },
          });
        } catch (bellErr) {
          log.warn({ err: bellErr, recipient: otherId, conversationId }, 'recipient_bell_notify_failed');
        }
      }
      if (adminFound) {
        try {
          await notifyAllAdmins({
            sourceRole: (senderRole as any) || 'artist',
            type: 'new_direct_message',
            title: `Сообщение от ${senderName || 'пользователя'}`.slice(0, 200),
            message: preview,
            link: `/ctrl-pm7k2f?tab=messages&conversation=${conversationId}`,
            metadata: { conversationId, messageId: msgId, senderId },
          });
        } catch (bellErr) {
          log.warn({ err: bellErr, conversationId }, 'admin_bell_notify_failed');
        }
      }
    } catch (err) {
      log.warn({ err, conversationId }, 'dm_bell_or_telegram_failed');
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

// ── GET /blocks — список юзеров, которых я заблокировал ──
//
// Header doc обещал этот endpoint, но реализации не было — фронт-bell
// дёргал и получал 404 (17 hits/period в admin-телеметрии). Возвращаем
// просто массив blocked_id'ов для текущего юзера, чтобы UI мог скрывать
// заблокированных в поиске и в инициаторах диалога.
app.get('/blocks', requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId') || '');
    const { rows } = await pool.query(
      `SELECT blocked_id, reason, created_at
         FROM dm_blocks
        WHERE blocker_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );
    return c.json({
      success: true,
      blocks: rows.map((r: any) => ({
        blockedId: String(r.blocked_id),
        reason: r.reason || '',
        createdAt: r.created_at,
      })),
    });
  } catch (err: any) {
    log.error({ err }, 'messaging_blocks_failed');
    return c.json({ success: true, blocks: [] });
  }
});

// ── GET /admin/reports — очередь жалоб для админа ──
//
// Аналогично /blocks — был задокументирован в header'е, но не
// зарегистрирован (2 hits/period). Возвращаем последние pending
// reports + опционально все по статусу (?status=actioned).
app.get('/admin/reports', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'pending';
    const limit = Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 500);
    const params: any[] = [];
    let where = '';
    if (status !== 'all') {
      params.push(status);
      where = `WHERE status = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, reporter_id, reported_id, message_id, category, details, status,
              reviewer_id, reviewed_at, resolution, created_at
         FROM dm_reports
         ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    return c.json({
      success: true,
      reports: rows.map((r: any) => ({
        id: String(r.id),
        reporterId: String(r.reporter_id),
        reportedId: String(r.reported_id),
        messageId: r.message_id ? String(r.message_id) : null,
        category: r.category,
        details: r.details || '',
        status: r.status,
        reviewerId: r.reviewer_id ? String(r.reviewer_id) : null,
        reviewedAt: r.reviewed_at,
        resolution: r.resolution || '',
        createdAt: r.created_at,
      })),
    });
  } catch (err: any) {
    log.error({ err }, 'messaging_admin_reports_failed');
    return c.json({ success: true, reports: [] });
  }
});

// ── POST /presence — heartbeat (no-op) ──

app.post('/presence', requireAuth, (c) => c.json({ success: true }));

// ── GET /search-contacts ──

app.get('/search-contacts', requireAuth, async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const role = c.req.query('role') || '';
  const authRole = c.get('userRole');
  const authUserId = c.get('userId');
  // Default 25 для совместимости (mobile inbox), max 200 для desktop browse.
  // Caller передаёт ?limit=200 чтобы видеть полный list.
  const requestedLimit = parseInt(c.req.query('limit') || '25', 10);
  const limit = Math.max(1, Math.min(200, isNaN(requestedLimit) ? 25 : requestedLimit));

  const contacts: Participant[] = [];
  try {
    const allowed = ALLOWED_CONTACTS[mapRole(authRole)] || [];
    // Empty allowlist (currently: radio) → return nothing instead
    // of falling through to a name-only LIKE that would expose every
    // user on the platform.
    if (allowed.length === 0) {
      return c.json({ success: true, contacts: [] });
    }
    // ── Browse mode ──
    // Раньше: if (!q) return [] — пустой запрос всегда отдавал ничего,
    // и юзер не понимал что есть 140+ зарегистрированных людей. Теперь
    // пустой q выдаёт первых 25 свежих юзеров allowed-set (или roleChip
    // если выбран). LIKE-фильтр включается только когда q непустой.
    const hasQ = q.length > 0;
    const params: any[] = [];
    let where = '';
    if (hasQ) {
      params.push(`%${q}%`);
      where = `(LOWER(u.full_name) LIKE $1 OR LOWER(u.email) LIKE $1)`;
    }
    if (role && allowed.includes(role as CabinetRole)) {
      params.push(role === 'radio' ? 'radio_station' : role);
      where = (where ? where + ' AND ' : '') + `u.role::text = $${params.length}`;
    } else {
      const dbRoles = allowed.map(r => r === 'radio' ? 'radio_station' : r);
      params.push(dbRoles);
      where = (where ? where + ' AND ' : '') + `u.role::text = ANY($${params.length})`;
    }
    // С поиском — порядок не критичен (LIMIT 25 хватает). В browse-режиме
    // — свежие регистрации сверху чтобы новички быстро находились.
    const orderBy = hasQ ? '' : 'ORDER BY u.created_at DESC';
    params.push(limit);
    const r = await pool.query(
      // password_hash IS NOT NULL гейт: legacy-импортированные артисты
      // (2250 строк, 2026-05-28) видны в чате ТОЛЬКО после активации
      // (когда сами поставят пароль через /reset-password). До этого —
      // невидимы, как и любой не активированный кабинет.
      `SELECT u.id, u.full_name, u.role::text, u.avatar_url
       FROM users u WHERE ${where}
         AND u.status = 'active'
         AND u.password_hash IS NOT NULL
         ${orderBy} LIMIT $${params.length}`,
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

// POST /conversations/:id/participants — creator adds a new member
// to an existing group. Body: { participant: { userId, userName, role } }.
//
// Validation:
//   - Conv exists and is a group (data.isGroup truthy).
//   - Caller is the creator (data.creatorId === authUserId).
//   - Target user isn't already in the group (idempotent — returns
//     200 with `added: false`).
//   - canCommunicate() holds for every existing-member ↔ new-member
//     pair (radio still out of the graph).
//   - Hard cap of 50 participants (matches POST /conversations).
//
// Side effects:
//   - Appends to participant_ids.
//   - Writes a system message «X добавил(а) Y в группу».
//   - Emits SSE `dm_participant_added` to every existing participant
//     AND the new one (so their conv list refreshes).
app.post('/conversations/:id/participants', requireAuth, async (c) => {
  const conversationId = c.req.param('id');
  try {
    const authUserId = String(c.get('userId'));
    const { participant } = await c.req.json() as { participant: Participant };
    if (!participant?.userId || !participant?.role) {
      return c.json({ success: false, error: 'participant.userId + role required' }, 400);
    }

    const conv = await pool.query(
      `SELECT participant_ids, data FROM dm_conversations WHERE id = $1`,
      [conversationId]
    );
    if (conv.rows.length === 0) {
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    }
    const participantIds: string[] = conv.rows[0].participant_ids || [];
    const data = conv.rows[0].data || {};
    if (!data.isGroup) {
      return c.json({
        success: false,
        error: 'Добавлять участников можно только в группы',
        code: 'NOT_A_GROUP',
      }, 400);
    }
    if (!participantIds.includes(authUserId)) {
      return c.json({ success: false, error: 'Access denied: not a participant' }, 403);
    }
    if (data.creatorId && data.creatorId !== authUserId) {
      return c.json({
        success: false,
        error: 'Только создатель группы может добавлять участников',
      }, 403);
    }
    if (participantIds.includes(participant.userId)) {
      return c.json({ success: true, added: false, alreadyMember: true });
    }
    if (participantIds.length >= 50) {
      return c.json({
        success: false,
        error: 'Группа уже содержит 50 участников',
      }, 400);
    }

    // Validate every existing-member ↔ new-member pair against the
    // communication matrix. We need each existing member's role —
    // hydrate cheaply via getParticipantInfo.
    const existing = await Promise.all(participantIds.map(uid => getParticipantInfo(uid)));
    for (const exMember of existing) {
      if (!canCommunicate(exMember.role, participant.role)) {
        const labelA = ROLE_LABELS[exMember.role] || exMember.role;
        const labelB = ROLE_LABELS[participant.role] || participant.role;
        return c.json({
          success: false,
          error: `${labelA} не может переписываться с ролью ${labelB} — добавление отклонено`,
          code: 'COMMUNICATION_RESTRICTED',
        }, 403);
      }
    }

    const newParticipantIds = [...participantIds, participant.userId];
    await pool.query(
      `UPDATE dm_conversations SET participant_ids = $1 WHERE id = $2`,
      [newParticipantIds, conversationId]
    );

    // System message — best-effort; the membership change has already
    // committed. Failure here is logged but doesn't roll back.
    try {
      const adderRow = await pool.query(
        `SELECT full_name FROM users WHERE id::text = $1 LIMIT 1`,
        [authUserId]
      );
      const adderName = adderRow.rows[0]?.full_name || 'Создатель';
      const targetName = participant.userName || 'участник';
      await pool.query(
        `INSERT INTO dm_messages (conversation_id, sender_id, content, message_type, is_read, created_at)
         VALUES ($1, $2, $3, 'system', false, NOW())`,
        [conversationId, authUserId, `${adderName} добавил(а) ${targetName} в группу`]
      );
    } catch (sysErr) {
      log.warn({ err: sysErr, conversationId }, 'add_participant_system_message_failed');
    }

    log.info({ conversationId, addedBy: authUserId, addedId: participant.userId }, 'dm_group_participant_added');

    for (const pid of newParticipantIds) {
      emitSSE(pid, {
        type: 'dm_participant_added',
        data: { conversationId, participant },
      });
    }

    return c.json({ success: true, added: true, participantCount: newParticipantIds.length });
  } catch (err: any) {
    log.error({ err, conversationId }, 'add_participant_failed');
    return c.json({ success: false, error: 'Не удалось добавить участника' }, 500);
  }
});

export default app;
