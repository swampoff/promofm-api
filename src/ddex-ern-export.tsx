/**
 * DDEX ERN export — генерация NewReleaseMessage (ERN 4.3-style) из нашей
 * Release-модели (releases / release_tracks / release_contributors /
 * release_deliveries, миграция 113).
 *
 * DDEX ERN (Electronic Release Notification) — индустриальный стандарт
 * метаданных, которым дистрибьюторы шлют релизы в DSP. Реальная доставка:
 * этот XML вкладывается в ERN-«посылку» (вместе с аудио-мастерами и
 * обложкой) и отправляется по согласованному каналу (SFTP/агрегатор).
 *
 * ⚠️ ВАЖНО: точный ERN-профиль (версия 3.8.2 / 4.1 / 4.3, AudioAlbum vs
 * AudioSingle, обязательные элементы) ЗАВИСИТ от получателя. Этот
 * генератор даёт структурно-корректный ERN 4.3 NewReleaseMessage с
 * правильным маппингом наших данных — но ПЕРЕД боевой доставкой его надо
 * провалидировать против DDEX-профиля конкретного канала (агрегатора/DSP).
 * Это стартовый шаблон, не «отправь как есть в Spotify».
 *
 * Источник истины по полям: docs/PRODUCT_FACTS.md «Distribution v2».
 */

