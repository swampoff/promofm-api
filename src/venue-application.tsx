/**
 * Заявка заведения при регистрации (PROMO.AIR, решение владельца 21.10.2026):
 * регистрация и есть заявка на подключение. Форма promoair.ru присылает в
 * applicationDetails контактное лицо, телефон, город, тип заведения и число
 * точек; всё хранится в users.settings.application (auth-routes.tsx), профиль
 * заведения берёт оттуда город, тип и телефон (db.tsx ensureVenueProfile),
 * админка показывает поля до одобрения.
 *
 * Модуль чистый (без БД), проверяется в tools/be-venue-signup.test.mts.
 */

/** Типы заведения: те же значения, что в профиле кабинета (fe cabinet/parts/venue-types.ts). */
export const VENUE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  cafe: 'Кофейня или кафе',
  restaurant: 'Ресторан',
  bar: 'Бар',
  lounge: 'Лаунж',
  club: 'Клуб',
  shop: 'Магазин',
  hotel: 'Отель',
  spa: 'SPA и салон',
  gym: 'Фитнес',
  other: 'Другое',
});

/** Сколько точек: значения формы и подписи для писем и админки. */
export const VENUE_POINTS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  '1': '1',
  '2-4': '2–4',
  '5+': '5 и больше',
});

const own = (map: Readonly<Record<string, string>>, key: string) => Object.prototype.hasOwnProperty.call(map, key);

export function isVenueType(v: unknown): v is string {
  return typeof v === 'string' && own(VENUE_TYPE_LABELS, v);
}

export function isVenuePoints(v: unknown): v is string {
  return typeof v === 'string' && own(VENUE_POINTS_LABELS, v);
}

export function venueTypeLabel(v: unknown): string {
  return isVenueType(v) ? VENUE_TYPE_LABELS[v] : '';
}

export function venuePointsLabel(v: unknown): string {
  return isVenuePoints(v) ? VENUE_POINTS_LABELS[v] : '';
}

/**
 * Телефон для связи: российский номер приводится к +7XXXXXXXXXX
 * (8 900…, 7 900…, +7 900…, 900… из 10 цифр), остальные к +<цифры>.
 * От 10 до 15 цифр, иначе null. Та же логика во фронте
 * (fe/src/promoair/auth/venue-application.ts).
 */
export function normalizeVenuePhone(raw: unknown): string | null {
  const s = String(raw ?? '').trim().slice(0, 40);
  if (!s) return null;
  if (/[^\d\s()+.\-]/.test(s)) return null;
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  if (!plus && digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7') && (!plus || digits[0] === '7')) return `+7${digits.slice(1)}`;
  return `+${digits}`;
}

export interface VenueApplication {
  submittedAt: string;
  contactName?: string;
  venueName?: string;
  source?: string;
  phone?: string;
  city?: string;
  venueType?: string;
  points?: string;
}

/** ok=false: error (текст для 400) и field заданы, application null. Один тип без
 * объединения: в api нет strictNullChecks, и объединение по ok не сужается. */
export interface VenueApplicationResult {
  ok: boolean;
  application: VenueApplication | null;
  error?: string;
  field?: 'phone' | 'city' | 'venueType' | 'points';
}

const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * applicationDetails → заявка для users.settings.application.
 *
 * required (форма PROMO.AIR): телефон, город и тип обязательны, число точек
 * из списка (по умолчанию «1»); ошибка = текст для 400. Без required (старая
 * форма promo-music.ru, которая этих полей не шлёт) ничего не отклоняется:
 * сохраняется только то, что прошло проверку, а без контакта, названия,
 * телефона, города и типа заявки нет (null), как раньше.
 */
export function parseVenueApplication(details: unknown, opts: { required: boolean; now?: Date }): VenueApplicationResult {
  const a = details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : {};
  const contactName = clean(a.contactName, 120);
  const venueName = clean(a.venueName, 200);
  const source = clean(a.source, 40);
  const phoneRaw = clean(a.phone, 40);
  const phone = normalizeVenuePhone(phoneRaw);
  const city = clean(a.city, 120);
  const typeRaw = clean(a.venueType, 40).toLowerCase();
  const venueType = isVenueType(typeRaw) ? typeRaw : '';
  const pointsRaw = clean(a.points, 8);
  const points = isVenuePoints(pointsRaw) ? pointsRaw : '';

  if (opts.required) {
    if (!phoneRaw) return { ok: false, application: null, field: 'phone', error: 'Укажите телефон для связи' };
    if (!phone) return { ok: false, application: null, field: 'phone', error: 'Проверьте номер телефона: нужно от 10 до 15 цифр' };
    if (city.length < 2) return { ok: false, application: null, field: 'city', error: 'Укажите город' };
    if (!typeRaw) return { ok: false, application: null, field: 'venueType', error: 'Укажите тип заведения' };
    if (!venueType) return { ok: false, application: null, field: 'venueType', error: 'Выберите тип заведения из списка' };
    if (pointsRaw && !points) return { ok: false, application: null, field: 'points', error: 'Укажите, сколько у вас точек: 1, 2–4 или 5 и больше' };
  }

  const application: VenueApplication = { submittedAt: (opts.now ?? new Date()).toISOString() };
  if (contactName) application.contactName = contactName;
  if (venueName) application.venueName = venueName;
  if (source) application.source = source;
  if (phone) application.phone = phone;
  if (city) application.city = city;
  if (venueType) application.venueType = venueType;
  if (points) application.points = points;
  else if (opts.required) application.points = '1';
  if (!contactName && !venueName && !phone && !city && !venueType) return { ok: true, application: null };
  return { ok: true, application };
}

/** Форма PROMO.AIR: регистрация с promoair.ru или с пометкой source='promoair'. */
export function isPromoAirSignup(site: string, details: unknown): boolean {
  if (site === 'air') return true;
  return Boolean(details && typeof details === 'object' && (details as Record<string, unknown>).source === 'promoair');
}
