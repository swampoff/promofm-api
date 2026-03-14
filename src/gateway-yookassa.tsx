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
    // ЮКасса не подписывает webhook-и — верифицируем через GET API
    const paymentId = body?.object?.id;
    if (!paymentId) {
      console.warn('YooKassa webhook: missing payment id');
      return null;
    }

    // Server-side verification
    let verified: any;
    try {
      const resp = await fetch(`${API_BASE}/payments/${paymentId}`, {
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

    // Map event type
    let eventType: WebhookPayload['eventType'];
    switch (verified.status) {
      case 'succeeded': eventType = 'payment.succeeded'; break;
      case 'canceled': eventType = 'payment.canceled'; break;
      default:
        console.log('YooKassa webhook: unhandled status', verified.status);
        return null;
    }

    const metadata = verified.metadata || {};

    return {
      gateway: 'yookassa',
      eventType,
      paymentId: verified.id,
      orderId: metadata.order_id || '',
      amount: parseFloat(verified.amount?.value || '0'),
      currency: verified.amount?.currency || 'RUB',
      metadata,
      paymentMethodId: verified.payment_method?.id,
      raw: body,
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
