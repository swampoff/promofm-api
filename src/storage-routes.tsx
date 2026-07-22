/**
 * STORAGE API ROUTES
 * REST API для управления файлами (local filesystem)
 */

import { Hono } from 'hono';
import {
  initializeStorage,
  uploadFile,
  getSignedUrl,
  deleteFile,
  listFiles,
  getStorageStats,
  generateUniqueFilename,
  validateFileType,
  getBucketConfig,
  BUCKET_NAMES,
} from './storage-setup.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { safeErrorMessage } from './security.tsx';
import { spawnSync } from 'child_process';
import { join } from 'path';
// file-type loaded dynamically in upload handler

const storage = new Hono();

// Buckets a regular authenticated user (artist) is allowed to write to.
// Everything else (attachments, concert-banners, banner-images, misc)
// requires admin/moderator role. `attachments` is marked private and
// must never be writable by an arbitrary artist.
//
// news-images открыт артистам 2026-07-02: артисты теперь создают свои
// новости (news-page.tsx -> POST /api/news), и обложка грузится сюда.
// До этого артистский аплоад обложки получал 403 — фича новостей
// целиком жила в localStorage и этого никто не видел.
const ARTIST_WRITABLE_BUCKETS = new Set([
  'track-covers',
  'track-audio',
  'artist-avatars',
  'video-files',
  'video-thumbnails',
  'news-images',
]);
const PRIVILEGED_ROLES = new Set(['admin', 'superadmin', 'moderator']);

// Initialize storage buckets on server start
let storageInitialized = false;

async function ensureStorageInitialized() {
  if (!storageInitialized) {
    console.log('Initializing Local Storage...');
    const result = await initializeStorage();
    
    if (result.success) {
      console.log('Storage initialized successfully');
      if (result.bucketsCreated.length > 0) {
        console.log('Buckets created:', result.bucketsCreated);
      } else {
        console.log('Storage ready');
      }
      storageInitialized = true;
    } else {
      // Only show errors if there are actual errors (not just "already exists")
      if (result.errors.length > 0) {
        console.warn('Storage initialization had issues:', result.errors);
        console.warn('Continuing with degraded storage functionality');
        // Don't fail - mark as initialized to prevent retry loops
        storageInitialized = true;
      } else {
        console.log('Storage initialized (all buckets already exist)');
        storageInitialized = true;
      }
    }
    
    return result;
  }
  return { success: true, bucketsCreated: [], errors: [] };
}

// Initialize storage on first request (lazy init)
storage.use('*', async (c, next) => {
  await ensureStorageInitialized();
  await next();
});

// Get storage initialization status
storage.get('/status', requireAuth, async (c) => {
  try {
    const result = await ensureStorageInitialized();
    
    return c.json({
      success: true,
      initialized: storageInitialized,
      ...result,
    });
  } catch (error) {
    console.error('Error checking storage status:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to check status',
    }, 500);
  }
});

// Get storage statistics
storage.get('/stats', requireAuth, async (c) => {
  try {
    const result = await getStorageStats();
    
    if (!result.success) {
      return c.json({
        success: false,
        error: result.error,
      }, 500);
    }
    
    return c.json({
      success: true,
      stats: result.stats,
    });
  } catch (error) {
    console.error('Error getting storage stats:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get stats',
    }, 500);
  }
});

// List available buckets
storage.get('/buckets', requireAuth, (c) => {
  return c.json({
    success: true,
    buckets: BUCKET_NAMES,
  });
});

