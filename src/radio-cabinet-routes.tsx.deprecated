/**
 * RADIO CABINET ROUTES — финансы и операции для radio_station role
 *
 * Mount: /server/api/radio-cabinet
 *
 * Endpoints:
 *   GET  /finance/withdrawals    — список заявок на вывод
 *   POST /finance/withdrawals    — создать заявку (мин 500 ₽, проверка баланса)
 *
 * Хранение: payment_withdrawals (user_id = `radio:${stationId}`)
 */

import { Hono } from 'hono';
import { requireAuth, requireRole } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

function radioUserKey(stationId: string): string {
  return `radio:${stationId}`;
}

async function getRadioWithdrawals(stationId: string): Promise<any[]> {
  const r = await pool.query(
    `SELECT data FROM payment_withdrawals WHERE user_id = $1`,
    [radioUserKey(stationId)]
  );
  const raw = r.rows[0]?.data;
  return Array.isArray(raw) ? raw : [];
}

async function saveRadioWithdrawals(stationId: string, list: any[]): Promise<void> {
  await pool.query(
    `INSERT INTO payment_withdrawals (user_id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [radioUserKey(stationId), JSON.stringify(list)]
  );
}

async function getRadioBalance(stationId: string): Promise<number> {
  let balance = 0;
  try {
    const r = await pool.query(`SELECT data FROM radio_finance WHERE radio_id = $1`, [stationId]);
    const data: any = r.rows[0]?.data || {};
    balance = Number(data?.availableBalance ?? data?.balance ?? data?.totalRevenue ?? 0);
  } catch {}

  const wds = await getRadioWithdrawals(stationId);
  const reserved = wds
    .filter((w: any) => w?.status !== 'rejected' && w?.status !== 'cancelled')
    .reduce((s: number, w: any) => s + (Number(w?.amount) || 0), 0);

  return Math.max(0, balance - reserved);
}

// ── GET /finance/withdrawals ─────────────────────────────────────────────
app.get('/finance/withdrawals', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const stationId = c.get('userId');
    const list = await getRadioWithdrawals(stationId);
    const balance = await getRadioBalance(stationId);
    return c.json({
      success: true,
      data: list.sort((a: any, b: any) =>
        String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''))
      ),
      balance,
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ── POST /finance/withdrawals ────────────────────────────────────────────
// body: { amount: number, paymentMethod?: string, paymentDetails?: any }
// Минимум 500 ₽, проверка баланса. Без комиссии (радио — partner channel).
app.post('/finance/withdrawals', requireAuth, requireRole('radio_station'), async (c) => {
  try {
    const stationId = c.get('userId');
    const body = await c.req.json();
    const amount = Number(body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ success: false, error: 'amount must be > 0' }, 400);
    }
    if (amount < 500) {
      return c.json({ success: false, error: 'Минимальная сумма вывода — 500 ₽' }, 400);
    }

    const balance = await getRadioBalance(stationId);
    if (amount > balance) {
      return c.json({
        success: false,
        error: `Недостаточно средств. Доступно: ${balance} ₽`,
        balance,
      }, 400);
    }

    const id = `wd-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const request = {
      id,
      source: 'radio',
      stationId,
      amount,
      paymentMethod: body.paymentMethod || 'card',
      paymentDetails: body.paymentDetails || null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    const list = await getRadioWithdrawals(stationId);
    list.unshift(request);
    await saveRadioWithdrawals(stationId, list);

    return c.json({
      success: true,
      data: request,
      balance: balance - amount,
    }, 201);
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
