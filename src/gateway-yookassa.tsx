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

function getCredentials() {
  const shopId = process.env.YOOKASSA_SHOP_ID || '';
  const secretKey = process.env.YOOKASSA_SECRET_KEY || '';
  return { shopId, secretKey };
}

function getAuthHeader(): string {
  const { shopId, secretKey } = getCredentials();
  if (!shopId || !secretKey) throw new Error('ЮКасса не настроена: YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY не заданы');
  return 'Basic ' + btoa(`${shopId}:${secretKey}`);
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

    const data = await response.json();

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
    let verified: any;
    try {
      const resp = await fetch(`${API_BASE}/payments/${referencedPaymentId}`, {
        headers: { 'Authorization': getAuthHeader() },
      });
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
    };
  }

  /**
   * Issue a refund against a previously-succeeded payment. Used by the
   * admin "Refund + Cancel" booking flow (POST /api/booking/:id/admin/
   * refund-and-cancel).
   *
   * Docs: https://yookassa.ru/developers/api#create_refund
   * Auth: same Basic <shopId:secretKey> as createPayment (no separate
   * agent credentials needed — refunds are billed against the
   * original charge).
   */
  async refund(paymentId: string, amountRub: number, opts?: {
    description?: string;
    idempotenceKey?: string;
    metadata?: Record<string, string>;
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

    const response = await fetch(`${API_BASE}/refunds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthHeader(),
        'Idempotence-Key': opts?.idempotenceKey || `refund-${paymentId}-${Date.now()}`,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('YooKassa refund error:', data);
      throw new Error(data.description || data.message || `YooKassa refund error ${response.status}`);
    }
    return {
      id: data.id,
      status: data.status,
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

    const data = await response.json();

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
