/**
 * СОБЫТИЯ СЦЕНЫ (16.10.2026): раздел «События» на promo-music.ru.
 *
 * Владелец: «главные мероприятия российской сцены, полезные музыкантам, диджеям,
 * исполнителям… выпускать помесячно». Не концерты (для них /concerts), а то, что
 * полезно самим участникам сцены: конференции, шоукейсы, фестивали с опен-коллом,
 * конкурсы, гранты, образование, диджейские события.
 *
 * Публикация помесячная: у события есть month ('2026-10'), публичная страница
 * показывает вкладки месяцев. Следующий месяц до публикации фронт показывает
 * закладкой «скоро».
 *
 *   GET  /server/api/scene-events?month=YYYY-MM   опубликованные события месяца
 *   GET  /server/api/scene-events/months          месяцы с опубликованными событиями
 *   GET  /server/api/scene-events/admin?month=    все события месяца (админ)
 *   POST /server/api/scene-events/admin           создать событие (админ)
 *   POST /server/api/scene-events/admin/import    пакет событий месяца (админ)
 *   PUT  /server/api/scene-events/admin/:id       изменить (админ)
 *   DELETE /server/api/scene-events/admin/:id     удалить (админ)
 */
import { Hono } from 'hono';
import crypto from 'node:crypto';
import { pool } from './db-client.tsx';
import { createLogger } from './logger.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const log = createLogger('scene-events');
const app = new Hono();

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SCENE_EVENT_KINDS = ['конференция', 'шоукейс', 'фестиваль', 'диджеи', 'конкурс', 'премия', 'грант/опен-колл', 'образование', 'выставка'] as const;
export const SCENE_EVENT_AUDIENCE = ['артисты', 'диджеи', 'продюсеры', 'звукорежиссёры', 'лейблы'] as const;

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scene_events (
          id           TEXT PRIMARY KEY,
          month        TEXT NOT NULL,
          title        TEXT NOT NULL,
          starts_on    DATE NOT NULL,
          ends_on      DATE,
          city         TEXT NOT NULL DEFAULT '',
          venue        TEXT NOT NULL DEFAULT '',
          kind         TEXT NOT NULL DEFAULT 'конференция',
          audience     TEXT[] NOT NULL DEFAULT '{}',
          summary      TEXT NOT NULL DEFAULT '',
          why          TEXT NOT NULL DEFAULT '',
          price        TEXT NOT NULL DEFAULT '',
          deadline     DATE,
          url          TEXT NOT NULL DEFAULT '',
          source_url   TEXT NOT NULL DEFAULT '',
          is_published BOOLEAN NOT NULL DEFAULT true,
          sort         INT NOT NULL DEFAULT 0,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await pool.query('CREATE INDEX IF NOT EXISTS scene_events_month_idx ON scene_events (month, starts_on)');
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// Запрет владельца на длинное тире в текстах сайта: чистим на записи.
const clean = (v: unknown, max = 2000) => String(v ?? '').replace(/—/g, '–').trim().slice(0, max);
const day = (v: unknown) => (typeof v === 'string' && DATE_RE.test(v) ? v : null);
const link = (v: unknown) => {
  const s = clean(v, 500);
  return /^https?:\/\//i.test(s) ? s : '';
};

function normalize(body: any): { ok: true; row: Record<string, any> } | { ok: false; error: string } {
  const title = clean(body?.title, 300);
  const start = day(body?.start ?? body?.startsOn);
  if (!title) return { ok: false, error: 'Нужно название' };
  if (!start) return { ok: false, error: 'Нужна дата начала в формате ГГГГ-ММ-ДД' };
  const end = day(body?.end ?? body?.endsOn) || start;
  const month = MONTH_RE.test(String(body?.month || '')) ? String(body.month) : start.slice(0, 7);
  const kind = clean(body?.kind ?? body?.type, 40) || 'конференция';
  const audience = (Array.isArray(body?.audience) ? body.audience : [])
    .map((a: unknown) => clean(a, 40)).filter((a: string) => a).slice(0, 6);
  return {
    ok: true,
    row: {
      month, title, starts_on: start, ends_on: end < start ? start : end,
      city: clean(body?.city, 120), venue: clean(body?.venue, 200), kind, audience,
      summary: clean(body?.summary, 600), why: clean(body?.why, 400), price: clean(body?.price, 60),
      deadline: day(body?.deadline), url: link(body?.url), source_url: link(body?.source ?? body?.sourceUrl),
      is_published: body?.isPublished !== false, sort: Number.isFinite(Number(body?.sort)) ? Math.round(Number(body.sort)) : 0,
    },
  };
}

const COLS = 'id, month, title, starts_on, ends_on, city, venue, kind, audience, summary, why, price, deadline, url, source_url, is_published, sort';
// DATE приходит из pg как Date на полночь в поясе сервера: toISOString() сдвинул бы день назад.
const p2 = (n: number) => String(n).padStart(2, '0');
const iso = (d: any) => (d instanceof Date ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : d ? String(d).slice(0, 10) : null);
function toJson(r: any) {
  return {
    id: r.id, month: r.month, title: r.title, start: iso(r.starts_on), end: iso(r.ends_on) || iso(r.starts_on),
    city: r.city, venue: r.venue, kind: r.kind, audience: r.audience || [], summary: r.summary, why: r.why,
    price: r.price, deadline: iso(r.deadline), url: r.url, sourceUrl: r.source_url, isPublished: r.is_published, sort: r.sort,
  };
}

async function insertRow(row: Record<string, any>, id = `se-${crypto.randomUUID()}`) {
  await pool.query(
    `INSERT INTO scene_events (${COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, row.month, row.title, row.starts_on, row.ends_on, row.city, row.venue, row.kind, row.audience,
      row.summary, row.why, row.price, row.deadline, row.url, row.source_url, row.is_published, row.sort],
  );
  return id;
}

// ── Публичная часть ──────────────────────────────────────────

app.get('/', async (c) => {
  try {
    await ensureSchema();
    const month = String(c.req.query('month') || '');
    if (!MONTH_RE.test(month)) return c.json({ success: false, error: 'month=YYYY-MM' }, 400);
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM scene_events WHERE month = $1 AND is_published ORDER BY starts_on, sort, title`, [month]);
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({ success: true, month, events: rows.map(toJson) });
  } catch (err: any) {
    log.error({ err }, 'scene_events_list_failed');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

app.get('/months', async (c) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT month, count(*)::int AS count FROM scene_events WHERE is_published GROUP BY month ORDER BY month`);
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({ success: true, months: rows });
  } catch (err: any) {
    log.error({ err }, 'scene_events_months_failed');
    return c.json({ success: false, error: 'internal error' }, 500);
  }
});

// ── Админка: ежемесячная публикация ──────────────────────────

app.get('/admin', requireAuth, requireAdmin, async (c) => {
  await ensureSchema();
  const month = String(c.req.query('month') || '');
  const { rows } = MONTH_RE.test(month)
    ? await pool.query(`SELECT ${COLS} FROM scene_events WHERE month = $1 ORDER BY starts_on, sort, title`, [month])
    : await pool.query(`SELECT ${COLS} FROM scene_events ORDER BY month DESC, starts_on, sort LIMIT 500`);
  return c.json({ success: true, events: rows.map(toJson) });
});

app.post('/admin', requireAuth, requireAdmin, async (c) => {
  await ensureSchema();
  const n = normalize(await c.req.json().catch(() => null));
  if (!n.ok) return c.json({ success: false, error: n.error }, 400);
  const id = await insertRow(n.row);
  return c.json({ success: true, id });
});

/** Пакет событий месяца: { month?, replace?: boolean, events: [...] }. replace=true сначала удаляет месяц. */
app.post('/admin/import', requireAuth, requireAdmin, async (c) => {
  await ensureSchema();
  const body = await c.req.json().catch(() => null);
  const list = Array.isArray(body?.events) ? body.events : [];
  if (!list.length) return c.json({ success: false, error: 'events: []' }, 400);
  const rows: Record<string, any>[] = [];
  const errors: string[] = [];
  list.forEach((e: any, i: number) => {
    const n = normalize(body?.month ? { ...e, month: body.month } : e);
    if (n.ok) rows.push(n.row); else errors.push(`#${i + 1}: ${n.error}`);
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (body?.replace === true && MONTH_RE.test(String(body?.month || ''))) {
      await client.query('DELETE FROM scene_events WHERE month = $1', [body.month]);
    }
    for (const [i, r] of rows.entries()) {
      await client.query(
        `INSERT INTO scene_events (${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [`se-${crypto.randomUUID()}`, r.month, r.title, r.starts_on, r.ends_on, r.city, r.venue, r.kind, r.audience,
          r.summary, r.why, r.price, r.deadline, r.url, r.source_url, r.is_published, r.sort || i]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  log.info({ inserted: rows.length, errors: errors.length }, 'scene_events_imported');
  return c.json({ success: true, inserted: rows.length, errors });
});

app.put('/admin/:id', requireAuth, requireAdmin, async (c) => {
  await ensureSchema();
  const n = normalize(await c.req.json().catch(() => null));
  if (!n.ok) return c.json({ success: false, error: n.error }, 400);
  const r = n.row;
  const res = await pool.query(
    `UPDATE scene_events SET month=$2, title=$3, starts_on=$4, ends_on=$5, city=$6, venue=$7, kind=$8, audience=$9,
            summary=$10, why=$11, price=$12, deadline=$13, url=$14, source_url=$15, is_published=$16, sort=$17, updated_at=now()
      WHERE id=$1`,
    [c.req.param('id'), r.month, r.title, r.starts_on, r.ends_on, r.city, r.venue, r.kind, r.audience,
      r.summary, r.why, r.price, r.deadline, r.url, r.source_url, r.is_published, r.sort]);
  return c.json({ success: res.rowCount === 1 });
});

app.delete('/admin/:id', requireAuth, requireAdmin, async (c) => {
  await ensureSchema();
  const res = await pool.query('DELETE FROM scene_events WHERE id = $1', [c.req.param('id')]);
  return c.json({ success: res.rowCount === 1 });
});

export default app;
