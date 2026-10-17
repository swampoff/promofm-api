/**
 * PROMO.AIR ADMIN ROUTES: раздел PROMO.AIR в админке promo-music.ru
 * (/ctrl-pm7k2f/promo-air). Монтируется на /server/api/promo-air-admin.
 *
 * Контракт: ~/Projects/promoair/notes/PLAN.md §3.6. Примеры запросов и
 * ответов: docs/PROMOAIR.md, раздел ADMIN.
 *
 * Все маршруты: requireAuth + requireAdmin (роль admin/superadmin и e-mail из
 * ADMIN_EMAILS). Каждое изменение пишется в audit_logs через logAdminAction:
 * кто (actor_id + actorEmail), кого (target_id = пользователь-заведение),
 * что, причина, было/стало.
 *
 * Список заведений строится от users.role = 'venue', а не от venue_profiles:
 * там много мусорных строк без пользователя (notes/be-venue.md §3).
 * Модерация анкет эфира и запуск потоков остаются на /api/venue-station/admin/*.
 *
 * Изменения атомарны: переход статуса аккаунта одной UPDATE-операцией с
 * условием на прежний статус (иначе 409 { error: 'conflict', status }),
 * тариф и пробный период в транзакции с блокировкой строк.
 */

import { Hono, type Context } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { logAdminAction } from './audit-helper.tsx';
import { revokeUserSessions } from './auth-security.tsx';
import { ensureVenueProfile, getVenueProfile, upsertNotification } from './db.tsx';
import { sendAccountApprovedEmail, sendAccountRejectedEmail } from './email-helper.tsx';
import { siteForUser } from './site-origin.tsx';
import { getTrialState } from './venue-trial.tsx';
import { rowToRequest, reissuePairingCode } from './venue-station-routes.tsx';
import { safeErrorMessage } from './security.tsx';
import { createLogger } from './logger.tsx';
import {
  ACCOUNT_TRANSITIONS, PLAN_ACCOUNT_STATUSES, BLOCKED_STATUSES, SUB_STATUS_SQL, VENUE_NAME_SQL, CITY_SQL,
  buildVenueFilters, decodeCursor, isUuid, pageOf, parseLimit, parsePlanAssignment, parseReason,
  parseTrialDays, planAssignmentData, subscriptionSnapshot, toAuditItem, toDevice, toPaymentItem, toStreamItem,
  toVenueRow, trialExtensionData, type AccountAction, type IdKind,
} from './promo-air-admin-helpers.tsx';

const log = createLogger('promo-air-admin');
const app = new Hono();

// Один гейт на весь раздел: новый маршрут не может остаться без проверки.
app.use('*', requireAuth, requireAdmin);

type Db = { query: (text: string, params?: any[]) => Promise<any> };

// ── SQL ──────────────────────────────────────────────────────────

