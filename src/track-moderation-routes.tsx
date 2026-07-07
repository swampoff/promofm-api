/**
 * TRACK MODERATION ROUTES v2 — Uses typed `tracks` table
 * Approve → status='published' + award coins (REAL)
 * One table, one row per track. No separate moderation store.
 */

import { notifyTrackUpload, sendEmail, escapeHtml, emailWrapper } from './email-helper.tsx';
import { logAdminAction } from './audit-helper.tsx';
import { notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { upsertNotification } from './db.tsx';
import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { scheduleAiCheck, backfillAiCheck } from './ai-check.tsx';
import * as typed from './db-typed.tsx';
import { getDbClient, pool } from "./db-client.tsx";

const app = new Hono();

const GENRES = [
  'Pop', 'Rock', 'Hip-Hop', 'R&B', 'Electronic', 'Dance',
  'House', 'Techno', 'Trance', 'Dubstep', 'Drum & Bass',
  'Jazz', 'Blues', 'Classical', 'Country', 'Folk',
  'Reggae', 'Afrobeat', 'Metal', 'Punk', 'Indie', 'Alternative',
  'Soul', 'Funk', 'Disco', 'Gospel', 'Latin', 'World'
];

const PUBLICATION_PRICE = 7000; // 7000 RUB for track publication
const AI_DETECTOR_URL = 'http://127.0.0.1:8085';
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/var/www/promofm/uploads';

/**
 * Stage published track для AutoDJ airplay.
 *
 * AutoDJ читает из /mnt/data/promofm-music/tracks/ и фильтрует треки в БД
 * по `audio_url LIKE '/server/uploads/tracks/%'`. Артистский upload через
 * /track-moderation/submit-track складывает файл в /uploads/track-audio/
 * (другой путь) — туда AutoDJ не смотрит, трек не попадает в эфир.
 *
 * Эта функция мигрирует трек в правильную локацию:
 *   1. Копирует физический файл из /var/www/promofm/uploads/track-audio/
 *      в /mnt/data/promofm-music/tracks/<slug>.<ext>
 *   2. UPDATE tracks.audio_url на /server/uploads/tracks/<slug>.<ext>
 *   3. symlink на /var/www/promofm/uploads/tracks/<slug>.<ext> чтобы nginx
 *      отдавал на новом URL
 *
 * Идемпотентно: если файл уже в MUSIC_DIR или audio_url уже норм — skip.
 * Это правило для всех треков с шаутаутами (и без) — единственный путь
 * чтобы published трек реально зазвучал в эфире.
 */
async function stageTrackForAirplay(trackId: string, track: any): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const audioUrl = String(track.audio_url || '');
  // Уже на правильном пути — нечего делать.
  if (audioUrl.startsWith('/server/uploads/tracks/')) return;
  if (!audioUrl.includes('/uploads/track-audio/')) {
    // Внешний URL (Yandex/Spotify/etc) — это не наш файл, AutoDJ не сможет
    // его проиграть; оставляем как есть (он может попасть в эфир через
    // другие источники типа Shazam).
    return;
  }
  // Источник: физический файл артистской загрузки.
  const filename = audioUrl.split('/uploads/track-audio/').pop() || '';
  if (!filename) return;
  // Если filename начинается с 'uploads/', убираем дубликат
  const cleanFilename = filename.startsWith('uploads/') ? filename.substring(8) : filename;
  const srcPath = `${UPLOADS_DIR}/track-audio/uploads/${cleanFilename}`;
  // Slug-имя на основе artist + title для читаемости. Транслит и сжатие
  // спецсимволов чтобы избежать problemc URL-encoding и shell escaping
  // в ffmpeg / play_track.
  const ext = (cleanFilename.split('.').pop() || 'mp3').toLowerCase();
  const slug = `${String(track.artist_name || 'unknown').trim()}_-_${String(track.title || 'untitled').trim()}`
    .replace(/[^A-Za-zА-Яа-я0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
  const dstName = `${slug}.${ext}`;
  const MUSIC_DIR = '/mnt/data/promofm-music/tracks';
  const dstPath = `${MUSIC_DIR}/${dstName}`;
  const nginxPath = `${UPLOADS_DIR}/tracks/${dstName}`;
  try {
    await fs.access(srcPath);
  } catch {
    console.warn(`[stageForAir] source missing: ${srcPath}`);
    return;
  }
  // Копируем (если уже есть — пропускаем).
  try {
    await fs.access(dstPath);
    console.log(`[stageForAir] already staged: ${dstName}`);
  } catch {
    await fs.copyFile(srcPath, dstPath);
    console.log(`[stageForAir] staged ${trackId}: ${dstName}`);
  }
  // Symlink на nginx-путь чтобы фронтенд продолжал получать файл по
  // /server/uploads/tracks/<name>.
  try {
    await fs.symlink(dstPath, nginxPath);
  } catch (e: any) {
    if (e?.code !== 'EEXIST') console.warn(`[stageForAir] symlink failed: ${e?.message}`);
  }
  // Обновляем audio_url в БД.
  const newUrl = `/server/uploads/tracks/${dstName}`;
  const { pool } = await import('./db-client.tsx');
  await pool.query(`UPDATE tracks SET audio_url = $1, updated_at = NOW() WHERE id = $2`, [newUrl, trackId]);
  console.log(`[stageForAir] DB url updated for ${trackId}: ${newUrl}`);

  // Триггерим пересборку metadata.json чтобы AutoDJ сразу увидел новый трек
  // (без этого build-metadata.py запускается только при рестарте autodj).
  try {
    const resp = await fetch('http://127.0.0.1:8087/api/metadata/scan', { method: 'POST' });
    if (resp.ok) console.log(`[stageForAir] autodj metadata rescan triggered for ${trackId}`);
  } catch (e: any) {
    console.warn(`[stageForAir] autodj rescan failed (non-fatal):`, e?.message);
  }
}

// Fire-and-forget AI analysis for uploaded track
async function triggerAiAnalysis(trackId: string, audioUrl: string) {
  try {
    // Convert URL to local file path
    let filePath = '';
    if (audioUrl.startsWith('/') || audioUrl.startsWith('/var/')) {
      filePath = audioUrl;
    } else if (audioUrl.includes('/uploads/track-audio/')) {
      const filename = audioUrl.split('/uploads/track-audio/').pop();
      filePath = `${UPLOADS_DIR}/track-audio/${filename}`;
    } else {
      console.log(`[ai-detector] Cannot analyze track ${trackId}: audio is external URL`);
      return;
    }

    console.log(`[ai-detector] Starting analysis for track ${trackId}: ${filePath}`);
    const resp = await fetch(`${AI_DETECTOR_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: filePath, track_id: trackId }),
    });

    if (!resp.ok) {
      console.error(`[ai-detector] HTTP ${resp.status} for track ${trackId}`);
      return;
    }

    const result = await resp.json() as any;
    await typed.updateTrack(trackId, {
      ai_score: result.ai_score,
      ai_analysis: result,
      ai_verdict: result.verdict,
      ai_analyzed_at: new Date().toISOString(),
    });
    console.log(`[ai-detector] Track ${trackId}: score=${result.ai_score}% verdict=${result.verdict}`);
  } catch (err) {
    console.error(`[ai-detector] Failed for track ${trackId}:`, err);
  }
}

// POST /submitTrack — Submit track for moderation
app.post('/submitTrack', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const userId = c.get('userId');
    const userRole = c.get('userRole') as string | undefined;
    if (!userId) {
      return c.json({ error: 'Авторизация обязательна', code: 'AUTH_REQUIRED' }, 401);
    }

    // Label-on-behalf: same shape as tracks-routes — actingForArtistId
    // resolves to the roster artist's profile, the row is owned/paid by
    // the label, and the track's display name is snapshotted.
    let resolvedArtistId: string | null = null;
    let resolvedArtistName: string = body.artist || body.artist_name || '';
    let actingForArtistId: string | undefined;
    let actingForArtistUserId: string | undefined;
    let labelId: string | undefined;

    if (body.actingForArtistId) {
      if (userRole !== 'label') {
        return c.json({ error: 'actingForArtistId доступно только роли label', code: 'ROLE_FORBIDDEN' }, 403);
      }
      const { pool } = await import('./db-client.tsx');
      const lp = await pool.query(`SELECT id FROM label_profiles WHERE user_id = $1`, [userId]);
      if (lp.rows.length === 0) {
        return c.json({ error: 'Сначала заполните профиль лейбла', code: 'LABEL_PROFILE_REQUIRED' }, 400);
      }
      labelId = lp.rows[0].id;
      const ap = await pool.query(
        `SELECT id, user_id, artist_name FROM artist_profiles
         WHERE id = $1 AND (managed_by_label_id = $2 OR label_id = $2)`,
        [body.actingForArtistId, labelId]
      );
      if (ap.rows.length === 0) {
        return c.json({ error: 'Артист не в вашем ростере', code: 'ARTIST_NOT_IN_ROSTER' }, 403);
      }
      resolvedArtistId = ap.rows[0].id;
      resolvedArtistName = ap.rows[0].artist_name || resolvedArtistName;
      actingForArtistId = resolvedArtistId || undefined;
      actingForArtistUserId = ap.rows[0].user_id || undefined;
    } else {
      // Artist branch — require own artist profile
      const profile = await getDbClient().from('artist_profiles').select('id, artist_name').eq('user_id', userId).maybeSingle();
      if (!profile?.data) {
        return c.json({ error: 'Сначала заполните профиль артиста в личном кабинете', code: 'PROFILE_REQUIRED' }, 403);
      }
      resolvedArtistId = (profile.data as any).id;
      if (!resolvedArtistName) {
        resolvedArtistName = (profile.data as any).artist_name || '';
      }
    }

    // RULE: трек нельзя отправить на модерацию без аудио-файла
    const audioFileUrl = body.audio_file_url || body.audio_url || '';
    if (!audioFileUrl || !audioFileUrl.trim()) {
      return c.json({
        error: 'Загрузите аудио-файл трека перед отправкой на модерацию',
        code: 'AUDIO_REQUIRED'
      }, 400);
    }
    if (!body.title || !body.title.trim()) {
      return c.json({ error: 'Укажите название трека', code: 'TITLE_REQUIRED' }, 400);
    }
    // RULE: трек нельзя отправить на модерацию без обложки.
    // Раньше backend принимал пустой cover и подставлял
    // /images/default-cover.svg — placeholder висел в публичном эфире,
    // плеере, профиле артиста и «Новинках недели». Эстетически бедно
    // и подрывает бренд (см. кейс DJ Альберт project «Великая сила -
    // любовь» 2026-05-27).
    // Симметрично AUDIO_REQUIRED — обязываем cover на этапе submitTrack,
    // без него 400 COVER_REQUIRED. Default-cover SVG остаётся как
    // final-fallback для legacy-rows (5677 без audio_url которые ждут
    // миграции с старой платформы — там обложек тоже может не быть).
    const coverImageUrl = body.cover_image_url || body.cover_url || '';
    if (!coverImageUrl || !coverImageUrl.trim() || coverImageUrl.endsWith('/default-cover.svg')) {
      return c.json({
        error: 'Загрузите обложку трека перед отправкой на модерацию',
        code: 'COVER_REQUIRED'
      }, 400);
    }
    // RULE: описание обязательно ≥20 символов. Раньше было opt-in и
    // публичный профиль артиста показывал пустой блок «О треке».
    // Минимум 20 символов чтобы отсечь спам "ok"/"new track"/"вышло".
    const descriptionRaw = String(body.description || '').trim();
    if (descriptionRaw.length < 20) {
      return c.json({
        error: 'Опишите трек минимум в 20 символах — это видно на публичном профиле',
        code: 'DESCRIPTION_REQUIRED'
      }, 400);
    }

    const track = await typed.insertTrack({
      title: body.title || '',
      artist_name: resolvedArtistName,
      artist_id: resolvedArtistId,
      genre: body.genre || '',
      duration: body.duration || 0,
      audio_url: body.audio_file_url || body.audio_url || '',
      cover_url: body.cover_image_url || body.cover_url || '',
      yandex_music_url: body.yandex_music_url || '',
      youtube_url: body.youtube_url || '',
      spotify_url: body.spotify_url || '',
      uploaded_by_email: c.get('userEmail') || body.uploaded_by_email || body.contact_email || body.email || '',
      user_id: userId,  // owner / payer (label for on-behalf, artist otherwise)
      moderation_status: 'pending',
      // Opt-in metadata — native cols (migration 089). Server-side trim/slice
      // как safety net: фронт каппирует, но curl / label admin tooling /
      // on-behalf flows могут не.
      shoutout_url:    body.shoutout_url ? String(body.shoutout_url) : null,
      description:     body.description && String(body.description).trim()
                         ? String(body.description).trim().slice(0, 1000) : null,
      music_composer:  body.music_composer && String(body.music_composer).trim()
                         ? String(body.music_composer).trim().slice(0, 200) : null,
      lyricist:        body.lyricist && String(body.lyricist).trim()
                         ? String(body.lyricist).trim().slice(0, 200) : null,
    });

    if (!track) {
      return c.json({ error: 'Failed to create track' }, 500);
    }

    // Доп. метаданные релиза: lyrics → колонка, продюсер/год/демо/сообщество → data jsonb.
    try {
      const extras: Record<string, any> = {};
      if (body.producer && String(body.producer).trim()) extras.producer = String(body.producer).trim().slice(0, 200);
      if (body.recording_year && String(body.recording_year).trim()) extras.recording_year = String(body.recording_year).trim().slice(0, 10);
      if (body.demo_start_sec && String(body.demo_start_sec).trim()) extras.demo_start_sec = String(body.demo_start_sec).trim().slice(0, 10);
      if (body.community_url && String(body.community_url).trim()) extras.community_url = String(body.community_url).trim().slice(0, 500);
      const lyricsVal = body.lyrics && String(body.lyrics).trim() ? String(body.lyrics).trim().slice(0, 8000) : null;
      if (lyricsVal || Object.keys(extras).length > 0) {
        const { pool } = await import('./db-client.tsx');
        await pool.query(
          `UPDATE tracks SET lyrics = COALESCE($1, lyrics), data = COALESCE(data, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $3`,
          [lyricsVal, JSON.stringify(extras), track.id]
        );
      }
    } catch (e: any) {
      console.warn('[submitTrack] extra metadata save failed:', e?.message);
    }

    // Fire-and-forget AI analysis (don't block the response)
    const audioUrl = track.audio_url || body.audio_file_url || body.audio_url || '';
    if (audioUrl) {
      triggerAiAnalysis(track.id, audioUrl).catch(() => {});
    }

    // Fire-and-forget: queue Promo.check fingerprint + watermark for
    // radio-airplay monitoring. In-process (2026-07-07): прежний
    // внутренний HTTP-фетч на /promo-check/process был мёртв — без
    // cookie requireAuth всегда отвечал 401, и треки попадали в
    // мониторинг только через reconcile-fingerprints.sh (15-мин cron).
    // Cron остаётся бэкстопом.
    if (audioUrl) {
      import('./promo-check-routes.tsx')
        .then(m => m.queueTrackFingerprint(track.id))
        .catch(() => {}); // non-blocking, monitoring is best-effort
    }

    // Email notification to admin
    notifyTrackUpload({
      title: body.title || '',
      artist: body.artist || '',
      genre: body.genre,
      email: body.uploaded_by_email,
      userId: body.uploaded_by_user_id || body.user_id,
    }).catch(err => console.error('[track-moderation] Email notify failed:', err.message));

    return c.json({
      success: true,
      pending_track_id: track.id,
      message: 'Трек отправлен на модерацию'
    });
  } catch (error) {
    console.error('Error in submitTrack:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /pendingTracks — Get tracks by status with filters
// IMPORTANT: ~5700 legacy accounts from old platform are stored without audio_url
// and will get audio reconnected during migration to promo-music.ru. DO NOT filter them out.
app.get('/pendingTracks', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'pending';
    const genre = c.req.query('genre');
    const search = c.req.query('search');
    const limit = parseInt(c.req.query('limit') || '200');

    const tracks = await typed.getAllTracksForModeration({
      status: status === 'all' ? undefined : status,
      genre: genre || undefined,
      search: search || undefined,
      limit: Math.min(limit, 500),
    });

    // Map to frontend-expected format
    const mapped = tracks.map((t: any) => ({
      id: t.id,
      title: t.title,
      artist: t.artist_name || '',
      cover_image_url: t.cover_url || '',
      audio_file_url: t.audio_url || '',
      duration: t.duration || 0,
      genre: t.genre || '',
      yandex_music_url: t.yandex_music_url || '',
      youtube_url: t.youtube_url || '',
      spotify_url: t.spotify_url || '',
      uploaded_by_email: t.uploaded_by_email || '',
      uploaded_by_user_id: t.user_id || '',
      moderation_status: t.moderation_status,
      overall_score: t.ai_score ?? null,
      moderator_notes: t.moderation_comment || null,
      rejection_reason: t.rejection_reason || null,
      created_at: t.created_at,
      updated_at: t.updated_at,
      // AI detection fields
      ai_score: t.ai_score ?? null,
      ai_verdict: t.ai_verdict || null,
      ai_analysis: t.ai_analysis || null,
      ai_analyzed_at: t.ai_analyzed_at || null,
    }));

    return c.json({ tracks: mapped });
  } catch (error) {
    console.error('Error in pendingTracks:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /manageTrackModeration — Approve or reject a track
app.post('/manageTrackModeration', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { pendingTrackId, action, moderator_notes, rejection_reason, overall_score, is_ai_track } = body;

    const track = await typed.getTrackById(pendingTrackId);
    if (!track) {
      return c.json({ error: 'Track not found' }, 404);
    }

    // State guard. This endpoint moderates fresh submissions only — without
    // this check a stale admin tab can click «Одобрить» on a row that has
    // already paid and re-advanced; the write happily downgrades status to
    // 'approved' and resets data.payment_amount back to PUBLICATION_PRICE
    // (5000), undoing the payment record. See production incident with
    // Nadezhda's track e77b1053 — payment_amount went 1 → 5000 and status
    // upcoming → approved because of exactly this path.
    if (track.moderation_status !== 'pending') {
      console.warn(
        `[manageTrackModeration] BLOCKED action=${action} on trackId=${pendingTrackId}: ` +
        `current status=${track.moderation_status}, expected 'pending'. ` +
        `Most likely a stale-UI re-click after payment/auto-advance.`
      );
      return c.json({
        error: 'Track is no longer in pending moderation',
        currentStatus: track.moderation_status,
        message: `Трек уже не на модерации (текущий статус: ${track.moderation_status})`,
      }, 409);
    }

    const now = new Date().toISOString();

    if (action === 'approve') {
      // Все треки публикуются за полную цену PUBLICATION_PRICE.
      // Native cols — единственный источник правды (см. KV-mandate,
      // CLAUDE.md). is_ai_track маппится на native is_ai_generated
      // (migration 062). overall_score → ai_score. ai_flagged +
      // ai_category — native с 062.
      const aiWarning = (track.ai_score && track.ai_score > 60)
        ? ` AI: ${track.ai_score}% (${track.ai_verdict})`
        : '';

      await typed.updateTrack(pendingTrackId, {
        moderation_status: 'approved',
        moderation_comment: moderator_notes || 'Трек одобрен',
        moderated_at: now,
        is_hidden: true,
        is_ai_generated: is_ai_track === true || false,
        ai_score: overall_score || null,
        ai_flagged: is_ai_track === true || (track.ai_score && track.ai_score > 60) || false,
        ai_category: is_ai_track ? 'ai_music' : 'original',
        requires_payment: true,
        payment_amount: PUBLICATION_PRICE,
        first_track_free_applied: false,
        payment_completed: false,
        paid_at: null,
        upcoming_until: null,
        approved_for_release_at: null,
      });

      console.log(`[moderation] Track ${pendingTrackId} approved. Awaiting payment ${PUBLICATION_PRICE} RUB.` + aiWarning);

      // Audit B-8: forensic trail кто одобрил.
      logAdminAction(c, {
        action: 'track_moderation_approve',
        resourceType: 'track',
        targetId: String(pendingTrackId),
        details: { title: track.title, artist: track.artist_name, price: PUBLICATION_PRICE, isAi: is_ai_track === true },
      });

      // Notify artist: email + in-app
      // Fallback chain: uploaded_by_email → users.email lookup (may be empty for VK/SSO users without email contact)
      let artistEmail = track.uploaded_by_email;
      if (!artistEmail && track.user_id) {
        try {
          const { pool } = await import('./db-client.tsx');
          const ur = await pool.query('SELECT email FROM users WHERE id::text = $1', [String(track.user_id)]);
          artistEmail = ur.rows[0]?.email || '';
        } catch {}
      }
      const artistName = track.artist_name || 'Артист';
      const aiNote = (track.ai_score && track.ai_score > 60)
        ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #F59E0B;border-radius:4px;"><strong>AI-анализ:</strong> С вероятностью ' + track.ai_score + '% трек создан с помощью ИИ. Мы предлагаем размещение в специальном разделе <strong>ИИ-треки</strong>.</p>'
        : '';

      if (artistEmail) {
        let emailHtml: string;
        let emailSubject: string;

        if (is_ai_track) {
          // AI track — special email with AI section offer
          const aiPercent = track.ai_score || 95;
          emailSubject = 'Результат модерации — ' + track.title;
          emailHtml = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a14;color:#e5e5e5;border-radius:12px;overflow:hidden;">'
            + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px 32px;text-align:center;border-bottom:1px solid #2a2a4a;">'
            + '<img src="https://promo-music.ru/logo.png" alt="Промо.Музыка" style="height:36px;" />'
            + '<p style="margin:8px 0 0;color:#888;font-size:13px;">Платформа для музыкантов и лейблов</p>'
            + '</div>'
            + '<div style="padding:32px;">'
            + '<p>Добрый день!</p>'
            + '<p>Благодарим вас за доверие и за то, что отправили свой трек на платформу Промо.Музыка. Нам действительно ценно, что вы делитесь своим творчеством с нами.</p>'
            + '<p>В процессе модерации наша система анализа <strong>Promo.Check</strong> определила, что композиция <strong>«' + escapeHtml(track.title) + '»</strong> с высокой вероятностью (около ' + aiPercent + '%) была создана с использованием технологий искусственного интеллекта.</p>'
            + '<p>Готовы предложить вам размещение трека в нашем специальном разделе, посвященном AI-контенту.</p>'
            + '<p style="padding:16px;background:#1a1a2e;border-left:3px solid #F59E0B;border-radius:4px;"><strong>Стоимость размещения составляет ' + PUBLICATION_PRICE.toLocaleString('ru-RU') + ' рублей.</strong></p>'
            + '<p>Если вам откликается это предложение, мы будем рады продолжить сотрудничество.</p>'
            + (moderator_notes ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий модератора: ' + escapeHtml(moderator_notes) + '</p>' : '')
            + '<p style="text-align:center;margin:28px 0;"><a href="https://promo-music.ru/login" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#F59E0B,#D97706);color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Разместить в AI-каталоге</a></p>'
            + '<p>Спасибо за ваш интерес к новым музыкальным формам.</p>'
            + '<p style="color:#888;">С уважением,<br/>Команда Промо.Музыка</p>'
            + '</div>'
            + '<div style="background:#0d0d1a;padding:20px 32px;border-top:1px solid #2a2a4a;text-align:center;font-size:12px;color:#666;">'
            + '<p style="margin:0 0 8px;">Промо.Музыка — <a href="https://promo-music.ru" style="color:#FF577F;text-decoration:none;">promo-music.ru</a></p>'
            + '<p style="margin:0 0 8px;">info@promofm.ru · Москва, Россия</p>'
            + '<p style="margin:0;color:#555;">Вы получили это письмо, так как отправили трек на модерацию</p>'
            + '</div>'
            + '</div>';
        } else {
          // Normal track — paid approval email.
          emailSubject = 'Трек одобрен — ' + track.title;
          const statusBlock = '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #10B981;border-radius:4px;">Для публикации необходимо произвести оплату: <strong>' + PUBLICATION_PRICE.toLocaleString('ru-RU') + ' ₽</strong></p>';
          const ctaButton = '<p style="text-align:center;margin:28px 0;"><a href="https://promo-music.ru/artist/tracks" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#FF577F,#FF577F);color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Оплатить и опубликовать</a></p>';

          emailHtml = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a14;color:#e5e5e5;border-radius:12px;overflow:hidden;">'
            + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px 32px;text-align:center;border-bottom:1px solid #2a2a4a;">'
            + '<img src="https://promo-music.ru/logo.png" alt="Промо.Музыка" style="height:36px;" />'
            + '<p style="margin:8px 0 0;color:#888;font-size:13px;">Платформа для музыкантов и лейблов</p>'
            + '</div>'
            + '<div style="padding:32px;">'
            + '<p>Добрый день!</p>'
            + '<p>Благодарим вас за отправку трека на платформу Промо.Музыка. Мы внимательно прослушали вашу работу и с радостью сообщаем, что она прошла модерацию.</p>'
            + '<p>Ваш трек <strong>«' + escapeHtml(track.title) + '»</strong> одобрен к размещению, и мы будем рады представить его нашей аудитории.</p>'
            + statusBlock
            + '<p>Спасибо за ваше творчество и доверие к нашей платформе — это действительно ценно для нас.</p>'
            + (moderator_notes ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ' + escapeHtml(moderator_notes) + '</p>' : '')
            + ctaButton
            + '<p style="color:#888;">С уважением,<br/>Команда Промо.Музыка</p>'
            + '</div>'
            + '<div style="background:#0d0d1a;padding:20px 32px;border-top:1px solid #2a2a4a;text-align:center;font-size:12px;color:#666;">'
            + '<p style="margin:0 0 8px;">Промо.Музыка — <a href="https://promo-music.ru" style="color:#FF577F;text-decoration:none;">promo-music.ru</a></p>'
            + '<p style="margin:0 0 8px;">info@promofm.ru · Москва, Россия</p>'
            + '<p style="margin:0;color:#555;">Вы получили это письмо, так как отправили трек на модерацию</p>'
            + '</div>'
            + '</div>';
        }

        sendEmail({ to: artistEmail, subject: emailSubject, html: emailHtml })
          .then(() => sendEmail({ to: 'info@promofm.ru', subject: '[КОПИЯ] ' + emailSubject + ' (' + artistEmail + ')', html: emailHtml }))
          .catch((err: any) => console.error('[moderation] Email to artist failed:', err.message));
      }


      if (track.user_id) {
        // Notification copy: AI-track gets AI-section offer, normal track
        // goes through the paid approval path.
        const notifTitle = is_ai_track
          ? `«${track.title}» определён как AI-трек`
          : `Трек «${track.title}» одобрен!`;
        const notifMessage = is_ai_track
          ? `Композиция «${track.title}» определена как AI-трек. Предлагаем размещение в разделе AI-музыки за ${PUBLICATION_PRICE.toLocaleString('ru-RU')} руб.`
          : `Трек «${track.title}» одобрен. Для публикации оплатите ${PUBLICATION_PRICE.toLocaleString('ru-RU')} ₽.`;

        // Cross-cabinet event (admin → artist surface). Writes to the
        // cross_cabinet_notifications table and emits SSE — keeps
        // dashboards / admin-aware UI in sync.
        notifyCrossCabinet({
          targetUserId: track.user_id,
          targetRole: 'artist',
          sourceRole: 'admin',
          type: 'track_moderation',
          title: notifTitle,
          message: notifMessage,
          link: '/artist/tracks',
        }).catch(() => {});

        // Persistent inbox notification. The artist's bell / history
        // page reads from the `notifications` table (publish-routes
        // /notifications/:userId), NOT from cross_cabinet_notifications.
        // Without this write, "трек одобрен" never appears in the bell
        // — exactly what artists reported after this approval flow.
        const notifId = `tn-${crypto.randomUUID()}`;
        upsertNotification(String(track.user_id), notifId, {
          id: notifId,
          type: 'track_moderation',
          title: notifTitle,
          message: notifMessage,
          trackId: pendingTrackId,
          trackTitle: track.title,
          newStatus: 'approved',
          link: '/artist/tracks',
          read: false,
          createdAt: now,
        }).catch((err: any) => console.error('[moderation] inbox notif failed:', err?.message || err));
      }

      return c.json({
        success: true,
        message: is_ai_track
          ? 'Трек одобрен как ИИ-трек. Ожидает оплаты.'
          : 'Трек одобрен. Ожидает оплаты.',
        trackId: pendingTrackId,
        paymentRequired: true,
        paymentAmount: PUBLICATION_PRICE,
        aiFlagged: is_ai_track === true || (track.ai_score && track.ai_score > 60) || false,
        aiScore: track.ai_score || null,
        isAiTrack: is_ai_track === true || false,
      });

    } else if (action === 'reject') {
      const { rejection_type } = body;
      await typed.updateTrack(pendingTrackId, {
        moderation_status: 'rejected',
        rejection_reason: rejection_reason || '',
        moderation_comment: moderator_notes || null,
        moderated_at: now,
      });

      // Audit B-8: forensic trail кто отклонил + причина.
      logAdminAction(c, {
        action: 'track_moderation_reject',
        resourceType: 'track',
        targetId: String(pendingTrackId),
        details: { title: track.title, artist: track.artist_name, rejectionType: rejection_type || null, reason: rejection_reason || moderator_notes || null },
      });

      // Notify artist: email + in-app
      let rejectEmail = track.uploaded_by_email;
      if (!rejectEmail && track.user_id) {
        try {
          const { pool } = await import('./db-client.tsx');
          const ur = await pool.query('SELECT email FROM users WHERE id::text = $1', [String(track.user_id)]);
          rejectEmail = ur.rows[0]?.email || '';
        } catch {}
      }
      const rejectName = track.artist_name || 'Артист';
      const reason = rejection_reason || moderator_notes || 'Не указана';

      if (rejectEmail) {
        let rejectHtml: string;
        let rejectSubject: string;

        if (rejection_type === 'profanity') {
          // Rejection: profanity / explicit content
          rejectSubject = 'Результат модерации — ' + track.title;
          rejectHtml = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a14;color:#e5e5e5;border-radius:12px;overflow:hidden;">'
            + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px 32px;text-align:center;border-bottom:1px solid #2a2a4a;">'
            + '<img src="https://promo-music.ru/logo.png" alt="Промо.Музыка" style="height:36px;" />'
            + '<p style="margin:8px 0 0;color:#888;font-size:13px;">Платформа для музыкантов и лейблов</p>'
            + '</div>'
            + '<div style="padding:32px;">'
            + '<p>Добрый день!</p>'
            + '<p>Благодарим вас за отправку трека на платформу Промо.Музыка и за доверие к нашему отбору.</p>'
            + '<p>Мы внимательно ознакомились с вашей работой. К сожалению, на данный момент мы не можем принять её к размещению в связи с использованием ненормативной лексики, что не соответствует редакционной политике платформы.</p>'
            + '<p>При этом хотим отметить, что у трека есть своя энергия и характер, и мы будем рады рассмотреть его повторно, если появится версия без соответствующего контента (clean version).</p>'
            + (moderator_notes ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ' + escapeHtml(moderator_notes) + '</p>' : '')
            + '<p>Спасибо за ваше творчество и понимание.</p>'
            + '<p style="color:#888;">С уважением,<br/>Команда Промо.Музыка</p>'
            + '</div>'
            + '<div style="background:#0d0d1a;padding:20px 32px;border-top:1px solid #2a2a4a;text-align:center;font-size:12px;color:#666;">'
            + '<p style="margin:0 0 8px;">Промо.Музыка — <a href="https://promo-music.ru" style="color:#FF577F;text-decoration:none;">promo-music.ru</a></p>'
            + '<p style="margin:0 0 8px;">info@promofm.ru · Москва, Россия</p>'
            + '<p style="margin:0;color:#555;">Вы получили это письмо, так как отправили трек на модерацию</p>'
            + '</div>'
            + '</div>';
        } else {
          // General rejection
          rejectSubject = 'Результат модерации — ' + track.title;
          rejectHtml = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a14;color:#e5e5e5;border-radius:12px;overflow:hidden;">'
            + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px 32px;text-align:center;border-bottom:1px solid #2a2a4a;">'
            + '<img src="https://promo-music.ru/logo.png" alt="Промо.Музыка" style="height:36px;" />'
            + '<p style="margin:8px 0 0;color:#888;font-size:13px;">Платформа для музыкантов и лейблов</p>'
            + '</div>'
            + '<div style="padding:32px;">'
            + '<p>Добрый день!</p>'
            + '<p>Благодарим вас за отправку трека на платформу Промо.Музыка и за доверие к нашему отбору.</p>'
            + '<p>Мы внимательно ознакомились с вашей работой, однако на данный момент не готовы включить её в публикацию. Это решение связано с внутренними критериями отбора и текущей редакционной концепцией платформы.</p>'
            + '<p>Важно отметить, что это не оценка вашего потенциала, скорее вопрос соответствия формату и звучанию, которое мы формируем в данный момент.</p>'
            + '<p>Будем рады, если вы продолжите делиться с нами своими новыми релизами в будущем, возможно, следующая работа идеально совпадёт с нашим направлением.</p>'
            + (moderator_notes ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ' + escapeHtml(moderator_notes) + '</p>' : '')
            + '<p>Спасибо за ваше творчество и за то, что выбрали нас.</p>'
            + '<p style="color:#888;">С уважением,<br/>Команда Промо.Музыка</p>'
            + '</div>'
            + '<div style="background:#0d0d1a;padding:20px 32px;border-top:1px solid #2a2a4a;text-align:center;font-size:12px;color:#666;">'
            + '<p style="margin:0 0 8px;">Промо.Музыка — <a href="https://promo-music.ru" style="color:#FF577F;text-decoration:none;">promo-music.ru</a></p>'
            + '<p style="margin:0 0 8px;">info@promofm.ru · Москва, Россия</p>'
            + '<p style="margin:0;color:#555;">Вы получили это письмо, так как отправили трек на модерацию</p>'
            + '</div>'
            + '</div>';
        }

        sendEmail({ to: rejectEmail, subject: rejectSubject, html: rejectHtml })
          .then(() => sendEmail({ to: 'info@promofm.ru', subject: '[КОПИЯ] ' + rejectSubject + ' (' + rejectEmail + ')', html: rejectHtml }))
          .catch((err: any) => console.error('[moderation] Reject email failed:', err.message));
      }

      if (track.user_id) {
        const rejectTitle = `Трек «${track.title}» отклонён`;
        const rejectMsg = rejection_type === 'profanity'
          ? 'Трек «' + track.title + '» отклонён: ненормативная лексика. Примем clean version.'
          : 'Трек «' + track.title + '» отклонён. ' + (reason !== 'Не указана' ? reason : 'Не соответствует формату платформы.');

        notifyCrossCabinet({
          targetUserId: track.user_id,
          targetRole: 'artist',
          sourceRole: 'admin',
          type: 'track_moderation',
          title: rejectTitle,
          message: rejectMsg,
          link: '/artist/tracks',
        }).catch(() => {});

        // Persistent inbox row — same reason as the approve branch:
        // the bell reads `notifications`, not `cross_cabinet_notifications`.
        const notifId = `tn-${crypto.randomUUID()}`;
        upsertNotification(String(track.user_id), notifId, {
          id: notifId,
          type: 'track_moderation',
          title: rejectTitle,
          message: rejectMsg,
          trackId: pendingTrackId,
          trackTitle: track.title,
          newStatus: 'rejected',
          rejectionReason: reason || '',
          link: '/artist/tracks',
          read: false,
          createdAt: now,
        }).catch((err: any) => console.error('[moderation] inbox notif failed:', err?.message || err));
      }

      return c.json({
        success: true,
        message: 'Трек отклонён',
      });


    } else {
      return c.json({ error: 'Invalid action' }, 400);
    }
  } catch (error) {
    console.error('Error in manageTrackModeration:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /batchModeration — Batch approve/reject
app.post('/batchModeration', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { trackIds, action } = body;
    const now = new Date().toISOString();

    const results = [];
    for (const trackId of trackIds) {
      const track = await typed.getTrackById(trackId);
      if (!track) {
        results.push({ trackId, success: false, message: 'Not found' });
        continue;
      }
      // Same state guard as /manageTrackModeration — batch path must not
      // downgrade tracks that have already moved beyond 'pending'. Without
      // this a bulk re-approve could nuke payment records across many rows
      // at once.
      if (track.moderation_status !== 'pending') {
        results.push({
          trackId,
          success: false,
          message: `Уже не на модерации (${track.moderation_status})`,
        });
        continue;
      }

      if (action === 'approve') {
        // Все треки публикуются за полную цену. Native cols only.
        await typed.updateTrack(trackId, {
          moderation_status: 'approved',
          moderated_at: now,
          is_hidden: true,
          requires_payment: true,
          payment_amount: PUBLICATION_PRICE,
          first_track_free_applied: false,
          payment_completed: false,
          paid_at: null,
          upcoming_until: null,
          approved_for_release_at: null,
        });
      } else {
        await typed.updateTrack(trackId, {
          moderation_status: 'rejected',
          moderated_at: now,
        });
      }

      results.push({ trackId, success: true, message: `${action} successful` });
    }

    return c.json({
      success: true,
      message: `Processed ${trackIds.length} tracks`,
      results
    });
  } catch (error) {
    console.error('Error in batchModeration:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /genres
app.get('/genres', async (c) => {
  return c.json({ genres: GENRES });
});

// GET /uploadStats — artist sees how many tracks they can still upload
// on the current plan. Was gated behind requireAdmin which made every
// artist's track-upload page hang on a 403 (no stats → loading state
// stuck, then UI rendered nothing useful).
app.get('/uploadStats', requireAuth, async (c) => {
  try {
    return c.json({
      current: 0,
      limit: 10,
      remaining: 10,
      subscription: 'artist_pro'
    });
  } catch (error) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /stats — Moderation statistics
app.get('/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const stats = await typed.getTrackModerationStats();
    return c.json(stats);
  } catch (error) {
    console.error('Error in stats:', error);
    return c.json({ total: 0, pending: 0, approved: 0, paid: 0, upcoming: 0, rejected: 0 });
  }
});


// ─── Public: New Releases with YouTube playback ─────────────
app.get('/newReleases', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '25');
    const { getPlatformStats } = await import('./db.tsx');
    const cached: any = await getPlatformStats('tracks:new_releases');
    if (cached?.tracks?.length) {
      return c.json({ success: true, releases: cached.tracks.slice(0, limit) });
    }
    return c.json({ success: true, releases: [] });
  } catch (error) {
    console.error('Error fetching new releases:', error);
    return c.json({ success: true, releases: [] });
  }
});

// POST /reanalyze — Re-run AI analysis on a specific track
app.post('/reanalyze', requireAuth, requireAdmin, async (c) => {
  try {
    const { trackId } = await c.req.json();
    const track = await typed.getTrackById(trackId);
    if (!track) {
      return c.json({ error: 'Track not found' }, 404);
    }

    const audioUrl = track.audio_url || '';
    if (!audioUrl) {
      return c.json({ error: 'No audio file to analyze' }, 400);
    }

    // Run analysis synchronously (admin waits for result)
    let filePath = '';
    if (audioUrl.startsWith('/')) {
      filePath = audioUrl;
    } else if (audioUrl.includes('/uploads/track-audio/')) {
      const filename = audioUrl.split('/uploads/track-audio/').pop();
      filePath = `${UPLOADS_DIR}/track-audio/${filename}`;
    } else {
      return c.json({ error: 'Cannot analyze external URL' }, 400);
    }

    const resp = await fetch(`${AI_DETECTOR_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: filePath, track_id: trackId }),
    });

    if (!resp.ok) {
      return c.json({ error: `AI detector returned ${resp.status}` }, 502);
    }

    const result = await resp.json() as any;
    await typed.updateTrack(trackId, {
      ai_score: result.ai_score,
      ai_analysis: result,
      ai_verdict: result.verdict,
      ai_analyzed_at: new Date().toISOString(),
    });

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error('Error in reanalyze:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});


// ─── POST /approve-paid — Админ утверждает оплаченный трек → upcoming (3 дня в "Скоро") ───
//
// Production incident on first deploy: Nadezhda's track e77b1053 wound up with
// status='approved' + payment_amount=5000 after passing through this endpoint.
// Root cause — two cooperating bugs:
//
//   1. JS-side spread on data jsonb:
//        const track = await getTrackById(...)            // snapshot
//        update({ data: { ...(track.data||{}), ... } })   // writes snapshot back
//      If anything else (webhook, /manageTrackModeration race, replica lag)
//      modified data between the SELECT and the UPDATE, that change is lost.
//      Webhook had set data.payment_amount=1 just two seconds earlier; the
//      stale snapshot here put 5000 back.
//
//   2. No row-level guard on the UPDATE. We checked `moderation_status==='paid'`
//      against the snapshot but the UPDATE was unconditional. If a parallel
//      writer flipped the status between SELECT and UPDATE, we'd happily
//      stomp them.
//
// Fix: a single raw UPDATE statement that
//   (a) merges new jsonb fields with `data || jsonb_build_object(...)` so the
//       merge happens against the CURRENT row, not against a JS snapshot, and
//   (b) carries `WHERE moderation_status = 'paid'` so a concurrent flip
//       blocks us at the row level instead of racing against a snapshot
//       guard. The RETURNING row count tells us whether we actually wrote.
app.post('/approve-paid', requireAuth, requireAdmin, async (c) => {
  try {
    const { trackIds } = await c.req.json();
    if (!trackIds || !Array.isArray(trackIds) || trackIds.length === 0) {
      return c.json({ error: 'trackIds required' }, 400);
    }

    const UPCOMING_DAYS = 3;
    const upcomingUntil = new Date(Date.now() + UPCOMING_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const approvedAt = new Date().toISOString();
    const nowIso = new Date().toISOString();
    let updated = 0;
    const skipped: Array<{ trackId: string; reason: string; currentStatus?: string }> = [];

    for (const trackId of trackIds) {
      // Fetch a snapshot purely for the notification payload (title / user_id).
      // The actual write is row-guarded by WHERE moderation_status='paid', so
      // even if this snapshot is stale we won't damage anything: the UPDATE
      // either lands cleanly (rowCount=1) or is a no-op (rowCount=0).
      const snapshot = await typed.getTrackById(trackId);
      if (!snapshot) {
        skipped.push({ trackId, reason: 'not_found' });
        continue;
      }

      const result = await pool.query(
        // Native cols after migration 062 — upcoming_until/approved_for_release_at
        // в native; payment_amount читаем тоже из native.
        `UPDATE tracks
            SET moderation_status         = 'upcoming',
                is_hidden                 = false,
                upcoming_until            = $2::timestamptz,
                approved_for_release_at   = $3::timestamptz,
                updated_at                = $4::timestamptz
          WHERE id = $1
            AND moderation_status = 'paid'
          RETURNING moderation_status, payment_amount AS amount`,
        [trackId, upcomingUntil, approvedAt, nowIso]
      );

      if (result.rowCount === 0) {
        skipped.push({
          trackId,
          reason: 'not_in_paid_state',
          currentStatus: snapshot.moderation_status,
        });
        console.warn(
          `[approve-paid] skipped trackId=${trackId} — snapshot status=${snapshot.moderation_status}, ` +
          `expected 'paid'. Possible causes: already advanced, /manageTrackModeration ` +
          `re-approval race, or webhook never fired.`
        );
        continue;
      }

      console.log(
        `[approve-paid] OK trackId=${trackId} status: paid → upcoming, ` +
        `amount=${result.rows[0]?.amount}, upcoming_until=${upcomingUntil}`
      );

      // Notify artist
      if (snapshot.user_id) {
        const upcomingTitle = 'Трек скоро в эфире!';
        const upcomingMsg = `"${snapshot.title}" появится в новинках через ${UPCOMING_DAYS} дня`;
        notifyCrossCabinet({
          targetUserId: snapshot.user_id,
          targetRole: 'artist',
          sourceRole: 'admin',
          type: 'track_upcoming',
          title: upcomingTitle,
          message: upcomingMsg,
          link: '/artist/tracks',
        }).catch(() => {});

        // Also write to the persistent inbox so the bell sees it.
        const inboxId = `tn-${crypto.randomUUID()}`;
        upsertNotification(String(snapshot.user_id), inboxId, {
          id: inboxId,
          type: 'track_upcoming',
          title: upcomingTitle,
          message: upcomingMsg,
          trackId,
          trackTitle: snapshot.title,
          link: '/artist/tracks',
          read: false,
          createdAt: new Date().toISOString(),
        }).catch((err: any) => console.error('[approve-paid] inbox notif failed:', err?.message || err));
      }

      // Email-оповещение артисту: трек прошёл модерацию → «Скоро» (с именем, БЕЗ доступа в кабинет — просто уведомление).
      try {
        let notifyEmail = (snapshot as any).uploaded_by_email || '';
        if (!notifyEmail && snapshot.user_id) {
          const ur = await pool.query('SELECT email FROM users WHERE id::text = $1', [String(snapshot.user_id)]);
          notifyEmail = ur.rows[0]?.email || '';
        }
        if (notifyEmail) {
          const aName = (snapshot as any).artist_name || (snapshot as any).artist || 'артист';
          const subj = `Ваш трек «${snapshot.title}» прошёл модерацию — размещён в разделе «Скоро»`;
          const eHtml = emailWrapper(
            '<h2 style="margin:0 0 16px; color:#fff; font-size:20px;">Трек прошёл модерацию ✓</h2>'
            + '<p>Здравствуйте, <b>' + escapeHtml(aName) + '</b>!</p>'
            + '<p>Ваш трек <b style="color:#fff;">«' + escapeHtml(snapshot.title) + '»</b> успешно прошёл модерацию и размещён в разделе <b style="color:#FF577F;">«Скоро»</b>. Через ' + UPCOMING_DAYS + ' дня он появится в новинках на ПРОМО.МУЗЫКА.</p>'
            + '<p>Спасибо, что вы с нами!</p>'
            + '<p style="color:#999; font-size:13px; margin-top:20px;">Это автоматическое уведомление, отвечать на него не нужно.</p>'
          );
          sendEmail({ to: notifyEmail, subject: subj, html: eHtml })
            .then(() => sendEmail({ to: 'info@promofm.ru', subject: '[КОПИЯ] ' + subj + ' (' + notifyEmail + ')', html: eHtml }))
            .catch((e: any) => console.error('[approve-paid] upcoming email failed:', e?.message || e));
        }
      } catch (e: any) { console.error('[approve-paid] upcoming email lookup failed:', e?.message || e); }

      updated++;
    }

    return c.json({ success: true, updated, upcomingUntil, skipped });
  } catch (error) {
    console.error('Error in approve-paid:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ─── POST /promote-upcoming — Крон: upcoming треки с истёкшим сроком → published ───
app.post('/promote-upcoming', async (c) => {
  const key = c.req.header('X-Internal-Key') || '';
  const expectedKey = process.env.VPS_INTERNAL_KEY || '';
  if (!expectedKey || key !== expectedKey) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const now = new Date();
    // SQL-side filter по native upcoming_until (миграция 062). Раньше
    // JS-side filter по track.data?.upcoming_until — это был KV reader
    // на jsonb path, тащил все 'upcoming' rows в JS только чтобы
    // отфильтровать по date. После 062 — native col + partial index
    // idx_tracks_upcoming_until покрывает WHERE clause.
    const { rows } = await (await import('./db-client.tsx')).pool.query(
      `SELECT id, title, artist_name, user_id, audio_url
         FROM tracks
        WHERE moderation_status = 'upcoming'
          AND upcoming_until IS NOT NULL
          AND upcoming_until <= $1::timestamptz`,
      [now.toISOString()]
    );

    let promoted = 0;

    for (const track of rows) {
      await typed.updateTrack(track.id, {
        moderation_status: 'published',
        is_hidden: false,
        published_at: now.toISOString(),
      });

      // Stage аудио для air (AutoDJ читает из /mnt/data/promofm-music/tracks/).
      // Если трек загружен в /uploads/track-audio/ — копируем в MUSIC_DIR с
      // понятным именем и обновляем audio_url на /server/uploads/tracks/<name>.
      // build-metadata.py фильтрует именно LIKE '/server/uploads/tracks/%',
      // без этой нормализации artist-uploaded треки в эфир не попадают.
      // Идемпотентно: если файл уже в MUSIC_DIR — skip (cp -n).
      try {
        await stageTrackForAirplay(track.id, track);
      } catch (e: any) {
        console.warn(`[promote-upcoming] stageTrackForAirplay failed for ${track.id}:`, e?.message);
      }

      // Сразу инжектим трек в активный weekly_release (новинки недели).
      // Раньше: weekly_release пересоздавался только по пятницам через
      // friday.js, треки промоутнутые из upcoming в середине недели
      // повисали в БД published, но не появлялись в публичных «Новинках»
      // до следующей пятницы. Теперь cron сразу добавляет id в начало
      // track_ids текущего активного release (защита от дублей через
      // NOT t.id = ANY(track_ids)).
      try {
        await (await import('./db-client.tsx')).pool.query(
          `UPDATE weekly_releases
              SET track_ids = ARRAY[$1::uuid] || track_ids
            WHERE id = (
              SELECT id FROM weekly_releases
               WHERE is_published = true
               ORDER BY release_date DESC LIMIT 1
            )
              AND NOT ($1::uuid = ANY(track_ids))`,
          [track.id]
        );
      } catch (e: any) {
        console.warn('[promote-upcoming] weekly_release inject failed:', e?.message);
      }

      // Notify artist
      if (track.user_id) {
        const pubTitle = 'Трек опубликован!';
        const pubMsg = `"${track.title}" теперь в новинках недели`;
        notifyCrossCabinet({
          targetUserId: track.user_id,
          targetRole: 'artist',
          sourceRole: 'system',
          type: 'track_published',
          title: pubTitle,
          message: pubMsg,
          link: '/artist/tracks',
        }).catch(() => {});

        // Persistent inbox row — bell reads `notifications` not
        // `cross_cabinet_notifications`.
        const inboxId = `tn-${crypto.randomUUID()}`;
        upsertNotification(String(track.user_id), inboxId, {
          id: inboxId,
          type: 'track_published',
          title: pubTitle,
          message: pubMsg,
          trackId: track.id,
          trackTitle: track.title,
          link: '/artist/tracks',
          read: false,
          createdAt: new Date().toISOString(),
        }).catch((err: any) => console.error('[promote-upcoming] inbox notif failed:', err?.message || err));
      }

      promoted++;
    }

    // ── Mixes: тот же flow — upcoming с истёкшим upcoming_until → published ──
    // Зеркало tracks-цикла выше. Cron-задача одна (POST /promote-upcoming),
    // обрабатывает оба типа за один прогон. Уведомление DJ другое (link
    // на /dj/mixes), но логика идентична.
    let mixesPromoted = 0;
    try {
      // Native cols (migration 046): WHERE и UPDATE напрямую по
      // upcoming_until/published_at TIMESTAMPTZ. Partial index
      // idx_dj_mixes_upcoming_until покрывает этот запрос.
      const mixNow = new Date();
      const { rows: mixRows } = await (await import('./db-client.tsx')).pool.query(
        `SELECT id, title, dj_id
           FROM dj_mixes
          WHERE moderation_status = 'upcoming'
            AND upcoming_until IS NOT NULL
            AND upcoming_until <= $1::timestamptz`,
        [mixNow.toISOString()]
      );
      for (const mix of mixRows) {
        await (await import('./db-client.tsx')).pool.query(
          `UPDATE dj_mixes
              SET moderation_status = 'published',
                  status            = 'published',
                  is_hidden         = false,
                  published_at      = $2::timestamptz,
                  updated_at        = $2
            WHERE id = $1 AND moderation_status = 'upcoming'`,
          [mix.id, mixNow.toISOString()]
        );

        if (mix.dj_id) {
          const pubTitle = 'Микс опубликован!';
          const pubMsg = `«${mix.title}» теперь в Новинках недели`;
          notifyCrossCabinet({
            targetUserId: String(mix.dj_id),
            targetRole: 'dj',
            sourceRole: 'system',
            type: 'mix_published',
            title: pubTitle,
            message: pubMsg,
            link: '/dj/mixes',
          }).catch(() => {});

          const mixInboxId = `mn-${crypto.randomUUID()}`;
          upsertNotification(String(mix.dj_id), mixInboxId, {
            id: mixInboxId,
            type: 'mix_published',
            title: pubTitle,
            message: pubMsg,
            mixId: mix.id,
            mixTitle: mix.title,
            link: '/dj/mixes',
            read: false,
            createdAt: mixNow.toISOString(),
          }).catch((err: any) => console.error('[promote-upcoming/mix] inbox notif failed:', err?.message || err));
        }

        mixesPromoted++;
      }
    } catch (e: any) {
      console.error('[promote-upcoming/mix] failed:', e?.message);
    }

    // Rebuild new releases if any were promoted
    if (promoted > 0 || mixesPromoted > 0) {
      fetch('http://127.0.0.1:3000/server/api/charts/build-new-releases', {
        method: 'POST',
        headers: { 'X-Internal-Key': expectedKey, 'Content-Type': 'application/json' },
      }).catch(() => {});
    }

    return c.json({ success: true, promoted, mixesPromoted, checked: rows.length });
  } catch (error) {
    console.error('Error in promote-upcoming:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /send-payment-reminders — массовая рассылка для approved без оплаты
// Body: { minAgeDays?: number }  default 7
// Header: X-Internal-Key (cron) или admin auth
// ───────────────────────────────────────────────────────────────────
const _expectedRemKey = process.env.VPS_INTERNAL_KEY || '';

app.post('/send-payment-reminders', async (c) => {
  const internalKey = c.req.header('X-Internal-Key');
  const isCron = internalKey && internalKey === _expectedRemKey;
  if (!isCron) {
    // Admin path. requireAuth/requireAdmin RETURN c.json(...) on failure
    // but the returned Response is dropped on the floor here — so wrap in
    // a sentinel and check it (audit INC-2, 2026-05-31).
    //
    // Follow-up 2026-05-31: bare `return;` on !authorized left c.res
    // unset → Hono built a default Response with status outside 200-599
    // → RangeError → 500 instead of clean 401 (visible in Sentry on
    // threat-detector.tsx:615 which is just the next middleware in the
    // chain). Bypass was always closed (work not executed), but the
    // status code was junk. Return an explicit 401 to fix the wire
    // response — semantically we know the request was unauthenticated/
    // unauthorized, the exact 401-vs-403 distinction doesn't matter for
    // a client that has no business hitting this endpoint anyway.
    let authorized = false;
    await requireAuth(c, async () => {
      await requireAdmin(c, async () => { authorized = true; });
    });
    if (!authorized) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const minAgeDays = parseInt(body.minAgeDays) || 7;
    const reminderInterval = parseInt(body.reminderIntervalDays) || 7;

    const { pool } = await import('./db-client.tsx');
    // Find approved tracks older than minAgeDays whose last_reminder_at (in data) is either null or older than reminderInterval
    const r = await pool.query(`
      SELECT t.id, t.title, t.artist_name, t.uploaded_by_email, t.user_id,
             u.email as user_email, t.created_at
      FROM tracks t LEFT JOIN users u ON u.id::text = t.user_id::text
      WHERE t.moderation_status = 'approved'
        AND t.created_at < NOW() - ($1::int || ' days')::interval
        AND t.user_id IS NOT NULL AND t.user_id::text NOT LIKE 'sys-%%'
        AND COALESCE(t.last_payment_reminder_at, '1970-01-01'::timestamptz)
            < NOW() - ($2::int || ' days')::interval
      ORDER BY t.created_at ASC
      LIMIT 100
    `, [minAgeDays, reminderInterval]);

    let sent = 0;
    let skipped = 0;
    for (const t of r.rows) {
      const email = t.uploaded_by_email || t.user_email || '';
      if (!email) { skipped++; continue; }

      const subject = 'Напоминание об оплате — ' + t.title;
      const html = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a14;color:#e5e5e5;border-radius:12px;overflow:hidden;">'
        + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px 32px;text-align:center;">'
        + '<img src="https://promo-music.ru/logo.png" alt="Промо.Музыка" style="height:36px;" />'
        + '</div><div style="padding:32px;">'
        + '<p>Добрый день!</p>'
        + '<p>Ваш трек <strong>«' + escapeHtml(t.title) + '»</strong> одобрен модерацией и ждёт оплаты для публикации.</p>'
        + '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #10B981;border-radius:4px;">Стоимость публикации: <strong>5 000 ₽</strong></p>'
        + '<p style="text-align:center;margin:28px 0;"><a href="https://promo-music.ru/artist/tracks" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#FF577F,#FF577F);color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Оплатить и опубликовать</a></p>'
        + '<p style="color:#888;">Если у вас вопросы — ответьте на это письмо.</p>'
        + '</div></div>';

      try {
        await sendEmail({ to: email, subject, html });
        sent++;
        // Stamp reminder
        await pool.query(`UPDATE tracks SET last_payment_reminder_at = NOW() WHERE id = $1`, [t.id]);

        // SSE
        try {
          const { emitSSE } = await import('./sse-routes.tsx');
          emitSSE(String(t.user_id), {
            type: 'payment_reminder',
            data: {
              title: 'Напоминание об оплате',
              message: 'Трек «' + t.title + '» ждёт оплату — 5 000 ₽',
              trackId: t.id,
              link: '/artist/tracks',
            },
          });
        } catch {}
      } catch (err: any) {
        console.error('[reminder]', t.id, err?.message);
      }
    }

    return c.json({ success: true, sent, skipped, total: r.rows.length, minAgeDays, reminderInterval });
  } catch (err: any) {
    return c.json({ success: false, error: err?.message || 'Internal error' }, 500);
  }
});


// ─── AI-check admin endpoints ────────────────────────────────────────────────

// POST /ai-check/run/:trackId — re-run analyzer on a single track
app.post('/ai-check/run/:trackId', requireAuth, requireAdmin, async (c) => {
  const trackId = c.req.param('trackId');
  const { rows } = await pool.query<{ audio_url: string }>(
    'SELECT audio_url FROM tracks WHERE id = $1',
    [trackId],
  );
  if (!rows[0]) {
    return c.json({ success: false, error: 'Track not found' }, 404);
  }
  if (!rows[0].audio_url) {
    return c.json({ success: false, error: 'Track has no audio_url' }, 422);
  }
  scheduleAiCheck(trackId, rows[0].audio_url);
  return c.json({ success: true, status: 'queued', trackId });
});

// POST /ai-check/backfill — enqueue all unchecked tracks (default 50, max 500)
app.post('/ai-check/backfill', requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 500);
  const queued = await backfillAiCheck(limit);
  return c.json({ success: true, queued, limit });
});

export default app;


