/**
 * PITCHING ROUTES — каталог стриминговых плейлистов + сабмиссии артистов с оплатой ЮКассой
 *
 * Pitching на этой платформе — это distribution трека/видео в стриминговые
 * плейлисты (Spotify / Apple Music / Яндекс.Музыка / Deezer и т.п.).
 * Радиостанции и заведения — отдельные фичи, в этом модуле их нет.
 *
 * Денежный путь:
 *   1. Артист на /pitching-page собирает «корзину» позиций из каталога
 *   2. POST /pitching/submit создаёт N submissions со status='pending_payment'
 *      и одну ЮКасса-сессию на сумму всех позиций; возвращает confirmation_url
 *   3. Артист уходит на ЮКассу, оплачивает, ЮКасса дёргает /checkout/webhook/yookassa
 *   4. Webhook видит metadata.itemType='pitching_bundle' и переводит submissions
 *      из pending_payment → pending (модерация), notifyAllAdmins по каждой
 *   5. Админ модерирует через /pitching/admin/submissions — артист получает SSE push
 *
 * Public/auth endpoints:
 *   GET    /pitching/playlists                — каталог активных плейлистов
 *   GET    /pitching/submissions              — собственные сабмиссии артиста
 *   POST   /pitching/submit                   — bundle-сабмит (создаёт payment session)
 *
 * Admin endpoints (requireAdmin):
 *   POST   /pitching/admin/playlists          — создать плейлист
 *   PUT    /pitching/admin/playlists/:id      — обновить
 *   DELETE /pitching/admin/playlists/:id      — архивировать (soft delete)
 *   GET    /pitching/admin/submissions        — все сабмиссии (фильтр по status)
 *   PUT    /pitching/admin/submissions/:id    — модерация (accepted/rejected + response)
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';
import { notifyAllAdmins, notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { getGateway, type PaymentSession } from './payment-gateway.tsx';
import { upsertPaymentSession } from './db.tsx';

const app = new Hono();

// ── Schema bootstrap (idempotent) ────────────────────────────────────────────

let schemaReady: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    // 1. Catalog: streaming playlists with price.
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
    // Add columns to pre-existing deployments where the table was created
    // by an earlier schema (without price/curator/image_url/acceptance_rate).
    await pool.query(`
      ALTER TABLE pitching_playlists
        ADD COLUMN IF NOT EXISTS curator TEXT,
        ADD COLUMN IF NOT EXISTS image_url TEXT,
        ADD COLUMN IF NOT EXISTS acceptance_rate INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS price_rub NUMERIC(10, 2) NOT NULL DEFAULT 0;
    `);

    // 2. Submissions log with payment fields.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitching_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
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
    `);
    // Idempotent column adds for pre-existing deployments.
    await pool.query(`
      ALTER TABLE pitching_submissions
        ADD COLUMN IF NOT EXISTS price_rub NUMERIC(10, 2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS payment_session_id TEXT;
    `);
    // Drop the now-unused submission_type column if it exists. Pitching is
    // always playlist-targeted in this module; the column is a leftover from
    // the radio-stations era.
    await pool.query(`
      ALTER TABLE pitching_submissions DROP COLUMN IF EXISTS submission_type;
    `);

    // 3. One-time cleanup of legacy fake submissions: anything created before
    // the payment column existed had status='pending' but no money behind it.
    // Per "Удалить все старые (Recommended)" — purge them so admins don't see
    // ghost rows in /admin/moderation/pitchings.
    await pool.query(`
      DELETE FROM pitching_submissions WHERE price_rub = 0 AND payment_session_id IS NULL;
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

// ── Artist submissions ────────────────────────────────────────────────────────

app.get('/submissions', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const userId = c.get('userId') as string;
    const r = await pool.query(
      `SELECT id, target_id, target_name, track_id, video_id, message,
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
 *       { targetId: 'p1', trackId?: '...', videoId?: '...', message?: '...' },
 *       ...
 *     ],
 *     returnUrl: 'https://promo-music.ru/cabinet/pitching?paid=1'
 *   }
 *
 * Pricing is server-authoritative: prices come from pitching_playlists.price_rub,
 * not from the client (client never gets to set its own price). Submissions are
 * created in status='pending_payment' and only flip to 'pending' (moderation
 * queue) when the YooKassa webhook confirms payment.
 *
 * Returns: { success, orderId, confirmationUrl, amount, submission_ids }
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
      return c.json({ success: false, error: 'Слишком много позиций в одном питче (максимум 50)' }, 400);
    }
    if (!returnUrl) {
      return c.json({ success: false, error: 'returnUrl обязателен' }, 400);
    }
    // Validate every item has a track or video.
    for (const it of items) {
      if (!it?.targetId) {
        return c.json({ success: false, error: 'Каждая позиция должна содержать targetId' }, 400);
      }
      if (!it?.trackId && !it?.videoId) {
        return c.json({ success: false, error: 'Каждая позиция должна содержать trackId или videoId' }, 400);
      }
    }

    // Load all selected catalog rows in one query — server-authoritative pricing.
    const targetIds: string[] = Array.from(new Set(items.map((it: any) => String(it.targetId))));
    const catalogRes = await pool.query(
      `SELECT id, name, price_rub FROM pitching_playlists WHERE id = ANY($1) AND status = 'active'`,
      [targetIds]
    );
    const catalog = new Map<string, { name: string; price_rub: number }>();
    for (const row of catalogRes.rows) {
      catalog.set(row.id, { name: row.name, price_rub: Number(row.price_rub) });
    }

    // Bail out if any selected target was missing/archived. Don't half-submit.
    for (const id of targetIds) {
      if (!catalog.has(id)) {
        return c.json({ success: false, error: `Площадка ${id} недоступна для питчинга` }, 400);
      }
    }

    // Sum prices, create submissions.
    const orderId = crypto.randomUUID();
    let total = 0;
    const submissionIds: string[] = [];

    // BEGIN a transaction so a partial failure doesn't leave orphan submissions.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const it of items) {
        const cat = catalog.get(String(it.targetId))!;
        const id = generateId('pit');
        await client.query(
          `INSERT INTO pitching_submissions
             (id, user_id, target_id, target_name, track_id, video_id, message,
              price_rub, payment_session_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_payment')`,
          [
            id,
            userId,
            it.targetId,
            cat.name,
            it.trackId || null,
            it.videoId || null,
            it.message || null,
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

    // Edge case: free catalog (price_rub=0 everywhere). Skip the gateway hop
    // and flip the submissions straight to 'pending'.
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

    // Create the YooKassa session. metadata.itemType='pitching_bundle' tells
    // the checkout webhook handler to flip submissions to 'pending'.
    const gw = getGateway('yookassa');
    const description = items.length === 1
      ? `Питчинг в «${catalog.get(items[0].targetId)!.name}»`
      : `Питчинг: ${items.length} позиций`;

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

app.post('/admin/playlists', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const body = await c.req.json();
    const {
      name, platform, followers, genre, region, description,
      curator, curator_contact, image_url, acceptance_rate, price_rub,
    } = body || {};
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

app.put('/admin/playlists/:id', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const id = c.req.param('id');
    const body = await c.req.json();
    const allowed = [
      'name', 'platform', 'followers', 'genre', 'region', 'description',
      'curator', 'curator_contact', 'image_url', 'acceptance_rate', 'price_rub', 'status',
    ];
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
      `UPDATE pitching_playlists SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING id`,
      args
    );
    if (r.rows.length === 0) return c.json({ success: false, error: 'Playlist not found' }, 404);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.delete('/admin/playlists/:id', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const id = c.req.param('id');
    const r = await pool.query(
      `UPDATE pitching_playlists SET status = 'archived', updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id]
    );
    if (r.rows.length === 0) return c.json({ success: false, error: 'Playlist not found' }, 404);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Admin: submissions moderation ─────────────────────────────────────────────

app.get('/admin/submissions', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const statusFilter = c.req.query('status'); // optional: pending | accepted | rejected | pending_payment
    let sql = `SELECT id, user_id, target_id, target_name, track_id, video_id,
                       message, price_rub, payment_session_id, status,
                       moderator_id, moderator_response, created_at, updated_at
                FROM pitching_submissions`;
    const args: any[] = [];
    if (statusFilter) {
      sql += ` WHERE status = $1`;
      args.push(statusFilter);
    } else {
      // Default: hide pending_payment rows from the moderation queue — those
      // are payment limbo, not real submissions yet. Admins can still see them
      // by passing ?status=pending_payment explicitly.
      sql += ` WHERE status != 'pending_payment'`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 500`;
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
       RETURNING user_id, target_name`,
      [status, adminId, response || null, id]
    );
    if (r.rows.length === 0) {
      return c.json({ success: false, error: 'Submission not found or already moderated' }, 404);
    }

    // Notify the artist about the decision.
    const sub = r.rows[0];
    try {
      await notifyCrossCabinet({
        targetUserId: sub.user_id,
        targetRole: 'artist',
        sourceRole: 'admin',
        type: 'pitching_update',
        title: status === 'accepted' ? 'Заявка на питчинг принята' : 'Заявка на питчинг отклонена',
        message: response ? `${sub.target_name}: ${response}` : `${sub.target_name}`,
        metadata: { submissionId: id, status },
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

  // Only flip rows that are still in pending_payment — guards against double
  // webhook deliveries.
  const r = await pool.query(
    `UPDATE pitching_submissions
       SET status = 'pending', updated_at = NOW()
     WHERE id = ANY($1) AND status = 'pending_payment' AND payment_session_id = $2
     RETURNING id, user_id, target_name`,
    [submissionIds, orderId]
  );
  if (r.rows.length === 0) return;

  for (const row of r.rows) {
    try {
      await notifyAllAdmins({
        sourceRole: 'artist',
        type: 'admin_action',
        title: 'Новая заявка на питчинг',
        message: `Артист ${row.user_id} → «${row.target_name}»`,
        link: 'pitching-moderation',
        metadata: { submissionId: row.id, orderId },
      });
    } catch (e: any) {
      console.warn('[pitching] notifyAllAdmins (paid) failed:', e?.message);
    }
  }
}

export default app;
