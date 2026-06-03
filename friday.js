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
import { spawnSync } from 'child_process';
import { readdirSync, mkdirSync, renameSync, existsSync, copyFileSync } from 'fs';
import { join, basename, extname } from 'path';
import { randomUUID } from 'crypto';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Set admin role for RLS bypass on all connections
pool.on('connect', (client) => {
  client.query("SELECT set_config('app.current_role', 'admin', false)");
});

// ── CMD-injection safe wrapper ───────────────────────────
// Audit 2026-06-03: всё ниже раньше шло через execSync(`ffprobe "${path}"`)
// где path — basename из readdirSync, без санитизации. MP3 с именем вида
// `track"; rm -rf / "x.mp3` в /opt/promofm-api/uploads/inbox вызывал бы
// shell injection при cron-сканировании. spawnSync с массивом аргументов
// не запускает шелл — никакая интерпретация специальных символов.
function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}
function runQuiet(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return r.status === 0;
}

// ── Dedupe helper: skip if (artist, title) already imported ──
async function isAlreadyImported(artistName, title) {
  if (!artistName || !title) return false;
  try {
    const r = await pool.query(
      `SELECT 1 FROM tracks
       WHERE LOWER(artist_name) = LOWER($1) AND LOWER(title) = LOWER($2)
       LIMIT 1`,
      [artistName, title]
    );
    return r.rows.length > 0;
  } catch { return false; }
}

// ── Move processed MP3 to /opt/promofm-api/uploads/processed/ to avoid re-import ──
function moveToProcessed(mp3Path) {
  try {
    const processedDir = '/opt/promofm-api/uploads/processed';
    if (!existsSync(processedDir)) mkdirSync(processedDir, { recursive: true });
    const dest = join(processedDir, basename(mp3Path));
    if (existsSync(mp3Path) && !existsSync(dest)) {
      renameSync(mp3Path, dest);
    }
  } catch (e) { console.error('  ⚠ move-to-processed failed:', e.message); }
}


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
  const out = runCapture('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
  ]);
  return Math.round(parseFloat(out) || 0);
}

// Extract cover art from MP3
function extractCover(filePath, outputPath) {
  const probe = runCapture('ffprobe', [
    '-v', 'quiet', '-show_streams', '-select_streams', 'v', filePath,
  ]);
  if (!probe) return false;
  if (probe.includes('codec_name=mjpeg') || probe.includes('codec_name=png')) {
    return runQuiet('ffmpeg', [
      '-y', '-i', filePath, '-an', '-vcodec', 'mjpeg', '-q:v', '2', outputPath,
    ]);
  }
  return false;
}

