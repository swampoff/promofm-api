/**
 * DISTRIBUTION ROUTES — release distribution to DSPs.
 *
 * Mounted at `/server/api/distribution`. Lets artists request that
 * their tracks be published to streaming services (Yandex Music,
 * VK Music, Spotify, Apple Music, etc.), and lets admins fulfill
 * those requests.
 *
 * Today fulfilment is MANUAL (admin uploads to DSP, pastes URL/ID
 * back). The schema in `migrations/013_distribution_orders.sql`
 * carries the exact columns a future API-integration worker
 * (Yandex Music partner API, VK Music API, etc.) will write
 * directly — so the same endpoints serve both modes without UI
 * churn when integrations land.
 *
 * Subscription discount: 'promotion' category (5/10/15% by tier)
 * applies to each per-DSP fee. Spark/free pay full base price.
 *
 * Endpoints:
 *
 *   Artist (requireAuth):
 *     POST   /                          — create order (track × DSP)
 *     GET    /user/:userId              — list artist's orders
 *     GET    /track/:trackId            — orders for one track
 *     POST   /:orderId/cancel           — cancel a pending order
 *
 *   Admin (requireAdmin):
 *     GET    /admin/queue               — pending/paid/submitted orders
 *     POST   /admin/:orderId/update     — change status / fill dsp_track_id / paste stats
 *     POST   /admin/:orderId/note       — append admin note
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';
import { applySubscriptionDiscount } from './subscription-pricing.tsx';
import { notifyAllAdmins, notifyCrossCabinet } from './cross-cabinet-notify.tsx';

const app = new Hono();

// ── Pricing (per-DSP, in RUB) ───────────────────────────────────
//
// Base prices before subscription discount. Source-of-truth for
// what an artist sees as «Стоимость дистрибуции в Яндекс Музыку».
// User can update these here; PRODUCT_FACTS.md mirrors them.

const DISTRIBUTION_BASE_PRICES: Record<string, number> = {
  yandex_music: 2000,
  vk_music:     1500,
  spotify:      5000,
  apple_music:  4000,
  soundcloud:   1500,
  other:        3000,
};

const ALLOWED_DSPS = Object.keys(DISTRIBUTION_BASE_PRICES);

function safeErr(err: any): string {
  return err?.message || String(err) || 'Unknown error';
}

// ── POST / — create distribution order ──────────────────────────
//
// body: { trackId: string, targetDsp: 'yandex_music' | ... }
// Validates the track belongs to the calling artist, computes price
// with subscription discount, inserts the order row. Does NOT charge
// — payment is handled via /checkout/create-session with type='purchase'
// and metadata.itemType='distribution' + metadata.orderId.
app.post('/', requireAuth, async (c) => {
  try {
    const userId = String((c as any).get('userId') || '');
    const body = await c.req.json().catch(() => ({} as any));
    const trackId = String(body.trackId || '').trim();
    const targetDsp = String(body.targetDsp || '').toLowerCase().trim();

    if (!trackId) return c.json({ success: false, error: 'trackId is required' }, 400);
    if (!ALLOWED_DSPS.includes(targetDsp)) {
      return c.json({
        success: false,
        error: 'targetDsp must be one of: ' + ALLOWED_DSPS.join(', '),
      }, 400);
    }

    // Verify track ownership — tracks.user_id is text per cheat-sheet.
    const ownerRow = await pool.query(
      `SELECT id::text AS id FROM tracks WHERE id::text = $1 AND user_id = $2 LIMIT 1`,
      [trackId, userId],
    );
    if (ownerRow.rows.length === 0) {
      return c.json({ success: false, error: 'Трек не найден или принадлежит другому артисту' }, 404);
    }

    // Prevent duplicate active orders (artist already has a pending/paid/
    // submitted/live order for the same track × DSP).
    const dup = await pool.query(
      `SELECT id::text AS id, status FROM distribution_orders
        WHERE track_id::text = $1
          AND user_id = $2
          AND target_dsp = $3
          AND status IN ('pending', 'paid', 'submitted', 'live')
        LIMIT 1`,
      [trackId, userId, targetDsp],
    );
    if (dup.rows.length > 0) {
      return c.json({
        success: false,
        error: 'Заявка на эту площадку уже создана',
        existing: dup.rows[0],
      }, 409);
    }

    const basePrice = DISTRIBUTION_BASE_PRICES[targetDsp];
    const priced = await applySubscriptionDiscount(userId, 'promotion', basePrice);

    const ins = await pool.query(
      `INSERT INTO distribution_orders
         (track_id, user_id, target_dsp, status, base_price_rub, price_rub,
          discount_pct, created_by_role)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, 'artist')
       RETURNING id::text AS id, created_at`,
      [trackId, userId, targetDsp, basePrice, priced.finalPrice, priced.discount],
    );

    const order = {
      id: ins.rows[0].id,
      trackId,
      targetDsp,
      status: 'pending',
      basePriceRub: basePrice,
      priceRub: priced.finalPrice,
      discountPct: priced.discount,
      tier: priced.tier,
      createdAt: ins.rows[0].created_at,
    };

    // Notify admins about the new distribution order.
    notifyAllAdmins({
      sourceRole: 'artist',
      type: 'admin_action',
      title: 'Заявка на дистрибуцию',
      message: `Артист запросил дистрибуцию трека на ${targetDsp}. К оплате: ${priced.finalPrice}₽.`,
      link: '/ctrl-pm7k2f/distribution',
      metadata: { orderId: order.id, trackId, targetDsp },
    }).catch((e) => console.warn('[distribution] notifyAllAdmins failed:', safeErr(e)));

    return c.json({ success: true, order }, 201);
  } catch (err: any) {
    console.error('[distribution] POST / error:', err);
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── GET /user/:userId — list artist's orders ────────────────────
app.get('/user/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    const authUserId = (c as any).get('userId');
    const authRole = (c as any).get('userRole');
    if (userId !== authUserId && authRole !== 'admin' && authRole !== 'superadmin') {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    const r = await pool.query(
      `SELECT id::text AS id, track_id::text AS "trackId", target_dsp AS "targetDsp",
              status, dsp_track_id AS "dspTrackId", dsp_track_url AS "dspTrackUrl",
              submitted_at AS "submittedAt", live_at AS "liveAt",
              rejected_reason AS "rejectedReason",
              stats_plays AS "statsPlays", stats_saves AS "statsSaves",
              stats_playlist_adds AS "statsPlaylistAdds",
              stats_last_fetched_at AS "statsLastFetchedAt",
              price_rub AS "priceRub", base_price_rub AS "basePriceRub",
              discount_pct AS "discountPct",
              payment_session_id AS "paymentSessionId",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM distribution_orders
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 500`,
      [userId],
    );
    return c.json({ success: true, orders: r.rows });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── GET /track/:trackId — orders for one track ──────────────────
app.get('/track/:trackId', requireAuth, async (c) => {
  try {
    const trackId = c.req.param('trackId');
    const authUserId = String((c as any).get('userId') || '');
    const authRole = (c as any).get('userRole');

    // Only owner or admin can list
    if (authRole !== 'admin' && authRole !== 'superadmin') {
      const ownerRow = await pool.query(
        `SELECT 1 FROM tracks WHERE id::text = $1 AND user_id = $2 LIMIT 1`,
        [trackId, authUserId],
      );
      if (ownerRow.rows.length === 0) {
        return c.json({ success: false, error: 'Access denied' }, 403);
      }
    }

    const r = await pool.query(
      `SELECT id::text AS id, target_dsp AS "targetDsp", status,
              dsp_track_id AS "dspTrackId", dsp_track_url AS "dspTrackUrl",
              submitted_at AS "submittedAt", live_at AS "liveAt",
              stats_plays AS "statsPlays", stats_saves AS "statsSaves",
              stats_playlist_adds AS "statsPlaylistAdds",
              stats_last_fetched_at AS "statsLastFetchedAt",
              price_rub AS "priceRub", created_at AS "createdAt"
         FROM distribution_orders
        WHERE track_id::text = $1
        ORDER BY created_at DESC`,
      [trackId],
    );
    return c.json({ success: true, orders: r.rows });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── POST /:orderId/cancel — artist cancels a pending order ──────
app.post('/:orderId/cancel', requireAuth, async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const userId = String((c as any).get('userId') || '');

    const r = await pool.query(
      `UPDATE distribution_orders
          SET status = 'cancelled'
        WHERE id::text = $1
          AND user_id = $2
          AND status = 'pending'
        RETURNING id::text AS id`,
      [orderId, userId],
    );
    if (r.rows.length === 0) {
      return c.json({
        success: false,
        error: 'Заявку нельзя отменить (не найдена или уже оплачена/отправлена)',
      }, 404);
    }
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── ADMIN: GET /admin/queue — pending/paid/submitted orders ─────
app.get('/admin/queue', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'pending,paid,submitted';
    const allowed = ['pending', 'paid', 'submitted', 'live', 'rejected', 'cancelled'];
    const statuses = status.split(',').map((s) => s.trim()).filter((s) => allowed.includes(s));
    if (statuses.length === 0) return c.json({ success: true, orders: [] });

    const r = await pool.query(
      `SELECT o.id::text AS id, o.track_id::text AS "trackId",
              o.user_id AS "userId", o.target_dsp AS "targetDsp", o.status,
              o.dsp_track_id AS "dspTrackId", o.dsp_track_url AS "dspTrackUrl",
              o.price_rub AS "priceRub", o.created_at AS "createdAt",
              o.updated_at AS "updatedAt",
              t.title, t.artist_name AS "artistName"
         FROM distribution_orders o
         LEFT JOIN tracks t ON t.id = o.track_id
        WHERE o.status = ANY($1::text[])
        ORDER BY o.created_at ASC
        LIMIT 500`,
      [statuses],
    );
    return c.json({ success: true, orders: r.rows });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── ADMIN: POST /admin/:orderId/update — change status / stats ──
//
// body (all fields optional, only the ones present are updated):
//   { status?, dspTrackId?, dspTrackUrl?, rejectedReason?,
//     statsPlays?, statsSaves?, statsPlaylistAdds? }
//
// Side-effects:
//   - status='submitted' → submitted_at = NOW()
//   - status='live'      → live_at = NOW()
//   - stats fields → stats_last_fetched_at = NOW(),
//                    + history row inserted in distribution_stats_history
app.post('/admin/:orderId/update', requireAuth, requireAdmin, async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const body = await c.req.json().catch(() => ({} as any));

    // Load existing row to validate transitions + collect user_id for SSE.
    const cur = await pool.query(
      `SELECT user_id, status FROM distribution_orders WHERE id::text = $1`,
      [orderId],
    );
    if (cur.rows.length === 0) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }
    const targetUserId: string = cur.rows[0].user_id;

    // Build dynamic UPDATE
    const sets: string[] = [];
    const params: any[] = [];
    let p = 0;
    const add = (col: string, val: any) => {
      p++;
      sets.push(`${col} = $${p}`);
      params.push(val);
    };

    if (typeof body.status === 'string') {
      const allowed = ['pending', 'paid', 'submitted', 'live', 'rejected', 'cancelled'];
      if (!allowed.includes(body.status)) {
        return c.json({ success: false, error: 'Invalid status' }, 400);
      }
      add('status', body.status);
      if (body.status === 'submitted') add('submitted_at', new Date().toISOString());
      if (body.status === 'live')      add('live_at', new Date().toISOString());
    }
    if (typeof body.dspTrackId === 'string')   add('dsp_track_id', body.dspTrackId);
    if (typeof body.dspTrackUrl === 'string')  add('dsp_track_url', body.dspTrackUrl);
    if (typeof body.rejectedReason === 'string') add('rejected_reason', body.rejectedReason);

    const statsTouched = (
      body.statsPlays !== undefined ||
      body.statsSaves !== undefined ||
      body.statsPlaylistAdds !== undefined
    );
    if (statsTouched) {
      if (body.statsPlays !== undefined) add('stats_plays', Math.max(0, Number(body.statsPlays) || 0));
      if (body.statsSaves !== undefined) add('stats_saves', Math.max(0, Number(body.statsSaves) || 0));
      if (body.statsPlaylistAdds !== undefined) add('stats_playlist_adds', Math.max(0, Number(body.statsPlaylistAdds) || 0));
      add('stats_last_fetched_at', new Date().toISOString());
    }

    if (sets.length === 0) {
      return c.json({ success: false, error: 'Nothing to update' }, 400);
    }
    params.push(orderId);
    const r = await pool.query(
      `UPDATE distribution_orders SET ${sets.join(', ')}
        WHERE id::text = $${params.length}
        RETURNING id::text AS id, status, dsp_track_id AS "dspTrackId",
                  dsp_track_url AS "dspTrackUrl",
                  stats_plays AS "statsPlays", stats_saves AS "statsSaves",
                  stats_playlist_adds AS "statsPlaylistAdds"`,
      params,
    );

    // Time-series stats snapshot
    if (statsTouched) {
      const u = r.rows[0];
      pool.query(
        `INSERT INTO distribution_stats_history
           (order_id, plays, saves, playlist_adds, source)
         VALUES ($1, $2, $3, $4, 'admin')`,
        [orderId, u.statsPlays, u.statsSaves, u.statsPlaylistAdds],
      ).catch((e) => console.warn('[distribution] history insert failed:', safeErr(e)));
    }

    // Notify the artist (cross-cabinet) on lifecycle transitions
    if (typeof body.status === 'string') {
      notifyCrossCabinet({
        targetUserId,
        targetRole: 'artist',
        sourceRole: 'admin',
        type: 'admin_action',
        title: 'Дистрибуция обновлена',
        message: `Статус заявки: ${cur.rows[0].status} → ${body.status}`,
        link: '/artist/promotion',
        metadata: { orderId, status: body.status, kind: 'distribution_update' },
      }).catch(() => {});
    }

    return c.json({ success: true, order: r.rows[0] });
  } catch (err: any) {
    console.error('[distribution] admin update error:', err);
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── ADMIN: POST /admin/:orderId/note — append admin note ────────
app.post('/admin/:orderId/note', requireAuth, requireAdmin, async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const body = await c.req.json().catch(() => ({} as any));
    const note = String(body.note || '').trim();
    if (!note) return c.json({ success: false, error: 'note is required' }, 400);

    const cur = await pool.query(
      `SELECT notes FROM distribution_orders WHERE id::text = $1`,
      [orderId],
    );
    if (cur.rows.length === 0) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }
    const prev = String(cur.rows[0].notes || '');
    const ts = new Date().toISOString();
    const merged = (prev ? prev + '\n\n' : '') + `[${ts}] ${note}`;

    await pool.query(
      `UPDATE distribution_orders SET notes = $1 WHERE id::text = $2`,
      [merged, orderId],
    );
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ success: false, error: safeErr(err) }, 500);
  }
});

// ── GET /pricing — public price list (no auth) ──────────────────
// Frontend cabinet shows this to build the «Заказать дистрибуцию» UI.
app.get('/pricing', (c) => {
  return c.json({ success: true, prices: DISTRIBUTION_BASE_PRICES });
});

export default app;
