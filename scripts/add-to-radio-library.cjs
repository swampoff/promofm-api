#!/usr/bin/env node
/**
 * Add tracks to radio_library — copies MP3 from uploads/tracks/ to radio music dir
 * and registers in radio_library table for AI-DJ broadcast pipeline.
 *
 * Использование:
 *   node scripts/add-to-radio-library.cjs <tracks.json>
 *
 * Формат — тот же, что и для add-weekly-release.cjs (artist, title, mp3, duration, genre)
 */

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const pool = new Pool({
  host: "127.0.0.1",
  user: "promofm_app",
  password: process.env.DB_PASSWORD || "PromoFM2024dbSecure",
  database: "promofm",
});

const SRC = "/opt/promofm-api/uploads/tracks";
const DST = "/mnt/data/promofm-music/tracks";

async function run(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let added = 0;

  for (const t of cfg.tracks) {
    const filename = `${t.artist} - ${t.title}.mp3`;
    const srcPath = path.join(SRC, t.mp3);
    const dstPath = path.join(DST, filename);

    if (!fs.existsSync(srcPath)) {
      console.log(`  ✗ ${filename} — source missing at ${srcPath}`);
      continue;
    }
    fs.copyFileSync(srcPath, dstPath);

    try {
      await pool.query(
        `INSERT INTO radio_library (filename, title, artist, genre, duration_seconds, file_path, region, is_vocal)
         VALUES ($1, $2, $3, $4, $5, $6, 'Global', true)
         ON CONFLICT (filename) DO UPDATE SET
           title = EXCLUDED.title,
           artist = EXCLUDED.artist,
           genre = EXCLUDED.genre,
           duration_seconds = EXCLUDED.duration_seconds,
           file_path = EXCLUDED.file_path`,
        [filename, t.title, t.artist, t.genre, t.duration, dstPath]
      );
      added++;
      console.log(`  ✓ ${filename}`);
    } catch (e) {
      console.log(`  ✗ ${filename}: ${e.message}`);
    }
  }

  const cnt = await pool.query(`SELECT COUNT(*) FROM radio_library`);
  console.log(`\n✅ Added ${added} tracks. radio_library total: ${cnt.rows[0].count}`);
  await pool.end();
}

if (process.argv.length < 3) {
  console.error("Usage: node scripts/add-to-radio-library.cjs <tracks.json>");
  process.exit(1);
}
run(process.argv[2]).catch(e => { console.error(e); pool.end(); process.exit(1); });