// Сортировка и курсор: (created_at, id) по убыванию. Время курсора текстом с
// микросекундами в UTC, не зависит от DateStyle/TimeZone сессии.
const sortKey = (a: string) => `COALESCE(${a}.created_at, 'epoch'::timestamptz)`;
const cursorAt = (a: string) => `to_char(${sortKey(a)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// «На связи»: устройство привязано и слало сигнал в последние 3 минуты
// (приложение шлёт его раз в минуту).
const online = (a: string) => `(${a}.paired_at IS NOT NULL AND ${a}.last_seen_at > NOW() - interval '3 minutes')`;

const VENUE_ROW_SQL = `
  SELECT u.id::text                                     AS user_id,
         u.email,
         COALESCE(NULLIF(u.full_name, ''), NULLIF(u.display_name, ''), u.username) AS name,
         u.status::text                                 AS account_status,
         COALESCE(u.is_email_verified, false)           AS email_verified,
         u.created_at,
         to_jsonb(u)->>'signup_site'                    AS signup_site,   -- читается и до миграции 160
         vp.id                                          AS profile_id,
         ${VENUE_NAME_SQL}                              AS venue_name,
         COALESCE(vp.venue_type, vp.data->>'venueType', vp.data->>'type') AS venue_type,
         ${CITY_SQL}                                    AS city,
         COALESCE(vp.address, vp.data->>'address')      AS address,
         vp.data                                        AS profile_data,
         EXISTS (SELECT 1 FROM payment_methods pm
                  WHERE pm.user_id = u.id::text
                    AND COALESCE(pm.data->>'gatewayMethodId', '') <> '') AS has_card,
         req.id::text                                   AS request_id,
         req.status                                     AS request_status,
         req.format->>'airType'                         AS air_type,
         CASE WHEN jsonb_typeof(req.format->'points') = 'array'
              THEN jsonb_array_length(req.format->'points') ELSE 0 END AS request_points,
         req.created_at                                 AS request_created_at,
         COALESCE(st.total, 0)                          AS streams_total,
         COALESCE(st.online, 0)                         AS streams_online,
         st.last_seen_at                                AS streams_last_seen_at,
         ${cursorAt('u')}                               AS cursor_at,
         u.id::text                                     AS cursor_id
    FROM users u
    LEFT JOIN venue_profiles vp ON vp.user_id = u.id::text
    LEFT JOIN LATERAL (
      SELECT r.id, r.status, r.format, r.created_at
        FROM venue_station_requests r
       WHERE r.user_id = u.id::text
       ORDER BY r.created_at DESC
       LIMIT 1
    ) req ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int                               AS total,
             (count(*) FILTER (WHERE ${online('s')}))::int AS online,
             max(s.last_seen_at)                         AS last_seen_at
        FROM venue_station_streams s
       WHERE s.user_id = u.id::text
    ) st ON true
   WHERE u.role = 'venue' AND u.deleted_at IS NULL`;

// Платежи заведений: по типу сессии (подписка, проверка карты, абонемент
// эфира) и любые платежи пользователей с ролью venue (бронирования, заказы
// контента). Источник: payment_sessions (одна строка на платёж);
// payment_transactions / payment_txns повторяют те же суммы проводками.
const PAYMENT_SQL = `
  SELECT ps.id::text                                     AS id,
         ps.user_id,
         u.email,
         ps.purpose,
         ps.status,
         ps.amount,
         ps.created_at,
         COALESCE(ps.data->>'description', ps.data->'metadata'->>'description') AS description,
         ps.data->'metadata'                             AS metadata,
         ${cursorAt('ps')}                              AS cursor_at,
         ps.id::text                                     AS cursor_id
    FROM payment_sessions ps
    LEFT JOIN users u ON u.id::text = ps.user_id
   WHERE (ps.purpose = 'venue_subscription'
          OR ps.data->'metadata'->>'type' IN ('venue_card_attach', 'venue_subscription', 'venue_radio_subscription')
          OR ps.data->'metadata'->>'itemType' = 'venue_radio_subscription'
          OR u.role = 'venue')`;

// Журнал: действия админов (actor с ролью admin/superadmin) с кодами
// promoair_* / venue_* или над пользователями-заведениями (в т. ч. одобрение
// из «Заявок партнёров»).
const AUDIT_SQL = `
  SELECT a.id::text                                      AS id,
         a.created_at,
         a.action,
         a.details,
         a.target_id,
         COALESCE(a.details->>'actorEmail', au.email)    AS actor_email,
         tu.email                                        AS target_email,
         COALESCE(tvp.venue_name, tvp.data->>'venueName', NULLIF(tu.full_name, '')) AS target_name,
         ${cursorAt('a')}                               AS cursor_at,
         a.id::text                                      AS cursor_id
    FROM audit_logs a
    JOIN users au ON au.id::text = a.actor_id AND au.role::text IN ('admin', 'superadmin')  -- в enum user_role нет superadmin
    LEFT JOIN users tu ON tu.id::text = a.target_id
    LEFT JOIN venue_profiles tvp ON tvp.user_id = a.target_id`;
const AUDIT_SCOPE = `(a.action LIKE 'promoair\\_%' OR a.action LIKE 'venue\\_%' OR tu.role = 'venue')`;

// ── helpers ──────────────────────────────────────────────────────

function fail(c: Context, status: 400 | 404 | 409 | 500, error: string, extra: Record<string, unknown> = {}) {
  return c.json({ success: false, error, ...extra }, status);
}

async function readBody(c: Context): Promise<Record<string, any>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

async function inTx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function audit(c: Context, action: string, targetUserId: string | null, details: Record<string, unknown>) {
  logAdminAction(c, {
    action,
    resourceType: 'venue',
    targetId: targetUserId,
    details: { actorEmail: c.get('userEmail') || null, ...details },
  });
}

async function loadVenueRow(userId: string, db: Db = pool) {
  const r = await db.query(`${VENUE_ROW_SQL} AND u.id::text = $1`, [userId]);
  return r.rows[0] ? toVenueRow(r.rows[0]) : null;
}

/** Курсорная страница: rows отсортированы (sort, id) DESC, берётся limit + 1. null = битый курсор. */
async function keysetPage(c: Context, sql: string, alias: string, idKind: IdKind, where: string[], params: unknown[]) {
  const limit = parseLimit(c.req.query('limit'));
  const cur = decodeCursor(c.req.query('cursor'), idKind);
  if (cur.ok === false) return null;
  const w = [...where];
  const p = [...params];
  if (cur.cursor) {
    p.push(cur.cursor.at, cur.cursor.id);
    w.push(`(${sortKey(alias)}, ${alias}.id) < ($${p.length - 1}::timestamptz, $${p.length}::${idKind})`);
  }
  p.push(limit + 1);
  const r = await pool.query(
    `${sql} ${w.length ? `AND ${w.join(' AND ')}` : ''}
     ORDER BY ${sortKey(alias)} DESC, ${alias}.id DESC
     LIMIT $${p.length}`,
    p
  );
  return pageOf(r.rows, limit);
}

// ── чтение ───────────────────────────────────────────────────────

// GET /overview: счётчики для главной раздела.
app.get('/overview', async (c) => {
  try {
    const r = await pool.query(
      `WITH v AS (
         SELECT u.status::text AS account_status, ${SUB_STATUS_SQL} AS sub
           FROM users u
           LEFT JOIN venue_profiles vp ON vp.user_id = u.id::text
          WHERE u.role = 'venue' AND u.deleted_at IS NULL
       )
       SELECT (SELECT count(*) FROM v)::int                                                AS venues,
              (SELECT count(*) FROM v WHERE account_status = 'pending')::int               AS accounts_pending,
              (SELECT count(*) FROM v WHERE account_status = 'active')::int                AS accounts_active,
              (SELECT count(*) FROM v WHERE account_status = ANY($1::text[]))::int         AS accounts_blocked,
              (SELECT count(*) FROM venue_station_requests WHERE status = 'pending_admin')::int AS requests_pending,
              (SELECT count(*) FROM venue_station_requests
                WHERE status IN ('in_setup', 'changes_requested'))::int                     AS requests_in_work,
              (SELECT count(*) FROM venue_station_streams WHERE status <> 'dead')::int      AS streams,
              (SELECT count(*) FROM venue_station_streams s
                WHERE s.status <> 'dead' AND ${online('s')})::int                           AS streams_online,
              (SELECT count(*) FROM v WHERE sub = 'pending_card')::int                     AS subs_pending_card,
              (SELECT count(*) FROM v WHERE sub = 'trial')::int                            AS subs_trial,
              (SELECT count(*) FROM v WHERE sub = 'active')::int                           AS subs_active,
              (SELECT count(*) FROM v WHERE sub = 'cancelled')::int                        AS subs_cancelled,
              (SELECT count(*) FROM v WHERE sub = 'expired')::int                          AS subs_expired`,
      [[...BLOCKED_STATUSES]]
    );
    const x = r.rows[0];
    return c.json({
      success: true,
      counts: {
        venues: x.venues,
        accountsPending: x.accounts_pending,
        accountsActive: x.accounts_active,
        accountsBlocked: x.accounts_blocked,
        requestsPending: x.requests_pending,
        requestsInWork: x.requests_in_work,
        streams: x.streams,
        streamsOnline: x.streams_online,
        subsPendingCard: x.subs_pending_card,
        subsTrial: x.subs_trial,
        subsActive: x.subs_active,
        subsCancelled: x.subs_cancelled,
        subsExpired: x.subs_expired,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    log.error({ err: error?.message }, 'overview_failed');
    return fail(c, 500, safeErrorMessage(error));
  }
});

// GET /venues?q=&status=&plan=&city=&sub=&cursor=&limit=
app.get('/venues', async (c) => {
  try {
    const f = buildVenueFilters(c.req.query(), 1);
    if (f.ok === false) return fail(c, 400, 'invalid_filter', { field: f.field, message: f.message });
    const page = await keysetPage(c, VENUE_ROW_SQL, 'u', 'uuid', f.where, f.params);
    if (!page) return fail(c, 400, 'invalid_cursor');
    const now = Date.now();
    return c.json({ success: true, items: page.rows.map((r: any) => toVenueRow(r, now)), nextCursor: page.nextCursor });
  } catch (error: any) {
    log.error({ err: error?.message }, 'venues_failed');
    return fail(c, 500, safeErrorMessage(error));
  }
});

// GET /venues/:userId: карточка заведения.
app.get('/venues/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
    if (!isUuid(userId)) return fail(c, 404, 'not_found');
    const row = await loadVenueRow(userId);
    if (!row) return fail(c, 404, 'not_found');
    const [profile, req, streams, payments, auditRows] = await Promise.all([
      getVenueProfile(userId),
      pool.query(
        `SELECT * FROM venue_station_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      ),
      pool.query(
        `SELECT s.*, ${online('s')} AS online
           FROM venue_station_streams s
          WHERE s.user_id = $1
          ORDER BY s.created_at ASC`,
        [userId]
      ),
      pool.query(`${PAYMENT_SQL} AND ps.user_id = $1 ORDER BY ${sortKey('ps')} DESC, ps.id DESC LIMIT 50`, [userId]),
      pool.query(`${AUDIT_SQL} WHERE a.target_id = $1 ORDER BY ${sortKey('a')} DESC, a.id DESC LIMIT 50`, [userId]),
    ]);
    return c.json({
      success: true,
      row,
      profile: profile || null,
      request: req.rows[0] ? rowToRequest(req.rows[0]) : null,
      streams: streams.rows.map(toStreamItem),
      payments: payments.rows.map(toPaymentItem),
      audit: auditRows.rows.map(toAuditItem),
    });
  } catch (error: any) {
    log.error({ err: error?.message }, 'venue_detail_failed');
    return fail(c, 500, safeErrorMessage(error));
  }
});

