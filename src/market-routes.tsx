// МАРКЕТПЛЕЙС: готовые биты, минусы и песни (25.09.2026)
//
// Решение владельца: «Продавай свои песни, минуса и биты через маркетплейс
// ПРОМО.МУЗЫКА». Продают все (артисты, продюсеры, DJ, лейблы, звукорежиссёры).
//   бит / минус — лицензия (можно продать многим) и/или эксклюзив (один раз);
//   песня       — только эксклюзив;
//   комиссия платформы 10 %; деньги — на счёт платформы (ЮKassa), продавцу
//   начисляется цена минус 10 %, вывод заявкой от 1 000 ₽ (payment_withdrawals,
//   source='market'), выплата вручную.
//
// Файлы: обложка и превью — публичные (saveUpload → /server/uploads/market/…),
// полный файл — в MARKET_PRIVATE_DIR (nginx его не отдаёт), скачивание только
// через GET /purchases/:id/download для покупателя.
//
// Старая витрина (beats, digital_goods) — тестовая и снята с продажи; этот
// модуль её не использует.

import { Hono } from 'hono';
import { requireAuth } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { saveUpload, IMAGE_EXTS, MAX_IMAGE_BYTES } from './cabinet-uploads.tsx';

const market = new Hono();

export const MARKET_COMMISSION = 0.10;
const MIN_PRICE = 100;
const MAX_PRICE = 1_000_000;
const MIN_WITHDRAWAL = 1000;
const MARKET_PRIVATE_DIR = process.env.MARKET_PRIVATE_DIR || '/opt/promofm-api/uploads/market-private';
const MAX_FILE_BYTES = 190 * 1024 * 1024;   // nginx client_max_body_size 200M
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const SELLER_ROLES = new Set(['artist', 'producer', 'dj', 'label', 'engineer', 'admin', 'superadmin']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = 'https://promo-music.ru';

export const KIND_LABEL: Record<string, string> = { beat: 'бит', minus: 'минус', song: 'песня' };
const LICENSE_LABEL: Record<string, string> = { lease: 'лицензия', exclusive: 'эксклюзив' };

const PRIVATE_FORMATS: Record<string, (b: Buffer) => boolean> = {
  wav: (b) => b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WAVE',
  mp3: (b) => b.length >= 3 && (b.subarray(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)),
  flac: (b) => b.length >= 4 && b.subarray(0, 4).toString('ascii') === 'fLaC',
  zip: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) ,
};

function isAdmin(c: any): boolean {
  const r = String(c.get('userRole') || '');
  return r === 'admin' || r === 'superadmin';
}

function money(n: number): number { return Math.round(n * 100) / 100; }

function validPrice(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_PRICE || n > MAX_PRICE) return NaN;
  return Math.round(n);
}

