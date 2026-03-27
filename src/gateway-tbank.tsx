/**
 * Т-Банк (Tinkoff) Acquiring Payment Gateway Implementation
 *
 * API docs: https://www.tbank.ru/kassa/develop/api/payments/
 * Webhook: SHA-256 Token signature verification
 */

import type {
  PaymentGateway,
  PaymentSessionRequest,
  PaymentSessionResult,
  WebhookPayload,
  RecurringChargeRequest,
} from './payment-gateway.tsx';
import { sha256hex } from './payment-gateway.tsx';

const API_BASE = 'https://securepay.tinkoff.ru/v2';

function getCredentials() {
  const terminalKey = process.env.TBANK_TERMINAL_KEY || '';
  const secretKey = process.env.TBANK_SECRET_KEY || '';
  return { terminalKey, secretKey };
}

/** Verify T-Bank webhook signature (Token field) */
async function verifyTBankSignature(params: Record<string, any>, secretKey: string): Promise<boolean> {
  if (!params.Token) return false;
  const token = params.Token;

  // Remove Token, Receipt, DATA from signature calculation
  const filtered: Record<string, any> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'Token' || k === 'Receipt' || k === 'DATA') continue;
    if (typeof v === 'object') continue; // skip nested objects
    filtered[k] = v;
  }

  // Add Password
  filtered.Password = secretKey;

  // Sort by key, concatenate values
  const sorted = Object.keys(filtered).sort();
  const concatenated = sorted.map(k => String(filtered[k])).join('');

  const hash = await sha256hex(concatenated);
  return hash === token;
}

export class TBankGateway implements PaymentGateway {
  name = 'tbank' as const;

  async createPayment(req: PaymentSessionRequest): Promise<PaymentSessionResult> {
    const { terminalKey, secretKey } = getCredentials();
    if (!terminalKey || !secretKey) {
      throw new Error('Т-Банк не настроен: TBANK_TERMINAL_KEY и TBANK_SECRET_KEY не заданы');
    }

    const webhookBase = process.env.PAYMENT_WEBHOOK_BASE_URL || 'https://promo-music.ru/server';

    const body: any = {
      TerminalKey: terminalKey,
      Amount: Math.round(req.amount * 100), // kopeks
      OrderId: req.orderId,
      Description: req.description,
      NotificationURL: `${webhookBase}/api/checkout/webhook/tbank`,
      SuccessURL: `${req.returnUrl}?orderId=${req.orderId}&status=success`,
      FailURL: `${req.returnUrl}?orderId=${req.orderId}&status=fail`,
      DATA: {
        UserId: req.userId,
        Type: req.type,
        ...req.metadata,
      },
    };

    if (req.savePaymentMethod) {
      body.Recurrent = 'Y';
      body.CustomerKey = req.userId;
    }

    const response = await fetch(`${API_BASE}/Init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!data.Success) {
      console.error('TBank Init error:', data);
      throw new Error(data.Message || data.Details || `T-Bank error: ${data.ErrorCode}`);
    }

    return {
      sessionId: String(data.PaymentId),
      confirmationUrl: data.PaymentURL,
      gateway: 'tbank',
      status: 'pending',
    };
  }

  async verifyWebhook(_request: Request, body: any): Promise<WebhookPayload | null> {
    const { secretKey } = getCredentials();

    // Verify signature — MANDATORY (reject if secret not configured)
    if (!secretKey) {
      console.error('TBank webhook: TBANK_SECRET_KEY not configured — rejecting webhook');
      return null;
    }
    const valid = await verifyTBankSignature(body, secretKey);
    if (!valid) {
      console.warn('TBank webhook: invalid signature');
      return null;
    }

    // Map status to event type
    let eventType: WebhookPayload['eventType'];
    switch (body.Status) {
      case 'CONFIRMED':
      case 'AUTHORIZED':
        eventType = 'payment.succeeded';
        break;
      case 'REJECTED':
      case 'CANCELED':
      case 'DEADLINE_EXPIRED':
        eventType = 'payment.canceled';
        break;
      case 'REFUNDED':
      case 'PARTIAL_REFUNDED':
        eventType = 'payment.refunded';
        break;
      default:
        console.log('TBank webhook: unhandled status', body.Status);
        return null;
    }

    const metadata = body.DATA || {};

    return {
      gateway: 'tbank',
      eventType,
      paymentId: String(body.PaymentId || ''),
      orderId: body.OrderId || '',
      amount: (body.Amount || 0) / 100, // kopeks → rubles
      currency: 'RUB',
      metadata: typeof metadata === 'string' ? {} : metadata,
      paymentMethodId: body.RebillId ? String(body.RebillId) : undefined,
      raw: body,
    };
  }

  async chargeRecurring(params: RecurringChargeRequest): Promise<PaymentSessionResult> {
    const { terminalKey } = getCredentials();
    if (!terminalKey) {
      throw new Error('Т-Банк не настроен: TBANK_TERMINAL_KEY не задан');
    }

    // First, Init a new payment
    const initBody = {
      TerminalKey: terminalKey,
      Amount: Math.round(params.amount * 100),
      OrderId: params.orderId,
      Description: params.description,
      CustomerKey: params.userId,
      Recurrent: 'Y',
    };

    const initResp = await fetch(`${API_BASE}/Init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initBody),
    });
    const initData = await initResp.json();

    if (!initData.Success) {
      throw new Error(initData.Message || `T-Bank recurring init error: ${initData.ErrorCode}`);
    }

    // Then, Charge using RebillId
    const chargeBody = {
      TerminalKey: terminalKey,
      PaymentId: initData.PaymentId,
      RebillId: params.paymentMethodId, // RebillId from first payment
    };

    const chargeResp = await fetch(`${API_BASE}/Charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chargeBody),
    });
    const chargeData = await chargeResp.json();

    if (!chargeData.Success) {
      throw new Error(chargeData.Message || `T-Bank recurring charge error: ${chargeData.ErrorCode}`);
    }

    return {
      sessionId: String(chargeData.PaymentId),
      confirmationUrl: '',
      gateway: 'tbank',
      status: 'pending',
    };
  }
}
