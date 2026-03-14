/**
 * Payment Gateway — Unified interface for ЮКасса and Т-Банк
 *
 * Types, interface, and factory function.
 * Each gateway implementation lives in its own file.
 */

// ── Types ──

export type GatewayName = 'yookassa' | 'tbank' | 'stripe';

export type PaymentType = 'purchase' | 'subscription' | 'donation' | 'topup';

export interface PaymentSessionRequest {
  amount: number;             // in rubles (e.g. 999.00)
  currency: string;           // 'RUB'
  description: string;
  gateway: GatewayName;
  userId: string;
  orderId: string;            // unique UUID, generated server-side
  returnUrl: string;          // redirect URL after payment
  metadata: Record<string, string>;
  savePaymentMethod?: boolean;
  type: PaymentType;
}

export interface PaymentSessionResult {
  sessionId: string;          // gateway-specific payment ID
  confirmationUrl: string;    // redirect URL for the user
  gateway: GatewayName;
  status: 'pending';
}

export interface WebhookPayload {
  gateway: GatewayName;
  eventType: 'payment.succeeded' | 'payment.canceled' | 'payment.refunded';
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  paymentMethodId?: string;
  raw: any;
}

export interface RecurringChargeRequest {
  amount: number;
  currency: string;
  paymentMethodId: string;
  orderId: string;
  description: string;
  userId: string;
}

export interface PaymentGateway {
  name: GatewayName;
  createPayment(req: PaymentSessionRequest): Promise<PaymentSessionResult>;
  verifyWebhook(request: Request, body: any): Promise<WebhookPayload | null>;
  chargeRecurring(params: RecurringChargeRequest): Promise<PaymentSessionResult>;
}

// ── Payment Session (stored in KV) ──

export interface PaymentSession {
  orderId: string;
  userId: string;
  gateway: GatewayName;
  gatewayPaymentId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'canceled' | 'refunded';
  type: PaymentType;
  description: string;
  metadata: Record<string, string>;
  savePaymentMethod: boolean;
  savedMethodId?: string;
  confirmationUrl: string;
  returnUrl: string;
  createdAt: string;
  completedAt?: string;
}

// ── Saved Payment Method ──

export interface SavedPaymentMethod {
  id: string;
  userId: string;
  gateway: GatewayName;
  gatewayMethodId: string;
  type: string;        // 'bank_card', 'yoo_money', etc.
  title: string;       // 'Visa *4242'
  createdAt: string;
}

// ── Factory ──

import { YooKassaGateway } from './gateway-yookassa.tsx';
import { TBankGateway } from './gateway-tbank.tsx';
import { StripeGateway } from './gateway-stripe.tsx';

export function getGateway(name: GatewayName): PaymentGateway {
  switch (name) {
    case 'yookassa':
      return new YooKassaGateway();
    case 'tbank':
      return new TBankGateway();
    case 'stripe':
      return new StripeGateway();
    default:
      throw new Error(`Unknown payment gateway: ${name}`);
  }
}

// ── Helpers ──

/** SHA-256 hex hash using Web Crypto API */
export async function sha256hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
