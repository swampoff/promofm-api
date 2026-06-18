import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
import {
  trackTestAllRequestsStore, trackTestRequestsStore, trackTestUserRequestsStore,
  getExpertStats, incrementExpertAssigned, completeExpertReviewAndReward,
  listRegisteredTrackTestExperts,
  getTrackTestReview, listTrackTestReviewsByRequest,
  upsertTrackTestReview, markTrackTestReviewRewardPaid,
  type TrackTestReviewRow,
} from './db.tsx';
import { emitSSE } from './sse-routes.tsx';
import { recordRevenue } from './platform-revenue.tsx';
import { quickLLM, getLLMStatus } from './llm-router.tsx';
import { pool } from './db-client.tsx';

const TRACK_TEST_BASE_PRICE = 3000;

/**
 * Resolve the artist's PromoLab test quota for the current calendar
 * month: how many tests are INCLUDED in their subscription, and how
 * many they've already used since the 1st of this month.
 *
 * Quota schedule (SUBSCRIPTION_PLANS.tests_per_month — see
 * subscriptions-routes.tsx):
 *     spark = 0    start = 1    pro = 3    elite = 10
 *
 * Over-quota submissions pay the flat TRACK_TEST_BASE_PRICE (3000 ₽).
 *
 * Returns { quota, used, available } where available = max(quota - used, 0).
 * On any failure (missing user, DB error, unknown tier) → quota=0,
 * available=0 so the artist falls through to the paid flow.
 */
async function getMonthlyTestQuotaState(userId: string | null | undefined): Promise<{ quota: number; used: number; available: number; tier: string | null }> {
  const fallback = { quota: 0, used: 0, available: 0, tier: null as string | null };
  if (!userId) return fallback;

  let quota = 0;
  let tier: string | null = null;
  try {
    const sr = await pool.query(
      `SELECT data FROM subscriptions WHERE user_id = $1
       ORDER BY (data->>'updated_at') DESC NULLS LAST, (data->>'created_at') DESC NULLS LAST
       LIMIT 1`,
      [userId],
    );
    if (sr.rows.length > 0) {
      const raw = sr.rows[0].data;
      const sub: any = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (sub) {
        // Active = ('active' or 'trial') AND (no expires_at OR not expired)
        const statusOk = sub.status === 'active' || sub.status === 'trial';
        const expiresOk = !sub.expires_at || new Date(sub.expires_at).getTime() > Date.now();
        if (statusOk && expiresOk) {
          tier = String(sub.tier || sub.planId || '').toLowerCase();
          quota = Number(sub.tests_per_month) || 0;
        }
      }
    }
  } catch (e: any) {
    console.warn('[track-test] quota lookup failed:', e?.message);
  }

  if (quota <= 0) return { ...fallback, tier };

  // Count usage this calendar month — iterate the user's request IDs
  // and check each one's `created_at` against month-start. Spark has 0
  // quota and short-circuits above, so this only runs for paid tiers
  // which typically have a handful of tests; OK to do in JS.
  let used = 0;
  try {
    const userRequests = await trackTestUserRequestsStore.get(userId) || [];
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (const reqId of userRequests as string[]) {
      const req = await trackTestRequestsStore.get(reqId);
      if (!req) continue;
      const created = req.created_at ? new Date(req.created_at) : null;
      if (!created || Number.isNaN(created.getTime())) continue;
      if (created < monthStart) continue;
      // Cancelled / refunded requests don't count.
      if (req.payment_status === 'refunded') continue;
      // Subscription-quota grants (payment_amount=0 from this code path)
      // count toward quota — that's the whole point.
      used++;
    }
  } catch (e: any) {
    console.warn('[track-test] usage count failed:', e?.message);
  }

  const available = Math.max(quota - used, 0);
  return { quota, used, available, tier };
}

const app = new Hono();

// =====================================================
// TRACK TEST SYSTEM - PROFESSIONAL EXPERT REVIEWS
// =====================================================

// Типы данных
interface TrackTestRequest {
  id: string;
  user_id: string | null; // null для гостей
  track_id: string | null; // null для гостей
  guest_email?: string;
  guest_name?: string;
  guest_track_url?: string;
  guest_cover_url?: string;
  track_title: string;
  artist_name: string;
  genre?: string;
  status: 'pending_payment' | 'payment_succeeded' | 'pending_moderation' | 'moderation_rejected' | 
          'pending_expert_assignment' | 'experts_assigned' | 'in_review' | 'review_in_progress' |
          'analysis_generated' | 'pending_admin_approval' | 'pending_admin_review' |
          'completed' | 'rejected';
  payment_status: 'pending' | 'completed' | 'refunded';
  payment_amount: number; // 3000 RUB
  payment_transaction_id?: string;
  required_expert_count: number; // до 10
  completed_reviews_count: number;
  assigned_experts: string[]; // email эксперта
  average_rating?: number; // средняя оценка (1-10)
  category_averages?: {
    mixing_mastering: number;
    arrangement: number;
    originality: number;
    commercial_potential: number;
  };
  final_analysis?: string; // сгенерированный общий анализ
  consolidated_feedback?: string;
  consolidated_recommendations?: string;
  admin_approval_status?: 'pending' | 'approved' | 'rejected';
  moderation_notes?: string;
  rejection_reason?: string;
  feedback_sent_date?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface ExpertReview {
  id: string;
  request_id: string;
  expert_email: string;
  expert_name: string;
  expert_role?: string;
  status: 'assigned' | 'in_progress' | 'completed';
  
  // Оценки (1-10)
  mixing_mastering_score: number;
  arrangement_score: number;
  originality_score: number;
  commercial_potential_score: number;
  overall_score: number;
  
  // Фидбек
  mixing_mastering_feedback: string;
  arrangement_feedback: string;
  originality_feedback: string;
  commercial_potential_feedback: string;
  general_feedback: string;
  recommendations: string;
  
  // Замечания по таймкодам
  audio_notes?: { id: string; timestamp: string; comment: string; category: string }[];
  
  reward_points: number; // 50 коинов
  reward_paid: boolean;
  
  created_at: string;
  completed_at?: string;
}

// =====================================================
// 1. СОЗДАНИЕ ЗАЯВКИ (для артистов и гостей)
// =====================================================

app.post('/submit', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { 
      user_id, 
      track_id,
      guest_email,
      guest_name,
      guest_track_url,
      guest_cover_url,
      track_title,
      artist_name,
      genre 
    } = body;

    // Валидация
    if (!track_title || !artist_name) {
      return c.json({ error: 'Track title and artist name are required' }, 400);
    }

    if (!user_id && !guest_email) {
      return c.json({ error: 'User ID or guest email required' }, 400);
    }

    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Tests are now part of the subscription quota (2026-05-25 product
    // decision). Each subscription tier includes N tests per calendar
    // month — see SUBSCRIPTION_PLANS.tests_per_month. Over-quota
    // submissions fall back to flat TRACK_TEST_BASE_PRICE (₽3000),
    // same for guests (no user_id → can't draw from a subscription).
    const quotaState = await getMonthlyTestQuotaState(user_id || null);
    const withinQuota = quotaState.available > 0;

    const paymentAmount = withinQuota ? 0 : TRACK_TEST_BASE_PRICE;
    // When inside subscription quota: skip the payment gate entirely —
    // the test is "paid" by the active subscription. Otherwise route
    // through pending_payment → YooKassa as before.
    const initialStatus = withinQuota ? 'payment_succeeded' : 'pending_payment';
    const initialPaymentStatus = withinQuota ? 'completed' : 'pending';

    const trackTestRequest: TrackTestRequest = {
      id: requestId,
      user_id: user_id || null,
      track_id: track_id || null,
      guest_email,
      guest_name,
      guest_track_url,
      guest_cover_url,
      track_title,
      artist_name,
      genre,
      status: initialStatus,
      payment_status: initialPaymentStatus,
      payment_amount: paymentAmount,
      required_expert_count: 5, // по умолчанию 5 экспертов
      completed_reviews_count: 0,
      assigned_experts: [],
      created_at: now,
      updated_at: now
    };

    // Сохранить заявку
    await trackTestRequestsStore.set(requestId, trackTestRequest);

    // Добавить в список заявок пользователя
    if (user_id) {
      const userRequests = await trackTestUserRequestsStore.get(user_id) || [];
      userRequests.unshift(requestId);
      await trackTestUserRequestsStore.set(user_id, userRequests);
    }

    // Добавить в общий список (для администратора)
    const allRequests = await trackTestAllRequestsStore.get('singleton') || [];
    allRequests.unshift(requestId);
    await trackTestAllRequestsStore.set('singleton', allRequests);

    console.log(
      withinQuota
        ? `Track test request created: ${requestId} (subscription-quota, tier=${quotaState.tier}, used ${quotaState.used + 1}/${quotaState.quota})`
        : `Track test request created: ${requestId} (over-quota or guest, paying ${paymentAmount} RUB)`
    );

    return c.json({
      success: true,
      request_id: requestId,
      status: initialStatus,
      withinQuota,
      quota: {
        included_per_month: quotaState.quota,
        used_this_month: quotaState.used + (withinQuota ? 1 : 0),
        tier: quotaState.tier,
      },
      payment_amount: paymentAmount,
      base_price: TRACK_TEST_BASE_PRICE,
      message: withinQuota
        ? 'Тест трека создан в рамках вашей подписки. Оплата не требуется.'
        : 'Тест трека создан. Перейдите к оплате.',
    });

  } catch (error) {
    console.error('Error creating track test request:', error);
    return c.json({ error: 'Failed to create track test request' }, 500);
  }
});

