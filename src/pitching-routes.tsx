/**
 * PITCHING ROUTES — каталог плейлистов/радиостанций + сабмиссии артистов + админ-модерация
 *
 * До этого рефакторинга весь модуль был фейком: каталог хардкоден массивами,
 * submit-pitch/submit-radio только писали в console.log и возвращали выдуманный
 * submissionId. Артисты «питчинговали» в пустоту, никто не модерировал.
 *
 * Public/auth endpoints:
 *   GET    /pitching/playlists                — список активных плейлистов
 *   GET    /pitching/radio-stations           — список активных радиостанций
 *   GET    /pitching/submissions              — собственные сабмиссии артиста
 *   POST   /pitching/submit-pitch             — сабмишшен на плейлист (трек/видео)
 *   POST   /pitching/submit-radio             — сабмишшен на радиостанцию
 *
 * Admin endpoints (requireAdmin):
 *   POST   /pitching/admin/playlists          — создать плейлист
 *   PUT    /pitching/admin/playlists/:id      — обновить
 *   DELETE /pitching/admin/playlists/:id      — архивировать (soft delete)
 *   POST   /pitching/admin/radio-stations     — создать радиостанцию
 *   PUT    /pitching/admin/radio-stations/:id — обновить
 *   DELETE /pitching/admin/radio-stations/:id — архивировать
 *   GET    /pitching/admin/submissions        — все сабмиссии (фильтр по status)
 *   PUT    /pitching/admin/submissions/:id    — модерация (status + response)
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';
import { notifyAllAdmins, notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { applySubscriptionDiscount } from './subscription-pricing.tsx';

const app = new Hono();

// ── Schema bootstrap (idempotent) ────────────────────────────────────────────
//
// Same self-bootstrap pattern as src/waitlist-routes.tsx. Runs CREATE TABLE
// IF NOT EXISTS on first hit to any pitching endpoint — no manual SSH-DDL step
// required on deploy. Seeds the catalog with the previous hardcoded entries
// so existing fronts don't see an empty list on first deploy.

let schemaReady: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitching_playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        followers BIGINT NOT NULL DEFAULT 0,
        genre TEXT,
        region TEXT,
        description TEXT,
        curator_contact TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pitching_playlists_status ON pitching_playlists(status);
      CREATE INDEX IF NOT EXISTS idx_pitching_playlists_platform ON pitching_playlists(platform);
    `);
    // pitching_radio_stations is provisioned as a VIEW over pitching_radio
    // by migration 009_pitching_schema_bridge.sql (970 legacy radio rows).
    // CREATE TABLE here used to throw "is not a table" at runtime, which
    // crashed every pitching endpoint via the lazy ensureSchema promise.
    // The migration is the canonical source; ensureSchema must not own
    // the schema for this name.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitching_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        submission_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_name TEXT,
        track_id TEXT,
        video_id TEXT,
        mix_id TEXT,
        actor_role TEXT NOT NULL DEFAULT 'artist',
        message TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        moderator_id TEXT,
        moderator_response TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- Self-heal for existing deployments that pre-date the DJ flow.
      ALTER TABLE pitching_submissions
        ADD COLUMN IF NOT EXISTS mix_id TEXT,
        ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'artist';
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_user ON pitching_submissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_actor_role ON pitching_submissions(actor_role);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_mix ON pitching_submissions(mix_id);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_status ON pitching_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_target ON pitching_submissions(target_id);
    `);
    // Seed removed 2026-05-23: pitching_playlists.id is uuid in prod
    // (legacy schema), hardcoded 'p1'/'p2' strings failed with
    // "invalid input syntax for type uuid". pitching_radio_stations
    // is a VIEW with 970 real radio rows backfilled from migration 009 —
    // seed would no-op anyway (count > 0). Catalog data comes from
    // admin UI, not bootstrap defaults.
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
      `SELECT id, name, platform, followers, genre, region, description, curator_contact
       FROM pitching_playlists WHERE status = 'active'
       ORDER BY followers DESC, name ASC`
    );
    return c.json({ success: true, playlists: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.get('/radio-stations', async (c) => {
  try {
    await ensureSchema();
    const r = await pool.query(
      `SELECT id, name, region, country, genre, website, contact_email
       FROM pitching_radio_stations WHERE status = 'active'
       ORDER BY name ASC`
    );
    return c.json({ success: true, stations: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Submissions (artist) ──────────────────────────────────────────────────────

app.get('/submissions', requireAuth, async (c) => {
  try {
    await ensureSchema();
    const userId = c.get('userId') as string;
    const r = await pool.query(
      `SELECT id, submission_type, target_id, target_name, track_id, video_id,
              message, status, moderator_response, created_at, updated_at
       FROM pitching_submissions WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 200`,
      [userId]
    );
    return c.json({ success: true, submissions: r.rows });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

async function createSubmission(c: any, submissionType: 'playlist' | 'radio' | 'influencer' | 'outlet') {
  await ensureSchema();
  const userId = c.get('userId') as string;
  const body = await c.req.json();
  const { targetId, trackId, videoId, mixId, message, targetName: targetNameFromBody } = body || {};

  if (!targetId) {
    return c.json({ success: false, error: 'targetId is required' }, 400);
  }
  if (!trackId && !videoId && !mixId) {
    return c.json({ success: false, error: 'Either trackId, videoId or mixId is required' }, 400);
  }

  // Если mixId — проверяем владение DJ + статус published (нельзя
  // питчить чужой / неопубликованный / в модерации микс).
  if (mixId) {
    const mxRow = await pool.query(
      `SELECT dj_id, moderation_status FROM dj_mixes WHERE id = $1 LIMIT 1`,
      [mixId]
    );
    if (mxRow.rows.length === 0) {
      return c.json({ success: false, error: 'Микс не найден' }, 404);
    }
    if (mxRow.rows[0].dj_id !== userId) {
      return c.json({ success: false, error: 'Нельзя питчить чужой микс' }, 403);
    }
    if (mxRow.rows[0].moderation_status !== 'published') {
      return c.json({
        success: false,
        error: `Микс должен быть опубликован для питчинга (статус: ${mxRow.rows[0].moderation_status})`,
      }, 400);
    }
  }

  // Soft target lookup — playlists & radio stations live in their own
  // catalogue tables. Influencer and outlet catalogues are frontend-only
  // for now (catalogInfluencers / catalogMediaOutlets in src/data), so
  // we trust the targetName from the request body for those types.
  let targetName: string = targetNameFromBody || targetId;
  if (submissionType === 'playlist' || submissionType === 'radio') {
    const targetTable = submissionType === 'playlist' ? 'pitching_playlists' : 'pitching_radio_stations';
    const targetRow = await pool.query(
      `SELECT name FROM ${targetTable} WHERE id = $1 AND status = 'active'`,
      [targetId]
    );
    targetName = (targetRow.rows[0]?.name as string) || targetName;
  }

  // Prevent duplicate pending submission of the same track/video/mix to the same target.
  const dup = await pool.query(
    `SELECT id FROM pitching_submissions
     WHERE user_id = $1 AND target_id = $2 AND status = 'pending'
       AND COALESCE(track_id, '') = COALESCE($3, '')
       AND COALESCE(video_id, '') = COALESCE($4, '')
       AND COALESCE(mix_id, '')   = COALESCE($5, '')`,
    [userId, targetId, trackId || null, videoId || null, mixId || null]
  );
  if (dup.rows.length > 0) {
    return c.json({ success: false, error: 'Заявка уже отправлена и ждёт модерации' }, 409);
  }

  const id = generateId('pit');
  await pool.query(
    `INSERT INTO pitching_submissions
       (id, user_id, submission_type, target_id, target_name, track_id, video_id, mix_id, message, status, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)`,
    [id, userId, submissionType, targetId, targetName, trackId || null, videoId || null, mixId || null, message || null, mixId ? 'dj' : 'artist']
  );

  try {
    await notifyAllAdmins({
      sourceRole: 'artist',
      type: 'admin_action',
      title:
        submissionType === 'playlist' ? 'Новая заявка на плейлист'
      : submissionType === 'radio'    ? 'Новая заявка на радиостанцию'
      : submissionType === 'influencer' ? 'Новая заявка блогеру'
      : submissionType === 'outlet'   ? 'Новый пресс-релиз'
      : 'Новая заявка на питчинг',
      message: `Артист ${userId} → «${targetName}»`,
      link: 'pitching-moderation',
      metadata: { submissionId: id, targetId, submissionType },
    });
  } catch (e: any) {
    console.warn('[pitching] notifyAllAdmins failed:', e?.message);
  }

  return c.json({ success: true, submissionId: id });
}

app.post('/submit-pitch', requireAuth, async (c) => {
  try {
    return await createSubmission(c, 'playlist');
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/submit-radio', requireAuth, async (c) => {
  try {
    return await createSubmission(c, 'radio');
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/submit-influencer', requireAuth, async (c) => {
  try {
    return await createSubmission(c, 'influencer');
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/submit-outlet', requireAuth, async (c) => {
  try {
    return await createSubmission(c, 'outlet');
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Admin: catalog CRUD ───────────────────────────────────────────────────────

app.post('/admin/playlists', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const body = await c.req.json();
    const { name, platform, followers, genre, region, description, curator_contact } = body || {};
    if (!name || !platform) {
      return c.json({ success: false, error: 'name and platform are required' }, 400);
    }
    const id = generateId('pl');
    const adminId = c.get('userId') as string;
    await pool.query(
      `INSERT INTO pitching_playlists
         (id, name, platform, followers, genre, region, description, curator_contact, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, name, platform, Number(followers) || 0, genre || null, region || null,
       description || null, curator_contact || null, adminId]
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
    const allowed = ['name', 'platform', 'followers', 'genre', 'region', 'description', 'curator_contact', 'status'];
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

app.post('/admin/radio-stations', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const body = await c.req.json();
    const { name, region, country, genre, website, contact_email } = body || {};
    if (!name) return c.json({ success: false, error: 'name is required' }, 400);
    const id = generateId('rs');
    const adminId = c.get('userId') as string;
    await pool.query(
      `INSERT INTO pitching_radio_stations
         (id, name, region, country, genre, website, contact_email, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, name, region || null, country || null, genre || null, website || null, contact_email || null, adminId]
    );
    return c.json({ success: true, id });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.put('/admin/radio-stations/:id', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const id = c.req.param('id');
    const body = await c.req.json();
    const allowed = ['name', 'region', 'country', 'genre', 'website', 'contact_email', 'status'];
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
      `UPDATE pitching_radio_stations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING id`,
      args
    );
    if (r.rows.length === 0) return c.json({ success: false, error: 'Station not found' }, 404);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.delete('/admin/radio-stations/:id', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    const id = c.req.param('id');
    const r = await pool.query(
      `UPDATE pitching_radio_stations SET status = 'archived', updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id]
    );
    if (r.rows.length === 0) return c.json({ success: false, error: 'Station not found' }, 404);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── Admin: submissions moderation ─────────────────────────────────────────────

app.get('/admin/submissions', requireAuth, requireAdmin, async (c) => {
  try {
    await ensureSchema();
    // Ensure DJ columns even on instances that haven't run migration 006 yet
    await pool.query(`
      ALTER TABLE IF EXISTS pitching_submissions
        ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'artist',
        ADD COLUMN IF NOT EXISTS mix_id TEXT
    `).catch(() => {});

    const statusFilter = c.req.query('status'); // optional: pending | accepted | rejected
    const actorFilter = c.req.query('actor');   // optional: artist | dj
    let sql = `SELECT id, user_id, submission_type, target_id, target_name, track_id, video_id, mix_id,
                       message, status, moderator_id, moderator_response, actor_role,
                       created_at, updated_at
                FROM pitching_submissions`;
    const args: any[] = [];
    const conds: string[] = [];
    if (statusFilter) { conds.push(`status = $${args.length + 1}`); args.push(statusFilter); }
    if (actorFilter)  { conds.push(`actor_role = $${args.length + 1}`); args.push(actorFilter); }
    if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
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
       WHERE id = $4
       RETURNING user_id, target_name, submission_type, actor_role, mix_id`,
      [status, adminId, response || null, id]
    );
    if (r.rows.length === 0) return c.json({ success: false, error: 'Submission not found' }, 404);

    // Notify the submitter (artist or dj) about the moderation decision
    const sub = r.rows[0];
    const targetRole: 'artist' | 'dj' = sub.actor_role === 'dj' ? 'dj' : 'artist';
    try {
      await notifyCrossCabinet({
        targetUserId: sub.user_id,
        targetRole,
        sourceRole: 'admin',
        type: 'pitching_update',
        title: status === 'accepted' ? 'Заявка на питчинг принята' : 'Заявка на питчинг отклонена',
        message: response
          ? `${sub.target_name || ''}: ${response}`
          : `${sub.target_name || ''}`,
        metadata: {
          submissionId: id, status,
          submissionType: sub.submission_type,
          actorRole: sub.actor_role || 'artist',
          mixId: sub.mix_id || null,
        },
      });
    } catch (e: any) {
      console.warn('[pitching] submitter notify failed:', e?.message);
    }

    return c.json({ success: true });
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
        // Apply subscriber discount per row (subscription tier from
        // SUBSCRIPTION_PLANS.discounts.pitching: spark=0, start=5%,
        // pro=10%, elite=15%). Failure to look up the subscription
        // returns full price — never under-charges.
        const priced = await applySubscriptionDiscount(userId, 'pitching', cat.price_rub);
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
            priced.finalPrice,
            orderId,
          ]
        );
        submissionIds.push(id);
        total += priced.finalPrice;
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