// GET /payments?cursor=&limit=
app.get('/payments', async (c) => {
  try {
    const page = await keysetPage(c, PAYMENT_SQL, 'ps', 'uuid', [], []);
    if (!page) return fail(c, 400, 'invalid_cursor');
    return c.json({ success: true, items: page.rows.map(toPaymentItem), nextCursor: page.nextCursor });
  } catch (error: any) {
    log.error({ err: error?.message }, 'payments_failed');
    return fail(c, 500, safeErrorMessage(error));
  }
});

// GET /devices: все потоки заведений; device = null, пока код не введён.
app.get('/devices', async (c) => {
  try {
    const r = await pool.query(
      `SELECT s.id::text AS stream_id, s.user_id, s.point_name, s.status, s.paired_at, s.last_seen_at,
              s.paired_device_info, ${online('s')} AS online,
              COALESCE(vp.venue_name, vp.data->>'venueName', NULLIF(u.full_name, ''), u.email) AS venue_name
         FROM venue_station_streams s
         LEFT JOIN venue_profiles vp ON vp.user_id = s.user_id
         LEFT JOIN users u ON u.id::text = s.user_id
        ORDER BY ${online('s')} DESC, s.last_seen_at DESC NULLS LAST, s.created_at DESC
        LIMIT 500`
    );
    return c.json({
      success: true,
      items: r.rows.map((s: any) => ({
        streamId: s.stream_id,
        userId: s.user_id,
        venueName: s.venue_name || null,
        pointName: s.point_name || null,
        status: s.status,
        pairedAt: s.paired_at ? new Date(s.paired_at).toISOString() : null,
        lastSeenAt: s.last_seen_at ? new Date(s.last_seen_at).toISOString() : null,
        online: !!s.online,
        device: toDevice(s.paired_device_info, s.paired_at),
      })),
    });
  } catch (error: any) {
    log.error({ err: error?.message }, 'devices_failed');
    return fail(c, 500, safeErrorMessage(error));
  }
});