// Upload file
storage.post('/upload', requireAuth, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body['file'] as File;
    const bucketName = body['bucket'] as string;
    const path = body['path'] as string || '';
    
    if (!file) {
      return c.json({
        success: false,
        error: 'No file provided',
      }, 400);
    }
    
    if (!bucketName) {
      return c.json({
        success: false,
        error: 'Bucket name is required',
      }, 400);
    }
    
    // Validate bucket exists
    const bucketConfig = getBucketConfig(bucketName);
    if (!bucketConfig) {
      return c.json({
        success: false,
        error: 'Invalid bucket name',
      }, 400);
    }

    // Bucket ACL: artists may only target the artist-writable whitelist.
    // Privileged roles (admin/superadmin/moderator) may upload anywhere.
    const role = c.get('userRole');
    if (!ARTIST_WRITABLE_BUCKETS.has(bucketName) && !PRIVILEGED_ROLES.has(role)) {
      return c.json({
        success: false,
        error: 'Access denied: not allowed to upload to this bucket',
      }, 403);
    }

    // Prevent path traversal: subpath must not escape the bucket subdir
    if (path && (path.includes('..') || path.startsWith('/'))) {
      return c.json({
        success: false,
        error: 'Invalid path',
      }, 400);
    }
    
    // Validate file type
    if (!validateFileType(file.name, bucketConfig.allowedMimeTypes)) {
      return c.json({
        success: false,
        error: `File type not allowed. Allowed types: ${bucketConfig.allowedMimeTypes.join(', ')}`,
      }, 400);
    }
    
    // Validate file content (magic bytes) — defense-in-depth.
    //
    // The `file-type` library normalizes MIME to its own canonical set,
    // which doesn't always match what we list in allowedMimeTypes. For
    // WAV specifically, file-type returns `audio/vnd.wave` while our
    // bucket whitelist has `audio/wav` / `audio/x-wav` (the de-facto
    // forms browsers send). A strict mime-only compare rejected legit
    // uploads with "File content does not match declared type" — the
    // exact toast artists were hitting on WAV submissions.
    //
    // Accept the file if EITHER side matches: canonical mime OR the
    // detected extension lands in the allowed-extensions set derived
    // from the whitelist. Still blocks real mismatches (e.g. a PNG
    // renamed to .wav — file-type would detect ext=png, no match).
    const fileData = Buffer.from(await file.arrayBuffer());
    const fileType: any = await import("file-type");
    const fromBuf = fileType.fileTypeFromBuffer || fileType.fromBuffer || fileType.default?.fromBuffer;
    const detectedType = fromBuf ? await fromBuf(fileData) : null;
    // Magic bytes undetectable (detectedType===null) for a bucket that
    // pins a concrete MIME whitelist. file-type couldn't recognize the
    // content, so we CANNOT trust the extension/declared type — reject
    // rather than fall through and store an unverified payload. '*'
    // buckets (anything-goes) are intentionally exempt.
    if (!detectedType && bucketConfig.allowedMimeTypes.length > 0 && !bucketConfig.allowedMimeTypes.includes('*')) {
      console.warn('[storage] Magic bytes undetectable for restricted bucket:', {
        claimed:  file.type,
        filename: file.name,
        bucket:   bucketName,
      });
      return c.json({ success: false, error: 'File content does not match declared type' }, 400);
    }
    if (detectedType && bucketConfig.allowedMimeTypes.length > 0 && !bucketConfig.allowedMimeTypes.includes('*')) {
      // Normalize MIME subtype → file extension. `audio/mpeg` → `mp3`,
      // `audio/x-wav` → `wav`, `audio/x-m4a` → `m4a` etc. file-type's
      // detected.ext uses the canonical extension form, so without this
      // mapping a perfectly valid WAV got rejected because the subtype
      // in the whitelist (`x-wav` / `vnd.wave`) didn't equal the ext.
      const MIME_SUBTYPE_TO_EXT: Record<string, string> = {
        'mpeg':     'mp3',
        'vnd.wave': 'wav',
        'wave':     'wav',
      };
      const allowedExts = bucketConfig.allowedMimeTypes
        .map((m: string) => m.split('/').pop() || '')
        .map((s: string) => s.replace(/^x-/, ''))
        .map((s: string) => MIME_SUBTYPE_TO_EXT[s] || s)
        .filter(Boolean);

      const mimeMatch = bucketConfig.allowedMimeTypes.includes(detectedType.mime);
      const extMatch  = !!detectedType.ext && allowedExts.includes(detectedType.ext);

      if (!mimeMatch && !extMatch) {
        console.warn('[storage] Magic bytes mismatch:', {
          claimed:   file.type,
          detected:  detectedType.mime,
          ext:       detectedType.ext,
          filename:  file.name,
          bucket:    bucketName,
          allowedExts,
        });
        return c.json({ success: false, error: 'File content does not match declared type' }, 400);
      }
    }

    // Validate file size
    if (file.size > bucketConfig.fileSizeLimit) {
      const limitMB = (bucketConfig.fileSizeLimit / (1024 * 1024)).toFixed(1);
      return c.json({
        success: false,
        error: `File too large. Maximum size: ${limitMB}MB`,
      }, 400);
    }
    
    // Generate unique filename
    const filename = generateUniqueFilename(file.name, path);
    
    // Upload file
    // fileData already declared above (magic bytes check)
    // ClamAV virus scan (if available)
    try {
      const tmpPath = join('/tmp', 'upload_scan_' + Date.now() + '_' + filename.replace(/\//g, '_'));
      const { writeFileSync, unlinkSync } = await import('fs');
      writeFileSync(tmpPath, fileData);
      // ClamAV scan timeout. Default 30s is too tight for big audio /
      // video uploads on slower disks — bumped to 90s and made env-tunable
      // (CLAMSCAN_TIMEOUT_MS) so prod can adjust without a code change.
      // We disable the scan entirely if CLAMSCAN_TIMEOUT_MS === '0'.
      const scanTimeoutMs = Number(process.env.CLAMSCAN_TIMEOUT_MS ?? 90000);
      if (scanTimeoutMs <= 0) {
        // Skip silently — operator opted out.
        try { unlinkSync(tmpPath); } catch {}
      } else {
        const scanResult = spawnSync('clamscan', ['--no-summary', tmpPath], { timeout: scanTimeoutMs, encoding: 'utf8' });
        unlinkSync(tmpPath);
        if (scanResult.status === 1) {
          console.error('[storage] VIRUS DETECTED:', { filename, output: scanResult.stdout?.trim() });
          return c.json({ success: false, error: 'File rejected by security scan' }, 400);
        }
        if ((scanResult.error as any)?.code === 'ETIMEDOUT' || (scanResult as any).signal === 'SIGTERM') {
          // clamscan ran past the timeout — log loudly but DON'T block the
          // upload. Otherwise a slow disk locks artists out of publishing.
          console.warn('[storage] ClamAV timed out after', scanTimeoutMs, 'ms — accepting upload anyway:', filename);
        } else if (scanResult.error) {
          // spawnSync failed to even run clamscan (binary missing → ENOENT,
          // EACCES, etc.). This branch used to be silently skipped: status
          // is null, no exception is thrown, so NONE of the guards above
          // fired and the upload proceeded UNSCANNED without a trace.
          // Scan is best-effort (fail-open), but this MUST be loud so ops
          // notices the scanner is down instead of it failing invisibly.
          console.error('[storage] ClamAV scan UNAVAILABLE — upload accepted UNSCANNED:', {
            filename,
            code:    (scanResult.error as any)?.code,
            message: (scanResult.error as Error).message,
          });
        } else if (scanResult.status !== 0) {
          // Any other non-zero, non-virus exit (e.g. clamscan internal error
          // code 2). Don't block, but surface it.
          console.warn('[storage] ClamAV returned status', scanResult.status, '— accepting upload:', filename, scanResult.stderr?.trim());
        }
      }
    } catch (e) {
      // ClamAV not available — continue without scan
      console.warn('[storage] ClamAV scan skipped:', (e as Error).message);
    }

    const result = await uploadFile(
      bucketName,
      filename,
      fileData,  // Buffer from line 159
      file.type
    );
    
    if (!result.success) {
      return c.json({
        success: false,
        error: result.error,
      }, 500);
    }
    
    // Auto-extract cover art from audio files uploaded to track-audio bucket
    let coverUrl: string | undefined;
    if (bucketName === 'track-audio' && result.url) {
      const localPath = join('/var/www/promofm/uploads/track-audio', filename);
      try {
        const py = spawnSync('python3', [
          '/opt/promofm-promo-check/extract_cover.py',
          '--input', localPath,
          '--output-dir', '/var/www/promofm/uploads/track-covers',
          '--base-url', 'https://promo-music.ru/uploads/track-covers',
        ], { timeout: 15000, encoding: 'utf8' });
        if (py.status === 0 && py.stdout) {
          const parsed = JSON.parse(py.stdout.trim());
          if (parsed.cover_url) {
            coverUrl = parsed.cover_url;
            console.log('[storage] Cover extracted:', coverUrl);
          }
        }
      } catch (e) {
        console.warn('[storage] Cover extraction skipped:', (e as Error).message);
      }
    }

    return c.json({
      success: true,
      url: result.url,
      filename,
      size: file.size,
      type: file.type,
      ...(coverUrl ? { cover_url: coverUrl } : {}),
    });
  } catch (error) {
    console.error('Upload error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed',
    }, 500);
  }
});

