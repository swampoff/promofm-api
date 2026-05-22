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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitching_radio_stations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        region TEXT,
        country TEXT,
        genre TEXT,
        website TEXT,
        contact_email TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pitching_radio_status ON pitching_radio_stations(status);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitching_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        submission_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_name TEXT,
        track_id TEXT,
        video_id TEXT,
        message TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        moderator_id TEXT,
        moderator_response TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_user ON pitching_submissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_status ON pitching_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_pitching_submissions_target ON pitching_submissions(target_id);
    `);
    // Seed once if empty so the frontend's first load isn't blank.
    const pCount = await pool.query(`SELECT COUNT(*)::int AS n FROM pitching_playlists`);
    if (Number(pCount.rows[0]?.n || 0) === 0) {
      await pool.query(`
        INSERT INTO pitching_playlists (id, name, platform, followers, genre) VALUES
          ('p1', 'New Music Friday', 'Spotify',     5000000, NULL),
          ('p2', 'Top Hits',         'Apple Music', 3000000, 'Pop'),
          ('p3', 'Electronic Rising','Spotify',      800000, 'Electronic'),
          ('p4', 'Indie Radar',      'Deezer',       200000, 'Indie')
        ON CONFLICT (id) DO NOTHING
      `);
    }
    const sCount = await pool.query(`SELECT COUNT(*)::int AS n FROM pitching_radio_stations`);
    if (Number(sCount.rows[0]?.n || 0) === 0) {
      await pool.query(`
        INSERT INTO pitching_radio_stations (id, name, region, genre) VALUES
          ('r1', 'Hit FM',           'Global',  'Pop'),
          ('r2', 'Rock Radio',       'USA',     'Rock'),
          ('r3', 'Jazz Cafe',        'France',  'Jazz'),
          ('r4', 'Electronic Waves', 'Germany', 'Electronic')
        ON CONFLICT (id) DO NOTHING
      `);
    }
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

async function createSubmission(c: any, submissionType: 'playlist' | 'radio') {
  await ensureSchema();
  const userId = c.get('userId') as string;
  const body = await c.req.json();
  const { targetId, trackId, videoId, message, targetName: targetNameFromBody } = body || {};

  if (!targetId) {
    return c.json({ success: false, error: 'targetId is required' }, 400);
  }
  if (!trackId && !videoId) {
    return c.json({ success: false, error: 'Either trackId or videoId is required' }, 400);
  }

  // Soft target lookup — the catalog DB stores ids like 'p1'/'p2', but the
  // existing track-pitching modal sends hardcoded ids like 'spotify' /
  // 'apple_music'. Don't reject those; just snapshot whichever name we know.
  const targetTable = submissionType === 'playlist' ? 'pitching_playlists' : 'pitching_radio_stations';
  const targetRow = await pool.query(
    `SELECT name FROM ${targetTable} WHERE id = $1 AND status = 'active'`,
    [targetId]
  );
  const targetName: string = (targetRow.rows[0]?.name as string) || targetNameFromBody || targetId;

  // Prevent duplicate pending submission of the same track/video to the same target.
  const dup = await pool.query(
    `SELECT id FROM pitching_submissions
     WHERE user_id = $1 AND target_id = $2 AND status = 'pending'
       AND COALESCE(track_id, '') = COALESCE($3, '')
       AND COALESCE(video_id, '') = COALESCE($4, '')`,
    [userId, targetId, trackId || null, videoId || null]
  );
  if (dup.rows.length > 0) {
    return c.json({ success: false, error: 'Заявка уже отправлена и ждёт модерации' }, 409);
  }

  const id = generateId('pit');
  await pool.query(
    `INSERT INTO pitching_submissions
       (id, user_id, submission_type, target_id, target_name, track_id, video_id, message, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
    [id, userId, submissionType, targetId, targetName, trackId || null, videoId || null, message || null]
  );

  try {
    await notifyAllAdmins({
      sourceRole: 'artist',
      type: 'admin_action',
      title: submissionType === 'playlist' ? 'Новая заявка на плейлист' : 'Новая заявка на радиостанцию',
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

export default app;