// GET /audit?cursor=&limit=
app.get('/audit', async (c) => {
  try {
    const page = await keysetPage(c, `${AUDIT_SQL} WHERE ${AUDIT_SCOPE}`, 'a', 'bigint', [], []);
    if (!page) return fail(c, 400, 'invalid_cursor');
    return c.json({ success: true, items: page.rows.map(toAuditItem), nextCursor: page.nextCursor });
  } catch (error: any) {
    log.error({ err: error?.message }, 'audit_failed');
    return fail(c, 500, safeErrorMessage(error));
  }
});

// ── статус аккаунта: approve / reject / block / restore ─────────

type Transition =
  | { ok: true; user: { id: string; email: string; name: string | null; prev_status: string; signup_site: string | null } }
  | { ok: false; code: 404 }
  | { ok: false; code: 409; status: string };

/**
 * Переход статуса одной операцией: строка блокируется (FOR UPDATE в CTE) и
 * меняется, только если прежний статус допустим для действия. Иначе 409
 * с текущим статусом (или 404, если это не заведение).
 */
async function transitionAccount(db: Db, userId: string, action: AccountAction): Promise<Transition> {
  const t = ACCOUNT_TRANSITIONS[action];
  const r = await db.query(
    `WITH prev AS (
       SELECT id, status::text AS prev_status
         FROM users
        WHERE id::text = $1 AND role = 'venue' AND deleted_at IS NULL
        FOR UPDATE
     )
     UPDATE users u
        SET status = $3::user_status
       FROM prev
      WHERE u.id = prev.id AND prev.prev_status = ANY($2::text[])
     RETURNING u.id::text AS id, u.email, COALESCE(NULLIF(u.full_name, ''), u.username) AS name,
               prev.prev_status, to_jsonb(u)->>'signup_site' AS signup_site`,
    [userId, [...t.from], t.to]
  );
  if (r.rows[0]) return { ok: true, user: r.rows[0] };
  const cur = await db.query(
    `SELECT status::text AS status FROM users WHERE id::text = $1 AND role = 'venue' AND deleted_at IS NULL`,
    [userId]
  );
  if (!cur.rows[0]) return { ok: false, code: 404 };
  return { ok: false, code: 409, status: cur.rows[0].status };
}

