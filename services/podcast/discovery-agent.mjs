#!/usr/bin/env node
/**
 * ПРОМО.МУЗЫКА Podcast Discovery Agent
 *
 * Бродит по платформе раз в DISCOVERY_INTERVAL_SEC (default: 1ч):
 *   - Сколько артистов, диджеев, продюсеров зарегистрировано
 *   - Кто новые артисты последней недели
 *   - Самые крутящиеся треки в эфире
 *   - Топ-чарт (взвешенный)
 *   - Концерты в ближайшие 7 дней
 *   - AI-чарт (треки сгенерированные нейросетями)
 *   - Beats marketplace pulse
 *   - Активность продюсеров (services, orders)
 *
 * Складывает результат в /opt/promofm-podcast/discovery-cache.json
 * Подкаст подцепляет этот кеш для тем news/new_releases/platform_pulse.
 */

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const CACHE_PATH = process.env.DISCOVERY_CACHE || '/opt/promofm-podcast/discovery-cache.json';
const DISCOVERY_INTERVAL_SEC = parseInt(process.env.DISCOVERY_INTERVAL_SEC || '3600', 10);

import { writeFile, readFile } from 'node:fs/promises';

async function safeFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally { clearTimeout(t); }
}

// ─── Discovery probes ─────────────────────────────────────────────────

async function probeStats() {
  // GET /api/landing-data/stats — общие цифры платформы
  const r = await safeFetch(`${API_BASE}/server/api/landing-data/stats`);
  if (r.ok && r.data?.data) return r.data.data;
  return null;
}

async function probeArtists() {
  // GET /api/landing-data/artists?limit=20 + popular-artists
  const fresh = await safeFetch(`${API_BASE}/server/api/landing-data/artists?limit=20`);
  const popular = await safeFetch(`${API_BASE}/server/api/landing-data/popular-artists`);
  return {
    fresh: (fresh.ok && Array.isArray(fresh.data?.data)) ? fresh.data.data.slice(0, 12).map(a => ({
      name: a.name, slug: a.slug, genres: a.genres || [], city: a.city,
    })) : [],
    popular: (popular.ok && Array.isArray(popular.data?.data)) ? popular.data.data.slice(0, 8).map(a => ({
      name: a.name || a.artist, listeners: a.monthlyListeners || a.listeners || 0,
    })) : [],
  };
}

async function probeTracks() {
  // Trending + new + AI charts
  const trending = await safeFetch(`${API_BASE}/server/api/landing-data/tracks/trending?limit=10`);
  const fresh = await safeFetch(`${API_BASE}/server/api/landing-data/tracks/new?limit=10`);
  const ai = await safeFetch(`${API_BASE}/server/api/landing-data/tracks/ai?limit=10`);
  const chart = await safeFetch(`${API_BASE}/server/api/landing-data/charts/weekly`);
  return {
    trending: (trending.ok && Array.isArray(trending.data?.data)) ? trending.data.data.slice(0, 8).map(t => ({
      title: t.title, artist: t.artist, plays: t.plays || 0,
    })) : [],
    fresh: (fresh.ok && Array.isArray(fresh.data?.data)) ? fresh.data.data.slice(0, 8).map(t => ({
      title: t.title, artist: t.artist,
    })) : [],
    ai_chart: (ai.ok && Array.isArray(ai.data?.data)) ? ai.data.data.slice(0, 8).map(t => ({
      title: t.title, artist: t.artist, ai_source: t.aiSource || t.source || '',
    })) : [],
    composite_chart: (chart.ok && chart.data?.data?.entries) ? chart.data.data.entries.slice(0, 8).map(e => ({
      title: e.title, artist: e.artist, score: e.score, trend: e.trend,
    })) : [],
  };
}

