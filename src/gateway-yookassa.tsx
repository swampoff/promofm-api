/**
 * ЮКасса Payment Gateway Implementation
 *
 * API docs: https://yookassa.ru/developers/api
 * Auth: Basic (shopId:secretKey)
 * Webhook verification: server-side GET /v3/payments/{id}
 */

import type {
  PaymentGateway,
  PaymentSessionRequest,
  PaymentSessionResult,
  WebhookPayload,
  RecurringChargeRequest,
} from './payment-gateway.tsx';

const API_BASE = 'https://api.yookassa.ru/v3';

// YooKassa API response shape (для всех endpoint'ов /payments, /refunds,
// /payouts — у каждого есть error envelope {description, message} и
// resource envelope {id, status, amount, ...}). TS-strict 4.7+ типизирует
// await response.json() как unknown — этот тип нужен для cast'а ниже.
//
// Док: https://yookassa.ru/developers/api
interface YooKassaResponse {
  id?: string;
  status?: string;
  paid?: boolean;
  amount?: { value: string; currency: string };
  description?: string;
  message?: string;
  recipient?: { account_id?: string; gateway_id?: string };
  payment_method?: { id?: string; type?: string; saved?: boolean };
  confirmation?: { type?: string; confirmation_url?: string };
  created_at?: string;
  captured_at?: string;
  metadata?: Record<string, any>;
  cancellation_details?: { party?: string; reason?: string };
  refundable?: boolean;
  test?: boolean;
  type?: string;
  code?: string;
  parameter?: string;
}

/**
 * Per-payment shop credentials resolver (migration window safety).
 *
 * Контекст: при ротации магазина (как 2026-06-03 → 1307217) часть
 * платежей остаётся «в полёте» под старыми кредами. Late-webhook'и и
 * retry'и этих платежей после ротации проваливают verify (новый ключ
 * не работает на старый payment_id → 401/404). Refund'ы по старым
 * payment_id'ам — то же самое.
 *
 * Решение: для каждой payment_session записывается shop_id (migration
 * 100). Gateway-методы принимают опциональный hint и выбирают
 * соответствующие creds из набора:
 *   - current   = YOOKASSA_SHOP_ID + YOOKASSA_SECRET_KEY (новый магазин)
 *   - legacy    = YOOKASSA_SHOP_ID_OLD + YOOKASSA_SECRET_KEY_OLD (опц.)
 *
 * Если hint shop_id совпадает с current — current creds. Если совпадает
 * с legacy — legacy. Если hint NULL/неизвестный — current (fallback).
 *
 * Webhook verify (где hint недоступен до verify) делает dual-try: сначала
 * current creds, на 401/404 fallback на legacy. После успеха возвращает
 * подсказку какие creds сработали — caller сохраняет shop_id в session
 * для будущих refund'ов.
 */
export function getCurrentShopId(): string {
  return process.env.YOOKASSA_SHOP_ID || '';
}

function getLegacyCredentials(): { shopId: string; secretKey: string } | null {
  const shopId = process.env.YOOKASSA_SHOP_ID_OLD || '';
  const secretKey = process.env.YOOKASSA_SECRET_KEY_OLD || '';
  if (!shopId || !secretKey) return null;
  return { shopId, secretKey };
}

function getCredentialsForShop(shopId?: string): { shopId: string; secretKey: string } {
  // current — default
  const current = {
    shopId: process.env.YOOKASSA_SHOP_ID || '',
    secretKey: process.env.YOOKASSA_SECRET_KEY || '',
  };
  if (!shopId || shopId === current.shopId) return current;
  // hint matches legacy → legacy creds
  const legacy = getLegacyCredentials();
  if (legacy && shopId === legacy.shopId) return legacy;
  // hint неизвестен — fallback на current (safer чем throw, поведение
  // как до migration 100). Warn-log чтобы было видно в проде.
  console.warn(`[YooKassa] unknown shop_id hint='${shopId}', falling back to current`);
  return current;
}

function getCredentials() {
  // Backward-compatible: без hint = current.
  return getCredentialsForShop();
}

function getAuthHeader(shopId?: string): string {
  const { shopId: sid, secretKey } = getCredentialsForShop(shopId);
  if (!sid || !secretKey) throw new Error('ЮКасса не настроена: YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY не заданы');
  return 'Basic ' + btoa(`${sid}:${secretKey}`);
}

export class YooKassaGateway implements PaymentGateway {
  name = 'yookassa' as const;