/**
 * Блокировка отрезает доступ целиком: сессии (тот же путь, что бан в админке
 * пользователей), потоки на паузу (как при истечении подписки, markVenueExpired)
 * и API-ключи заведения (Bearer-доступ статус аккаунта не проверяет).
 * Восстановление потоки и ключи не возвращает: потоки админ включает сам
 * (/venue-station/admin/streams/:id/resume), ключи заведение выпускает заново.
 */
async function cutVenueAccess(db: Db, userId: string) {
  await revokeUserSessions(userId, db);
  const paused = await db.query(
    `UPDATE venue_station_streams
        SET status = 'paused', updated_at = NOW()
      WHERE user_id = $1 AND status IN ('provisioned', 'live')
      RETURNING id::text AS id`,
    [userId]
  );
  const tokens = await db.query(
    `UPDATE venue_api_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return { pausedStreamIds: paused.rows.map((x: any) => x.id), revokedApiTokens: tokens.rowCount || 0 };
}

const ACCOUNT_AUDIT: Record<AccountAction, string> = {
  approve: 'promoair_venue_approve',
  reject: 'promoair_venue_reject',
  block: 'promoair_venue_block',
  restore: 'promoair_venue_restore',
};

// Письмо и уведомление в кабинете после одобрения / отказа. Письмо ведёт на
// сайт заведения (siteForUser: PROMO.AIR при включённом гейте), хотя админ
// работает на promo-music.ru. Сбой почты не отменяет действие.
function notifyAccountDecision(action: AccountAction, userId: string, user: { email: string; name: string | null; signup_site: string | null }, reason: string | null) {
  if (action !== 'approve' && action !== 'reject') return;
  const site = siteForUser({ role: 'venue', signup_site: user.signup_site });
  const send = action === 'approve'
    ? sendAccountApprovedEmail(user.email, user.name || '', site)
    : sendAccountRejectedEmail(user.email, user.name || '', reason || '', site);
  send.catch((e: any) => log.warn({ err: e?.message, userId, action }, 'account_decision_email_failed'));
  const notifId = `notif_${action === 'approve' ? 'approved' : 'rejected'}_${Date.now()}`;
  upsertNotification(userId, notifId, {
    id: notifId, userId, type: 'info',
    title: action === 'approve' ? 'Аккаунт одобрен!' : 'Заявка отклонена',
    message: action === 'approve' ? 'Ваша заявка одобрена.' : (reason ? `Причина: ${reason}` : 'Заявка отклонена.'),
    read: false, createdAt: new Date().toISOString(),
  }).catch((e: any) => log.warn({ err: e?.message, userId, action }, 'account_decision_notification_failed'));
}

async function handleAccountAction(c: Context, action: AccountAction) {
  try {
    const userId = c.req.param('userId');
    if (!isUuid(userId)) return fail(c, 404, 'not_found');
    const body = await readBody(c);
    const reason = parseReason(body.reason, action === 'reject' || action === 'block');
    if (!reason.ok) return fail(c, 400, 'reason_required', { message: 'Укажите причину.' });

    const out = await inTx(async (db) => {
      const t = await transitionAccount(db, userId, action);
      if (!t.ok) return { t, cut: null };
      return { t, cut: action === 'block' ? await cutVenueAccess(db, userId) : null };
    });
    const t = out.t;
    if (t.ok === false) {
      if (t.code === 404) return fail(c, 404, 'not_found');
      return fail(c, 409, 'conflict', { status: t.status, kind: 'account' });
    }

    audit(c, ACCOUNT_AUDIT[action], userId, {
      reason: reason.reason,
      before: { accountStatus: t.user.prev_status },
      after: { accountStatus: ACCOUNT_TRANSITIONS[action].to },
      ...(out.cut || {}),
    });
    notifyAccountDecision(action, userId, t.user, reason.reason);
    return c.json({ success: true, row: await loadVenueRow(userId), ...(out.cut || {}) });
  } catch (error: any) {
    log.error({ err: error?.message, action }, 'account_action_failed');
    // До миграции 162 в enum user_status нет 'rejected' (22P02).
    if (action === 'reject' && error?.code === '22P02') {
      return fail(c, 500, 'migration_required', { message: 'Отказ пока не сохраняется: на сервере не применена миграция 162 (статус rejected).' });
    }
    return fail(c, 500, safeErrorMessage(error));
  }
}

app.post('/venues/:userId/approve', (c) => handleAccountAction(c, 'approve'));
app.post('/venues/:userId/reject', (c) => handleAccountAction(c, 'reject'));
app.post('/venues/:userId/block', (c) => handleAccountAction(c, 'block'));
app.post('/venues/:userId/restore', (c) => handleAccountAction(c, 'restore'));

// ── тариф и пробный период ──────────────────────────────────────

/**
 * Пользователь-заведение под блокировкой строки (чтобы блокировка аккаунта
 * не шла параллельно с назначением тарифа) и его venue_profiles.data, тоже
 * FOR UPDATE. null = не заведение.
 */
async function lockVenueForBilling(db: Db, userId: string) {
  const u = await db.query(
    `SELECT status::text AS status FROM users
      WHERE id::text = $1 AND role = 'venue' AND deleted_at IS NULL
      FOR UPDATE`,
    [userId]
  );
  if (!u.rows[0]) return null;
  const p = await db.query(`SELECT data FROM venue_profiles WHERE user_id = $1 FOR UPDATE`, [userId]);
  return { accountStatus: u.rows[0].status as string, hasProfile: !!p.rows[0], data: p.rows[0]?.data || {} };
}

// POST /venues/:userId/plan {plan, status, until, reason, interval?}: тариф
// без списания. Пишет те же поля venue_profiles.data, что читают биллинг и
// кроны (venue-billing-routes, venue-trial), платежей не создаёт.
app.post('/venues/:userId/plan', async (c) => {
  try {
    const userId = c.req.param('userId');
    if (!isUuid(userId)) return fail(c, 404, 'not_found');
    const body = await readBody(c);
    const reason = parseReason(body.reason, true);
    if (!reason.ok) return fail(c, 400, 'reason_required', { message: 'Укажите причину.' });
    const nowMs = Date.now();
    const input = parsePlanAssignment(body, nowMs);
    if (input.ok === false) return fail(c, 400, 'invalid_input', { field: input.field, message: input.message });

    // Заготовка профиля для заведения, которое ещё не открывало кабинет
    // (тот же создатель, что у кабинета; он же пишет админу «новое заведение»).
    const venue = await pool.query(
      `SELECT 1 FROM users WHERE id::text = $1 AND role = 'venue' AND deleted_at IS NULL`,
      [userId]
    );
    if (!venue.rowCount || !(await ensureVenueProfile(userId))) return fail(c, 404, 'not_found');

    const out = await inTx(async (db) => {
      const v = await lockVenueForBilling(db, userId);
      if (!v || !v.hasProfile) return { code: 404 as const };
      if (!PLAN_ACCOUNT_STATUSES.includes(v.accountStatus)) return { code: 409 as const, status: v.accountStatus };
      const next = planAssignmentData(v.data, input.value, new Date(nowMs).toISOString());
      await db.query(
        `UPDATE venue_profiles SET data = $2::jsonb, updated_at = NOW() WHERE user_id = $1`,
        [userId, JSON.stringify(next)]
      );
      // Доступ снова есть: потоки с паузы, как после оплаты (checkout-routes,
      // ветка venue_subscription).
      const resumed = await db.query(
        `UPDATE venue_station_streams SET status = 'provisioned', updated_at = NOW()
          WHERE user_id = $1 AND status = 'paused'
          RETURNING id::text AS id`,
        [userId]
      );
      return { code: 200 as const, before: subscriptionSnapshot(v.data), after: subscriptionSnapshot(next), resumedStreamIds: resumed.rows.map((x: any) => x.id) };
    });
    if (out.code === 404) return fail(c, 404, 'not_found');
    if (out.code === 409) return fail(c, 409, 'conflict', { status: out.status, kind: 'account' });

    audit(c, 'promoair_plan_assign', userId, {
      reason: reason.reason,
      before: out.before,
      after: out.after,
      resumedStreamIds: out.resumedStreamIds,
    });
    return c.json({ success: true, row: await loadVenueRow(userId), resumedStreamIds: out.resumedStreamIds });
  } catch (error: any) {
    log.error({ err: error?.message }, 'plan_assign_failed');
    return fail(c, 500, safeErrorMessage(error));
  }
});

// POST /venues/:userId/trial-extend {days: 1..60, reason}: только для
// подписки в статусе trial (иначе 409 со статусом подписки).
app.post('/venues/:userId/trial-extend', async (c) => {
  try {
    const userId = c.req.param('userId');
    if (!isUuid(userId)) return fail(c, 404, 'not_found');
    const body = await readBody(c);
    const reason = parseReason(body.reason, true);
    if (!reason.ok) return fail(c, 400, 'reason_required', { message: 'Укажите причину.' });
    const days = parseTrialDays(body.days);
    if (!days) return fail(c, 400, 'invalid_input', { field: 'days', message: 'Продление: целое число дней от 1 до 60.' });

    const nowMs = Date.now();
    const out = await inTx(async (db) => {
      const v = await lockVenueForBilling(db, userId);
      if (!v) return { code: 404 as const };
      if (!PLAN_ACCOUNT_STATUSES.includes(v.accountStatus)) return { code: 409 as const, status: v.accountStatus, kind: 'account' };
      const subStatus = String(v.data.subscriptionStatus || 'pending_card');
      if (subStatus !== 'trial') return { code: 409 as const, status: subStatus, kind: 'subscription' };
      // Текущий конец пробного так же, как его видит крон (venue-trial.tsx).
      const end = getTrialState({ subscriptionStatus: 'trial', createdAt: v.data.createdAt, data: v.data }).expiresAtIso;
      const ext = trialExtensionData(v.data, end ? Date.parse(end) : NaN, days, nowMs);
      await db.query(
        `UPDATE venue_profiles SET data = $2::jsonb, updated_at = NOW() WHERE user_id = $1`,
        [userId, JSON.stringify(ext.next)]
      );
      return { code: 200 as const, beforeIso: ext.beforeIso, afterIso: ext.afterIso };
    });
    if (out.code === 404) return fail(c, 404, 'not_found');
    if (out.code === 409) return fail(c, 409, 'conflict', { status: out.status, kind: out.kind });

    audit(c, 'promoair_trial_extend', userId, {
      reason: reason.reason,
      days,
      before: { trialExpiresAt: out.beforeIso },
      after: { trialExpiresAt: out.afterIso },
    });
    return c.json({ success: true, row: await loadVenueRow(userId) });
  } catch (error: any) {
    log.error({ err: error?.message }, 'trial_extend_failed');
    return fail(c, 500, safeErrorMessage(error));
  }
});

// ── устройства ───────────────────────────────────────────────────

// POST /streams/:streamId/regenerate-pairing: новый код подключения на 24 часа,
// старое устройство отвязывается. Допустимо в любом статусе потока (как в
// кабинете), поэтому без 409. Код в журнал не пишется.
app.post('/streams/:streamId/regenerate-pairing', async (c) => {
  try {
    const streamId = c.req.param('streamId');
    if (!isUuid(streamId)) return fail(c, 404, 'not_found');
    const prev = await pool.query(
      `SELECT paired_at FROM venue_station_streams WHERE id::text = $1`,
      [streamId]
    );
    const row = await reissuePairingCode(streamId);
    if (!row) return fail(c, 404, 'not_found');
    const pairingExpiresAt = row.pairing_expires_at ? new Date(row.pairing_expires_at).toISOString() : null;
    audit(c, 'promoair_pairing_regenerate', row.user_id ? String(row.user_id) : null, {
      streamId,
      pointName: row.point_name || null,
      before: { paired: !!prev.rows[0]?.paired_at },
      after: { paired: false, pairingExpiresAt },
    });
    return c.json({ success: true, streamId, pairingCode: row.pairing_code, pairingExpiresAt });
  } catch (error: any) {
    log.error({ err: error?.message }, 'regenerate_pairing_failed');
    return fail(c, 500, safeErrorMessage(error));
  }
});

export default app;
