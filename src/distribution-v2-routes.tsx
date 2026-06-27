/**
 * DISTRIBUTION v2 ROUTES — full Release CRUD + submit + pricing.
 *
 * Mounted at `/server/api/releases`. Реализует богатую Release-модель
 * (миграция 113): артист/DJ собирает релиз (single/EP/album) с треками,
 * контрибьюторами и сплитами, выбирает целевые DSP, отправляет на
 * модерацию → оплата → доставка.
 *
 * Эта фаза (2) — owner-facing CRUD + валидация + submit + ценообразование.
 * Оплата идёт через /checkout/create-session с metadata.type=
 * 'release_distribution' (amount-gate + webhook — в checkout-routes.tsx).
 * Доставка в DSP, DDEX-export, роялти — следующие фазы.
 *
 * РЕАЛЬНОСТЬ: Spotify/Apple не имеют upload-API. Доставка = DDEX +
 * аккредитованный канал/агрегатор или ручная админ-доставка (см.
 * PRODUCT_FACTS «Distribution v2»). Эта фаза готовит метаданные, не шлёт.
 *
 * Endpoints (owner — requireAuth, ownership по c.get('userId')):
 *   POST   /                              — создать draft-релиз
 *   GET    /                              — список своих релизов
 *   GET    /:id                           — полный релиз (tracks+contributors+deliveries)
 *   PATCH  /:id                           — обновить метаданные (draft only)
 *   DELETE /:id                           — удалить draft
 *   POST   /:id/tracks                    — добавить трек (draft only)
 *   PATCH  /:id/tracks/:trackId           — обновить трек (draft only)
 *   DELETE /:id/tracks/:trackId           — удалить трек (draft only)
 *   PUT    /:id/tracks/:trackId/contributors — заменить контрибьюторов трека
 *   PUT    /:id/deliveries                — выбрать целевые DSP (draft only)
 *   POST   /:id/submit                    — валидация + цена → pending_payment
 *   POST   /:id/cancel                    — отменить (draft/pending_payment)
 *   GET    /meta/pricing                  — публичный price-list DSP
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';
import { applySubscriptionDiscount } from './subscription-pricing.tsx';
import { notifyAllAdmins } from './cross-cabinet-notify.tsx';
import {
  mapReleaseRow, mapReleaseTrackRow, mapReleaseDeliveryRow,
  type ContributorRole, type DistributionDsp,
} from './distribution-v2-types.ts';

const app = new Hono();

// ── DSP base prices (per-DSP, RUB) — совпадают с v1 distribution-routes ──
const DSP_BASE_PRICES: Record<DistributionDsp, number> = {
  yandex_music: 2000,
  vk_music:     1500,
  spotify:      5000,
  apple_music:  4000,
  soundcloud:   1500,
  other:        3000,
};
const ALLOWED_DSPS = Object.keys(DSP_BASE_PRICES) as DistributionDsp[];
const ALLOWED_CONTRIBUTOR_ROLES: ContributorRole[] = [
  'primary_artist', 'featured_artist', 'composer', 'lyricist',
  'producer', 'remixer', 'mixer',
];
const ALLOWED_RELEASE_TYPES = ['single', 'ep', 'album'];

function uid(c: any): string {
  return String(c.get('userId') || '');
}

// ── Ownership helper: load release if owned by caller ───────────────────
async function loadOwnedRelease(id: string, userId: string): Promise<any | null> {
  const r = await pool.query(`SELECT * FROM releases WHERE id::text = $1 LIMIT 1`, [id]);
  if (r.rows.length === 0) return null;
  if (r.rows[0].user_id !== userId) return 'forbidden' as any;
  return r.rows[0];
}

// ── Validators ──────────────────────────────────────────────────────────
function isValidIsrc(isrc: string): boolean {
  // CC + XXX + YY + NNNNN — 12 alphanumerics (dashes optional)
  const clean = isrc.replace(/-/g, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{2}[0-9]{5}$/.test(clean);
}
function isValidUpc(upc: string): boolean {
  return /^[0-9]{12,13}$/.test(upc.replace(/\s/g, ''));
}

// ════════════════════════════════════════════════════════════════════
// CREATE / LIST / GET
// ════════════════════════════════════════════════════════════════════

app.post('/', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const body = await c.req.json().catch(() => ({} as any));
    const title = String(body.title || '').trim();
    const releaseType = String(body.releaseType || 'single').toLowerCase();
    const primaryArtistName = String(body.primaryArtistName || '').trim();
    const creatorRole = body.creatorRole === 'dj' ? 'dj' : 'artist';

    if (!title) return c.json({ success: false, error: 'title обязателен' }, 400);
    if (!primaryArtistName) return c.json({ success: false, error: 'primaryArtistName обязателен' }, 400);
    if (!ALLOWED_RELEASE_TYPES.includes(releaseType)) {
      return c.json({ success: false, error: 'releaseType: single|ep|album' }, 400);
    }

    // artist_profile_id — опционально (если у юзера есть профиль артиста)
    let artistProfileId: string | null = null;
    try {
      const ap = await pool.query(
        `SELECT id::text AS id FROM artist_profiles WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [userId],
      );
      artistProfileId = ap.rows[0]?.id ?? null;
    } catch { /* профиль не обязателен */ }

    const ins = await pool.query(
      `INSERT INTO releases (user_id, creator_role, artist_profile_id, title, release_type, primary_artist_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')
       RETURNING *`,
      [userId, creatorRole, artistProfileId, title, releaseType, primaryArtistName],
    );
    return c.json({ success: true, release: mapReleaseRow(ins.rows[0]) }, 201);
  } catch (err) {
    console.error('[dist-v2] POST / error:', safeErrorMessage(err));
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.get('/', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const r = await pool.query(
      `SELECT * FROM releases WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [userId],
    );
    return c.json({ success: true, releases: r.rows.map(mapReleaseRow) });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

app.get('/:id', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const rel = await loadOwnedRelease(id, userId);
    if (!rel) return c.json({ success: false, error: 'Релиз не найден' }, 404);
    if (rel === 'forbidden') return c.json({ success: false, error: 'Это не ваш релиз' }, 403);

    const [tracks, deliveries] = await Promise.all([
      pool.query(`SELECT * FROM release_tracks WHERE release_id = $1 ORDER BY disc_number, track_number`, [id]),
      pool.query(`SELECT * FROM release_deliveries WHERE release_id = $1 ORDER BY target_dsp`, [id]),
    ]);
    // Contributors per track
    const trackIds = tracks.rows.map((t: any) => t.id);
    let contribByTrack: Record<string, any[]> = {};
    if (trackIds.length > 0) {
      const cr = await pool.query(
        `SELECT * FROM release_contributors WHERE release_track_id = ANY($1) ORDER BY role, name`,
        [trackIds],
      );
      for (const row of cr.rows) {
        (contribByTrack[row.release_track_id] ||= []).push({
          id: row.id, name: row.name, role: row.role,
          splitPct: Number(row.split_pct) || 0,
          payeeUserId: row.payee_user_id ?? null, ipi: row.ipi ?? null,
        });
      }
    }
    const tracksOut = tracks.rows.map((t: any) => ({
      ...mapReleaseTrackRow(t),
      contributors: contribByTrack[t.id] || [],
    }));

    return c.json({
      success: true,
      release: mapReleaseRow(rel),
      tracks: tracksOut,
      deliveries: deliveries.rows.map(mapReleaseDeliveryRow),
    });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// ════════════════════════════════════════════════════════════════════
// UPDATE / DELETE release (draft only)
// ════════════════════════════════════════════════════════════════════

const RELEASE_PATCH_FIELDS: Record<string, string> = {
  title: 'title', releaseType: 'release_type', primaryArtistName: 'primary_artist_name',
  labelName: 'label_name', upc: 'upc', catalogNumber: 'catalog_number',
  genre: 'genre', subgenre: 'subgenre', language: 'language',
  releaseDate: 'release_date', originalReleaseDate: 'original_release_date',
  coverUrl: 'cover_url', coverWidth: 'cover_width', coverHeight: 'cover_height',
  cLine: 'c_line', pLine: 'p_line', cLineYear: 'c_line_year', pLineYear: 'p_line_year',
  explicit: 'explicit',
};

app.patch('/:id', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const rel = await loadOwnedRelease(id, userId);
    if (!rel) return c.json({ success: false, error: 'Релиз не найден' }, 404);
    if (rel === 'forbidden') return c.json({ success: false, error: 'Это не ваш релиз' }, 403);
    if (rel.status !== 'draft') {
      return c.json({ success: false, error: `Редактировать можно только draft (текущий: ${rel.status})` }, 409);
    }

    const body = await c.req.json().catch(() => ({} as any));
    if (body.upc != null && String(body.upc).trim() && !isValidUpc(String(body.upc))) {
      return c.json({ success: false, error: 'UPC должен быть 12-13 цифр' }, 400);
    }
    if (body.releaseType != null && !ALLOWED_RELEASE_TYPES.includes(String(body.releaseType))) {
      return c.json({ success: false, error: 'releaseType: single|ep|album' }, 400);
    }

    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    for (const [apiKey, col] of Object.entries(RELEASE_PATCH_FIELDS)) {
      if (apiKey in body) {
        sets.push(`${col} = $${i++}`);
        vals.push(body[apiKey] === '' ? null : body[apiKey]);
      }
    }
    if (sets.length === 0) return c.json({ success: false, error: 'Нет полей для обновления' }, 400);
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const upd = await pool.query(
      `UPDATE releases SET ${sets.join(', ')} WHERE id::text = $${i} RETURNING *`,
      vals,
    );
    return c.json({ success: true, release: mapReleaseRow(upd.rows[0]) });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

app.delete('/:id', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const del = await pool.query(
      `DELETE FROM releases WHERE id::text = $1 AND user_id = $2 AND status IN ('draft','cancelled')`,
      [id, userId],
    );
    if (del.rowCount === 0) {
      return c.json({ success: false, error: 'Релиз не найден, не ваш, или уже отправлен (удалить можно только draft)' }, 404);
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// ════════════════════════════════════════════════════════════════════
// TRACKS (draft only)
// ════════════════════════════════════════════════════════════════════

async function assertDraftOwned(id: string, userId: string, c: any): Promise<any | Response> {
  const rel = await loadOwnedRelease(id, userId);
  if (!rel) return c.json({ success: false, error: 'Релиз не найден' }, 404);
  if (rel === 'forbidden') return c.json({ success: false, error: 'Это не ваш релиз' }, 403);
  if (rel.status !== 'draft') return c.json({ success: false, error: `Релиз не в статусе draft (${rel.status})` }, 409);
  return rel;
}

app.post('/:id/tracks', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const guard = await assertDraftOwned(id, userId, c);
    if (guard instanceof Response) return guard;

    const body = await c.req.json().catch(() => ({} as any));
    const title = String(body.title || '').trim();
    if (!title) return c.json({ success: false, error: 'title трека обязателен' }, 400);
    if (body.isrc != null && String(body.isrc).trim() && !isValidIsrc(String(body.isrc))) {
      return c.json({ success: false, error: 'ISRC формат: CCXXXYYNNNNN (12 символов)' }, 400);
    }

    // track_id — опционально, если переиспользуем существующий tracks-row.
    // Проверяем владение если передан.
    let trackId: string | null = null;
    if (body.trackId) {
      const own = await pool.query(
        `SELECT id::text AS id FROM tracks WHERE id::text = $1 AND user_id = $2 LIMIT 1`,
        [String(body.trackId), userId],
      );
      if (own.rows.length === 0) return c.json({ success: false, error: 'trackId не найден или не ваш' }, 400);
      trackId = own.rows[0].id;
    }

    // next track_number
    const cnt = await pool.query(`SELECT COALESCE(MAX(track_number),0)+1 AS n FROM release_tracks WHERE release_id = $1`, [id]);
    const trackNumber = Number(body.trackNumber) || Number(cnt.rows[0].n) || 1;

    const ins = await pool.query(
      `INSERT INTO release_tracks
         (release_id, track_id, track_number, disc_number, title, version, isrc,
          explicit, language, audio_url, audio_format, audio_sample_rate, audio_bit_depth,
          duration_sec, preview_start_sec, is_dj_mix, rights_attested, rights_attested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        id, trackId, trackNumber, Number(body.discNumber) || 1, title,
        body.version || null, body.isrc || null, !!body.explicit,
        body.language || 'ru', body.audioUrl || null, body.audioFormat || null,
        body.audioSampleRate || null, body.audioBitDepth || null,
        body.durationSec || null, body.previewStartSec || null,
        !!body.isDjMix, !!body.rightsAttested, body.rightsAttested ? new Date().toISOString() : null,
      ],
    );
    return c.json({ success: true, track: mapReleaseTrackRow(ins.rows[0]) }, 201);
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

const TRACK_PATCH_FIELDS: Record<string, string> = {
  title: 'title', version: 'version', isrc: 'isrc', explicit: 'explicit',
  language: 'language', audioUrl: 'audio_url', audioFormat: 'audio_format',
  audioSampleRate: 'audio_sample_rate', audioBitDepth: 'audio_bit_depth',
  durationSec: 'duration_sec', previewStartSec: 'preview_start_sec',
  trackNumber: 'track_number', discNumber: 'disc_number', isDjMix: 'is_dj_mix',
};

app.patch('/:id/tracks/:trackId', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const trackRowId = c.req.param('trackId');
    const guard = await assertDraftOwned(id, userId, c);
    if (guard instanceof Response) return guard;

    const body = await c.req.json().catch(() => ({} as any));
    if (body.isrc != null && String(body.isrc).trim() && !isValidIsrc(String(body.isrc))) {
      return c.json({ success: false, error: 'ISRC формат: CCXXXYYNNNNN' }, 400);
    }

    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    for (const [apiKey, col] of Object.entries(TRACK_PATCH_FIELDS)) {
      if (apiKey in body) { sets.push(`${col} = $${i++}`); vals.push(body[apiKey] === '' ? null : body[apiKey]); }
    }
    // rights_attested отдельно — стампим время
    if ('rightsAttested' in body) {
      sets.push(`rights_attested = $${i++}`); vals.push(!!body.rightsAttested);
      sets.push(`rights_attested_at = $${i++}`); vals.push(body.rightsAttested ? new Date().toISOString() : null);
    }
    if (sets.length === 0) return c.json({ success: false, error: 'Нет полей' }, 400);
    sets.push(`updated_at = NOW()`);
    vals.push(trackRowId); vals.push(id);
    const upd = await pool.query(
      `UPDATE release_tracks SET ${sets.join(', ')} WHERE id::text = $${i++} AND release_id::text = $${i} RETURNING *`,
      vals,
    );
    if (upd.rowCount === 0) return c.json({ success: false, error: 'Трек не найден в релизе' }, 404);
    return c.json({ success: true, track: mapReleaseTrackRow(upd.rows[0]) });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

app.delete('/:id/tracks/:trackId', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const trackRowId = c.req.param('trackId');
    const guard = await assertDraftOwned(id, userId, c);
    if (guard instanceof Response) return guard;
    const del = await pool.query(
      `DELETE FROM release_tracks WHERE id::text = $1 AND release_id::text = $2`,
      [trackRowId, id],
    );
    if (del.rowCount === 0) return c.json({ success: false, error: 'Трек не найден' }, 404);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// ── PUT contributors (replace all for a track) ──────────────────────────
app.put('/:id/tracks/:trackId/contributors', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const trackRowId = c.req.param('trackId');
    const guard = await assertDraftOwned(id, userId, c);
    if (guard instanceof Response) return guard;

    // Verify track belongs to release
    const tk = await pool.query(`SELECT id FROM release_tracks WHERE id::text = $1 AND release_id::text = $2`, [trackRowId, id]);
    if (tk.rows.length === 0) return c.json({ success: false, error: 'Трек не найден в релизе' }, 404);

    const body = await c.req.json().catch(() => ({} as any));
    const contributors: any[] = Array.isArray(body.contributors) ? body.contributors : [];
    for (const ct of contributors) {
      if (!ct.name || !String(ct.name).trim()) return c.json({ success: false, error: 'У контрибьютора нет name' }, 400);
      if (!ALLOWED_CONTRIBUTOR_ROLES.includes(ct.role)) {
        return c.json({ success: false, error: `role должен быть: ${ALLOWED_CONTRIBUTOR_ROLES.join('|')}` }, 400);
      }
    }

    // Replace transactionally
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM release_contributors WHERE release_track_id::text = $1`, [trackRowId]);
      for (const ct of contributors) {
        await client.query(
          `INSERT INTO release_contributors (release_track_id, name, role, split_pct, payee_user_id, ipi)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [trackRowId, String(ct.name).trim(), ct.role, Number(ct.splitPct) || 0, ct.payeeUserId || null, ct.ipi || null],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return c.json({ success: true, count: contributors.length });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// ── PUT deliveries (set target DSPs) ────────────────────────────────────
app.put('/:id/deliveries', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const guard = await assertDraftOwned(id, userId, c);
    if (guard instanceof Response) return guard;

    const body = await c.req.json().catch(() => ({} as any));
    const dsps: string[] = Array.isArray(body.dsps) ? body.dsps : [];
    const invalid = dsps.filter((d) => !ALLOWED_DSPS.includes(d as DistributionDsp));
    if (invalid.length > 0) return c.json({ success: false, error: `Неизвестные DSP: ${invalid.join(', ')}` }, 400);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM release_deliveries WHERE release_id::text = $1`, [id]);
      for (const dsp of dsps) {
        await client.query(
          `INSERT INTO release_deliveries (release_id, target_dsp, status) VALUES ($1, $2, 'queued')
           ON CONFLICT (release_id, target_dsp) DO NOTHING`,
          [id, dsp],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const out = await pool.query(`SELECT * FROM release_deliveries WHERE release_id = $1 ORDER BY target_dsp`, [id]);
    return c.json({ success: true, deliveries: out.rows.map(mapReleaseDeliveryRow) });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// ════════════════════════════════════════════════════════════════════
// SUBMIT — validate + price + → pending_payment
// ════════════════════════════════════════════════════════════════════

app.post('/:id/submit', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const rel = await loadOwnedRelease(id, userId);
    if (!rel) return c.json({ success: false, error: 'Релиз не найден' }, 404);
    if (rel === 'forbidden') return c.json({ success: false, error: 'Это не ваш релиз' }, 403);
    if (rel.status !== 'draft') {
      return c.json({ success: false, error: `Отправить можно только draft (текущий: ${rel.status})` }, 409);
    }

    const [tracks, deliveries] = await Promise.all([
      pool.query(`SELECT * FROM release_tracks WHERE release_id = $1 ORDER BY track_number`, [id]),
      pool.query(`SELECT * FROM release_deliveries WHERE release_id = $1`, [id]),
    ]);

    // ── Validation ──
    const errors: string[] = [];
    if (!rel.title?.trim()) errors.push('Не заполнено название релиза');
    if (!rel.primary_artist_name?.trim()) errors.push('Не указан основной исполнитель');
    if (!rel.genre?.trim()) errors.push('Не выбран жанр');
    if (!rel.cover_url) errors.push('Не загружена обложка');
    if (rel.cover_width && rel.cover_height) {
      if (rel.cover_width !== rel.cover_height) errors.push('Обложка должна быть квадратной');
      if (rel.cover_width < 3000) errors.push('Обложка должна быть минимум 3000×3000');
    }
    if (!rel.release_date) errors.push('Не выбрана дата релиза');
    else {
      const rd = new Date(rel.release_date);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (!isNaN(rd.getTime()) && rd < today) errors.push('Дата релиза в прошлом');
    }
    if (rel.upc && !isValidUpc(rel.upc)) errors.push('Некорректный UPC');

    if (tracks.rows.length === 0) errors.push('В релизе нет треков');
    for (const t of tracks.rows) {
      const label = `Трек «${t.title || t.track_number}»`;
      if (!t.title?.trim()) errors.push(`${label}: нет названия`);
      if (!t.audio_url) errors.push(`${label}: не загружено аудио`);
      if (t.audio_format && !['wav', 'flac'].includes(String(t.audio_format).toLowerCase())) {
        errors.push(`${label}: аудио должно быть WAV или FLAC (получено ${t.audio_format})`);
      }
      if (t.isrc && !isValidIsrc(t.isrc)) errors.push(`${label}: некорректный ISRC`);
      if (t.is_dj_mix && !t.rights_attested) {
        errors.push(`${label}: DJ-микс требует подтверждения прав на содержимое`);
      }
      // contributors: ≥1 primary_artist; royalty-сплиты payee'ев ≤ 100
      const cr = await pool.query(`SELECT role, split_pct, payee_user_id FROM release_contributors WHERE release_track_id = $1`, [t.id]);
      const hasPrimary = cr.rows.some((x: any) => x.role === 'primary_artist');
      if (!hasPrimary) errors.push(`${label}: нет основного исполнителя (primary_artist)`);
      const payeeSplit = cr.rows
        .filter((x: any) => x.payee_user_id)
        .reduce((s: number, x: any) => s + (Number(x.split_pct) || 0), 0);
      if (payeeSplit > 100.01) errors.push(`${label}: сумма роялти-сплитов ${payeeSplit}% > 100%`);
    }

    const selectedDsps = deliveries.rows.map((d: any) => d.target_dsp);
    if (selectedDsps.length === 0) errors.push('Не выбран ни один DSP для доставки');

    if (errors.length > 0) {
      return c.json({ success: false, error: 'Релиз не готов к отправке', validationErrors: errors }, 422);
    }

    // ── Pricing: сумма base-цен выбранных DSP с promotion-скидкой ──
    const basePrice = selectedDsps.reduce((s: number, dsp: string) => s + (DSP_BASE_PRICES[dsp as DistributionDsp] || 0), 0);
    const priced = await applySubscriptionDiscount(userId, 'promotion', basePrice);

    const upd = await pool.query(
      `UPDATE releases
          SET status = 'pending_payment', base_price_rub = $2, price_rub = $3,
              discount_pct = $4, updated_at = NOW()
        WHERE id::text = $1 AND status = 'draft'
        RETURNING *`,
      [id, basePrice, priced.finalPrice, priced.discount],
    );
    if (upd.rowCount === 0) {
      return c.json({ success: false, error: 'Релиз уже не в статусе draft' }, 409);
    }

    notifyAllAdmins({
      sourceRole: rel.creator_role === 'dj' ? 'dj' : 'artist',
      type: 'admin_action',
      title: 'Релиз на дистрибуцию',
      message: `${rel.creator_role === 'dj' ? 'DJ' : 'Артист'} отправил релиз «${rel.title}» (${selectedDsps.length} DSP). К оплате: ${priced.finalPrice}₽.`,
      link: '/ctrl-pm7k2f/distribution',
      metadata: { releaseId: id, dsps: selectedDsps },
    }).catch(() => {});

    return c.json({
      success: true,
      release: mapReleaseRow(upd.rows[0]),
      pricing: {
        basePriceRub: basePrice,
        priceRub: priced.finalPrice,
        discountPct: priced.discount,
        tier: priced.tier,
      },
      // Frontend → /checkout/create-session с type='purchase',
      // metadata.type='release_distribution', metadata.releaseId
      checkout: { paymentType: 'release_distribution', releaseId: id, amount: priced.finalPrice },
    });
  } catch (err) {
    console.error('[dist-v2] submit error:', safeErrorMessage(err));
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

app.post('/:id/cancel', requireAuth, async (c) => {
  try {
    const userId = uid(c);
    const id = c.req.param('id');
    const upd = await pool.query(
      `UPDATE releases SET status = 'cancelled', updated_at = NOW()
        WHERE id::text = $1 AND user_id = $2 AND status IN ('draft','pending_payment')
        RETURNING id::text AS id`,
      [id, userId],
    );
    if (upd.rowCount === 0) {
      return c.json({ success: false, error: 'Релиз не найден, не ваш, или уже в работе (отменить можно до оплаты)' }, 404);
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// ── Public: pricing list ────────────────────────────────────────────────
app.get('/meta/pricing', (c) => {
  return c.json({ success: true, prices: DSP_BASE_PRICES });
});

export default app;