// =====================================================
// 2. ОБРАБОТКА ОПЛАТЫ
// =====================================================

app.post('/payment', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { request_id, payment_method } = body;

    const request = await trackTestRequestsStore.get(request_id);
    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }

    if (request.payment_status === 'completed') {
      return c.json({ error: 'Payment already completed' }, 400);
    }

    // Create real checkout session via YooKassa
    const { getGateway } = await import('./payment-gateway.tsx');
    const { upsertPaymentSession } = await import('./db.tsx');

    const gateway = getGateway('yookassa');
    const orderId = crypto.randomUUID();
    const returnUrl = `https://promo-music.ru/cabinet/tracks?payment=success&request_id=${request_id}`;

    const result = await gateway.createPayment({
      orderId,
      amount: request.payment_amount,
      currency: 'RUB',
      description: `Тест трека: ${request.track_title} — ${request.artist_name}`,
      returnUrl,
      gateway: 'yookassa',
      userId: request.user_id || 'guest',
      type: 'purchase',
      metadata: {
        type: 'track_test',
        requestId: request_id,
        trackTitle: request.track_title,
        artistName: request.artist_name,
      },
    });

    // Save payment session for webhook processing
    const session: any = {
      orderId,
      userId: request.user_id || 'guest',
      amount: request.payment_amount,
      currency: 'RUB',
      type: 'purchase',
      description: `Тест трека: ${request.track_title}`,
      status: 'pending',
      gateway: 'yookassa',
      gatewayPaymentId: result.sessionId,
      metadata: {
        type: 'track_test',
        requestId: request_id,
        trackTitle: request.track_title,
      },
      createdAt: new Date().toISOString(),
    };
    await upsertPaymentSession(orderId, session);

    // Link payment session to track test request
    request.payment_transaction_id = orderId;
    request.updated_at = new Date().toISOString();
    await trackTestRequestsStore.set(request_id, request);

    return c.json({
      success: true,
      orderId,
      confirmationUrl: result.confirmationUrl,
      status: 'pending',
      message: 'Перенаправление на оплату...'
    });

  } catch (error) {
    console.error('Error creating track test payment:', error);
    return c.json({ error: 'Failed to create payment session' }, 500);
  }
});

// POST /payment/confirm — Called by webhook or frontend after payment success
app.post('/payment/confirm', requireAuth, async (c) => {
  // SECURITY: Payment confirmation is handled exclusively by the YooKassa webhook.
  // Manual confirmation disabled to prevent payment bypass.
  return c.json({ success: false, error: 'Payment confirmed via gateway webhook only' }, 403);
  try {
    const body = await c.req.json();
    const { request_id } = body;

    const request = await trackTestRequestsStore.get(request_id);
    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }

    if (request.payment_status === 'completed') {
      return c.json({ success: true, status: 'already_completed' });
    }

    // Mark as paid
    request.payment_status = 'completed';
    request.status = 'payment_succeeded';
    request.updated_at = new Date().toISOString();

    await trackTestRequestsStore.set(request_id, request);

    // Record transaction (migration 037: row-per-tx, не overwrite массива).
    await pool.query(
      `INSERT INTO payment_transactions
         (app_id, user_id, amount, currency, tx_type, status,
          payment_method, description, related_entity_type,
          related_entity_id, created_at)
       VALUES ($1, $2, $3, 'RUB', 'track_test', 'completed',
               $4, $5, 'track_test_request', $6, NOW())
       ON CONFLICT (user_id, app_id) DO NOTHING`,
      [
        crypto.randomUUID(),
        request.user_id,
        request.payment_amount,
        'yookassa', // payment_method — раньше использовалась переменная payment_method которой нет в scope; hardcode'или yookassa (всё равно через него идёт оплата)
        `Track test: ${request.track_title}`,
        request_id,
      ]
    );

    // Запись дохода платформы (тест трека - 100% дохода)
    await recordRevenue({
      channel: 'track_test',
      description: `Тест трека: ${request.track_title} - ${request.artist_name}`,
      grossAmount: request.payment_amount,
      platformRevenue: request.payment_amount,
      payoutAmount: 0,
      commissionRate: 1.0,
      payerId: request.user_id || request.guest_email || 'guest',
      payerName: request.artist_name || request.guest_name || 'Артист',
      metadata: { requestId: request_id, genre: request.genre },
    });

    // SSE: уведомить администраторов о новой оплаченной заявке
    emitSSE('admin', {
      type: 'notification',
      data: {
        newStatus: 'in_review',
        orderTitle: request.track_title,
        comment: `Оплачен тест трека: ${request.track_title} - ${request.artist_name} (1000 ₽)`,
      },
    });

    console.log(`Payment completed for request: ${request_id}`);

    return c.json({
      success: true,
      status: 'payment_succeeded',
      message: 'Payment completed. Your request is now under moderation.'
    });

  } catch (error) {
    console.error('Error processing payment:', error);
    return c.json({ error: 'Failed to process payment' }, 500);
  }
});

// =====================================================
// 3. МОДЕРАЦИЯ (администратор)
// =====================================================

