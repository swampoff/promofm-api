/**
 * Отдача аудиофайла трека «как вложение» с человеческим именем
 * «Артист - Название.mp3». Общая для скачивания из кабинета
 * (tracks-routes GET /:id/download) и по личной ссылке из письма
 * (radio-get-routes).
 *
 * Жалоба радиостанции 2026-08-11: «скачивается без названия трека» — на диске
 * имена технические, кириллица при загрузке терялась. Поэтому файл отдаём
 * сами, а не редиректом на audio_url: ASCII-имя + RFC 5987 для кириллицы.
 *
 * Возвращает Response или null, если файла на диске нет (тогда вызывающий
 * может откатиться на редирект к audio_url).
 */

export async function sendTrackFile(
  c: any,
  track: { audio_url: string; artist_name?: string | null; title?: string | null },
): Promise<Response | null> {
  try {
    const rel = String(track.audio_url).replace(/^https?:\/\/[^/]+/, '');
    const decoded = decodeURIComponent(rel);
    const diskName = decoded.split('/').pop() || '';
    const ext = (decoded.match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'mp3').toLowerCase();
    const { existsSync, statSync, createReadStream } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const uploadsRoot = process.env.UPLOADS_DIR || '/var/www/promofm/uploads';
    const subdir = decoded.includes('/track-audio/') ? 'track-audio' : 'tracks';

    let filePath = '';
    for (const base of [
      join(uploadsRoot, subdir, 'uploads'),
      join(uploadsRoot, subdir),
      '/opt/promofm-api/uploads/tracks',
    ]) {
      const candidate = resolve(base, diskName);
      if (candidate.startsWith(resolve(base)) && existsSync(candidate)) { filePath = candidate; break; }
    }
    if (!filePath) return null;

    const clean = (x: string) => String(x || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
    const nice = `${clean(track.artist_name || '') || 'Artist'} - ${clean(track.title || '') || 'Track'}.${ext}`;
    const ascii = nice.replace(/[^\x20-\x7E]/g, '_');
    // Node-поток отдаём как web ReadableStream. Раньше (c.body(createReadStream))
    // после отдачи файла процесс падал: «ReadableStream is already closed»
    // (найдено 01.10.2026 на тестовом стенде) — uncaughtException роняет весь API.
    const { Readable } = await import('node:stream');
    const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': ext === 'wav' ? 'audio/wav' : 'audio/mpeg',
        'Content-Length': String(statSync(filePath).size),
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nice)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.warn('[track-file] stream failed:', e?.message || e);
    return null;
  }
}
