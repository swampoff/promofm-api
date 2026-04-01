/**
 * STORAGE SETUP — Local filesystem (replaces Supabase Storage)
 * Creates upload directories instead of Supabase buckets.
 * Provides file upload/delete/list/stats operations.
 */
import { mkdirSync, existsSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeErrorMessage } from './security.tsx';

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/var/www/promofm/uploads';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://promo-music.ru';

// ─── Bucket Configuration ───

interface BucketConfig {
  name: string;
  subdir: string;
  public: boolean;
  fileSizeLimit: number; // bytes
  allowedMimeTypes: string[];
}

export const BUCKET_NAMES = {
  CONCERT_BANNERS: 'concert-banners',
  ARTIST_AVATARS: 'artist-avatars',
  TRACK_COVERS: 'track-covers',
  TRACK_AUDIO: 'track-audio',
  VIDEO_FILES: 'video-files',
  VIDEO_THUMBNAILS: 'video-thumbnails',
  BANNER_IMAGES: 'banner-images',
  NEWS_IMAGES: 'news-images',
  ATTACHMENTS: 'attachments',
  MISC: 'misc',
} as const;

const BUCKET_CONFIGS: Record<string, BucketConfig> = {
  'concert-banners': {
    name: 'concert-banners', subdir: 'concert-banners', public: true,
    fileSizeLimit: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  },
  'artist-avatars': {
    name: 'artist-avatars', subdir: 'artist-avatars', public: true,
    fileSizeLimit: 5 * 1024 * 1024, // 5MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  'track-covers': {
    name: 'track-covers', subdir: 'track-covers', public: true,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  'track-audio': {
    name: 'track-audio', subdir: 'track-audio', public: true,
    fileSizeLimit: 100 * 1024 * 1024, // 100MB
    allowedMimeTypes: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/aac'],
  },
  'video-files': {
    name: 'video-files', subdir: 'video-files', public: true,
    fileSizeLimit: 500 * 1024 * 1024, // 500MB
    allowedMimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
  },
  'video-thumbnails': {
    name: 'video-thumbnails', subdir: 'video-thumbnails', public: true,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  'banner-images': {
    name: 'banner-images', subdir: 'banner-images', public: true,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  },
  'news-images': {
    name: 'news-images', subdir: 'news-images', public: true,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
  'attachments': {
    name: 'attachments', subdir: 'attachments', public: false,
    fileSizeLimit: 50 * 1024 * 1024, // 50MB
    allowedMimeTypes: ['*'],
  },
  'misc': {
    name: 'misc', subdir: 'misc', public: true,
    fileSizeLimit: 20 * 1024 * 1024,
    allowedMimeTypes: ['*'],
  },
};

// ─── Public API ───

export function getBucketConfig(bucketName: string): BucketConfig | null {
  return BUCKET_CONFIGS[bucketName] || null;
}

export function validateFileType(filename: string, allowedTypes: string[]): boolean {
  if (allowedTypes.includes('*')) return true;
  const ext = extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
    '.ogg': 'audio/ogg', '.aac': 'audio/aac',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  return allowedTypes.includes(mime);
}

export function generateUniqueFilename(originalName: string, pathPrefix: string = ''): string {
  const ext = extname(originalName);
  const base = basename(originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  const unique = `${base}_${randomUUID().slice(0, 8)}${ext}`;
  return pathPrefix ? `${pathPrefix}/${unique}` : unique;
}

export async function initializeStorage(): Promise<{ success: boolean; bucketsCreated: string[]; errors: string[] }> {
  const created: string[] = [];
  const errors: string[] = [];

  try {
    if (!existsSync(UPLOADS_DIR)) {
      mkdirSync(UPLOADS_DIR, { recursive: true });
      created.push(UPLOADS_DIR);
    }

    for (const config of Object.values(BUCKET_CONFIGS)) {
      const fullPath = join(UPLOADS_DIR, config.subdir);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
        created.push(config.name);
      }
    }
  } catch (err: any) {
    errors.push(err.message);
  }

  return { success: errors.length === 0, bucketsCreated: created, errors };
}

export async function uploadFile(
  bucketName: string,
  filename: string,
  data: ArrayBuffer | Buffer,
  contentType?: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const config = BUCKET_CONFIGS[bucketName];
    if (!config) return { success: false, error: `Unknown bucket: ${bucketName}` };

    const filePath = join(UPLOADS_DIR, config.subdir, filename);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    writeFileSync(filePath, buffer);

    const url = `${PUBLIC_URL}/uploads/${config.subdir}/${filename}`;
    return { success: true, url };
  } catch (err: any) {
    return { success: false, error: safeErrorMessage(err) };
  }
}

export async function getSignedUrl(
  bucketName: string,
  path: string,
  expiresIn: number = 3600
): Promise<{ success: boolean; url?: string; error?: string }> {
  // For local filesystem, all files are served by Nginx — no signed URLs needed
  const config = BUCKET_CONFIGS[bucketName];
  if (!config) return { success: false, error: `Unknown bucket: ${bucketName}` };
  const url = `${PUBLIC_URL}/uploads/${config.subdir}/${path}`;
  return { success: true, url };
}

export async function deleteFile(
  bucketName: string,
  path: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = BUCKET_CONFIGS[bucketName];
    if (!config) return { success: false, error: `Unknown bucket: ${bucketName}` };

    // Path traversal protection: resolve and verify path stays within bucket
    const baseDir = resolve(UPLOADS_DIR, config.subdir);
    const filePath = resolve(baseDir, path);
    if (!filePath.startsWith(baseDir)) {
      return { success: false, error: 'Invalid path' };
    }

    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: safeErrorMessage(err) };
  }
}

