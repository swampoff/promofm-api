/**
 * AI-check pipeline — runs promofm-ai-detector.service on each new
 * track upload and persists the verdict to track_moderation.
 *
 * Architecture: fire-and-forget from POST /tracks. The artist's
 * upload response is NOT blocked by the ~15s analyzer round-trip.
 * Results land in (track_moderation native cols since migration 052):
 *   - ai_check_status        — 'pending' | 'likely_ai' | 'likely_human' | 'error' | …
 *   - ai_check_started_at    — timestamptz
 *   - ai_check_finished_at   — timestamptz
 *   - ai_check_error         — text (only on error)
 *   - ai_check_result        — jsonb (legit nested analyzer breakdown)
 * Also mirrored into tracks.data->aiCheck (jsonb, for cabinet UI).
 *
 * Detector contract (POST 127.0.0.1:8085/analyze):
 *   body: { file_path: string, track_id?: string }
 *   response: { ai_score, confidence, verdict, breakdown, analysis_time_seconds, analyzer_version }
 */

import { pool } from './db-client.tsx';

const AI_DETECTOR_URL = process.env.AI_DETECTOR_URL || 'http://127.0.0.1:8085';
const AI_DETECTOR_TIMEOUT_MS = 90_000;

/**
 * Resolve a public audio_url (https://promo-music.ru/uploads/...) into
 * the absolute filesystem path the analyzer can open.
 * nginx serves /uploads/ from /var/www/promofm/uploads/.
 * Returns null if the URL doesn't match a known mount.
 */
function audioUrlToFilePath(audioUrl: string): string | null {
  if (!audioUrl) return null;

  // Strip scheme + host for any promo-music.ru variant
  const path = audioUrl
    .replace(/^https?:\/\/(www\.)?promo-music\.ru/, '')
    .replace(/^https?:\/\/(www\.)?promofm\.org/, '')
    .replace(/^https?:\/\/promofm\.ru/, '');

  // Already a relative path? Use as-is.
  const relPath = path.startsWith('/') ? path : '/' + path;

  // nginx alias map (verified on prod 2026-05-23):
  //   /uploads/...  →  /var/www/promofm/uploads/...
  //   /server/uploads/...  →  /opt/promofm-api/uploads/...
  if (relPath.startsWith('/uploads/')) {
    return '/var/www/promofm' + relPath;
  }
  if (relPath.startsWith('/server/uploads/')) {
    return '/opt/promofm-api' + relPath.replace('/server', '');
  }
  // External / unknown — analyzer can't reach it locally
  return null;
}

interface AnalysisResult {
  ai_score: number;
  confidence: number;
  verdict: string;
  breakdown: Record<string, number>;
  analysis_time_seconds: number;
  analyzer_version: string;
}

/**
 * Fire-and-forget background AI check. Logs but never throws.
 * Call from POST /tracks after track row is created.
 */
export function scheduleAiCheck(trackId: string, audioUrl: string | null): void {
  if (!trackId || !audioUrl) return;
  const filePath = audioUrlToFilePath(audioUrl);
  if (!filePath) {
    console.log(`[ai-check] skip ${trackId}: external audio_url ${audioUrl}`);
    return;
  }

  // Detach so the calling request returns immediately.
  setImmediate(() => {
    runAiCheck(trackId, filePath).catch((err) => {
      console.error(`[ai-check] background run failed for ${trackId}:`, err?.message || err);
    });
  });
}

export async function runAiCheck(trackId: string, filePath: string): Promise<AnalysisResult | null> {
  const started = Date.now();
  console.log(`[ai-check] start ${trackId} → ${filePath}`);

  // Mark pending so admin UI can show progress
  try {
    await pool.query(
      `INSERT INTO track_moderation
         (id, track_id, ai_check_status, ai_check_started_at, created_at, updated_at)
       VALUES ($1, $2, 'pending', NOW(), NOW(), NOW())
       ON CONFLICT (id) DO UPDATE
         SET ai_check_status     = 'pending',
             ai_check_started_at = NOW(),
             updated_at          = NOW()`,
      [`ai_${trackId}`, trackId],
    );
  } catch (e: any) {
    console.warn(`[ai-check] pending-row insert failed for ${trackId}: ${e?.message || e}`);
  }

  // Run analyzer with timeout
  let result: AnalysisResult;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), AI_DETECTOR_TIMEOUT_MS);
    const r = await fetch(`${AI_DETECTOR_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: filePath, track_id: trackId }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`analyzer HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }
    result = (await r.json()) as AnalysisResult;
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    console.error(`[ai-check] analyzer error for ${trackId}: ${errMsg}`);
    try {
      await pool.query(
        `UPDATE track_moderation
            SET ai_check_status      = 'error',
                ai_check_error       = $2,
                ai_check_finished_at = NOW(),
                updated_at           = NOW()
          WHERE id = $1`,
        [`ai_${trackId}`, errMsg],
      );
    } catch {}
    return null;
  }

  // Persist
  const verdict = result.verdict || 'unknown';
  try {
    await pool.query(
      `UPDATE track_moderation
          SET ai_check_status      = $2,
              ai_check_result      = $3::jsonb,
              ai_check_finished_at = NOW(),
              updated_at           = NOW()
        WHERE id = $1`,
      [`ai_${trackId}`, verdict, JSON.stringify(result)],
    );
    await pool.query(
      `UPDATE tracks
          SET data = COALESCE(data, '{}'::jsonb)
                     || jsonb_build_object('aiCheck', $2::jsonb),
              updated_at = now()
        WHERE id = $1`,
      [trackId, JSON.stringify(result)],
    );
  } catch (e: any) {
    console.error(`[ai-check] persist failed for ${trackId}: ${e?.message || e}`);
  }

  console.log(
    `[ai-check] done ${trackId} verdict=${verdict} score=${result.ai_score} conf=${result.confidence} (${Date.now() - started}ms)`,
  );
  return result;
}

/**
 * Backfill — runs AI-check for tracks that already have audio_url but
 * never received an ai_check_status row. Used by admin endpoint.
 * Returns count enqueued; the actual runs happen in background.
 */
export async function backfillAiCheck(limit: number = 50): Promise<number> {
  const { rows } = await pool.query<{ id: string; audio_url: string }>(
    `SELECT t.id, t.audio_url
       FROM tracks t
       LEFT JOIN track_moderation tm ON tm.id = 'ai_' || t.id
      WHERE t.audio_url IS NOT NULL AND t.audio_url <> ''
        AND tm.id IS NULL
      ORDER BY t.created_at DESC
      LIMIT $1`,
    [limit],
  );
  for (const t of rows) {
    scheduleAiCheck(t.id, t.audio_url);
  }
  console.log(`[ai-check] backfill enqueued ${rows.length} tracks`);
  return rows.length;
}