app.post('/moderate', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { request_id, action, notes } = body;
    // action: 'approve' | 'reject'

    const request = await trackTestRequestsStore.get(request_id);
    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }

    if (request.status !== 'payment_succeeded' && request.status !== 'pending_moderation') {
      return c.json({ error: 'Request is not pending moderation' }, 400);
    }

    if (action === 'approve') {
      request.status = 'pending_expert_assignment';
      request.moderation_notes = notes;
      console.log(`Request approved: ${request_id}`);

      // SSE: уведомить всех онлайн-экспертов о новом доступном тесте.
      // Native source — DISTINCT expert_id из track_test_expert_stats.
      const expertIds = await listRegisteredTrackTestExperts();
      for (const eid of expertIds) {
        emitSSE(eid, {
          type: 'track_test_available',
          data: {
            requestId: request_id,
            trackTitle: request.track_title,
            artistName: request.artist_name,
            genre: request.genre,
            message: `Новый трек для тестирования: ${request.track_title} - ${request.artist_name}`,
          },
        });
      }
    } else if (action === 'reject') {
      request.status = 'moderation_rejected';
      request.rejection_reason = notes;
      
      // Возврат средств
      request.payment_status = 'refunded';

      // SSE: уведомить артиста об отклонении + возврате
      if (request.user_id) {
        emitSSE(request.user_id, {
          type: 'notification',
          data: {
            newStatus: 'rejected',
            orderTitle: request.track_title,
            comment: `Заявка на тест трека "${request.track_title}" отклонена. Средства возвращены на баланс.`,
          },
        });
      }

      console.log(`Request rejected: ${request_id}`);
    }

    request.updated_at = new Date().toISOString();
    await trackTestRequestsStore.set(request_id, request);

    return c.json({
      success: true,
      status: request.status,
      message: action === 'approve' ? 'Request approved' : 'Request rejected and refunded'
    });

  } catch (error) {
    console.error('Error moderating request:', error);
    return c.json({ error: 'Failed to moderate request' }, 500);
  }
});

// =====================================================
// 4. НАЗНАЧЕНИЕ ЭКСПЕРТОВ (администратор)
// =====================================================

app.post('/assign-experts', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { request_id, expert_emails, required_count } = body;

    if (!expert_emails || expert_emails.length === 0) {
      return c.json({ error: 'At least one expert required' }, 400);
    }

    if (expert_emails.length > 10) {
      return c.json({ error: 'Maximum 10 experts allowed' }, 400);
    }

    const request = await trackTestRequestsStore.get(request_id);
    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }

    if (request.status !== 'pending_expert_assignment') {
      return c.json({ error: 'Request is not ready for expert assignment' }, 400);
    }

    // Создать ExpertReview для каждого эксперта
    const expertReviews: string[] = [];
    const now = new Date().toISOString();

    for (const expertEmail of expert_emails) {
      const reviewId = crypto.randomUUID();
      
      const expertReview: ExpertReview = {
        id: reviewId,
        request_id,
        expert_email: expertEmail,
        expert_name: expertEmail.split('@')[0], // temporary
        status: 'assigned',
        mixing_mastering_score: 0,
        arrangement_score: 0,
        originality_score: 0,
        commercial_potential_score: 0,
        overall_score: 0,
        mixing_mastering_feedback: '',
        arrangement_feedback: '',
        originality_feedback: '',
        commercial_potential_feedback: '',
        general_feedback: '',
        recommendations: '',
        reward_points: 50,
        reward_paid: false,
        created_at: now
      };

      await upsertTrackTestReview({
        ...(expertReview as unknown as TrackTestReviewRow),
        created_at: now,
        completed_at: null,
        expert_role: null,
        audio_notes: [],
        reward_points: 50,
        reward_paid: false,
      });
      expertReviews.push(reviewId);

      // Отправить уведомление эксперту
      console.log(`Notification sent to expert: ${expertEmail}`);
    }

    // Обновить заявку. track_test_request_reviews DROPPED migration 053 —
    // derived через listTrackTestReviewsByRequest, no separate index write.
    request.assigned_experts = expert_emails;
    request.required_expert_count = required_count || expert_emails.length;
    request.status = 'experts_assigned';
    request.updated_at = now;

    await trackTestRequestsStore.set(request_id, request);

    console.log(`Assigned ${expert_emails.length} experts to request: ${request_id}`);

    return c.json({
      success: true,
      assigned_experts: expert_emails.length,
      status: 'experts_assigned',
      message: `Successfully assigned ${expert_emails.length} experts`
    });

  } catch (error) {
    console.error('Error assigning experts:', error);
    return c.json({ error: 'Failed to assign experts' }, 500);
  }
});

// =====================================================
// 5. ОТПРАВКА ОЦЕНКИ ЭКСПЕРТОМ
// =====================================================

app.post('/submit-review', requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { 
      review_id,
      mixing_mastering_score,
      arrangement_score,
      originality_score,
      commercial_potential_score,
      overall_score,
      mixing_mastering_feedback,
      arrangement_feedback,
      originality_feedback,
      commercial_potential_feedback,
      general_feedback,
      recommendations,
      audio_notes
    } = body;

    // Валидация оценок
    const scores = [
      mixing_mastering_score,
      arrangement_score,
      originality_score,
      commercial_potential_score,
      overall_score
    ];

    for (const score of scores) {
      if (score < 1 || score > 10) {
        return c.json({ error: 'All scores must be between 1 and 10' }, 400);
      }
    }

    const review = await getTrackTestReview(review_id);
    if (!review) {
      return c.json({ error: 'Review not found' }, 404);
    }

    // Обновить оценку + reward в одном typed UPSERT.
    review.status = 'completed';
    review.mixing_mastering_score = mixing_mastering_score;
    review.arrangement_score = arrangement_score;
    review.originality_score = originality_score;
    review.commercial_potential_score = commercial_potential_score;
    review.overall_score = overall_score;
    review.mixing_mastering_feedback = mixing_mastering_feedback;
    review.arrangement_feedback = arrangement_feedback;
    review.originality_feedback = originality_feedback;
    review.commercial_potential_feedback = commercial_potential_feedback;
    review.general_feedback = general_feedback;
    review.recommendations = recommendations;
    review.audio_notes = audio_notes || [];
    review.completed_at = new Date().toISOString();
    review.reward_paid = true;
    await upsertTrackTestReview(review);

    // Atomic completion: +1 completed, +reward_points coins, recompute rating.
    // Race-free vs legacy get→mutate→set паттерн (concurrent review completions
    // могли терять updates).
    await completeExpertReviewAndReward(review.expert_email, review.reward_points || 50);

    console.log(`Reward (${review.reward_points} coins) paid to expert: ${review.expert_email}`);

    // Обновить статус заявки
    const request = await trackTestRequestsStore.get(review.request_id);
    if (request) {
      request.completed_reviews_count += 1;
      
      // Если это первая завершенная оценка — статус in_review
      if (request.completed_reviews_count === 1 && request.status === 'experts_assigned') {
        request.status = 'in_review';
      }

      // Если все оценки собраны — генерация анализа
      if (request.completed_reviews_count >= request.required_expert_count) {
        await consolidateReviews(request);
        // Формируем final_analysis
        request.final_analysis = `${request.consolidated_feedback}\n\n${request.consolidated_recommendations}`;
        request.status = 'analysis_generated';
        request.admin_approval_status = 'pending';

        // SSE: уведомить администратора, что анализ готов
        emitSSE('admin', {
          type: 'notification',
          data: {
            newStatus: 'approved',
            orderTitle: request.track_title,
            comment: `Анализ трека "${request.track_title}" готов. Все ${request.required_expert_count} экспертов завершили рецензирование.`,
          },
        });
      }

      request.updated_at = new Date().toISOString();
      await trackTestRequestsStore.set(review.request_id, request);
    }

    console.log(`Expert review submitted: ${review_id}`);

    return c.json({
      success: true,
      message: 'Review submitted successfully',
      reward: 50
    });

  } catch (error) {
    console.error('Error submitting review:', error);
    return c.json({ error: 'Failed to submit review' }, 500);
  }
});