function publicItem(r: any) {
  return {
    id: String(r.id),
    kind: r.kind,
    title: r.title,
    genre: r.genre || null,
    bpm: r.bpm ?? null,
    musicKey: r.music_key || null,
    description: r.description || '',
    coverUrl: r.cover_url || null,
    previewUrl: r.preview_url || null,
    priceLease: r.price_lease !== null && r.price_lease !== undefined ? Number(r.price_lease) : null,
    priceExclusive: r.price_exclusive !== null && r.price_exclusive !== undefined ? Number(r.price_exclusive) : null,
    sellerName: r.seller_name || 'Автор',
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

function sellerItem(r: any) {
  return {
    ...publicItem(r),
    hasFile: !!r.file_path,
    fileName: r.file_name || null,
    fileSize: r.file_size ? Number(r.file_size) : null,
    rightsConfirmed: !!r.rights_confirmed_at,
    sales: Number(r.sales || 0),
  };
}

async function userInfo(userId: string): Promise<{ email: string | null; name: string; role: string | null }> {
  const { rows } = await pool.query(
    `SELECT email, role, COALESCE(NULLIF(display_name, ''), NULLIF(full_name, ''), NULLIF(username, ''), '') AS name
       FROM users WHERE id::text = $1 LIMIT 1`,
    [userId],
  );
  const u = rows[0];
  return { email: u?.email || null, name: u?.name || '', role: u?.role || null };
}

async function ownItem(itemId: string, userId: string): Promise<any | null> {
  if (!UUID_RE.test(itemId)) return null;
  const { rows } = await pool.query(`SELECT * FROM market_items WHERE id = $1 AND seller_id = $2 AND status <> 'removed'`, [itemId, userId]);
  return rows[0] || null;
}

// ═══════════════════════════════════════════════════════
// ПУБЛИЧНАЯ ВИТРИНА
// ═══════════════════════════════════════════════════════

market.get('/items', async (c) => {
  try {
    const kind = c.req.query('kind');
    const q = (c.req.query('q') || '').trim().slice(0, 80);
    const genre = (c.req.query('genre') || '').trim().slice(0, 40);
    const sort = c.req.query('sort') || 'new';
    const limit = Math.min(Math.max(Number(c.req.query('limit') || 48), 1), 100);
    const offset = Math.max(Number(c.req.query('offset') || 0), 0);
    const where: string[] = [`status = 'active'`];
    const params: any[] = [];
    if (kind && ['beat', 'minus', 'song'].includes(kind)) { params.push(kind); where.push(`kind = $${params.length}`); }
    if (genre) { params.push(genre); where.push(`genre ILIKE $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`(title ILIKE $${params.length} OR seller_name ILIKE $${params.length} OR genre ILIKE $${params.length})`); }
    const order = sort === 'price_asc' ? 'LEAST(COALESCE(price_lease, price_exclusive), COALESCE(price_exclusive, price_lease)) ASC'
      : sort === 'price_desc' ? 'GREATEST(COALESCE(price_lease, 0), COALESCE(price_exclusive, 0)) DESC'
      : 'created_at DESC';
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM market_items WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const stats = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS items,
              count(DISTINCT seller_id) FILTER (WHERE status = 'active')::int AS sellers,
              (SELECT count(*)::int FROM market_purchases WHERE status = 'paid') AS sold
         FROM market_items`,
    );
    return c.json({ success: true, data: rows.map(publicItem), stats: stats.rows[0] });
  } catch (e: any) {
    console.error('[market] GET /items', e?.message);
    return c.json({ success: false, error: 'Ошибка загрузки' }, 500);
  }
});

market.get('/items/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ success: false, error: 'Товар не найден' }, 404);
  const { rows } = await pool.query(`SELECT * FROM market_items WHERE id = $1 AND status IN ('active', 'sold')`, [id]);
  if (!rows[0]) return c.json({ success: false, error: 'Товар не найден' }, 404);
  return c.json({ success: true, data: publicItem(rows[0]) });
});

// ═══════════════════════════════════════════════════════
// КАБИНЕТ ПРОДАВЦА
// ═══════════════════════════════════════════════════════

async function requireSeller(c: any): Promise<string | Response> {
  const userId = String(c.get('userId') || '');
  if (!userId) return c.json({ success: false, error: 'Нужна авторизация' }, 401);
  const role = String(c.get('userRole') || '');
  if (!SELLER_ROLES.has(role)) {
    return c.json({ success: false, error: 'Продавать могут артисты, продюсеры, DJ, лейблы и звукорежиссёры' }, 403);
  }
  return userId;
}

market.get('/my/items', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const { rows } = await pool.query(
    `SELECT i.*, (SELECT count(*) FROM market_purchases p WHERE p.item_id = i.id AND p.status = 'paid') AS sales
       FROM market_items i WHERE i.seller_id = $1 AND i.status <> 'removed' ORDER BY i.created_at DESC`,
    [s],
  );
  return c.json({ success: true, data: rows.map(sellerItem) });
});

function readItemFields(body: any, kind: string) {
  const title = String(body?.title || '').trim().slice(0, 120);
  const genre = String(body?.genre || '').trim().slice(0, 40) || null;
  const bpm = body?.bpm ? Math.round(Number(body.bpm)) : null;
  const musicKey = String(body?.musicKey || '').trim().slice(0, 20) || null;
  const description = String(body?.description || '').trim().slice(0, 2000);
  const sellerName = String(body?.sellerName || '').trim().slice(0, 80);
  const priceLease = kind === 'song' ? null : validPrice(body?.priceLease);
  const priceExclusive = validPrice(body?.priceExclusive);
  return { title, genre, bpm, musicKey, description, sellerName, priceLease, priceExclusive };
}

function fieldsError(f: ReturnType<typeof readItemFields>): string | null {
  if (!f.title) return 'Укажите название';
  if (f.bpm !== null && (!Number.isFinite(f.bpm) || f.bpm < 30 || f.bpm > 300)) return 'BPM — от 30 до 300';
  if (Number.isNaN(f.priceLease as any) || Number.isNaN(f.priceExclusive as any)) return `Цена — от ${MIN_PRICE} до ${MAX_PRICE.toLocaleString('ru-RU')} ₽`;
  return null;
}

market.post('/my/items', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const body = await c.req.json().catch(() => ({}));
  const kind = String(body?.kind || '');
  if (!['beat', 'minus', 'song'].includes(kind)) return c.json({ success: false, error: 'Выберите тип: бит, минус или песня' }, 400);
  const f = readItemFields(body, kind);
  const err = fieldsError(f); if (err) return c.json({ success: false, error: err }, 400);
  const u = await userInfo(s);
  const { rows } = await pool.query(
    `INSERT INTO market_items (seller_id, seller_name, seller_role, kind, title, genre, bpm, music_key, description, price_lease, price_exclusive)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [s, f.sellerName || u.name || 'Автор', String(c.get('userRole') || ''), kind, f.title, f.genre, f.bpm, f.musicKey, f.description, f.priceLease, f.priceExclusive],
  );
  return c.json({ success: true, data: sellerItem(rows[0]) }, 201);
});

market.put('/my/items/:id', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const item = await ownItem(c.req.param('id'), s);
  if (!item) return c.json({ success: false, error: 'Товар не найден' }, 404);
  if (item.status === 'sold') return c.json({ success: false, error: 'Товар продан эксклюзивно — менять нельзя' }, 409);
  const body = await c.req.json().catch(() => ({}));
  const f = readItemFields(body, item.kind);
  const err = fieldsError(f); if (err) return c.json({ success: false, error: err }, 400);
  const { rows } = await pool.query(
    `UPDATE market_items SET title = $2, genre = $3, bpm = $4, music_key = $5, description = $6,
            seller_name = COALESCE(NULLIF($7, ''), seller_name), price_lease = $8, price_exclusive = $9, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [item.id, f.title, f.genre, f.bpm, f.musicKey, f.description, f.sellerName, f.priceLease, f.priceExclusive],
  );
  // Активный товар без единой цены продавать нельзя — снимаем в черновик.
  if (rows[0].status === 'active' && rows[0].price_lease === null && rows[0].price_exclusive === null) {
    await pool.query(`UPDATE market_items SET status = 'draft' WHERE id = $1`, [item.id]);
    rows[0].status = 'draft';
  }
  return c.json({ success: true, data: sellerItem(rows[0]) });
});