  async createPayment(req: PaymentSessionRequest): Promise<PaymentSessionResult> {
    const body: any = {
      amount: {
        value: req.amount.toFixed(2),
        currency: req.currency || 'RUB',
      },
      confirmation: {
        type: 'redirect',
        return_url: req.returnUrl,
      },
      capture: true,
      description: req.description,
      metadata: {
        order_id: req.orderId,
        user_id: req.userId,
        type: req.type,
        ...req.metadata,
      },
    };

    // 54-ФЗ: чек обязателен при включённой фискализации
    body.receipt = {
      customer: {
        email: req.metadata?.email || 'noreply@promo-music.ru',
      },
      items: [{
        description: req.description?.slice(0, 128) || 'Оплата на ПРОМО.МУЗЫКА',
        quantity: '1.00',
        amount: {
          value: req.amount.toFixed(2),
          currency: req.currency || 'RUB',
        },
        vat_code: 1,  // Без НДС
        payment_subject: 'service',
        payment_mode: 'full_payment',
      }],
    };

    if (req.savePaymentMethod) {
      body.save_payment_method = true;
    }

    const response = await fetch(`${API_BASE}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthHeader(),
        'Idempotence-Key': req.orderId,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as YooKassaResponse;

    if (!response.ok) {
      console.error('YooKassa createPayment error:', data);
      throw new Error(data.description || data.message || `YooKassa error ${response.status}`);
    }

    return {
      sessionId: data.id,
      confirmationUrl: data.confirmation.confirmation_url,
      gateway: 'yookassa',
      status: 'pending',
    };
  }

  async verifyWebhook(_request: Request, body: any): Promise<WebhookPayload | null> {
    // ЮКасса не подписывает webhook-и — верифицируем через GET API.
    // For payment.* events `body.object` is a Payment (its `id` is the payment id).
    // For refund.succeeded `body.object` is a Refund whose `id` is the refund id
    // but whose `.payment_id` references the original payment we need to look up.
    const notificationEvent: string = body?.event || '';
    const objectId: string | undefined = body?.object?.id;
    const referencedPaymentId: string | undefined = notificationEvent === 'refund.succeeded'
      ? body?.object?.payment_id
      : objectId;
    if (!referencedPaymentId) {
      console.warn('YooKassa webhook: missing referenced payment id', { notificationEvent });
      return null;
    }

    // Server-side verification: always fetch the original Payment object so
    // we can match it to our session via metadata.order_id.
    //
    // Migration 100 dual-try: сначала current creds (новый магазин), на
    // 401/404 fallback на legacy creds (старый магазин если ENV задан).
    // resolvedShopId сообщает caller'у какие creds сработали — checkout-
    // routes.tsx сохраняет это в payment_sessions.shop_id для refund'а.
    let verified: any;
    let resolvedShopId = getCurrentShopId();
    try {
      let resp = await fetch(`${API_BASE}/payments/${referencedPaymentId}`, {
        headers: { 'Authorization': getAuthHeader() },
      });
      if (resp.status === 401 || resp.status === 404) {
        // Не находится у current магазина — пробуем legacy
        const legacy = getLegacyCredentials();
        if (legacy) {
          const legacyAuth = 'Basic ' + btoa(`${legacy.shopId}:${legacy.secretKey}`);
          const legacyResp = await fetch(`${API_BASE}/payments/${referencedPaymentId}`, {
            headers: { 'Authorization': legacyAuth },
          });
          if (legacyResp.ok) {
            resp = legacyResp;
            resolvedShopId = legacy.shopId;
            console.log(`[YooKassa] webhook verified via legacy shop ${legacy.shopId}`);
          }
        }
      }
      if (!resp.ok) {
        console.warn('YooKassa verification failed:', resp.status);
        return null;
      }
      verified = await resp.json();
    } catch (err) {
      console.error('YooKassa verification error:', err);
      return null;
    }

    // For refund.succeeded the Payment status stays 'succeeded' but we want to
    // emit payment.refunded so the checkout handler can mark the session and
    // reverse the credit. For payment.* events we use the Payment.status.
    let eventType: WebhookPayload['eventType'];
    if (notificationEvent === 'refund.succeeded') {
      eventType = 'payment.refunded';
    } else {
      switch (verified.status) {
        case 'succeeded': eventType = 'payment.succeeded'; break;
        case 'canceled': eventType = 'payment.canceled'; break;
        default:
          console.log('YooKassa webhook: unhandled status', verified.status);
          return null;
      }
    }

    const metadata = verified.metadata || {};
    // For refunds the relevant amount is the refund amount, not the original
    // payment amount — the checkout handler can use it to support partial refunds.
    const eventAmount = eventType === 'payment.refunded'
      ? parseFloat(body?.object?.amount?.value || verified.amount?.value || '0')
      : parseFloat(verified.amount?.value || '0');

    return {
      gateway: 'yookassa',
      eventType,
      paymentId: verified.id,
      orderId: metadata.order_id || '',
      amount: eventAmount,
      currency: verified.amount?.currency || 'RUB',
      metadata,
      paymentMethodId: verified.payment_method?.id,
      raw: body,
      resolvedShopId,
    };
  }

  /**
   * Issue a refund against a previously-succeeded payment. Used by the
   * admin "Refund + Cancel" booking flow (POST /api/booking/:id/admin/
   * refund-and-cancel), marketplace refunds, venue-campaign refunds.
   *
   * Docs: https://yookassa.ru/developers/api#create_refund
   *
   * Migration 100: optional `shopId` hint — caller передаёт
   * payment_sessions.shop_id чтобы рефанд старого платежа сразу шёл с
   * правильными legacy creds. Без hint — current creds (как и было).
   */
  async refund(paymentId: string, amountRub: number, opts?: {
    description?: string;
    idempotenceKey?: string;
    metadata?: Record<string, string>;
    shopId?: string;
  }): Promise<{ id: string; status: 'succeeded' | 'pending' | 'canceled'; amount: number; raw: any }> {
    const body: any = {
      amount: {
        value: amountRub.toFixed(2),
        currency: 'RUB',
      },
      payment_id: paymentId,
      description: opts?.description?.slice(0, 250),
      metadata: opts?.metadata || {},
    };
    const idempotenceKey = opts?.idempotenceKey || `refund-${paymentId}-${Date.now()}`;
    const payload = JSON.stringify(body);

    const doRefund = async (auth: string): Promise<Response> => {
      return fetch(`${API_BASE}/refunds`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth,
          'Idempotence-Key': idempotenceKey,
        },
        body: payload,
      });
    };

    // Migration 100 dual-try (как в verifyWebhook): caller передаёт hint,
    // но если hint stale/wrong (например, payment_sessions.shop_id NULL
    // из-за пропущенного backfill) — первый запрос уйдёт на current creds
    // и провалится 401/404. Fallback на «другие» creds (current↔legacy)
    // закрывает migration window seamless.
    let response = await doRefund(getAuthHeader(opts?.shopId));
    if (response.status === 401 || response.status === 404) {
      const triedShopId = opts?.shopId || getCurrentShopId();
      const legacy = getLegacyCredentials();
      // Если первая попытка шла под current — fallback на legacy.
      // Если первая шла под legacy — fallback на current.
      let fallbackAuth: string | null = null;
      if (legacy && triedShopId !== legacy.shopId) {
        fallbackAuth = 'Basic ' + btoa(`${legacy.shopId}:${legacy.secretKey}`);
      } else if (triedShopId !== getCurrentShopId()) {
        fallbackAuth = getAuthHeader();
      }
      if (fallbackAuth) {
        console.log(`[YooKassa] refund ${response.status} on ${triedShopId}, retrying with fallback creds`);
        response = await doRefund(fallbackAuth);
      }
    }

    const data = await response.json() as YooKassaResponse;
    if (!response.ok) {
      console.error('YooKassa refund error:', data);
      throw new Error(data.description || data.message || `YooKassa refund error ${response.status}`);
    }
    return {
      id: data.id,
      status: (data.status || 'pending') as 'pending' | 'succeeded' | 'canceled',
      amount: parseFloat(data.amount?.value || '0'),
      raw: data,
    };
  }

  async chargeRecurring(params: RecurringChargeRequest): Promise<PaymentSessionResult> {
    const body = {
      amount: {
        value: params.amount.toFixed(2),
        currency: params.currency || 'RUB',
      },
      payment_method_id: params.paymentMethodId,
      capture: true,
      description: params.description,
      metadata: {
        order_id: params.orderId,
        user_id: params.userId,
        type: 'subscription',
      },
    };

    const response = await fetch(`${API_BASE}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthHeader(),
        'Idempotence-Key': params.orderId,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as YooKassaResponse;

    if (!response.ok) {
      console.error('YooKassa chargeRecurring error:', data);
      throw new Error(data.description || `YooKassa recurring error ${response.status}`);
    }

    return {
      sessionId: data.id,
      confirmationUrl: '', // No redirect needed for recurring
      gateway: 'yookassa',
      status: 'pending',
    };
  }
}
