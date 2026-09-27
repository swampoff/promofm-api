// РОЯЛТИ АРТИСТАМ ЗА ЗАВЕДЕНИЯ ПРОМО.ЭИР (27.09.2026)
//
// Решение владельца:
//   • при размещении трека (или позже в кабинете, раздел «Заведения») артист
//     отмечает, что хочет звучать в заведениях, и принимает дополнительное
//     соглашение /venue-royalty-agreement (tracks.venue_opt_in + дата/версия);
//   • такие треки (оплаченные и одобренные, как в эфире ПРОМО.ЭИР) ложатся
//     ссылками в папки музыки потоков заведений — syncVenueArtistTracks();
//     снял отметку → ссылка убирается при следующей синхронизации;
//   • PROMO.CHECK: раз в 30 с опрашиваем AutoDJ каждого потока заведения,
//     проигрывание трека артиста пишется в venue_track_plays — только если
//     устройство заведения в этот момент на связи (иначе исполнения не было);
//     за каждое проигрывание 20 ₽;
//   • баланс = начислено − заявки на вывод (payment_withdrawals, source
//     'venue_royalty'); вывод от 500 ₽, выплата вручную (письмо + Telegram).

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { venueDjPort, venueNameFor, VENUE_MOUNT_RE } from './venue-station-routes.tsx';

export const VENUE_ROYALTY_PER_PLAY = 20;
export const VENUE_ROYALTY_MIN_WITHDRAWAL = 500;
export const VENUE_AGREEMENT_VERSION = '2026-09-27';
const AGREEMENT_URL = '/venue-royalty-agreement';
const AIR_TRACKS_DIR = '/mnt/data/promofm-music/tracks';
const VENUES_ENV_DIR = '/etc/promo-air/venues';
const BUILD_METADATA = '/opt/promo-air-venue/build-metadata.py';
const DEVICE_ONLINE_SEC = 180;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = new Hono();

// Имя файла в эфире — как у синхронизации ПРОМО.ЭИР (air-routes /library/sync).
const AIR_FILENAME_SQL = `replace(COALESCE(t.artist_name, 'Unknown') || ' - ' || COALESCE(t.title, 'Untitled') || '.mp3', '/', '_')`;

// Трек участвует в эфире заведений: согласие артиста + те же условия, что у эфира ПРОМО.ЭИР.
const ELIGIBLE_SQL = `
  SELECT t.id, ${AIR_FILENAME_SQL} AS filename
    FROM tracks t
   WHERE t.venue_opt_in = true AND t.venue_agreement_at IS NOT NULL
     AND t.moderation_status IN ('upcoming', 'published')
     AND (t.payment_completed = true OR t.is_paid = true)
     AND NOT (COALESCE(t.payment_amount, 0) > 0 AND t.payment_amount < 1000)
     AND COALESCE(t.is_legacy, false) = false
     AND t.is_hidden = false
     AND (t.is_ai_generated IS NULL OR t.is_ai_generated = false)`;

const money = (n: number) => Math.round(n * 100) / 100;
const iso = (d: any) => (d instanceof Date ? d.toISOString() : d ?? null);

// ─── Треки артистов в папках потоков заведений ────────────────────────────

interface VenueEnv { slug: string; musicDir: string; port: number | null; env: Record<string, string> }

