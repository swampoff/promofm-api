/**
 * ROYALTY ROUTES — Distribution v2 Phase 6.
 *
 * Сбор и выплата роялти от DSP. Админ импортирует отчёт (royalty_statement)
 * со строками {isrc, units, gross} → matching по ISRC к release_track →
 * split по release_contributors.split_pct (payee_user_id) → royalty_lines
 * с net на каждого earner'а. Артист/DJ видит свой накопленный роялти и
 * запрашивает выплату (реюз payment_withdrawals, source='royalty').
 *
 * Mounted at /server/api/royalty. Backend Phase 6, схема — миграция 113
 * (royalty_statements / royalty_lines).
 *
 * РЕАЛЬНОСТЬ: данные роялти приходят из DSP-отчётов (CSV/DDEX DSR),
 * которые загружает админ. Автоматический pull из DSP API требует
 * партнёрского доступа — пока ручной импорт.
 */

import { Hono } from 'hono';
import { pool } from './db-client.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';
import { notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import type { DistributionDsp } from './distribution-v2-types.ts';

const app = new Hono();

// Платформенная комиссия с роялти. ДЕФОЛТ 0 (100% pass-through —
// артист получает всё что заплатил DSP). Это lever: owner выставляет
// процент когда примет решение. НЕ ставим silently >0 — деньги артиста.
const ROYALTY_PLATFORM_FEE_PCT = 0;

// Минимальная сумма к выводу (RUB).
const MIN_ROYALTY_PAYOUT_RUB = 500;

const ALLOWED_DSPS: DistributionDsp[] = ['spotify', 'apple_music', 'yandex_music', 'vk_music', 'soundcloud', 'other'];

function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }
function cleanIsrc(s: string): string { return String(s || '').replace(/-/g, '').toUpperCase(); }

// ════════════════════════════════════════════════════════════════════
// ADMIN — import / list statements
// ════════════════════════════════════════════════════════════════════

/**
 * POST /admin/statements — импорт отчёта роялти.
 * body: {
 *   targetDsp, periodStart, periodEnd, sourceFilename?,
 *   currency?, lines: [{ isrc, units?, grossAmountRub }]
 * }
 * Возвращает { statementId, matched, unmatched, totalGross, totalNet }.
 */
