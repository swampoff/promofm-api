/**
 * PRODUCER STUDIO ROUTES
 * Маршруты для реальных сообщений (SQL Store) и календаря сессий
 * Stores (from db.tsx):
 *   producer_convs              table (row-per-conversation, since migration 042)
 *   producer_messages           table (row-per-message,      since migration 042)
 *   producer_sessions           table (row-per-session,      since migration 042)
 *   producer_custom_services    table (row-per-service,      since migration 039)
 *   producer_custom_portfolio   table (row-per-entry,        since migration 039)
 *   paymentWithdrawalsStore     → payment_withdrawals table (pk: user_id)
 *   producerSettingsStore       → producer_settings table (pk: user_id)
 *   producerProfileEditStore    → producer_profile_edit table (pk: user_id)
 *   producerAiLastStore         → producer_ai_last table (pk: user_id)
 */

import { Hono } from 'hono';
import * as db from './db.tsx';
import {
  getProducerAiLast, setProducerAiLast,
  getProducerProfileEdit, setProducerProfileEdit, patchProducerProfileEdit,
  getProducerSettings, setProducerSettings,
  upsertProducerService, deleteProducerService,
} from './db.tsx';
import { getPaymentBalance, upsertPaymentBalance } from './db.tsx';
import { getDbClient, pool } from "./db-client.tsx";
import { requireAuth } from './auth-middleware.tsx';
import { profileLimiter, apiLimiter } from './rate-limiter.tsx';
import { logUserAction } from './audit-helper.tsx';
import { safeErrorMessage } from './security.tsx';
import { saveUpload, IMAGE_EXTS, MAX_IMAGE_BYTES } from './cabinet-uploads.tsx';

// Audio uploads — producer portfolio. Те же limits / extensions
// что у DJ-микс-аплоадера и engineer portfolio. Поднимем в
// cabinet-uploads.tsx когда добавится ещё один кабинет с audio.
const PRODUCER_AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);
const PRODUCER_MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200 MB

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
  return `${prefix}-${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function timeHHmm(): string {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}

// ════════════════════════════════════════
// CONVERSATIONS (row-per-conv since migration 042)
// ════════════════════════════════════════

function mapConvRow(row: any): ConversationMeta {
  const iso = (d: any) => d instanceof Date ? d.toISOString() : String(d);
  return {
    id: row.app_id,
    producerId: row.producer_id,
    clientName: row.client_name,
    clientInitial: row.client_initial || '?',
    orderTitle: row.order_title || '',
    orderId: row.order_id || '',
    lastMessage: row.last_message || '',
    lastTime: row.last_time || '',
    unread: row.unread,
    online: row.online,
    createdAt: iso(row.created_at),
  };
}

const CONV_COLS = `app_id, producer_id, client_name, client_initial, order_title,
  order_id, last_message, last_time, unread, online, created_at, updated_at`;

// GET /conversations/:producerId
app.get('/conversations/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
    if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    const r = await pool.query(
      `SELECT ${CONV_COLS} FROM producer_convs
        WHERE producer_id = $1 ORDER BY created_at DESC`,
      [producerId]
    );
    return c.json({ success: true, data: r.rows.map(mapConvRow) });
  } catch (error) {
    console.log(`Error fetching conversations: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /conversations/create
