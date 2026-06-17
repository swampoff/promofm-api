/**
 * BANNER ROUTES v3 — Real money flow via ЮКасса (no coins).
 *
 * Pipeline:
 *   1. POST /          → создаёт banner со статусом pending, цену
 *                        пересчитывает на сервере через calculateBannerPrice()
 *   2. Админ approve   → moderation_status='approved', requires_payment=true,
 *                        notification юзеру «Оплатите чтобы запустить»
 *   3. POST /:id/checkout → создаёт ЮКасса checkout с metadata.type=
 *                        'banner_publish', amount = серверная цена
 *   4. webhook ЮКассы  → fulfillment в checkout-routes.tsx:
 *                        moderation_status='paid', status='active',
 *                        start/end_date выставлены
 *   5. Cron daily      → POST /banners/expire — переводит истекшие в 'expired'
 *
 * Все суммы в РУБЛЯХ. Никаких coin'ов.
 */

import { notifyBannerCreated } from './email-helper.tsx';
import { Hono } from 'hono';
import * as typed from './db-typed.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import { notifyCrossCabinet } from './cross-cabinet-notify.tsx';
import { upsertNotification } from './db.tsx';
import { createLogger } from './logger.tsx';
import {
  BANNER_PLACEMENTS,
  BANNER_DURATIONS,
  BANNER_SUBSCRIPTION_DISCOUNTS,
  calculateBannerPrice,
} from './banner-pricing.tsx';

const log = createLogger('banner');
import { pool } from './db-client.tsx';
import crypto from 'crypto';

const app = new Hono();

// ═══════════════════════════════════════
// PUBLIC endpoints (no auth required)
// ═══════════════════════════════════════

// GET /pricing — прайс-лист (placements + durations + discounts).
// Фронт может использовать как single source of truth, но локально
// держит зеркало в src/data/banner-pricing.ts чтобы рендерить превью
// без round-trip. Цены здесь — авторитативные.
app.get('/pricing', (c) => {
  return c.json({
    success: true,
    data: {
      placements: BANNER_PLACEMENTS,
      durations: BANNER_DURATIONS,
      subscriptionDiscounts: BANNER_SUBSCRIPTION_DISCOUNTS,
      currency: 'RUB',
    },
  });
});

// GET /active — Active banners for display on the site
app.get('/active', async (c) => {
  try {
    const placement = c.req.query('placement') || undefined;
    const banners = await typed.getActiveBanners(placement);

    // Record impressions atomically — race-free, single UPDATE WHERE id = ANY
    // вместо N×(get+1+set), которое теряло impressions под нагрузкой.
    typed.incrementBannerImpressions(banners.map((b: any) => b.id)).catch(() => {});

    return c.json({ success: true, data: banners });
  } catch (error) {
    console.error('Error in GET /banners/active:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /click/:id — Record banner click. Anonymous endpoint by design
// (publicly visible banners; click attribution не требует JWT).
// Atomic UPDATE counter — раньше get+(+1)+set терял конкурентные клики
// под нагрузкой, особенно на hot-баннерах (hero_main).
app.post('/click/:id', async (c) => {
  try {
    const bannerId = c.req.param('id');
    await typed.incrementBannerClicks(bannerId);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: true }); // Don't fail on click tracking
  }
});

// ═══════════════════════════════════════
// ARTIST endpoints (auth required)
// ═══════════════════════════════════════

// GET / — Get all banners for current user
app.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const banners = await typed.getBannersByUser(userId);
    return c.json({ success: true, data: banners });
  } catch (error) {
    console.error('Error in GET /banners:', error);
    return c.json({ success: true, data: [] });
  }
});