async function multipartFile(c: any): Promise<File | null> {
  const body = await c.req.parseBody().catch(() => null);
  const file = body?.file as File | undefined;
  return file && typeof (file as any).arrayBuffer === 'function' ? file : null;
}

market.post('/my/items/:id/cover', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const item = await ownItem(c.req.param('id'), s);
  if (!item) return c.json({ success: false, error: 'Товар не найден' }, 404);
  const file = await multipartFile(c);
  if (!file) return c.json({ success: false, error: 'Файл обязателен' }, 400);
  try {
    const saved = await saveUpload(file, 'market/covers', item.id.slice(0, 8), IMAGE_EXTS, MAX_IMAGE_BYTES);
    await pool.query(`UPDATE market_items SET cover_url = $2, updated_at = now() WHERE id = $1`, [item.id, saved.url]);
    return c.json({ success: true, data: { coverUrl: saved.url } });
  } catch (e: any) {
    return c.json({ success: false, error: e?.message || 'Не удалось сохранить обложку' }, 400);
  }
});

market.post('/my/items/:id/preview', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const item = await ownItem(c.req.param('id'), s);
  if (!item) return c.json({ success: false, error: 'Товар не найден' }, 404);
  const file = await multipartFile(c);
  if (!file) return c.json({ success: false, error: 'Файл обязателен' }, 400);
  try {
    const saved = await saveUpload(file, 'market/previews', item.id.slice(0, 8), new Set(['mp3']), MAX_PREVIEW_BYTES);
    await pool.query(`UPDATE market_items SET preview_url = $2, updated_at = now() WHERE id = $1`, [item.id, saved.url]);
    return c.json({ success: true, data: { previewUrl: saved.url } });
  } catch (e: any) {
    return c.json({ success: false, error: e?.message || 'Не удалось сохранить превью' }, 400);
  }
});

