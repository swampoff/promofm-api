/**
 * PAYMENTS ROUTES - API роуты для системы платежей
 * Все данные хранятся в PostgreSQL через typed stores (db.tsx)
 */

import { Hono } from 'hono';
import {
  getPaymentBalance, upsertPaymentBalance, debitAvailableToPendingAtomic,
  getPaymentMethods as dbGetPaymentMethods, upsertPaymentMethod,
  insertPaymentTx, getPaymentTxsByUser, getAllPaymentTxs, getPaymentTxStats, getPaymentTxUserSummaries,
} from './db.tsx';
import { pool } from './db-client.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';

const paymentsRoutes = new Hono();

// ========================================
// HELPERS - inline payments logic (using typed stores)
// ========================================

async function getTransactions(userId: string, filters: any = {}): Promise<any[]> {
  return getPaymentTxsByUser(userId, {
    type: filters.type,
    category: filters.category,
    status: filters.status,
    search: filters.search,
    limit: filters.limit || 50,
    offset: filters.offset || 0,
  });
}

async function createTransaction(userId: string, type: string, category: string, amount: number, description: string, metadata?: any): Promise<string> {
  const id = `tx-${crypto.randomUUID()}`;
  await insertPaymentTx({ id, userId, type, category, amount, description, metadata, status: 'completed', createdAt: new Date().toISOString() });
  // Update balance
  const balRaw = await getPaymentBalance(userId);
  // getPaymentBalance union: { available, pending, total } | { userId, available, pending, total }.
  // Нормализуем сразу до второго варианта (с userId), убираем TS2339.
  const bal: { userId: string; available: number; pending: number; total: number } =
    balRaw
      ? { userId, ...balRaw }
      : { userId, available: 0, pending: 0, total: 0 };
  bal.available = Number(bal.available) || 0;
  bal.pending = Number(bal.pending) || 0;
  if (type === 'income' || type === 'donation') bal.available += Number(amount);
  else if (type === 'expense' || type === 'withdrawal') bal.available -= Number(amount);
  bal.total = bal.available + bal.pending;
  await upsertPaymentBalance(userId, bal);
  return id;
}

async function getUserBalance(userId: string): Promise<any> {
  const raw = await getPaymentBalance(userId);
  return raw || { available: 0, pending: 0, total: 0, currency: 'RUB' };
}

async function getUserStats(userId: string): Promise<any> {
  const txs: any[] = await getPaymentTxsByUser(userId);
  const totalIncome = txs.filter((t: any) => t.type === 'income' || t.type === 'donation').reduce((s: number, t: any) => s + t.amount, 0);
  const totalExpense = txs.filter((t: any) => t.type === 'expense' || t.type === 'withdrawal').reduce((s: number, t: any) => s + t.amount, 0);
  return { totalIncome, totalExpense, transactionCount: txs.length, netBalance: totalIncome - totalExpense };
}

async function getPaymentMethodsList(userId: string): Promise<any[]> {
  return await dbGetPaymentMethods(userId);
}

async function addPaymentMethod(userId: string, methodData: any): Promise<any> {
  const method = { id: `pm-${crypto.randomUUID()}`, ...methodData, createdAt: new Date().toISOString() };
  await upsertPaymentMethod(method.id, userId, method);
  return method;
}

async function createWithdrawRequest(userId: string, amount: number, paymentMethodId: string): Promise<string> {
  if (amount <= 0) throw new Error('Amount must be positive');
  // Atomic guarded debit: UPDATE ... WHERE available >= amount. If two concurrent
  // withdraws hit at the same time, only one passes the WHERE clause and the
  // other gets rowCount=0 here — preventing the negative-balance race.
  const newBal = await debitAvailableToPendingAtomic(userId, amount);
  if (!newBal) {
    const current = await getPaymentBalance(userId);
    const available = current ? Number(current.available) : 0;
    throw new Error(`Insufficient balance: ${available} RUB available, requested ${amount} RUB`);
  }

  const id = `wd-${crypto.randomUUID()}`;
  // row-per-withdrawal (migration 043): INSERT — никаких race conditions.
  await (await import("./db-client.tsx")).pool.query(
    `INSERT INTO payment_withdrawals
       (app_id, user_id, amount, payment_method, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (user_id, app_id) DO NOTHING`,
    [id, userId, amount, paymentMethodId]
  );
  return id;
}

