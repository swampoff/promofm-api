/**
 * RADIO PROMO.AIR — API Routes
 * Radio streaming management for promo-music.ru/air/
 * Public: status, now-playing, history, stats
 * Admin: library, queue, schedules, jingles, podcasts
 * Internal: report-play (AutoDJ callback)
 */
import { Hono } from "hono";
import { pool } from "./db-client.tsx";
import { requireAuth, requireAdmin } from "./auth-middleware.tsx";
import { createLogger } from "./logger.tsx";

const log = createLogger("air-routes");
const app = new Hono();

const STREAM_API = "http://127.0.0.1:8086";
const AUTODJ_API = "http://127.0.0.1:8087";

// ─── PUBLIC ENDPOINTS ───

app.get("/status", async (c) => {
  try {
    const res = await fetch(STREAM_API + "/status");
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ error: "Stream server unavailable" }, 503);
  }
});

app.get("/health", async (c) => {
  try {
    const res = await fetch(STREAM_API + "/health");
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ status: "offline", streaming: false, listeners: 0 }, 503);
  }
});

app.get("/now-playing", async (c) => {
  try {
    const res = await fetch(AUTODJ_API + "/api/status");
    const data = (await res.json()) as Record<string, any>;
    return c.json({
      station: "promo.fm",
      track: data.current_track || "Silence",
      info: data.current_track_info || {},
      queue_length: data.queue_length || 0,
      oracle: data.oracle || null,
    });
  } catch {
    return c.json({ station: "promo.fm", track: "Offline", info: {} }, 503);
  }
});

