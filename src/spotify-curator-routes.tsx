/**
 * SPOTIFY CURATOR DISCOVERY — admin-only утилита для поиска плейлист-
 * кураторов на Spotify по жанру/keywords. Inspired by MusicMonolith
 * (Django-аналог) — admin вбивает query → видит свежий список плейлистов
 * с публичными контактами куратора (email/Instagram extracted из
 * description playlist'а), затем делает outreach (CSV / email-campaign).
 *
 * НЕ для артистов и DJ напрямую — это инструмент admin-команды в
 * /ctrl-pm7k2f. Когда артист/DJ заказывает питчинг через
 * /pitching/submit, admin открывает этот tool и формирует таргет-лист
 * кураторов под submission'у.
 *
 * Setup: добавить в .env проды:
 *   SPOTIFY_CLIENT_ID=<from developer.spotify.com/dashboard>
 *   SPOTIFY_CLIENT_SECRET=<from developer.spotify.com/dashboard>
 *
 * Без credentials endpoint возвращает 503 «не настроено» — не падает.
 *
 * Mount: /server/api/spotify-curators (см. index.ts)
 *
 * Endpoints:
 *   POST /search — поиск плейлистов с extraction контактов кураторов
 *
 * Rate limit: Spotify Search API имеет soft-limit ~180 req/min на client_id.
 * Этот endpoint делает 1 search + N detail-fetches (по limit, default 20),
 * параллельно. Admin-only, low traffic — пока без advisory_lock.
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { createLogger } from './logger.tsx';

const log = createLogger('spotify-curators');
const app = new Hono();

// ─── Spotify access token cache (in-memory, client_credentials flow) ───

interface SpotifyTokenCache {
  value: string;
  expiresAt: number;
}
let _tokenCache: SpotifyTokenCache | null = null;

/**
 * Get a fresh Spotify access token via Client Credentials Flow.
 * Returns null if SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET not configured —
 * caller should respond 503 «не настроено». Cached in-memory until 30s
 * before expiry.
 */