app.post('/conversations/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get('userId'); // IDOR fix
    const { clientName, orderTitle, orderId } = body;

    if (!producerId || !clientName) {
      return c.json({ success: false, error: 'producerId and clientName are required' }, 400);
    }

    const appId = genId('conv');
    const clientInitial = clientName[0]?.toUpperCase() || '?';
    const r = await pool.query(
      `INSERT INTO producer_convs
         (app_id, producer_id, client_name, client_initial, order_title,
          order_id, last_message, last_time, unread, online)
       VALUES ($1, $2, $3, $4, $5, $6, '', $7, 0, FALSE)
       RETURNING ${CONV_COLS}`,
      [
        appId, producerId, clientName, clientInitial,
        orderTitle || 'Новый диалог', orderId || '',
        timeHHmm(),
      ]
    );
    // Сообщения теперь row-per-msg (никакой "empty array init" не нужен —
    // первая запись через INSERT появится автоматически когда придёт.
    return c.json({ success: true, data: mapConvRow(r.rows[0]) });
  } catch (error) {
    console.log(`Error creating conversation: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// MESSAGES (row-per-msg since migration 042)
// ════════════════════════════════════════

function mapMsgRow(row: any): Message {
  const iso = (d: any) => d instanceof Date ? d.toISOString() : String(d);
  return {
    id: row.app_id,
    text: row.body,
    sender: row.sender,
    timestamp: iso(row.created_at),
    read: row.is_read,
    ...(row.attachment ? { attachment: row.attachment } : {}),
  };
}

const MSG_COLS = `app_id, conversation_id, body, sender, attachment,
  is_read, created_at`;

// GET /messages/:conversationId
app.get('/messages/:conversationId', requireAuth, async (c) => {
  try {
    const convId = c.req.param('conversationId');
    const r = await pool.query(
      `SELECT ${MSG_COLS} FROM producer_messages
        WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [convId]
    );
    return c.json({ success: true, data: r.rows.map(mapMsgRow) });
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

    const r = await pool.query(
      `SELECT ${MSG_COLS} FROM producer_messages
        WHERE conversation_id = $1 AND created_at > $2
        ORDER BY created_at ASC`,
      [convId, since]
    );
    // total отдаём для UI совместимости — отдельный COUNT, не доп
    // запрос для каждой ячейки.
    const totalR = await pool.query(
      `SELECT COUNT(*)::int AS n FROM producer_messages WHERE conversation_id = $1`,
      [convId]
    );
    return c.json({ success: true, data: r.rows.map(mapMsgRow), total: totalR.rows[0]?.n ?? 0 });
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

    const appId = genId('msg');
    // INSERT — никаких race condition'ов на массиве.
    const msgRes = await pool.query(
      `INSERT INTO producer_messages
         (app_id, conversation_id, body, sender, attachment, is_read)
       VALUES ($1, $2, $3, $4, $5::jsonb, FALSE)
       RETURNING ${MSG_COLS}`,
      [
        appId, conversationId, text, sender,
        attachment ? JSON.stringify(attachment) : null,
      ]
    );
    const msg = mapMsgRow(msgRes.rows[0]);

    // Update conversation meta (lastMessage, lastTime, unread+1 если client).
    // Один UPDATE — атомарно, никакого read-modify-write массива.
    if (producerId) {
      const lastMessage = text.length > 60 ? text.slice(0, 57) + '...' : text;
      await pool.query(
        `UPDATE producer_convs
            SET last_message = $1,
                last_time = $2,
                unread = unread + CASE WHEN $3 = 'client' THEN 1 ELSE 0 END,
                updated_at = NOW()
          WHERE app_id = $4 AND producer_id = $5`,
        [lastMessage, timeHHmm(), sender, conversationId, producerId]
      );
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

    // Mark all client messages as read. UPDATE через partial-index'ный
    // фильтр (idx_pc_msgs_unread покрывает is_read=FALSE).
    await pool.query(
      `UPDATE producer_messages
          SET is_read = TRUE
        WHERE conversation_id = $1 AND sender = 'client' AND is_read = FALSE`,
      [conversationId]
    );

    // Reset unread counter
    if (producerId) {
      await pool.query(
        `UPDATE producer_convs
            SET unread = 0, updated_at = NOW()
          WHERE app_id = $1 AND producer_id = $2 AND unread > 0`,
        [conversationId, producerId]
      );
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
    const random = crypto.randomUUID().slice(0, 7);
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
  if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const settings = await getProducerSettings(producerId);
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
  if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const body = await c.req.json();
    const settings = {
      ...body,
      updatedAt: new Date().toISOString(),
    };
    await setProducerSettings(producerId, settings);
    return c.json({ success: true, data: settings });
  } catch (error) {
    console.log(`Error saving settings: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});


// ════════════════════════════════════════
// BRIDGE: sync custom services → marketplace producer_services (native cols, migration 057)
// ════════════════════════════════════════
async function syncServiceToMarketplace(svc: CustomService, producerName?: string) {
  if (svc.status !== 'active') {
    // Remove from marketplace if paused/deleted
    try { await deleteProducerService(svc.id); } catch {}
    return;
  }
  await upsertProducerService(svc.id, {
    producerId: svc.producerId,
    producer: producerName || svc.producerId,
    title: svc.title,
    type: svc.type,
    basePrice: svc.basePrice,
    description: svc.description,
    deliveryDays: svc.deliveryDays,
    status: 'active',
    orders: svc.orders || 0,
    rating: svc.rating || 5.0,
    // residual fields (revisions, includes) уйдут в extra jsonb
    revisions: svc.revisions,
    includes: svc.includes,
  });
}

async function removeServiceFromMarketplace(serviceId: string) {
  try { await deleteProducerService(serviceId); } catch {}
}

// ════════════════════════════════════════
// SERVICES CRUD
// ════════════════════════════════════════

interface CustomService {
  id: string; producerId: string; title: string; type: string;
  basePrice: number; description: string; deliveryDays: number;
  revisions: number; includes: string[]; status: 'active' | 'paused';
  orders: number; rating: number; createdAt: string;
}

// row mapper: snake_case → API camelCase. `type` в API = `service_type`
// в БД (избегаем reserved-keyword путаницы в запросах).
function mapServiceRow(row: any): CustomService {
  const iso = (d: any) => d instanceof Date ? d.toISOString() : String(d);
  return {
    id: row.app_id,
    producerId: row.producer_id,
    title: row.title,
    type: row.service_type,
    basePrice: Number(row.base_price),
    description: row.description || '',
    deliveryDays: row.delivery_days,
    revisions: row.revisions,
    includes: Array.isArray(row.includes) ? row.includes : [],
    status: row.status,
    orders: row.orders,
    rating: Number(row.rating),
    createdAt: iso(row.created_at),
  };
}

const SERVICE_COLS = `app_id, producer_id, title, service_type, base_price,
  description, delivery_days, revisions, includes, status, orders, rating, created_at`;

app.post('/services/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get('userId'); // IDOR fix
    const { title, type, basePrice, description, deliveryDays, revisions, includes } = body;
    if (!producerId || !title || !basePrice) return c.json({ success: false, error: 'producerId, title, basePrice required' }, 400);

    const appId = genId('svc');
    const r = await pool.query(
      `INSERT INTO producer_custom_services
         (app_id, producer_id, title, service_type, base_price, description,
          delivery_days, revisions, includes, status, orders, rating)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'active', 0, 5.0)
       RETURNING ${SERVICE_COLS}`,
      [
        appId, producerId, title, type || 'mixing', Number(basePrice),
        description || '', Number(deliveryDays) || 5, Number(revisions) || 2,
        JSON.stringify(Array.isArray(includes) ? includes : []),
      ]
    );
    const svc = mapServiceRow(r.rows[0]);
    // Bridge: sync to marketplace so service appears in public catalog
    await syncServiceToMarketplace(svc);
    return c.json({ success: true, data: svc });
  } catch (error) { console.log(`Error creating service: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.put('/services/update/:serviceId', requireAuth, async (c) => {
  try {
    const serviceId = c.req.param('serviceId');
    const body = await c.req.json();
    const producerId = c.get('userId'); // IDOR fix: use JWT userId
    if (!producerId) return c.json({ success: false, error: 'Auth required' }, 401);

    const sets: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    const push = (col: string, val: any) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (typeof body.title === 'string')         push('title',         body.title);
    if (typeof body.type === 'string')          push('service_type',  body.type);
    if (body.basePrice !== undefined)           push('base_price',    Number(body.basePrice));
    if (body.description !== undefined)         push('description',   body.description);
    if (body.deliveryDays !== undefined)        push('delivery_days', Number(body.deliveryDays));
    if (body.revisions !== undefined)           push('revisions',     Number(body.revisions));
    if (Array.isArray(body.includes))           push('includes',      JSON.stringify(body.includes));
    if (typeof body.status === 'string')        push('status',        body.status);

    params.push(serviceId, producerId);
    const idxA = params.length - 1;
    const idxB = params.length;
    const r = await pool.query(
      `UPDATE producer_custom_services SET ${sets.join(', ')}
        WHERE app_id = $${idxA} AND producer_id = $${idxB}
       RETURNING ${SERVICE_COLS}`,
      params
    );
    if (r.rowCount === 0) return c.json({ success: false, error: 'Service not found' }, 404);
    const svc = mapServiceRow(r.rows[0]);
    // Bridge: sync to marketplace
    await syncServiceToMarketplace(svc);
    return c.json({ success: true, data: svc });
  } catch (error) { console.log(`Error updating service: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// Audit INC-P1+P2 (2026-05-31): profileLimiter + logUserAction. Раньше
// destructive action без rate-limit (abuse через украденный JWT) и без
// forensic trail (кто/когда удалил услугу из маркетплейса).
app.delete('/services/delete/:serviceId', requireAuth, profileLimiter, async (c) => {
  try {
    const serviceId = c.req.param('serviceId');
    const producerId = c.get('userId'); // IDOR fix: use JWT userId
    if (!producerId) return c.json({ success: false, error: 'Auth required' }, 401);

    const r = await pool.query(
      `DELETE FROM producer_custom_services
        WHERE app_id = $1 AND producer_id = $2`,
      [serviceId, producerId]
    );
    if (r.rowCount === 0) return c.json({ success: false, error: 'Not found' }, 404);
    // Bridge: remove from marketplace
    await removeServiceFromMarketplace(serviceId);
    logUserAction(c, {
      action: 'producer_service_delete',
      resourceType: 'producer_service',
      targetId: String(serviceId),
    });
    return c.json({ success: true });
  } catch (error) { console.log(`Error deleting service: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.get('/services/custom/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const r = await pool.query(
      `SELECT ${SERVICE_COLS} FROM producer_custom_services
        WHERE producer_id = $1 ORDER BY created_at DESC`,
      [producerId]
    );
    return c.json({ success: true, data: r.rows.map(mapServiceRow) });
  } catch (error) { return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// ════════════════════════════════════════
// PORTFOLIO CRUD
// ════════════════════════════════════════

function mapPortfolioRow(row: any) {
  const iso = (d: any) => d instanceof Date ? d.toISOString() : String(d);
  return {
    id: row.app_id,
    producerId: row.producer_id,
    title: row.title,
    artist: row.artist,
    type: row.item_type,
    year: row.year,
    description: row.description || '',
    createdAt: iso(row.created_at),
  };
}

app.post('/portfolio/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get('userId'); // IDOR fix
    const { title, artist, type, description } = body;
    if (!producerId || !title || !artist) return c.json({ success: false, error: 'producerId, title, artist required' }, 400);

    const appId = genId('pf');
    const r = await pool.query(
      `INSERT INTO producer_custom_portfolio
         (app_id, producer_id, title, artist, item_type, year, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING app_id, producer_id, title, artist, item_type, year, description, created_at`,
      [
        appId, producerId, title, artist, type || 'Сведение',
        new Date().getFullYear(), description || '',
      ]
    );
    return c.json({ success: true, data: mapPortfolioRow(r.rows[0]) });
  } catch (error) { console.log(`Error creating portfolio: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.delete('/portfolio/delete/:id', requireAuth, async (c) => {
  try {
    const id = c.req.param('id');
    const producerId = c.get('userId'); // IDOR fix: use JWT userId
    if (!producerId) return c.json({ success: false, error: 'Auth required' }, 401);
    const r = await pool.query(
      `DELETE FROM producer_custom_portfolio
        WHERE app_id = $1 AND producer_id = $2`,
      [id, producerId]
    );
    if (r.rowCount === 0) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true });
  } catch (error) { return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// ════════════════════════════════════════
// PROFILE UPDATE
// ════════════════════════════════════════

// ════════════════════════════════════════
// PORTFOLIO V2 (migration 028) — реальное портфолио с файлами
// ════════════════════════════════════════
//
// Старые endpoint-ы (/portfolio/create, /portfolio/delete/:id) выше
// используют `producerCustomPortfolioStore` — jsonb-blob с
// метаданными без файлов. Они остаются для backward-compat
// (текущие данные пользователей не теряются). Новые endpoint-ы
// ниже работают с таблицей `producer_portfolio` и реально
// загружают файл через `cabinet-uploads.saveUpload`. UI новых
// пользователей должен использовать только эти.

// GET /portfolio/v2 — список своих работ (включая is_public=false).
app.get('/portfolio/v2', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as string;
    if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const r = await pool.query(
      `SELECT id, title, artist_name, work_type, description, audio_url, cover_url,
              duration_sec, bpm, sort_order, is_public, created_at, updated_at
         FROM producer_portfolio
        WHERE user_id = $1
        ORDER BY sort_order ASC, created_at DESC`,
      [userId],
    );
    return c.json({
      success: true,
      data: r.rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        artistName: row.artist_name,
        workType: row.work_type,
        description: row.description,
        audioUrl: row.audio_url,
        coverUrl: row.cover_url,
        durationSec: row.duration_sec,
        bpm: row.bpm,
        sortOrder: row.sort_order,
        isPublic: row.is_public,
        createdAt: row.created_at?.toISOString?.() || row.created_at,
        updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
      })),
    });
  } catch (error: any) {
    console.error('Producer portfolio list failed:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /portfolio/v2 — multipart upload + INSERT.
// fields: file, title, workType, artistName?, description?, durationSec?
app.post('/portfolio/v2', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as string;
    if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);

    const title = String(body.title || file.name || 'Без названия').slice(0, 200);
    const workType = String(body.workType || 'mixing').slice(0, 40);
    const artistName = String(body.artistName || '').slice(0, 200) || null;
    const description = String(body.description || '').slice(0, 2000) || null;
    const durationSec = Number(body.durationSec) || null;
    // BPM — опциональный, миграция 029. FE валидирует 40-220.
    const bpmRaw = Number(body.bpm);
    const bpm = Number.isFinite(bpmRaw) && bpmRaw > 0 ? Math.round(bpmRaw) : null;

    const uploaded = await saveUpload(
      file,
      'producer-portfolio',
      `pf-${userId}`,
      PRODUCER_AUDIO_EXTS,
      PRODUCER_MAX_AUDIO_BYTES,
    );

    const ins = await pool.query(
      `INSERT INTO producer_portfolio
         (user_id, title, artist_name, work_type, description, audio_url, duration_sec, bpm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [userId, title, artistName, workType, description, uploaded.url, durationSec, bpm],
    );

    return c.json({
      success: true,
      data: {
        id: ins.rows[0].id,
        title,
        artistName,
        workType,
        description,
        audioUrl: uploaded.url,
        coverUrl: null,
        durationSec,
        bpm,
        sortOrder: 0,
        isPublic: true,
        createdAt: ins.rows[0].created_at?.toISOString?.() || ins.rows[0].created_at,
      },
    });
  } catch (error: any) {
    console.error('Producer portfolio create failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

// PUT /portfolio/v2/:id — метаданные.
app.put('/portfolio/v2/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  try {
    const userId = c.get('userId') as string;
    if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const body = await c.req.json();
    const setFields: string[] = [];
    const args: any[] = [];
    let i = 1;
    const allowed: Record<string, string> = {
      title: 'title',
      artistName: 'artist_name',
      workType: 'work_type',
      description: 'description',
      durationSec: 'duration_sec',
      bpm: 'bpm',
      sortOrder: 'sort_order',
      isPublic: 'is_public',
    };
    for (const [key, column] of Object.entries(allowed)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        setFields.push(`${column} = $${i++}`);
        args.push((body as any)[key]);
      }
    }
    if (setFields.length === 0) {
      return c.json({ success: false, error: 'No fields to update' }, 400);
    }
    setFields.push(`updated_at = NOW()`);
    args.push(id, userId);
    const r = await pool.query(
      `UPDATE producer_portfolio SET ${setFields.join(', ')}
        WHERE id = $${i++} AND user_id = $${i}
        RETURNING id`,
      args,
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Not found or not yours' }, 404);
    }
    return c.json({ success: true });
  } catch (error: any) {
    console.error('Producer portfolio update failed:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /portfolio/v2/:id — удалить запись.
// Audit INC-P1+P2: rate-limit + audit log.
app.delete('/portfolio/v2/:id', requireAuth, profileLimiter, async (c) => {
  const id = c.req.param('id');
  try {
    const userId = c.get('userId') as string;
    if (!userId) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const r = await pool.query(
      `DELETE FROM producer_portfolio WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Not found or not yours' }, 404);
    }
    logUserAction(c, {
      action: 'producer_portfolio_delete',
      resourceType: 'producer_portfolio',
      targetId: String(id),
    });
    return c.json({ success: true });
  } catch (error: any) {
    console.error('Producer portfolio delete failed:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /portfolio/v2/public/:userId — публичный листинг (без auth).
// Audit B-P2 (2026-05-31): apiLimiter (200/min/IP) — public endpoint без
// auth, раньше без rate-limit. Enumeration attack (перебор userId-ов в
// поиске публичных портфолио) или DOS scrape всего каталога.
app.get('/portfolio/v2/public/:userId', apiLimiter, async (c) => {
  const targetUserId = c.req.param('userId');
  try {
    const r = await pool.query(
      `SELECT id, title, artist_name, work_type, description, audio_url, cover_url,
              duration_sec, bpm, sort_order, created_at
         FROM producer_portfolio
        WHERE user_id = $1 AND is_public = true
        ORDER BY sort_order ASC, created_at DESC
        LIMIT 100`,
      [targetUserId],
    );
    return c.json({
      success: true,
      data: r.rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        artistName: row.artist_name,
        workType: row.work_type,
        description: row.description,
        audioUrl: row.audio_url,
        coverUrl: row.cover_url,
        durationSec: row.duration_sec,
        bpm: row.bpm,
        sortOrder: row.sort_order,
        createdAt: row.created_at?.toISOString?.() || row.created_at,
      })),
    });
  } catch (error: any) {
    console.error('Producer public portfolio failed:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.put('/profile/update/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const body = await c.req.json();
    // Atomic jsonb || merge — race-free vs legacy get+merge+set.
    const updated = await patchProducerProfileEdit(producerId, { ...body, updatedAt: nowIso() });

    // Migration 061: mirror editor writes to the public `producer_profiles`
    // table so cross-cabinet listings (landing-data-routes /landing/
    // producer-profiles, /landing/producer-profile/:id) and the public
    // producer page see what the editor saved. Same pattern as
    // persistProducerImage() at line 1333 — keeps both stores in sync.
    // Without this, editor changes were trapped in producer_profile_edit
    // and the public row stayed empty of name/city/bio/workPhilosophy.
    try {
      const pubExisting = (await db.getProducerProfile(producerId)) || {};
      await db.upsertProducerProfile(producerId, { ...(pubExisting as any), ...body });
    } catch (mirrorErr) {
      console.log(`[producer-profile] mirror to producer_profiles failed (non-fatal):`, mirrorErr);
    }

    return c.json({ success: true, data: updated });
  } catch (error) { console.log(`Error updating profile: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

/**
 * POST /request-verification — producer submits a verification request.
 *
 * Mirrors artist's POST /artist-profile/request-verification (migration
 * 058) + the venue/radio analogues. Admin processes via POST /auth/
 * admin/verify-profile { role: 'producer', isVerified, rejectionReason? }.
 *
 * Idempotent: re-clicking refreshes verification_requested_at and
 * clears any previous rejection_reason.
 *
 * Migration 062 added the underlying is_verified +
 * verification_requested_at/approved_at/rejection_reason columns
 * (producer never had is_verified before — migration 011 skipped this
 * table).
 */
app.post('/request-verification', requireAuth, async (c) => {
  const userId = c.get('userId' as never) as string | undefined;
  if (!userId) {
    return c.json({ success: false, error: 'Не авторизован' }, 401);
  }
  try {
    const { rows } = await pool.query(
      `SELECT is_verified FROM producer_profiles WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) {
      return c.json({ success: false, error: 'Producer profile not found' }, 404);
    }
    if (rows[0].is_verified) {
      return c.json({ success: false, error: 'Профиль уже верифицирован' }, 400);
    }
    await pool.query(
      `UPDATE producer_profiles
          SET verification_requested_at     = NOW(),
              verification_rejection_reason = NULL
        WHERE user_id = $1`,
      [userId],
    );
    console.log(`[ProducerProfile] Verification requested by ${userId}`);
    return c.json({
      success: true,
      message: 'Заявка на верификацию отправлена. Ожидайте рассмотрения администратором.',
    });
  } catch (error) {
    console.error('[ProducerProfile] request-verification error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.get('/profile/edits/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const edits = (await getProducerProfileEdit(producerId)) || {};
    // Fold migration 062 verification state from producer_profiles
    // (admin-managed, not part of the editor store) so the cabinet
    // doesn't have to hit the public /landing-data endpoint just to
    // render its own status badge. Verification state is public
    // info, so this is a convenience-locality win — not a privacy
    // change. Errors here are swallowed: the edit-store payload is
    // the contract; verification fields are best-effort overlay.
    let verification: Record<string, any> = {};
    try {
      const pub = await db.getProducerProfile(producerId);
      if (pub) {
        verification = {
          isVerified:                  !!(pub as any).isVerified,
          verificationRequestedAt:     (pub as any).verificationRequestedAt     ?? null,
          verificationApprovedAt:      (pub as any).verificationApprovedAt      ?? null,
          verificationRejectionReason: (pub as any).verificationRejectionReason ?? null,
        };
      }
    } catch (verifErr) {
      console.log(`[producer-profile] verification fold failed (non-fatal):`, verifErr);
    }
    return c.json({ success: true, data: { ...(edits as any), ...verification } });
  } catch (error) { return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// ════════════════════════════════════════
// WALLET WITHDRAWAL
// ════════════════════════════════════════

// Audit INC-P1+P2: rate-limit + audit log. Withdraw = реальные деньги,
// без forensic-trail невозможно расследовать спор «я не выводил». 5/min
// достаточно для legit UX, узко для abuse.
app.post('/wallet/withdraw', requireAuth, profileLimiter, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get('userId'); // IDOR fix: cannot withdraw from other wallets
    const { amount, method, methodLabel } = body;
    if (!producerId || !amount || !method) return c.json({ success: false, error: 'producerId, amount, method required' }, 400);
    const numAmount = Number(amount);
    if (numAmount <= 0) return c.json({ success: false, error: 'Amount must be positive' }, 400);
    // Check balance before withdrawal
    const balance = await getPaymentBalance(producerId);
    const available = Number(balance?.available || 0);
    if (available < numAmount) {
      return c.json({ success: false, error: `Insufficient balance: ${available} RUB available, requested ${numAmount} RUB` }, 400);
    }
    // Deduct from balance
    const bal = balance || { available: 0, pending: 0, total: 0, userId: producerId };
    bal.available = Number(bal.available) - numAmount;
    bal.pending = Number(bal.pending || 0) + numAmount;
    bal.total = bal.available + bal.pending;
    await upsertPaymentBalance(producerId, bal);
    // row-per-withdrawal (migration 043): атомарный INSERT, race-free.
    const wdId = genId('wd');
    const createdAt = nowIso();
    await (await import('./db-client.tsx')).pool.query(
      `INSERT INTO payment_withdrawals
         (app_id, user_id, source, amount, payment_method, method_label, status, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, 'pending', $6, $6)
       ON CONFLICT (user_id, app_id) DO NOTHING`,
      [wdId, producerId, numAmount, method, methodLabel || method, createdAt]
    );
    const wd = {
      id: wdId, producerId, amount: numAmount, method,
      methodLabel: methodLabel || method, status: 'pending', createdAt,
    };
    logUserAction(c, {
      action: 'producer_withdrawal_request',
      resourceType: 'payment_withdrawal',
      targetId: String(wdId),
      details: { amount: numAmount, method, methodLabel: methodLabel || method },
    });
    return c.json({ success: true, data: wd });
  } catch (error) { console.log(`Error creating withdrawal: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.get('/wallet/withdrawals/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    // row-per-withdrawal (migration 043). Producer-side scope: source IS NULL
    // (donations и radio имеют свои source-фильтры).
    const _wq = await (await import('./db-client.tsx')).pool.query(
      `SELECT app_id, user_id, amount, payment_method, method_label, status,
              created_at, updated_at
         FROM payment_withdrawals
        WHERE user_id = $1 AND source IS NULL
        ORDER BY created_at DESC`,
      [producerId]
    );
    const list = _wq.rows.map((r: any) => {
      const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : undefined);
      return {
        id: r.app_id,
        producerId: r.user_id,
        amount: Number(r.amount),
        method: r.payment_method,
        methodLabel: r.method_label || r.payment_method,
        status: r.status,
        createdAt: iso(r.created_at),
      };
    });
    return c.json({ success: true, data: list });
  } catch (error) { return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

// ════════════════════════════════════════
// AI ASSISTANT (Producer context)
// ════════════════════════════════════════

app.post('/ai/analyze', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get('userId'); // IDOR fix
    const { context, question } = body;
    if (!producerId) return c.json({ success: false, error: 'producerId required' }, 400);

    const [convsRows, sessionsRows, settings, withdrawals, customSvcs] = await Promise.all([
      pool.query(
        `SELECT ${CONV_COLS} FROM producer_convs WHERE producer_id = $1`,
        [producerId]
      ).then((r: any) => r.rows.map(mapConvRow)),
      pool.query(
        `SELECT ${SESSION_COLS} FROM producer_sessions WHERE producer_id = $1`,
        [producerId]
      ).then((r: any) => r.rows.map(mapSessionRow)),
      getProducerSettings(producerId),
      // row-per-withdrawal (migration 043): возвращаем массив строк.
      pool.query(
        `SELECT app_id, amount, payment_method, status
           FROM payment_withdrawals
          WHERE user_id = $1 AND source IS NULL
          ORDER BY created_at DESC`,
        [producerId]
      ).then((r: any) => r.rows),
      pool.query(
        `SELECT ${SERVICE_COLS} FROM producer_custom_services
          WHERE producer_id = $1 ORDER BY created_at DESC`,
        [producerId]
      ).then((r: any) => r.rows.map(mapServiceRow)),
    ]);
    const convs = convsRows;
    const sessions = sessionsRows;

    const dc = {
      conversations: convs.length,
      totalUnread: convs.reduce((s: number, c: any) => s + (c.unread || 0), 0),
      sessions: sessions.length,
      upcomingSessions: sessions.filter((s: any) => s.status === 'scheduled' || s.status === 'confirmed').length,
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
    await setProducerAiLast(producerId, { question, response: aiResp, timestamp: nowIso() });
    return c.json({ success: true, data: { response: aiResp, model: 'mistral-large' } });
  } catch (error) { console.log(`AI error: ${error}`); return c.json({ success: false, error: safeErrorMessage(error) }, 500); }
});

app.get('/ai/history/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
  // IDOR fix: verify ownership
  if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
    return c.json({ success: false, error: 'Access denied' }, 403);
  }
    const last = await getProducerAiLast(producerId);
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
// CALENDAR SESSIONS (row-per-session since migration 042)
// ════════════════════════════════════════

function mapSessionRow(row: any): CalendarSession {
  const iso = (d: any) => d instanceof Date ? d.toISOString() : String(d);
  const dateStr = (d: any): string => {
    if (!d) return '';
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  };
  return {
    id: row.app_id,
    producerId: row.producer_id,
    title: row.title,
    clientName: row.client_name || '',
    clientId: row.client_id || undefined,
    date: dateStr(row.session_date),
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    type: row.session_type as CalendarSession['type'],
    status: row.status as CalendarSession['status'],
    notes: row.notes || '',
    color: row.color || '',
    orderId: row.order_id || '',
    createdAt: iso(row.created_at),
  };
}

const SESSION_COLS = `app_id, producer_id, title, client_name, client_id,
  session_date, start_time, end_time, session_type, status, notes, color,
  order_id, created_at, updated_at`;

// GET /calendar/:producerId
app.get('/calendar/:producerId', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
    if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    const r = await pool.query(
      `SELECT ${SESSION_COLS} FROM producer_sessions
        WHERE producer_id = $1 ORDER BY session_date, start_time`,
      [producerId]
    );
    return c.json({ success: true, data: r.rows.map(mapSessionRow) });
  } catch (error) {
    console.log(`Error fetching calendar: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /calendar/:producerId/month?year=2026&month=2
app.get('/calendar/:producerId/month', requireAuth, async (c) => {
  try {
    const producerId = c.req.param('producerId');
    if (producerId !== c.get('userId') && c.get('userRole') !== 'admin') {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    const year = parseInt(c.req.query('year') || '2026');
    const month = parseInt(c.req.query('month') || '2'); // 1-based

    // Фильтр по месяцу в SQL — индекс (producer_id, session_date) ловит.
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 1));
    const r = await pool.query(
      `SELECT ${SESSION_COLS} FROM producer_sessions
        WHERE producer_id = $1
          AND session_date >= $2 AND session_date < $3
        ORDER BY session_date, start_time`,
      [producerId, monthStart.toISOString().slice(0, 10), monthEnd.toISOString().slice(0, 10)]
    );
    return c.json({ success: true, data: r.rows.map(mapSessionRow) });
  } catch (error) {
    console.log(`Error fetching month calendar: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

const SESSION_TYPE_COLORS: Record<string, string> = {
  recording: '#ef4444',
  mixing: '#14b8a6',
  mastering: '#8b5cf6',
  consultation: '#f59e0b',
  other: '#6b7280',
};

// POST /calendar/create
app.post('/calendar/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const producerId = c.get('userId'); // IDOR fix
    const { title, clientName, date, startTime, endTime, type, notes, orderId } = body;

    if (!producerId || !title || !date || !startTime || !endTime) {
      return c.json({ success: false, error: 'producerId, title, date, startTime, endTime are required' }, 400);
    }

    const appId = genId('session');
    const sessionType = type || 'other';
    const color = SESSION_TYPE_COLORS[sessionType] || SESSION_TYPE_COLORS.other;

    const r = await pool.query(
      `INSERT INTO producer_sessions
         (app_id, producer_id, title, client_name, session_date,
          start_time, end_time, session_type, status, notes, color, order_id)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, 'scheduled', $9, $10, $11)
       RETURNING ${SESSION_COLS}`,
      [
        appId, producerId, title, clientName || '',
        date, startTime, endTime,
        sessionType, notes || '', color, orderId || '',
      ]
    );
    return c.json({ success: true, data: mapSessionRow(r.rows[0]) });
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
    const producerId = c.get('userId'); // IDOR fix: use JWT userId

    if (!producerId) {
      return c.json({ success: false, error: 'Auth required' }, 401);
    }

    const sets: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    const push = (col: string, val: any) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (typeof body.title === 'string')      push('title',        body.title);
    if (body.clientName !== undefined)       push('client_name',  body.clientName);
    if (body.date !== undefined)             push('session_date', body.date);
    if (body.startTime !== undefined)        push('start_time',   body.startTime);
    if (body.endTime !== undefined)          push('end_time',     body.endTime);
    if (typeof body.type === 'string')       push('session_type', body.type);
    if (typeof body.status === 'string')     push('status',       body.status);
    if (body.notes !== undefined)            push('notes',        body.notes);
    if (body.color !== undefined)            push('color',        body.color);

    params.push(sessionId, producerId);
    const idxA = params.length - 1;
    const idxB = params.length;
    const r = await pool.query(
      `UPDATE producer_sessions SET ${sets.join(', ')}
        WHERE app_id = $${idxA} AND producer_id = $${idxB}
       RETURNING ${SESSION_COLS}`,
      params
    );
    if (r.rowCount === 0) return c.json({ success: false, error: 'Session not found' }, 404);
    return c.json({ success: true, data: mapSessionRow(r.rows[0]) });
  } catch (error) {
    console.log(`Error updating session: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /calendar/delete/:sessionId
app.delete('/calendar/delete/:sessionId', requireAuth, async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const producerId = c.get('userId'); // IDOR fix: use JWT userId

    if (!producerId) {
      return c.json({ success: false, error: 'Auth required' }, 401);
    }

    const r = await pool.query(
      `DELETE FROM producer_sessions
        WHERE app_id = $1 AND producer_id = $2`,
      [sessionId, producerId]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    return c.json({ success: true });
  } catch (error) {
    console.log(`Error deleting session: ${error}`);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ════════════════════════════════════════
// DEMO DATA SEEDING
// ════════════════════════════════════════

// ────────────────────────────────────────
// Profile image uploads
// ────────────────────────────────────────
//
// Producer cabinet (Promomusicfigma/src/app/ProducerApp.tsx
// `ProfileTab`) didn't ship with avatar / cover upload — the
// header was a static gradient with the first letter of the
// producer's name. These two endpoints add the missing surface.
//
// Producer data has two stores:
//   1. `producer_profile_edit` (jsonb-per-user, used by the editor)
//   2. `producer_profiles` (jsonb in `data` column, consumed by
//      cross-cabinet listings)
// Both get the new URL via the helper below so a freshly-uploaded
// avatar shows up in BOTH the producer's own editor (next load)
// AND any public/cross-cabinet card that hits getProducerProfile.

async function persistProducerImage(producerId: string, field: 'avatarUrl' | 'coverUrl', url: string) {
  // Edit store (what the producer sees in their cabinet). Atomic jsonb || merge.
  await patchProducerProfileEdit(producerId, { [field]: url, updatedAt: nowIso() });
  // Public producer_profiles row (what other cabinets read)
  const pubExisting = (await db.getProducerProfile(producerId)) || {};
  await db.upsertProducerProfile(producerId, {
    ...(pubExisting as any),
    [field]: url,
  });
}

app.post('/profile/avatar', requireAuth, async (c) => {
  try {
    const producerId = c.get('userId') as string;
    if (!producerId) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);
    const uploaded = await saveUpload(file, 'producer-avatars', `avatar-${producerId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);
    await persistProducerImage(producerId, 'avatarUrl', uploaded.url);
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Producer avatar upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

app.post('/profile/cover', requireAuth, async (c) => {
  try {
    const producerId = c.get('userId') as string;
    if (!producerId) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ success: false, error: 'Файл не передан' }, 400);
    const uploaded = await saveUpload(file, 'producer-covers', `cover-${producerId}`, IMAGE_EXTS, MAX_IMAGE_BYTES);
    await persistProducerImage(producerId, 'coverUrl', uploaded.url);
    return c.json({ success: true, data: { url: uploaded.url } });
  } catch (error: any) {
    console.error('Producer cover upload failed:', error);
    return c.json({ success: false, error: error?.message || 'Upload failed' }, 400);
  }
});

export default app;