async function getWithdrawRequests(userId: string, status?: string): Promise<any[]> {
  // row-per-withdrawal: фильтр в SQL. source IS NULL = generic payments
  // (НЕ donation, НЕ radio — каждый модуль scope'ит свой source).
  const params: any[] = [userId];
  let where = `user_id = $1 AND source IS NULL`;
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  const _wq2 = await (await import("./db-client.tsx")).pool.query(
    `SELECT app_id, user_id, amount, payment_method, status,
            created_at, updated_at
       FROM payment_withdrawals
      WHERE ${where}
      ORDER BY created_at DESC`,
    params
  );
  return _wq2.rows.map((r: any) => ({
    id: r.app_id,
    userId: r.user_id,
    amount: Number(r.amount),
    paymentMethodId: r.payment_method,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

async function getCategoryStats(userId: string, type: string, period: string): Promise<any[]> {
  const txs: any[] = await getPaymentTxsByUser(userId, { type });
  const filtered = txs.filter((t: any) => t.type === type);
  const cats = new Map<string, number>();
  for (const t of filtered) {
    cats.set(t.category, (cats.get(t.category) || 0) + t.amount);
  }
  return Array.from(cats.entries()).map(([category, total]) => ({ category, total }));
}

async function syncDonationToTransaction(userId: string, donationData: any): Promise<string> {
  const txId = await createTransaction(userId, 'donation', 'donations', donationData.amount, `Донат от ${donationData.from || 'Anonymous'}`, donationData);

  // Записать доход платформы (донаты проходят через платформу, комиссия 0%)
  await recordRevenue({
    channel: 'donation',
    description: `Донат для ${userId}: от ${donationData.from || 'Anonymous'}`,
    grossAmount: donationData.amount,
    platformRevenue: 0,
    payoutAmount: donationData.amount,
    commissionRate: 0,
    payerId: donationData.from || 'anonymous',
    payerName: donationData.from || 'Анонимный',
    payeeId: userId,
    payeeName: userId,
    metadata: { donationId: txId },
  });

  return txId;
}

async function syncSubscriptionToTransaction(userId: string, subscriptionData: any): Promise<string> {
  const txId = await createTransaction(userId, 'income', 'subscriptions', subscriptionData.amount, `Подписка: ${subscriptionData.plan || 'Pro'}`, subscriptionData);

  // Записать доход платформы (подписки = 100% доход платформы)
  await recordRevenue({
    channel: 'subscription',
    description: `Подписка ${subscriptionData.plan || 'Pro'}: ${userId}`,
    grossAmount: subscriptionData.amount,
    platformRevenue: subscriptionData.amount,
    payoutAmount: 0,
    commissionRate: 1.0,
    payerId: userId,
    payerName: subscriptionData.userName || userId,
    metadata: { plan: subscriptionData.plan, subscriptionId: txId },
  });

  return txId;
}

// ========================================
// ТРАНЗАКЦИИ
// ========================================

paymentsRoutes.get('/transactions', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const filters = {
      type: c.req.query('type') as any,
      category: c.req.query('category') as any,
      status: c.req.query('status') as any,
      search: c.req.query('search'),
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : 50,
      offset: c.req.query('offset') ? parseInt(c.req.query('offset')!) : 0,
    };
    const transactions = await getTransactions(userId, filters);
    return c.json({ success: true, data: transactions });
  } catch (error: any) {
    console.error('Error in GET /payments/transactions:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

paymentsRoutes.post('/transactions', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId');
    const userRole = c.get('userRole');
    const { type, category, amount, description, metadata } = body;
    if (!type || !category || !amount || !description) {
      return c.json({ error: 'Missing required fields: type, category, amount, description' }, 400);
    }
    // Security: only admins can create income/donation transactions
    if ((type === 'income' || type === 'donation' || type === 'commission') && userRole !== 'admin') {
      return c.json({ error: 'Only expense and withdrawal transactions can be created by users' }, 403);
    }
    if (Number(amount) <= 0) {
      return c.json({ error: 'Amount must be positive' }, 400);
    }
    const transactionId = await createTransaction(userId, type, category, amount, description, metadata);
    return c.json({ success: true, data: { transaction_id: transactionId } });
  } catch (error: any) {
    console.error('Error in POST /payments/transactions:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

// ========================================
// БАЛАНС И СТАТИСТИКА
// ========================================

paymentsRoutes.get('/balance', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const balance = await getUserBalance(userId);
    return c.json({ success: true, data: balance });
  } catch (error: any) {
    console.error('Error in GET /payments/balance:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

paymentsRoutes.get('/stats', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const stats = await getUserStats(userId);
    return c.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error in GET /payments/stats:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

paymentsRoutes.get('/category-stats', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const type = c.req.query('type') as any;
    const period = (c.req.query('period') || 'month') as 'month' | 'year' | 'all';
    if (!type) return c.json({ error: 'type is required' }, 400);
    const stats = await getCategoryStats(userId, type, period);
    return c.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error in GET /payments/category-stats:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

// ========================================
// МЕТОДЫ ОПЛАТЫ
// ========================================

paymentsRoutes.get('/payment-methods', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const methods = await getPaymentMethodsList(userId);
    return c.json({ success: true, data: methods });
  } catch (error: any) {
    console.error('Error in GET /payments/payment-methods:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

paymentsRoutes.post('/payment-methods', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId');
    const methodData = body;
    if (!methodData.type) return c.json({ error: 'type is required' }, 400);
    const method = await addPaymentMethod(userId, methodData);
    return c.json({ success: true, data: method });
  } catch (error: any) {
    console.error('Error in POST /payments/payment-methods:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

// ========================================
// ВЫВОД СРЕДСТВ
// ========================================

paymentsRoutes.get('/withdrawals', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const status = c.req.query('status') as any;
    const requests = await getWithdrawRequests(userId, status);
    return c.json({ success: true, data: requests });
  } catch (error: any) {
    console.error('Error in GET /payments/withdrawals:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

paymentsRoutes.post('/withdrawals', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId');
    const { amount, payment_method_id } = body;
    if (!amount || !payment_method_id) {
      return c.json({ error: 'Missing required fields: amount, payment_method_id' }, 400);
    }
    const requestId = await createWithdrawRequest(userId, amount, payment_method_id);
    return c.json({ success: true, data: { request_id: requestId } });
  } catch (error: any) {
    console.error('Error in POST /payments/withdrawals:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

// ========================================
// СИНХРОНИЗАЦИЯ
// ========================================

paymentsRoutes.post('/sync/donation', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId');
    const { donation_data } = body;
    if (!donation_data) return c.json({ error: 'donation_data is required' }, 400);
    const transactionId = await syncDonationToTransaction(userId, donation_data);
    return c.json({ success: true, data: { transaction_id: transactionId } });
  } catch (error: any) {
    console.error('Error in POST /payments/sync/donation:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

paymentsRoutes.post('/sync/subscription', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId');
    const { subscription_data } = body;
    if (!subscription_data) return c.json({ error: 'subscription_data is required' }, 400);
    const transactionId = await syncSubscriptionToTransaction(userId, subscription_data);
    return c.json({ success: true, data: { transaction_id: transactionId } });
  } catch (error: any) {
    console.error('Error in POST /payments/sync/subscription:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

// ========================================
// WEBHOOK
// ========================================

// Webhook endpoint removed — real webhooks are in checkout-routes.tsx (no auth required)

// ========================================
// ADMIN ENDPOINTS
// ========================================

/**
 * GET /admin/transactions - Все транзакции всех пользователей (для админки)
 */
// ========================================
// ADMIN ROUTES (SQL-based, no KV stores)
// ========================================

/**
 * GET /admin/transactions - All transactions (platform-wide, SQL-based)
 */
paymentsRoutes.get('/admin/transactions', requireAuth, requireAdmin, async (c) => {
  try {
    const filters = {
      type: c.req.query('type') || undefined,
      category: c.req.query('category') || undefined,
      status: c.req.query('status') || undefined,
      search: c.req.query('search') || undefined,
      limit: parseInt(c.req.query('limit') || '100'),
      offset: parseInt(c.req.query('offset') || '0'),
    };
    const { txs, total } = await getAllPaymentTxs(filters);
    return c.json({ success: true, data: txs, total });
  } catch (error: any) {
    console.error('Error in GET /payments/admin/transactions:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/users - All users with balances (SQL-based)
 */
paymentsRoutes.get('/admin/users', requireAuth, requireAdmin, async (c) => {
  try {
    const summaries = await getPaymentTxUserSummaries();
    return c.json({ success: true, data: summaries });
  } catch (error: any) {
    console.error('Error in GET /payments/admin/users:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/stats - Platform financial stats (SQL-based)
 */
paymentsRoutes.get('/admin/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const stats = await getPaymentTxStats();
    return c.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error in GET /payments/admin/stats:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

// ========================================
// ADMIN - ACCOUNTING ENDPOINTS
// ========================================

/**
 * GET /admin/accounting/reports - Все налоговые отчёты
 */
paymentsRoutes.get('/admin/accounting/reports', requireAuth, requireAdmin, async (c) => {
  try {
    const statusFilter = c.req.query('status');
    const typeFilter = c.req.query('type');
    const periodFilter = c.req.query('taxPeriod');
    const where: string[] = [];
    const params: any[] = [];
    if (statusFilter && statusFilter !== 'all') { params.push(statusFilter); where.push(`status = $${params.length}`); }
    if (typeFilter && typeFilter !== 'all') { params.push(typeFilter); where.push(`report_type = $${params.length}`); }
    if (periodFilter && periodFilter !== 'all') { params.push(periodFilter); where.push(`tax_period = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT id, report_type AS type, tax_period AS "taxPeriod", status, tax_amount AS "taxAmount",
              extra, sent_at AS "sentAt", accepted_at AS "acceptedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM accounting_reports
         ${whereSql}
         ORDER BY created_at DESC`,
      params,
    );
    // Spread extra (residual jsonb fields) onto each row for API compat.
    const data = rows.map((r: any) => ({ ...r.extra, ...r, extra: undefined }));
    return c.json({ success: true, data });
  } catch (error: any) {
    console.error('Error in GET /admin/accounting/reports:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /admin/accounting/reports - Создать налоговый отчёт
 */
paymentsRoutes.post('/admin/accounting/reports', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const id = crypto.randomUUID();
    const extra = { ...body };
    ['id', 'type', 'taxPeriod', 'status', 'taxAmount', 'sentAt', 'acceptedAt', 'createdAt', 'updatedAt'].forEach(k => delete extra[k]);
    const { rows } = await pool.query(
      `INSERT INTO accounting_reports
         (id, report_type, tax_period, status, tax_amount, extra)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, report_type AS type, tax_period AS "taxPeriod", status,
                 tax_amount AS "taxAmount", extra,
                 sent_at AS "sentAt", accepted_at AS "acceptedAt",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        id,
        body.type || null,
        body.taxPeriod || null,
        body.status || 'draft',
        Number(body.taxAmount || 0),
        JSON.stringify(extra),
      ],
    );
    const r = rows[0];
    return c.json({ success: true, data: { ...r.extra, ...r, extra: undefined } });
  } catch (error: any) {
    console.error('Error in POST /admin/accounting/reports:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * PUT /admin/accounting/reports/:id - Обновить отчёт (статус, отправка и т.д.)
 */
paymentsRoutes.put('/admin/accounting/reports/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const reportId = c.req.param('id'); // string id (UUID); фикс legacy parseInt() bug
    const body = await c.req.json();
    // Atomic UPDATE с COALESCE — обновляем только переданные поля.
    // sent_at / accepted_at автоматически выставляются при status transition.
    const { rows } = await pool.query(
      `UPDATE accounting_reports SET
         report_type = COALESCE($2, report_type),
         tax_period  = COALESCE($3, tax_period),
         status      = COALESCE($4, status),
         tax_amount  = COALESCE($5, tax_amount),
         sent_at     = CASE WHEN $4 = 'sent' AND sent_at IS NULL THEN NOW() ELSE sent_at END,
         accepted_at = CASE WHEN $4 = 'accepted' AND accepted_at IS NULL THEN NOW() ELSE accepted_at END,
         updated_at  = NOW()
       WHERE id = $1
       RETURNING id, report_type AS type, tax_period AS "taxPeriod", status,
                 tax_amount AS "taxAmount", extra,
                 sent_at AS "sentAt", accepted_at AS "acceptedAt",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        reportId,
        body.type ?? null,
        body.taxPeriod ?? null,
        body.status ?? null,
        body.taxAmount !== undefined ? Number(body.taxAmount) : null,
      ],
    );
    if (rows.length === 0) return c.json({ error: 'Report not found' }, 404);
    const r = rows[0];
    return c.json({ success: true, data: { ...r.extra, ...r, extra: undefined } });
  } catch (error: any) {
    console.error('Error in PUT /admin/accounting/reports/:id:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * DELETE /admin/accounting/reports/:id - Удалить отчёт
 */
paymentsRoutes.delete('/admin/accounting/reports/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const reportId = c.req.param('id'); // string id; фикс legacy parseInt() bug
    const r = await pool.query(`DELETE FROM accounting_reports WHERE id = $1`, [reportId]);
    if (r.rowCount === 0) return c.json({ error: 'Report not found' }, 404);
    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error in DELETE /admin/accounting/reports/:id:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/accounting/documents - Все первичные документы
 */
paymentsRoutes.get('/admin/accounting/documents', requireAuth, requireAdmin, async (c) => {
  try {
    const search = c.req.query('search');
    let whereSql = '';
    const params: any[] = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      whereSql = `WHERE LOWER(doc_number) LIKE $1 OR LOWER(counterparty) LIKE $1 OR LOWER(description) LIKE $1`;
    }
    const { rows } = await pool.query(
      `SELECT id, doc_number AS number, counterparty, description, doc_date AS date,
              amount, vat_amount AS "vatAmount", doc_type AS type, status,
              paid_at AS "paidAt", extra,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM accounting_documents
         ${whereSql}
         ORDER BY doc_date DESC NULLS LAST`,
      params,
    );
    const data = rows.map((r: any) => ({ ...r.extra, ...r, extra: undefined }));
    return c.json({ success: true, data });
  } catch (error: any) {
    console.error('Error in GET /admin/accounting/documents:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /admin/accounting/documents - Создать документ
 */
paymentsRoutes.post('/admin/accounting/documents', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const id = crypto.randomUUID();
    const extra = { ...body };
    ['id', 'number', 'counterparty', 'description', 'date', 'amount', 'vatAmount',
     'type', 'status', 'paidAt', 'createdAt', 'updatedAt'].forEach(k => delete extra[k]);
    const { rows } = await pool.query(
      `INSERT INTO accounting_documents
         (id, doc_number, counterparty, description, doc_date, amount,
          vat_amount, doc_type, status, paid_at, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING id, doc_number AS number, counterparty, description, doc_date AS date,
                 amount, vat_amount AS "vatAmount", doc_type AS type, status,
                 paid_at AS "paidAt", extra,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        id,
        body.number || null,
        body.counterparty || null,
        body.description || null,
        body.date || new Date().toISOString().split('T')[0],
        Number(body.amount || 0),
        Number(body.vatAmount || 0),
        body.type || null,
        body.status || 'draft',
        body.paidAt || null,
        JSON.stringify(extra),
      ],
    );
    const r = rows[0];
    return c.json({ success: true, data: { ...r.extra, ...r, extra: undefined } });
  } catch (error: any) {
    console.error('Error in POST /admin/accounting/documents:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * PUT /admin/accounting/documents/:id - Обновить документ
 */
paymentsRoutes.put('/admin/accounting/documents/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const docId = c.req.param('id'); // string id; фикс legacy parseInt() bug
    const body = await c.req.json();
    const { rows } = await pool.query(
      `UPDATE accounting_documents SET
         doc_number   = COALESCE($2, doc_number),
         counterparty = COALESCE($3, counterparty),
         description  = COALESCE($4, description),
         doc_date     = COALESCE($5::date, doc_date),
         amount       = COALESCE($6, amount),
         vat_amount   = COALESCE($7, vat_amount),
         doc_type     = COALESCE($8, doc_type),
         status       = COALESCE($9, status),
         paid_at      = CASE WHEN $9 = 'paid' AND paid_at IS NULL THEN CURRENT_DATE
                             ELSE COALESCE($10::date, paid_at) END,
         updated_at   = NOW()
       WHERE id = $1
       RETURNING id, doc_number AS number, counterparty, description, doc_date AS date,
                 amount, vat_amount AS "vatAmount", doc_type AS type, status,
                 paid_at AS "paidAt", extra,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        docId,
        body.number ?? null,
        body.counterparty ?? null,
        body.description ?? null,
        body.date ?? null,
        body.amount !== undefined ? Number(body.amount) : null,
        body.vatAmount !== undefined ? Number(body.vatAmount) : null,
        body.type ?? null,
        body.status ?? null,
        body.paidAt ?? null,
      ],
    );
    if (rows.length === 0) return c.json({ error: 'Document not found' }, 404);
    const r = rows[0];
    return c.json({ success: true, data: { ...r.extra, ...r, extra: undefined } });
  } catch (error: any) {
    console.error('Error in PUT /admin/accounting/documents/:id:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/accounting/ledger - Бухгалтерские проводки
 */
/**
 * GET /admin/accounting/ledger - Бухгалтерские проводки.
 *
 * Audit 2026-06-01: раньше отдавал только содержимое accounting_ledger
 * (отдельная таблица для ручных проводок). Никаких автоматических
 * INSERT'ов на платежи не было — стол всегда пустой → бухгалтерия
 * показывала «непонятные данные и фейки» (UI fallback'ы).
 *
 * Теперь: UNION ALL манульного ledger'а + auto-derived проводок из
 * payment_transactions (реальные платежи: подписки, комиссии,
 * выплаты). Каждый payment_tx → одна проводка с debit/credit
 * выведенными из tx_type:
 *   deposit/topup/donation/commission → 51 (касса) / 90 (выручка)
 *   withdrawal/expense/payout         → 76 (расчёты) / 51 (касса)
 *   refund                            → 90 (выручка) / 51 (касса)
 *
 * Ручные записи в accounting_ledger — для корректировок, налогов и т.п.
 */
paymentsRoutes.get('/admin/accounting/ledger', requireAuth, requireAdmin, async (c) => {
  try {
    // Manual entries from accounting_ledger
    const { rows: manual } = await pool.query(
      `SELECT id, entry_date AS date, debit_account AS debit, credit_account AS credit,
              amount, description, extra,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM accounting_ledger
         ORDER BY entry_date DESC NULLS LAST`
    );
    const manualEntries = manual.map((r: any) => ({
      ...r.extra, ...r, extra: undefined, source: 'manual',
    }));

    // Auto-derived entries из payment_transactions. Лимит 1000 чтобы
    // UI не задыхался; для аудита есть фильтры в /admin/transactions.
    const { rows: auto } = await pool.query(
      `SELECT app_id        AS id,
              created_at    AS date,
              tx_type       AS tx_type,
              category      AS category,
              amount        AS amount,
              status        AS status,
              description   AS description,
              created_at    AS "createdAt"
         FROM payment_transactions
        WHERE status = 'completed'
        ORDER BY created_at DESC
        LIMIT 1000`
    );

    // Russian chart-of-accounts соответствие (упрощённое):
    //   51 — касса/банк (платформа)
    //   76 — расчёты с разными дебиторами/кредиторами (выплаты исполнителям)
    //   90 — выручка
    //   91 — прочие доходы/расходы (возвраты)
    const DEBIT_CREDIT: Record<string, { debit: string; credit: string }> = {
      deposit:    { debit: '51', credit: '90' },
      topup:      { debit: '51', credit: '90' },
      donation:   { debit: '51', credit: '90' },
      commission: { debit: '51', credit: '90' },
      withdrawal: { debit: '76', credit: '51' },
      payout:     { debit: '76', credit: '51' },
      expense:    { debit: '91', credit: '51' },
      refund:     { debit: '90', credit: '51' },
    };

    const autoEntries = auto.map((r: any) => {
      const dc = DEBIT_CREDIT[r.tx_type] || { debit: '76', credit: '51' };
      return {
        id: `auto-${r.id}`,
        date: r.date instanceof Date
          ? r.date.toISOString().slice(0, 10)
          : String(r.date).slice(0, 10),
        debit: dc.debit,
        credit: dc.credit,
        amount: Number(r.amount) || 0,
        description: r.description
          || `${r.tx_type}${r.category ? ` (${r.category})` : ''}`,
        createdAt: r.createdAt,
        source: 'payment_tx',
        txType: r.tx_type,
      };
    });

    // Merge — manual записи сначала, потом auto (по дате). Стабильная
    // сортировка по date desc.
    const all = [...manualEntries, ...autoEntries].sort((a, b) => {
      const da = String(a.date || a.createdAt || '');
      const db = String(b.date || b.createdAt || '');
      return db.localeCompare(da);
    });

    return c.json({ success: true, data: all });
  } catch (error: any) {
    console.error('Error in GET /admin/accounting/ledger:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /admin/accounting/ledger - Создать проводку
 */
paymentsRoutes.post('/admin/accounting/ledger', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const id = crypto.randomUUID();
    const extra = { ...body };
    ['id', 'date', 'debit', 'credit', 'amount', 'description', 'createdAt', 'updatedAt'].forEach(k => delete extra[k]);
    const { rows } = await pool.query(
      `INSERT INTO accounting_ledger
         (id, entry_date, debit_account, credit_account, amount, description, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, entry_date AS date, debit_account AS debit, credit_account AS credit,
                 amount, description, extra,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        id,
        body.date || new Date().toISOString().split('T')[0],
        body.debit || null,
        body.credit || null,
        Number(body.amount || 0),
        body.description || null,
        JSON.stringify(extra),
      ],
    );
    const r = rows[0];
    return c.json({ success: true, data: { ...r.extra, ...r, extra: undefined } });
  } catch (error: any) {
    console.error('Error in POST /admin/accounting/ledger:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/accounting/counterparties - Контрагенты
 */
paymentsRoutes.get('/admin/accounting/counterparties', requireAuth, requireAdmin, async (c) => {
  try {
    const search = c.req.query('search');
    let whereSql = '';
    const params: any[] = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      whereSql = `WHERE LOWER(name) LIKE $1 OR inn LIKE $1 OR LOWER(email) LIKE $1`;
    }
    const { rows } = await pool.query(
      `SELECT id, name, inn, kpp, email, address, status,
              last_activity_date AS "lastActivityDate", extra,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM accounting_counterparties
         ${whereSql}
         ORDER BY name`,
      params,
    );
    const data = rows.map((r: any) => ({ ...r.extra, ...r, extra: undefined }));
    return c.json({ success: true, data });
  } catch (error: any) {
    console.error('Error in GET /admin/accounting/counterparties:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /admin/accounting/counterparties - Создать контрагента
 */
paymentsRoutes.post('/admin/accounting/counterparties', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const id = crypto.randomUUID();
    const extra = { ...body };
    ['id', 'name', 'inn', 'kpp', 'email', 'address', 'status', 'lastActivityDate', 'createdAt', 'updatedAt'].forEach(k => delete extra[k]);
    const { rows } = await pool.query(
      `INSERT INTO accounting_counterparties
         (id, name, inn, kpp, email, address, status, last_activity_date, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8::jsonb)
       RETURNING id, name, inn, kpp, email, address, status,
                 last_activity_date AS "lastActivityDate", extra,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        id,
        body.name || null,
        body.inn || null,
        body.kpp || null,
        body.email || null,
        body.address || null,
        body.status || 'active',
        JSON.stringify(extra),
      ],
    );
    const r = rows[0];
    return c.json({ success: true, data: { ...r.extra, ...r, extra: undefined } });
  } catch (error: any) {
    console.error('Error in POST /admin/accounting/counterparties:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * PUT /admin/accounting/counterparties/:id - Обновить контрагента
 */
paymentsRoutes.put('/admin/accounting/counterparties/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const cpId = c.req.param('id'); // string id; фикс legacy parseInt() bug
    const body = await c.req.json();
    const { rows } = await pool.query(
      `UPDATE accounting_counterparties SET
         name    = COALESCE($2, name),
         inn     = COALESCE($3, inn),
         kpp     = COALESCE($4, kpp),
         email   = COALESCE($5, email),
         address = COALESCE($6, address),
         status  = COALESCE($7, status),
         last_activity_date = CURRENT_DATE,
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, inn, kpp, email, address, status,
                 last_activity_date AS "lastActivityDate", extra,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        cpId,
        body.name ?? null,
        body.inn ?? null,
        body.kpp ?? null,
        body.email ?? null,
        body.address ?? null,
        body.status ?? null,
      ],
    );
    if (rows.length === 0) return c.json({ error: 'Counterparty not found' }, 404);
    const r = rows[0];
    return c.json({ success: true, data: { ...r.extra, ...r, extra: undefined } });
  } catch (error: any) {
    console.error('Error in PUT /admin/accounting/counterparties/:id:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/accounting/calendar - Налоговый календарь
 */
paymentsRoutes.get('/admin/accounting/calendar', requireAuth, requireAdmin, async (c) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, event_date AS date, title, description, completed, extra,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM accounting_calendar
         ORDER BY event_date ASC NULLS LAST`
    );
    const data = rows.map((r: any) => ({ ...r.extra, ...r, extra: undefined }));
    return c.json({ success: true, data });
  } catch (error: any) {
    console.error('Error in GET /admin/accounting/calendar:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /admin/accounting/calendar - Создать событие
 */
paymentsRoutes.post('/admin/accounting/calendar', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const id = crypto.randomUUID();
    const extra = { ...body };
    ['id', 'date', 'title', 'description', 'completed', 'createdAt', 'updatedAt'].forEach(k => delete extra[k]);
    const { rows } = await pool.query(
      `INSERT INTO accounting_calendar
         (id, event_date, title, description, completed, extra)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, event_date AS date, title, description, completed, extra,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        id,
        body.date || null,
        body.title || null,
        body.description || null,
        !!body.completed,
        JSON.stringify(extra),
      ],
    );
    const r = rows[0];
    return c.json({ success: true, data: { ...r.extra, ...r, extra: undefined } });
  } catch (error: any) {
    console.error('Error in POST /admin/accounting/calendar:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * PUT /admin/accounting/calendar/:id - Обновить событие (toggle completed и т.д.)
 */
paymentsRoutes.put('/admin/accounting/calendar/:id', requireAuth, requireAdmin, async (c) => {
  try {
    const eventId = c.req.param('id'); // string id; фикс legacy parseInt() bug
    const body = await c.req.json();
    const { rows } = await pool.query(
      `UPDATE accounting_calendar SET
         event_date  = COALESCE($2::date, event_date),
         title       = COALESCE($3, title),
         description = COALESCE($4, description),
         completed   = COALESCE($5, completed),
         updated_at  = NOW()
       WHERE id = $1
       RETURNING id, event_date AS date, title, description, completed, extra,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        eventId,
        body.date ?? null,
        body.title ?? null,
        body.description ?? null,
        body.completed !== undefined ? !!body.completed : null,
      ],
    );
    if (rows.length === 0) return c.json({ error: 'Calendar event not found' }, 404);
    const r = rows[0];
    return c.json({ success: true, data: { ...r.extra, ...r, extra: undefined } });
  } catch (error: any) {
    console.error('Error in PUT /admin/accounting/calendar/:id:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/accounting/summary - Сводная статистика бухгалтерии
 */
paymentsRoutes.get('/admin/accounting/summary', requireAuth, requireAdmin, async (c) => {
  try {
    // SQL aggregation — взамен SELECT-all-then-JS-reduce.
    const [reportAgg, docAgg, calAgg, upcoming] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)                                                            AS count,
           COALESCE(SUM(tax_amount) FILTER (WHERE status IN ('accepted','sent')), 0) AS total_paid,
           COALESCE(SUM(tax_amount) FILTER (WHERE status IN ('ready','draft')),   0) AS pending
         FROM accounting_reports`
      ),
      pool.query(
        `SELECT
           COUNT(*)                                                  AS count,
           COALESCE(SUM(amount)     FILTER (WHERE status = 'paid'),   0) AS total_paid,
           COALESCE(SUM(vat_amount) FILTER (WHERE status = 'paid'),   0) AS total_vat,
           COALESCE(SUM(amount)     FILTER (WHERE status = 'issued'), 0) AS pending
         FROM accounting_documents`
      ),
      pool.query(`SELECT COUNT(*) AS count FROM accounting_calendar`),
      pool.query(
        `SELECT id, event_date AS date, title, description, completed
           FROM accounting_calendar
          WHERE completed = FALSE AND event_date > CURRENT_DATE
          ORDER BY event_date ASC
          LIMIT 5`
      ),
    ]);
    const reps = reportAgg.rows[0] || {};
    const ds   = docAgg.rows[0] || {};
    const cs   = calAgg.rows[0] || {};
    return c.json({
      success: true,
      data: {
        totalTaxPaid:        Number(reps.total_paid || 0),
        pendingTax:          Number(reps.pending || 0),
        totalDocsPaid:       Number(ds.total_paid || 0),
        totalVAT:            Number(ds.total_vat || 0),
        pendingPayments:     Number(ds.pending || 0),
        upcomingDeadlines:   upcoming.rows,
        reportsCount:        Number(reps.count || 0),
        documentsCount:      Number(ds.count || 0),
        calendarEventsCount: Number(cs.count || 0),
      }
    });
  } catch (error: any) {
    console.error('Error in GET /admin/accounting/summary:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * POST /admin/payments/:orderId/refund — универсальный admin refund.
 *
 * Покрывает 9 paid-product типов которые НЕ имели specific refund route:
 *   - track_publish      (артист оплатил публикацию → отмена)
 *   - dj_mix_publish     (DJ оплатил публикацию микса → отмена)
 *   - distribution_order (артист оплатил distribution → DSP отказал)
 *   - content_order      (заказ контента → отмена)
 *   - venue_radio_subscription (venue передумал → pro-rata)
 *   - banner_publish     (баннерная кампания → admin рефанд)
 *   - production_360_payment
 *   - donation / topup   (admin может рефаднуть по запросу)
 *   - любой другой по orderId
 *
 * Specific refund routes (marketplace beat/digital, booking, radio reject)
 * НЕ покрываются этим endpoint'ом — они имеют свою бизнес-логику
 * (snapshot purchase, cancel campaign, etc.) и должны идти через
 * специальные ручки.
 *
 * Что делает:
 *   1. Lookup payment_session по orderId
 *   2. yk.refund() с idempotenceKey + shopId hint (если migration 100
 *      применена)
 *   3. UPDATE payment_session.status='refunded', payment_session.data
 *      обогащается refund metadata
 *   4. Запись в platform_revenue_log с типом 'refund' (отрицательная
 *      сумма для accounting)
 *   5. SSE userId о возврате
 *
 * Что НЕ делает (admin manual):
 *   - НЕ откатывает product status (track moderation_status, dj_mix
 *     status, distribution status и т.д.) — это admin делает руками
 *     через type-specific endpoint'ы. Причина: разные типы имеют разный
 *     workflow (трек после рефанда может остаться 'rejected' для history,
 *     dj_mix → 'rejected' если уже approved + paid, distribution →
 *     'cancelled' и т.д.). Универсальное решение «всё в rejected» сломало
 *     бы accounting/SSE flows.
 *   - НЕ возвращает coins за topup (если topup рефандится, coins не
 *     отнимаются автоматически — admin должен это сделать через
 *     coins-routes manually). Reverse операция на coins-counter без
 *     escrow → потенциальный отрицательный balance.
 *
 * Body: { amount?, reason }
 *   - amount: опциональный partial refund. По умолчанию — полная сумма
 *     payment_session.amount.
 *   - reason: обязательный, идёт в YK metadata + ledger.
 *
 * Idempotency: idempotenceKey = `refund-${orderId}` — повторный вызов
 * с тем же orderId не делает второй refund (YooKassa дедуп + status
 * check ниже).
 */
paymentsRoutes.post('/admin/payments/:orderId/refund', requireAuth, requireAdmin, async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const adminId = c.get('userId') as string;
    const body = await c.req.json().catch(() => ({}));
    const reason = String(body.reason || '').trim().slice(0, 250);
    const partialAmount = Number(body.amount);

    if (!orderId) {
      return c.json({ success: false, error: 'orderId обязателен' }, 400);
    }
    if (!reason) {
      return c.json({ success: false, error: 'reason обязателен' }, 400);
    }

    // 1. Lookup payment session
    const { getPaymentSession } = await import('./db.tsx');
    const session = await getPaymentSession(orderId) as any;
    if (!session) {
      return c.json({ success: false, error: 'Payment session не найдена' }, 404);
    }
    if (session.status === 'refunded') {
      return c.json({
        success: false,
        error: 'Платёж уже возвращён',
        data: { refundId: session.refundId, refundedAt: session.refundedAt },
      }, 409);
    }
    if (!session.gatewayPaymentId) {
      return c.json({ success: false, error: 'gatewayPaymentId не сохранён — рефанд через YooKassa-дашборд' }, 422);
    }
    if (session.gateway !== 'yookassa') {
      return c.json({ success: false, error: `Gateway ${session.gateway} не поддерживается auto-refund'ом` }, 501);
    }

    // 2. Refund via YooKassa
    const refundAmount = Number.isFinite(partialAmount) && partialAmount > 0
      ? Math.min(partialAmount, Number(session.amount))
      : Number(session.amount);

    const { YooKassaGateway } = await import('./gateway-yookassa.tsx');
    const yk = new YooKassaGateway();
    let refund: any;
    try {
      refund = await yk.refund(session.gatewayPaymentId, refundAmount, {
        description: `Возврат ${session.purpose || session.type || 'платежа'} #${orderId}${reason ? ': ' + reason : ''}`.slice(0, 250),
        idempotenceKey: `refund-${orderId}`,
        metadata: { orderId, refundedBy: adminId, reason },
        // shopId hint — graceful когда PR #184 (yookassa dual-creds bridge)
        // мержится: type там расширяется, тут уже передаём. До merge'а #184
        // — `as any` молча проигнорирует параметр.
        ...({ shopId: session.shop_id || session.shopId } as any),
      });
    } catch (refundErr: any) {
      console.error('[admin/payments/refund] yk.refund failed:', refundErr?.message);
      return c.json({
        success: false,
        error: 'YooKassa отклонила refund: ' + (refundErr?.message || 'unknown'),
      }, 502);
    }

    // 3. Mark session as refunded
    const refundedAt = new Date().toISOString();
    const { upsertPaymentSession } = await import('./db.tsx');
    await upsertPaymentSession(orderId, {
      ...session,
      status: 'refunded',
      refundId: refund.id,
      refundedAt,
      refundedBy: adminId,
      refundReason: reason,
      refundAmount,
    });

    // 4. Platform-revenue ledger — отрицательная запись для accounting
    try {
      const { recordRevenue } = await import('./platform-revenue.tsx');
      await recordRevenue({
        userId: session.userId,
        type: 'refund',
        gross: -refundAmount,
        commission: 0,
        net: -refundAmount,
        description: `Admin refund ${session.purpose || session.type}: ${reason}`,
        metadata: { orderId, refundId: refund.id, originalGateway: session.gateway, originalAmount: session.amount, refundedBy: adminId },
      } as any).catch(() => {});
    } catch {}

    // 5. SSE user
    try {
      const { emitSSE } = await import('./sse-routes.tsx');
      emitSSE(session.userId, {
        type: 'payment_refunded',
        data: {
          title: 'Возврат средств',
          message: `Платёж на ${refundAmount.toLocaleString('ru-RU')} ₽ возвращён${reason ? ': ' + reason : ''}`,
          orderId, refundId: refund.id, amount: refundAmount,
        },
      });
    } catch {}

    return c.json({
      success: true,
      data: { orderId, refundId: refund.id, amount: refundAmount, status: refund.status },
    });
  } catch (error: any) {
    console.error('POST /admin/payments/:orderId/refund error:', error);
    return c.json({ success: false, error: 'Ошибка возврата' }, 500);
  }
});

export default paymentsRoutes;