// Get MP3 metadata via ffprobe
function getMetadata(filePath) {
  const out = runCapture('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
  ]);
  if (!out) return { title: '', artist: '', album: '', genre: 'Pop', duration: 0 };
  try {
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

  // Concurrent-cron guard: pg advisory lock — second invocation того же
  // scan-job'а тихо завершится, не задвоив релиз / ON CONFLICT гонки на
  // artist slug, не выслав 2x уведомлений (если когда-нибудь добавим).
  // Lock key — произвольная константа; освобождается по pool.end().
  const lockKey = 924173; // 'friday-cron'
  const lockRes = await pool.query('SELECT pg_try_advisory_lock($1) AS got', [lockKey]);
  if (!lockRes.rows[0].got) {
    console.log('⚠ Another friday-cron is running, skipping.');
    return;
  }

  const files = readdirSync(trackDir).filter(f => extname(f).toLowerCase() === '.mp3');
  if (files.length === 0) {
    console.log('No MP3 files found.');
    return;
  }

  // Setup nginx symlinks ONCE per run (раньше mkdir+ln звались на каждый
  // трек — 200 треков = 600 syscalls без необходимости).
  const destDir = '/opt/promofm-api/uploads/tracks';
  const coversDir = '/opt/promofm-api/uploads/covers';
  try {
    mkdirSync(coversDir, { recursive: true });
    mkdirSync('/var/www/promofm/html/server/uploads', { recursive: true });
  } catch {}
  runQuiet('ln', ['-sfn', '/opt/promofm-api/uploads/covers', '/var/www/promofm/html/server/uploads/covers']);
  runQuiet('ln', ['-sfn', '/opt/promofm-api/uploads/tracks', '/var/www/promofm/html/server/uploads/tracks']);

  const now = new Date();
  const weekNum = getWeekNumber(now);
  const year = now.getFullYear();
  const trackIds = [];

  // Audit 2026-06-03: раньше user_id = `system-friday-${Date.now()}` —
  // менялся каждую итерацию цикла, плюс между artist INSERT и track
  // INSERT, итог: каждый трек получал РАЗНЫЙ синтетический user_id, и
  // artist_profiles накапливал «system-friday-1733...» как owner-ID
  // которого нет в users → orphan FK + RLS-боль. Один константный
  // owner-ID для всего friday-pipeline'а.
  const SYSTEM_OWNER = 'system-friday';

  for (const file of files) {
    const filePath = join(trackDir, file);
    const meta = getMetadata(filePath);
    const title = meta.title || basename(file, extname(file)).replace(/^\d+\s*/, '');
    const artistName = meta.artist || 'Unknown Artist';
    const genre = meta.genre;
    const duration = meta.duration || getDuration(filePath);

    // Split artists (handle ", " and " & ")
    // Dedupe: skip if (artist, title) already in DB
    if (await isAlreadyImported(artistName, title)) {
      console.log(`  ⊘ skip (already imported): ${artistName} — ${title}`);
      moveToProcessed(filePath);
      continue;
    }

    const artists = artistName.split(/,\s*|&\s*|\s+feat\.?\s+/i).map(a => a.trim()).filter(Boolean);
    const primaryArtist = artists[0];
    const slug = slugify(primaryArtist);
    const trackId = randomUUID();
    const audioUrl = `/server/uploads/tracks/${encodeURIComponent(file)}`;

    // ─── Атомарная вставка артиста+трека в одной транзакции ───
    // Раньше: INSERT artist → cp file → ln → INSERT track → UPDATE cover.
    // Если падало между artist INSERT и track INSERT — оставался orphan
    // artist_profile без треков. Теперь всё в BEGIN/COMMIT, BEGIN-локально
    // на одном client'е (pool.connect — не pool.query).
    const client = await pool.connect();
    let finalArtistId = null;
    try {
      await client.query('BEGIN');
      const artistResult = await client.query(`
        INSERT INTO artist_profiles (id, user_id, slug, artist_name, genre)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (slug) DO UPDATE SET genre = COALESCE(NULLIF(artist_profiles.genre, ''), $5)
        RETURNING id
      `, [randomUUID(), SYSTEM_OWNER, slug, primaryArtist, genre]);
      finalArtistId = artistResult.rows[0].id;

      // Copy file BEFORE track INSERT — если cp падает, не записываем
      // в DB ссылку на несуществующий файл.
      const destPath = join(destDir, file);
      try {
        copyFileSync(filePath, destPath);
      } catch (e) {
        throw new Error(`copy ${file} failed: ${e.message}`);
      }

      await client.query(`
        INSERT INTO tracks (id, artist_id, user_id, title, artist_name, genre, duration, audio_url, release_date, moderation_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published')
        ON CONFLICT (id) DO NOTHING
      `, [
        trackId, finalArtistId, SYSTEM_OWNER,
        title, artistName, genre, duration, audioUrl,
        now.toISOString(),
      ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  ✗ ${artistName} — ${title} txn failed:`, e.message);
      client.release();
      continue;
    }
    client.release();

    // Extract cover art from MP3 (вне транзакции — best-effort enrichment,
    // если ffmpeg падает — трек уже опубликован без обложки, не блокер).
    // Cover slug includes trackId tail для уникальности: иначе два трека
    // с одинаковым title затирали бы обложку друг друга.
    const baseCoverSlug = slugify(title) || basename(file, extname(file)).replace(/^\d+\s*/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const coverSlug = `${baseCoverSlug}-${trackId.slice(0, 8)}`;
    const coverPath = join(coversDir, coverSlug + '.jpg');

    if (extractCover(filePath, coverPath)) {
      const coverUrl = '/server/uploads/covers/' + encodeURIComponent(coverSlug + '.jpg');
      await pool.query('UPDATE tracks SET cover_url = $1 WHERE id = $2', [coverUrl, trackId]);
      console.log(`  Cover extracted: ${coverSlug}.jpg`);
      // Also set as artist avatar if missing
      await pool.query(
        "UPDATE artist_profiles SET avatar_url = $1, cover_url = $1 WHERE id = $2 AND (avatar_url IS NULL OR avatar_url = '')",
        [coverUrl, finalArtistId]
      );
    }

    trackIds.push(trackId);
    console.log(`  ✓ ${artistName} — ${title} (${Math.floor(duration/60)}:${(duration%60).toString().padStart(2,'0')})`);
    // Move MP3 to processed/ so cron doesn't re-import it next week
    moveToProcessed(filePath);
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

  // Auto-generate radio pickups for new tracks
  const STATIONS = [
    { name: 'Европа Плюс', cities: ['Москва', 'Санкт-Петербург', 'Казань', 'Сочи'] },
    { name: 'Русское Радио', cities: ['Москва', 'Санкт-Петербург', 'Новосибирск', 'Краснодар'] },
    { name: 'DFM', cities: ['Москва', 'Санкт-Петербург', 'Казань', 'Новосибирск'] },
    { name: 'Хит FM', cities: ['Москва', 'Санкт-Петербург', 'Екатеринбург', 'Сочи'] },
    { name: 'Love Radio', cities: ['Москва', 'Санкт-Петербург', 'Екатеринбург', 'Казань'] },
    { name: 'Радио Energy', cities: ['Москва', 'Санкт-Петербург', 'Новосибирск', 'Краснодар'] },
    { name: 'Record', cities: ['Москва', 'Санкт-Петербург'] },
    { name: 'Наше Радио', cities: ['Москва', 'Санкт-Петербург'] },
  ];

  let pickupCount = 0;
  for (const tid of trackIds) {
    const count = 2 + Math.floor(Math.random() * 5);
    const shuffled = [...STATIONS].sort(() => Math.random() - 0.5).slice(0, count);
    for (const st of shuffled) {
      const city = st.cities[Math.floor(Math.random() * st.cities.length)];
      try {
        await pool.query(
          `INSERT INTO track_radio_pickups (track_id, station_name, city, country, source)
           VALUES ($1, $2, $3, 'Россия', 'auto') ON CONFLICT (track_id, station_name) DO NOTHING`,
          [tid, st.name, city]
        );
        pickupCount++;
      } catch {}
    }
  }
  console.log(`  📻 ${pickupCount} radio pickups generated`);

  console.log(`\n✅ Release created: ${releaseTitle}`);
  await addToRadioLibrary(weekNum, year);
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

  const trackCount = await pool.query(`SELECT COUNT(DISTINCT tid)::int AS count FROM weekly_releases wr, unnest(wr.track_ids) AS tid`);
  const artistCount = await pool.query(`SELECT COUNT(DISTINCT t.artist_id)::int AS count FROM weekly_releases wr, unnest(wr.track_ids) AS tid JOIN tracks t ON t.id = tid WHERE t.artist_id IS NOT NULL`);

  console.log(`\n  Total: ${trackCount.rows[0].count} tracks, ${artistCount.rows[0].count} artists\n`);
}


// ── Auto-add new tracks to radio_library (ПРОМО.ЭИР) ──
async function addToRadioLibrary(weekNumber, year) {
  const TARGET_DIR = '/mnt/data/promofm-music/tracks';
  try { mkdirSync(TARGET_DIR, { recursive: true }); } catch {}

  const r = await pool.query(
    `SELECT t.id, t.title, t.artist_name, t.genre, t.duration,
            regexp_replace(t.audio_url, '^.*?/uploads/tracks/', '') AS enc_filename
     FROM weekly_releases wr
     JOIN tracks t ON t.id = ANY(wr.track_ids)
     WHERE wr.week_number = $1 AND wr.year = $2
       AND t.audio_url IS NOT NULL AND t.audio_url <> ''`,
    [weekNumber, year]
  );
  let added = 0;
  for (const row of r.rows) {
    const decoded = decodeURIComponent(row.enc_filename || '');
    const src = join('/opt/promofm-api/uploads/tracks', decoded);
    if (!existsSync(src)) continue;
    const stdFilename = (`${row.artist_name} - ${row.title}.mp3`).replace(/\//g, '_');
    const dest = join(TARGET_DIR, stdFilename);
    if (!existsSync(dest)) {
      try { copyFileSync(src, dest); } catch (e) { console.error('copy fail:', e.message); continue; }
    }
    try {
      await pool.query(
        `INSERT INTO radio_library (filename, title, artist, genre, duration_seconds, region, is_vocal, file_path)
         VALUES ($1, $2, $3, $4, $5, 'Global', true, $6)
         ON CONFLICT (filename) DO UPDATE
           SET title = EXCLUDED.title, artist = EXCLUDED.artist,
               genre = EXCLUDED.genre, duration_seconds = EXCLUDED.duration_seconds,
               file_path = EXCLUDED.file_path`,
        [stdFilename, row.title, row.artist_name, row.genre || 'pop', row.duration || 180, dest]
      );
      added++;
    } catch (e) {
      console.error(`  ✗ radio_library insert "${stdFilename}":`, e.message);
    }
  }
  console.log(`  📻 ${added}/${r.rows.length} tracks added to radio_library`);
  return added;
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
