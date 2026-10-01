/**
 * RADIO DOWNLOAD KEY — личная подписанная ссылка станции на скачивание треков
 * из еженедельного письма «Новинки недели» (01.10.2026).
 *
 * Раньше «Скачать» в письме требовало вход в кабинет + ручную верификацию
 * профиля: за 14 дней ~15 живых станций нажали кнопку, скачало 0. Ключ в
 * ссылке заменяет вход и при этом сохраняет учёт выдач: каждое скачивание
 * пишется за конкретным получателем письма.
 *
 * Формат ключа: <kind>.<id>.<sig>
 *   kind: 'u' — аккаунт станции (users.id), 'p' — партнёрский контакт
 *         (radio_partner_contacts.id), 't' — тестовое письмо (?test=), не учитывается;
 *   id:   uuid получателя;
 *   sig:  первые 32 hex HMAC-SHA256 — подделать ключ без секрета нельзя.
 * Срока нет: письмо может пролежать во входящих неделями.
 *
 * Секрет — тот же resolution, что у track-url-token / unsub-token.
 */

import crypto from 'crypto';

export type RadioRecipientKind = 'u' | 'p' | 't';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TEST_RECIPIENT_ID = '00000000-0000-0000-0000-000000000000';

function getSecret(): string {
  const s = process.env.EMAIL_TRACK_SECRET || process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('EMAIL_TRACK_SECRET / UNSUBSCRIBE_SECRET / JWT_SECRET must be set');
  return s;
}

function sign(kind: RadioRecipientKind, id: string): string {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`radio-dl|${kind}|${id.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

export function makeRadioDownloadKey(kind: RadioRecipientKind, id: string): string {
  return `${kind}.${id.toLowerCase()}.${sign(kind, id)}`;
}

export function parseRadioDownloadKey(key: unknown): { kind: RadioRecipientKind; id: string } | null {
  if (typeof key !== 'string' || key.length > 120) return null;
  const [kind, id, sig] = key.split('.');
  if ((kind !== 'u' && kind !== 'p' && kind !== 't') || !id || !sig) return null;
  if (!UUID_RE.test(id) || !/^[0-9a-f]{32}$/i.test(sig)) return null;
  const expected = Buffer.from(sign(kind, id), 'hex');
  const got = Buffer.from(sig.toLowerCase(), 'hex');
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  return { kind, id: id.toLowerCase() };
}