export async function listFiles(
  bucketName: string,
  pathPrefix: string = '',
  opts: { limit?: number; offset?: number } = {}
): Promise<{ success: boolean; files?: any[]; error?: string }> {
  try {
    const config = BUCKET_CONFIGS[bucketName];
    if (!config) return { success: false, error: `Unknown bucket: ${bucketName}` };

    const baseDir = resolve(UPLOADS_DIR, config.subdir);
    const dir = resolve(baseDir, pathPrefix);
    // Path traversal protection
    if (!dir.startsWith(baseDir)) return { success: false, error: 'Invalid path' };
    if (!existsSync(dir)) return { success: true, files: [] };

    const entries = readdirSync(dir);
    const files = entries.map(name => {
      try {
        const st = statSync(join(dir, name));
        return {
          name,
          size: st.size,
          created_at: st.birthtime.toISOString(),
          updated_at: st.mtime.toISOString(),
          isDir: st.isDirectory(),
        };
      } catch {
        return { name, size: 0, created_at: '', updated_at: '', isDir: false };
      }
    });

    const offset = opts.offset || 0;
    const limit = opts.limit || 100;
    return { success: true, files: files.slice(offset, offset + limit) };
  } catch (err: any) {
    return { success: false, error: safeErrorMessage(err) };
  }
}

export async function getStorageStats(): Promise<{ success: boolean; stats?: any; error?: string }> {
  try {
    const bucketStats: Record<string, { files: number; totalSize: number }> = {};
    let totalFiles = 0;
    let totalSize = 0;

    for (const config of Object.values(BUCKET_CONFIGS)) {
      const dir = join(UPLOADS_DIR, config.subdir);
      let files = 0;
      let size = 0;

      if (existsSync(dir)) {
        const entries = readdirSync(dir);
        for (const name of entries) {
          try {
            const st = statSync(join(dir, name));
            if (st.isFile()) {
              files++;
              size += st.size;
            }
          } catch { /* skip */ }
        }
      }

      bucketStats[config.name] = { files, totalSize: size };
      totalFiles += files;
      totalSize += size;
    }

    return {
      success: true,
      stats: {
        buckets: bucketStats,
        totalFiles,
        totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
        uploadsDir: UPLOADS_DIR,
      },
    };
  } catch (err: any) {
    return { success: false, error: safeErrorMessage(err) };
  }
}

export function getUploadPath(subdir: string, filename: string): string {
  return join(UPLOADS_DIR, subdir, filename);
}

export function getPublicUrl(subdir: string, filename: string): string {
  return `${PUBLIC_URL}/uploads/${subdir}/${filename}`;
}
