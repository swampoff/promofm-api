/**
 * STORAGE API ROUTES
 * REST API для управления файлами в Supabase Storage
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
    
    // Validate file type
    if (!validateFileType(file.name, bucketConfig.allowedMimeTypes)) {
      return c.json({
        success: false,
        error: `File type not allowed. Allowed types: ${bucketConfig.allowedMimeTypes.join(', ')}`,
      }, 400);
    }
    
    // Validate file content (magic bytes) — defense-in-depth
    const fileData = Buffer.from(await file.arrayBuffer());
    const { fileTypeFromBuffer } = await import("file-type");
    const detectedType = await fileTypeFromBuffer(fileData);
    if (detectedType && bucketConfig.allowedMimeTypes.length > 0 && !bucketConfig.allowedMimeTypes.includes('*')) {
      const allowedExts = bucketConfig.allowedMimeTypes.map((m: string) => m.split('/')[1]);
      const detectedExt = detectedType.ext;
      // Block if detected content doesn't match any allowed type
      const mimeMatch = bucketConfig.allowedMimeTypes.includes(detectedType.mime);
      if (!mimeMatch) {
        console.warn('[storage] Magic bytes mismatch:', { claimed: file.type, detected: detectedType.mime, filename: file.name });
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
      const tmpPath = join('/tmp', 'upload_scan_' + Date.now() + '_' + filename);
      const { writeFileSync, unlinkSync } = await import('fs');
      writeFileSync(tmpPath, fileData);
      const scanResult = spawnSync('clamscan', ['--no-summary', tmpPath], { timeout: 30000, encoding: 'utf8' });
      unlinkSync(tmpPath);
      if (scanResult.status === 1) {
        console.error('[storage] VIRUS DETECTED:', { filename, output: scanResult.stdout?.trim() });
        return c.json({ success: false, error: 'File rejected by security scan' }, 400);
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
storage.get('/list/:bucket', requireAuth, async (c) => {
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