async function readVenueEnvs(): Promise<VenueEnv[]> {
  const fs = await import('fs/promises');
  let files: string[] = [];
  try { files = (await fs.readdir(VENUES_ENV_DIR)).filter((f) => f.endsWith('.env')); } catch { return []; }
  const out: VenueEnv[] = [];
  for (const f of files) {
    const txt = await fs.readFile(`${VENUES_ENV_DIR}/${f}`, 'utf8').catch(() => '');
    const env: Record<string, string> = {};
    for (const line of txt.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
    if (!env.VENUE_MUSIC_DIR) continue;
    out.push({ slug: f.replace(/\.env$/, ''), musicDir: env.VENUE_MUSIC_DIR, port: env.VENUE_API_PORT ? Number(env.VENUE_API_PORT) : null, env });
  }
  return out;
}

async function rebuildVenue(v: VenueEnv): Promise<void> {
  const { execFile } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('python3', [BUILD_METADATA], { env: { ...process.env, ...v.env }, timeout: 120_000 }, (err) => (err ? reject(err) : resolve()));
  });
  if (v.port) {
    await fetch(`http://127.0.0.1:${v.port}/api/metadata/scan`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

let syncRunning = false;
export async function syncVenueArtistTracks(): Promise<{ venues: number; eligible: number; linked: number; removed: number; warnings: string[] }> {
  if (syncRunning) return { venues: 0, eligible: 0, linked: 0, removed: 0, warnings: ['синхронизация уже идёт'] };
  syncRunning = true;
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const { rows } = await pool.query(ELIGIBLE_SQL);
    const eligible = new Set<string>();
    for (const r of rows) {
      // Файла в эфире ещё нет — появится после синхронизации ПРОМО.ЭИР (крон раз в 6 ч).
      try { await fs.access(path.join(AIR_TRACKS_DIR, r.filename)); eligible.add(r.filename); } catch { /* ждём */ }
    }
    const venues = await readVenueEnvs();
    let linked = 0; let removed = 0;
    const warnings: string[] = [];
    for (const v of venues) {
      if (path.resolve(v.musicDir) === path.resolve(AIR_TRACKS_DIR)) {
        warnings.push(`${v.slug}: папка музыки — общий эфир, в заведении звучат и треки без согласия артиста`);
        continue;
      }
      let entries: import('fs').Dirent[] = [];
      try { entries = await fs.readdir(v.musicDir, { withFileTypes: true }); } catch { warnings.push(`${v.slug}: нет папки ${v.musicDir}`); continue; }
      let changed = false;
      const present = new Set(entries.map((e) => e.name));
      for (const e of entries) {
        if (!e.isSymbolicLink()) continue;
        const full = path.join(v.musicDir, e.name);
        const target = await fs.readlink(full).catch(() => '');
        if (!target.startsWith(AIR_TRACKS_DIR + '/') || eligible.has(e.name)) continue;
        await fs.unlink(full).then(() => { removed++; changed = true; }).catch(() => {});
      }
      for (const fn of eligible) {
        if (present.has(fn)) continue;
        await fs.symlink(path.join(AIR_TRACKS_DIR, fn), path.join(v.musicDir, fn))
          .then(() => { linked++; changed = true; })
          .catch((e: any) => warnings.push(`${v.slug}: ${fn}: ${e?.code || e?.message}`));
      }
      if (changed) await rebuildVenue(v).catch((e: any) => warnings.push(`${v.slug}: пересборка — ${e?.message}`));
    }
    return { venues: venues.length, eligible: eligible.size, linked, removed, warnings };
  } finally {
    syncRunning = false;
  }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncVenueArtistTracks().catch((e) => console.warn('[venue-royalty] sync', e?.message)); }, 5_000);
}

// ─── PROMO.CHECK: учёт проигрываний в заведениях ──────────────────────────

let pollRunning = false;
async function pollVenuePlays(): Promise<void> {
  if (pollRunning) return;
  pollRunning = true;
  try {
    // Только потоки, чьё устройство сейчас на связи: без устройства эфир в зале не звучит.
    const { rows: streams } = await pool.query(
      `SELECT id, user_id, point_name, stream_url
         FROM venue_station_streams
        WHERE status IN ('live', 'provisioned')
          AND device_token_hash IS NOT NULL
          AND last_seen_at > now() - make_interval(secs => $1)
          AND stream_url ~ '/air/live/venue-'`,
      [DEVICE_ONLINE_SEC],
    );
    for (const s of streams) {
      const m = String(s.stream_url || '').match(VENUE_MOUNT_RE);
      if (!m) continue;
      const port = await venueDjPort(m[1]);
      if (!port) continue;
      let info: any = null;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) });
        info = ((await res.json()) as any)?.current_track_info;
      } catch { continue; }
      const filename = info?.filename ? String(info.filename) : '';
      const playedKey = info?.played_at ? String(info.played_at) : '';
      if (!filename || !playedKey) continue;
      const { rows } = await pool.query(
        `SELECT t.id, t.user_id FROM tracks t
          WHERE t.venue_opt_in = true AND t.venue_agreement_at IS NOT NULL AND t.user_id IS NOT NULL
            AND ${AIR_FILENAME_SQL} = $1
          LIMIT 1`,
        [filename],
      );
      const tr = rows[0];
      if (!tr) continue; // собственный каталог или трек без согласия — не учитываем
      const venueName = await venueNameFor(String(s.user_id)).catch(() => 'Заведение');
      await pool.query(
        `INSERT INTO venue_track_plays (stream_id, venue_user_id, venue_name, point_name, track_id, artist_user_id, filename, played_key, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (stream_id, played_key) DO NOTHING`,
        [s.id, String(s.user_id), venueName, s.point_name || null, tr.id, String(tr.user_id), filename, playedKey, VENUE_ROYALTY_PER_PLAY],
      );
    }
  } catch (e: any) {
    console.warn('[venue-royalty] poll', e?.message);
  } finally {
    pollRunning = false;
  }
}

