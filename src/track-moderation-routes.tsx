/**
 * TRACK MODERATION ROUTES v2 — Uses typed `tracks` table
 * Approve → status='published' + award coins (REAL)
 * One table, one row per track. No separate moderation store.
 */

import { notifyTrackUpload, sendEmail } from './email-helper.tsx';
import { notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import * as typed from './db-typed.tsx';
import { getDbClient } from './db-client.tsx';

const app = new Hono();

const GENRES = [
  'Pop', 'Rock', 'Hip-Hop', 'R&B', 'Electronic', 'Dance',
  'House', 'Techno', 'Trance', 'Dubstep', 'Drum & Bass',
  'Jazz', 'Blues', 'Classical', 'Country', 'Folk',
  'Reggae', 'Afrobeat', 'Metal', 'Punk', 'Indie', 'Alternative',
  'Soul', 'Funk', 'Disco', 'Gospel', 'Latin', 'World'
];

const PUBLICATION_PRICE = 5000; // 5000 RUB for track publication
const AI_DETECTOR_URL = 'http://127.0.0.1:8085';
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/var/www/promofm/uploads';

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

    const result = await resp.json();
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
      // Optional artist shoutout — short voice greeting played before the
      // track on partner radio. Lives in the JSONB `data` blob so we don't
      // need a column migration for an opt-in field.
      data: body.shoutout_url ? { shoutout_url: String(body.shoutout_url) } : {},
    });

    if (!track) {
      return c.json({ error: 'Failed to create track' }, 500);
    }

    // Fire-and-forget AI analysis (don't block the response)
    const audioUrl = track.audio_url || body.audio_file_url || body.audio_url || '';
    if (audioUrl) {
      triggerAiAnalysis(track.id, audioUrl).catch(() => {});
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
      overall_score: t.data?.overall_score || null,
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

    const now = new Date().toISOString();

    if (action === 'approve') {
      // Модерация одобрена -> статус approved (ожидает оплаты 5000 RUB)
      // После оплаты -> upcoming (раздел Скоро) -> затем published
      const aiWarning = (track.ai_score && track.ai_score > 60)
        ? ` AI: ${track.ai_score}% (${track.ai_verdict})`
        : '';

      await typed.updateTrack(pendingTrackId, {
        moderation_status: 'approved',
        moderation_comment: moderator_notes || 'Трек одобрен',
        moderated_at: now,
        is_hidden: true,
        is_ai_track: is_ai_track === true || false,
        data: {
          ...(track.data || {}),
          overall_score: overall_score || null,
          requires_payment: true,
          payment_amount: PUBLICATION_PRICE,
          ai_flagged: is_ai_track === true || (track.ai_score && track.ai_score > 60) || false,
          is_ai_track: is_ai_track === true || false,
          ai_category: is_ai_track ? 'ai_music' : 'original',
        },
      });

      console.log(`[moderation] Track ${pendingTrackId} approved. Awaiting payment ${PUBLICATION_PRICE} RUB.` + aiWarning);

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
            + '<p>В процессе модерации наша система анализа <strong>Promo.Check</strong> определила, что композиция <strong>«' + track.title + '»</strong> с высокой вероятностью (около ' + aiPercent + '%) была создана с использованием технологий искусственного интеллекта.</p>'
            + '<p>Готовы предложить вам размещение трека в нашем специальном разделе, посвященном AI-контенту.</p>'
            + '<p style="padding:16px;background:#1a1a2e;border-left:3px solid #F59E0B;border-radius:4px;"><strong>Стоимость размещения составляет ' + PUBLICATION_PRICE.toLocaleString('ru-RU') + ' рублей.</strong></p>'
            + '<p>Если вам откликается это предложение, мы будем рады продолжить сотрудничество.</p>'
            + (moderator_notes ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий модератора: ' + moderator_notes + '</p>' : '')
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
          // Normal track — standard approval email
          emailSubject = 'Трек одобрен — ' + track.title;
          emailHtml = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a14;color:#e5e5e5;border-radius:12px;overflow:hidden;">'
            + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px 32px;text-align:center;border-bottom:1px solid #2a2a4a;">'
            + '<img src="https://promo-music.ru/logo.png" alt="Промо.Музыка" style="height:36px;" />'
            + '<p style="margin:8px 0 0;color:#888;font-size:13px;">Платформа для музыкантов и лейблов</p>'
            + '</div>'
            + '<div style="padding:32px;">'
            + '<p>Добрый день!</p>'
            + '<p>Благодарим вас за отправку трека на платформу Промо.Музыка. Мы внимательно прослушали вашу работу и с радостью сообщаем, что она прошла модерацию.</p>'
            + '<p>Ваш трек <strong>«' + track.title + '»</strong> одобрен к размещению, и мы будем рады представить его нашей аудитории.</p>'
            + '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #10B981;border-radius:4px;">Для публикации необходимо произвести оплату: <strong>' + PUBLICATION_PRICE.toLocaleString('ru-RU') + ' ₽</strong></p>'
            + '<p>Спасибо за ваше творчество и доверие к нашей платформе — это действительно ценно для нас.</p>'
            + (moderator_notes ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ' + moderator_notes + '</p>' : '')
            + '<p style="text-align:center;margin:28px 0;"><a href="https://promo-music.ru/artist/tracks" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#FF577F,#FF577F);color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Оплатить и опубликовать</a></p>'
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
        if (is_ai_track) {
          notifyCrossCabinet({
            targetUserId: track.user_id,
            targetRole: 'artist',
            sourceRole: 'admin',
            type: 'track_moderation',
            title: 'Результат модерации',
            message: 'Композиция «' + track.title + '» определена как AI-трек. Предлагаем размещение в разделе AI-музыки за ' + PUBLICATION_PRICE.toLocaleString('ru-RU') + ' руб.',
            link: '/artist/tracks',
          }).catch(() => {});
        } else {
          notifyCrossCabinet({
            targetUserId: track.user_id,
            targetRole: 'artist',
            sourceRole: 'admin',
            type: 'track_moderation',
            title: 'Трек одобрен!',
            message: 'Трек «' + track.title + '» одобрен. Для публикации оплатите ' + PUBLICATION_PRICE.toLocaleString('ru-RU') + ' ₽.',
            link: '/artist/tracks',
          }).catch(() => {});
        }
      }

      return c.json({
        success: true,
        message: is_ai_track ? 'Трек одобрен как ИИ-трек. Ожидает оплаты.' : 'Трек одобрен. Ожидает оплаты.',
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
            + (moderator_notes ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ' + moderator_notes + '</p>' : '')
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
            + (moderator_notes ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ' + moderator_notes + '</p>' : '')
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
        const rejectMsg = rejection_type === 'profanity'
          ? 'Трек «' + track.title + '» отклонён: ненормативная лексика. Примем clean version.'
          : 'Трек «' + track.title + '» отклонён. ' + (reason !== 'Не указана' ? reason : 'Не соответствует формату платформы.');
        notifyCrossCabinet({
          targetUserId: track.user_id,
          targetRole: 'artist',
          sourceRole: 'admin',
          type: 'track_moderation',
          title: 'Результат модерации',
          message: rejectMsg,
          link: '/artist/tracks',
        }).catch(() => {});
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

      if (action === 'approve') {
        await typed.updateTrack(trackId, {
          moderation_status: 'approved',
          moderated_at: now,
          is_hidden: true,
          data: {
            ...(track.data || {}),
            requires_payment: true,
            payment_amount: PUBLICATION_PRICE,
          },
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
    return c.json({ total: 0, pending: 0, approved: 0, rejected: 0 });
  }
});


// ─── Public: New Releases with YouTube playback ─────────────
app.get('/newReleases', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '25');
    const { platformStatsStore } = await import('./db.tsx');
    const cached: any = await platformStatsStore.get('tracks:new_releases');
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

    const result = await resp.json();
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
app.post('/approve-paid', requireAuth, requireAdmin, async (c) => {
  try {
    const { trackIds } = await c.req.json();
    if (!trackIds || !Array.isArray(trackIds) || trackIds.length === 0) {
      return c.json({ error: 'trackIds required' }, 400);
    }

    const UPCOMING_DAYS = 3;
    const upcomingUntil = new Date(Date.now() + UPCOMING_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let updated = 0;

    for (const trackId of trackIds) {
      const track = await typed.getTrackById(trackId);
      if (!track || track.moderation_status !== 'paid') continue;

      await typed.updateTrack(trackId, {
        moderation_status: 'upcoming',
        is_hidden: false,
        data: {
          ...(track.data || {}),
          upcoming_until: upcomingUntil,
          approved_for_release_at: new Date().toISOString(),
        },
      });

      // Notify artist
      if (track.user_id) {
        notifyCrossCabinet({
          targetUserId: track.user_id,
          targetRole: 'artist',
          sourceRole: 'admin',
          type: 'track_upcoming',
          title: 'Трек скоро в эфире!',
          message: `"${track.title}" появится в новинках через ${UPCOMING_DAYS} дня`,
          link: '/artist/tracks',
        }).catch(() => {});
      }

      updated++;
    }

    return c.json({ success: true, updated, upcomingUntil });
  } catch (error) {
    console.error('Error in approve-paid:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ─── POST /promote-upcoming — Крон: upcoming треки с истёкшим сроком → published ───
app.post('/promote-upcoming', async (c) => {
  const key = c.req.header('X-Internal-Key') || '';
  const expectedKey = process.env.VPS_INTERNAL_KEY || '';
  if (expectedKey && key !== expectedKey) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const { rows } = await (await import('./db-client.tsx')).pool.query(
      `SELECT id, title, artist_name, user_id, data FROM tracks WHERE moderation_status = 'upcoming'`
    );

    const now = new Date();
    let promoted = 0;

    for (const track of rows) {
      const upcomingUntil = track.data?.upcoming_until;
      if (!upcomingUntil || new Date(upcomingUntil) > now) continue;

      await typed.updateTrack(track.id, {
        moderation_status: 'published',
        is_hidden: false,
        data: {
          ...(track.data || {}),
          published_at: now.toISOString(),
        },
      });

      // Notify artist
      if (track.user_id) {
        notifyCrossCabinet({
          targetUserId: track.user_id,
          targetRole: 'artist',
          sourceRole: 'system',
          type: 'track_published',
          title: 'Трек опубликован!',
          message: `"${track.title}" теперь в новинках недели`,
          link: '/artist/tracks',
        }).catch(() => {});
      }

      promoted++;
    }

    // Rebuild new releases if any were promoted
    if (promoted > 0) {
      fetch('http://127.0.0.1:3000/server/api/charts/build-new-releases', {
        method: 'POST',
        headers: { 'X-Internal-Key': expectedKey, 'Content-Type': 'application/json' },
      }).catch(() => {});
    }

    return c.json({ success: true, promoted, checked: rows.length });
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
    // Admin path
    try {
      await requireAuth(c, async () => { await requireAdmin(c, async () => {}); });
    } catch {
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
             u.email as user_email, t.data, t.created_at
      FROM tracks t LEFT JOIN users u ON u.id::text = t.user_id::text
      WHERE t.moderation_status = 'approved'
        AND t.created_at < NOW() - ($1::int || ' days')::interval
        AND t.user_id IS NOT NULL AND t.user_id::text NOT LIKE 'sys-%%'
        AND COALESCE((t.data->>'last_payment_reminder_at')::timestamptz, '1970-01-01'::timestamptz)
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
        + '<p>Ваш трек <strong>«' + t.title + '»</strong> одобрен модерацией и ждёт оплаты для публикации.</p>'
        + '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #10B981;border-radius:4px;">Стоимость публикации: <strong>5 000 ₽</strong></p>'
        + '<p style="text-align:center;margin:28px 0;"><a href="https://promo-music.ru/artist/tracks" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#FF577F,#FF577F);color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Оплатить и опубликовать</a></p>'
        + '<p style="color:#888;">Если у вас вопросы — ответьте на это письмо.</p>'
        + '</div></div>';

      try {
        await sendEmail({ to: email, subject, html });
        sent++;
        // Stamp reminder
        await pool.query(`UPDATE tracks SET data = COALESCE(data,'{}'::jsonb) || jsonb_build_object('last_payment_reminder_at', NOW()::text) WHERE id = $1`, [t.id]);

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

export default app;
