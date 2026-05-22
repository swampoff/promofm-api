/**
 * PITCHING ROUTES — каталог стримингов/блогеров/медиа + платные сабмиссии артистов
 *
 * Pitching на платформе — distribution трека/видео в одну из трёх категорий
 * promo-площадок:
 *   • playlist — стриминговые плейлисты (Spotify / Apple / Яндекс.Музыка / …)
 *   • influencer — блогеры (Instagram / YouTube / Telegram / TikTok …)
 *   • media — медиа-издания, пресса (журналы, блоги, подкасты)
 *
 * Денежный путь (един для всех категорий):
 *   1. Артист на /pitching-page собирает «корзину» позиций — может смешивать
 *      категории в одной заявке
 *   2. POST /pitching/submit создаёт N submissions со status='pending_payment'
 *      и одну ЮКасса-сессию на сумму всех позиций; возвращает confirmation_url
 *   3. Артист уходит на ЮКассу, оплачивает, ЮКасса дёргает
 *      /checkout/webhook/yookassa
 *   4. Webhook видит metadata.itemType='pitching_bundle' и переводит
 *      submissions из pending_payment → pending (модерация),
 *      notifyAllAdmins по каждой
 *   5. Админ модерирует через /pitching/admin/submissions — артист получает
 *      SSE push pitching_update
 *
 * Public/auth endpoints:
 *   GET    /pitching/playlists                — каталог активных плейлистов
 *   GET    /pitching/influencers              — каталог активных блогеров
 *   GET    /pitching/media-outlets            — каталог активных медиа
 *   GET    /pitching/submissions              — собственные сабмиссии артиста
 *   POST   /pitching/submit                   — bundle-сабмит (создаёт payment session)
 *
 * Admin endpoints (requireAdmin):
 *   POST   /pitching/admin/playlists          — создать
 *   PUT    /pitching/admin/playlists/:id      — обновить
 *   DELETE /pitching/admin/playlists/:id      — архивировать
 *   POST   /pitching/admin/influencers        — создать блогера
 *   PUT    /pitching/admin/influencers/:id    — обновить
 *   DELETE /pitching/admin/influencers/:id    — архивировать
 *   POST   /pitching/admin/media-outlets      — создать медиа
 *   PUT    /pitching/admin/media-outlets/:id  — обновить
 *   DELETE /pitching/admin/media-outlets/:id  — архивировать
 *   GET    /pitching/admin/submissions        — все сабмиссии (фильтр по status)
 *   PUT    /pitching/admin/submissions/:id    — модерация (accepted/rejected)
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';
import { notifyAllAdmins, notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { getGateway, type PaymentSession } from './payment-gateway.tsx';
import { upsertPaymentSession } from './db.tsx';

const app = new Hono();

type Category = 'playlist' | 'influencer' | 'media';

const CATEGORY_TABLES: Record<Category, string> = {
  playlist: 'pitching_playlists',
  influencer: 'pitching_influencers',
  media: 'pitching_media_outlets',
};

function isCategory(v: any): v is Category {
  return v === 'playlist' || v === 'influencer' || v === 'media';
}

// ── Schema bootstrap (idempotent) ────────────────────────────────────────────

let schemaReady: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    // 1. Catalog: streaming playlists.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitching_playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        followers BIGINT NOT NULL DEFAULT 0,
        genre TEXT,
        region TEXT,
        description TEXT,
        curator TEXT,
        curator_contact TEXT,
        image_url TEXT,
        acceptance_rate INT NOT NULL DEFAULT 0,
        price_rub NUMERIC(10, 2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pitching_playlists_status ON pitching_playlists(status);
      CREATE INDEX IF NOT EXISTS idx_pitching_playlists_platform ON pitching_playlists(platform);
    `);
    await pool.query(`
      ALTER TABLE pitching_playlists
        ADD COLUMN IF NOT EXISTS curator TEXT,
        ADD COLUMN IF NOT EXISTS image_url TEXT,
        ADD COLUMN IF NOT EXISTS acceptance_rate INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS price_rub NUMERIC(10, 2) NOT NULL DEFAULT 0;
    `);

    // 2. Catalog: influencers / bloggers.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitching_influencers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        handle TEXT,
        followers BIGINT NOT NULL DEFAULT 0,
        engagement_rate NUMERIC(5, 2) NOT NULL DEFAULT 0,
        category TEXT,
        region TEXT,
        description TEXT,
        contact TEXT,
        image_url TEXT,
        price_rub NUMERIC(10, 2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pitching_influencers_status ON pitching_influencers(status);
      CREATE INDEX IF NOT EXISTS idx_pitching_influencers_platform ON pitching_influencers(platform);
    `);

    // 3. Catalog: media outlets (press, blogs, magazines, podcasts).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitching_media_outlets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        outlet_type TEXT NOT NULL,
        readers BIGINT NOT NULL DEFAULT 0,
        reach TEXT,
        region TEXT,
        description TEXT,
        contact_email TEXT,
        website TEXT,
        image_url TEXT,
        price_rub NUMERIC(10, 2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pitching_media_status ON pitching_media_outlets(status);
      CREATE INDEX IF NOT EXISTS idx_pitching_media_type ON pitching_media_outlets(outlet_type);
    `);

    // 4. Submissions log — extended with `category` so one queue handles all three.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitching_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'playlist',
        target_id TEXT NOT NULL,
        target_name TEXT,
        track_id TEXT,
        video_id TEXT,
        message TEXT,
        price_rub NUMERIC(10, 2) NOT NULL DEFAULT 0,
        payment_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending_payment',
        moderator_id TEXT,
        moderator_response TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_user ON pitching_submissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_status ON pitching_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_target ON pitching_submissions(target_id);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_payment ON pitching_submissions(payment_session_id);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_category ON pitching_submissions(category);
    `);
    await pool.query(`
      ALTER TABLE pitching_submissions
        ADD COLUMN IF NOT EXISTS price_rub NUMERIC(10, 2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS payment_session_id TEXT,
        ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'playlist';
    `);
    await pool.query(`
      ALTER TABLE pitching_submissions DROP COLUMN IF EXISTS submission_type;
    `);
  })();
  return schemaReady;
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

// ── Public catalog ────────────────────────────────────────────────────────────

app.get('/playlists', async (c) => {
  try {
    await ensureSchema();
    const r = await pool.query(
      `SELECT id, name, platform, followers, genre, region, description,
              curator, curator_contact, image_url, acceptance_rate, price_rub
       FROM pitching_playlists WHERE status = 'active'
       ORDER BY followers DESC, name ASC`
    );
    return c.json({ success: true, playlists: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.get('/influencers', async (c) => {
  try {
    await ensureSchema();
    const r = await pool.query(
      `SELECT id, name, platform, handle, followers, engagement_rate, category,
              region, description, contact, image_url, price_rub
       FROM pitching_influencers WHERE status = 'active'
       ORDER BY followers DESC, name ASC`
    );
    return c.json({ success: true, influencers: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.get('/media-outlets', async (c) => {
  try {
    await ensureSchema();
    const r = await pool.query(
      `SELECT id, name, outlet_type, readers, reach, region, description,
              contact_email, website, image_url, price_rub
       FROM pitching_media_outlets WHERE status = 'active'
       ORDER BY readers DESC, name ASC`
    );
    return c.json({ success: true, outlets: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Artist submissions ────────────────────────────────────────────────────────

app.get('/submissions', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const userId = c.get('userId') as string;
    const r = await pool.query(
      `SELECT id, category, target_id, target_name, track_id, video_id, message,
              price_rub, payment_session_id, status, moderator_response,
              created_at, updated_at
       FROM pitching_submissions WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 200`,
      [userId]
    );
    return c.json({ success: true, submissions: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /pitching/submit — bundle-submit with payment.
 *
 * Body:
 *   {
 *     items: [
 *       { category: 'playlist'|'influencer'|'media', targetId,
 *         trackId?, videoId?, message? },
 *       ...
 *     ],
 *     returnUrl: 'https://promo-music.ru/cabinet/pitching?paid=1'
 *   }
 *
 * Server-authoritative pricing: prices come from the category-matching
 * catalog table (.price_rub), not from the client. Submissions land in
 * pending_payment; the YooKassa webhook flips them to pending (the
 * moderation queue) and fans out notifyAllAdmins.
 *
 * Returns: { success, orderId, confirmationUrl, amount, submission_ids, free? }
 */
