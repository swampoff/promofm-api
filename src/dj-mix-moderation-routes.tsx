/**
 * DJ MIX MODERATION ROUTES — зеркало track-moderation-routes.tsx для DJ-миксов.
 *
 * Те же стейты что у tracks (pending → approved → published / rejected),
 * та же цена 5000 ₽ + бесплатная квота на первый микс, тот же UX в
 * admin /ctrl-pm7k2f. После апрува микс попадает в "Новинки недели" наряду
 * с треками артистов (см. landing-data-routes.tsx /tracks/new UNION).
 *
 * Эндпоинты:
 *   GET  /pending-dj-mixes               — admin list
 *   POST /manage-dj-mix-moderation       — admin approve/reject
 *
 * Mounted в index.ts: app.route('/server/api/dj-mix-moderation', djMixModerationRoutes)
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { pool } from './db-client.tsx';
import { upsertNotification } from './db.tsx';
import { notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { sendEmail } from './email-helper.tsx';
import crypto from 'crypto';

const app = new Hono();

const MIX_PUBLICATION_PRICE = 5000; // зеркало tracks PUBLICATION_PRICE

/**
 * Resolve publication price for a DJ mix being approved.
 * Та же логика что resolveTrackPublicationPrice (track-moderation-routes.tsx:51):
 * первый микс DJ на платформе — бесплатно, последующие — MIX_PUBLICATION_PRICE.
 *
 * "Квота использована" = у DJ уже есть хотя бы один микс что либо
 *   (a) прошёл оплату и попал в upcoming/published с data.payment_amount>0,
 *   (b) был сам помечен first_mix_free_applied=true.
 * Текущий микс исключается из подсчёта чтобы повторный апрув не ломал цену.
 */
