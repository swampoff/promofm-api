// СОБСТВЕННЫЙ ФОНОВЫЙ КАТАЛОГ ПРОМО.ЭИР (27.09.2026)
//
// Решение владельца: каталог инструментальной музыки по форматам заведений
// (Lounge, Cafe, Deep House, Chillout, Sport, Workout, Meditation, Focus,
// Restaurant, Hotel, Spa). Треки делаются на арендованном GPU скриптами
// services/promo-air-catalog и заливаются сюда: POST /ingest (ключ AIR_CATALOG_KEY,
// отдельный от VPS_INTERNAL_KEY — у GPU-машины минимум прав).
// Составитель и продюсер каталога — Моисеев Н. В., изготовитель фонограмм —
// ООО «ПФМ». По каждому треку храним провенанс: модель, версия, промпт, seed.
// ⛔ Коммерческая тайна: способ создания каталога публично не раскрывается.

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';

const app = new Hono();

const CATALOG_DIR = process.env.AIR_CATALOG_DIR || '/mnt/data/promo-air-catalog';
const INGEST_KEY = process.env.AIR_CATALOG_KEY || '';
const MAX_BYTES = 25 * 1024 * 1024;
export const CATALOG_GENRES = ['lounge', 'cafe', 'deep-house', 'chillout', 'sport', 'workout', 'meditation', 'focus', 'restaurant', 'hotel', 'spa'] as const;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,120}$/;
const STATUSES = new Set(['new', 'approved', 'rejected']);

// MP3: ID3-тег или кадр MPEG (0xFFE?)
const isMp3 = (b: Buffer) => b.length > 4 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0));
const num = (v: any) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

app.post('/ingest', async (c) => {
  if (!INGEST_KEY || c.req.header('X-Catalog-Key') !== INGEST_KEY) return c.json({ error: 'Unauthorized' }, 401);
  let body: Record<string, any>;
  try { body = await c.req.parseBody(); } catch { return c.json({ error: 'Bad multipart' }, 400); }
  const file = body.file as File | undefined;
  let meta: any;
  try { meta = JSON.parse(String(body.meta || '{}')); } catch { return c.json({ error: 'Bad meta' }, 400); }
  const id = String(meta.id || '');
  const genre = String(meta.genre || '');
  if (!ID_RE.test(id)) return c.json({ error: 'Bad id' }, 400);
  if (!(CATALOG_GENRES as readonly string[]).includes(genre)) return c.json({ error: 'Bad genre' }, 400);
  if (!meta.prompt || !meta.model) return c.json({ error: 'prompt and model required' }, 400);
  if (!file || typeof (file as any).arrayBuffer !== 'function') return c.json({ error: 'file required' }, 400);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length < 50_000 || buf.length > MAX_BYTES) return c.json({ error: 'Bad size' }, 400);
  if (!isMp3(buf)) return c.json({ error: 'Not an MP3' }, 400);

  const fs = await import('fs/promises');
  const dir = `${CATALOG_DIR}/${genre}`;
  const path = `${dir}/${id}.mp3`;
  const { rows: existing } = await pool.query(`SELECT 1 FROM air_catalog_tracks WHERE id = $1`, [id]);
  if (existing.length) return c.json({ ok: true, duplicate: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${path}.part`, buf);
  await fs.rename(`${path}.part`, path);
  await pool.query(
    `INSERT INTO air_catalog_tracks
       (id, genre, prompt_id, variation, prompt, negative_prompt, model, model_version, seed, steps,
        duration_sec, bpm, loudness_lufs, peak_db, file_path, bytes, generated_at, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      id, genre, meta.prompt_id || null, num(meta.variation), String(meta.prompt).slice(0, 2000),
      meta.negative_prompt ? String(meta.negative_prompt).slice(0, 1000) : null,
      String(meta.model).slice(0, 80), meta.model_version ? String(meta.model_version).slice(0, 120) : null,
      num(meta.seed), num(meta.steps), num(meta.duration_sec), num(meta.bpm), num(meta.loudness_lufs), num(meta.peak_db),
      path, buf.length, meta.generated_at && !Number.isNaN(Date.parse(meta.generated_at)) ? meta.generated_at : null,
      JSON.stringify(meta.extra || {}),
    ],
  );
  return c.json({ ok: true, id, bytes: buf.length });
});

// ─── Админ: прослушивание и отбор ─────────────────────────────────────────

app.get('/admin/stats', requireAuth, requireAdmin, async (c) => {
  const { rows } = await pool.query(
    `SELECT genre, model, status, count(*)::int AS n, round(sum(duration_sec) / 3600, 1)::float AS hours, sum(bytes)::bigint AS bytes
       FROM air_catalog_tracks GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  );
  return c.json({ success: true, data: rows });
});

app.get('/admin/tracks', requireAuth, requireAdmin, async (c) => {
  const genre = c.req.query('genre') || null;
  const model = c.req.query('model') || null;
  const status = c.req.query('status') || null;
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 100));
  const { rows } = await pool.query(
    `SELECT id, genre, prompt, model, seed, duration_sec, bpm, loudness_lufs, status, created_at
       FROM air_catalog_tracks
      WHERE ($1::text IS NULL OR genre = $1) AND ($2::text IS NULL OR model = $2) AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC LIMIT $4`,
    [genre, model, status, limit],
  );
  return c.json({ success: true, data: rows });
});

app.get('/admin/file/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'Bad id' }, 400);
  const { rows } = await pool.query(`SELECT file_path FROM air_catalog_tracks WHERE id = $1`, [id]);
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  const fs = await import('fs/promises');
  const buf = await fs.readFile(rows[0].file_path).catch(() => null);
  if (!buf) return c.json({ error: 'File missing' }, 404);
  c.header('Content-Type', 'audio/mpeg');
  c.header('Cache-Control', 'private, max-age=3600');
  return c.body(buf);
});

app.post('/admin/tracks/:id/status', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  const body: any = await c.req.json().catch(() => ({}));
  if (!ID_RE.test(id) || !STATUSES.has(body?.status)) return c.json({ success: false, error: 'Bad request' }, 400);
  const { rowCount } = await pool.query(`UPDATE air_catalog_tracks SET status = $2 WHERE id = $1`, [id, body.status]);
  return c.json({ success: !!rowCount });
});

export default app;