if (process.env.VENUE_ROYALTY_POLL !== '0') {
  setTimeout(() => {
    setInterval(() => { pollVenuePlays(); }, 30_000);
    setInterval(() => { syncVenueArtistTracks().catch((e) => console.warn('[venue-royalty] sync', e?.message)); }, 30 * 60_000);
    syncVenueArtistTracks().catch((e) => console.warn('[venue-royalty] sync', e?.message));
  }, 20_000);
}

// Согласие при размещении трека (submitTrack): отметка + дата и версия соглашения.
export async function applyVenueOptInOnUpload(trackId: string): Promise<void> {
  await pool.query(
    `UPDATE tracks SET venue_opt_in = true, venue_agreement_at = now(), venue_agreement_version = $2, updated_at = now() WHERE id = $1`,
    [trackId, VENUE_AGREEMENT_VERSION],
  );
}

// ─── Кабинет артиста ──────────────────────────────────────────────────────

async function balanceFor(userId: string, client: { query: typeof pool.query } = pool) {
  const { rows } = await client.query(
    `SELECT
       COALESCE((SELECT sum(amount) FROM venue_track_plays WHERE artist_user_id = $1), 0)::numeric AS earned,
       COALESCE((SELECT sum(amount) FROM payment_withdrawals WHERE user_id = $1 AND source = 'venue_royalty'
                  AND COALESCE(status, 'pending') NOT IN ('rejected', 'cancelled')), 0)::numeric AS withdrawn`,
    [userId],
  );
  const earned = Number(rows[0]?.earned || 0);
  const withdrawn = Number(rows[0]?.withdrawn || 0);
  return { earned: money(earned), withdrawn: money(withdrawn), available: money(Math.max(0, earned - withdrawn)) };
}

