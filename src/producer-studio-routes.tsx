/**
 * PRODUCER STUDIO ROUTES
 * Маршруты для реальных сообщений (SQL Store) и календаря сессий
 * Stores (from db.tsx):
 *   producerConvsStore          → producer_convs table (pk: user_id)
 *   producerMessagesStore       → producer_messages table (pk: user_id)
 *   producerSessionsStore       → producer_sessions table (pk: user_id)
 *   producerCustomServicesStore → producer_custom_services table (pk: user_id)
 *   producerCustomPortfolioStore→ producer_custom_portfolio table (pk: user_id)
 *   paymentWithdrawalsStore     → payment_withdrawals table (pk: user_id)
 *   producerSettingsStore       → producer_settings table (pk: user_id)
 *   producerProfileEditStore    → producer_profile_edit table (pk: user_id)
 *   producerAiLastStore         → producer_ai_last table (pk: user_id)
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import {
  paymentWithdrawalsStore,
  producerAiLastStore,
  producerConvsStore,
  producerCustomPortfolioStore,
  producerCustomServicesStore,
  producerMessagesStore,
  producerProfileEditStore,
  producerSessionsStore,
  producerSettingsStore,
} from './db.tsx';
import { getDbClient } from "./db-client.tsx";
import { requireAuth } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

// ════════════════════════════════════════
// TYPES
// ════════════════════════════════════════

interface Message {
  id: string;
  text: string;
  sender: 'producer' | 'client';
  timestamp: string;      // ISO
  read: boolean;
  attachment?: { type: 'audio' | 'image' | 'file'; name: string };
}

interface ConversationMeta {
  id: string;
  producerId: string;
  clientName: string;
  clientInitial: string;
  orderTitle: string;
  orderId: string;
  lastMessage: string;
  lastTime: string;       // HH:mm
  unread: number;
  online: boolean;
  createdAt: string;      // ISO
}

interface CalendarSession {
  id: string;
  producerId: string;
  title: string;
  clientName: string;
  clientId?: string;
  date: string;           // YYYY-MM-DD
  startTime: string;      // HH:mm
  endTime: string;        // HH:mm
  type: 'recording' | 'mixing' | 'mastering' | 'consultation' | 'other';
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled';
  notes?: string;
  color?: string;
  orderId?: string;
  createdAt: string;
}

// ════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function timeHHmm(): string {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}

// ════════════════════════════════════════
// CONVERSATIONS
// ════════════════════════════════════════

// GET /conversations/:producerId
app.get('/conversations/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const convs: ConversationMeta[] = await producerConvsStore.get(producerId) || [];
    return c.json({ success: true, data: convs });
  } catch (error) {
    console.log(`Error fetching conversations: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /conversations/create
app.post('/conversations/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get(userId); // IDOR fix
    const { clientName, orderTitle, orderId } = body;

    if (!producerId || !clientName) {
      return c.json({ success: false, error: 'producerId and clientName are required' }, 400);
    }

    const conv: ConversationMeta = {
      id: genId('conv'),
      producerId,
      clientName,
      clientInitial: clientName[0]?.toUpperCase() || '?',
      orderTitle: orderTitle || 'Новый диалог',
      orderId: orderId || '',
      lastMessage: '',
      lastTime: timeHHmm(),
      unread: 0,
      online: Math.random() > 0.4,
      createdAt: nowIso(),
    };

    const convs: ConversationMeta[] = await producerConvsStore.get(producerId) || [];
    convs.unshift(conv);
    await producerConvsStore.set(producerId, convs);

    // Create empty messages array
    await producerMessagesStore.set(conv.id, []);

    return c.json({ success: true, data: conv });
  } catch (error) {
    console.log(`Error creating conversation: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// MESSAGES
// ════════════════════════════════════════

// GET /messages/:conversationId
app.get('/messages/:conversationId', requireAuth, async (c) => {
  try {
    const convId = c.req.param('conversationId');
    const msgs: Message[] = await producerMessagesStore.get(convId) || [];
    return c.json({ success: true, data: msgs });
  } catch (error) {
    console.log(`Error fetching messages: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /messages/:conversationId/poll?since=<iso>
// Returns only messages after 'since' timestamp (for efficient polling)
app.get('/messages/:conversationId/poll', requireAuth, async (c) => {
  try {
    const convId = c.req.param('conversationId');
    const since = c.req.query('since') || '1970-01-01T00:00:00Z';
    const sinceTime = new Date(since).getTime();

    const msgs: Message[] = await producerMessagesStore.get(convId) || [];
    const newMsgs = msgs.filter(m => new Date(m.timestamp).getTime() > sinceTime);

    return c.json({ success: true, data: newMsgs, total: msgs.length });
  } catch (error) {
    console.log(`Error polling messages: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /messages/send
app.post('/messages/send', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { conversationId, producerId, text, sender, attachment } = body;

    if (!conversationId || !text || !sender) {
      return c.json({ success: false, error: 'conversationId, text, and sender are required' }, 400);
    }

    const msg: Message = {
      id: genId('msg'),
      text,
      sender,
      timestamp: nowIso(),
      read: false,
      ...(attachment ? { attachment } : {}),
    };

    // Append message
    const msgs: Message[] = await producerMessagesStore.get(conversationId) || [];
    msgs.push(msg);
    await producerMessagesStore.set(conversationId, msgs);

    // Update conversation meta
    if (producerId) {
      const convs: ConversationMeta[] = await producerConvsStore.get(producerId) || [];
      const idx = convs.findIndex(c => c.id === conversationId);
      if (idx >= 0) {
        convs[idx].lastMessage = text.length > 60 ? text.slice(0, 57) + '...' : text;
        convs[idx].lastTime = timeHHmm();
        if (sender === 'client') {
          convs[idx].unread = (convs[idx].unread || 0) + 1;
        }
        await producerConvsStore.set(producerId, convs);
      }
    }

    // Simulate client auto-reply after 3-8 seconds (only for producer messages)
    if (sender === 'producer') {
      setTimeout(async () => {
        try {
          const autoReplies = [
            'Отлично, спасибо!',
            'Понял, жду результат.',
            'Супер, мне нравится направление!',
            'Хорошо, договорились.',
            'Можно ещё уточнить один момент?',
            'Звучит здорово!',
            'Ок, буду на связи.',
          ];
          const reply: Message = {
            id: genId('msg'),
            text: autoReplies[Math.floor(Math.random() * autoReplies.length)],
            sender: 'client',
            timestamp: nowIso(),
            read: false,
          };
          const currentMsgs: Message[] = await producerMessagesStore.get(conversationId) || [];
          currentMsgs.push(reply);
          await producerMessagesStore.set(conversationId, currentMsgs);

          // Update conversation meta
          if (producerId) {
            const currentConvs: ConversationMeta[] = await producerConvsStore.get(producerId) || [];
            const convIdx = currentConvs.findIndex(c => c.id === conversationId);
            if (convIdx >= 0) {
              currentConvs[convIdx].lastMessage = reply.text;
              currentConvs[convIdx].lastTime = timeHHmm();
              currentConvs[convIdx].unread = (currentConvs[convIdx].unread || 0) + 1;
              await producerConvsStore.set(producerId, currentConvs);
            }
          }
        } catch (e) {
          console.log(`Auto-reply error: ${e}`);
        }
      }, 3000 + Math.random() * 5000);
    }

    return c.json({ success: true, data: msg });
  } catch (error) {
    console.log(`Error sending message: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /messages/read
app.post('/messages/read', requireAuth, async (c) => {
  try {
    const { conversationId, producerId } = await c.req.json();
    if (!conversationId) {
      return c.json({ success: false, error: 'conversationId required' }, 400);
    }

    // Mark all client messages as read
    const msgs: Message[] = await producerMessagesStore.get(conversationId) || [];
    let changed = false;
    for (const m of msgs) {
      if (m.sender === 'client' && !m.read) {
        m.read = true;
        changed = true;
      }
    }
    if (changed) await producerMessagesStore.set(conversationId, msgs);

    // Reset unread counter
    if (producerId) {
      const convs: ConversationMeta[] = await producerConvsStore.get(producerId) || [];
      const idx = convs.findIndex(c => c.id === conversationId);
      if (idx >= 0 && convs[idx].unread > 0) {
        convs[idx].unread = 0;
        await producerConvsStore.set(producerId, convs);
      }
    }

    return c.json({ success: true });
  } catch (error) {
    console.log(`Error marking read: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// FILE UPLOAD (Local Storage)
// ════════════════════════════════════════

const AUDIO_BUCKET = 'make-84730125-audio-files';

// POST /upload/audio - accepts base64 audio data, stores locally, returns signed URL
app.post('/upload/audio', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { fileName, base64Data, contentType } = body;

    if (!fileName || !base64Data) {
      return c.json({ success: false, error: 'fileName and base64Data are required' }, 400);
    }

    const dbClient = getDbClient();
    const mimeType = contentType || 'audio/webm';

    // Decode base64 to Uint8Array
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Ensure bucket exists
    try {
      const { data: buckets } = await dbClient.storage.listBuckets();
      const bucketExists = buckets?.some((b: any) => b.name === AUDIO_BUCKET);
      if (!bucketExists) {
        await dbClient.storage.createBucket(AUDIO_BUCKET, { public: false });
      }
    } catch (bucketErr: any) {
      console.warn('⚠️ listBuckets failed, attempting createBucket directly:', bucketErr?.message);
      try {
        await dbClient.storage.createBucket(AUDIO_BUCKET, { public: false });
      } catch {
        // Bucket may already exist - ignore
      }
    }

    // Generate unique path
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 7);
    const ext = fileName.split('.').pop() || 'webm';
    const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `producer-chat/${timestamp}_${random}_${sanitized}`;

    // Upload
    const { data, error: uploadError } = await dbClient.storage
      .from(AUDIO_BUCKET)
      .upload(storagePath, bytes, { contentType: mimeType, upsert: true });

    if (uploadError) {
      console.log(`Upload error: ${uploadError.message}`);
      return c.json({ success: false, error: `Upload failed: ${uploadError.message}` }, 500);
    }

    // Create signed URL (1 hour expiry)
    const { data: signedData, error: signedError } = await dbClient.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(storagePath, 3600);

    if (signedError) {
      console.log(`Signed URL error: ${signedError.message}`);
      return c.json({ success: false, error: `Signed URL failed: ${signedError.message}` }, 500);
    }

    return c.json({
      success: true,
      data: {
        url: signedData.signedUrl,
        path: storagePath,
        fileName,
        contentType: mimeType,
        size: bytes.length,
      },
    });
  } catch (error) {
    console.log(`Error uploading audio: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /upload/signed-url?path=<storagePath> - refresh signed URL for a stored file
app.get('/upload/signed-url', requireAuth, async (c) => {
  try {
    const storagePath = c.req.query('path');
    if (!storagePath) {
      return c.json({ success: false, error: 'path query param required' }, 400);
    }
    const dbClient = getDbClient();
    const { data, error } = await dbClient.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(storagePath, 3600);

    if (error) {
      return c.json({ success: false, error: safeErrorMessage(error) }, 500);
    }
    return c.json({ success: true, data: { url: data.signedUrl } });
  } catch (error) {
    console.log(`Error getting signed URL: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// PRODUCER SETTINGS (SQL Store persistence)
// ════════════════════════════════════════

interface ProducerSettings {
  emailNotifs: boolean;
  pushNotifs: boolean;
  soundNotifs: boolean;
  newOrderNotif: boolean;
  messageNotif: boolean;
  reviewNotif: boolean;
  payoutNotif: boolean;
  marketingNotif: boolean;
  workDays: boolean[];
  workStart: string;
  workEnd: string;
  timezone: string;
  autoReply: boolean;
  autoReplyText: string;
  vacationMode: boolean;
  profilePublic: boolean;
  showOnlineStatus: boolean;
  showLastSeen: boolean;
  twoFactorAuth: boolean;
  language: string;
  theme: string;
  density: string;
  minPayoutAmount: number;
  legalStatus: string;
  inn: string;
  updatedAt: string;
}

// GET /settings/:producerId
app.get('/settings/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const settings = await producerSettingsStore.get(producerId);
    return c.json({ success: true, data: settings || null });
  } catch (error) {
    console.log(`Error fetching settings: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /settings/:producerId
app.post('/settings/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const body = await c.req.json();
    const settings = {
      ...body,
      updatedAt: new Date().toISOString(),
    };
    await producerSettingsStore.set(producerId, settings);
    return c.json({ success: true, data: settings });
  } catch (error) {
    console.log(`Error saving settings: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// SERVICES CRUD
// ════════════════════════════════════════

interface CustomService {
  id: string; producerId: string; title: string; type: string;
  basePrice: number; description: string; deliveryDays: number;
  revisions: number; includes: string[]; status: 'active' | 'paused';
  orders: number; rating: number; createdAt: string;
}

app.post('/services/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get(userId); // IDOR fix
    const { title, type, basePrice, description, deliveryDays, revisions, includes } = body;
    if (!producerId || !title || !basePrice) return c.json({ success: false, error: 'producerId, title, basePrice required' }, 400);
    const svc: CustomService = { id: genId('svc'), producerId, title, type: type || 'mixing', basePrice: Number(basePrice), description: description || '', deliveryDays: Number(deliveryDays) || 5, revisions: Number(revisions) || 2, includes: includes || [], status: 'active', orders: 0, rating: 5.0, createdAt: nowIso() };
    const list: CustomService[] = await producerCustomServicesStore.get(producerId) || [];
    list.push(svc);
    await producerCustomServicesStore.set(producerId, list);
    return c.json({ success: true, data: svc });
  } catch (error) { console.log(`Error creating service: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.put('/services/update/:serviceId', requireAuth, async (c) => {
  try {
    const serviceId = c.req.param('serviceId');
    const body = await c.req.json();
    const { producerId } = body;
    if (!producerId) return c.json({ success: false, error: 'producerId required' }, 400);
    const list: CustomService[] = await producerCustomServicesStore.get(producerId) || [];
    const idx = list.findIndex(s => s.id === serviceId);
    if (idx < 0) return c.json({ success: false, error: 'Service not found' }, 404);
    for (const f of ['title','type','basePrice','description','deliveryDays','revisions','includes','status']) { if (body[f] !== undefined) (list[idx] as any)[f] = body[f]; }
    await producerCustomServicesStore.set(producerId, list);
    return c.json({ success: true, data: list[idx] });
  } catch (error) { console.log(`Error updating service: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.delete('/services/delete/:serviceId', requireAuth, async (c) => {
  try {
    const serviceId = c.req.param('serviceId');
    const producerId = c.req.query('producerId');
    if (!producerId) return c.json({ success: false, error: 'producerId required' }, 400);
    const list: CustomService[] = await producerCustomServicesStore.get(producerId) || [];
    const filtered = list.filter(s => s.id !== serviceId);
    if (filtered.length === list.length) return c.json({ success: false, error: 'Not found' }, 404);
    await producerCustomServicesStore.set(producerId, filtered);
    return c.json({ success: true });
  } catch (error) { console.log(`Error deleting service: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.get('/services/custom/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const list: CustomService[] = await producerCustomServicesStore.get(producerId) || [];
    return c.json({ success: true, data: list });
  } catch (error) { return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// ════════════════════════════════════════
// PORTFOLIO CRUD
// ════════════════════════════════════════

app.post('/portfolio/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get(userId); // IDOR fix
    const { title, artist, type, description } = body;
    if (!producerId || !title || !artist) return c.json({ success: false, error: 'producerId, title, artist required' }, 400);
    const entry = { id: genId('pf'), producerId, title, artist, type: type || 'Сведение', year: new Date().getFullYear(), description: description || '', createdAt: nowIso() };
    const list = await producerCustomPortfolioStore.get(producerId) || [];
    (list as any[]).unshift(entry);
    await producerCustomPortfolioStore.set(producerId, list);
    return c.json({ success: true, data: entry });
  } catch (error) { console.log(`Error creating portfolio: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.delete('/portfolio/delete/:id', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const producerId = c.req.query('producerId');
    if (!producerId) return c.json({ success: false, error: 'producerId required' }, 400);
    const list = await producerCustomPortfolioStore.get(producerId) || [];
    const filtered = (list as any[]).filter(p => p.id !== id);
    if (filtered.length === (list as any[]).length) return c.json({ success: false, error: 'Not found' }, 404);
    await producerCustomPortfolioStore.set(producerId, filtered);
    return c.json({ success: true });
  } catch (error) { return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// ════════════════════════════════════════
// PROFILE UPDATE
// ════════════════════════════════════════

app.put('/profile/update/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const body = await c.req.json();
    const existing = await producerProfileEditStore.get(producerId) || {};
    const updated = { ...(existing as any), ...body, updatedAt: nowIso() };
    await producerProfileEditStore.set(producerId, updated);
    return c.json({ success: true, data: updated });
  } catch (error) { console.log(`Error updating profile: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.get('/profile/edits/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const edits = await producerProfileEditStore.get(producerId);
    return c.json({ success: true, data: edits || null });
  } catch (error) { return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// ════════════════════════════════════════
// WALLET WITHDRAWAL
// ════════════════════════════════════════

app.post('/wallet/withdraw', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get(userId); // IDOR fix: cannot withdraw from other wallets
    const { amount, method, methodLabel } = body;
    if (!producerId || !amount || !method) return c.json({ success: false, error: 'producerId, amount, method required' }, 400);
    const wd = { id: genId('wd'), producerId, amount: Number(amount), method, methodLabel: methodLabel || method, status: 'pending', createdAt: nowIso() };
    const list = await paymentWithdrawalsStore.get(producerId) || [];
    (list as any[]).unshift(wd);
    await paymentWithdrawalsStore.set(producerId, list);
    return c.json({ success: true, data: wd });
  } catch (error) { console.log(`Error creating withdrawal: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.get('/wallet/withdrawals/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const list = await paymentWithdrawalsStore.get(producerId) || [];
    return c.json({ success: true, data: list });
  } catch (error) { return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// ════════════════════════════════════════
// AI ASSISTANT (Producer context)
// ════════════════════════════════════════

app.post('/ai/analyze', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get(userId); // IDOR fix
    const { context, question } = body;
    if (!producerId) return c.json({ success: false, error: 'producerId required' }, 400);

    const [convs, sessions, settings, withdrawals, customSvcs] = await Promise.all([
      producerConvsStore.get(producerId),
      producerSessionsStore.get(producerId),
      producerSettingsStore.get(producerId),
      paymentWithdrawalsStore.get(producerId),
      producerCustomServicesStore.get(producerId),
    ]);

    const dc = {
      conversations: ((convs || []) as any[]).length,
      totalUnread: ((convs || []) as any[]).reduce((s: number, c: any) => s + (c.unread || 0), 0),
      sessions: ((sessions || []) as any[]).length,
      upcomingSessions: ((sessions || []) as any[]).filter((s: any) => s.status === 'scheduled' || s.status === 'confirmed').length,
      withdrawals: ((withdrawals || []) as any[]).length,
      customServices: ((customSvcs || []) as any[]).length,
      vacationMode: (settings as any)?.vacationMode || false,
    };

    const sysPrompt = `Ты - ассистент продюсера на платформе ПРОМО.МУЗЫКА. Анализируешь данные и даёшь рекомендации. Русский язык. Короткие тире (-), не длинные. Краткий формат с эмодзи.\n\nДанные: ${JSON.stringify(dc)}\n${context ? `Контекст: ${context}` : ''}`;

    const mistralKey = process.env.MISTRAL_API_KEY;
    if (!mistralKey) {
      return c.json({ success: true, data: { response: fallbackRecs(dc), model: 'fallback' } });
    }

    const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mistralKey}` },
      body: JSON.stringify({ model: 'mistral-large-latest', messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: question || 'Проанализируй мои данные и дай рекомендации по развитию бизнеса продюсера.' }], temperature: 0.7, max_tokens: 1500 }),
    });

    if (!resp.ok) {
      console.log(`Mistral error: ${await resp.text()}`);
      return c.json({ success: true, data: { response: fallbackRecs(dc), model: 'fallback' } });
    }

    const data = await resp.json();
    const aiResp = data.choices[0].message.content;
    await producerAiLastStore.set(producerId, { question, response: aiResp, timestamp: nowIso() });
    return c.json({ success: true, data: { response: aiResp, model: 'mistral-large' } });
  } catch (error) { console.log(`AI error: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.get('/ai/history/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const last = await producerAiLastStore.get(producerId);
    return c.json({ success: true, data: last || null });
  } catch (error) { return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

function fallbackRecs(d: any): string {
  const t: string[] = ['📊 **Обзор кабинета**\n', `- Диалогов: ${d.conversations}`, `- Непрочитанных: ${d.totalUnread}`, `- Сессий: ${d.sessions} (предстоящих: ${d.upcomingSessions})`, `- Услуг: ${d.customServices}`, '', '💡 **Рекомендации:**'];
  if (d.totalUnread > 0) t.push('- Ответьте на непрочитанные - быстрый отклик повышает рейтинг');
  if (d.customServices < 3) t.push('- Добавьте больше услуг для расширения аудитории');
  if (d.upcomingSessions < 2) t.push('- Мало сессий - активнее продвигайте услуги');
  t.push('- Регулярно обновляйте портфолио');
  if (d.vacationMode) t.push('- ⚠️ Режим отпуска включён');
  return t.join('\n');
}

// ════════════════════════════════════════
// CALENDAR SESSIONS
// ════════════════════════════════════════

// GET /calendar/:producerId
app.get('/calendar/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const sessions: CalendarSession[] = await producerSessionsStore.get(producerId) || [];
    return c.json({ success: true, data: sessions });
  } catch (error) {
    console.log(`Error fetching calendar: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /calendar/:producerId/month?year=2026&month=2
app.get('/calendar/:producerId/month', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get(userId) && c.get(userRole) !== admin) {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const year = parseInt(c.req.query('year') || '2026');
    const month = parseInt(c.req.query('month') || '2'); // 1-based

    const sessions: CalendarSession[] = await producerSessionsStore.get(producerId) || [];

    // Filter by month
    const filtered = sessions.filter(s => {
      const d = new Date(s.date);
      return d.getFullYear() === year && d.getMonth() + 1 === month;
    });

    return c.json({ success: true, data: filtered });
  } catch (error) {
    console.log(`Error fetching month calendar: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /calendar/create
app.post('/calendar/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get(userId); // IDOR fix
    const { title, clientName, date, startTime, endTime, type, notes, orderId } = body;

    if (!producerId || !title || !date || !startTime || !endTime) {
      return c.json({ success: false, error: 'producerId, title, date, startTime, endTime are required' }, 400);
    }

    const TYPE_COLORS: Record<string, string> = {
      recording: '#ef4444',
      mixing: '#14b8a6',
      mastering: '#8b5cf6',
      consultation: '#f59e0b',
      other: '#6b7280',
    };

    const session: CalendarSession = {
      id: genId('session'),
      producerId,
      title,
      clientName: clientName || '',
      date,
      startTime,
      endTime,
      type: type || 'other',
      status: 'scheduled',
      notes: notes || '',
      color: TYPE_COLORS[type] || TYPE_COLORS.other,
      orderId: orderId || '',
      createdAt: nowIso(),
    };

    const sessions: CalendarSession[] = await producerSessionsStore.get(producerId) || [];
    sessions.push(session);
    await producerSessionsStore.set(producerId, sessions);

    return c.json({ success: true, data: session });
  } catch (error) {
    console.log(`Error creating session: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /calendar/update/:sessionId
app.put('/calendar/update/:sessionId', requireAuth, async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json();
    const { producerId } = body;

    if (!producerId) {
      return c.json({ success: false, error: 'producerId required' }, 400);
    }

    const sessions: CalendarSession[] = await producerSessionsStore.get(producerId) || [];
    const idx = sessions.findIndex(s => s.id === sessionId);

    if (idx < 0) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    // Update fields
    const updatable = ['title', 'clientName', 'date', 'startTime', 'endTime', 'type', 'status', 'notes', 'color'];
    for (const field of updatable) {
      if (body[field] !== undefined) {
        (sessions[idx] as any)[field] = body[field];
      }
    }

    await producerSessionsStore.set(producerId, sessions);
    return c.json({ success: true, data: sessions[idx] });
  } catch (error) {
    console.log(`Error updating session: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /calendar/delete/:sessionId
app.delete('/calendar/delete/:sessionId', requireAuth, async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const producerId = c.req.query('producerId');

    if (!producerId) {
      return c.json({ success: false, error: 'producerId query param required' }, 400);
    }

    const sessions: CalendarSession[] = await producerSessionsStore.get(producerId) || [];
    const filtered = sessions.filter(s => s.id !== sessionId);

    if (filtered.length === sessions.length) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }

    await producerSessionsStore.set(producerId, filtered);
    return c.json({ success: true });
  } catch (error) {
    console.log(`Error deleting session: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// DEMO DATA SEEDING
// ════════════════════════════════════════

export default app;