// ── XML helpers ──────────────────────────────────────────────────────
function esc(v: unknown): string {
  const s = v == null ? '' : String(v);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function el(tag: string, value: unknown, attrs?: Record<string, string>): string {
  const a = attrs ? ' ' + Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ') : '';
  if (value == null || value === '') return '';
  return `<${tag}${a}>${esc(value)}</${tag}>`;
}

function durationIso(sec: number | null | undefined): string {
  // ISO 8601 duration PT#M#S
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `PT${m}M${rem}S`;
}

function isoDate(d: string | null | undefined): string {
  if (!d) return '';
  return String(d).slice(0, 10);
}

// ── Types (subset — то что нужно для экспорта) ───────────────────────
export interface DdexReleaseInput {
  release: {
    id: string;
    title: string;
    releaseType: string;            // single|ep|album
    primaryArtistName: string;
    labelName: string | null;
    upc: string | null;
    genre: string | null;
    language: string;
    releaseDate: string | null;
    coverUrl: string | null;
    cLine: string | null;
    pLine: string | null;
    cLineYear: number | null;
    pLineYear: number | null;
    explicit: boolean;
  };
  tracks: Array<{
    id: string;
    trackNumber: number;
    discNumber: number;
    title: string;
    version: string | null;
    isrc: string | null;
    explicit: boolean;
    language: string;
    durationSec: number | null;
    contributors: Array<{ name: string; role: string }>;
  }>;
  deliveries: Array<{ targetDsp: string }>;
  messageId: string;                // уникальный id посылки
  senderName: string;               // имя нашей платформы как MessageSender
  createdAt: string;                // ISO datetime
}

const RELEASE_TYPE_DDEX: Record<string, string> = {
  single: 'Single',
  ep: 'EP',
  album: 'Album',
};

// DDEX contributor role → ERN ContributorRole / ResourceContributor role
const CONTRIB_ROLE_DDEX: Record<string, string> = {
  primary_artist: 'MainArtist',
  featured_artist: 'FeaturedArtist',
  composer: 'Composer',
  lyricist: 'Lyricist',
  producer: 'Producer',
  remixer: 'Remixer',
  mixer: 'Mixer',
};

/**
 * Генерирует ERN 4.3 NewReleaseMessage XML.
 */
export function generateDdexErn(input: DdexReleaseInput): string {
  const { release: r, tracks, deliveries, messageId, senderName, createdAt } = input;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<ern:NewReleaseMessage xmlns:ern="http://ddex.net/xml/ern/43" ` +
    `xmlns:xs="http://www.w3.org/2001/XMLSchema-instance" ` +
    `MessageSchemaVersionId="ern/43" LanguageAndScriptCode="${esc(r.language || 'ru')}">`,
  );

  // ── MessageHeader ──
  lines.push('  <MessageHeader>');
  lines.push(`    ${el('MessageId', messageId)}`);
  lines.push('    <MessageSender>');
  lines.push(`      <PartyName><FullName>${esc(senderName)}</FullName></PartyName>`);
  lines.push('    </MessageSender>');
  lines.push('    <MessageRecipient>');
  lines.push(`      <PartyName><FullName>${esc(deliveries.map(d => d.targetDsp).join(', ') || 'DSP')}</FullName></PartyName>`);
  lines.push('    </MessageRecipient>');
  lines.push(`    ${el('MessageCreatedDateTime', createdAt)}`);
  lines.push('  </MessageHeader>');

  // ── ResourceList — SoundRecording per track + Image (cover) ──
  lines.push('  <ResourceList>');
  tracks.forEach((t, idx) => {
    const resRef = `A${idx + 1}`;
    lines.push('    <SoundRecording>');
    lines.push(`      <ResourceReference>${resRef}</ResourceReference>`);
    lines.push('      <Type>MusicalWorkSoundRecording</Type>');
    if (t.isrc) lines.push(`      <SoundRecordingEdition><ResourceId>${el('ISRC', t.isrc.replace(/-/g, ''))}</ResourceId></SoundRecordingEdition>`);
    lines.push('      <DisplayTitle>');
    lines.push(`        <TitleText>${esc(t.title)}</TitleText>`);
    if (t.version) lines.push(`        <SubTitle>${esc(t.version)}</SubTitle>`);
    lines.push('      </DisplayTitle>');
    lines.push(`      <DisplayArtist><PartyName><FullName>${esc(r.primaryArtistName)}</FullName></PartyName><ArtistRole>MainArtist</ArtistRole></DisplayArtist>`);
    // contributors
    for (const c of t.contributors) {
      const role = CONTRIB_ROLE_DDEX[c.role] || 'Contributor';
      lines.push(`      <ResourceContributor><PartyName><FullName>${esc(c.name)}</FullName></PartyName><Role>${esc(role)}</Role></ResourceContributor>`);
    }
    lines.push(`      ${el('Duration', durationIso(t.durationSec))}`);
    lines.push(`      ${el('LanguageOfPerformance', t.language || r.language)}`);
    lines.push(`      <ParentalWarningType>${t.explicit ? 'Explicit' : 'NotExplicit'}</ParentalWarningType>`);
    lines.push('    </SoundRecording>');
  });
  // Cover image
  if (r.coverUrl) {
    lines.push('    <Image>');
    lines.push('      <ResourceReference>IMG1</ResourceReference>');
    lines.push('      <Type>FrontCoverImage</Type>');
    lines.push(`      <DisplayTitle><TitleText>${esc(r.title)}</TitleText></DisplayTitle>`);
    lines.push('    </Image>');
  }
  lines.push('  </ResourceList>');

  // ── ReleaseList — one main Release ──
  lines.push('  <ReleaseList>');
  lines.push('    <Release>');
  lines.push('      <ReleaseReference>R0</ReleaseReference>');
  if (r.upc) lines.push(`      <ReleaseId>${el('ICPN', r.upc)}</ReleaseId>`);
  lines.push('      <DisplayTitle>');
  lines.push(`        <TitleText>${esc(r.title)}</TitleText>`);
  lines.push('      </DisplayTitle>');
  lines.push(`      <DisplayArtist><PartyName><FullName>${esc(r.primaryArtistName)}</FullName></PartyName><ArtistRole>MainArtist</ArtistRole></DisplayArtist>`);
  lines.push(`      ${el('ReleaseType', RELEASE_TYPE_DDEX[r.releaseType] || 'Album')}`);
  if (r.labelName) lines.push(`      <ReleaseLabelReference>${esc(r.labelName)}</ReleaseLabelReference>`);
  if (r.genre) lines.push(`      <Genre><GenreText>${esc(r.genre)}</GenreText></Genre>`);
  if (r.pLine) lines.push(`      <PLine>${el('Year', r.pLineYear || (r.releaseDate ? isoDate(r.releaseDate).slice(0, 4) : ''))}${el('PLineText', r.pLine)}</PLine>`);
  if (r.cLine) lines.push(`      <CLine>${el('Year', r.cLineYear || (r.releaseDate ? isoDate(r.releaseDate).slice(0, 4) : ''))}${el('CLineText', r.cLine)}</CLine>`);
  lines.push(`      <ParentalWarningType>${r.explicit ? 'Explicit' : 'NotExplicit'}</ParentalWarningType>`);
  // Resource references (track order)
  lines.push('      <ResourceGroup>');
  tracks
    .slice()
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber))
    .forEach((t, idx) => {
      const resRef = `A${tracks.indexOf(t) + 1}`;
      lines.push('        <ResourceGroupContentItem>');
      lines.push(`          <SequenceNumber>${idx + 1}</SequenceNumber>`);
      lines.push(`          <ReleaseResourceReference>${resRef}</ReleaseResourceReference>`);
      lines.push('        </ResourceGroupContentItem>');
    });
  lines.push('      </ResourceGroup>');
  lines.push('    </Release>');
  lines.push('  </ReleaseList>');

  // ── DealList — ReleaseDeal per territory (Worldwide), stream+download ──
  lines.push('  <DealList>');
  lines.push('    <ReleaseDeal>');
  lines.push('      <DealReleaseReference>R0</DealReleaseReference>');
  lines.push('      <Deal>');
  lines.push('        <DealTerms>');
  lines.push('          <CommercialModelType>SubscriptionModel</CommercialModelType>');
  lines.push('          <Usage><UseType>Stream</UseType></Usage>');
  lines.push('          <Usage><UseType>PermanentDownload</UseType></Usage>');
  lines.push('          <TerritoryCode>Worldwide</TerritoryCode>');
  if (r.releaseDate) lines.push(`          <ValidityPeriod><StartDate>${esc(isoDate(r.releaseDate))}</StartDate></ValidityPeriod>`);
  lines.push('        </DealTerms>');
  lines.push('      </Deal>');
  lines.push('    </ReleaseDeal>');
  lines.push('  </DealList>');

  lines.push('</ern:NewReleaseMessage>');
  return lines.filter(Boolean).join('\n');
}
