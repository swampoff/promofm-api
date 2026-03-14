/**
 * PLATFORM REVENUE - Единый модуль записи доходов платформы
 *
 * Все финансовые события со ВСЕХ модулей (маркетплейс, букинг, радио, тест трека,
 * подписки) проходят через этот модуль и записываются в:
 *   1. payments:transactions:platform   - финансовый ledger (виден в admin «Финансы»)
 *   2. payments:balance:platform        - баланс платформы
 *   3. platform:revenue:log             - общий реестр всех доходов (для admin-дашборда)
 *
 * Категории доходов (channel):
 *   - marketplace_beat       - продажа бита (комиссия 10%)
 *   - marketplace_service    - услуга продюсера (комиссия 10%)
 *   - marketplace_digital    - цифровой товар (комиссия 10%)
 *   - dj_booking             - DJ-букинг (комиссия 10%)
 *   - dj_subscription        - DJ-подписки (комиссия 10%)
 *   - radio_venue            - реклама радио-заведение (комиссия 15%)
 *   - track_test             - тест трека (100% дохода)
 *   - subscription           - подписка (100% дохода)
 *   - donation               - донат (100% дохода, но может быть pass-through)
 *
 * Использование:
 *   import { recordRevenue, getRevenueStats } from './platform-revenue.tsx';
 *   await recordRevenue({ channel: 'dj_booking', ... });
 */

import { platformRevenueLogStore, paymentTransactionsStore, paymentBalancesStore } from './db.tsx';