market.post('/my/items/:id/file', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const item = await ownItem(c.req.param('id'), s);
  if (!item) return c.json({ success: false, error: 'Товар не найден' }, 404);
  if (item.status === 'sold') return c.json({ success: false, error: 'Товар продан эксклюзивно' }, 409);
  const file = await multipartFile(c);
  if (!file) return c.json({ success: false, error: 'Файл обязателен' }, 400);
  const rawName = String((file as any).name || 'file').slice(0, 200);
  const ext = (rawName.split('.').pop() || '').toLowerCase();
  const check = PRIVATE_FORMATS[ext];
  if (!check) return c.json({ success: false, error: `Формат .${ext} не поддерживается. Можно: WAV, MP3, FLAC или ZIP (дорожки)` }, 400);
  if (file.size > MAX_FILE_BYTES) return c.json({ success: false, error: `Файл больше ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ` }, 413);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength === 0 || !check(buf)) return c.json({ success: false, error: `Файл не похож на .${ext}` }, 400);
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(MARKET_PRIVATE_DIR, { recursive: true });
  const stored = `${item.id}-${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(MARKET_PRIVATE_DIR, stored), buf);
  if (item.file_path) {
    // Старый файл удаляем, только если по нему ещё никто не покупал.
    const sold = await pool.query(`SELECT 1 FROM market_purchases WHERE item_id = $1 AND status = 'paid' LIMIT 1`, [item.id]);
    if (!sold.rows.length) await fs.unlink(path.join(MARKET_PRIVATE_DIR, path.basename(item.file_path))).catch(() => {});
  }
  await pool.query(
    `UPDATE market_items SET file_path = $2, file_name = $3, file_size = $4, updated_at = now() WHERE id = $1`,
    [item.id, stored, rawName, buf.byteLength],
  );
  return c.json({ success: true, data: { fileName: rawName, fileSize: buf.byteLength } });
});

market.post('/my/items/:id/publish', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const item = await ownItem(c.req.param('id'), s);
  if (!item) return c.json({ success: false, error: 'Товар не найден' }, 404);
  if (item.status === 'sold') return c.json({ success: false, error: 'Товар уже продан эксклюзивно' }, 409);
  const body = await c.req.json().catch(() => ({}));
  if (body?.rightsConfirmed !== true) {
    return c.json({ success: false, error: 'Подтвердите, что вы автор или правообладатель и можете продавать этот материал' }, 400);
  }
  const missing: string[] = [];
  if (!item.preview_url) missing.push('превью (mp3)');
  if (!item.file_path) missing.push('полный файл');
  if (item.price_lease === null && item.price_exclusive === null) missing.push('цена');
  if (missing.length) return c.json({ success: false, error: `Не хватает: ${missing.join(', ')}` }, 400);
  const { rows } = await pool.query(
    `UPDATE market_items SET status = 'active', rights_confirmed_at = COALESCE(rights_confirmed_at, now()), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [item.id],
  );
  return c.json({ success: true, data: sellerItem(rows[0]) });
});

market.post('/my/items/:id/unpublish', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const item = await ownItem(c.req.param('id'), s);
  if (!item) return c.json({ success: false, error: 'Товар не найден' }, 404);
  if (item.status !== 'active') return c.json({ success: false, error: 'Товар не в продаже' }, 409);
  const { rows } = await pool.query(`UPDATE market_items SET status = 'hidden', updated_at = now() WHERE id = $1 RETURNING *`, [item.id]);
  return c.json({ success: true, data: sellerItem(rows[0]) });
});

market.delete('/my/items/:id', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const item = await ownItem(c.req.param('id'), s);
  if (!item) return c.json({ success: false, error: 'Товар не найден' }, 404);
  // Покупки остаются: покупатель должен и дальше скачивать купленное.
  await pool.query(`UPDATE market_items SET status = 'removed', updated_at = now() WHERE id = $1`, [item.id]);
  return c.json({ success: true });
});