async function resolveDjMixPublicationPrice(djId: string, currentMixId: string): Promise<number> {
  if (!djId) return MIX_PUBLICATION_PRICE;
  try {
    // Native cols since migration 046 — data jsonb column на dj_mixes DROP'нут.
    // Раньше код читал data->>'payment_amount' / data->>'first_mix_free_applied',
    // что crash'ило query (column "data" does not exist) → catch swallowed →
    // всегда возвращал MIX_PUBLICATION_PRICE → first-mix-free квота никогда
    // не работала, каждый DJ платил 5000 RUB.
    const r = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM dj_mixes
          WHERE dj_id = $1
            AND id <> $2
            AND (
              (moderation_status IN ('upcoming', 'published')
                AND COALESCE(payment_amount, 0) > 0)
              OR first_mix_free_applied = TRUE
            )
       )::int AS used_quota`,
      [djId, currentMixId]
    );
    const used = Number(r.rows[0]?.used_quota || 0) > 0;
    return used ? MIX_PUBLICATION_PRICE : 0;
  } catch (e: any) {
    console.warn('[dj-mix-moderation] resolveDjMixPublicationPrice failed:', e?.message);
    return MIX_PUBLICATION_PRICE;
  }
}

// GET /pending-dj-mixes — список миксов на модерации (admin)
app.get('/pending-dj-mixes', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'pending';
    const search = c.req.query('search') || '';
    const limit = Math.min(parseInt(c.req.query('limit') || '200'), 500);

    const params: any[] = [];
    const where: string[] = [];

    if (status !== 'all') {
      params.push(status);
      where.push(`m.moderation_status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(m.title ILIKE $${params.length} OR m.genre ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    const limitSql = `LIMIT $${params.length}`;

    // LEFT JOIN dj_profiles чтобы выдать имя DJ в админ-таблицу.
    // Если у DJ нет профиля — fallback на user_id.
    const { rows } = await pool.query(
      // Native cols since migration 046 (data column DROP'нут):
      // is_premium / price / requires_payment / payment_amount /
      // first_mix_free_applied. Раньше SELECT m.data crash'ил query.
      `SELECT m.id, m.dj_id, m.title, m.genre, m.duration, m.audio_url, m.cover_url,
              m.description, m.bpm_range,
              m.is_premium, m.price, m.requires_payment, m.payment_amount,
              m.first_mix_free_applied,
              m.moderation_status, m.moderated_at,
              m.moderation_comment, m.rejection_reason, m.is_hidden,
              m.created_at, m.updated_at,
              dp.dj_name AS dj_name, u.email AS dj_email
         FROM dj_mixes m
         LEFT JOIN dj_profiles dp ON dp.user_id = m.dj_id
         LEFT JOIN users u ON u.id::text = m.dj_id
         ${whereSql}
         ORDER BY m.created_at DESC
         ${limitSql}`,
      params
    );

    const mapped = rows.map((r: any) => ({
      id: r.id,
      title: r.title || '',
      djId: r.dj_id || '',
      djName: r.dj_name || '',
      djEmail: r.dj_email || '',
      genre: r.genre || '',
      duration: r.duration || 0,
      audioUrl: r.audio_url || '',
      coverUrl: r.cover_url || '',
      description: r.description || '',
      bpmRange: r.bpm_range || '',
      isPremium: !!r.is_premium,
      price: Number(r.price || 0),
      moderationStatus: r.moderation_status,
      moderatedAt: r.moderated_at,
      moderationComment: r.moderation_comment || '',
      rejectionReason: r.rejection_reason || '',
      isHidden: !!r.is_hidden,
      requiresPayment: !!r.requires_payment,
      paymentAmount: Number(r.payment_amount || 0),
      firstMixFreeApplied: !!r.first_mix_free_applied,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return c.json({ mixes: mapped });
  } catch (error: any) {
    console.error('Error in pending-dj-mixes:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// POST /manage-dj-mix-moderation — admin approve / reject
app.post('/manage-dj-mix-moderation', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { pendingMixId, action, moderator_notes, rejection_reason, rejection_type } = body;

    if (!pendingMixId || !action) {
      return c.json({ error: 'pendingMixId и action обязательны' }, 400);
    }
    if (action !== 'approve' && action !== 'reject') {
      return c.json({ error: 'action должен быть approve или reject' }, 400);
    }

    // Native cols (migration 046) — data jsonb dropped.
    const mixRes = await pool.query(
      `SELECT id, dj_id, title, audio_url, cover_url, moderation_status, paid_at
         FROM dj_mixes WHERE id = $1 LIMIT 1`,
      [pendingMixId]
    );
    const mix = mixRes.rows[0];
    if (!mix) return c.json({ error: 'Mix not found' }, 404);

    // State guard — зеркало track-moderation-routes.tsx:326. Защита от
    // stale-UI клика по уже одобренной строке. Без этого админ может
    // даунгрейднуть оплаченный микс обратно в 'approved' и сбросить
    // payment_amount.
    if (mix.moderation_status !== 'pending') {
      console.warn(
        `[dj-mix-moderation] BLOCKED action=${action} on mixId=${pendingMixId}: ` +
        `current status=${mix.moderation_status}, expected 'pending'.`
      );
      return c.json({
        error: 'Микс уже не на модерации',
        currentStatus: mix.moderation_status,
        message: `Микс уже не на модерации (текущий статус: ${mix.moderation_status})`,
      }, 409);
    }

    const now = new Date().toISOString();
    const djId = String(mix.dj_id || '');

    if (action === 'approve') {
      // Акция «Первый микс бесплатно» отключена 2026-05-31 (зеркально треки).
      // resolveDjMixPublicationPrice оставлен для будущих скидок/промокодов.
      const publicationPrice = MIX_PUBLICATION_PRICE;
      const isFirstFree = false;

      // Для first-mix-free выставляем upcoming_until = now + 3 дня
      // (UPCOMING_DAYS) — без этого cron /promote-upcoming не поднимет
      // микс в published. Симметрично track-flow approve-paid.
      const UPCOMING_DAYS = 3;
      const upcomingUntil = isFirstFree
        ? new Date(Date.now() + UPCOMING_DAYS * 86400000).toISOString()
        : null;

      // Native cols (migration 046): больше никакого data jsonb merge.
      // COALESCE для paid_at сохраняет существующее значение когда оно
      // не isFirstFree (re-approve scenario).
      await pool.query(
        `UPDATE dj_mixes
            SET moderation_status        = $1,
                moderation_comment       = $2,
                moderated_at             = $3,
                is_hidden                = $4,
                status                   = $5,
                requires_payment         = $6,
                payment_amount           = $7,
                first_mix_free_applied   = $8,
                paid_at                  = CASE WHEN $8 THEN $3::timestamptz ELSE paid_at END,
                upcoming_until           = COALESCE($9::timestamptz, upcoming_until),
                approved_for_release_at  = COALESCE($9::timestamptz, approved_for_release_at),
                updated_at               = NOW()
          WHERE id = $10`,
        [
          isFirstFree ? 'upcoming' : 'approved',
          moderator_notes || (isFirstFree ? 'Микс одобрен (первый микс — бесплатно)' : 'Микс одобрен'),
          now,
          !isFirstFree,                         // is_hidden=false только для бесплатных
          isFirstFree ? 'upcoming' : 'draft',  // старая колонка status держим в синхроне
          !isFirstFree,                         // requires_payment
          publicationPrice,                     // payment_amount
          isFirstFree,                          // first_mix_free_applied
          upcomingUntil,                        // upcoming_until (NULL для paid path)
          pendingMixId,
        ]
      );

      if (isFirstFree) {
        console.log(`[dj-mix-moderation] Mix ${pendingMixId} approved + auto-published (first-mix-free quota).`);
      } else {
        console.log(`[dj-mix-moderation] Mix ${pendingMixId} approved. Awaiting payment ${publicationPrice} RUB.`);
      }

      // Email DJ (fallback chain: users.email → cabinet-stored email)
      let djEmail = '';
      try {
        const ur = await pool.query('SELECT email FROM users WHERE id::text = $1', [djId]);
        djEmail = ur.rows[0]?.email || '';
      } catch {}

      if (djEmail) {
        const emailSubject = isFirstFree
          ? `Микс опубликован — ${mix.title}`
          : `Микс одобрен — ${mix.title}`;
        const statusBlock = isFirstFree
          ? '<p style="padding:12px;background:#1a1a2e;border-left:3px solid #10B981;border-radius:4px;">Это ваш <strong>первый микс на платформе — публикация бесплатна</strong> по акции «Первый микс без оплаты». Микс уже в «Новинках недели».</p>'
          : `<p style="padding:12px;background:#1a1a2e;border-left:3px solid #10B981;border-radius:4px;">Для публикации необходимо произвести оплату: <strong>${MIX_PUBLICATION_PRICE.toLocaleString('ru-RU')} ₽</strong></p>`;
        const ctaButton = isFirstFree
          ? '<p style="text-align:center;margin:28px 0;"><a href="https://promo-music.ru/dj/mixes" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#10B981,#059669);color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Посмотреть в кабинете</a></p>'
          : '<p style="text-align:center;margin:28px 0;"><a href="https://promo-music.ru/dj/mixes" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#8B5CF6,#7C3AED);color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Оплатить и опубликовать</a></p>';

        const emailHtml =
          '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a14;color:#e5e5e5;border-radius:12px;overflow:hidden;">'
          + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px 32px;text-align:center;border-bottom:1px solid #2a2a4a;">'
          + '<img src="https://promo-music.ru/logo.png" alt="Промо.Музыка" style="height:36px;" />'
          + '<p style="margin:8px 0 0;color:#888;font-size:13px;">DJ-кабинет</p>'
          + '</div>'
          + '<div style="padding:32px;">'
          + '<p>Добрый день!</p>'
          + `<p>Ваш микс <strong>«${mix.title}»</strong> прошёл модерацию и одобрен к публикации.</p>`
          + statusBlock
          + (moderator_notes ? `<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ${moderator_notes}</p>` : '')
          + ctaButton
          + '<p style="color:#888;">С уважением,<br/>Команда Промо.Музыка</p>'
          + '</div>'
          + '</div>';

        sendEmail({ to: djEmail, subject: emailSubject, html: emailHtml })
          .catch((err: any) => console.error('[dj-mix-moderation] Email to DJ failed:', err.message));
      }

      // In-app notification (DJ bell + admin SSE)
      const notifTitle = isFirstFree
        ? `Микс «${mix.title}» опубликован!`
        : `Микс «${mix.title}» одобрен!`;
      const notifMessage = isFirstFree
        ? `Микс «${mix.title}» опубликован бесплатно по акции «Первый микс без оплаты». Он уже в «Новинках недели».`
        : `Микс «${mix.title}» одобрен. Для публикации оплатите ${MIX_PUBLICATION_PRICE.toLocaleString('ru-RU')} ₽.`;

      notifyCrossCabinet({
        targetUserId: djId,
        targetRole: 'dj',
        sourceRole: 'admin',
        type: 'mix_moderation',
        title: notifTitle,
        message: notifMessage,
        link: '/dj/mixes',
      }).catch(() => {});

      const notifId = `mn-${crypto.randomUUID()}`;
      upsertNotification(djId, notifId, {
        id: notifId,
        type: 'mix_moderation',
        title: notifTitle,
        message: notifMessage,
        mixId: pendingMixId,
        mixTitle: mix.title,
        newStatus: isFirstFree ? 'upcoming' : 'approved',
        link: '/dj/mixes',
        read: false,
        createdAt: now,
      }).catch((err: any) => console.error('[dj-mix-moderation] inbox notif failed:', err?.message || err));

      return c.json({
        success: true,
        message: isFirstFree
          ? 'Микс одобрен и опубликован бесплатно (первый микс по акции).'
          : 'Микс одобрен. Ожидает оплаты.',
        mixId: pendingMixId,
        paymentRequired: !isFirstFree,
        paymentAmount: publicationPrice,
        isFirstFree,
      });
    }

    // ── reject ──
    const reason = rejection_reason || moderator_notes || 'Не указана';
    await pool.query(
      `UPDATE dj_mixes
          SET moderation_status   = 'rejected',
              rejection_reason    = $1,
              moderation_comment  = $2,
              moderated_at        = $3,
              is_hidden           = TRUE,
              status              = 'draft',
              updated_at          = NOW()
        WHERE id = $4`,
      [rejection_reason || '', moderator_notes || null, now, pendingMixId]
    );

    let djEmail = '';
    try {
      const ur = await pool.query('SELECT email FROM users WHERE id::text = $1', [djId]);
      djEmail = ur.rows[0]?.email || '';
    } catch {}

    if (djEmail) {
      const rejectSubject = `Результат модерации — ${mix.title}`;
      const bodyText = rejection_type === 'profanity'
        ? 'Микс отклонён в связи с ненормативной лексикой / контентом, не соответствующим редакционной политике платформы. Будем рады принять clean version.'
        : 'На данный момент мы не готовы включить микс в публикацию. Это связано с внутренними критериями отбора и редакционной концепцией платформы. Будем рады следующим работам.';

      const rejectHtml =
        '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a14;color:#e5e5e5;border-radius:12px;overflow:hidden;">'
        + '<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:24px 32px;text-align:center;border-bottom:1px solid #2a2a4a;">'
        + '<img src="https://promo-music.ru/logo.png" alt="Промо.Музыка" style="height:36px;" />'
        + '<p style="margin:8px 0 0;color:#888;font-size:13px;">DJ-кабинет</p>'
        + '</div>'
        + '<div style="padding:32px;">'
        + '<p>Добрый день!</p>'
        + `<p>Благодарим за отправку микса <strong>«${mix.title}»</strong> на платформу.</p>`
        + `<p>${bodyText}</p>`
        + (moderator_notes ? `<p style="padding:12px;background:#1a1a2e;border-left:3px solid #3B82F6;border-radius:4px;">Комментарий: ${moderator_notes}</p>` : '')
        + '<p style="color:#888;">С уважением,<br/>Команда Промо.Музыка</p>'
        + '</div>'
        + '</div>';

      sendEmail({ to: djEmail, subject: rejectSubject, html: rejectHtml })
        .catch((err: any) => console.error('[dj-mix-moderation] Reject email failed:', err.message));
    }

    const rejectTitle = `Микс «${mix.title}» отклонён`;
    const rejectMsg = rejection_type === 'profanity'
      ? `Микс «${mix.title}» отклонён: ненормативная лексика. Примем clean version.`
      : `Микс «${mix.title}» отклонён. ${reason !== 'Не указана' ? reason : 'Не соответствует формату платформы.'}`;

    notifyCrossCabinet({
      targetUserId: djId,
      targetRole: 'dj',
      sourceRole: 'admin',
      type: 'mix_moderation',
      title: rejectTitle,
      message: rejectMsg,
      link: '/dj/mixes',
    }).catch(() => {});

    const notifId = `mn-${crypto.randomUUID()}`;
    upsertNotification(djId, notifId, {
      id: notifId,
      type: 'mix_moderation',
      title: rejectTitle,
      message: rejectMsg,
      mixId: pendingMixId,
      mixTitle: mix.title,
      newStatus: 'rejected',
      rejectionReason: reason || '',
      link: '/dj/mixes',
      read: false,
      createdAt: now,
    }).catch((err: any) => console.error('[dj-mix-moderation] inbox notif failed:', err?.message || err));

    return c.json({ success: true, message: 'Микс отклонён' });
  } catch (error: any) {
    console.error('Error in manage-dj-mix-moderation:', error);
    return c.json({ error: error?.message || 'Internal server error' }, 500);
  }
});

export default app;