app.post('/admin/statements', requireAuth, requireAdmin, async (c) => {
  try {
    const adminId = String(c.get('userId') || '');
    const body = await c.req.json().catch(() => ({} as any));
    const targetDsp = String(body.targetDsp || '').toLowerCase();
    const periodStart = String(body.periodStart || '').slice(0, 10);
    const periodEnd = String(body.periodEnd || '').slice(0, 10);
    const currency = String(body.currency || 'RUB').toUpperCase().slice(0, 3);
    const lines: any[] = Array.isArray(body.lines) ? body.lines : [];

    if (!ALLOWED_DSPS.includes(targetDsp as DistributionDsp)) {
      return c.json({ success: false, error: `targetDsp: ${ALLOWED_DSPS.join('|')}` }, 400);
    }
    if (!periodStart || !periodEnd) return c.json({ success: false, error: 'periodStart/periodEnd обязательны' }, 400);
    if (lines.length === 0) return c.json({ success: false, error: 'Нет строк в отчёте' }, 400);

    const totalGross = round2(lines.reduce((s, l) => s + (Number(l.grossAmountRub) || 0), 0));

    const client = await pool.connect();
    let statementId = '';
    let matched = 0;
    let unmatched = 0;
    let totalNet = 0;
    try {
      await client.query('BEGIN');
      const st = await client.query(
        `INSERT INTO royalty_statements
           (target_dsp, period_start, period_end, source_filename, imported_by, currency, total_amount_rub, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'imported')
         RETURNING id::text AS id`,
        [targetDsp, periodStart, periodEnd, body.sourceFilename || null, adminId, currency, totalGross],
      );
      statementId = st.rows[0].id;

      for (const l of lines) {
        const isrc = cleanIsrc(l.isrc);
        const gross = round2(l.grossAmountRub);
        const units = Math.max(0, parseInt(l.units) || 0);
        const fee = round2(gross * ROYALTY_PLATFORM_FEE_PCT);
        const net = round2(gross - fee);
        if (gross <= 0) continue;

        // match by ISRC → release_track → owner
        const mt = isrc
          ? await client.query(
              `SELECT rt.id::text AS rt_id, r.user_id AS owner
                 FROM release_tracks rt JOIN releases r ON r.id = rt.release_id
                WHERE rt.isrc = $1 ORDER BY rt.updated_at DESC LIMIT 1`,
              [isrc],
            )
          : { rows: [] as any[] };

        if (mt.rows.length === 0) {
          // unmatched — admin reconciles later
          unmatched++;
          await client.query(
            `INSERT INTO royalty_lines (statement_id, release_track_id, isrc, user_id, units, gross_amount_rub, platform_fee_rub, net_amount_rub, payout_status)
             VALUES ($1, NULL, $2, NULL, $3, $4, $5, $6, 'unpaid')`,
            [statementId, isrc || null, units, gross, fee, net],
          );
          totalNet = round2(totalNet + net);
          continue;
        }

        matched++;
        const rtId = mt.rows[0].rt_id;
        const owner = mt.rows[0].owner;

        // contributor splits (payee_user_id с долей)
        const cr = await client.query(
          `SELECT payee_user_id, split_pct FROM release_contributors
            WHERE release_track_id = $1 AND payee_user_id IS NOT NULL AND split_pct > 0`,
          [rtId],
        );
        const payees = cr.rows as Array<{ payee_user_id: string; split_pct: number }>;
        const sumSplit = Math.min(100, payees.reduce((s, p) => s + (Number(p.split_pct) || 0), 0));

        let allocatedNet = 0;
        let allocatedFee = 0;
        // payee lines
        for (const p of payees) {
          const pct = Number(p.split_pct) || 0;
          const pNet = round2(net * pct / 100);
          const pFee = round2(fee * pct / 100);
          allocatedNet = round2(allocatedNet + pNet);
          allocatedFee = round2(allocatedFee + pFee);
          await client.query(
            `INSERT INTO royalty_lines (statement_id, release_track_id, isrc, user_id, units, gross_amount_rub, platform_fee_rub, net_amount_rub, payout_status)
             VALUES ($1,$2,$3,$4,0,$5,$6,$7,'unpaid')`,
            [statementId, rtId, isrc || null, p.payee_user_id, round2(gross * pct / 100), pFee, pNet],
          );
        }
        // owner remainder (units учитываются здесь, чтобы не задваивать)
        const ownerShare = 100 - sumSplit;
        if (ownerShare > 0 || payees.length === 0) {
          const oNet = payees.length === 0 ? net : round2(net - allocatedNet);
          const oFee = payees.length === 0 ? fee : round2(fee - allocatedFee);
          const oGross = round2(gross * (payees.length === 0 ? 100 : ownerShare) / 100);
          await client.query(
            `INSERT INTO royalty_lines (statement_id, release_track_id, isrc, user_id, units, gross_amount_rub, platform_fee_rub, net_amount_rub, payout_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unpaid')`,
            [statementId, rtId, isrc || null, owner, units, oGross, oFee, oNet],
          );
        }
        totalNet = round2(totalNet + net);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return c.json({ success: true, statementId, matched, unmatched, totalGross, totalNet });
  } catch (err) {
    console.error('[royalty] import error:', safeErrorMessage(err));
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// GET /admin/statements — список
app.get('/admin/statements', requireAuth, requireAdmin, async (c) => {
  try {
    const r = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM royalty_lines WHERE statement_id = s.id)::int AS line_count,
              (SELECT COUNT(*) FROM royalty_lines WHERE statement_id = s.id AND user_id IS NULL)::int AS unmatched_count
         FROM royalty_statements s ORDER BY s.created_at DESC LIMIT 200`,
    );
    return c.json({
      success: true,
      statements: r.rows.map((s: any) => ({
        id: s.id, targetDsp: s.target_dsp, periodStart: s.period_start, periodEnd: s.period_end,
        sourceFilename: s.source_filename, currency: s.currency,
        totalAmountRub: Number(s.total_amount_rub) || 0, status: s.status,
        lineCount: s.line_count, unmatchedCount: s.unmatched_count, createdAt: s.created_at,
      })),
    });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// GET /admin/statements/:id — детали + строки
app.get('/admin/statements/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const id = c.req.param('id');
    const st = await pool.query(`SELECT * FROM royalty_statements WHERE id::text = $1 LIMIT 1`, [id]);
    if (st.rows.length === 0) return c.json({ success: false, error: 'Отчёт не найден' }, 404);
    const lines = await pool.query(
      `SELECT id::text AS id, release_track_id::text AS "releaseTrackId", isrc, user_id AS "userId",
              units, gross_amount_rub AS "grossAmountRub", platform_fee_rub AS "platformFeeRub",
              net_amount_rub AS "netAmountRub", payout_status AS "payoutStatus"
         FROM royalty_lines WHERE statement_id::text = $1 ORDER BY isrc NULLS LAST LIMIT 2000`,
      [id],
    );
    const s = st.rows[0];
    return c.json({
      success: true,
      statement: {
        id: s.id, targetDsp: s.target_dsp, periodStart: s.period_start, periodEnd: s.period_end,
        currency: s.currency, totalAmountRub: Number(s.total_amount_rub) || 0, status: s.status, createdAt: s.created_at,
      },
      lines: lines.rows,
    });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// ════════════════════════════════════════════════════════════════════
// EARNER (артист/DJ) — summary / lines / payout
// ════════════════════════════════════════════════════════════════════

// GET /summary — мои накопленные роялти
app.get('/summary', requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId') || '');
    const r = await pool.query(
      `SELECT
         COALESCE(SUM(net_amount_rub) FILTER (WHERE payout_status = 'unpaid'), 0)   AS unpaid,
         COALESCE(SUM(net_amount_rub) FILTER (WHERE payout_status = 'reserved'), 0) AS reserved,
         COALESCE(SUM(net_amount_rub) FILTER (WHERE payout_status = 'paid'), 0)     AS paid,
         COALESCE(SUM(units), 0) AS total_units
       FROM royalty_lines WHERE user_id = $1`,
      [userId],
    );
    const row = r.rows[0];
    return c.json({
      success: true,
      summary: {
        unpaidRub: round2(row.unpaid),
        reservedRub: round2(row.reserved),
        paidRub: round2(row.paid),
        totalUnits: Number(row.total_units) || 0,
        minPayoutRub: MIN_ROYALTY_PAYOUT_RUB,
      },
    });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// GET /lines — мои строки роялти
app.get('/lines', requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId') || '');
    const r = await pool.query(
      `SELECT rl.id::text AS id, rl.isrc, rl.units,
              rl.gross_amount_rub AS "grossAmountRub", rl.net_amount_rub AS "netAmountRub",
              rl.payout_status AS "payoutStatus", rl.created_at AS "createdAt",
              s.target_dsp AS "targetDsp", s.period_start AS "periodStart", s.period_end AS "periodEnd"
         FROM royalty_lines rl JOIN royalty_statements s ON s.id = rl.statement_id
        WHERE rl.user_id = $1 ORDER BY rl.created_at DESC LIMIT 500`,
      [userId],
    );
    return c.json({ success: true, lines: r.rows });
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

// POST /payout — запросить выплату накопленных роялти
// body: { paymentMethod?, paymentDetails? }
app.post('/payout', requireAuth, async (c) => {
  try {
    const userId = String(c.get('userId') || '');
    const body = await c.req.json().catch(() => ({} as any));
    const paymentMethod = String(body.paymentMethod || 'card');
    const paymentDetails = body.paymentDetails || null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock unpaid lines, sum
      const sumR = await client.query(
        `SELECT COALESCE(SUM(net_amount_rub), 0) AS amount
           FROM royalty_lines WHERE user_id = $1 AND payout_status = 'unpaid' FOR UPDATE`,
        [userId],
      );
      const amount = round2(sumR.rows[0].amount);
      if (amount < MIN_ROYALTY_PAYOUT_RUB) {
        await client.query('ROLLBACK');
        return c.json({ success: false, error: `Минимальная сумма к выводу — ${MIN_ROYALTY_PAYOUT_RUB} ₽ (доступно ${amount} ₽)` }, 400);
      }
      const wdId = `wd-${crypto.randomUUID()}`;
      await client.query(
        `INSERT INTO payment_withdrawals (app_id, user_id, source, amount, payment_method, payment_details, status)
         VALUES ($1, $2, 'royalty', $3, $4, $5::jsonb, 'pending')
         ON CONFLICT (user_id, app_id) DO NOTHING`,
        [wdId, userId, amount, paymentMethod, paymentDetails ? JSON.stringify(paymentDetails) : null],
      );
      await client.query(
        `UPDATE royalty_lines SET payout_status = 'reserved', payout_withdrawal_id = $2
          WHERE user_id = $1 AND payout_status = 'unpaid'`,
        [userId, wdId],
      );
      await client.query('COMMIT');
      return c.json({ success: true, withdrawalId: wdId, amount }, 201);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[royalty] payout error:', safeErrorMessage(err));
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

// POST /admin/payouts/:withdrawalId/complete — админ отмечает выплату
// завершённой → royalty_lines reserved→paid
app.post('/admin/payouts/:withdrawalId/complete', requireAuth, requireAdmin, async (c) => {
  try {
    const wdId = c.req.param('withdrawalId');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const wd = await client.query(
        `UPDATE payment_withdrawals SET status = 'completed', updated_at = NOW()
          WHERE app_id = $1 AND source = 'royalty' AND status = 'pending'
          RETURNING user_id`,
        [wdId],
      );
      if (wd.rowCount === 0) {
        await client.query('ROLLBACK');
        return c.json({ success: false, error: 'Заявка не найдена или уже обработана' }, 404);
      }
      const userId = wd.rows[0].user_id;
      await client.query(
        `UPDATE royalty_lines SET payout_status = 'paid'
          WHERE payout_withdrawal_id = $1 AND payout_status = 'reserved'`,
        [wdId],
      );
      await client.query('COMMIT');
      notifyCrossCabinet({
        targetUserId: userId, sourceRole: 'admin', targetRole: 'artist',
        type: 'order_update', title: 'Роялти выплачены',
        message: 'Ваша заявка на вывод роялти обработана.',
        metadata: { withdrawalId: wdId },
      }).catch(() => {});
      return c.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    return c.json({ success: false, error: safeErrorMessage(err) }, 500);
  }
});

export default app;