// =====================================================
// 6. КОНСОЛИДАЦИЯ РЕЗУЛЬТАТОВ (автоматическая)
// =====================================================

async function consolidateReviews(request: TrackTestRequest) {
  try {
    // Single indexed SELECT (idx_track_test_reviews_request) — заменяет
    // dropped track_test_request_reviews + N+1 .get fetches.
    const allReviews = await listTrackTestReviewsByRequest(request.id);
    const reviews: ExpertReview[] = allReviews.filter(r => r.status === 'completed') as unknown as ExpertReview[];

    if (reviews.length === 0) return;

    // Рассчитать средние оценки
    const averages = {
      mixing_mastering: 0,
      arrangement: 0,
      originality: 0,
      commercial_potential: 0,
      overall: 0
    };

    for (const review of reviews) {
      averages.mixing_mastering += review.mixing_mastering_score;
      averages.arrangement += review.arrangement_score;
      averages.originality += review.originality_score;
      averages.commercial_potential += review.commercial_potential_score;
      averages.overall += review.overall_score;
    }

    const count = reviews.length;
    request.category_averages = {
      mixing_mastering: Number((averages.mixing_mastering / count).toFixed(1)),
      arrangement: Number((averages.arrangement / count).toFixed(1)),
      originality: Number((averages.originality / count).toFixed(1)),
      commercial_potential: Number((averages.commercial_potential / count).toFixed(1))
    };
    request.average_rating = Number((averages.overall / count).toFixed(1));

    // Генерация консолидированного фидбека через Anthropic Claude
    const aiResult = await generateConsolidatedAnalysis(request, reviews);
    request.consolidated_feedback = aiResult.feedback;
    request.consolidated_recommendations = aiResult.recommendations;

    console.log(`Reviews consolidated for request: ${request.id}`);

  } catch (error) {
    console.error('Error consolidating reviews:', error);
  }
}

// ── Anthropic Claude Integration ──

async function generateConsolidatedAnalysis(
  request: TrackTestRequest,
  reviews: ExpertReview[]
): Promise<{ feedback: string; recommendations: string }> {
  const llmStatus = getLLMStatus();

  if (!llmStatus.available) {
    console.log('LLM not configured, falling back to template consolidation');
    return {
      feedback: templateConsolidatedFeedback(reviews),
      recommendations: templateConsolidatedRecommendations(reviews),
    };
  }

  try {
    // Формируем контекст
    const reviewsSummary = reviews.map((r, i) => {
      let summary = `Эксперт ${i + 1} (${r.expert_name}, ${r.expert_role || 'эксперт'}):\n`;
      summary += `  Сведение/мастеринг: ${r.mixing_mastering_score}/10\n`;
      summary += `  Аранжировка: ${r.arrangement_score}/10\n`;
      summary += `  Оригинальность: ${r.originality_score}/10\n`;
      summary += `  Коммерческий потенциал: ${r.commercial_potential_score}/10\n`;
      summary += `  Общая оценка: ${r.overall_score}/10\n`;
      if (r.general_feedback) summary += `  Комментарий: ${r.general_feedback}\n`;
      if (r.recommendations) summary += `  Рекомендации: ${r.recommendations}\n`;
      if (r.audio_notes && r.audio_notes.length > 0) {
        summary += `  Замечания по таймкодам:\n`;
        r.audio_notes.forEach(n => {
          summary += `    [${n.timestamp}] (${n.category}) ${n.comment}\n`;
        });
      }
      return summary;
    }).join('\n');

    const prompt = `Ты - музыкальный аналитик платформы ПРОМО.МУЗЫКА. Проанализируй рецензии экспертов на трек и составь консолидированный отчёт.

Трек: "${request.track_title}" - ${request.artist_name}
Жанр: ${request.genre || 'не указан'}
Средняя оценка: ${request.average_rating}/10
Количество экспертов: ${reviews.length}

Средние оценки по критериям:
- Сведение и мастеринг: ${request.category_averages?.mixing_mastering}/10
- Аранжировка: ${request.category_averages?.arrangement}/10
- Оригинальность: ${request.category_averages?.originality}/10
- Коммерческий потенциал: ${request.category_averages?.commercial_potential}/10

Рецензии экспертов:
${reviewsSummary}

Составь два раздела в формате JSON:
1. "feedback" - развёрнутый анализ трека (3-5 абзацев). Пиши на русском языке, профессионально но доступно.
2. "recommendations" - конкретные рекомендации артисту (нум��рованный список из 3-7 пунктов).

ВАЖНО: Используй только короткие тире (-), длинные тире запрещены. Ответ строго в формате JSON: {"feedback": "...", "recommendations": "..."}`;

    const text = await quickLLM(
      'Ты - музыкальный аналитик. Возвращай ТОЛЬКО валидный JSON.',
      prompt,
      { maxTokens: 2000, tag: 'track-test-consolidation' }
    );

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('LLM consolidation successful');
      return {
        feedback: parsed.feedback || templateConsolidatedFeedback(reviews),
        recommendations: parsed.recommendations || templateConsolidatedRecommendations(reviews),
      };
    }

    throw new Error('Could not parse JSON from LLM response');
  } catch (error) {
    console.error('LLM consolidation failed, using template fallback:', error);
    return {
      feedback: templateConsolidatedFeedback(reviews),
      recommendations: templateConsolidatedRecommendations(reviews),
    };
  }
}

// ── Fallback template generators ──