// Embeddable мини-плеер для сторонних сайтов (iframe 320×160).
// AirLivePage выдаёт пользователям embed-код с этим URL. Страница
// обязана открываться в чужом iframe → frame-ancestors * и exemption
// из глобального X-Frame-Options: DENY (см. index.ts security headers).
// ВАЖНО (nginx): location /server/api/air/embed не должен add_header
// X-Frame-Options — иначе iframe заблокирован независимо от Node.
app.get("/embed", (c) => {
  c.header("Content-Security-Policy", "frame-ancestors *");
  c.header("Cache-Control", "public, max-age=300");
  return c.html(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ПРОМО.ЭИР — прямой эфир</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{font:13px/1.4 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;
    background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);
    color:#fff;display:flex;align-items:center;padding:14px;gap:14px}
  #btn{flex:none;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;
    background:#e94b8a;color:#fff;font-size:22px;display:flex;
    align-items:center;justify-content:center;transition:transform .15s}
  #btn:hover{transform:scale(1.06)}
  .meta{min-width:0;flex:1}
  .brand{display:flex;align-items:center;gap:6px;font-weight:700;
    letter-spacing:.06em;font-size:12px;color:#f7a8c9}
  .dot{width:7px;height:7px;border-radius:50%;background:#4ade80;
    animation:pulse 1.6s infinite}
  @keyframes pulse{50%{opacity:.35}}
  #track{margin-top:5px;font-size:14px;font-weight:600;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  a{color:#9aa0ff;text-decoration:none;font-size:11px}
  a:hover{text-decoration:underline}
</style></head><body>
<button id="btn" aria-label="Слушать эфир">&#9654;</button>
<div class="meta">
  <div class="brand"><span class="dot"></span>ПРОМО.ЭИР &middot; LIVE</div>
  <div id="track">Прямой эфир promo.fm</div>
  <a href="https://promo-music.ru/air-live" target="_blank" rel="noopener">promo-music.ru/air-live &rarr;</a>
</div>
<script>
  var a=new Audio('/air/live/promo.fm'),btn=document.getElementById('btn'),
      tr=document.getElementById('track'),playing=false;
  a.preload='none';
  btn.onclick=function(){
    if(playing){a.pause();a.src='';a.src='/air/live/promo.fm';btn.innerHTML='&#9654;';playing=false;return}
    a.play().then(function(){btn.innerHTML='&#10074;&#10074;';playing=true})
      .catch(function(){tr.textContent='Эфир недоступен'});
  };
  function poll(){
    fetch('/server/api/air/now-playing').then(function(r){return r.json()})
      .then(function(d){
        var i=d.info||{};
        var s=(i.artist&&i.title)?i.artist+' — '+i.title:(d.track||'');
        if(s&&s!=='Silence'&&s!=='Offline')tr.textContent=s;
      }).catch(function(){});
  }
  poll();setInterval(poll,15000);
</script>
</body></html>`);
});

app.get("/history", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);
  try {
    const res = await pool.query(
      "SELECT id, filename, artist, title, listeners_count, played_at FROM radio_play_history ORDER BY played_at DESC LIMIT $1",
      [limit]
    );
    return c.json({ history: res.rows });
  } catch {
    return c.json({ history: [] });
  }
});

app.get("/stats", async (c) => {
  let totalPlays = 0;
  let librarySize = 0;
  let playsToday = 0;
  let streamHealth: Record<string, any> = { status: "offline" };

  try {
    const r1 = await pool.query("SELECT COUNT(*)::int AS cnt FROM radio_play_history");
    totalPlays = r1.rows[0].cnt;
    const r2 = await pool.query("SELECT COUNT(*)::int AS cnt FROM radio_library");
    librarySize = r2.rows[0].cnt;
    const r3 = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM radio_play_history WHERE played_at > NOW() - INTERVAL '1 day'"
    );
    playsToday = r3.rows[0].cnt;
  } catch (dbErr: any) {
    log.error({ err: dbErr.message }, "stats_db_error");
  }

  try {
    const sr = await fetch(STREAM_API + "/health");
    streamHealth = (await sr.json()) as Record<string, any>;
  } catch {
    /* stream offline */
  }

  return c.json({
    total_plays: totalPlays,
    library_size: librarySize,
    plays_today: playsToday,
    stream: streamHealth,
  });
});

// ─── INTERNAL ENDPOINT (AutoDJ callback) ───

app.post("/internal/report-play", async (c) => {
  const internalKey = c.req.header("X-Internal-Key");
  if (internalKey !== process.env.VPS_INTERNAL_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = (await c.req.json()) as Record<string, any>;
  try {
    await pool.query(
      "INSERT INTO radio_play_history (filename, artist, title, listeners_count) VALUES ($1, $2, $3, $4)",
      [body.filename || "unknown", body.artist || null, body.title || null, body.listeners_count || 0]
    );
    if (body.filename) {
      await pool.query(
        "UPDATE radio_library SET play_count = play_count + 1, last_played_at = NOW() WHERE filename = $1",
        [body.filename]
      );
    }
    return c.json({ success: true });
  } catch (err: any) {
    log.error({ err: err.message }, "report_play_error");
    return c.json({ error: "Failed to record play" }, 500);
  }
});

// ─── ADMIN ENDPOINTS ───

app.get("/library", requireAuth, requireAdmin, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "100"), 500);
  const offset = parseInt(c.req.query("offset") || "0");
  try {
    const res = await pool.query("SELECT * FROM radio_library ORDER BY created_at DESC LIMIT $1 OFFSET $2", [limit, offset]);
    const countRes = await pool.query("SELECT COUNT(*)::int AS cnt FROM radio_library");
    return c.json({ tracks: res.rows, total: countRes.rows[0].cnt });
  } catch {
    return c.json({ tracks: [], total: 0 });
  }
});

app.post("/library", requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json()) as Record<string, any>;
  try {
    const res = await pool.query(
      `INSERT INTO radio_library (filename, title, artist, genre, bpm, key, energy, duration_seconds, region, is_vocal, file_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (filename) DO UPDATE SET
         title=EXCLUDED.title, artist=EXCLUDED.artist, genre=EXCLUDED.genre,
         bpm=EXCLUDED.bpm, key=EXCLUDED.key, energy=EXCLUDED.energy,
         duration_seconds=EXCLUDED.duration_seconds, updated_at=NOW()
       RETURNING *`,
      [body.filename, body.title, body.artist, body.genre, body.bpm, body.key,
       body.energy, body.duration_seconds, body.region || "Global",
       body.is_vocal !== false, body.file_path]
    );
    return c.json({ success: true, track: res.rows[0] });
  } catch (err: any) {
    log.error({ err: err.message }, "library_insert_error");
    return c.json({ error: "Failed to add track" }, 500);
  }
});

app.put("/library/:id", requireAuth, requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as Record<string, any>;
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const key of ["title", "artist", "genre", "bpm", "key", "energy", "duration_seconds", "region", "is_vocal"]) {
    if (body[key] !== undefined) {
      fields.push(key + " = $" + idx);
      values.push(body[key]);
      idx++;
    }
  }
  if (fields.length === 0) return c.json({ error: "No fields to update" }, 400);
  fields.push("updated_at = NOW()");
  values.push(id);
  try {
    const res = await pool.query("UPDATE radio_library SET " + fields.join(", ") + " WHERE id = $" + idx + " RETURNING *", values);
    return c.json({ success: true, track: res.rows[0] || null });
  } catch (err: any) {
    return c.json({ error: "Failed to update track" }, 500);
  }
});

app.delete("/library/:id", requireAuth, requireAdmin, async (c) => {
  const id = c.req.param("id");
  try {
    await pool.query("DELETE FROM radio_library WHERE id = $1", [id]);
    return c.json({ success: true });
  } catch {
    return c.json({ error: "Failed to delete" }, 500);
  }
});

// Queue (proxy to AutoDJ)
app.get("/queue", requireAuth, requireAdmin, async (c) => {
  try {
    const res = await fetch(AUTODJ_API + "/api/queue");
    return c.json(await res.json());
  } catch {
    return c.json({ queue: [] }, 503);
  }
});

app.post("/queue/add", requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json();
  try {
    const res = await fetch(AUTODJ_API + "/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "AutoDJ unavailable" }, 503);
  }
});

app.post("/queue/clear", requireAuth, requireAdmin, async (c) => {
  try {
    const res = await fetch(AUTODJ_API + "/api/clear_queue", { method: "POST" });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "AutoDJ unavailable" }, 503);
  }
});

app.post("/skip", requireAuth, requireAdmin, async (c) => {
  try {
    const res = await fetch(AUTODJ_API + "/api/skip", { method: "POST" });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "AutoDJ unavailable" }, 503);
  }
});

// Jingles
app.get("/jingles", requireAuth, requireAdmin, async (c) => {
  try {
    const res = await pool.query("SELECT * FROM radio_jingles ORDER BY created_at DESC");
    return c.json({ jingles: res.rows });
  } catch {
    return c.json({ jingles: [] });
  }
});

app.post("/jingles", requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json()) as Record<string, any>;
  try {
    const res = await pool.query(
      "INSERT INTO radio_jingles (name, file_path, duration_seconds, category, play_frequency) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [body.name, body.file_path, body.duration_seconds, body.category || "general", body.play_frequency || 5]
    );
    return c.json({ success: true, jingle: res.rows[0] });
  } catch {
    return c.json({ error: "Failed to add jingle" }, 500);
  }
});

// Podcasts
app.get("/podcasts", requireAuth, requireAdmin, async (c) => {
  try {
    const res = await pool.query("SELECT * FROM radio_podcasts ORDER BY created_at DESC");
    return c.json({ podcasts: res.rows });
  } catch {
    return c.json({ podcasts: [] });
  }
});

app.post("/podcasts", requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json()) as Record<string, any>;
  try {
    const res = await pool.query(
      "INSERT INTO radio_podcasts (title, description, file_path, duration_seconds, host_name, episode_number, series_name, scheduled_time, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [body.title, body.description, body.file_path, body.duration_seconds,
       body.host_name, body.episode_number, body.series_name,
       body.scheduled_time, body.status || "pending"]
    );
    return c.json({ success: true, podcast: res.rows[0] });
  } catch {
    return c.json({ error: "Failed to add podcast" }, 500);
  }
});

// Schedules
app.get("/schedules", requireAuth, requireAdmin, async (c) => {
  try {
    const res = await pool.query("SELECT * FROM radio_schedules ORDER BY created_at DESC");
    return c.json({ schedules: res.rows });
  } catch {
    return c.json({ schedules: [] });
  }
});

app.post("/schedules", requireAuth, requireAdmin, async (c) => {
  const body = (await c.req.json()) as Record<string, any>;
  try {
    const res = await pool.query(
      "INSERT INTO radio_schedules (schedule_type, title, description, file_path, cron_expression, is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [body.schedule_type, body.title, body.description, body.file_path, body.cron_expression, body.is_active !== false]
    );
    return c.json({ success: true, schedule: res.rows[0] });
  } catch {
    return c.json({ error: "Failed to create schedule" }, 500);
  }
});


// ─── SYNC: Import platform tracks into radio library ───

app.post("/library/sync", async (c) => {
  const internalKey = c.req.header("X-Internal-Key");
  if (internalKey !== process.env.VPS_INTERNAL_KEY) {
    return c.json({ error: "unauthorized" }, 401);
  }

  try {
    const { rows: platformTracks } = await pool.query(`
      SELECT t.id, t.title, t.artist_name, t.audio_url, t.genre, t.duration, t.city
      FROM tracks t
      WHERE t.audio_url IS NOT NULL
        AND t.audio_url != ''
        AND t.moderation_status = 'approved'
        AND t.is_hidden = false
        AND (t.is_ai_generated IS NULL OR t.is_ai_generated = false)
        AND NOT EXISTS (
          SELECT 1 FROM radio_library rl 
          WHERE rl.filename = regexp_replace(t.audio_url, '^.*/', '')
        )
    `);

    if (platformTracks.length === 0) {
      return c.json({ success: true, synced: 0, message: "All tracks already in radio library" });
    }

    const path = await import("path");
    const fs = await import("fs");
    const RADIO_TRACKS_DIR = "/mnt/data/promofm-music/tracks";
    const UPLOADS_DIR = "/opt/promofm-api/uploads/tracks";
    let synced = 0;
    const errors: string[] = [];

    for (const track of platformTracks) {
      try {
        let srcPath = "";
        const audioUrl = track.audio_url as string;

        if (audioUrl.startsWith("/server/uploads/tracks/")) {
          const filename = decodeURIComponent(audioUrl.replace("/server/uploads/tracks/", ""));
          srcPath = path.join(UPLOADS_DIR, filename);
        } else if (audioUrl.startsWith("https://promo-music.ru/uploads/track-audio/")) {
          const filename = decodeURIComponent(audioUrl.replace("https://promo-music.ru/uploads/track-audio/", ""));
          srcPath = path.join("/opt/promofm-api/uploads/track-audio", filename);
        } else {
          errors.push("Unknown audio_url format: " + audioUrl);
          continue;
        }

        if (!fs.existsSync(srcPath)) {
          errors.push("File not found: " + srcPath);
          continue;
        }

        const artist = (track.artist_name || "Unknown").replace(/[\/\\]/g, "-");
        const title = (track.title || "Untitled").replace(/[\/\\]/g, "-");
        const radioFilename = artist + " - " + title + ".mp3";
        const destPath = path.join(RADIO_TRACKS_DIR, radioFilename);

        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(srcPath, destPath);
        }

        await pool.query(
          `INSERT INTO radio_library (filename, title, artist, genre, duration_seconds, region, is_vocal, file_path)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7)
           ON CONFLICT (filename) DO NOTHING`,
          [radioFilename, track.title, track.artist_name, track.genre, track.duration || 0, track.city || "Global", destPath]
        );

        synced++;
        log.info({ track: radioFilename }, "synced_track_to_radio");
      } catch (trackErr: any) {
        errors.push(track.title + ": " + trackErr.message);
      }
    }

    return c.json({
      success: true,
      synced,
      total_platform: platformTracks.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    log.error({ err: err.message }, "sync_error");
    return c.json({ error: err.message }, 500);
  }
});

export default app;