async function sellerBalance(userId: string) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE((SELECT sum(payout) FROM market_purchases WHERE seller_id = $1 AND status = 'paid'), 0)::numeric AS earned,
       COALESCE((SELECT sum(amount) FROM payment_withdrawals WHERE user_id = $1 AND source = 'market'
                  AND COALESCE(status, 'pending') NOT IN ('rejected', 'cancelled')), 0)::numeric AS withdrawn`,
    [userId],
  );
  const earned = Number(rows[0]?.earned || 0);
  const withdrawn = Number(rows[0]?.withdrawn || 0);
  return { earned: money(earned), withdrawn: money(withdrawn), available: money(Math.max(0, earned - withdrawn)) };
}

market.get('/my/sales', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const [sales, wds, balance] = await Promise.all([
    pool.query(
      `SELECT id, item_title, item_kind, license, amount, commission, payout, paid_at FROM market_purchases
        WHERE seller_id = $1 AND status = 'paid' ORDER BY paid_at DESC LIMIT 200`, [s]),
    pool.query(
      `SELECT id, amount, status, created_at, payment_method FROM payment_withdrawals
        WHERE user_id = $1 AND source = 'market' ORDER BY created_at DESC LIMIT 50`, [s]),
    sellerBalance(s),
  ]);
  return c.json({
    success: true,
    data: {
      balance,
      minWithdrawal: MIN_WITHDRAWAL,
      commissionRate: MARKET_COMMISSION,
      sales: sales.rows.map((r: any) => ({
        id: String(r.id), title: r.item_title, kind: r.item_kind, license: r.license,
        amount: Number(r.amount), commission: Number(r.commission), payout: Number(r.payout),
        paidAt: r.paid_at instanceof Date ? r.paid_at.toISOString() : r.paid_at,
      })),
      withdrawals: wds.rows.map((r: any) => ({
        id: String(r.id), amount: Number(r.amount), status: r.status || 'pending',
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        method: r.payment_method || null,
      })),
    },
  });
});

market.post('/my/withdrawals', requireAuth, async (c) => {
  const s = await requireSeller(c); if (typeof s !== 'string') return s;
  const body = await c.req.json().catch(() => ({}));
  const amount = Math.round(Number(body?.amount) * 100) / 100;
  const details = String(body?.details || '').trim().slice(0, 500);
  const method = ['card', 'sbp', 'bank'].includes(body?.method) ? body.method : 'card';
  if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL) return c.json({ success: false, error: `Минимальная сумма вывода — ${MIN_WITHDRAWAL.toLocaleString('ru-RU')} ₽` }, 400);
  if (!details) return c.json({ success: false, error: 'Укажите реквизиты для выплаты' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Сериализуем заявки одного продавца, чтобы две параллельные не вывели больше баланса.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`market-wd:${s}`]);
    const bal = await client.query(
      `SELECT
         COALESCE((SELECT sum(payout) FROM market_purchases WHERE seller_id = $1 AND status = 'paid'), 0)
         - COALESCE((SELECT sum(amount) FROM payment_withdrawals WHERE user_id = $1 AND source = 'market'
                      AND COALESCE(status, 'pending') NOT IN ('rejected', 'cancelled')), 0) AS available`,
      [s],
    );
    const available = Number(bal.rows[0]?.available || 0);
    if (amount > available + 0.001) {
      await client.query('ROLLBACK');
      return c.json({ success: false, error: `Недостаточно средств. Доступно: ${money(available).toLocaleString('ru-RU')} ₽` }, 400);
    }
    const { rows } = await client.query(
      `INSERT INTO payment_withdrawals (user_id, app_id, source, amount, currency, commission, commission_rate, payout,
                                        payment_method, payment_details, status, requested_at)
       VALUES ($1, $2, 'market', $3, 'RUB', 0, 0, $3, $4, $5::jsonb, 'pending', now()) RETURNING id`,
      [s, `market-wd-${crypto.randomUUID()}`, amount, method, JSON.stringify({ details })],
    );
    await client.query('COMMIT');
    const u = await userInfo(s);
    import('./email-helper.tsx').then(async (m) => {
      const html = m.emailWrapper(`
        <h2 style="margin:0 0 16px;color:#10B981;">Заявка на вывод — маркетплейс</h2>
        <p style="color:#e0e0e0;">${m.escapeHtml(u.name || u.email || s)} (${m.escapeHtml(u.email || '—')}) просит вывести <b>${amount.toLocaleString('ru-RU')} ₽</b>.</p>
        <p style="color:#e0e0e0;">Способ: ${m.escapeHtml(method)}. Реквизиты: ${m.escapeHtml(details)}</p>
        <p style="color:#888;font-size:13px;">Комиссия 10 % уже удержана при продаже. Заявка ${m.escapeHtml(String(rows[0].id))}.</p>`);
      await m.sendEmail({ to: 'info@promofm.ru', subject: `[ПРОМО] Вывод с маркетплейса: ${amount.toLocaleString('ru-RU')} ₽ — ${u.name || u.email || s}`, html });
      await m.notifyAdminTelegram(`💸 <b>Вывод с маркетплейса</b>\n${u.name || u.email || s}: <b>${amount} ₽</b>\nРеквизиты: ${details}`).catch(() => {});
    }).catch(() => {});
    return c.json({ success: true, data: { id: String(rows[0].id), amount, status: 'pending' } }, 201);
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[market] withdrawal', e?.message);
    return c.json({ success: false, error: 'Не удалось создать заявку' }, 500);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════
// ПОКУПКА
// ═══════════════════════════════════════════════════════

market.post('/items/:id/purchase', requireAuth, async (c) => {
  const buyerId = String(c.get('userId') || '');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ success: false, error: 'Товар не найден' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const license = body?.license === 'exclusive' ? 'exclusive' : body?.license === 'lease' ? 'lease' : null;
  if (!license) return c.json({ success: false, error: 'Выберите лицензию' }, 400);
  const { rows } = await pool.query(`SELECT * FROM market_items WHERE id = $1 AND status = 'active'`, [id]);
  const item = rows[0];
  if (!item) return c.json({ success: false, error: 'Товар больше не продаётся' }, 404);
  if (item.seller_id === buyerId) return c.json({ success: false, error: 'Нельзя купить собственный товар' }, 400);
  const price = Number(license === 'lease' ? item.price_lease : item.price_exclusive);
  if (!price) return c.json({ success: false, error: 'Этот вариант покупки недоступен' }, 400);
  if (license === 'exclusive') {
    const busy = await pool.query(
      `SELECT 1 FROM market_purchases WHERE item_id = $1 AND license = 'exclusive'
          AND (status = 'paid' OR (status = 'pending' AND created_at > now() - interval '30 minutes')) LIMIT 1`,
      [id],
    );
    if (busy.rows.length) return c.json({ success: false, error: 'Эксклюзив сейчас оформляет другой покупатель' }, 409);
  }
  const commission = money(price * MARKET_COMMISSION);
  const payout = money(price - commission);
  const ins = await pool.query(
    `INSERT INTO market_purchases (item_id, buyer_id, seller_id, license, amount, commission, payout, item_title, item_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [id, buyerId, item.seller_id, license, price, commission, payout, item.title, item.kind],
  );
  const purchaseId = String(ins.rows[0].id);
  try {
    const { getGateway } = await import('./payment-gateway.tsx');
    const { upsertPaymentSession } = await import('./db.tsx');
    const orderId = crypto.randomUUID();
    const returnUrl = `${DOMAIN}/marketplace?tab=purchases&purchase=${purchaseId}`;
    const description = `Покупка: ${KIND_LABEL[item.kind]} «${item.title}» (${LICENSE_LABEL[license]})`.slice(0, 128);
    const metadata = { type: 'market_purchase', purchaseId, itemId: id, license };
    const result = await getGateway('yookassa').createPayment({
      orderId, amount: price, currency: 'RUB', description, returnUrl, gateway: 'yookassa',
      userId: buyerId, type: 'purchase', metadata,
    } as any);
    await upsertPaymentSession(orderId, {
      orderId, userId: buyerId, gateway: 'yookassa', gatewayPaymentId: result.sessionId,
      amount: price, currency: 'RUB', status: 'pending', type: 'purchase', description, metadata,
      confirmationUrl: result.confirmationUrl, returnUrl, createdAt: new Date().toISOString(),
    } as any);
    await pool.query(`UPDATE market_purchases SET order_id = $2 WHERE id = $1`, [purchaseId, orderId]);
    return c.json({ success: true, data: { purchaseId, confirmationUrl: result.confirmationUrl } });
  } catch (e: any) {
    await pool.query(`UPDATE market_purchases SET status = 'canceled' WHERE id = $1`, [purchaseId]).catch(() => {});
    console.error('[market] purchase gateway', e?.message);
    return c.json({ success: false, error: 'Платёжная система недоступна, попробуйте позже' }, 502);
  }
});

