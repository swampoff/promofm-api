/**
 * VENUE-STATION ROUTES — onboarding + provisioning of a venue's own
 * dedicated radio (the «promo.fm-style» stream that ships to the
 * in-venue Android device).
 *
 * Three audiences:
 *
 *   1. Venue owner (JWT) — fills the onboarding wizard, sees status,
 *      can resubmit after admin requests changes, gets the pairing
 *      code once the stream is provisioned.
 *
 *   2. Admin (requireAdmin) — works the queue: take request → set up
 *      stream config on the VPS infra → mark provisioned → optionally
 *      pause/resume/reject. The actual VPS/Icecast/Go-service work is
 *      out of scope for this module — admin just records the result.
 *
 *   3. Android APK (no auth, single-use pairing code) — POST /pair
 *      with the 6-char code shown in the cabinet, gets back the
 *      stream URL + Bearer token and starts playing.
 *
 * Internal note for devs: the AI host (Gemini) tech is intentionally
 * invisible to venues — every user-facing string in the wizard /
 * cabinet / email refers to «ведущий эфира» without naming the tech.
 * Internal field names (`ai_host_config`, `gemini_config`) stay
 * descriptive for backend code clarity.
 *
 * Persistence: `venue_station_requests` + `venue_station_streams`
 * (see src/migrations/021_venue_station.sql).
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { getVenueProfile as dbGetVenueProfile } from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { sendVenueRadioReadyEmail, sendVenueRadioChangesRequestedEmail } from './email-helper.tsx';

const app = new Hono();

// ── helpers ──────────────────────────────────────────────────────

async function getUserId(c: any): Promise<string> {
  return (c as any).get('userId') || 'anonymous';
}

function parse(data: any): any {
  if (!data) return null;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data;
}

async function loadVenueProfile(userId: string): Promise<any | null> {
  const data = await dbGetVenueProfile(userId);
  return parse(data);
}

// Look up the user's email + display name for notification emails.
// Returns null when the user row is gone (extremely rare — would mean
// the venue was deleted but a request still references the user_id).
async function loadVenueContact(userId: string): Promise<{ email: string; name: string } | null> {
  try {
    const r = await pool.query(
      `SELECT email, COALESCE(full_name, username, email) AS name
         FROM users
        WHERE id::text = $1
        LIMIT 1`,
      [userId]
    );
    if (r.rowCount === 0 || !r.rows[0].email) return null;
    return { email: r.rows[0].email, name: r.rows[0].name || 'Заведение' };
  } catch (err) {
    console.error('[venue-station] loadVenueContact failed:', err);
    return null;
  }
}

function rowToRequest(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    venueId: r.venue_id,
    musicPreferences: r.music_preferences || {},
    jingles: r.jingles || {},
    aiHostConfig: r.ai_host_config || {},
    status: r.status,
    assignedAdminId: r.assigned_admin_id,
    adminNotes: r.admin_notes,
    rejectedReason: r.rejected_reason,
    changesRequested: r.changes_requested,
    submittedAt: r.submitted_at,
    takenAt: r.taken_at,
    provisionedAt: r.provisioned_at,
    liveAt: r.live_at,
    monthlyPrice: r.monthly_price != null ? Number(r.monthly_price) : 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToStream(r: any, includePrivate = false) {
  const base = {
    id: r.id,
    requestId: r.request_id,
    venueId: r.venue_id,
    locationId: r.location_id,
    streamUrl: r.stream_url,
    pairingCode: r.paired_at ? null : r.pairing_code,    // hide code once paired
    pairingExpiresAt: r.pairing_expires_at,
    pairedAt: r.paired_at,
    pairedDeviceInfo: r.paired_device_info,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeenAt: r.last_seen_at,
  };
  if (includePrivate) {
    return {
      ...base,
      userId: r.user_id,
      vpsHost: r.vps_host,
      bearerTokenId: r.bearer_token_id,
      geminiConfig: r.gemini_config,
    };
  }
  return base;
}

// Pairing-code alphabet — base32 sans the ambiguous chars (0/O, 1/I/L).
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newPairingCode(): string {
  const part = (n: number) =>
    Array.from(crypto.randomBytes(n))
      .map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length])
      .join('');
  return `${part(3)}-${part(3)}`;
}

// ──────────────────────────────────────────────────────────────────
// VENUE-OWNER ENDPOINTS (JWT auth, scoped to own profile)
// ──────────────────────────────────────────────────────────────────

// GET /me — the auth'd venue's onboarding request (+ stream if any).
// Used by the cabinet to render either the lock-overlay (no request /
// pending_admin) or the «my radio» panel (provisioned / live).
app.get('/me', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: true, request: null, streams: [] });
    }

    const reqRes = await pool.query(
      `SELECT * FROM venue_station_requests
        WHERE venue_id = $1
          AND status NOT IN ('rejected')
        ORDER BY created_at DESC LIMIT 1`,
      [profile.id]
    );
    const request = reqRes.rows[0] ? rowToRequest(reqRes.rows[0]) : null;

    let streams: any[] = [];
    if (request) {
      const sr = await pool.query(
        `SELECT * FROM venue_station_streams
          WHERE request_id::text = $1 OR venue_id = $2
          ORDER BY created_at ASC`,
        [request.id, profile.id]
      );
      streams = sr.rows.map((r) => rowToStream(r, false));
    }

    return c.json({ success: true, request, streams });
  } catch (error: any) {
    console.error('GET /venue-station/me:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST / — submit the onboarding wizard. Idempotent per-venue: if a
// request already exists in any open status, we 409 and tell the
// caller to PUT / instead (used when admin requested changes).
app.post('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const existing = await pool.query(
      `SELECT id, status FROM venue_station_requests
        WHERE venue_id = $1 AND status NOT IN ('rejected')`,
      [profile.id]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return c.json({
        success: false,
        error: 'A request already exists for this venue. Use PUT / to update.',
        existingRequestId: existing.rows[0].id,
        existingStatus: existing.rows[0].status,
      }, 409);
    }

    const body = await c.req.json().catch(() => ({}));
    const musicPreferences = body.musicPreferences || {};
    const jingles          = body.jingles          || {};
    const aiHostConfig     = body.aiHostConfig     || {};

    const r = await pool.query(
      `INSERT INTO venue_station_requests
         (user_id, venue_id, music_preferences, jingles, ai_host_config,
          status, submitted_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb,
               'pending_admin', NOW())
       RETURNING *`,
      [
        userId,
        profile.id,
        JSON.stringify(musicPreferences),
        JSON.stringify(jingles),
        JSON.stringify(aiHostConfig),
      ]
    );

    // Best-effort admin notify — don't block the response.
    notifyAdminNewRequest(profile, r.rows[0]).catch((err) =>
      console.error('notifyAdminNewRequest failed:', err?.message));

    return c.json({ success: true, request: rowToRequest(r.rows[0]) });
  } catch (error: any) {
    console.error('POST /venue-station:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT / — update the open request (used after admin requested changes
// or when the venue wants to edit preferences before admin takes it).
// Auto-bumps status back to pending_admin so the admin queue picks it
// up again.
app.put('/', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const existing = await pool.query(
      `SELECT * FROM venue_station_requests
        WHERE venue_id = $1 AND status NOT IN ('rejected')
        ORDER BY created_at DESC LIMIT 1`,
      [profile.id]
    );
    if (existing.rowCount === 0) {
      return c.json({ success: false, error: 'No open request to update' }, 404);
    }
    const cur = existing.rows[0];

    const body = await c.req.json().catch(() => ({}));
    const musicPreferences = body.musicPreferences ?? cur.music_preferences;
    const jingles          = body.jingles          ?? cur.jingles;
    const aiHostConfig     = body.aiHostConfig     ?? cur.ai_host_config;

    // Auto-resubmit semantics: any edit bumps us back to pending_admin
    // (unless already provisioned/live — those keep their status; only
    // the config is updated for next admin review).
    const nextStatus =
      cur.status === 'changes_requested' || cur.status === 'pending_admin'
        ? 'pending_admin'
        : cur.status;
    const nextSubmittedAt =
      nextStatus === 'pending_admin' ? new Date().toISOString() : cur.submitted_at;

    const r = await pool.query(
      `UPDATE venue_station_requests
          SET music_preferences  = $1::jsonb,
              jingles            = $2::jsonb,
              ai_host_config     = $3::jsonb,
              status             = $4,
              submitted_at       = $5,
              changes_requested  = NULL,
              updated_at         = NOW()
        WHERE id = $6
        RETURNING *`,
      [
        JSON.stringify(musicPreferences),
        JSON.stringify(jingles),
        JSON.stringify(aiHostConfig),
        nextStatus,
        nextSubmittedAt,
        cur.id,
      ]
    );

    return c.json({ success: true, request: rowToRequest(r.rows[0]) });
  } catch (error: any) {
    console.error('PUT /venue-station:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /me/regenerate-pairing — venue lost the code or is replacing
// the in-venue Android device. Generates a fresh 24h code for the
// provided stream id, BUT only if the venue actually owns that stream.
app.post('/me/regenerate-pairing', requireAuth, async (c) => {
  try {
    const userId = await getUserId(c);
    const profile = await loadVenueProfile(userId);
    if (!profile) {
      return c.json({ success: false, error: 'Venue profile not found' }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const streamId = String(body.streamId || '').trim();
    if (!streamId) {
      return c.json({ success: false, error: 'streamId is required' }, 400);
    }

    const ownership = await pool.query(
      `SELECT id FROM venue_station_streams
        WHERE id::text = $1 AND user_id = $2 AND venue_id = $3`,
      [streamId, userId, profile.id]
    );
    if (ownership.rowCount === 0) {
      return c.json({ success: false, error: 'Stream not found' }, 404);
    }

    const code = newPairingCode();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const r = await pool.query(
      `UPDATE venue_station_streams
          SET pairing_code        = $1,
              pairing_expires_at  = $2,
              paired_at           = NULL,
              paired_device_info  = NULL,
              updated_at          = NOW()
        WHERE id::text = $3
        RETURNING *`,
      [code, expires, streamId]
    );
    return c.json({ success: true, stream: rowToStream(r.rows[0], false) });
  } catch (error: any) {
    console.error('POST /venue-station/me/regenerate-pairing:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS (requireAdmin)
// ──────────────────────────────────────────────────────────────────

app.get('/admin/queue', requireAuth, requireAdmin, async (c) => {
  try {
    const r = await pool.query(
      `SELECT r.*,
              vp.data->>'venueName' AS venue_name,
              vp.data->>'city'      AS venue_city,
              vp.data->>'venueType' AS venue_type
         FROM venue_station_requests r
         LEFT JOIN venue_profiles vp ON vp.user_id = r.user_id
        WHERE r.status NOT IN ('rejected')
        ORDER BY
          CASE r.status
            WHEN 'pending_admin'       THEN 0
            WHEN 'changes_requested'   THEN 1
            WHEN 'in_setup'            THEN 2
            WHEN 'provisioned'         THEN 3
            WHEN 'live'                THEN 4
            WHEN 'paused'              THEN 5
            ELSE 9
          END,
          r.submitted_at DESC NULLS LAST`
    );
    const requests = r.rows.map((row) => ({
      ...rowToRequest(row),
      venueName: row.venue_name,
      venueCity: row.venue_city,
      venueType: row.venue_type,
    }));
    return c.json({ success: true, requests });
  } catch (error: any) {
    console.error('GET /venue-station/admin/queue:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.get('/admin/:requestId', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('requestId');
    const r = await pool.query(
      `SELECT r.*,
              vp.data->>'venueName' AS venue_name,
              vp.data        AS venue_profile
         FROM venue_station_requests r
         LEFT JOIN venue_profiles vp ON vp.user_id = r.user_id
        WHERE r.id::text = $1`,
      [id]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Request not found' }, 404);
    }
    const sr = await pool.query(
      `SELECT * FROM venue_station_streams
        WHERE request_id::text = $1
        ORDER BY created_at ASC`,
      [id]
    );
    const row = r.rows[0];
    return c.json({
      success: true,
      request: { ...rowToRequest(row), venueName: row.venue_name },
      venueProfile: parse(row.venue_profile),
      streams: sr.rows.map((s) => rowToStream(s, true)),
    });
  } catch (error: any) {
    console.error('GET /venue-station/admin/:requestId:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/admin/:requestId/take', requireAuth, requireAdmin, async (c) => {
  try {
    const adminId = await getUserId(c);
    const id = c.req.param('requestId');
    const r = await pool.query(
      `UPDATE venue_station_requests
          SET status              = 'in_setup',
              assigned_admin_id   = $1,
              taken_at            = NOW(),
              updated_at          = NOW()
        WHERE id::text = $2 AND status IN ('pending_admin', 'changes_requested')
        RETURNING *`,
      [adminId, id]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Request not found or already taken' }, 404);
    }
    return c.json({ success: true, request: rowToRequest(r.rows[0]) });
  } catch (error: any) {
    console.error('POST /venue-station/admin/:requestId/take:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/admin/:requestId/reject', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('requestId');
    const body = await c.req.json().catch(() => ({}));
    const reason = String(body.reason || '').trim();
    if (!reason) {
      return c.json({ success: false, error: 'reason is required' }, 400);
    }
    const r = await pool.query(
      `UPDATE venue_station_requests
          SET status           = 'rejected',
              rejected_reason  = $1,
              updated_at       = NOW()
        WHERE id::text = $2
        RETURNING *`,
      [reason, id]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Request not found' }, 404);
    }
    return c.json({ success: true, request: rowToRequest(r.rows[0]) });
  } catch (error: any) {
    console.error('POST /venue-station/admin/:requestId/reject:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/admin/:requestId/request-changes', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('requestId');
    const body = await c.req.json().catch(() => ({}));
    const message = String(body.message || '').trim();
    if (!message) {
      return c.json({ success: false, error: 'message is required' }, 400);
    }
    const r = await pool.query(
      `UPDATE venue_station_requests
          SET status              = 'changes_requested',
              changes_requested   = $1,
              updated_at          = NOW()
        WHERE id::text = $2 AND status IN ('pending_admin', 'in_setup')
        RETURNING *`,
      [message, id]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Request not found or not in editable state' }, 404);
    }

    // Notify venue — fire-and-forget so email outage doesn't block
    // the admin action.
    const venueRow = r.rows[0];
    loadVenueContact(venueRow.user_id).then((contact) => {
      if (contact) {
        return sendVenueRadioChangesRequestedEmail({
          toEmail: contact.email,
          venueName: contact.name,
          message,
        });
      }
    }).catch((err) => console.error('[venue-station] changes_requested email failed:', err?.message));

    return c.json({ success: true, request: rowToRequest(r.rows[0]) });
  } catch (error: any) {
    console.error('POST /venue-station/admin/:requestId/request-changes:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /admin/:requestId/provision — admin records the manual setup
// they did on the VPS infra: stream URL, host name, bearer token id
// (from /venue-api/tokens), gemini config snapshot. Creates the
// venue_station_streams row + a fresh pairing code.
app.post('/admin/:requestId/provision', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('requestId');
    const body = await c.req.json().catch(() => ({}));
    const streamUrl    = String(body.streamUrl || '').trim();
    const vpsHost      = body.vpsHost      ? String(body.vpsHost).trim()      : null;
    const bearerTokenId = body.bearerTokenId ? String(body.bearerTokenId).trim() : null;
    const locationId   = body.locationId   ? String(body.locationId).trim()   : null;
    const geminiConfig = body.geminiConfig || null;
    // Цена абонемента по типу эфира — админ задаёт при провижининге
    // (migration 123). 0 допустимо (проставит позже), триал стартует
    // независимо от цены.
    const monthlyPrice = Number(body.monthlyPrice) || 0;

    if (!streamUrl) {
      return c.json({ success: false, error: 'streamUrl is required' }, 400);
    }
    if (!/^https?:\/\//i.test(streamUrl)) {
      return c.json({ success: false, error: 'streamUrl must start with http(s)://' }, 400);
    }

    const reqRow = await pool.query(
      `SELECT * FROM venue_station_requests WHERE id::text = $1`,
      [id]
    );
    if (reqRow.rowCount === 0) {
      return c.json({ success: false, error: 'Request not found' }, 404);
    }
    const req = reqRow.rows[0];

    const code = newPairingCode();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const ins = await pool.query(
      `INSERT INTO venue_station_streams
         (request_id, user_id, venue_id, location_id, stream_url, vps_host,
          bearer_token_id, pairing_code, pairing_expires_at, status,
          gemini_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'provisioned', $10::jsonb)
       RETURNING *`,
      [
        req.id, req.user_id, req.venue_id, locationId, streamUrl,
        vpsHost, bearerTokenId, code, expires,
        geminiConfig ? JSON.stringify(geminiConfig) : null,
      ]
    );

    const upd = await pool.query(
      `UPDATE venue_station_requests
          SET status         = 'provisioned',
              provisioned_at = NOW(),
              monthly_price  = $2,
              updated_at     = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.id, monthlyPrice]
    );

    // ── 14-дневный бесплатный триал стартует с момента провижининга ──
    // Пишем venue_radio_subscriptions строкой status='active' (без нового
    // enum-значения → без риска CHECK), plan_id='trial', +14 дней. stream-token
    // пускает active+период → эфир играет сразу; по истечении доступ гаснет
    // по дате, дальше нужен платный абонемент. Идемпотентно: только если у
    // заведения ещё нет живой подписки (active с непросроченным периодом).
    try {
      await pool.query(
        `INSERT INTO venue_radio_subscriptions
           (venue_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
         SELECT $1, 'trial', 'active', NOW(), NOW() + INTERVAL '14 days', NOW(), NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM venue_radio_subscriptions
             WHERE venue_id = $1
               AND status = 'active'
               AND (current_period_end IS NULL OR current_period_end > NOW())
          )`,
        [req.venue_id]
      );
    } catch (trialErr: any) {
      // Триал best-effort: не валим провижининг, если подписочная таблица
      // недоступна — админ соберёт станцию, триал можно завести отдельно.
      console.error('[venue-station] trial start failed:', trialErr?.message);
    }

    // Notify venue with the pairing code — this is the critical
    // moment in the funnel: admin's done, venue sees the code in
    // their inbox and in the cabinet at the same time.
    loadVenueContact(req.user_id).then((contact) => {
      if (contact) {
        return sendVenueRadioReadyEmail({
          toEmail: contact.email,
          venueName: contact.name,
          pairingCode: code,
        });
      }
    }).catch((err) => console.error('[venue-station] ready email failed:', err?.message));

    return c.json({
      success: true,
      request: rowToRequest(upd.rows[0]),
      stream: rowToStream(ins.rows[0], true),
    });
  } catch (error: any) {
    console.error('POST /venue-station/admin/:requestId/provision:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

app.post('/admin/streams/:streamId/pause', requireAuth, requireAdmin, async (c) => {
  return setStreamStatus(c, 'paused');
});

app.post('/admin/streams/:streamId/resume', requireAuth, requireAdmin, async (c) => {
  return setStreamStatus(c, 'live');
});

app.post('/admin/streams/:streamId/mark-live', requireAuth, requireAdmin, async (c) => {
  // Idempotent: also stamps the request's live_at on first transition.
  return setStreamStatus(c, 'live', true);
});

async function setStreamStatus(c: any, status: string, stampLiveOnRequest = false) {
  try {
    const id = c.req.param('streamId');
    const r = await pool.query(
      `UPDATE venue_station_streams
          SET status = $1, updated_at = NOW(),
              last_seen_at = CASE WHEN $1 = 'live' THEN NOW() ELSE last_seen_at END
        WHERE id::text = $2
        RETURNING *`,
      [status, id]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Stream not found' }, 404);
    }
    if (stampLiveOnRequest && r.rows[0].request_id) {
      await pool.query(
        `UPDATE venue_station_requests
            SET status   = 'live',
                live_at  = COALESCE(live_at, NOW()),
                updated_at = NOW()
          WHERE id = $1`,
        [r.rows[0].request_id]
      );
    }
    return c.json({ success: true, stream: rowToStream(r.rows[0], true) });
  } catch (error: any) {
    console.error('setStreamStatus error:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
}

// ──────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINT — APK pairing (no auth, single-use code)
// ──────────────────────────────────────────────────────────────────

// POST /pair {code, deviceInfo?}
// Returns the stream URL + bearer token + branding snapshot the APK
// needs to render and play. Code is single-use; subsequent attempts
// against the same code return 410.
app.post('/pair', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const rawCode = String(body.code || '').trim().toUpperCase();
    if (!rawCode) {
      return c.json({ success: false, error: 'code is required' }, 400);
    }
    // Accept both "ABC-DEF" and "ABCDEF" inputs; normalise to dashed.
    const code = rawCode.length === 6 && !rawCode.includes('-')
      ? `${rawCode.slice(0, 3)}-${rawCode.slice(3)}`
      : rawCode;

    const r = await pool.query(
      `SELECT * FROM venue_station_streams
        WHERE pairing_code = $1`,
      [code]
    );
    if (r.rowCount === 0) {
      return c.json({ success: false, error: 'Code not found' }, 404);
    }
    const stream = r.rows[0];
    if (stream.paired_at) {
      return c.json({ success: false, error: 'Code already used' }, 410);
    }
    if (stream.pairing_expires_at && new Date(stream.pairing_expires_at).getTime() < Date.now()) {
      return c.json({ success: false, error: 'Code expired' }, 410);
    }

    // Mark paired + record device info.
    const deviceInfo = body.deviceInfo && typeof body.deviceInfo === 'object' ? body.deviceInfo : {};
    await pool.query(
      `UPDATE venue_station_streams
          SET paired_at           = NOW(),
              paired_device_info  = $1::jsonb,
              last_seen_at        = NOW(),
              updated_at          = NOW()
        WHERE id = $2`,
      [JSON.stringify(deviceInfo), stream.id]
    );

    // Fetch the bearer token plaintext-equivalent identifier so APK
    // can authenticate to /venue-public/* in subsequent calls. We DO
    // NOT have the plaintext anymore (only the SHA-256 hash) — the
    // admin had to supply the bearer at provision time. The token row
    // tracked by `bearer_token_id` is what the APK uses, so we just
    // return its prefix + venue_id. APK consumes /venue-public/me
    // with the bearer it was given OUT-OF-BAND if needed.
    //
    // For the MVP we return enough to bootstrap the APK; the admin
    // workflow can choose to embed the bearer directly in `streamUrl`
    // (e.g. as a query param) when provisioning.
    return c.json({
      success: true,
      streamUrl: stream.stream_url,
      venueId: stream.venue_id,
      streamId: stream.id,
      // Optional branding hint so APK can render splash before its
      // first /venue-branding/public call.
      brandingHint: {
        // Filled by the cabinet branding section; if absent the APK
        // falls back to platform defaults.
      },
    });
  } catch (error: any) {
    console.error('POST /venue-station/pair:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// Best-effort admin notification (replaces a TODO when an admin
// messaging table exists). For the MVP just logs — wire to email
// or the in-app inbox in a follow-up.
// ──────────────────────────────────────────────────────────────────
async function notifyAdminNewRequest(profile: any, requestRow: any) {
  // Была заглушка: писала в консоль, письма не уходили — админ не видел заявок
  // (владелец 2026-08-07). Теперь реальное письмо на info@.
  console.info('[venue-station] new request', {
    venueId: profile.id,
    venueName: profile.venueName || profile.name,
    requestId: requestRow.id,
  });
  try {
    const { notifyVenueRequest } = await import('./email-helper.tsx');
    await notifyVenueRequest({
      venueName: profile.venueName || profile.name || 'заведение',
      venueCity: profile.city,
      stationId: String(requestRow.id),
      stationName: requestRow.station_name || requestRow.stationName,
    });
  } catch (e: any) {
    console.error('[venue-station] admin email failed:', e?.message || e);
  }
}

export default app;
