// Что из треков, клипов и концертов считается публичным — одно место для
// страниц людей (/server/api/landing-data/tracks|videos/:id), HTML для
// роботов (seo-routes.tsx) и карты сайта (sitemap-routes.tsx). Раньше у
// каждого был свой фильтр, и они расходились: робот видел отклонённые
// треки, в sitemap стояли пустые видео, у человека страниц не было вовсе.

import { pool } from './db-client.tsx';

/** Публичный трек — тот же фильтр, что в a5ee088 (страница артиста). */
export const PUBLIC_TRACK_SQL = `t.moderation_status IN ('approved','upcoming','published') AND t.is_hidden = false`;

/**
 * Публичный клип: одобрен, не скрыт и есть сам ролик. 389 «видео» январского
 * импорта (2026-01-31) — пустые записи без ссылки, обложки и владельца.
 */
export const PUBLIC_VIDEO_SQL = `v.moderation_status = 'approved' AND v.is_hidden = false AND COALESCE(v.video_url, '') <> ''`;

/**
 * Концерт, который человек видит в афише — зеркало getPublishedConcerts
 * (db-typed.tsx): предстоящий, с площадкой, баннером и билетами.
 */
export const PUBLIC_CONCERT_SQL = `c.moderation_status IN ('approved','published') AND c.is_hidden = false
  AND c.is_cancelled = false AND c.event_date >= CURRENT_DATE
  AND COALESCE(c.venue_name, '') NOT IN ('', 'Уточняется')
  AND COALESCE(c.banner_image_url, '') <> ''
  AND (COALESCE(c.ticket_link, '') <> '' OR COALESCE(c.ticket_price_min, 0) > 0)`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicTrack {
  id: string;
  title: string;
  artist: string;
  artistProfile: string | null; // slug или id профиля для /profile/:id
  genre: string | null;
  cover: string | null;
  audioUrl: string | null;
  durationSec: number | null;
  releaseDate: string | null;
  description: string | null;
  composer: string | null;
  lyricist: string | null;
  isAi: boolean;
  isArchive: boolean;
  links: { platform: string; url: string }[];
  /** Станции, где эфир подтверждён мониторингом (promo_check_detections) — не «заявлено станцией». */
  airplayStations: string[];
}

function iso(d: any): string | null {
  if (!d) return null;
  const s = d instanceof Date ? d.toISOString() : String(d);
  return s.slice(0, 10);
}

export async function getPublicTrack(id: string): Promise<PublicTrack | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.artist_name, t.genre, t.cover_url, t.audio_url, t.duration,
            t.release_date, t.published_at, t.created_at, t.description, t.music_composer, t.lyricist,
            t.is_ai_track, t.is_legacy, t.yandex_music_url, t.vk_music_url, t.spotify_url,
            t.apple_music_url, t.youtube_url, ap.slug AS artist_slug, ap.id AS artist_profile_id,
            ap.artist_name AS profile_name
       FROM tracks t
       LEFT JOIN artist_profiles ap ON ap.id = t.artist_id
      WHERE t.id = $1 AND ${PUBLIC_TRACK_SQL}`,
    [id],
  );
  const t = rows[0];
  if (!t) return null;
  const det = await pool.query(
    `SELECT DISTINCT station_name FROM promo_check_detections WHERE track_id = $1 AND station_name IS NOT NULL ORDER BY 1 LIMIT 20`,
    [id],
  ).catch(() => ({ rows: [] as any[] }));
  const links = [
    ['Яндекс Музыка', t.yandex_music_url], ['VK Музыка', t.vk_music_url], ['Spotify', t.spotify_url],
    ['Apple Music', t.apple_music_url], ['YouTube', t.youtube_url],
  ].filter(([, u]) => typeof u === 'string' && /^https?:\/\//i.test(u)).map(([platform, url]) => ({ platform: platform as string, url: url as string }));
  return {
    id: String(t.id),
    title: t.title || 'Без названия',
    artist: t.artist_name || t.profile_name || 'Артист',
    artistProfile: t.artist_slug || (t.artist_profile_id ? String(t.artist_profile_id) : null),
    genre: t.genre || null,
    cover: t.cover_url || null,
    audioUrl: t.audio_url || null,
    durationSec: t.duration ? Number(t.duration) : null,
    releaseDate: iso(t.release_date) || iso(t.published_at) || iso(t.created_at),
    description: t.description || null,
    composer: t.music_composer || null,
    lyricist: t.lyricist || null,
    isAi: !!t.is_ai_track,
    isArchive: !!t.is_legacy,
    links,
    airplayStations: det.rows.map((r: any) => String(r.station_name)),
  };
}

export interface PublicVideo {
  id: string;
  title: string;
  artist: string | null;
  artistProfile: string | null;
  description: string | null;
  videoUrl: string;
  youtubeId: string | null;
  thumbnail: string | null;
  durationSec: number | null;
  uploadDate: string | null;
  trackId: string | null;
}

export function youtubeIdFromUrl(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/i);
  return m ? m[1] : null;
}

export async function getPublicVideo(id: string): Promise<PublicVideo | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await pool.query(
    `SELECT v.id, v.title, v.description, v.video_url, v.thumbnail_url, v.duration, v.created_at, v.track_id,
            ap.artist_name, ap.slug AS artist_slug, ap.id AS artist_profile_id
       FROM videos v
       LEFT JOIN artist_profiles ap ON ap.id = v.artist_id
      WHERE v.id = $1 AND ${PUBLIC_VIDEO_SQL}`,
    [id],
  );
  const v = rows[0];
  if (!v) return null;
  const ytId = youtubeIdFromUrl(String(v.video_url));
  return {
    id: String(v.id),
    title: v.title || 'Клип',
    artist: v.artist_name || null,
    artistProfile: v.artist_slug || (v.artist_profile_id ? String(v.artist_profile_id) : null),
    description: v.description || null,
    videoUrl: String(v.video_url),
    youtubeId: ytId,
    thumbnail: v.thumbnail_url || (ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : null),
    durationSec: v.duration ? Number(v.duration) : null,
    uploadDate: iso(v.created_at),
    trackId: v.track_id && (await getPublicTrack(String(v.track_id)).catch(() => null)) ? String(v.track_id) : null,
  };
}

/** «3:45» из секунд. */
export function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