async function getSpotifyAccessToken(): Promise<string | null> {
  const cid = process.env.SPOTIFY_CLIENT_ID;
  const cs = process.env.SPOTIFY_CLIENT_SECRET;
  if (!cid || !cs) return null;

  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 30_000) {
    return _tokenCache.value;
  }

  try {
    const basic = Buffer.from(`${cid}:${cs}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      log.error({ status: res.status, statusText: res.statusText }, 'spotify_token_failed');
      return null;
    }
    const json: any = await res.json();
    if (!json?.access_token || typeof json.expires_in !== 'number') {
      log.error({ json }, 'spotify_token_invalid_response');
      return null;
    }
    _tokenCache = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return _tokenCache.value;
  } catch (err: any) {
    log.error({ err: err?.message }, 'spotify_token_network_error');
    return null;
  }
}

// ─── Contact extraction from playlist description ───

// Spotify playlist description часто содержит email/Instagram куратора в
// форматах "submit at example@gmail.com", "DM @insta_handle", "ig:
// @handle", "Contact: name@domain.tld". Используем conservative regex
// чтобы не вылавливать ложные email-подобные подстроки.
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const INSTAGRAM_RE = /(?:@|instagram\.com\/)([a-zA-Z0-9_.]{2,30})/g;

function extractContacts(description: string | null | undefined): { emails: string[]; instagrams: string[] } {
  if (!description) return { emails: [], instagrams: [] };
  const emails = Array.from(new Set((description.match(EMAIL_RE) || []).map(e => e.toLowerCase())));
  const instagrams = Array.from(new Set(
    Array.from(description.matchAll(INSTAGRAM_RE), m => m[1].toLowerCase())
      .filter(h => h && h !== 'instagram')
  ));
  return { emails, instagrams };
}

// ─── Endpoint: POST /search ───

/**
 * POST /search — поиск плейлистов на Spotify + extraction контактов
 *
 * Body:
 *   {
 *     query: string         // обязательно, min 1 символ
 *     market?: string       // ISO 3166-1 alpha-2, default 'US' (RU также ОК)
 *     limit?: number        // 1..50, default 20
 *   }
 *
 * Response 200:
 *   {
 *     success: true,
 *     query,
 *     market,
 *     curators: [{
 *       playlistId, playlistName, playlistUrl, description,
 *       ownerId, ownerName, ownerSpotifyUrl,
 *       trackCount, followers,
 *       emails: string[], instagrams: string[]
 *     }],
 *     total
 *   }
 *
 * Response 503: { success: false, error: 'Spotify не настроен ...' }
 *   когда SPOTIFY_CLIENT_ID/SECRET отсутствуют в env.
 *
 * Response 502/500: при сбое Spotify API.
 */
app.post('/search', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const query = String(body?.query || '').trim();
    const market = String(body?.market || 'US').toUpperCase().slice(0, 2);
    const limit = Math.min(Math.max(Number(body?.limit) || 20, 1), 50);

    if (!query) {
      return c.json({ success: false, error: 'query обязателен' }, 400);
    }

    const token = await getSpotifyAccessToken();
    if (!token) {
      return c.json({
        success: false,
        error: 'Spotify API не настроен. Добавьте SPOTIFY_CLIENT_ID и SPOTIFY_CLIENT_SECRET в .env прода.',
      }, 503);
    }

    // 1. Search playlists
    const searchUrl = new URL('https://api.spotify.com/v1/search');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('type', 'playlist');
    searchUrl.searchParams.set('market', market);
    searchUrl.searchParams.set('limit', String(limit));

    const searchRes = await fetch(searchUrl.toString(), {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!searchRes.ok) {
      const errBody = await searchRes.text().catch(() => '');
      log.error({ status: searchRes.status, errBody: errBody.slice(0, 200) }, 'spotify_search_failed');
      return c.json({ success: false, error: `Spotify search failed: HTTP ${searchRes.status}` }, 502);
    }
    const searchJson: any = await searchRes.json();
    const items: any[] = searchJson?.playlists?.items || [];

    // Spotify API недавно начал возвращать null'ы в items для приватных/
    // удалённых плейлистов вместо их исключения — фильтруем.
    const validItems = items.filter((x: any) => x && x.id && x.owner);

    // 2. Для каждого playlist — детали (description, followers, track count)
    //    параллельно, но cap'нем concurrency через batches of 10.
    const concurrency = 10;
    const detailed: any[] = [];
    for (let i = 0; i < validItems.length; i += concurrency) {
      const batch = validItems.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map(async (item: any) => {
        const url = `https://api.spotify.com/v1/playlists/${item.id}?fields=id,name,description,external_urls(spotify),owner(id,display_name,external_urls(spotify)),tracks(total),followers(total)`;
        const r = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`detail HTTP ${r.status}`);
        return r.json();
      }));
      for (const res of results) {
        if (res.status === 'fulfilled') detailed.push(res.value);
        // failed details — silently skip, не валим весь search
      }
    }

    // 3. Mapping + contact extraction
    const curators = detailed.map((p: any) => {
      const description = p?.description || '';
      const { emails, instagrams } = extractContacts(description);
      return {
        playlistId: p?.id,
        playlistName: p?.name,
        playlistUrl: p?.external_urls?.spotify,
        description,
        ownerId: p?.owner?.id,
        ownerName: p?.owner?.display_name,
        ownerSpotifyUrl: p?.owner?.external_urls?.spotify,
        trackCount: p?.tracks?.total ?? 0,
        followers: p?.followers?.total ?? 0,
        emails,
        instagrams,
      };
    });

    return c.json({
      success: true,
      query,
      market,
      curators,
      total: curators.length,
    });
  } catch (err: any) {
    log.error({ err: err?.message }, 'spotify_search_handler_error');
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});

export default app;