// GET /:id — Get single banner
app.get('/:id', requireAuth, async (c) => {
  try {
    const bannerId = c.req.param('id');
    if (['active', 'moderation'].includes(bannerId)) return c.notFound();
    const banner = await typed.getBannerById(bannerId);
    if (!banner) {
      return c.json({ success: false, error: 'Banner not found' }, 404);
    }
    return c.json({ success: true, data: banner });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST / — Create new banner campaign (submission for moderation).
//
// Принимает: placement (BannerPlacementId), duration_days (7/14/30/90),
// image_url, target_url, campaign_name (optional), title (optional).
// Цену считает на сервере через calculateBannerPrice — фронт-цене НЕ
// доверяем. Subscription discount применяется на основе текущего тарифа
// юзера.
app.post('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();

    const placement = String(body.placement || '');
    const durationDays = Number(body.duration_days || 7);
    const imageUrl = String(body.image_url || '');
    const targetUrl = String(body.target_url || body.link_url || '');
    const campaignName = String(body.campaign_name || body.title || '').slice(0, 200);

    if (!placement || !imageUrl || !targetUrl) {
      return c.json({
        success: false,
        error: 'placement, image_url и target_url обязательны',
        code: 'MISSING_FIELDS',
      }, 400);
    }

    // Резолвим тариф юзера для подписочной скидки. Если что-то падает —
    // считаем что spark (без скидки), а не блокируем создание баннера.
    let userTier = 'spark';
    try {
      const sub = await pool.query(
        `SELECT data FROM subscriptions WHERE user_id = $1 LIMIT 1`,
        [String(userId)],
      );
      const subData = sub.rows[0]?.data;
      if (subData?.tier) userTier = String(subData.tier).toLowerCase();
    } catch {}

    const pricing = calculateBannerPrice(placement, durationDays, userTier);
    if (!pricing.ok) {
      return c.json({
        success: false,
        error: pricing.error,
        code: 'PRICING_ERROR',
      }, 400);
    }

    const banner = await typed.insertBanner({
      title: campaignName || `Кампания ${pricing.placementName}`,
      campaign_name: campaignName,
      image_url: imageUrl,
      target_url: targetUrl,
      link_url: targetUrl,
      placement,
      banner_type: placement,
      duration_days: durationDays,
      price: pricing.finalPrice,
      user_id: userId,
      status: 'draft',                  // не активен до оплаты
      moderation_status: 'pending',
      data: {
        placement_name: pricing.placementName,
        base_price: pricing.basePrice,
        volume_discount: pricing.volumeDiscount,
        subscription_tier: pricing.subscriptionTier,
        subscription_discount: pricing.subscriptionDiscount,
        final_price: pricing.finalPrice,
        currency: 'RUB',
        requires_payment: true,
        submitted_at: new Date().toISOString(),
      },
    });

    if (!banner) {
      return c.json({ success: false, error: 'Failed to create banner' }, 500);
    }

    notifyBannerCreated({
      title: campaignName,
      userId,
      position: placement,
    }).catch(err => console.error('[banners] Email notify failed:', err.message));

    return c.json({
      success: true,
      data: banner,
      pricing,
      message: 'Кампания отправлена на модерацию. После одобрения вам придёт уведомление об оплате.',
    }, 201);
  } catch (error) {
    console.error('Error in POST /banners:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// PUT /:id — Update banner
app.put('/:id', requireAuth, async (c) => {
  try {
    const bannerId = c.req.param('id');
    const body = await c.req.json();

    const banner = await typed.updateBanner(bannerId, body);
    if (!banner) {
      return c.json({ success: false, error: 'Banner not found' }, 404);
    }

    return c.json({ success: true, data: banner });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// DELETE /:id — Delete banner
app.delete('/:id', requireAuth, async (c) => {
  try {
    const bannerId = c.req.param('id');
    await typed.deleteBanner(bannerId);
    return c.json({ success: true, message: 'Banner deleted' });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// GET /:id/checkout-amount — отдаёт точную сумму для оплаты.
// Фронт дёргает перед открытием ЮКасса-формы, чтобы показать юзеру
// «вы платите X ₽» и сравнить с тем что хранится в banner (защита от
// случая когда админ изменил duration после approve).
app.get('/:id/checkout-amount', requireAuth, async (c) => {
  try {
    const bannerId = c.req.param('id');
    const banner = await typed.getBannerById(bannerId);
    if (!banner) return c.json({ success: false, error: 'Banner not found' }, 404);
    if (String(banner.user_id) !== String(c.get('userId'))) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    if (banner.moderation_status !== 'approved') {
      return c.json({
        success: false,
        error: 'Кампания ещё не одобрена администратором',
        currentStatus: banner.moderation_status,
      }, 409);
    }
    return c.json({
      success: true,
      data: {
        bannerId: banner.id,
        amount: Number(banner.price || banner.data?.final_price || 0),
        currency: 'RUB',
        title: banner.title,
        placement: banner.placement,
        durationDays: banner.duration_days,
      },
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /:id/manual-activate — admin-only fallback (если ЮКасса недоступна
// или юзер платит вне платформы и админ хочет вручную запустить кампанию).
// Не списывает деньги — просто переводит approved → active.
app.post('/:id/manual-activate', requireAuth, requireAdmin, async (c) => {
  try {
    const bannerId = c.req.param('id');
    const banner = await typed.getBannerById(bannerId);
    if (!banner) return c.json({ success: false, error: 'Banner not found' }, 404);
    if (banner.moderation_status !== 'approved' && banner.moderation_status !== 'paid') {
      return c.json({
        success: false,
        error: 'Banner must be approved or paid first',
        currentStatus: banner.moderation_status,
      }, 409);
    }

    const days = banner.duration_days || 7;
    const now = new Date();
    const endDate = new Date(now.getTime() + days * 86400000);
    await typed.updateBanner(bannerId, {
      status: 'active',
      moderation_status: 'paid',
      start_date: now.toISOString(),
      end_date: endDate.toISOString(),
      data: {
        ...(banner.data || {}),
        manually_activated: true,
        manually_activated_at: now.toISOString(),
        manually_activated_by: c.get('userId'),
      },
    });

    return c.json({
      success: true,
      message: `Баннер активирован вручную на ${days} дней`,
      start_date: now.toISOString(),
      end_date: endDate.toISOString(),
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// =====================================================================
// POST /:id/admin/refund — admin-инициированный возврат за оплаченный баннер
// =====================================================================
// Зеркало engineer-routes.tsx /admin/orders/:id/refund (тот же money-handler
// шаблон): YooKassa refund по сохранённому gatewayPaymentId, UPDATE
// banner_ads.moderation_status='refunded' + status='cancelled', снятие из
// platform_revenue_log, SSE юзеру.
//
// До 2026-06-17 banner-refund'а не было — фронт analytics-banners.tsx
// тостил «X ₽ будут возвращены», но никакого API-вызова не делал.
// Теперь endpoint реальный.
//
// Pre-conditions:
//   * banner.moderation_status === 'paid' (баннер был оплачен).
//   * banner.payment_order_id NOT NULL (migration 107 даёт колонку).
//   * payment_sessions row найден и gateway === 'yookassa' (Stripe/T-Bank
//     auto-refund — отдельная фича).
//
// Idempotency: idempotenceKey=`refund-banner-${id}` на стороне YooKassa
// + WHERE moderation_status='paid' на UPDATE banner_ads — повторный вызов
// после успеха вернёт «уже возвращён» (409) без дублирующего refund'а.
app.post('/:id/admin/refund', requireAuth, requireAdmin, async (c) => {
  const adminId = c.get('userId' as never) as string;
  const bannerId = c.req.param('id');
  try {
    const body = await c.req.json().catch(() => ({}));
    const reason = String(body?.reason || '').slice(0, 250);

    const banner: any = await typed.getBannerById(bannerId);
    if (!banner) return c.json({ success: false, error: 'Баннер не найден' }, 404);

    if (banner.moderation_status === 'refunded') {
      return c.json({ success: false, error: 'Баннер уже возвращён' }, 409);
    }
    if (banner.moderation_status !== 'paid') {
      return c.json({
        success: false,
        error: `Refund возможен только для оплаченных баннеров (status=${banner.moderation_status})`,
      }, 409);
    }
    if (!banner.payment_order_id) {
      return c.json({
        success: false,
        error: 'payment_order_id NULL — refund через YooKassa-дашборд вручную',
      }, 422);
    }

    const { getPaymentSession } = await import('./db.tsx');
    const session: any = await getPaymentSession(banner.payment_order_id);
    if (!session?.gatewayPaymentId) {
      return c.json({ success: false, error: 'payment_session не найден' }, 404);
    }
    if (session.gateway !== 'yookassa') {
      return c.json({
        success: false,
        error: `Gateway ${session.gateway} не поддерживается auto-refund'ом`,
      }, 501);
    }

    const amount = Number(banner.price || banner.data?.final_price || 0);
    if (!amount || amount <= 0) {
      return c.json({ success: false, error: 'Сумма к возврату равна 0 — refund невозможен' }, 422);
    }

    const { YooKassaGateway } = await import('./gateway-yookassa.tsx');
    const yk = new YooKassaGateway();
    let refund: any;
    try {
      refund = await yk.refund(session.gatewayPaymentId, amount, {
        description: `Возврат banner #${bannerId}${reason ? ': ' + reason : ''}`.slice(0, 250),
        idempotenceKey: `refund-banner-${bannerId}`,
        metadata: { bannerId, reason, refundedBy: adminId },
        shopId: session.shopId,
      });
    } catch (refundErr: any) {
      log.error({ err: refundErr, bannerId }, 'banner_admin_refund_yk_fail');
      return c.json({
        success: false,
        error: 'YooKassa отклонила refund: ' + (refundErr?.message || 'unknown'),
      }, 502);
    }

    const refundedAt = new Date().toISOString();
    await typed.updateBanner(bannerId, {
      status: 'cancelled',
      moderation_status: 'refunded',
      data: {
        ...(banner.data || {}),
        refunded_at: refundedAt,
        refunded_by: adminId,
        refund_reason: reason,
        yk_refund_id: refund?.id,
      },
    });

    // Снимаем сумму из платформенного отчёта (banner_publish channel
    // фигурирует в platform_revenue_log с metadata.orderId).
    try {
      const { pool } = await import('./db-client.tsx');
      await pool.query(
        `UPDATE platform_revenue_log SET status='refunded', updated_at=NOW()
          WHERE channel='banner_publish' AND metadata->>'orderId' = $1`,
        [banner.payment_order_id],
      );
    } catch (revLogErr: any) {
      log.warn({ err: revLogErr, bannerId }, 'banner_refund_revenue_log_update_failed');
    }

    // SSE юзеру: его кабинет «Реклама» подтянет refunded-state.
    try {
      const { emitSSE } = await import('./sse-routes.tsx');
      emitSSE(banner.user_id, {
        type: 'banner_refunded',
        data: { bannerId, title: banner.title, amount, reason },
      });
    } catch {}

    // Persistent inbox notification.
    try {
      await notifyCrossCabinet({
        targetUserId: banner.user_id,
        targetRole: 'artist',
        sourceRole: 'admin',
        type: 'banner_refunded',
        title: 'Возврат за баннер',
        message: `Кампания «${banner.title}» отменена администратором. На ваш счёт возвращено ${amount.toLocaleString('ru-RU')} ₽${reason ? ` (причина: ${reason})` : ''}.`,
        metadata: { bannerId, amount, refundId: refund?.id },
      });
    } catch (notifyErr: any) {
      log.warn({ err: notifyErr, bannerId }, 'banner_refund_notify_failed');
    }

    log.info({ bannerId, amount, adminId, refundId: refund?.id }, 'banner_admin_refunded');
    return c.json({
      success: true,
      bannerId,
      amount,
      refundId: refund?.id,
      refundedAt,
    });
  } catch (error: any) {
    log.error({ err: error, bannerId }, 'banner_admin_refund_error');
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// POST /expire — admin/cron endpoint. Переводит истекшие активные баннеры
// в status='expired'. Два режима auth:
//   1. X-Internal-Key (для VPS cron — без JWT) — приоритет, как у /promote-upcoming.
//   2. JWT admin (для админ-панели UI) — fallback.
// Cron в crontab: 0 * * * * curl -X POST -H "X-Internal-Key: $VPS_INTERNAL_KEY"
//   http://127.0.0.1:3000/server/api/banners/expire >> /var/log/promofm-banner-expire.log
app.post('/expire', async (c, next) => {
  // X-Internal-Key auth bypass для VPS-cron (по аналогии с
  // /track-moderation/promote-upcoming). Если key валидный — пропускаем
  // requireAuth + requireAdmin, иначе — стандартная JWT-проверка.
  const internalKey = c.req.header('X-Internal-Key') || '';
  const expectedKey = process.env.VPS_INTERNAL_KEY || '';
  if (expectedKey && internalKey === expectedKey) {
    return next();
  }
  // Иначе — admin JWT через middleware.
  return requireAuth(c, async () => { await requireAdmin(c, next); });
}, async (c) => {
  try {
    const r = await pool.query(
      `UPDATE banner_ads
          SET status = 'expired',
              updated_at = NOW()
        WHERE status = 'active'
          AND end_date IS NOT NULL
          AND end_date < NOW()
        RETURNING id, title, end_date`,
    );
    return c.json({
      success: true,
      expired: r.rowCount || 0,
      ids: (r.rows || []).map(x => x.id),
    });
  } catch (error) {
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

// ═══════════════════════════════════════
// MODERATION endpoints
// ═══════════════════════════════════════

// GET /moderation/pending — Get banners for moderation
app.get('/moderation/pending', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status') || 'pending';
    const banners = await typed.getAllBannersForModeration(status === 'all' ? undefined : status);
    return c.json({ success: true, data: banners });
  } catch (error) {
    console.error('Error in GET /banners/moderation/pending:', error);
    return c.json({ success: true, data: [] });
  }
});

// POST /moderation/manage — Approve or reject banner
app.post('/moderation/manage', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { bannerId, action, moderator_notes, rejection_reason } = body;

    const banner = await typed.getBannerById(bannerId);
    if (!banner) {
      return c.json({ success: false, error: 'Banner not found' }, 404);
    }

    const now = new Date().toISOString();

    if (action === 'approve') {
      await typed.updateBanner(bannerId, {
        moderation_status: 'approved',
        moderation_comment: moderator_notes || 'Баннер одобрен',
        data: {
          ...(banner.data || {}),
          approved_at: now,
          requires_payment: true,
        },
      });

      // Уведомление юзеру: «Оплатите чтобы запустить». SSE баннер +
      // bell-inbox, чтобы из любого кабинета он попал в /banners.
      const amount = Number(banner.price || banner.data?.final_price || 0);
      if (banner.user_id) {
        notifyCrossCabinet({
          targetUserId: String(banner.user_id),
          targetRole: 'artist', // не критично — кабинет тот в котором юзер сидит
          sourceRole: 'admin',
          type: 'admin_action',
          title: 'Баннер одобрен — оплатите для запуска',
          message: `Кампания «${banner.title}» одобрена. К оплате ${amount.toLocaleString('ru-RU')} ₽.`,
          link: '/banners',
        }).catch(() => {});

        const notifId = `bnotif-${crypto.randomUUID()}`;
        upsertNotification(String(banner.user_id), notifId, {
          id: notifId,
          type: 'banner_approved',
          title: 'Баннер одобрен — оплатите для запуска',
          message: `Кампания «${banner.title}» одобрена администратором. К оплате ${amount.toLocaleString('ru-RU')} ₽ за ${banner.duration_days} дн.`,
          bannerId,
          amount,
          link: '/banners',
          read: false,
          createdAt: now,
        }).catch(() => {});
      }

      return c.json({
        success: true,
        message: `Баннер одобрен. Юзер увидит «Оплатить ${amount.toLocaleString('ru-RU')} ₽» в кабинете.`,
        requiresPayment: true,
        amount,
      });

    } else if (action === 'reject') {
      await typed.updateBanner(bannerId, {
        moderation_status: 'rejected',
        rejection_reason: rejection_reason || '',
        moderation_comment: moderator_notes || null,
        status: 'rejected',
        data: {
          ...(banner.data || {}),
          rejected_at: now,
          rejection_reason: rejection_reason || '',
        },
      });

      if (banner.user_id) {
        notifyCrossCabinet({
          targetUserId: String(banner.user_id),
          targetRole: 'artist',
          sourceRole: 'admin',
          type: 'admin_action',
          title: 'Баннер отклонён',
          message: `Кампания «${banner.title}» отклонена. ${rejection_reason || moderator_notes || 'Свяжитесь с поддержкой за деталями.'}`,
          link: '/banners',
        }).catch(() => {});

        const notifId = `bnotif-${crypto.randomUUID()}`;
        upsertNotification(String(banner.user_id), notifId, {
          id: notifId,
          type: 'banner_rejected',
          title: 'Баннер отклонён',
          message: `Кампания «${banner.title}» отклонена. ${rejection_reason || 'См. подробности в кабинете'}`,
          bannerId,
          rejectionReason: rejection_reason || '',
          link: '/banners',
          read: false,
          createdAt: now,
        }).catch(() => {});
      }

      return c.json({ success: true, message: 'Баннер отклонён' });

    } else {
      return c.json({ success: false, error: 'Invalid action' }, 400);
    }
  } catch (error) {
    console.error('Error in banner moderation:', error);
    return c.json({ success: false, error: safeErrorMessage(error) }, 500);
  }
});

export default app;