market.get('/my/purchases', requireAuth, async (c) => {
  const buyerId = String(c.get('userId') || '');
  const { rows } = await pool.query(
    `SELECT p.id, p.license, p.amount, p.paid_at, p.item_title, p.item_kind, i.cover_url, i.seller_name, i.file_name
       FROM market_purchases p JOIN market_items i ON i.id = p.item_id
      WHERE p.buyer_id = $1 AND p.status = 'paid' ORDER BY p.paid_at DESC LIMIT 200`,
    [buyerId],
  );
  return c.json({
    success: true,
    data: rows.map((r: any) => ({
      id: String(r.id), title: r.item_title, kind: r.item_kind, license: r.license, amount: Number(r.amount),
      sellerName: r.seller_name, coverUrl: r.cover_url || null, fileName: r.file_name || null,
      paidAt: r.paid_at instanceof Date ? r.paid_at.toISOString() : r.paid_at,
      downloadUrl: `/server/api/market/purchases/${r.id}/download`,
      licenseText: licenseText(r.item_kind, r.license, r.item_title, r.seller_name),
    })),
  });
});

market.get('/purchases/:id/download', requireAuth, async (c) => {
  const userId = String(c.get('userId') || '');
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ success: false, error: 'Покупка не найдена' }, 404);
  const { rows } = await pool.query(
    `SELECT p.buyer_id, p.seller_id, p.status, i.file_path, i.file_name, i.title
       FROM market_purchases p JOIN market_items i ON i.id = p.item_id WHERE p.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r || r.status !== 'paid') return c.json({ success: false, error: 'Покупка не найдена' }, 404);
  if (r.buyer_id !== userId && r.seller_id !== userId && !isAdmin(c)) return c.json({ success: false, error: 'Нет доступа' }, 403);
  if (!r.file_path) return c.json({ success: false, error: 'Файл недоступен. Напишите в поддержку.' }, 404);
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { Readable } = await import('node:stream');
  const full = path.join(MARKET_PRIVATE_DIR, path.basename(r.file_path));
  if (!full.startsWith(path.resolve(MARKET_PRIVATE_DIR) + path.sep) || !fs.existsSync(full)) {
    console.error('[market] file missing', full);
    return c.json({ success: false, error: 'Файл недоступен. Напишите в поддержку.' }, 500);
  }
  const ext = path.extname(r.file_path).slice(1).toLowerCase();
  const nice = `${String(r.title || 'file').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'file'}.${ext}`;
  const ascii = nice.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const mime: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', zip: 'application/zip' };
  c.header('Content-Type', mime[ext] || 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nice)}`);
  c.header('Content-Length', String(fs.statSync(full).size));
  c.header('Cache-Control', 'private, no-store');
  return c.body(Readable.toWeb(fs.createReadStream(full)) as any);
});

