/**
 * Stripe Payment Gateway Implementation
 *
 * API docs: https://stripe.com/docs/api
 * Auth: Bearer token (secret key)
 * Webhook: HMAC-SHA256 signature verification (Stripe-Signature header)
 */

import type {
  PaymentGateway,
  PaymentSessionRequest,
  PaymentSessionResult,
  WebhookPayload,
  RecurringChargeRequest,
} from './payment-gateway.tsx';

const API_BASE = 'https://api.stripe.com/v1';

function getCredentials() {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  return { secretKey, webhookSecret };
}

function getAuthHeaders(): Record<string, string> {
  const { secretKey } = getCredentials();
  if (!secretKey) throw new Error('Stripe не настроен: STRIPE_SECRET_KEY не задан');
  return {
    'Authorization': `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/** Encode object to x-www-form-urlencoded (Stripe API format) */
function encodeForm(params: Record<string, any>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(encodeForm(value, fullKey));
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

/** Verify Stripe webhook signature using Web Crypto API */
async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string,
  tolerance = 300,
): Promise<boolean> {
  if (!sigHeader || !secret) return false;

  // Parse Stripe-Signature header: t=timestamp,v1=signature
  const parts: Record<string, string> = {};
  for (const item of sigHeader.split(',')) {
    const [k, v] = item.split('=', 2);
    if (k && v) parts[k.trim()] = v.trim();
  }

  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) return false;

  // Check timestamp tolerance
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > tolerance) {
    console.warn('Stripe webhook: timestamp outside tolerance');
    return false;
  }

  // Compute expected signature: HMAC-SHA256(timestamp + "." + payload, secret)
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(signed))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return expected === signature;
}

export class StripeGateway implements PaymentGateway {
  name = 'stripe' as const;

  async createPayment(req: PaymentSessionRequest): Promise<PaymentSessionResult> {
    const webhookBase = process.env.PAYMENT_WEBHOOK_BASE_URL ||
      'https://promo-music.ru/server';

    // Stripe amounts are in smallest currency unit (kopeks for RUB, cents for USD)
    const amountInSmallest = Math.round(req.amount * 100);

    const params: Record<string, any> = {
      mode: 'payment',
      'line_items[0][price_data][currency]': (req.currency || 'RUB').toLowerCase(),
      'line_items[0][price_data][product_data][name]': req.description,
      'line_items[0][price_data][unit_amount]': amountInSmallest,
      'line_items[0][quantity]': 1,
      success_url: `${req.returnUrl}?orderId=${req.orderId}&status=success`,
      cancel_url: `${req.returnUrl}?orderId=${req.orderId}&status=fail`,
      'metadata[order_id]': req.orderId,
      'metadata[user_id]': req.userId,
      'metadata[type]': req.type,
    };

    // Pass through additional metadata
    for (const [k, v] of Object.entries(req.metadata || {})) {
      params[`metadata[${k}]`] = v;
    }

    // Save payment method for future use
    if (req.savePaymentMethod) {
      params['payment_intent_data[setup_future_usage]'] = 'off_session';
    }

    const body = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');

    const response = await fetch(`${API_BASE}/checkout/sessions`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body,
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Stripe createPayment error:', data);
      throw new Error(data.error?.message || `Stripe error ${response.status}`);
    }

    return {
      sessionId: data.id,
      confirmationUrl: data.url,
      gateway: 'stripe',
      status: 'pending',
    };
  }

  async verifyWebhook(request: Request, body: any): Promise<WebhookPayload | null> {
    const { webhookSecret } = getCredentials();
    const sigHeader = request.headers.get('Stripe-Signature') || '';

    // Get raw body for signature verification
    let rawBody: string;
    try {
      rawBody = JSON.stringify(body);
    } catch {
      console.warn('Stripe webhook: cannot serialize body');
      return null;
    }

    // Verify signature if webhook secret is configured
    if (webhookSecret) {
      const valid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
      if (!valid) {
        console.warn('Stripe webhook: invalid signature');
        return null;
      }
    }

    // Map Stripe event types
    const eventType = body.type;
    const obj = body.data?.object;
    if (!obj) return null;

    let mappedEventType: WebhookPayload['eventType'];
    switch (eventType) {
      case 'checkout.session.completed':
      case 'payment_intent.succeeded':
        mappedEventType = 'payment.succeeded';
        break;
      case 'payment_intent.canceled':
      case 'checkout.session.expired':
        mappedEventType = 'payment.canceled';
        break;
      case 'charge.refunded':
        mappedEventType = 'payment.refunded';
        break;
      default:
        console.log('Stripe webhook: unhandled event type', eventType);
        return null;
    }

    // Extract metadata — from checkout session or payment intent
    const metadata = obj.metadata || {};
    const amount = obj.amount_total
      ? obj.amount_total / 100  // checkout session (in smallest unit)
      : obj.amount
        ? obj.amount / 100      // payment intent
        : 0;

    return {
      gateway: 'stripe',
      eventType: mappedEventType,
      paymentId: obj.payment_intent || obj.id,
      orderId: metadata.order_id || '',
      amount,
      currency: (obj.currency || 'rub').toUpperCase(),
      metadata,
      paymentMethodId: obj.payment_method || undefined,
      raw: body,
    };
  }

  async chargeRecurring(params: RecurringChargeRequest): Promise<PaymentSessionResult> {
    const amountInSmallest = Math.round(params.amount * 100);

    // Create PaymentIntent with saved payment method (off-session)
    const body = encodeForm({
      amount: amountInSmallest,
      currency: (params.currency || 'RUB').toLowerCase(),
      payment_method: params.paymentMethodId,
      confirm: 'true',
      off_session: 'true',
      description: params.description,
      'metadata[order_id]': params.orderId,
      'metadata[user_id]': params.userId,
      'metadata[type]': 'subscription',
    });

    const response = await fetch(`${API_BASE}/payment_intents`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body,
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Stripe chargeRecurring error:', data);
      throw new Error(data.error?.message || `Stripe recurring error ${response.status}`);
    }

    return {
      sessionId: data.id,
      confirmationUrl: '', // No redirect for off-session
      gateway: 'stripe',
      status: 'pending',
    };
  }
}