app.get('/my', requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId'));
    const [tracks, venues, recent, totals, wds, balance] = await Promise.all([
      pool.query(
        `SELECT t.id, t.title, t.artist_name, t.moderation_status, t.venue_opt_in, t.venue_agreement_at,
                (t.payment_completed = true OR t.is_paid = true) AS paid,
                COALESCE(p.plays, 0)::int AS plays, COALESCE(p.earned, 0)::numeric AS earned, p.last_at
           FROM tracks t
           LEFT JOIN (SELECT track_id, count(*) AS plays, sum(amount) AS earned, max(played_at) AS last_at
                        FROM venue_track_plays WHERE artist_user_id = $1 GROUP BY track_id) p ON p.track_id = t.id
          WHERE t.user_id::text = $1 AND COALESCE(t.is_legacy, false) = false
            AND COALESCE(t.moderation_status, '') NOT IN ('rejected', 'deleted')
          ORDER BY t.created_at DESC
          LIMIT 200`,
        [userId],
      ),
      pool.query(
        `SELECT venue_name, point_name, count(*)::int AS plays, sum(amount)::numeric AS earned, max(played_at) AS last_at
           FROM venue_track_plays WHERE artist_user_id = $1
          GROUP BY venue_name, point_name ORDER BY plays DESC LIMIT 50`,
        [userId],
      ),
      pool.query(
        `SELECT p.played_at, p.venue_name, p.point_name, p.amount, t.title
           FROM venue_track_plays p LEFT JOIN tracks t ON t.id = p.track_id
          WHERE p.artist_user_id = $1 ORDER BY p.played_at DESC LIMIT 50`,
        [userId],
      ),
      pool.query(
        `SELECT count(*)::int AS plays, count(DISTINCT venue_user_id)::int AS venues FROM venue_track_plays WHERE artist_user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT id, amount, status, created_at, payment_method FROM payment_withdrawals
          WHERE user_id = $1 AND source = 'venue_royalty' ORDER BY created_at DESC LIMIT 50`,
        [userId],
      ),
      balanceFor(userId),
    ]);
    return c.json({
      success: true,
      data: {
        ratePerPlay: VENUE_ROYALTY_PER_PLAY,
        minWithdrawal: VENUE_ROYALTY_MIN_WITHDRAWAL,
        agreementUrl: AGREEMENT_URL,
        balance,
        totals: { plays: totals.rows[0]?.plays || 0, venues: totals.rows[0]?.venues || 0 },
        tracks: tracks.rows.map((r: any) => ({
          id: String(r.id), title: r.title || 'Без названия', artist: r.artist_name || '',
          status: r.moderation_status || 'pending', paid: !!r.paid,
          optIn: !!r.venue_opt_in, agreedAt: iso(r.venue_agreement_at),
          plays: Number(r.plays || 0), earned: money(Number(r.earned || 0)), lastPlayedAt: iso(r.last_at),
        })),
        venues: venues.rows.map((r: any) => ({
          venueName: r.venue_name || 'Заведение', pointName: r.point_name || null,
          plays: Number(r.plays || 0), earned: money(Number(r.earned || 0)), lastPlayedAt: iso(r.last_at),
        })),
        recent: recent.rows.map((r: any) => ({
          title: r.title || '', venueName: r.venue_name || 'Заведение', pointName: r.point_name || null,
          amount: Number(r.amount || 0), playedAt: iso(r.played_at),
        })),
        withdrawals: wds.rows.map((r: any) => ({
          id: String(r.id), amount: Number(r.amount), status: r.status || 'pending',
          createdAt: iso(r.created_at), method: r.payment_method || null,
        })),
      },
    });
  } catch (e: any) {
    console.error('[venue-royalty] my', e?.message);
    return c.json({ success: false, error: 'Не удалось загрузить статистику' }, 500);
  }
});

app.post('/my/tracks/:id/opt-in', requireAuth, async (c) => {
  const userId = String(c.get('userId'));
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ success: false, error: 'Неверный трек' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const optIn = body?.optIn === true;
  if (optIn && body?.acceptAgreement !== true) {
    return c.json({ success: false, error: 'Чтобы трек звучал в заведениях, примите дополнительное соглашение' }, 400);
  }
  const { rows } = await pool.query(
    `UPDATE tracks
        SET venue_opt_in = $3,
            venue_agreement_at = CASE WHEN $3 THEN now() ELSE venue_agreement_at END,
            venue_agreement_version = CASE WHEN $3 THEN $4 ELSE venue_agreement_version END,
            updated_at = now()
      WHERE id = $1 AND user_id::text = $2 AND COALESCE(is_legacy, false) = false
      RETURNING venue_opt_in`,
    [id, userId, optIn, VENUE_AGREEMENT_VERSION],
  );
  if (!rows[0]) return c.json({ success: false, error: 'Трек не найден' }, 404);
  scheduleSync();
  return c.json({ success: true, data: { id, optIn: !!rows[0].venue_opt_in } });
});

