/**
 * Financial constants for audio-branding and production-360 pipelines
 */

// ── Audio Branding Pricing ──

export const AUDIO_BRANDING_CONTENT_PRICES: Record<string, number> = {
  jingle: 15000,
  voiceover: 8000,
  podcast_intro: 10000,
  radio_spot: 12000,
  brand_anthem: 25000,
  sound_logo: 20000,
  on_hold: 7000,
  notification: 5000,
};

export const AUDIO_BRANDING_STYLE_PRICES: Record<string, number> = {
  professional: 0,
  premium: 5000,
  exclusive: 15000,
  custom: 10000,
};

export const AUDIO_BRANDING_DURATION_MULTIPLIERS: Record<number, number> = {
  5: 0.5,
  10: 0.7,
  15: 1.0,
  30: 1.5,
  60: 2.0,
  90: 2.5,
  120: 3.0,
};

export const AUDIO_BRANDING_VOICE_MULTIPLIERS: Record<string, number> = {
  none: 1.0,
  male: 1.2,
  female: 1.2,
  duo: 1.5,
  choir: 2.0,
};

export const AUDIO_BRANDING_DISCOUNTS: Record<string, number> = {
  none: 0,
  spark: 0.05,
  start: 0.10,
  pro: 0.15,
  elite: 0.25,
};

export function calculateAudioBrandingPrice(
  contentType: string,
  style: string,
  duration: number | string,
  voiceType: string,
  subscription: string = 'none',
) {
  const base = AUDIO_BRANDING_CONTENT_PRICES[contentType] || 10000;
  const styleAdd = AUDIO_BRANDING_STYLE_PRICES[style] || 0;
  const durMult = AUDIO_BRANDING_DURATION_MULTIPLIERS[Number(duration)] || 1.0;
  const voiceMult = AUDIO_BRANDING_VOICE_MULTIPLIERS[voiceType] || 1.0;
  const discount = AUDIO_BRANDING_DISCOUNTS[subscription] || 0;

  const subtotal = (base + styleAdd) * durMult * voiceMult;
  const discountAmount = subtotal * discount;
  const total = Math.round(subtotal - discountAmount);

  return {
    base,
    styleAdd,
    durationMultiplier: durMult,
    voiceMultiplier: voiceMult,
    subtotal: Math.round(subtotal),
    discount: discount * 100,
    discountAmount: Math.round(discountAmount),
    total,
    currency: 'RUB',
  };
}

// ── Production 360 Pricing ──

export const PRODUCTION_360_SERVICE_PRICES: Record<string, number> = {
  single_track: 30000,
  ep_3_tracks: 75000,
  album: 150000,
  video_shooting: 50000,
  distribution_promo: 40000,
  full_package: 250000,
  mixing_mastering: 20000,
  remix: 25000,
};

export const PRODUCTION_360_ADDON_PRICES: Record<string, number> = {
  music_video: 80000,
  lyric_video: 15000,
  cover_art: 5000,
  social_content: 10000,
  press_release: 8000,
  radio_pitching: 12000,
  playlist_pitching: 15000,
  sync_licensing: 20000,
};

const PRODUCTION_360_DISCOUNTS: Record<string, number> = {
  none: 0,
  spark: 0.05,
  start: 0.10,
  pro: 0.15,
  elite: 0.25,
};

export function calculateProduction360Price(
  serviceType: string,
  addons: string[] = [],
  subscription: string = 'none',
) {
  const base = PRODUCTION_360_SERVICE_PRICES[serviceType] || 30000;
  const addonsTotal = addons.reduce((sum, addon) => sum + (PRODUCTION_360_ADDON_PRICES[addon] || 0), 0);
  const subtotal = base + addonsTotal;
  const discount = PRODUCTION_360_DISCOUNTS[subscription] || 0;
  const discountAmount = subtotal * discount;
  const total = Math.round(subtotal - discountAmount);

  return {
    base,
    addonsTotal,
    subtotal,
    discount: discount * 100,
    discountAmount: Math.round(discountAmount),
    total,
    currency: 'RUB',
    addonsBreakdown: addons.map(a => ({ name: a, price: PRODUCTION_360_ADDON_PRICES[a] || 0 })),
    // Legacy aliases — production-360-routes.tsx использует servicePrice
    // и finalPrice (предшествующие имена этих полей). Чтобы не править
    // 5 мест в callers, держим алиасы. Удалить после полного rename.
    servicePrice: base,
    finalPrice: total,
  };
}

// ── Radio partner commission ──
//
// Когда заведение оплачивает рекламную кампанию на радиостанции
// (radio_venue_requests), платформа удерживает RADIO_COMMISSION_RATE,
// остальное (payout) причитается станции. До 2026-06-10 ставка 0.15
// хардкодилась 6× в radio-routes.tsx (платёжный split + analytics +
// finance) — drift-риск как DJ_PLANS/VENUE_PLANS: поменяешь одно
// место, забудешь другое → station_payout разойдётся с тем, что
// реально удержано. Единый источник.
//
// Отдельно от MARKETPLACE_COMMISSION_RATE (10% на beats/digital/
// services) — у радио своя ставка 15%.

export const RADIO_COMMISSION_RATE = 0.15;

/** Разбивка суммы рекламной кампании заведения: комиссия платформы
 *  (15%) + выплата станции (85%). Округление до рубля (как
 *  исторически Math.round). */
export function splitRadioCampaignAmount(grossPrice: number): {
  platformFee: number;
  stationPayout: number;
  rate: number;
} {
  const platformFee = Math.round(grossPrice * RADIO_COMMISSION_RATE);
  return {
    platformFee,
    stationPayout: grossPrice - platformFee,
    rate: RADIO_COMMISSION_RATE,
  };
}
