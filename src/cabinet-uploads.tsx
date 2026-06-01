/**
 * CABINET UPLOADS — shared multipart helper for cabinet avatars,
 * covers, and similar small assets.
 *
 * History: each cabinet's routes file (DJ, producer, label, …)
 * grew its own private `saveUpload` copy with subtle drifts:
 *   - DJ:       8 MB image cap, dj-avatars / dj-covers / dj-mixes subdirs
 *   - Producer: had nothing (no avatar/cover support at all)
 *   - Label:    had nothing (avatar via URL-string only)
 *
 * Centralising here so the next cabinet that wants uploads doesn't
 * re-invent the wheel + so the size/MIME contract is consistent
 * across the platform. DJ's own helper still exists in
 * dj-studio-routes.tsx (kept as-is to avoid touching a working
 * surface); migration to this shared helper is a follow-up.
 *
 * URL contract:
 *   Files land at `${UPLOADS_BASE}/${subdir}/${filename}`.
 *   Public URL is `${PUBLIC_BASE}/${subdir}/${filename}` which nginx
 *   serves via the existing `/server/uploads/` alias. Adding a new
 *   subdir requires NO nginx reconfig — the alias covers all
 *   children.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import crypto from 'node:crypto';

export const UPLOADS_BASE = process.env.UPLOADS_DIR || '/opt/promofm-api/uploads';
export const PUBLIC_BASE = process.env.PUBLIC_UPLOADS_BASE_URL || 'https://promo-music.ru/server/uploads';

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

export function sanitizeExt(filename: string, allowed: Set<string>): string | null {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename || '');
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return allowed.has(ext) ? ext : null;
}

export interface SavedUpload {
  filename: string;
  url: string;
  size: number;
  ext: string;
}

/**
 * Magic-byte check для загруженных файлов. Audit B-P1 (2026-05-31):
 * раньше saveUpload валидировал только расширение через sanitizeExt.
 * Файл с расширением .mp3 мог содержать .exe / shell-script / архив
 * → backend хранил как audio, nginx отдавал с audio/* Content-Type
 * → MIME confusion attack (например: SVG-with-script под .png).
 *
 * Проверяем первые 16 байт против ext'а. Если ext в allowed но magic
 * bytes не совпадают — reject. Расширения вне списка (custom) пропускаем
 * (не наш job — отвечать за неизвестные форматы).
 */
const MAGIC_SIGNATURES: Record<string, RegExp[]> = {
  // Audio
  mp3:  [/^ID3/, /^\xFF[\xFB\xF3\xF2]/], // ID3v2 или MPEG frame sync
  wav:  [/^RIFF.{4}WAVE/s],
  flac: [/^fLaC/],
  ogg:  [/^OggS/],
  m4a:  [/^.{4}ftyp(M4A |mp42|isom|dash)/s],
  aac:  [/^\xFF[\xF1\xF9]/],
  // Images
  jpg:  [/^\xFF\xD8\xFF/],
  jpeg: [/^\xFF\xD8\xFF/],
  png:  [/^\x89PNG\r\n\x1A\n/],
  webp: [/^RIFF.{4}WEBP/s],
  gif:  [/^GIF8[79]a/],
};

function verifyMagicBytes(buf: Buffer, ext: string): boolean {
  const sigs = MAGIC_SIGNATURES[ext.toLowerCase()];
  if (!sigs) return true; // unknown ext — не наш scope
  const head = buf.subarray(0, 16).toString('binary');
  return sigs.some((re) => re.test(head));
}

export async function saveUpload(
  file: File,
  subdir: string,
  prefix: string,
  allowed: Set<string>,
  maxBytes: number,
): Promise<SavedUpload> {
  if (file.size > maxBytes) {
    throw new Error(`Файл слишком большой (макс. ${Math.round(maxBytes / 1024 / 1024)} МБ)`);
  }
  const ext = sanitizeExt(file.name, allowed);
  if (!ext) throw new Error('Недопустимый формат файла');
  const dir = path.join(UPLOADS_BASE, subdir);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${prefix}-${crypto.randomUUID()}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  if (!verifyMagicBytes(buf, ext)) {
    throw new Error(`Содержимое файла не соответствует расширению .${ext}`);
  }
  await fs.writeFile(path.join(dir, filename), buf);
  return {
    filename,
    url: `${PUBLIC_BASE}/${subdir}/${filename}`,
    size: file.size,
    ext,
  };
}
