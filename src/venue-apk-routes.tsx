/**
 * VENUE-APK ROUTES — Android player app metadata + download endpoint.
 *
 * MVP: backend exposes metadata about the current APK release
 * (version, sha256, min Android, changelog, file URL). Admin uploads
 * a new APK build via POST /admin/apk-info → file lands in
 * /opt/promofm-api/uploads/apk/, metadata recorded in system_config
 * jsonb store. Venue cabinet reads /info to render the «Скачать
 * приложение» button.
 *
 * Static file is served by the existing
 * STATIC_UPLOAD_SUBDIRS pipeline in src/index.ts — venue users
 * download from /server/uploads/apk/<filename>.
 *
 * When no APK has been uploaded yet, GET /info returns
 * `{ available: false }` so the cabinet renders a «скоро будет»
 * banner instead of a dead link.
 *
 * Scope: VENUE only. Mounted at /server/api/venue-apk.
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import { existsSync, mkdirSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { getSystemConfig, upsertSystemConfig } from './db.tsx';
import { safeErrorMessage } from './security.tsx';

const app = new Hono();

const APK_DIR = '/opt/promofm-api/uploads/apk';
const APK_CONFIG_KEY = 'venue_apk_release';
const MAX_APK_BYTES = 200 * 1024 * 1024;        // 200 MiB — generous, Android APKs typically 20-80 MiB

interface ApkReleaseMeta {
  available: boolean;
  filename: string | null;
  version: string | null;           // e.g. "1.0.3"
  versionCode: number | null;       // Android versionCode
  sha256: string | null;            // hex digest of the .apk file
  bytes: number | null;
  minAndroidSdk: number | null;     // e.g. 24 (Android 7.0)
  releaseNotes: string | null;
  releasedAt: string | null;
  downloadUrl: string | null;       // /server/uploads/apk/<filename>
}

const DEFAULT_META: ApkReleaseMeta = {
  available: false,
  filename: null,
  version: null,
  versionCode: null,
  sha256: null,
  bytes: null,
  minAndroidSdk: null,
  releaseNotes: null,
  releasedAt: null,
  downloadUrl: null,
};

async function readMeta(): Promise<ApkReleaseMeta> {
  try {
    const stored = await getSystemConfig<any>(APK_CONFIG_KEY);
    if (!stored) return { ...DEFAULT_META };
    return { ...DEFAULT_META, ...stored };
  } catch (err) {
    console.error('[venue-apk] readMeta failed:', err);
    return { ...DEFAULT_META };
  }
}

async function writeMeta(meta: ApkReleaseMeta): Promise<void> {
  await upsertSystemConfig(APK_CONFIG_KEY, meta);
}

// ──────────────────────────────────────────────────────────────────
// GET /info — public read (auth still required for cabinet
// integration consistency; APK download URL itself is open static).
// ──────────────────────────────────────────────────────────────────
app.get('/info', requireAuth, async (c) => {
  try {
    const meta = await readMeta();
    return c.json({ success: true, ...meta });
  } catch (error: any) {
    console.error('GET /venue-apk/info:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// Same as /info but no auth — for the public download landing page
// and for the actual Android device pulling metadata at first boot.
app.get('/public-info', async (c) => {
  try {
    const meta = await readMeta();
    return c.json({ success: true, ...meta });
  } catch (error: any) {
    console.error('GET /venue-apk/public-info:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /admin/upload — replace the current APK release.
// Multipart/form-data: file=<.apk> + version + minAndroidSdk +
// releaseNotes. Stamps sha256 + bytes + releasedAt server-side.
// ──────────────────────────────────────────────────────────────────
app.post('/admin/upload', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.parseBody().catch(() => null);
    const file = body?.file as File | undefined;
    if (!file || typeof (file as any).arrayBuffer !== 'function') {
      return c.json({ success: false, error: 'file is required (multipart/form-data)' }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.byteLength === 0) {
      return c.json({ success: false, error: 'File is empty' }, 400);
    }
    if (buf.byteLength > MAX_APK_BYTES) {
      return c.json({
        success: false,
        error: `File too large (${Math.round(buf.byteLength / 1024 / 1024)} MiB). Max 200 MiB.`,
      }, 413);
    }
    // Sanity check: real APK files start with a ZIP magic (PK\x03\x04).
    // Catches obviously-wrong uploads (HTML, ZIPless container).
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B || buf[2] !== 0x03 || buf[3] !== 0x04) {
      return c.json({
        success: false,
        error: 'Doesn\'t look like a valid APK (missing ZIP magic at offset 0)',
      }, 400);
    }

    const version = String((body as any).version || '').trim();
    if (!version || !/^\d+\.\d+(\.\d+)?$/.test(version)) {
      return c.json({ success: false, error: 'version is required (e.g. "1.0.3")' }, 400);
    }
    const versionCode = Number((body as any).versionCode);
    const minAndroidSdk = Number((body as any).minAndroidSdk) || 24;
    const releaseNotes = String((body as any).releaseNotes || '').trim() || null;

    if (!existsSync(APK_DIR)) mkdirSync(APK_DIR, { recursive: true });

    // Stable filename so /server/uploads/apk/<filename> doesn't
    // change across releases (venues can bookmark it). Old file is
    // overwritten — previous metadata kept in audit_logs would be a
    // nice next step but out of scope for the pilot.
    const filename = 'promofm-venue-player.apk';
    const filePath = join(APK_DIR, filename);

    // Drop old file if present so writeFileSync doesn't leave a
    // hardlink hanging if filesystems are doing copy-on-write tricks.
    if (existsSync(filePath)) {
      try { unlinkSync(filePath); } catch { /* permissions issue is bubbled by the write below */ }
    }
    writeFileSync(filePath, buf);

    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const baseUrl = process.env.PUBLIC_BASE_URL || '';
    const downloadUrl = `${baseUrl}/server/uploads/apk/${filename}`;

    const meta: ApkReleaseMeta = {
      available: true,
      filename,
      version,
      versionCode: Number.isFinite(versionCode) ? versionCode : null,
      sha256,
      bytes: buf.byteLength,
      minAndroidSdk,
      releaseNotes,
      releasedAt: new Date().toISOString(),
      downloadUrl,
    };
    await writeMeta(meta);

    return c.json({ success: true, release: meta });
  } catch (error: any) {
    console.error('POST /venue-apk/admin/upload:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /admin/info — update metadata WITHOUT re-uploading the file
// (e.g. fix a typo in release notes). Keeps everything else intact.
app.put('/admin/info', requireAuth, requireAdmin, async (c) => {
  try {
    const cur = await readMeta();
    if (!cur.available) {
      return c.json({ success: false, error: 'No APK uploaded yet' }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const next: ApkReleaseMeta = {
      ...cur,
      version:        body.version        !== undefined ? String(body.version)        : cur.version,
      versionCode:    body.versionCode    !== undefined ? Number(body.versionCode)    : cur.versionCode,
      minAndroidSdk:  body.minAndroidSdk  !== undefined ? Number(body.minAndroidSdk)  : cur.minAndroidSdk,
      releaseNotes:   body.releaseNotes   !== undefined ? (String(body.releaseNotes) || null) : cur.releaseNotes,
    };
    await writeMeta(next);
    return c.json({ success: true, release: next });
  } catch (error: any) {
    console.error('PUT /venue-apk/admin/info:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /admin/release — wipe the current release (debug / rollback).
// File on disk gets deleted; metadata flag flips to available=false.
app.delete('/admin/release', requireAuth, requireAdmin, async (c) => {
  try {
    const cur = await readMeta();
    if (cur.filename) {
      const filePath = join(APK_DIR, cur.filename);
      if (existsSync(filePath)) {
        try { unlinkSync(filePath); } catch (e) { console.warn('[venue-apk] file unlink failed:', (e as any)?.message); }
      }
    }
    await writeMeta({ ...DEFAULT_META });
    return c.json({ success: true });
  } catch (error: any) {
    console.error('DELETE /venue-apk/admin/release:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /admin/connected-devices — admin tool: list every paired
// venue device with its last-seen timestamp + which venue / location
// it belongs to. Built on top of the existing venue_station_streams
// table — no new schema needed.
app.get('/admin/connected-devices', requireAuth, requireAdmin, async (c) => {
  try {
    const { pool } = await import('./db-client.tsx');
    const r = await pool.query(
      `SELECT s.id, s.venue_id, s.location_id, s.user_id, s.status,
              s.paired_at, s.paired_device_info, s.last_seen_at,
              vp.data->>'venueName' AS venue_name,
              vp.data->>'city'      AS venue_city,
              u.email               AS email
         FROM venue_station_streams s
         LEFT JOIN venue_profiles vp ON vp.user_id = s.user_id
         LEFT JOIN users u           ON u.id::text = s.user_id
        WHERE s.paired_at IS NOT NULL
        ORDER BY s.last_seen_at DESC NULLS LAST, s.paired_at DESC
        LIMIT 500`
    );
    const devices = r.rows.map((row: any) => ({
      streamId:        row.id,
      venueId:         row.venue_id,
      locationId:      row.location_id,
      userId:          row.user_id,
      status:          row.status,
      pairedAt:        row.paired_at,
      lastSeenAt:      row.last_seen_at,
      deviceModel:     row.paired_device_info?.model || null,
      androidVer:      row.paired_device_info?.androidVer || null,
      appVer:          row.paired_device_info?.appVer || null,
      venueName:       row.venue_name,
      venueCity:       row.venue_city,
      email:           row.email,
    }));
    return c.json({ success: true, devices });
  } catch (error: any) {
    console.error('GET /venue-apk/admin/connected-devices:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