// ═══════════════════════════════════════════════════════
// УСЛОВИЯ ПОКУПКИ
// ═══════════════════════════════════════════════════════

export function licenseText(kind: string, license: string, title: string, seller: string): string {
  const what = kind === 'song' ? 'песню (музыку и текст)' : kind === 'minus' ? 'минус (инструментал)' : 'бит (инструментал)';
  if (license === 'lease') {
    return `Лицензия (неисключительная): покупатель вправе использовать ${what} «${title}» автора ${seller} в своих треках и выступлениях, в том числе с коммерческим распространением, с указанием автора. Авторство и права остаются у продавца, который может продавать лицензии другим покупателям.`;
  }
  return `Эксклюзив: покупатель получает право единолично использовать ${what} «${title}» автора ${seller}; продавец снимает материал с продажи и больше его не продаёт. Лицензии, проданные до эксклюзива, сохраняют силу. Продавец подтвердил, что является автором или правообладателем.`;
}

// ═══════════════════════════════════════════════════════
// ВЕБХУК ОПЛАТЫ (вызывается из checkout-routes.processPaymentSuccess)
// ═══════════════════════════════════════════════════════

export async function fulfillMarketPurchase(purchaseId: string, orderId: string, amountPaid: number): Promise<void> {
  if (!UUID_RE.test(purchaseId)) return;
  const upd = await pool.query(
    `UPDATE market_purchases SET status = 'paid', paid_at = now(), order_id = COALESCE(order_id, $2)
      WHERE id = $1 AND status IN ('pending', 'canceled') RETURNING *`,
    [purchaseId, orderId],
  );
  const p = upd.rows[0];
  if (!p) return; // уже обработано (повтор вебхука)
  if (Math.abs(Number(p.amount) - Number(amountPaid)) > 0.01) {
    console.warn('[market] amount mismatch', { purchaseId, expected: p.amount, paid: amountPaid });
  }
  if (p.license === 'exclusive') {
    await pool.query(`UPDATE market_items SET status = 'sold', updated_at = now() WHERE id = $1 AND status IN ('active', 'hidden')`, [p.item_id]);
    // Страховка от двойного эксклюзива (например, оплата пришла после отмены сессии).
    const dup = await pool.query(
      `SELECT count(*)::int AS n FROM market_purchases WHERE item_id = $1 AND license = 'exclusive' AND status = 'paid'`, [p.item_id]);
    if (Number(dup.rows[0]?.n) > 1) {
      import('./email-helper.tsx').then((m) => m.notifyAdminTelegram(
        `⚠️ <b>Маркетплейс: второй оплаченный эксклюзив</b>\nТовар ${p.item_id}, покупка ${p.id} — нужен возврат ${p.amount} ₽`)).catch(() => {});
    }
  }
  const [{ rows: items }, buyer, seller] = await Promise.all([
    pool.query(`SELECT title, kind, seller_name FROM market_items WHERE id = $1`, [p.item_id]),
    userInfo(p.buyer_id),
    userInfo(p.seller_id),
  ]);
  const it = items[0] || { title: p.item_title, kind: p.item_kind, seller_name: '' };
  try {
    const { recordRevenue } = await import('./platform-revenue.tsx');
    await recordRevenue({
      channel: 'marketplace_item', description: `${KIND_LABEL[it.kind] || 'товар'} «${it.title}» (${LICENSE_LABEL[p.license]})`,
      grossAmount: Number(p.amount), platformRevenue: Number(p.commission), payoutAmount: Number(p.payout),
      commissionRate: MARKET_COMMISSION, payerId: p.buyer_id, payerName: buyer.name || buyer.email || 'Покупатель',
      payeeId: p.seller_id, payeeName: seller.name || it.seller_name || 'Продавец',
    } as any);
  } catch (e: any) {
    console.warn('[market] recordRevenue', e?.message);
  }
  try {
    const m = await import('./email-helper.tsx');
    const kindLabel = KIND_LABEL[it.kind] || 'товар';
    if (buyer.email) {
      await m.sendEmail({
        to: buyer.email,
        subject: `[ПРОМО] Покупка: ${kindLabel} «${it.title}»`,
        html: m.emailWrapper(`
          <h2 style="margin:0 0 16px;color:#7C3AED;">Спасибо за покупку!</h2>
          <p style="color:#e0e0e0;">${m.escapeHtml(kindLabel)} «${m.escapeHtml(it.title)}» — ${m.escapeHtml(it.seller_name || '')}. ${m.escapeHtml(LICENSE_LABEL[p.license])}, ${Number(p.amount).toLocaleString('ru-RU')} ₽.</p>
          <p style="color:#e0e0e0;">${m.escapeHtml(licenseText(it.kind, p.license, it.title, it.seller_name || ''))}</p>
          <p><a href="${DOMAIN}/marketplace?tab=purchases" style="display:inline-block;padding:12px 24px;background:#7C3AED;color:#fff;border-radius:8px;text-decoration:none;">Скачать файл</a></p>`),
      });
    }
    if (seller.email) {
      await m.sendEmail({
        to: seller.email,
        subject: `[ПРОМО] Продажа: ${kindLabel} «${it.title}» — ${Number(p.amount).toLocaleString('ru-RU')} ₽`,
        html: m.emailWrapper(`
          <h2 style="margin:0 0 16px;color:#10B981;">Ваш ${m.escapeHtml(kindLabel)} купили</h2>
          <p style="color:#e0e0e0;">«${m.escapeHtml(it.title)}», ${m.escapeHtml(LICENSE_LABEL[p.license])} — ${Number(p.amount).toLocaleString('ru-RU')} ₽.</p>
          <p style="color:#e0e0e0;">Вам начислено <b>${Number(p.payout).toLocaleString('ru-RU')} ₽</b> (за вычетом 10 % комиссии платформы). Вывести — в кабинете, раздел «Мои продажи», от ${MIN_WITHDRAWAL.toLocaleString('ru-RU')} ₽.</p>
          ${p.license === 'exclusive' ? '<p style="color:#e0e0e0;">Эксклюзив продаётся один раз — товар снят с продажи.</p>' : ''}`),
      });
    }
    m.notifyAdminTelegram(`🛒 <b>Продажа на маркетплейсе</b>\n${kindLabel} «${it.title}» (${LICENSE_LABEL[p.license]}) — ${p.amount} ₽\nПродавцу: ${p.payout} ₽, комиссия: ${p.commission} ₽`).catch(() => {});
  } catch (e: any) {
    console.warn('[market] emails', e?.message);
  }
}

export async function cancelMarketPurchase(purchaseId: string): Promise<void> {
  if (!UUID_RE.test(purchaseId)) return;
  await pool.query(`UPDATE market_purchases SET status = 'canceled' WHERE id = $1 AND status = 'pending'`, [purchaseId]);
}

export default market;