// Get signed URL for private file
storage.post('/signed-url', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { bucket, path, expiresIn } = body;
    
    if (!bucket || !path) {
      return c.json({
        success: false,
        error: 'Bucket and path are required',
      }, 400);
    }
    
    const result = await getSignedUrl(bucket, path, expiresIn);
    
    if (!result.success) {
      return c.json({
        success: false,
        error: result.error,
      }, 500);
    }
    
    return c.json({
      success: true,
      url: result.url,
      expiresIn: expiresIn || 3600,
    });
  } catch (error) {
    console.error('Signed URL error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create signed URL',
    }, 500);
  }
});

// List files in bucket
storage.get('/list/:bucket', requireAuth, requireAdmin, async (c) => {
  try {
    const bucket = c.req.param('bucket');
    const path = c.req.query('path') || '';
    const limit = parseInt(c.req.query('limit') || '100');
    const offset = parseInt(c.req.query('offset') || '0');
    
    const result = await listFiles(bucket, path, { limit, offset });
    
    if (!result.success) {
      return c.json({
        success: false,
        error: result.error,
      }, 500);
    }
    
    return c.json({
      success: true,
      files: result.files,
      count: result.files?.length || 0,
    });
  } catch (error) {
    console.error('List files error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list files',
    }, 500);
  }
});

// Delete file
storage.delete('/:bucket/:path', requireAuth, requireAdmin, async (c) => {
  try {
    const bucket = c.req.param('bucket');
    const path = c.req.param('path');
    
    if (!bucket || !path) {
      return c.json({
        success: false,
        error: 'Bucket and path are required',
      }, 400);
    }
    
    const result = await deleteFile(bucket, path);
    
    if (!result.success) {
      return c.json({
        success: false,
        error: result.error,
      }, 500);
    }
    
    return c.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    console.error('Delete file error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete file',
    }, 500);
  }
});

// Reinitialize storage (for testing/debugging)
storage.post('/reinitialize', requireAuth, async (c) => {
  try {
    storageInitialized = false;
    const result = await ensureStorageInitialized();
    
    return c.json({
      success: result.success,
      message: 'Storage reinitialized',
      bucketsCreated: result.bucketsCreated,
      errors: result.errors,
    });
  } catch (error) {
    console.error('Reinitialize error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reinitialize',
    }, 500);
  }
});

export default storage;