function templateConsolidatedFeedback(reviews: ExpertReview[]): string {
  // Симуляция AI-генерации
  // В production зде��ь будет вызов OpenAI/Claude API
  
  let feedback = `На основе оценок ${reviews.length} экспертов:\n\n`;
  
  feedback += '🎵 **Сведение и мастеринг:** Эксперты отметили ';
  const mixingScores = reviews.map(r => r.mixing_mastering_score);
  const avgMixing = mixingScores.reduce((a, b) => a + b, 0) / mixingScores.length;
  
  if (avgMixing >= 8) {
    feedback += 'высокое качество звучания и профессиональный баланс частот.\n\n';
  } else if (avgMixing >= 6) {
    feedback += 'хорошее качество с некоторыми аспектами для улучшения.\n\n';
  } else {
    feedback += 'необходимость доработки сведения и мастеринга.\n\n';
  }

  feedback += '🎯 **Аранжировка:** ';
  const arrScores = reviews.map(r => r.arrangement_score);
  const avgArr = arrScores.reduce((a, b) => a + b, 0) / arrScores.length;
  
  if (avgArr >= 8) {
    feedback += 'Гармоничная структура и продуманная инструментовка.\n\n';
  } else if (avgArr >= 6) {
    feedback += 'Интересные идеи, есть возможности для улучшения структуры.\n\n';
  } else {
    feedback += 'Рекомендуется пересмотреть структуру и аранжировку.\n\n';
  }

  feedback += '🏆 **Оригинальность:** ';
  const origScores = reviews.map(r => r.originality_score);
  const avgOrig = origScores.reduce((a, b) => a + b, 0) / origScores.length;
  
  if (avgOrig >= 8) {
    feedback += 'Уникальное звучание, выделяется среди конкурентов.\n\n';
  } else if (avgOrig >= 6) {
    feedback += 'Приятное звучание с элементами оригинальности.\n\n';
  } else {
    feedback += 'Можно добавить больше уникальных элементов.\n\n';
  }

  feedback += '📈 **Коммерческий потенциал:** ';
  const commScores = reviews.map(r => r.commercial_potential_score);
  const avgComm = commScores.reduce((a, b) => a + b, 0) / commScores.length;
  
  if (avgComm >= 8) {
    feedback += 'Высокий потенциал успеха на рынке.';
  } else if (avgComm >= 6) {
    feedback += 'Хорошие шансы найти свою аудиторию.';
  } else {
    feedback += 'Рекомендуется доработка перед релизом.';
  }

  return feedback;
}

function templateConsolidatedRecommendations(reviews: ExpertReview[]): string {
  let recommendations = '📝 **Общие рекомендации экспертов:**\n\n';
  
  // Собираем ключевые рекомендации
  const allRecommendations = reviews
    .map(r => r.recommendations)
    .filter(r => r && r.trim().length > 0);
  
  if (allRecommendations.length > 0) {
    recommendations += allRecommendations
      .map((rec, index) => `${index + 1}. ${rec}`)
      .join('\n');
  } else {
    recommendations += 'Продолжайте развивать свой уникальный стиль и совершенствовать навыки производства.';
  }

  return recommendations;
}

// =====================================================
// 7. ФИНАЛИЗАЦИЯ И ОТПРАВКА РЕЗУЛЬТАТОВ (админстратор)
// =====================================================

app.post('/finalize', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { request_id, action, rejection_reason } = body;
    // action: 'approve' | 'reject' (default: 'approve')

    const request = await trackTestRequestsStore.get(request_id);
    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }

    // Принимаем заявки в статусе analysis_generated или pending_admin_review (обратная совместимость)
    if (request.status !== 'analysis_generated' && request.status !== 'pending_admin_review') {
      return c.json({ error: `Request is not ready for finalization (current status: ${request.status})` }, 400);
    }

    const now = new Date().toISOString();

    if (action === 'reject') {
      // Админ отклоняет анализ — требует доработки
      request.admin_approval_status = 'rejected';
      request.rejection_reason = rejection_reason || 'Требуется доработка анализа';
      request.status = 'rejected';
      request.updated_at = now;
      await trackTestRequestsStore.set(request_id, request);

      console.log(`Track test analysis rejected: ${request_id}`);

      return c.json({
        success: true,
        status: 'rejected',
        message: 'Analysis rejected by admin',
      });
    }

    // Одобрение — финализация
    request.admin_approval_status = 'approved';
    request.status = 'completed';
    request.completed_at = now;
    request.updated_at = now;

    await trackTestRequestsStore.set(request_id, request);

    console.log(`Track test finalized: ${request_id}`);

    return c.json({
      success: true,
      status: 'completed',
      message: 'Analysis approved. Use /send-feedback to deliver results to artist.',
    });

  } catch (error) {
    console.error('Error finalizing request:', error);
    return c.json({ error: 'Failed to finalize request' }, 500);
  }
});

// =====================================================
// 7a. ОТПРАВКА ОТЧЁТА АРТИСТУ (sendFeedbackToArtist)
// =====================================================

app.post('/send-feedback', requireAuth, requireAdmin, async (c) => {
  try {
    const { request_id } = await c.req.json();

    const request = await trackTestRequestsStore.get(request_id);
    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }

    if (request.status !== 'completed') {
      return c.json({ error: 'Request must be completed before sending feedback' }, 400);
    }

    if (request.feedback_sent_date) {
      return c.json({ error: 'Feedback already sent', feedback_sent_date: request.feedback_sent_date }, 400);
    }

    const now = new Date().toISOString();
    request.feedback_sent_date = now;
    request.updated_at = now;

    await trackTestRequestsStore.set(request_id, request);

    // SSE: уведомить артиста о готовом отчёте
    const recipientId = request.user_id;
    if (recipientId) {
      emitSSE(recipientId, {
        type: 'notification',
        data: {
          newStatus: 'approved',
          orderTitle: request.track_title,
          comment: `Отчёт по тесту трека "${request.track_title}" готов! Средняя оценка: ${request.average_rating}/10`,
        },
      });
    }

    const recipient = request.guest_email || request.user_id;
    console.log(`Feedback sent to: ${recipient} at ${now}`);

    return c.json({
      success: true,
      feedback_sent_date: now,
      message: `Feedback sent to ${recipient}`,
    });

  } catch (error) {
    console.error('Error sending feedback:', error);
    return c.json({ error: 'Failed to send feedback' }, 500);
  }
});

// =====================================================
// 7.a ADMIN PIPELINE — POST-TEST ПРОДВИЖЕНИЕ
// =====================================================
//
// 3 кнопки в TrackTestManagement (UI) — нажимает админ ПОСЛЕ того,
// как трек прошёл тест и фидбек отправлен артисту.
//
// A) /pipeline/promoteToNovelty — payment-link артисту на 3000 ₽.
//    Webhook (checkout-routes.tsx, type='track_test_promote') после
//    оплаты UPDATE tracks SET expert_tested_until = now() + interval
//    '14 days' WHERE id = $request.track_id. Трек появляется на
//    лендинге в секции «Протестировано экспертами».
//
// B) /pipeline/addToNewsletter — бесплатная синхронная рассылка email
//    всем users.role IN ('label','producer'). Шаблон письма содержит
//    среднюю экспертную оценку + ссылку на трек. Помечает
//    request.data.pipeline.newsletter = { sent_at, recipients_count }.
//
// C) /pipeline/exclusivePitch — payment-link артисту на 7000 ₽.
//    Webhook (type='track_test_exclusive') шлёт эксклюзивную рассылку
//    тем же label/producer + помечает
//    request.data.pipeline.exclusive = { sent_at, recipients_count }.

const TRACK_TEST_PIPELINE_PROMOTE_PRICE = 3000;
const TRACK_TEST_PIPELINE_EXCLUSIVE_PRICE = 7000;
const TRACK_TEST_PROMOTE_DAYS = 14;

