/**
 * PAYMENTS ROUTES - API роуты для системы платежей
 * Все данные хранятся в PostgreSQL через typed stores (db.tsx)
 */

import { Hono } from 'hono';
import {
  getPaymentBalance, upsertPaymentBalance, accountingStore,
  paymentTransactionsStore, paymentWithdrawalsStore, paymentBalancesStore,
  getPaymentMethods as dbGetPaymentMethods, upsertPaymentMethod,
} from './db.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';

const paymentsRoutes = new Hono();

// ========================================
// HELPERS - inline payments logic (using typed stores)
// ========================================

async function getTransactions(userId: string, filters: any = {}): Promise<any[]> {
  const raw = await paymentTransactionsStore.get(userId);
  let txs: any[] = raw || [];
  if (filters.type) txs = txs.filter((t: any) => t.type === filters.type);
  if (filters.category) txs = txs.filter((t: any) => t.category === filters.category);
  if (filters.status) txs = txs.filter((t: any) => t.status === filters.status);
  if (filters.search) {
    const s = filters.search.toLowerCase();
    txs = txs.filter((t: any) => t.description?.toLowerCase().includes(s));
  }
  txs.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const offset = filters.offset || 0;
  const limit = filters.limit || 50;
  return txs.slice(offset, offset + limit);
}

async function createTransaction(userId: string, type: string, category: string, amount: number, description: string, metadata?: any): Promise<string> {
  const id = `tx-${crypto.randomUUID()}`;
  const tx = { id, userId, type, category, amount, description, metadata, status: 'completed', createdAt: new Date().toISOString() };
  const raw = await paymentTransactionsStore.get(userId);
  const txs: any[] = raw || [];
  txs.push(tx);
  await paymentTransactionsStore.set(userId, txs);
  // Update balance
  const balRaw = await getPaymentBalance(userId);
  const bal = balRaw || { userId, available: 0, pending: 0, total: 0 };
  if (!bal.userId) bal.userId = userId;
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
  const raw = await paymentTransactionsStore.get(userId);
  const txs: any[] = raw || [];
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
  // Check balance
  const balRaw = await getPaymentBalance(userId);
  const bal = balRaw || { available: 0, pending: 0, total: 0, userId };
  const available = Number(bal.available) || 0;
  if (available < amount) {
    throw new Error(`Insufficient balance: ${available} RUB available, requested ${amount} RUB`);
  }
  // Deduct from available, add to pending
  bal.available = available - amount;
  bal.pending = (Number(bal.pending) || 0) + amount;
  bal.total = bal.available + bal.pending;
  await upsertPaymentBalance(userId, bal);

  const id = `wd-${crypto.randomUUID()}`;
  const req = { id, userId, amount, paymentMethodId, status: 'pending', createdAt: new Date().toISOString() };
  const raw = await paymentWithdrawalsStore.get(userId);
  const reqs: any[] = raw || [];
  reqs.push(req);
  await paymentWithdrawalsStore.set(userId, reqs);
  return id;
}

async function getWithdrawRequests(userId: string, status?: string): Promise<any[]> {
  const raw = await paymentWithdrawalsStore.get(userId);
  let reqs: any[] = raw || [];
  if (status) reqs = reqs.filter((r: any) => r.status === status);
  return reqs;
}