export interface RevenueEntry {
  id: string;
  channel: string;
  description: string;
  grossAmount: number;       // Полная сумма сделки
  platformRevenue: number;   // Доход платформы (комиссия или полная сумма)
  payoutAmount: number;      // Выплата исполнителю (0 если 100% платформе)
  commissionRate: number;    // Ставка комиссии (0.10 = 10%)
  payerId: string;
  payerName: string;
  payeeId?: string;          // Получатель (продюсер/DJ/радио) - null если платформа
  payeeName?: string;
  metadata?: Record<string, any>;
  status: 'completed' | 'pending' | 'refunded';
  createdAt: string;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Записать доход платформы
 */
export async function recordRevenue(params: {
  channel: string;
  description: string;
  grossAmount: number;
  platformRevenue: number;
  payoutAmount?: number;
  commissionRate?: number;
  payerId: string;
  payerName: string;
  payeeId?: string;
  payeeName?: string;
  metadata?: Record<string, any>;
}): Promise<string> {
  const id = genId('rev');
  const now = nowIso();

  const entry: RevenueEntry = {
    id,
    channel: params.channel,
    description: params.description,
    grossAmount: params.grossAmount,
    platformRevenue: params.platformRevenue,
    payoutAmount: params.payoutAmount ?? (params.grossAmount - params.platformRevenue),
    commissionRate: params.commissionRate ?? (params.grossAmount > 0 ? params.platformRevenue / params.grossAmount : 0),
    payerId: params.payerId,
    payerName: params.payerName,
    payeeId: params.payeeId,
    payeeName: params.payeeName,
    metadata: params.metadata,
    status: 'completed',
    createdAt: now,
  };

  try {
    // 1. Платёжный ledger
    const txRaw = await paymentTransactionsStore.get('platform');
    const txs: any[] = Array.isArray(txRaw) ? txRaw : [];
    txs.push({
      id,
      userId: 'platform',
      type: 'commission',
      category: params.channel,
      amount: params.platformRevenue,
      description: params.description,
      metadata: { ...params.metadata, grossAmount: params.grossAmount, payoutAmount: entry.payoutAmount, channel: params.channel },
      status: 'completed',
      createdAt: now,
    });
    await paymentTransactionsStore.set('platform', txs);

    // 2. Баланс платформы
    const balRaw = await paymentBalancesStore.get('platform');
    const bal = (balRaw && typeof balRaw === 'object' && !Array.isArray(balRaw)) ? balRaw as any : { available: 0, pending: 0, total: 0 };
    bal.available += params.platformRevenue;
    bal.total = bal.available + bal.pending;
    await paymentBalancesStore.set('platform', bal);

    // 3. Общий реестр доходов
    const logRaw = await platformRevenueLogStore.get('singleton');
    const log: RevenueEntry[] = Array.isArray(logRaw) ? logRaw : [];
    log.push(entry);
    await platformRevenueLogStore.set('singleton', log);

    // 4. Также записать в marketplace:transactions для обратной совместимости (если маркетплейс)
    if (['marketplace_beat', 'marketplace_service', 'marketplace_digital'].includes(params.channel)) {
      const mRaw = await paymentTransactionsStore.get('marketplace');
      const mTxs: any[] = Array.isArray(mRaw) ? mRaw : [];
      mTxs.push({
        id,
        type: params.channel.replace('marketplace_', ''),
        itemTitle: params.description,
        totalPrice: params.grossAmount,
        commission: params.platformRevenue,
        producerPayout: entry.payoutAmount,
        producerId: params.payeeId,
        producerName: params.payeeName,
        buyerId: params.payerId,
        buyerName: params.payerName,
        status: 'completed',
        createdAt: now,
        ...params.metadata,
      });
      await paymentTransactionsStore.set('marketplace', mTxs);
    }

    console.log(`[Revenue] ${params.channel}: ${params.platformRevenue}₽ (gross ${params.grossAmount}₽)`);
  } catch (e) {
    console.log('[Revenue] recordRevenue error:', e);
  }

  return id;
}

/**
 * Агрегированная статистика доходов платформы (для admin-дашборда)
 */
export async function getRevenueStats(): Promise<{
  totalGross: number;
  totalRevenue: number;
  totalPayouts: number;
  platformBalance: number;
  transactionCount: number;
  byChannel: Array<{ channel: string; label: string; count: number; gross: number; revenue: number }>;
  recentTransactions: RevenueEntry[];
}> {
  const logRaw = await platformRevenueLogStore.get('singleton');
  const log: RevenueEntry[] = Array.isArray(logRaw) ? logRaw : [];

  const totalGross = log.reduce((s, e) => s + e.grossAmount, 0);
  const totalRevenue = log.reduce((s, e) => s + e.platformRevenue, 0);
  const totalPayouts = log.reduce((s, e) => s + e.payoutAmount, 0);

  const balRaw = await paymentBalancesStore.get('platform');
  const bal = (balRaw && typeof balRaw === 'object' && !Array.isArray(balRaw)) ? balRaw as any : { available: 0 };

  const CHANNEL_LABELS: Record<string, string> = {
    marketplace_beat: 'Биты',
    marketplace_service: 'Услуги',
    marketplace_digital: 'Цифровые товары',
    dj_booking: 'DJ-букинг',
    dj_subscription: 'DJ-подписки',
    radio_venue: 'Радио-реклама',
    track_test: 'Тест трека',
    subscription: 'Подписки',
    donation: 'Донаты',
  };

  const channelMap = new Map<string, { count: number; gross: number; revenue: number }>();
  for (const e of log) {
    const existing = channelMap.get(e.channel) || { count: 0, gross: 0, revenue: 0 };
    existing.count++;
    existing.gross += e.grossAmount;
    existing.revenue += e.platformRevenue;
    channelMap.set(e.channel, existing);
  }

  const byChannel = Array.from(channelMap.entries()).map(([channel, data]) => ({
    channel,
    label: CHANNEL_LABELS[channel] || channel,
    ...data,
  }));

  const recentTransactions = [...log]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);

  return {
    totalGross,
    totalRevenue,
    totalPayouts,
    platformBalance: bal.available || 0,
    transactionCount: log.length,
    byChannel,
    recentTransactions,
  };
}