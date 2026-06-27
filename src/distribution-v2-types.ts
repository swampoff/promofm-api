/**
 * DISTRIBUTION v2 — TypeScript types для богатой Release-модели.
 *
 * Зеркалит схему миграции 113 (releases / release_tracks /
 * release_contributors / release_deliveries / royalty_statements /
 * royalty_lines). Используется backend-роутами (Фаза 2+) и при mapping'е
 * row → API response.
 *
 * Реальность доставки: Spotify/Apple не имеют upload-API. Доставка идёт
 * через DDEX-ERN + аккредитованный канал или ручную админ-доставку.
 * `ReleaseDelivery.ddexMessageId` + `dspReleaseId` готовы под оба режима.
 */

export type ReleaseCreatorRole = 'artist' | 'dj';
export type ReleaseType = 'single' | 'ep' | 'album';

export type ReleaseStatus =
  | 'draft'            // артист/DJ заполняет
  | 'pending_payment'  // ждёт оплаты release-fee
  | 'paid'             // оплачено, в очереди на модерацию
  | 'in_review'        // админ проверяет метаданные/аудио/обложку
  | 'approved'         // модерация пройдена, готов к доставке
  | 'delivering'       // доставляется в DSP (хотя бы один delivery in-flight)
  | 'live'             // живой хотя бы в одном DSP
  | 'rejected'         // модерация отклонила
  | 'taken_down'       // снят со всех DSP
  | 'cancelled';       // отменён до оплаты

export type DistributionDsp =
  | 'spotify' | 'apple_music' | 'yandex_music' | 'vk_music' | 'soundcloud' | 'other';

export type DeliveryStatus = 'queued' | 'delivering' | 'live' | 'rejected' | 'taken_down';

export type ContributorRole =
  | 'primary_artist' | 'featured_artist' | 'composer' | 'lyricist'
  | 'producer' | 'remixer' | 'mixer';

export type RoyaltyStatementStatus = 'imported' | 'reconciled' | 'paid_out';
export type RoyaltyPayoutStatus = 'unpaid' | 'reserved' | 'paid';

export interface Release {
  id: string;
  userId: string;
  creatorRole: ReleaseCreatorRole;
  artistProfileId: string | null;
  title: string;
  releaseType: ReleaseType;
  primaryArtistName: string;
  labelName: string | null;
  upc: string | null;
  catalogNumber: string | null;
  genre: string | null;
  subgenre: string | null;
  language: string;
  releaseDate: string | null;        // ISO date
  originalReleaseDate: string | null;
  coverUrl: string | null;
  coverWidth: number | null;
  coverHeight: number | null;
  cLine: string | null;
  pLine: string | null;
  cLineYear: number | null;
  pLineYear: number | null;
  explicit: boolean;
  status: ReleaseStatus;
  rejectionReason: string | null;
  paymentSessionId: string | null;
  basePriceRub: number;
  priceRub: number;
  discountPct: number;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseTrack {
  id: string;
  releaseId: string;
  trackId: string | null;
  trackNumber: number;
  discNumber: number;
  title: string;
  version: string | null;
  isrc: string | null;
  explicit: boolean;
  language: string;
  audioUrl: string | null;
  audioFormat: string | null;
  audioSampleRate: number | null;
  audioBitDepth: number | null;
  durationSec: number | null;
  previewStartSec: number | null;
  isDjMix: boolean;
  rightsAttested: boolean;
  rightsAttestedAt: string | null;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseContributor {
  id: string;
  releaseTrackId: string;
  name: string;
  role: ContributorRole;
  splitPct: number;
  payeeUserId: string | null;
  ipi: string | null;
  extra: Record<string, unknown>;
  createdAt: string;
}

export interface ReleaseDelivery {
  id: string;
  releaseId: string;
  targetDsp: DistributionDsp;
  status: DeliveryStatus;
  dspReleaseId: string | null;
  dspUrl: string | null;
  ddexMessageId: string | null;
  deliveredAt: string | null;
  liveAt: string | null;
  rejectedReason: string | null;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RoyaltyStatement {
  id: string;
  targetDsp: DistributionDsp;
  periodStart: string;
  periodEnd: string;
  sourceFilename: string | null;
  importedBy: string | null;
  currency: string;
  totalAmountRub: number;
  status: RoyaltyStatementStatus;
  extra: Record<string, unknown>;
  createdAt: string;
}

export interface RoyaltyLine {
  id: string;
  statementId: string;
  releaseTrackId: string | null;
  isrc: string | null;
  userId: string | null;
  units: number;
  grossAmountRub: number;
  platformFeeRub: number;
  netAmountRub: number;
  payoutStatus: RoyaltyPayoutStatus;
  payoutWithdrawalId: string | null;
  extra: Record<string, unknown>;
  createdAt: string;
}

// ── row → typed mappers (snake_case DB → camelCase API) ───────────────

export function mapReleaseRow(r: any): Release {
  return {
    id: r.id,
    userId: r.user_id,
    creatorRole: r.creator_role,
    artistProfileId: r.artist_profile_id ?? null,
    title: r.title,
    releaseType: r.release_type,
    primaryArtistName: r.primary_artist_name,
    labelName: r.label_name ?? null,
    upc: r.upc ?? null,
    catalogNumber: r.catalog_number ?? null,
    genre: r.genre ?? null,
    subgenre: r.subgenre ?? null,
    language: r.language,
    releaseDate: r.release_date ?? null,
    originalReleaseDate: r.original_release_date ?? null,
    coverUrl: r.cover_url ?? null,
    coverWidth: r.cover_width ?? null,
    coverHeight: r.cover_height ?? null,
    cLine: r.c_line ?? null,
    pLine: r.p_line ?? null,
    cLineYear: r.c_line_year ?? null,
    pLineYear: r.p_line_year ?? null,
    explicit: !!r.explicit,
    status: r.status,
    rejectionReason: r.rejection_reason ?? null,
    paymentSessionId: r.payment_session_id ?? null,
    basePriceRub: Number(r.base_price_rub) || 0,
    priceRub: Number(r.price_rub) || 0,
    discountPct: Number(r.discount_pct) || 0,
    extra: r.extra || {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapReleaseTrackRow(r: any): ReleaseTrack {
  return {
    id: r.id,
    releaseId: r.release_id,
    trackId: r.track_id ?? null,
    trackNumber: Number(r.track_number) || 1,
    discNumber: Number(r.disc_number) || 1,
    title: r.title,
    version: r.version ?? null,
    isrc: r.isrc ?? null,
    explicit: !!r.explicit,
    language: r.language,
    audioUrl: r.audio_url ?? null,
    audioFormat: r.audio_format ?? null,
    audioSampleRate: r.audio_sample_rate ?? null,
    audioBitDepth: r.audio_bit_depth ?? null,
    durationSec: r.duration_sec ?? null,
    previewStartSec: r.preview_start_sec ?? null,
    isDjMix: !!r.is_dj_mix,
    rightsAttested: !!r.rights_attested,
    rightsAttestedAt: r.rights_attested_at ?? null,
    extra: r.extra || {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapReleaseDeliveryRow(r: any): ReleaseDelivery {
  return {
    id: r.id,
    releaseId: r.release_id,
    targetDsp: r.target_dsp,
    status: r.status,
    dspReleaseId: r.dsp_release_id ?? null,
    dspUrl: r.dsp_url ?? null,
    ddexMessageId: r.ddex_message_id ?? null,
    deliveredAt: r.delivered_at ?? null,
    liveAt: r.live_at ?? null,
    rejectedReason: r.rejected_reason ?? null,
    extra: r.extra || {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