async function createTrackTestPipelinePayment(
  request: any,
  type: 'track_test_promote' | 'track_test_exclusive',
  amount: number,
  description: string,
): Promise<{ orderId: string; confirmationUrl: string } | { error: string }> {
  if (!request.user_id) return { error: 'Заявка от гостя — payment-link невозможен' };
  if (!request.track_id) return { error: 'request.track_id отсутствует' };

  const { getGateway } = await import('./payment-gateway.tsx');
  const { upsertPaymentSession } = await import('./db.tsx');
  const orderId = crypto.randomUUID();
  const returnUrl = 'https://promo-music.ru/cabinet/artist?tab=promolab';

  try {
    const gw = getGateway('yookassa');
    const result = await gw.createPayment({
      amount, currency: 'RUB', description,
      gateway: 'yookassa',
      userId: request.user_id,
      orderId,
      returnUrl,
      metadata: {
        type,
        requestId: request.id,
        trackId: request.track_id,
        trackTitle: request.track_title,
      },
      savePaymentMethod: false,
      type: 'purchase',
    });

    await upsertPaymentSession(orderId, {
      orderId, userId: request.user_id,
      gateway: 'yookassa',
      gatewayPaymentId: result.sessionId,
      amount, currency: 'RUB', status: 'pending',
      type: 'purchase', description,
      metadata: {
        type, requestId: request.id,
        trackId: request.track_id,
        trackTitle: request.track_title,
      },
      savePaymentMethod: false,
      confirmationUrl: result.confirmationUrl,
      returnUrl,
      createdAt: new Date().toISOString(),
    });

    return { orderId, confirmationUrl: result.confirmationUrl };
  } catch (e: any) {
    return { error: `YooKassa: ${e?.message || 'unknown'}` };
  }
}

