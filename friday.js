#!/usr/bin/env node
/**
 * ПЯТНИЦА — Friday Release Automation
 * 
 * Usage:
 *   node friday.js scan /path/to/tracks   — Scan folder, create artists + tracks + release
 *   node friday.js publish                — Publish latest draft release
 *   node friday.js status                 — Show current release status
 * 
 * Designed to run every Friday via cron:
 *   0 10 * * 5 cd /opt/promofm-api && node friday.js scan /path/to/new-tracks >> /var/log/friday.log 2>&1
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, basename, extname } from 'path';
import { randomUUID } from 'crypto';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Helpers ──────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[а-яё]/g, c => {
      const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
      return map[c] || c;
    })
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function getWeekNumber(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

function formatDate(date) {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

// Get MP3 duration via ffprobe (fallback to 0)
function getDuration(filePath) {
  try {
    const out = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}" 2>/dev/null`, { encoding: 'utf8' });
    return Math.round(parseFloat(out) || 0);
  } catch {
    return 0;
  }
}

// Get MP3 metadata via ffprobe
function getMetadata(filePath) {
  try {
    const out = execSync(`ffprobe -v quiet -print_format json -show_format "${filePath}" 2>/dev/null`, { encoding: 'utf8' });
    const data = JSON.parse(out);
    const tags = data.format?.tags || {};
    return {
      title: tags.title || tags.TITLE || '',
      artist: tags.artist || tags.ARTIST || '',
      album: tags.album || tags.ALBUM || '',
      genre: tags.genre || tags.GENRE || 'Pop',
      duration: Math.round(parseFloat(data.format?.duration) || 0),
    };
  } catch {
    return { title: '', artist: '', album: '', genre: 'Pop', duration: 0 };
  }
}

// ── Commands ─────────────────────────────

async function scanAndCreate(trackDir) {
  console.log(`\n🎵 ПЯТНИЦА — Scanning: ${trackDir}\n`);

  const files = readdirSync(trackDir).filter(f => extname(f).toLowerCase() === '.mp3');
  if (files.length === 0) {
    console.log('No MP3 files found.');
    return;
  }

  const now = new Date();
  const weekNum = getWeekNumber(now);
  const year = now.getFullYear();
  const trackIds = [];

  for (const file of files) {
    const filePath = join(trackDir, file);
    const meta = getMetadata(filePath);
    const title = meta.title || basename(file, extname(file)).replace(/^\d+\s*/, '');
    const artistName = meta.artist || 'Unknown Artist';
    const genre = meta.genre;
    const duration = meta.duration || getDuration(filePath);

    // Split artists (handle ", " and " & ")
    const artists = artistName.split(/,\s*|&\s*|\s+feat\.?\s+/i).map(a => a.trim()).filter(Boolean);
    const primaryArtist = artists[0];
    const slug = slugify(primaryArtist);

    // Upsert artist profile
    const artistId = randomUUID();
    const artistResult = await pool.query(`
      INSERT INTO artist_profiles (id, user_id, slug, artist_name, genre, data)
      VALUES ($1, $2, $3, $4, $5, '{"source": "friday_release"}'::jsonb)
      ON CONFLICT (slug) DO UPDATE SET genre = COALESCE(NULLIF(artist_profiles.genre, ''), $5)
      RETURNING id
    `, [artistId, `system-friday-${Date.now()}`, slug, primaryArtist, genre]);

    const finalArtistId = artistResult.rows[0].id;

    // Copy file to uploads
    const destDir = '/opt/promofm-api/uploads/tracks';
    const destPath = join(destDir, file);
    try {
      execSync(`cp "${filePath}" "${destPath}"`);
    } catch (e) {
      console.error(`  Failed to copy ${file}: ${e.message}`);
    }

    // Symlink for nginx
    const symlinkDir = '/var/www/promofm/uploads/tracks';
    try {
      execSync(`ln -sf ${destDir} ${symlinkDir} 2>/dev/null || true`);
    } catch {}

    // Insert track
    const trackId = randomUUID();
    const audioUrl = `/server/uploads/tracks/${encodeURIComponent(file)}`;

    await pool.query(`
      INSERT INTO tracks (id, artist_id, user_id, title, artist_name, genre, duration, audio_url, release_date, moderation_status, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'approved', $10)
      ON CONFLICT (id) DO NOTHING
    `, [
      trackId, finalArtistId, `system-friday-${Date.now()}`,
      title, artistName, genre, duration, audioUrl,
      now.toISOString(),
      JSON.stringify({ album: meta.album, source: 'friday_release', week: weekNum, year }),
    ]);

    trackIds.push(trackId);
    console.log(`  ✓ ${artistName} — ${title} (${Math.floor(duration/60)}:${(duration%60).toString().padStart(2,'0')})`);
  }

  // Create weekly release
  const releaseTitle = `Новинки недели #${weekNum} (${formatDate(now)})`;

  await pool.query(`
    INSERT INTO weekly_releases (title, week_number, year, release_date, track_ids, is_published, published_at)
    VALUES ($1, $2, $3, $4, $5, true, now())
    ON CONFLICT (week_number, year) DO UPDATE SET
      title = EXCLUDED.title,
      track_ids = array_cat(weekly_releases.track_ids, EXCLUDED.track_ids),
      is_published = true,
      published_at = now()
  `, [releaseTitle, weekNum, year, now.toISOString(), trackIds]);

  console.log(`\n✅ Release created: ${releaseTitle}`);
  console.log(`   ${trackIds.length} tracks added\n`);
}

async function showStatus() {
  const result = await pool.query(`
    SELECT wr.*, 
      (SELECT count(*) FROM tracks t WHERE t.id = ANY(wr.track_ids)) as actual_tracks
    FROM weekly_releases wr
    ORDER BY release_date DESC
    LIMIT 5
  `);

  console.log('\n📊 Recent releases:\n');
  for (const r of result.rows) {
    const status = r.is_published ? '✅' : '⏳';
    console.log(`  ${status} ${r.title} — ${r.actual_tracks} tracks`);
  }

  const trackCount = await pool.query(`SELECT count(*) FROM tracks WHERE data->>'source' = 'friday_release'`);
  const artistCount = await pool.query(`SELECT count(*) FROM artist_profiles WHERE data->>'source' = 'friday_release'`);

  console.log(`\n  Total: ${trackCount.rows[0].count} tracks, ${artistCount.rows[0].count} artists\n`);
}

// ── CLI ──────────────────────────────────

const [,, command, arg] = process.argv;

switch (command) {
  case 'scan':
    if (!arg) {
      console.error('Usage: node friday.js scan /path/to/tracks');
      process.exit(1);
    }
    scanAndCreate(arg).then(() => pool.end()).catch(e => { console.error(e); pool.end(); process.exit(1); });
    break;
  case 'status':
    showStatus().then(() => pool.end()).catch(e => { console.error(e); pool.end(); process.exit(1); });
    break;
  default:
    console.log('Usage: node friday.js <scan|status> [path]');
    pool.end();
}