async function getCategoryStats(userId: string, type: string, period: string): Promise<any[]> {
  const raw = await paymentTransactionsStore.get(userId);
  const txs: any[] = raw || [];
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
paymentsRoutes.get('/admin/transactions', requireAuth, requireAdmin, async (c) => {
  try {
    const filters = {
      type: c.req.query('type') as any,
      category: c.req.query('category') as any,
      status: c.req.query('status') as any,
      search: c.req.query('search'),
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : 100,
      offset: c.req.query('offset') ? parseInt(c.req.query('offset')!) : 0,
    };
    // Собираем транзакции всех пользователей
    const allTxItems = await paymentTransactionsStore.getAll();
    let allTxs: any[] = [];
    for (const item of allTxItems) {
      try {
        if (Array.isArray(item)) {
          allTxs.push(...item);
        }
      } catch { /* skip */ }
    }
    // Фильтрация
    if (filters.type) allTxs = allTxs.filter((t: any) => t.type === filters.type);
    if (filters.category) allTxs = allTxs.filter((t: any) => t.category === filters.category);
    if (filters.status) allTxs = allTxs.filter((t: any) => t.status === filters.status);
    if (filters.search) {
      const s = filters.search.toLowerCase();
      allTxs = allTxs.filter((t: any) => t.description?.toLowerCase().includes(s) || t.userId?.toLowerCase().includes(s));
    }
    allTxs.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const total = allTxs.length;
    const data = allTxs.slice(filters.offset, filters.offset + filters.limit);
    return c.json({ success: true, data, total });
  } catch (error: any) {
    console.error('Error in GET /payments/admin/transactions:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/users - Все пользователи с балансами (для админки)
 */
paymentsRoutes.get('/admin/users', requireAuth, requireAdmin, async (c) => {
  try {
    // Get all balance records
    const allBalances = await paymentBalancesStore.getAll();
    const users: any[] = [];
    for (const balance of allBalances) {
      if (!balance || typeof balance !== 'object') continue;
      const userId = balance.userId;
      if (!userId) continue;
      // Получить транзакции для подсчёта статистики
      const txs: any[] = (await paymentTransactionsStore.get(userId)) || [];
      const totalEarned = txs.filter((t: any) => t.type === 'income' || t.type === 'donation' || t.type === 'commission').reduce((s: number, t: any) => s + t.amount, 0);
      const totalSpent = txs.filter((t: any) => t.type === 'expense' || t.type === 'withdrawal').reduce((s: number, t: any) => s + t.amount, 0);
      const lastTx = txs.length > 0 ? txs.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] : null;
      users.push({
        id: userId,
        name: lastTx?.userName || userId,
        email: `${userId}@promo.music`,
        balance: balance.available || 0,
        totalSpent,
        totalEarned,
        transactionsCount: txs.length,
        lastTransaction: lastTx?.createdAt || null,
        status: 'active',
      });
    }
    return c.json({ success: true, data: users });
  } catch (error: any) {
    console.error('Error in GET /payments/admin/users:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/stats - Общая финансовая статистика платформы
 */
paymentsRoutes.get('/admin/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const allTxItems = await paymentTransactionsStore.getAll();
    let allTxs: any[] = [];
    for (const item of allTxItems) {
      try {
        if (Array.isArray(item)) allTxs.push(...item);
      } catch { /* skip */ }
    }
    const totalIncome = allTxs.filter((t: any) => t.type === 'income' || t.type === 'commission' || t.type === 'donation').reduce((s: number, t: any) => s + t.amount, 0);
    const totalExpense = allTxs.filter((t: any) => t.type === 'expense' || t.type === 'withdrawal').reduce((s: number, t: any) => s + t.amount, 0);
    const totalRefund = allTxs.filter((t: any) => t.type === 'refund').reduce((s: number, t: any) => s + t.amount, 0);
    const pendingCount = allTxs.filter((t: any) => t.status === 'pending').length;
    
    // category breakdown
    const catMap = new Map<string, number>();
    for (const t of allTxs) {
      catMap.set(t.category, (catMap.get(t.category) || 0) + t.amount);
    }
    const categoryBreakdown = Array.from(catMap.entries()).map(([category, total]) => ({ category, total }));
    
    // monthly trend (last 6 months)
    const monthlyTrend: any[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthStr = d.toISOString().slice(0, 7);
      const monthTxs = allTxs.filter((t: any) => t.createdAt?.startsWith(monthStr));
      const income = monthTxs.filter((t: any) => t.type === 'income' || t.type === 'commission').reduce((s: number, t: any) => s + t.amount, 0);
      const expense = monthTxs.filter((t: any) => t.type === 'expense' || t.type === 'withdrawal').reduce((s: number, t: any) => s + t.amount, 0);
      monthlyTrend.push({ month: monthStr, income, expense, net: income - expense });
    }
    
    return c.json({
      success: true,
      data: {
        totalIncome,
        totalExpense,
        totalRefund,
        netBalance: totalIncome - totalExpense - totalRefund,
        transactionCount: allTxs.length,
        pendingCount,
        categoryBreakdown,
        monthlyTrend,
      }
    });
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
    const raw = await accountingStore.get('accounting:reports');
    const reports: any[] = raw || [];
    const statusFilter = c.req.query('status');
    const typeFilter = c.req.query('type');
    const periodFilter = c.req.query('taxPeriod');
    let filtered = reports;
    if (statusFilter && statusFilter !== 'all') filtered = filtered.filter((r: any) => r.status === statusFilter);
    if (typeFilter && typeFilter !== 'all') filtered = filtered.filter((r: any) => r.type === typeFilter);
    if (periodFilter && periodFilter !== 'all') filtered = filtered.filter((r: any) => r.taxPeriod === periodFilter);
    filtered.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ success: true, data: filtered });
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
    const report = {
      id,
      ...body,
      status: body.status || 'draft',
      createdAt: new Date().toISOString(),
    };
    const raw = await accountingStore.get('accounting:reports');
    const reports: any[] = raw || [];
    reports.push(report);
    await accountingStore.set('accounting:reports', reports);
    return c.json({ success: true, data: report });
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
    const reportId = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const raw = await accountingStore.get('accounting:reports');
    const reports: any[] = raw || [];
    const idx = reports.findIndex((r: any) => r.id === reportId);
    if (idx === -1) return c.json({ error: 'Report not found' }, 404);
    reports[idx] = { ...reports[idx], ...body, updatedAt: new Date().toISOString() };
    if (body.status === 'sent' && !reports[idx].sentAt) reports[idx].sentAt = new Date().toISOString();
    if (body.status === 'accepted' && !reports[idx].acceptedAt) reports[idx].acceptedAt = new Date().toISOString();
    await accountingStore.set('accounting:reports', reports);
    return c.json({ success: true, data: reports[idx] });
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
    const reportId = parseInt(c.req.param('id'));
    const raw = await accountingStore.get('accounting:reports');
    const reports: any[] = raw || [];
    const filtered = reports.filter((r: any) => r.id !== reportId);
    await accountingStore.set('accounting:reports', filtered);
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
    const raw = await accountingStore.get('accounting:documents');
    const docs: any[] = raw || [];
    const search = c.req.query('search')?.toLowerCase();
    let filtered = docs;
    if (search) {
      filtered = filtered.filter((d: any) =>
        d.number?.toLowerCase().includes(search) ||
        d.counterparty?.toLowerCase().includes(search) ||
        d.description?.toLowerCase().includes(search)
      );
    }
    filtered.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return c.json({ success: true, data: filtered });
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
    const doc = { id, ...body, status: body.status || 'draft', date: body.date || new Date().toISOString().split('T')[0] };
    const raw = await accountingStore.get('accounting:documents');
    const docs: any[] = raw || [];
    docs.push(doc);
    await accountingStore.set('accounting:documents', docs);
    return c.json({ success: true, data: doc });
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
    const docId = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const raw = await accountingStore.get('accounting:documents');
    const docs: any[] = raw || [];
    const idx = docs.findIndex((d: any) => d.id === docId);
    if (idx === -1) return c.json({ error: 'Document not found' }, 404);
    docs[idx] = { ...docs[idx], ...body };
    if (body.status === 'paid' && !docs[idx].paidAt) docs[idx].paidAt = new Date().toISOString().split('T')[0];
    await accountingStore.set('accounting:documents', docs);
    return c.json({ success: true, data: docs[idx] });
  } catch (error: any) {
    console.error('Error in PUT /admin/accounting/documents/:id:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

/**
 * GET /admin/accounting/ledger - Бухгалтерские проводки
 */
paymentsRoutes.get('/admin/accounting/ledger', requireAuth, requireAdmin, async (c) => {
  try {
    const raw = await accountingStore.get('accounting:ledger');
    const entries: any[] = raw || [];
    entries.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return c.json({ success: true, data: entries });
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
    const entry = { id, ...body, date: body.date || new Date().toISOString().split('T')[0] };
    const raw = await accountingStore.get('accounting:ledger');
    const entries: any[] = raw || [];
    entries.push(entry);
    await accountingStore.set('accounting:ledger', entries);
    return c.json({ success: true, data: entry });
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
    const raw = await accountingStore.get('accounting:counterparties');
    const cps: any[] = raw || [];
    const search = c.req.query('search')?.toLowerCase();
    let filtered = cps;
    if (search) {
      filtered = filtered.filter((cp: any) =>
        cp.name?.toLowerCase().includes(search) ||
        cp.inn?.includes(search) ||
        cp.email?.toLowerCase().includes(search)
      );
    }
    return c.json({ success: true, data: filtered });
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
    const cp = { id, ...body, status: body.status || 'active', lastActivityDate: new Date().toISOString().split('T')[0] };
    const raw = await accountingStore.get('accounting:counterparties');
    const cps: any[] = raw || [];
    cps.push(cp);
    await accountingStore.set('accounting:counterparties', cps);
    return c.json({ success: true, data: cp });
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
    const cpId = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const raw = await accountingStore.get('accounting:counterparties');
    const cps: any[] = raw || [];
    const idx = cps.findIndex((cp: any) => cp.id === cpId);
    if (idx === -1) return c.json({ error: 'Counterparty not found' }, 404);
    cps[idx] = { ...cps[idx], ...body, lastActivityDate: new Date().toISOString().split('T')[0] };
    await accountingStore.set('accounting:counterparties', cps);
    return c.json({ success: true, data: cps[idx] });
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
    const raw = await accountingStore.get('accounting:calendar');
    const events: any[] = raw || [];
    events.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return c.json({ success: true, data: events });
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
    const event = { id, ...body, completed: body.completed || false };
    const raw = await accountingStore.get('accounting:calendar');
    const events: any[] = raw || [];
    events.push(event);
    await accountingStore.set('accounting:calendar', events);
    return c.json({ success: true, data: event });
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
    const eventId = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const raw = await accountingStore.get('accounting:calendar');
    const events: any[] = raw || [];
    const idx = events.findIndex((e: any) => e.id === eventId);
    if (idx === -1) return c.json({ error: 'Calendar event not found' }, 404);
    events[idx] = { ...events[idx], ...body };
    await accountingStore.set('accounting:calendar', events);
    return c.json({ success: true, data: events[idx] });
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
    const [reportsRaw, docsRaw, calendarRaw] = await Promise.all([
      accountingStore.get('accounting:reports'),
      accountingStore.get('accounting:documents'),
      accountingStore.get('accounting:calendar'),
    ]);
    const reports: any[] = reportsRaw || [];
    const docs: any[] = docsRaw || [];
    const calendar: any[] = calendarRaw || [];

    const totalTaxPaid = reports
      .filter((r: any) => r.status === 'accepted' || r.status === 'sent')
      .reduce((s: number, r: any) => s + (r.taxAmount || 0), 0);
    const pendingTax = reports
      .filter((r: any) => r.status === 'ready' || r.status === 'draft')
      .reduce((s: number, r: any) => s + (r.taxAmount || 0), 0);
    const totalDocsPaid = docs
      .filter((d: any) => d.status === 'paid')
      .reduce((s: number, d: any) => s + (d.amount || 0), 0);
    const totalVAT = docs
      .filter((d: any) => d.status === 'paid')
      .reduce((s: number, d: any) => s + (d.vatAmount || 0), 0);
    const pendingPayments = docs
      .filter((d: any) => d.status === 'issued')
      .reduce((s: number, d: any) => s + (d.amount || 0), 0);
    const upcomingDeadlines = calendar
      .filter((e: any) => !e.completed && new Date(e.date) > new Date())
      .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .slice(0, 5);

    return c.json({
      success: true,
      data: {
        totalTaxPaid,
        pendingTax,
        totalDocsPaid,
        totalVAT,
        pendingPayments,
        upcomingDeadlines,
        reportsCount: reports.length,
        documentsCount: docs.length,
        calendarEventsCount: calendar.length,
      }
    });
  } catch (error: any) {
    console.error('Error in GET /admin/accounting/summary:', error);
    return c.json({ error: safeErrorMessage(error) }, 500);
  }
});

export default paymentsRoutes;
