/**
 * YooKassa Payouts API
 *
 * Docs: https://yookassa.ru/developers/payouts/payouts-from-balance/process
 *
 * Auth: Basic <agentId:secretKey> — выплаты используют ОТДЕЛЬНЫЙ
 * agentId/secretKey, выдаваемый кабинетом ЮКассы для шопа с включённым
 * сервисом «Выплаты». Если они не заданы — падаем с понятной ошибкой.
 *
 * Поддерживаемые направления (для MVP):
 *   - sbp           → СБП по номеру телефона
 *   - yoo_money     → кошелёк ЮMoney
 *   - bank_card     → карта (требует payout_token, полученный фронтом
 *                     через yookassa-checkout-widget — НЕ хранить PAN
 *                     никогда; обработка PAN = PCI DSS на нашей стороне).
 */

const API_BASE = 'https://api.yookassa.ru/v3';

// YooKassa Payouts API response shape — те же envelope-поля что у
// /payments. TS-strict 4.7+ типизирует await response.json() как unknown.
interface YooKassaPayoutResponse {
  id?: string;
  status?: string;
  amount?: { value: string; currency: string };
  description?: string;
  message?: string;
  created_at?: string;
  payout_destination?: { type?: string };
  cancellation_details?: { party?: string; reason?: string };
}

function getPayoutCredentials() {
  const agentId = process.env.YOOKASSA_PAYOUT_AGENT_ID || process.env.YOOKASSA_SHOP_ID || '';
  const secretKey = process.env.YOOKASSA_PAYOUT_SECRET_KEY || process.env.YOOKASSA_SECRET_KEY || '';
  if (!agentId || !secretKey) {
    throw new Error('YooKassa Payouts не настроены: YOOKASSA_PAYOUT_AGENT_ID + YOOKASSA_PAYOUT_SECRET_KEY обязательны');
  }
  return { agentId, secretKey };
}

function getAuthHeader(): string {
  const { agentId, secretKey } = getPayoutCredentials();
  return 'Basic ' + btoa(`${agentId}:${secretKey}`);
}

export type PayoutDestinationType = 'sbp' | 'yoo_money' | 'bank_card';

export interface SbpDestination {
  type: 'sbp';
  phone: string;       // E.164, например +79991234567
  bankId?: string;     // опционально — bankId плательщика по СБП
}

export interface YooMoneyDestination {
  type: 'yoo_money';
  account: string;     // номер кошелька ЮMoney (15 цифр)
}

export interface BankCardDestination {
  type: 'bank_card';
  payoutToken: string; // токен карты, выданный YooKassa виджету на фронте
}

export type PayoutDestination = SbpDestination | YooMoneyDestination | BankCardDestination;

export interface CreatePayoutParams {
  amountRub: number;
  destination: PayoutDestination;
  description: string;
  idempotenceKey: string;
  metadata?: Record<string, any>;
}

export interface PayoutResult {
  id: string;
  status: 'pending' | 'succeeded' | 'canceled';
  amount: { value: string; currency: string };
  createdAt: string;
  raw: any;
}

function buildDestination(dest: PayoutDestination) {
  if (dest.type === 'sbp') {
    return {
      type: 'sbp',
      phone: dest.phone.replace(/[^\d+]/g, ''),
      ...(dest.bankId ? { bank_id: dest.bankId } : {}),
    };
  }
  if (dest.type === 'yoo_money') {
    return {
      type: 'yoo_money',
      account_number: dest.account.replace(/\D/g, ''),
    };
  }
  // bank_card — payout via payout_token
  return {
    type: 'bank_card',
    card: { payout_token: dest.payoutToken },
  };
}

export async function createYooKassaPayout(params: CreatePayoutParams): Promise<PayoutResult> {
  const body: any = {
    amount: {
      value: params.amountRub.toFixed(2),
      currency: 'RUB',
    },
    payout_destination_data: buildDestination(params.destination),
    description: params.description?.slice(0, 128),
    metadata: params.metadata || {},
  };

  const resp = await fetch(`${API_BASE}/payouts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader(),
      'Idempotence-Key': params.idempotenceKey,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json() as YooKassaPayoutResponse;
  if (!resp.ok) {
    const message = data?.description || data?.message || `YooKassa payout error ${resp.status}`;
    console.error('YooKassa createPayout failed:', { status: resp.status, data });
    throw new Error(message);
  }

  return {
    id: data.id,
    status: data.status,
    amount: data.amount,
    createdAt: data.created_at,
    raw: data,
  };
}

export async function fetchYooKassaPayout(payoutId: string): Promise<PayoutResult | null> {
  try {
    const resp = await fetch(`${API_BASE}/payouts/${payoutId}`, {
      headers: { 'Authorization': getAuthHeader() },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as YooKassaPayoutResponse;
    return {
      id: data.id,
      status: data.status,
      amount: data.amount,
      createdAt: data.created_at,
      raw: data,
    };
  } catch (err) {
    console.error('YooKassa fetchPayout error:', err);
    return null;
  }
}
