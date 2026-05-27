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

import { platformRevenueLogStore, paymentBalancesStore } from './db.tsx';
import { pool } from './db-client.tsx';

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
  return `${prefix}-${crypto.randomUUID()}`;
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
    // 1. Платёжный ledger — row-per-transaction (migration 037).
    // 'platform' остаётся как valid user_id (system bucket для комиссий).
    await pool.query(
      `INSERT INTO payment_transactions
         (app_id, user_id, amount, currency, tx_type, category, status,
          description, metadata, created_at)
       VALUES ($1, 'platform', $2, 'RUB', 'commission', $3, 'completed',
               $4, $5::jsonb, $6)
       ON CONFLICT (user_id, app_id) DO NOTHING`,
      [
        id,
        params.platformRevenue,
        params.channel,
        params.description,
        JSON.stringify({ ...params.metadata, grossAmount: params.grossAmount, payoutAmount: entry.payoutAmount, channel: params.channel }),
        now,
      ]
    );

    // 2. Баланс платформы — payment_balances остаётся singleton-style KV
    // (один user → один баланс), это валидный паттерн.
    const balRaw = await paymentBalancesStore.get('platform');
    const bal = (balRaw && typeof balRaw === 'object' && !Array.isArray(balRaw)) ? balRaw as any : { available: 0, pending: 0, total: 0 };
    bal.available += params.platformRevenue;
    bal.total = bal.available + bal.pending;
    await paymentBalancesStore.set('platform', bal);

    // 3. Общий реестр доходов — пока остаётся kv-array (Wave 2 будет
    // мигрировать platform_revenue_log на row-per-entry).
    const logRaw = await platformRevenueLogStore.get('singleton');
    const log: RevenueEntry[] = Array.isArray(logRaw) ? logRaw : [];
    log.push(entry);
    await platformRevenueLogStore.set('singleton', log);

    // 4. Дублирующая запись в 'marketplace' bucket для совместимости
    // с legacy marketplace-Финансы вьюхами. После Wave 2 (когда
    // platform_revenue_log станет row-per-entry с category column)
    // эту вставку можно удалить — admin-Финансы будет читать оттуда.
    if (['marketplace_beat', 'marketplace_service', 'marketplace_digital'].includes(params.channel)) {
      const mAppId = `${id}-mp`;
      const subtype = params.channel.replace('marketplace_', '');
      await pool.query(
        `INSERT INTO payment_transactions
           (app_id, user_id, amount, currency, tx_type, category, status,
            description, metadata, created_at)
         VALUES ($1, 'marketplace', $2, 'RUB', $3, $4, 'completed',
                 $5, $6::jsonb, $7)
         ON CONFLICT (user_id, app_id) DO NOTHING`,
        [
          mAppId,
          params.grossAmount,
          subtype,
          params.channel,
          params.description,
          JSON.stringify({
            itemTitle: params.description,
            totalPrice: params.grossAmount,
            commission: params.platformRevenue,
            producerPayout: entry.payoutAmount,
            producerId: params.payeeId,
            producerName: params.payeeName,
            buyerId: params.payerId,
            buyerName: params.payerName,
            ...params.metadata,
          }),
          now,
        ]
      );
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