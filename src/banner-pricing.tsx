/**
 * BANNER PRICING — single source of truth для цены баннеров.
 *
 * Цены в рублях. Логика расчёта зеркалится во фронте (см.
 * Promomusicfigma/src/data/banner-pricing.ts) — обновляешь здесь
 * и там в одном PR.
 *
 * Pipeline:
 *   1. Юзер выбирает placement + duration на фронте
 *   2. Фронт сам считает превью через клиентский модуль (тот же расчёт)
 *   3. POST /api/banners передаёт placement + duration_days
 *   4. Сервер сам пересчитывает цену через calculateBannerPrice() —
 *      фронт-цене не доверяем (юзер мог подменить)
 *   5. После apr банер ждёт оплаты через ЮКассу (metadata.type=
 *      'banner_publish', amount = серверная цена)
 *   6. webhook фиксирует оплату → банер активируется
 *
 * Цены и скидки можно править здесь без миграции БД.
 */

export type BannerPlacementId =
  | 'hero_main'
  | 'feed_wide'
  | 'sidebar_large'
  | 'in_feed_card'
  | 'sidebar_small';

export interface BannerPlacement {
  id: BannerPlacementId;
  name: string;
  description: string;
  dimensions: string;
  /** Цена за 1 неделю в рублях. */
  pricePerWeek: number;
  /** Где на сайте показывается. Для UX-описания в форме. */
  locations: string[];
}

export const BANNER_PLACEMENTS: BannerPlacement[] = [
  {
    id: 'hero_main',
    name: 'Hero на главной',
    description: 'Премиум-размещение над фолдом на главной странице. Самый высокий охват.',
    dimensions: '1920×600 px',
    pricePerWeek: 60000,
    locations: ['Главная (/) — top of fold'],
  },
  {
    id: 'feed_wide',
    name: 'Широкий в ленте',
    description: 'Между секциями главной (между чартами и новостями).',
    dimensions: '1200×300 px',
    pricePerWeek: 35000,
    locations: ['Главная — между секциями'],
  },
  {
    id: 'sidebar_large',
    name: 'Боковая большая',
    description: 'Высокий sidebar-баннер на главной и контентных страницах.',
    dimensions: '300×600 px',
    pricePerWeek: 20000,
    locations: ['Главная, /charts, /news — правая колонка'],
  },
  {
    id: 'in_feed_card',
    name: 'Карточка в ленте',
    description: 'Нативное размещение между карточками новостей, DJ и концертов.',
    dimensions: '600×400 px',
    pricePerWeek: 15000,
    locations: ['/news, /djs, /concerts — между карточками'],
  },
  {
    id: 'sidebar_small',
    name: 'Боковая малая',
    description: 'Компактный sidebar-блок. Минимальный пакет для теста.',
    dimensions: '300×250 px',
    pricePerWeek: 10000,
    locations: ['Главная, /charts, /news — правая колонка (нижняя зона)'],
  },
];

export interface BannerDurationOption {
  /** Длительность в днях. */
  days: number;
  /** Множитель: цена-за-неделю × multiplier = базовая цена кампании. */
  multiplier: number;
  label: string;
  /** Скидка для подсветки в UI. */
  discount: number;
}

export const BANNER_DURATIONS: BannerDurationOption[] = [
  { days: 7,  multiplier: 1.0, label: '1 неделя',    discount: 0 },
  { days: 14, multiplier: 1.9, label: '2 недели',    discount: 0.05 },
  { days: 30, multiplier: 4 * 0.85, label: '1 месяц',     discount: 0.15 }, // = 3.4
  { days: 90, multiplier: 12 * 0.75, label: '3 месяца',   discount: 0.25 }, // = 9.0
];

/**
 * Скидки за подписку. Применяются после volume-расчёта.
 * Те же что в checkout-routes.tsx subscription tiers.
 */
export const BANNER_SUBSCRIPTION_DISCOUNTS: Record<string, number> = {
  spark: 0,
  start: 0.05,
  pro:   0.10,
  elite: 0.15,
};

/**
 * Server-side calculator. Принимает placement, duration и опциональный
 * тариф подписки. Возвращает финальную цену в рублях, округлённую вверх
 * до целого рубля.
 *
 * НИКОГДА не доверять цене с фронта — фронт может быть подменён, юзер
 * может вызвать API напрямую. Эта функция — единственный источник
 * правды для checkout.amount.
 */
export interface BannerPriceCalculation {
  ok: boolean;
  error?: string;
  placementId?: BannerPlacementId;
  placementName?: string;
  durationDays?: number;
  basePrice?: number;       // pricePerWeek × multiplier
  volumeDiscount?: number;  // ₽
  subscriptionTier?: string;
  subscriptionDiscount?: number; // ₽
  finalPrice?: number;
}

export function calculateBannerPrice(
  placementId: string,
  durationDays: number,
  subscriptionTier?: string,
): BannerPriceCalculation {
  const placement = BANNER_PLACEMENTS.find(p => p.id === placementId);
  if (!placement) {
    return { ok: false, error: `Unknown placement: ${placementId}` };
  }
  const duration = BANNER_DURATIONS.find(d => d.days === durationDays);
  if (!duration) {
    return { ok: false, error: `Unknown duration: ${durationDays} days` };
  }

  const basePrice = Math.round(placement.pricePerWeek * duration.multiplier);
  const beforeSub = basePrice;
  const tier = (subscriptionTier || 'spark').toLowerCase();
  const subDiscPct = BANNER_SUBSCRIPTION_DISCOUNTS[tier] || 0;
  const subDiscount = Math.round(beforeSub * subDiscPct);
  const finalPrice = beforeSub - subDiscount;

  // Volume-скидка уже встроена в multiplier (для 14д = 1.9 а не 2.0).
  // Здесь её показываем как «сколько сэкономлено vs цена-за-неделю × дни/7».
  const noDiscountPrice = Math.round(placement.pricePerWeek * (durationDays / 7));
  const volumeDiscount = noDiscountPrice - basePrice;

  return {
    ok: true,
    placementId: placement.id,
    placementName: placement.name,
    durationDays,
    basePrice,
    volumeDiscount,
    subscriptionTier: tier,
    subscriptionDiscount: subDiscount,
    finalPrice,
  };
}
