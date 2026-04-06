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

    const track = await typed.insertTrack({
      title: body.title || '',
      artist_name: body.artist || body.artist_name || '',
      genre: body.genre || '',
      duration: body.duration || 0,
      audio_url: body.audio_file_url || body.audio_url || '',
      cover_url: body.cover_image_url || body.cover_url || '',
      yandex_music_url: body.yandex_music_url || '',
      youtube_url: body.youtube_url || '',
      spotify_url: body.spotify_url || '',
      uploaded_by_email: c.get('userEmail') || body.uploaded_by_email || body.contact_email || body.email || '',
      user_id: c.get('userId') || null,  // ALWAYS from JWT — requireAuth guarantees this
      moderation_status: 'pending',
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
      const artistEmail = track.uploaded_by_email;
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
            + '<p style="text-align:center;margin:28px 0;"><a href="https://promo-music.ru/login" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#FF577F,#FF577F);color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Оплатить и опубликовать</a></p>'
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
      const rejectEmail = track.uploaded_by_email;
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

// GET /uploadStats
app.get('/uploadStats', requireAuth, requireAdmin, async (c) => {
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

export default app;