// A) Промо в секцию «Протестировано экспертами» (3000 ₽).
app.post('/pipeline/promoteToNovelty', requireAuth, requireAdmin, async (c) => {
  try {
    const { request_id } = await c.req.json();
    if (!request_id) return c.json({ error: 'request_id required' }, 400);
    const request: any = await trackTestRequestsStore.get(request_id);
    if (!request) return c.json({ error: 'Request not found' }, 404);
    if (request.status !== 'completed') {
      return c.json({ error: 'Заявка ещё не завершена' }, 400);
    }
    if (request?.data?.pipeline?.promote?.paid_at) {
      return c.json({ error: 'Этот трек уже промоутится' }, 409);
    }

    const payment = await createTrackTestPipelinePayment(
      request,
      'track_test_promote',
      TRACK_TEST_PIPELINE_PROMOTE_PRICE,
      `ПРОМО.ЛАБ: «${request.track_title}» — секция «Протестировано экспертами» на 14 дней`,
    );
    if ('error' in payment) return c.json({ error: payment.error }, 400);

    // Pipeline state mark — payment_pending до webhook'а.
    request.data = request.data || {};
    request.data.pipeline = request.data.pipeline || {};
    request.data.pipeline.promote = {
      payment_order_id: payment.orderId,
      requested_at: new Date().toISOString(),
      requested_by_admin: c.get('userEmail') || c.get('userId'),
      paid_at: null,
    };
    request.updated_at = new Date().toISOString();
    await trackTestRequestsStore.set(request_id, request);

    // In-app notification артисту со ссылкой на оплату.
    const { upsertNotification } = await import('./db.tsx');
    const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await upsertNotification(request.user_id, notifId, {
      type: 'track_test_promote_invoice',
      title: 'Продвижение трека в «Протестировано экспертами»',
      message: `Админ предлагает разместить «${request.track_title}» на 14 дней в секции «Протестировано экспертами». Стоимость: ${TRACK_TEST_PIPELINE_PROMOTE_PRICE} ₽.`,
      action_url: payment.confirmationUrl,
      metadata: { request_id, order_id: payment.orderId, amount: TRACK_TEST_PIPELINE_PROMOTE_PRICE },
      created_at: new Date().toISOString(),
      read: false,
    });

    emitSSE(request.user_id, {
      type: 'notification',
      data: { title: 'Предложение от ПРОМО.МУЗЫКА', comment: `Продвинуть «${request.track_title}» за ${TRACK_TEST_PIPELINE_PROMOTE_PRICE} ₽` },
    });

    return c.json({
      success: true,
      message: 'Артисту отправлено уведомление с payment-link',
      payment_order_id: payment.orderId,
      confirmation_url: payment.confirmationUrl,
    });
  } catch (error) {
    console.error('promoteToNovelty error:', error);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// B) Рассылка label/producer (бесплатно, синхронно).
app.post('/pipeline/addToNewsletter', requireAuth, requireAdmin, async (c) => {
  try {
    const { request_id } = await c.req.json();
    if (!request_id) return c.json({ error: 'request_id required' }, 400);
    const request: any = await trackTestRequestsStore.get(request_id);
    if (!request) return c.json({ error: 'Request not found' }, 404);
    if (request.status !== 'completed') {
      return c.json({ error: 'Заявка ещё не завершена' }, 400);
    }
    if (request?.data?.pipeline?.newsletter?.sent_at) {
      return c.json({ error: 'Уже отправлено в рассылку' }, 409);
    }

    // Получатели: все label/producer юзеры. role хранится в users.role
    // (text). Используем pool.query из db-client, не jsonbStore.
    const recipientsRes = await pool.query(
      `SELECT u.email FROM users u
        WHERE u.role IN ('label','producer')
          AND u.email IS NOT NULL AND u.email <> ''
          AND COALESCE((u.data->>'unsubscribed_newsletter')::boolean, false) = false`
    );
    const emails: string[] = recipientsRes.rows.map((r: any) => String(r.email)).filter(Boolean);
    if (emails.length === 0) {
      return c.json({ error: 'Нет подписчиков label/producer' }, 400);
    }

    // Шаблон письма — простой HTML с ссылкой на трек.
    const trackUrl = `https://promo-music.ru/tracks/${request.track_id || ''}`;
    const subject = `[ПРОМО.МУЗЫКА] Новый трек прошёл экспертный тест: ${request.track_title}`;
    const html = `
      <div style="font-family: system-ui, sans-serif; max-width: 600px;">
        <h2 style="color: #FF577F;">Трек прошёл экспертный тест</h2>
        <p><strong>${request.track_title}</strong> — ${request.artist_name}</p>
        <p>Жанр: ${request.genre || '—'}</p>
        <p>Средняя оценка экспертов: <strong>${request.average_rating ?? '—'}/10</strong></p>
        <p><a href="${trackUrl}" style="display:inline-block;padding:10px 20px;background:#FF577F;color:#fff;text-decoration:none;border-radius:6px;">Послушать трек</a></p>
        <hr><p style="color:#999;font-size:12px;">Вы получаете эту рассылку как зарегистрированный label/producer на promo-music.ru.</p>
      </div>`;

    const { smtpSendBatch } = await import('./smtp-sender.tsx');
    const sendResult = await smtpSendBatch(
      emails.map(e => ({ email: e })),
      subject,
      html,
      { campaignId: `track_test_newsletter:${request_id}` },
    );

    request.data = request.data || {};
    request.data.pipeline = request.data.pipeline || {};
    request.data.pipeline.newsletter = {
      sent_at: new Date().toISOString(),
      sent_by_admin: c.get('userEmail') || c.get('userId'),
      recipients_count: emails.length,
      success_count: sendResult.sent,
      fail_count: sendResult.failed,
    };
    request.updated_at = new Date().toISOString();
    await trackTestRequestsStore.set(request_id, request);

    return c.json({
      success: true,
      recipients_count: emails.length,
      message: `Письма отправлены ${emails.length} получателям`,
    });
  } catch (error) {
    console.error('addToNewsletter error:', error);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// C) Эксклюзив-pitch (7000 ₽).
app.post('/pipeline/exclusivePitch', requireAuth, requireAdmin, async (c) => {
  try {
    const { request_id } = await c.req.json();
    if (!request_id) return c.json({ error: 'request_id required' }, 400);
    const request: any = await trackTestRequestsStore.get(request_id);
    if (!request) return c.json({ error: 'Request not found' }, 404);
    if (request.status !== 'completed') {
      return c.json({ error: 'Заявка ещё не завершена' }, 400);
    }
    if (request?.data?.pipeline?.exclusive?.paid_at) {
      return c.json({ error: 'Эксклюзив уже отправлен' }, 409);
    }

    // Узнаём заранее количество получателей — для UI и UX.
    const recipientsCountRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM users
        WHERE role IN ('label','producer')
          AND email IS NOT NULL AND email <> ''`
    );
    const editors_count = recipientsCountRes.rows[0]?.c || 0;

    const payment = await createTrackTestPipelinePayment(
      request,
      'track_test_exclusive',
      TRACK_TEST_PIPELINE_EXCLUSIVE_PRICE,
      `ПРОМО.ЛАБ: эксклюзив-pitch «${request.track_title}» — ${editors_count} A&R`,
    );
    if ('error' in payment) return c.json({ error: payment.error }, 400);

    request.data = request.data || {};
    request.data.pipeline = request.data.pipeline || {};
    request.data.pipeline.exclusive = {
      payment_order_id: payment.orderId,
      requested_at: new Date().toISOString(),
      requested_by_admin: c.get('userEmail') || c.get('userId'),
      planned_recipients_count: editors_count,
      paid_at: null,
    };
    request.updated_at = new Date().toISOString();
    await trackTestRequestsStore.set(request_id, request);

    const { upsertNotification } = await import('./db.tsx');
    const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await upsertNotification(request.user_id, notifId, {
      type: 'track_test_exclusive_invoice',
      title: 'Эксклюзив-pitch A&R',
      message: `Админ предлагает отправить «${request.track_title}» с экспертной оценкой ${editors_count} A&R менеджерам. Стоимость: ${TRACK_TEST_PIPELINE_EXCLUSIVE_PRICE} ₽.`,
      action_url: payment.confirmationUrl,
      metadata: { request_id, order_id: payment.orderId, amount: TRACK_TEST_PIPELINE_EXCLUSIVE_PRICE, editors_count },
      created_at: new Date().toISOString(),
      read: false,
    });

    emitSSE(request.user_id, {
      type: 'notification',
      data: { title: 'Предложение от ПРОМО.МУЗЫКА', comment: `Эксклюзив A&R за ${TRACK_TEST_PIPELINE_EXCLUSIVE_PRICE} ₽` },
    });

    return c.json({
      success: true,
      editors_count,
      payment_order_id: payment.orderId,
      confirmation_url: payment.confirmationUrl,
      message: `Артисту отправлено уведомление с payment-link на ${TRACK_TEST_PIPELINE_EXCLUSIVE_PRICE} ₽`,
    });
  } catch (error) {
    console.error('exclusivePitch error:', error);
    return c.json({ error: 'Internal error' }, 500);
  }
});

// =====================================================
// 8. ПОЛУЧЕНИЕ ДАННЫХ
// =====================================================

// Получить список заявок пользователя
app.get('/requests', requireAuth, async (c) => {
  try {
    const userId = c.req.query('user_id');
    
    if (!userId) {
      return c.json({ error: 'User ID required' }, 400);
    }

    const requestIds = await trackTestUserRequestsStore.get(userId) || [];
    const requests = [];

    for (const requestId of requestIds) {
      const request = await trackTestRequestsStore.get(requestId);
      if (request) {
        requests.push(request);
      }
    }

    return c.json({
      success: true,
      requests,
      total: requests.length
    });

  } catch (error) {
    console.error('Error fetching requests:', error);
    return c.json({ error: 'Failed to fetch requests' }, 500);
  }
});

// Получить детали заявки
app.get('/requests/:id', requireAuth, async (c) => {
  try {
    const requestId = c.req.param('id');
    
    const request = await trackTestRequestsStore.get(requestId);
    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }

    // Single indexed SELECT — заменяет dropped track_test_request_reviews + N+1.
    const reviews = await listTrackTestReviewsByRequest(requestId);

    return c.json({
      success: true,
      request,
      reviews,
      reviews_count: reviews.length
    });

  } catch (error) {
    console.error('Error fetching request details:', error);
    return c.json({ error: 'Failed to fetch request details' }, 500);
  }
});

// Получить все заявки (для администратора)
app.get('/admin/requests', requireAuth, requireAdmin, async (c) => {
  try {
    const status = c.req.query('status');
    const allRequestIds = await trackTestAllRequestsStore.get('singleton') || [];
    const requests = [];

    for (const requestId of allRequestIds) {
      const request = await trackTestRequestsStore.get(requestId);
      if (request) {
        if (!status || request.status === status) {
          requests.push(request);
        }
      }
    }

    return c.json({
      success: true,
      requests,
      total: requests.length
    });

  } catch (error) {
    console.error('Error fetching admin requests:', error);
    return c.json({ error: 'Failed to fetch requests' }, 500);
  }
});

// Получить назначенные оценки для эксперта
app.get('/expert/reviews', requireAuth, async (c) => {
  try {
    const expertEmail = c.req.query('email');
    
    if (!expertEmail) {
      return c.json({ error: 'Expert email required' }, 400);
    }

    // Native indexed SELECT через idx_track_test_reviews_expert.
    // Single query вместо O(N*M) iteration through index tables.
    const { pool: ttPool } = await import('./db-client.tsx');
    const r = await ttPool.query(
      `SELECT * FROM track_test_reviews
        WHERE expert_email = $1 ORDER BY created_at DESC`,
      [expertEmail]
    );
    const expertReviews: any[] = [];
    for (const row of r.rows) {
      const request = await trackTestRequestsStore.get(row.request_id);
      expertReviews.push({ review: row, request });
    }

    return c.json({
      success: true,
      reviews: expertReviews,
      total: expertReviews.length
    });

  } catch (error) {
    console.error('Error fetching expert reviews:', error);
    return c.json({ error: 'Failed to fetch expert reviews' }, 500);
  }
});

// =====================================================
// 9. ДОСТУПНЫЕ ТЕСТЫ ДЛЯ ЭКСПЕРТОВ (DJ / Producer / Engineer)
// =====================================================

// No demo data — only real track test requests from the database

app.get('/available-for-review', requireAuth, async (c) => {
  try {
    const allIds = (await trackTestAllRequestsStore.get('singleton') || []) as string[];
    const expertId = c.req.query('expert_id') || '';
    const available: any[] = [];

    for (const id of allIds) {
      const req: any = await trackTestRequestsStore.get(id);
      if (!req) continue;

      // Тесты, которые ждут экспертов или ещё есть свободные слоты
      if (
        req.status === 'pending_expert_assignment' ||
        (req.status === 'experts_assigned' && (req.assigned_experts || []).length < req.required_expert_count)
      ) {
        // Не показывать тесты, где эксперт уже назначен
        if (expertId && (req.assigned_experts || []).includes(expertId)) continue;
        available.push(req);
      }
    }

    return c.json({ success: true, tests: available, total: available.length });
  } catch (error) {
    console.error('Error fetching available tests:', error);
    return c.json({ error: 'Failed to fetch available tests' }, 500);
  }
});

// =====================================================
// 10. ЭКСПЕРТ БЕРЁТ ТЕСТ В РАБОТУ
// =====================================================

app.post('/claim-review', requireAuth, async (c) => {
  try {
    const { request_id, expert_id, expert_name, expert_role } = await c.req.json();

    if (!request_id || !expert_id) {
      return c.json({ error: 'request_id and expert_id are required' }, 400);
    }

    const req: any = await trackTestRequestsStore.get(request_id);
    if (!req) return c.json({ error: 'Request not found' }, 404);

    // Allow claiming while there's room for more experts
    const acceptingStatuses = ['pending_expert_assignment', 'experts_assigned', 'in_review', 'review_in_progress'];
    const hasRoom = (req.assigned_experts || []).length < req.required_expert_count;
    if (!acceptingStatuses.includes(req.status) || (!hasRoom && req.status !== 'pending_expert_assignment')) {
      return c.json({ error: 'This test is not accepting new experts' }, 400);
    }

    if ((req.assigned_experts || []).includes(expert_id)) {
      return c.json({ error: 'You are already assigned to this test' }, 400);
    }

    // Создаём ExpertReview
    const reviewId = crypto.randomUUID();
    const now = new Date().toISOString();

    const expertReview = {
      id: reviewId,
      request_id,
      expert_email: expert_id,
      expert_name: expert_name || expert_id.split('@')[0],
      expert_role: expert_role || 'expert',
      status: 'assigned',
      mixing_mastering_score: 0,
      arrangement_score: 0,
      originality_score: 0,
      commercial_potential_score: 0,
      overall_score: 0,
      mixing_mastering_feedback: '',
      arrangement_feedback: '',
      originality_feedback: '',
      commercial_potential_feedback: '',
      general_feedback: '',
      recommendations: '',
      reward_points: 50,
      reward_paid: false,
      created_at: now,
    };

    await upsertTrackTestReview({
      ...expertReview,
      audio_notes: [],
      completed_at: null,
    } as unknown as TrackTestReviewRow);
    // track_test_request_reviews — DROPPED migration 053. List теперь
    // derived через listTrackTestReviewsByRequest, no separate index write.

    // Обновляем заявку
    req.assigned_experts = [...(req.assigned_experts || []), expert_id];
    if (req.status === 'pending_expert_assignment') {
      req.status = 'experts_assigned';
    }
    req.updated_at = now;
    await trackTestRequestsStore.set(request_id, req);

    // Atomic +1 total_assigned. Создаёт row если не существует.
    // Регистрация эксперта в track_test_expert_stats — single source of truth
    // для listRegisteredTrackTestExperts. Прежний блок с trackTestExpertsStore
    // singleton-array — REDUNDANT, удалён (migration 053 dropped the table).
    await incrementExpertAssigned(expert_id);

    // SSE: уведомить артиста-автора о новом эксперте
    if (req.user_id) {
      emitSSE(req.user_id, {
        type: 'notification',
        data: {
          newStatus: 'in_review',
          orderTitle: req.track_title,
          comment: `Эксперт ${expert_name || 'Эксперт'} взял ваш трек на рецензию`,
        },
      });
    }

    console.log(`Expert ${expert_id} claimed review for request ${request_id}`);

    return c.json({
      success: true,
      review_id: reviewId,
      message: 'Successfully claimed the test for review',
    });
  } catch (error) {
    console.error('Error claiming review:', error);
    return c.json({ error: 'Failed to claim review' }, 500);
  }
});

// =====================================================
// 11. СТАТИСТИКА ЭКСПЕРТА
// =====================================================

app.get('/expert/stats', requireAuth, async (c) => {
  try {
    const expertId = c.req.query('expert_id');
    if (!expertId) return c.json({ error: 'expert_id required' }, 400);

    const statsRow = await getExpertStats(expertId);
    const stats: any = statsRow ? {
      expert_id: statsRow.expertId,
      total_assigned: statsRow.totalAssigned,
      total_completed: statsRow.totalCompleted,
      total_coins: statsRow.totalCoins,
      rating_bonus: statsRow.ratingBonus,
    } : {
      expert_id: expertId,
      total_assigned: 0,
      total_completed: 0,
      total_coins: 0,
      rating_bonus: 0,
    };

    // SQL aggregation через idx_track_test_reviews_expert — заменяет O(N*M)
    // iteration through dropped index tables.
    const { pool: ttSPool } = await import('./db-client.tsx');
    const aggRes = await ttSPool.query(
      `SELECT
         COUNT(*)::int AS assigned,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
         COALESCE(SUM(reward_points) FILTER (WHERE status = 'completed'), 0)::int AS total_coins
         FROM track_test_reviews WHERE expert_email = $1`,
      [expertId]
    );
    const assigned: number = aggRes.rows[0]?.assigned || 0;
    const completed: number = aggRes.rows[0]?.completed || 0;
    const totalCoins: number = aggRes.rows[0]?.total_coins || 0;

    const ratingBonus = completed * 0.05; // +0.05 к рейтингу за каждый завершённый тест

    return c.json({
      success: true,
      stats: {
        expert_id: expertId,
        total_assigned: assigned,
        total_completed: completed,
        total_coins: totalCoins,
        rating_bonus: Number(ratingBonus.toFixed(2)),
      },
    });
  } catch (error) {
    console.error('Error fetching expert stats:', error);
    return c.json({ error: 'Failed to fetch expert stats' }, 500);
  }
});

// =====================================================
// 12. РЕВЬЮ ЭКСПЕРТА ПО expert_id (не email)
// =====================================================

app.get('/expert/my-reviews', requireAuth, async (c) => {
  try {
    const expertId = c.req.query('expert_id');
    if (!expertId) return c.json({ error: 'expert_id required' }, 400);

    // Indexed SELECT через idx_track_test_reviews_expert — single query.
    const { pool: ttMyPool } = await import('./db-client.tsx');
    const r = await ttMyPool.query(
      `SELECT * FROM track_test_reviews WHERE expert_email = $1 ORDER BY created_at DESC`,
      [expertId]
    );
    const myReviews: any[] = [];
    for (const review of r.rows) {
      const request = await trackTestRequestsStore.get(review.request_id);
      myReviews.push({ review, request });
    }

    return c.json({ success: true, reviews: myReviews, total: myReviews.length });
  } catch (error) {
    console.error('Error fetching my reviews:', error);
    return c.json({ error: 'Failed to fetch reviews' }, 500);
  }
});

// ── GET /quota/:userId — read current month's quota state ─────────
//
// Used by the artist cabinet to show «использовано X из Y тестов в
// этом месяце» before they hit /submit. Owner or admin only.
app.get('/quota/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId');
    const authUserId = (c as any).get('userId');
    const authRole = (c as any).get('userRole');
    if (userId !== authUserId && authRole !== 'admin' && authRole !== 'superadmin') {
      return c.json({ success: false, error: 'Access denied' }, 403);
    }
    const state = await getMonthlyTestQuotaState(userId);
    return c.json({
      success: true,
      tier: state.tier,
      quota: state.quota,
      used: state.used,
      available: state.available,
      basePrice: TRACK_TEST_BASE_PRICE,
    });
  } catch (err: any) {
    return c.json({ success: false, error: err?.message || String(err) }, 500);
  }
});

export default app;