app.post('/my/withdrawals', requireAuth, async (c) => {
  const userId = String(c.get('userId'));
  const body = await c.req.json().catch(() => ({}));
  const amount = money(Number(body?.amount));
  const details = String(body?.details || '').trim().slice(0, 500);
  const method = ['card', 'sbp', 'bank'].includes(body?.method) ? body.method : 'card';
  if (!Number.isFinite(amount) || amount < VENUE_ROYALTY_MIN_WITHDRAWAL) {
    return c.json({ success: false, error: `Минимальная сумма вывода: ${VENUE_ROYALTY_MIN_WITHDRAWAL.toLocaleString('ru-RU')} ₽` }, 400);
  }
  if (!details) return c.json({ success: false, error: 'Укажите реквизиты для выплаты' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Сериализуем заявки одного артиста, чтобы две параллельные не вывели больше баланса.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`venue-royalty-wd:${userId}`]);
    const bal = await balanceFor(userId, client as any);
    if (amount > bal.available + 0.001) {
      await client.query('ROLLBACK');
      return c.json({ success: false, error: `Недостаточно средств. Доступно: ${bal.available.toLocaleString('ru-RU')} ₽` }, 400);
    }
    const { rows } = await client.query(
      `INSERT INTO payment_withdrawals (user_id, app_id, source, amount, currency, commission, commission_rate, payout,
                                        payment_method, payment_details, status, requested_at)
       VALUES ($1, $2, 'venue_royalty', $3, 'RUB', 0, 0, $3, $4, $5::jsonb, 'pending', now()) RETURNING id`,
      [userId, `venue-royalty-wd-${crypto.randomUUID()}`, amount, method, JSON.stringify({ details })],
    );
    await client.query('COMMIT');
    const { rows: u } = await pool.query(
      `SELECT email, COALESCE(NULLIF(display_name, ''), NULLIF(full_name, ''), NULLIF(username, ''), '') AS name FROM users WHERE id::text = $1 LIMIT 1`,
      [userId],
    );
    const who = u[0]?.name || u[0]?.email || userId;
    import('./email-helper.tsx').then(async (m) => {
      const html = m.emailWrapper(`
        <h2 style="margin:0 0 16px;color:#10B981;">Заявка на вывод: роялти за заведения</h2>
        <p style="color:#e0e0e0;">${m.escapeHtml(who)} (${m.escapeHtml(u[0]?.email || 'нет почты')}) просит вывести <b>${amount.toLocaleString('ru-RU')} ₽</b>.</p>
        <p style="color:#e0e0e0;">Способ: ${m.escapeHtml(method)}. Реквизиты: ${m.escapeHtml(details)}</p>
        <p style="color:#888;font-size:13px;">Начислено за проигрывания в заведениях ПРОМО.ЭИР (PROMO.CHECK). Заявка ${m.escapeHtml(String(rows[0].id))}.</p>`);
      await m.sendEmail({ to: 'info@promofm.ru', subject: `[ПРОМО] Вывод роялти за заведения: ${amount.toLocaleString('ru-RU')} ₽, ${who}`, html });
      await m.notifyAdminTelegram(`💸 <b>Вывод роялти за заведения</b>\n${who}: <b>${amount} ₽</b>\nРеквизиты: ${details}`).catch(() => {});
    }).catch(() => {});
    return c.json({ success: true, data: { id: String(rows[0].id), amount, status: 'pending' } }, 201);
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[venue-royalty] withdrawal', e?.message);
    return c.json({ success: false, error: 'Не удалось создать заявку' }, 500);
  } finally {
    client.release();
  }
});

// ─── Админ ────────────────────────────────────────────────────────────────

app.post('/admin/sync', requireAuth, requireAdmin, async (c) => {
  const r = await syncVenueArtistTracks();
  return c.json({ success: true, data: r });
});

app.get('/admin/summary', requireAuth, requireAdmin, async (c) => {
  const { rows } = await pool.query(
    `SELECT p.artist_user_id, max(t.artist_name) AS artist, count(*)::int AS plays, sum(p.amount)::numeric AS earned,
            count(DISTINCT p.venue_user_id)::int AS venues, max(p.played_at) AS last_at
       FROM venue_track_plays p LEFT JOIN tracks t ON t.id = p.track_id
      GROUP BY p.artist_user_id ORDER BY earned DESC LIMIT 200`,
  );
  const { rows: opt } = await pool.query(`SELECT count(*)::int AS n FROM tracks WHERE venue_opt_in = true`);
  return c.json({
    success: true,
    data: {
      optInTracks: opt[0]?.n || 0,
      artists: rows.map((r: any) => ({
        userId: r.artist_user_id, artist: r.artist || '', plays: r.plays, earned: money(Number(r.earned || 0)),
        venues: r.venues, lastPlayedAt: iso(r.last_at),
      })),
    },
  });
});

export default app;