app.post('/submit', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const userId = c.get('userId') as string;
    const body = await c.req.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    const returnUrl: string | undefined = body?.returnUrl;

    if (items.length === 0) {
      return c.json({ success: false, error: 'items пустой' }, 400);
    }
    if (items.length > 50) {
      return c.json({ success: false, error: 'Слишком много позиций (максимум 50)' }, 400);
    }
    if (!returnUrl) {
      return c.json({ success: false, error: 'returnUrl обязателен' }, 400);
    }

    // Normalize + validate every item.
    type Normalized = {
      category: Category;
      targetId: string;
      trackId: string | null;
      videoId: string | null;
      message: string | null;
    };
    const normalized: Normalized[] = [];
    for (const it of items) {
      const category = isCategory(it?.category) ? it.category : 'playlist';
      if (!it?.targetId) {
        return c.json({ success: false, error: 'Каждая позиция должна содержать targetId' }, 400);
      }
      if (!it?.trackId && !it?.videoId) {
        return c.json({ success: false, error: 'Каждая позиция должна содержать trackId или videoId' }, 400);
      }
      normalized.push({
        category,
        targetId: String(it.targetId),
        trackId: it.trackId ? String(it.trackId) : null,
        videoId: it.videoId ? String(it.videoId) : null,
        message: it.message ? String(it.message) : null,
      });
    }

    // Resolve catalog rows per category — server-authoritative pricing.
    type CatalogRow = { name: string; price_rub: number };
    const catalog: Record<Category, Map<string, CatalogRow>> = {
      playlist: new Map(),
      influencer: new Map(),
      media: new Map(),
    };
    for (const cat of ['playlist', 'influencer', 'media'] as Category[]) {
      const ids = Array.from(new Set(normalized.filter(n => n.category === cat).map(n => n.targetId)));
      if (ids.length === 0) continue;
      const table = CATEGORY_TABLES[cat];
      const res = await pool.query(
        `SELECT id, name, price_rub FROM ${table} WHERE id = ANY($1) AND status = 'active'`,
        [ids]
      );
      for (const row of res.rows) {
        catalog[cat].set(row.id, { name: row.name, price_rub: Number(row.price_rub) });
      }
    }

    // Bail out if any selected target was missing/archived. Don't half-submit.
    for (const n of normalized) {
      if (!catalog[n.category].has(n.targetId)) {
        return c.json({ success: false, error: `Площадка ${n.targetId} (${n.category}) недоступна` }, 400);
      }
    }

    const orderId = crypto.randomUUID();
    let total = 0;
    const submissionIds: string[] = [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const n of normalized) {
        const cat = catalog[n.category].get(n.targetId)!;
        const id = generateId('pit');
        await client.query(
          `INSERT INTO pitching_submissions
             (id, user_id, category, target_id, target_name, track_id, video_id, message,
              price_rub, payment_session_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_payment')`,
          [
            id,
            userId,
            n.category,
            n.targetId,
            cat.name,
            n.trackId,
            n.videoId,
            n.message,
            cat.price_rub,
            orderId,
          ]
        );
        submissionIds.push(id);
        total += cat.price_rub;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Free edge case: skip the gateway entirely.
    if (total <= 0) {
      await pool.query(
        `UPDATE pitching_submissions
           SET status = 'pending', updated_at = NOW()
         WHERE id = ANY($1)`,
        [submissionIds]
      );
      try {
        for (const sid of submissionIds) {
          await notifyAllAdmins({
            sourceRole: 'artist',
            type: 'admin_action',
            title: 'Новая заявка на питчинг',
            message: `Артист ${userId} → бесплатная позиция`,
            link: 'pitching-moderation',
            metadata: { submissionId: sid },
          });
        }
      } catch (e: any) {
        console.warn('[pitching] notifyAllAdmins (free) failed:', e?.message);
      }
      return c.json({
        success: true,
        orderId,
        confirmationUrl: null,
        amount: 0,
        submission_ids: submissionIds,
        free: true,
      });
    }

    // Build a human description that mentions categories without becoming a wall of text.
    const counts = { playlist: 0, influencer: 0, media: 0 };
    for (const n of normalized) counts[n.category]++;
    const parts: string[] = [];
    if (counts.playlist) parts.push(`${counts.playlist} плейлист(ов)`);
    if (counts.influencer) parts.push(`${counts.influencer} блогер(ов)`);
    if (counts.media) parts.push(`${counts.media} медиа`);
    const description = `Питчинг: ${parts.join(', ')}`;

    const gw = getGateway('yookassa');
    const gwResult = await gw.createPayment({
      amount: total,
      currency: 'RUB',
      description,
      gateway: 'yookassa',
      userId,
      orderId,
      returnUrl,
      type: 'purchase',
      metadata: {
        itemType: 'pitching_bundle',
        submission_ids: submissionIds.join(','),
      },
    });

    const session: PaymentSession = {
      orderId,
      userId,
      gateway: 'yookassa',
      gatewayPaymentId: gwResult.sessionId,
      amount: total,
      currency: 'RUB',
      status: 'pending',
      type: 'purchase',
      description,
      metadata: {
        itemType: 'pitching_bundle',
        submission_ids: submissionIds.join(','),
      },
      savePaymentMethod: false,
      confirmationUrl: gwResult.confirmationUrl,
      returnUrl,
      createdAt: new Date().toISOString(),
    };
    await upsertPaymentSession(orderId, session);

    return c.json({
      success: true,
      orderId,
      confirmationUrl: gwResult.confirmationUrl,
      amount: total,
      submission_ids: submissionIds,
      free: false,
    });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Admin: catalog CRUD ───────────────────────────────────────────────────────
//
// All three CRUD groups share the same skeleton: validate name + a category-
// specific required field, allow PATCH of a known column list, soft-delete via
// status='archived'. Differences live only in column lists.

app.post('/admin/playlists', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const body = await c.req.json();
    const { name, platform, followers, genre, region, description,
            curator, curator_contact, image_url, acceptance_rate, price_rub } = body || {};
    if (!name || !platform) {
      return c.json({ success: false, error: 'name and platform are required' }, 400);
    }
    const id = generateId('pl');
    const adminId = c.get('userId') as string;
    await pool.query(
      `INSERT INTO pitching_playlists
         (id, name, platform, followers, genre, region, description,
          curator, curator_contact, image_url, acceptance_rate, price_rub, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id, name, platform, Number(followers) || 0,
        genre || null, region || null, description || null,
        curator || null, curator_contact || null, image_url || null,
        Math.max(0, Math.min(100, Number(acceptance_rate) || 0)),
        Math.max(0, Number(price_rub) || 0),
        adminId,
      ]
    );
    return c.json({ success: true, id });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

function patchHandlerFor(table: string, allowed: string[]) {
  return async (c: any) => {
    try {
      await ensureSchema();
      const id = c.req.param('id');
      const body = await c.req.json();
      const sets: string[] = [];
      const args: any[] = [];
      let i = 1;
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          sets.push(`${key} = $${i++}`);
          args.push((body as any)[key]);
        }
      }
      if (sets.length === 0) return c.json({ success: false, error: 'No editable fields supplied' }, 400);
      args.push(id);
      const r = await pool.query(
        `UPDATE ${table} SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING id`,
        args
      );
      if (r.rows.length === 0) return c.json({ success: false, error: 'Not found' }, 404);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ success: false, error: safeErrorMessage(error) }, 500);
    }
  };
}

function archiveHandlerFor(table: string) {
  return async (c: any) => {
    try {
      await ensureSchema();
      const id = c.req.param('id');
      const r = await pool.query(
        `UPDATE ${table} SET status = 'archived', updated_at = NOW() WHERE id = $1 RETURNING id`,
        [id]
      );
      if (r.rows.length === 0) return c.json({ success: false, error: 'Not found' }, 404);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ success: false, error: safeErrorMessage(error) }, 500);
    }
  };
}

app.put('/admin/playlists/:id', requireAuth, requireAdmin, patchHandlerFor(
  'pitching_playlists',
  ['name', 'platform', 'followers', 'genre', 'region', 'description',
   'curator', 'curator_contact', 'image_url', 'acceptance_rate', 'price_rub', 'status'],
));
app.delete('/admin/playlists/:id', requireAuth, requireAdmin, archiveHandlerFor('pitching_playlists'));

app.post('/admin/influencers', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const body = await c.req.json();
    const { name, platform, handle, followers, engagement_rate, category, region,
            description, contact, image_url, price_rub } = body || {};
    if (!name || !platform) {
      return c.json({ success: false, error: 'name and platform are required' }, 400);
    }
    const id = generateId('inf');
    const adminId = c.get('userId') as string;
    await pool.query(
      `INSERT INTO pitching_influencers
         (id, name, platform, handle, followers, engagement_rate, category,
          region, description, contact, image_url, price_rub, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id, name, platform, handle || null,
        Number(followers) || 0,
        Math.max(0, Math.min(100, Number(engagement_rate) || 0)),
        category || null, region || null, description || null,
        contact || null, image_url || null,
        Math.max(0, Number(price_rub) || 0),
        adminId,
      ]
    );
    return c.json({ success: true, id });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.put('/admin/influencers/:id', requireAuth, requireAdmin, patchHandlerFor(
  'pitching_influencers',
  ['name', 'platform', 'handle', 'followers', 'engagement_rate', 'category',
   'region', 'description', 'contact', 'image_url', 'price_rub', 'status'],
));
app.delete('/admin/influencers/:id', requireAuth, requireAdmin, archiveHandlerFor('pitching_influencers'));

app.post('/admin/media-outlets', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const body = await c.req.json();
    const { name, outlet_type, readers, reach, region, description,
            contact_email, website, image_url, price_rub } = body || {};
    if (!name || !outlet_type) {
      return c.json({ success: false, error: 'name and outlet_type are required' }, 400);
    }
    const id = generateId('med');
    const adminId = c.get('userId') as string;
    await pool.query(
      `INSERT INTO pitching_media_outlets
         (id, name, outlet_type, readers, reach, region, description,
          contact_email, website, image_url, price_rub, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id, name, outlet_type,
        Number(readers) || 0,
        reach || null, region || null, description || null,
        contact_email || null, website || null, image_url || null,
        Math.max(0, Number(price_rub) || 0),
        adminId,
      ]
    );
    return c.json({ success: true, id });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.put('/admin/media-outlets/:id', requireAuth, requireAdmin, patchHandlerFor(
  'pitching_media_outlets',
  ['name', 'outlet_type', 'readers', 'reach', 'region', 'description',
   'contact_email', 'website', 'image_url', 'price_rub', 'status'],
));
app.delete('/admin/media-outlets/:id', requireAuth, requireAdmin, archiveHandlerFor('pitching_media_outlets'));

// ── Admin: submissions moderation ─────────────────────────────────────────────

app.get('/admin/submissions', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const statusFilter = c.req.query('status');
    const categoryFilter = c.req.query('category');
    const conditions: string[] = [];
    const args: any[] = [];

    if (statusFilter) {
      conditions.push(`status = $${args.length + 1}`);
      args.push(statusFilter);
    } else {
      conditions.push(`status != 'pending_payment'`);
    }
    if (categoryFilter) {
      conditions.push(`category = $${args.length + 1}`);
      args.push(categoryFilter);
    }

    const sql = `
      SELECT id, user_id, category, target_id, target_name, track_id, video_id,
             message, price_rub, payment_session_id, status,
             moderator_id, moderator_response, created_at, updated_at
      FROM pitching_submissions
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 500
    `;
    const r = await pool.query(sql, args);
    return c.json({ success: true, submissions: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.put('/admin/submissions/:id', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const id = c.req.param('id');
    const { status, response } = await c.req.json();
    if (!['accepted', 'rejected'].includes(status)) {
      return c.json({ success: false, error: 'status must be "accepted" or "rejected"' }, 400);
    }
    const adminId = c.get('userId') as string;
    const r = await pool.query(
      `UPDATE pitching_submissions
         SET status = $1, moderator_id = $2, moderator_response = $3, updated_at = NOW()
       WHERE id = $4 AND status = 'pending'
       RETURNING user_id, target_name, category`,
      [status, adminId, response || null, id]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Submission not found or already moderated' }, 404);
    }

    const sub = r.rows[0];
    try {
      await notifyCrossCabinet({
        targetUserId: sub.user_id,
        targetRole: 'artist',
        sourceRole: 'admin',
        type: 'pitching_update',
        title: status === 'accepted' ? 'Заявка на питчинг принята' : 'Заявка на питчинг отклонена',
        message: response ? `${sub.target_name}: ${response}` : `${sub.target_name}`,
        metadata: { submissionId: id, status, category: sub.category },
      });
    } catch (e: any) {
      console.warn('[pitching] artist notify failed:', e?.message);
    }

    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

/**
 * INTERNAL — called by checkout webhook when a pitching_bundle session is paid.
 * Flips all submissions for that order from pending_payment to pending and
 * fans out admin notifications. Exported so checkout-routes.tsx can wire it
 * in without going back through HTTP.
 */
export async function finalizePitchingBundle(orderId: string, submissionIds: string[]): Promise<void> {
  await ensureSchema();
  if (submissionIds.length === 0) return;

  const r = await pool.query(
    `UPDATE pitching_submissions
       SET status = 'pending', updated_at = NOW()
     WHERE id = ANY($1) AND status = 'pending_payment' AND payment_session_id = $2
     RETURNING id, user_id, target_name, category`,
    [submissionIds, orderId]
  );
  if (r.rows.length === 0) return;

  for (const row of r.rows) {
    try {
      await notifyAllAdmins({
        sourceRole: 'artist',
        type: 'admin_action',
        title: 'Новая заявка на питчинг',
        message: `Артист ${row.user_id} → «${row.target_name}» (${row.category})`,
        link: 'pitching-moderation',
        metadata: { submissionId: row.id, orderId, category: row.category },
      });
    } catch (e: any) {
      console.warn('[pitching] notifyAllAdmins (paid) failed:', e?.message);
    }
  }
}

export default app;
