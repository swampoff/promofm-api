#!/usr/bin/env node
/**
 * Add Weekly Release — manual workflow when friday.js не подходит
 *
 * Использование:
 *   node scripts/add-weekly-release.cjs <tracks.json>
 *
 * Формат tracks.json:
 *   {
 *     "weekNumber": 18,
 *     "year": 2026,
 *     "releaseDate": "2026-04-27",
 *     "title": "Новинки недели #18 (27 апреля 2026)",
 *     "tracks": [
 *       {
 *         "artist": "Mari Froes",
 *         "title": "Como Ouro",
 *         "slug": "como-ouro",
 *         "mp3": "01 Como Ouro.mp3",
 *         "duration": 154,
 *         "genre": "Electronic"
 *       }
 *     ]
 *   }
 *
 * Предусловия:
 *   - MP3 уже залиты в /opt/promofm-api/uploads/tracks/
 *   - Обложки залиты в /opt/promofm-api/uploads/covers/{slug}.jpg
 */

const { Pool } = require("pg");
const fs = require("fs");

const pool = new Pool({
  host: "127.0.0.1",
  user: "promofm_app",
  password: process.env.DB_PASSWORD || "PromoFM2024dbSecure",
  database: "promofm",
});

const BASE = "https://promo-music.ru/server/uploads";

function makeSlug(name) {
  const map = {а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"yo",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"kh",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya"};
  return name.toLowerCase().replace(/[а-яё]/g, c => map[c] || c).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function run(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const trackIds = [];

  for (const t of cfg.tracks) {
    const primaryArtist = t.artist.split(/[,&]/)[0].trim();
    const artistSlug = t.artistSlug || makeSlug(primaryArtist);
    const sysUserId = `sys-${artistSlug}`;
    const audioUrl = `${BASE}/tracks/${encodeURIComponent(t.mp3)}`;
    const coverUrl = `${BASE}/covers/${t.slug}.jpg`;

    const apRes = await pool.query(
      `INSERT INTO artist_profiles (artist_name, slug, genre, country, user_id, avatar_url)
       VALUES ($1, $2, $3, 'Россия', $4, $5)
       ON CONFLICT (slug) DO UPDATE SET
         artist_name = EXCLUDED.artist_name,
         genre = COALESCE(EXCLUDED.genre, artist_profiles.genre),
         avatar_url = COALESCE(EXCLUDED.avatar_url, artist_profiles.avatar_url)
       RETURNING id`,
      [primaryArtist, artistSlug, t.genre, sysUserId, coverUrl]
    );
    const artistId = apRes.rows[0].id;

    const trRes = await pool.query(
      `INSERT INTO tracks (title, artist_name, genre, duration, audio_url, cover_url, artist_id, moderation_status, is_hidden, release_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'published', false, $8)
       RETURNING id`,
      [t.title, t.artist, t.genre, t.duration, audioUrl, coverUrl, artistId, cfg.releaseDate]
    );
    trackIds.push(trRes.rows[0].id);
    console.log(`  ✓ ${t.artist} — ${t.title}`);
  }

  const relRes = await pool.query(
    `INSERT INTO weekly_releases (title, week_number, year, release_date, track_ids, is_published, published_at)
     VALUES ($1, $2, $3, $4, $5, true, now())
     ON CONFLICT (week_number, year) DO UPDATE SET
       title = EXCLUDED.title,
       track_ids = EXCLUDED.track_ids,
       is_published = true,
       published_at = now()
     RETURNING id, title`,
    [cfg.title, cfg.weekNumber, cfg.year, cfg.releaseDate, trackIds]
  );

  console.log(`\n✅ ${relRes.rows[0].title}`);
  console.log(`   ID: ${relRes.rows[0].id} | tracks: ${trackIds.length}`);
  await pool.end();
}

if (process.argv.length < 3) {
  console.error("Usage: node scripts/add-weekly-release.cjs <tracks.json>");
  process.exit(1);
}
run(process.argv[2]).catch(e => { console.error(e); pool.end(); process.exit(1); });