async function probeProducers() {
  const profiles = await safeFetch(`${API_BASE}/server/api/landing-data/producer-profiles`);
  const services = await safeFetch(`${API_BASE}/server/api/landing-data/producer-services`);
  return {
    profiles: (profiles.ok && Array.isArray(profiles.data?.data)) ? profiles.data.data.slice(0, 6).map(p => ({
      name: p.name, city: p.city, specializations: p.specializations || [], rating: p.averageRating || 0,
    })) : [],
    services_count: (services.ok && Array.isArray(services.data?.data)) ? services.data.data.length : 0,
  };
}

async function probeConcerts() {
  const r = await safeFetch(`${API_BASE}/server/api/concerts/public?limit=10`);
  if (!r.ok || !Array.isArray(r.data)) return [];
  const now = Date.now();
  return r.data
    .filter(c => c.event_date && new Date(c.event_date).getTime() > now)
    .slice(0, 8)
    .map(c => ({
      artist: c.artist_name || c.title,
      city: c.city,
      venue: c.venue_name,
      date: c.event_date,
    }));
}

async function probeBeats() {
  const r = await safeFetch(`${API_BASE}/server/api/landing-data/beats?limit=10`);
  if (!r.ok || !Array.isArray(r.data?.data)) return [];
  return r.data.data.slice(0, 6).map(b => ({
    title: b.title, producer: b.producerName, genre: b.genre, bpm: b.bpm, price: b.price,
  }));
}

async function probeRadio() {
  const r = await safeFetch(`${API_BASE}/server/api/landing-data/radio-partners`);
  if (!r.ok || !Array.isArray(r.data?.data)) return [];
  return r.data.data.slice(0, 6).map(s => ({
    name: s.name, city: s.city || '', genre: s.genre || '',
  }));
}

async function probeNews() {
  const r = await safeFetch(`${API_BASE}/server/api/news?limit=8`);
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.slice(0, 6).map(n => ({
    title: n.title, excerpt: (n.excerpt || '').slice(0, 200), category: n.category, source: n.source,
  }));
}

// ─── Orchestrator ─────────────────────────────────────────────────────

async function discover() {
  const startedAt = Date.now();
  console.log(`[discovery] start at ${new Date().toISOString()}`);

  const [stats, artists, tracks, producers, concerts, beats, radio, news] = await Promise.all([
    probeStats(), probeArtists(), probeTracks(), probeProducers(),
    probeConcerts(), probeBeats(), probeRadio(), probeNews(),
  ]);

  const snapshot = {
    updatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    stats,
    artists,
    tracks,
    producers,
    concerts,
    beats,
    radio,
    news,
  };

  await writeFile(CACHE_PATH, JSON.stringify(snapshot, null, 2));

  // Summary log
  console.log(`[discovery] saved ${CACHE_PATH}`);
  console.log(`[discovery] stats:${stats ? 'ok' : '-'}`
    + ` artists:${artists.fresh.length}+${artists.popular.length}p`
    + ` tracks:${tracks.trending.length}t/${tracks.fresh.length}f/${tracks.ai_chart.length}ai/${tracks.composite_chart.length}c`
    + ` producers:${producers.profiles.length}`
    + ` concerts:${concerts.length}`
    + ` beats:${beats.length}`
    + ` radio:${radio.length}`
    + ` news:${news.length}`
    + ` in ${Math.round((Date.now() - startedAt)/1000)}s`);
}

// ─── Main loop ────────────────────────────────────────────────────────
async function main() {
  console.log(`[discovery] start. interval=${DISCOVERY_INTERVAL_SEC}s cache=${CACHE_PATH}`);
  while (true) {
    if (process.argv.includes('--once')) {
      await discover();
      break;
    }
    try { await discover(); } catch (e) { console.error(`[discovery] failed: ${e.message}`); }
    await new Promise(r => setTimeout(r, DISCOVERY_INTERVAL_SEC * 1000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });

process.on('SIGTERM', () => { console.log('[discovery] SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { console.log('[discovery] SIGINT'); process.exit(0); });
