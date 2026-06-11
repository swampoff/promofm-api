/**
 * DB.TSX — Data Access Layer
 * Прямые SQL-запросы через PostgreSQL.
 * Каждая функция возвращает типизированные данные.
 */

import { getDbClient } from './db-client.tsx';

const db = () => getDbClient();

// ─── Helpers ───

function throwIfError(result: { error: any; data: any }, context: string) {
  if (result.error) {
    console.error(`[db] ${context}:`, result.error);
    throw new Error(result.error.message || `DB error in ${context}`);
  }
  return result.data;
}

// ─── Profiles ───

export async function getProfile(userId: string) {
  const { data, error } = await db()
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getProfile:', error);
  return data;
}

export async function upsertProfile(userId: string, profile: Record<string, any>) {
  const row = { user_id: userId, ...profile, updated_at: new Date().toISOString() };
  const { data, error } = await db()
    .from('profiles')
    .upsert(row, { onConflict: 'user_id' })
    .select()
    .single();
  if (error) console.error('[db] upsertProfile:', error);
  return data;
}

// ─── Tracks ───

export async function getTracksByUser(userId: string) {
  const { data, error } = await db()
    .from('tracks')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getTracksByUser:', error);
  return (data || []).map((r: any) => r.data || r);
}

// Legacy getTrack/upsertTrack/deleteTrack (composite text key `${userId}:${trackId}`
// против UUID-колонки tracks.id) удалены — никогда не работали на проде.
// Use db-typed.tsx { getTrackById, insertTrack, updateTrack, deleteTrack }.

// ─── Videos ───

export async function getVideosByUser(userId: string) {
  const { data, error } = await db()
    .from('videos')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getVideosByUser:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function upsertVideo(userId: string, videoId: string, video: Record<string, any>) {
  // videoId may not be a valid UUID — use insert instead of upsert for non-UUID IDs
  try {
    const { error } = await db()
      .from('videos')
      .insert({
        artist_id: userId,
        user_id: userId,
        title: video.title || 'Untitled',
        description: video.description || '',
        video_url: video.video_url || video.url || '',
        thumbnail_url: video.thumbnail_url || '',
      });
    if (error) console.error('[db] upsertVideo:', error);
  } catch (e: any) {
    console.error('[db] upsertVideo exception:', e.message);
  }
  if (error) console.error('[db] upsertVideo:', error);
}

// ─── News ───

export async function getNewsByUser(userId: string) {
  const { data, error } = await db()
    .from('news')
    .select('*')
    .eq('author_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getNewsByUser:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function upsertNews(userId: string, newsId: string, news: Record<string, any>) {
  const row = {
    id: newsId,
    author_id: userId,
    title: news.title || 'Untitled',
    content: news.content || '',
    summary: news.summary || '',
    category: news.category || 'general',
    status: news.status || 'draft',
    author_name: news.author_name || '',
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('news')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertNews:', error);
}

// ─── Concerts ───

export async function getConcertsByUser(userId: string) {
  const { data, error } = await db()
    .from('concerts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getConcertsByUser:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function getAllConcerts() {
  const { data, error } = await db()
    .from('concerts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getAllConcerts:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function getConcert(concertId: string) {
  // concerts stores id as "userId:concertId"
  const { data, error } = await db()
    .from('concerts')
    .select('*')
    .like('id', `%:${concertId}`)
    .maybeSingle();
  if (error) console.error('[db] getConcert:', error);
  return data ? (data.data || data) : null;
}

export async function upsertConcert(userId: string, concertId: string, concert: Record<string, any>) {
  const row = {
    id: `${userId}:${concertId}`,
    user_id: userId,
    data: concert,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('concerts')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertConcert:', error);
}

export async function deleteConcert(userId: string, concertId: string) {
  const { error } = await db()
    .from('concerts')
    .delete()
    .eq('id', `${userId}:${concertId}`);
  if (error) console.error('[db] deleteConcert:', error);
}

// ─── Donations ───

export async function getDonationsByArtist(artistId: string) {
  const { data, error } = await db()
    .from('donations')
    .select('*')
    .eq('recipient_id', artistId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getDonationsByArtist:', error);
  // FIX (2026-06-04): донаты пишутся в КОЛОНКИ (recipient_id/amount/status),
  // а `data` jsonb остаётся '{}'. Старое `r.data || r` для пустого {} (truthy)
  // возвращало {} → баланс/список донатов были пустыми у ВСЕХ артистов
  // (рублёвый кошелёк показывал 0). Берём строку, когда data пустой/NULL.
  return (data || []).map((r: any) =>
    (r.data && typeof r.data === 'object' && Object.keys(r.data).length > 0) ? r.data : r
  );
}

export async function createDonation(artistId: string, donationId: string, donation: Record<string, any>) {
  const row = {
    id: donationId,
    recipient_id: artistId,
    donor_id: donation.donor_id || null,
    amount: donation.amount || 0,
    currency: donation.currency || 'RUB',
    message: donation.message || '',
    is_anonymous: donation.is_anonymous || false,
    status: donation.status || 'completed',
  };
  const { error } = await db()
    .from('donations')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] createDonation:', error);
}

// ─── Coins ───

export async function getCoinBalance(userId: string) {
  const { data, error } = await db()
    .from('coin_balances')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getCoinBalance:', error);
  return data ? { balance: data.balance, userId } : null;
}

export async function setCoinBalance(userId: string, balance: number) {
  const { error } = await db()
    .from('coin_balances')
    .upsert({ user_id: userId, balance, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) console.error('[db] setCoinBalance:', error);
}

// Atomic increment via raw SQL — necessary for concurrent topups for the same
// user. The read-modify-write pattern (getCoinBalance then setCoinBalance)
// loses updates when two webhooks land in the same event-loop tick.
// UPSERT-on-conflict ensures users with no existing row get one created.
export async function incrementCoinBalanceAtomic(userId: string, delta: number): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const res = await pool.query(
    `INSERT INTO coin_balances (user_id, balance, updated_at)
     VALUES ($1, $2::numeric, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET balance = coin_balances.balance + EXCLUDED.balance,
           updated_at = NOW()
     RETURNING balance`,
    [userId, delta]
  );
  return Number(res.rows[0]?.balance ?? 0);
}

export async function getCoinTransactions(userId: string) {
  const { data, error } = await db()
    .from('coin_transactions')
    .select('*')
    .eq('artist_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getCoinTransactions:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function createCoinTransaction(userId: string, txId: string, tx: Record<string, any>) {
  const row = {
    id: txId,
    artist_id: userId,
    transaction_type: tx.type || tx.transaction_type || 'credit',
    amount: tx.amount || 0,
    balance_before: tx.balance_before || 0,
    balance_after: tx.balance_after || 0,
    description: tx.description || '',
    reference_type: tx.reference_type || null,
    reference_id: tx.reference_id || null,
    metadata: tx.metadata ? JSON.stringify(tx.metadata) : '{}',
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('coin_transactions')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] createCoinTransaction:', error);
}

// ─── Payment Sessions ───

export async function getPaymentSession(orderId: string) {
  const { data, error } = await db()
    .from('payment_sessions')
    .select('*')
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) console.error('[db] getPaymentSession:', error);
  return data ? (data.data || data) : null;
}

// Self-heal payment_sessions.shop_id — migration 100 is manual, but the
// code below writes shop_id unconditionally. If a deploy reaches code
// before the migration runs (or on a fresh PG instance), every upsert
// would 500 with "column shop_id does not exist". Memoized ALTER TABLE
// ADD COLUMN IF NOT EXISTS makes this safe regardless of deploy order.
let _paymentSessionsShopIdReady: Promise<void> | null = null;
function ensurePaymentSessionsShopId(): Promise<void> {
  if (_paymentSessionsShopIdReady) return _paymentSessionsShopIdReady;
  _paymentSessionsShopIdReady = (async () => {
    try {
      const { pool } = await import('./db-client.tsx');
      await pool.query(`ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS shop_id TEXT`);
    } catch (err) {
      console.error('[db] ensurePaymentSessionsShopId failed:', err);
      _paymentSessionsShopIdReady = null; // allow retry on next request
      throw err;
    }
  })();
  return _paymentSessionsShopIdReady;
}

export async function upsertPaymentSession(orderId: string, session: Record<string, any>) {
  // Migration 100: пишем shop_id для yookassa-сессий. Для других gateway'ев
  // (Stripe, T-Bank) — поле остаётся NULL, gateway-обработчики его не
  // используют. При обновлении session — shop_id может прийти из
  // resolvedShopId (после webhook verify); если нет — берём текущий
  // YOOKASSA_SHOP_ID из env (для свежесозданных сессий).
  await ensurePaymentSessionsShopId();
  const provider = session.gateway || session.provider || 'yookassa';
  let shopId: string | null = session.shop_id || session.shopId || null;
  if (!shopId && provider === 'yookassa') {
    shopId = process.env.YOOKASSA_SHOP_ID || null;
  }
  const row: Record<string, any> = {
    order_id: orderId,
    user_id: session.userId || session.user_id || 'unknown',
    amount: session.amount || 0,
    currency: session.currency || 'RUB',
    purpose: session.type || session.purpose || null,
    status: session.status || 'created',
    provider,
    provider_session_id: session.gatewayPaymentId || session.provider_session_id || null,
    shop_id: shopId,
    data: { ...session, shop_id: shopId },
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('payment_sessions')
    .upsert(row, { onConflict: 'order_id' });
  if (error) console.error('[db] upsertPaymentSession:', error);
}

// Migration 100: targeted UPDATE для записи только shop_id, БЕЗ риска
// перезаписать status/data из stale in-memory копии. Используется в
// webhook handler'ах, где мы хотим зафиксировать resolvedShopId
// (после verifyWebhook с legacy creds) без побочных эффектов на
// claimPaymentSessionForProcessing / processPaymentSuccess.
//
// WHERE-clause проверяет COALESCE(shop_id,'')<>$1 — UPDATE не происходит
// если shop_id уже совпадает (избегаем лишнего write'а и trigger'а
// updated_at). Возвращает true если строка обновилась.
export async function setPaymentSessionShopId(orderId: string, shopId: string): Promise<boolean> {
  if (!shopId) return false;
  await ensurePaymentSessionsShopId();
  const { pool } = await import('./db-client.tsx');
  const res = await pool.query(
    `UPDATE payment_sessions
        SET shop_id = $1,
            data    = jsonb_set(COALESCE(data, '{}'::jsonb), '{shop_id}', to_jsonb($1::text)),
            updated_at = NOW()
      WHERE order_id = $2
        AND COALESCE(shop_id, '') <> $1`,
    [shopId, orderId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Atomic webhook idempotency claim.
 * Transitions a session's status from 'pending' → 'processing' in a single SQL UPDATE.
 * Returns the session blob on success, or null if the session is missing OR its status
 * is no longer 'pending' (another webhook is already processing / has processed it).
 *
 * This closes the race window where two concurrent webhook deliveries from the same
 * gateway would both read status='pending' and double-credit the user's balance.
 */
export async function claimPaymentSessionForProcessing(orderId: string): Promise<Record<string, any> | null> {
  const { pool } = await import('./db-client.tsx');
  const res = await pool.query(
    `UPDATE payment_sessions
        SET status = 'processing',
            data = data || jsonb_build_object('status', 'processing'),
            updated_at = NOW()
      WHERE order_id = $1 AND status = 'pending'
      RETURNING data`,
    [orderId],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return row?.data || null;
}

/**
 * Reverts a 'processing' claim back to 'pending' so the gateway's retry can succeed.
 * No-op if status is not 'processing' (e.g. already succeeded or already reverted).
 */
export async function revertPaymentSessionToPending(orderId: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE payment_sessions
        SET status = 'pending',
            data = data || jsonb_build_object('status', 'pending'),
            updated_at = NOW()
      WHERE order_id = $1 AND status = 'processing'`,
    [orderId],
  );
}

// ─── Subscriptions ───

export async function getSubscription(userId: string) {
  const { data, error } = await db()
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getSubscription:', error);
  return data ? (data.data || data) : null;
}

export async function upsertSubscription(userId: string, sub: Record<string, any>) {
  const row = {
    user_id: userId,
    data: sub,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('subscriptions')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertSubscription:', error);
}

export async function getAllSubscriptions(limit = 500): Promise<{ key: string; value: any }[]> {
  const { data, error } = await db()
    .from('subscriptions')
    .select('*')
    .limit(limit);
  if (error) console.error('[db] getAllSubscriptions:', error);
  return (data || []).map((r: any) => ({
    key: `subscription:${r.user_id}`,
    value: r.data || r,
  }));
}

// ─── Notifications ───

export async function getNotificationsByUser(userId: string) {
  const { data, error } = await db()
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getNotificationsByUser:', error);
  // Normalize each row to the camelCase shape the frontend expects.
  // Two row variants live in this table:
  //   - new rows: native columns only (no `data` jsonb), so `r.data` is
  //     null and we'd previously fall back to the raw row, leaking
  //     `created_at` / `notification_type` / `is_read` snake_case fields
  //     that the UI doesn't read → "Invalid Date" + "без конкретики".
  //   - legacy rows: rich `data` jsonb with the full notification object
  //     (orderTitle, newStatus, comment, createdAt camelCase, etc.)
  // Merge: jsonb supplies rich fields, native columns are the source of
  // truth for primitives that the trigger keeps in sync.
  return (data || []).map((r: any) => {
    const rich = r.data && typeof r.data === 'object' ? r.data : null;
    return {
      ...(rich || {}),
      id: r.id,
      type: r.notification_type || rich?.type || 'info',
      title: r.title || rich?.title || '',
      message: r.message || rich?.message || '',
      read: r.is_read ?? rich?.read ?? false,
      createdAt: rich?.createdAt || r.created_at || '',
    };
  });
}

export async function getNotification(userId: string, notifId: string) {
  const { data, error } = await db()
    .from('notifications')
    .select('*')
    .eq('id', `${userId}:${notifId}`)
    .maybeSingle();
  if (error) console.error('[db] getNotification:', error);
  return data ? (data.data || data) : null;
}

export async function upsertNotification(userId: string, notifId: string, notif: Record<string, any>) {
  // Persist the full notification object into `data` jsonb so rich
  // fields (orderTitle, newStatus, createdAt, comment, etc.) survive
  // the round-trip. Previously only the 4 primitive columns were
  // stored — anything the caller passed got dropped, which is why
  // history rows came back without dates and with empty titles.
  const row = {
    id: notifId,
    user_id: userId,
    notification_type: notif.type || 'info',
    title: notif.title || '',
    message: notif.message || '',
    status: notif.read ? 'read' : 'unread',
    is_read: notif.read || false,
    data: notif,
  };
  const { error } = await db()
    .from('notifications')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertNotification:', error);
}

export async function deleteNotification(userId: string, notifId: string) {
  // Scope by user_id too — single-row delete shouldn't blow away
  // someone else's notification if id collides (defense in depth;
  // ids are uuid-shaped so this isn't a real risk today).
  const { error } = await db()
    .from('notifications')
    .delete()
    .eq('id', notifId)
    .eq('user_id', userId);
  if (error) console.error('[db] deleteNotification:', error);
}

/**
 * Bulk-delete all of a user's notifications in one query. Used by the
 * "Очистить все" button. Returns the number of rows removed.
 *
 * Previously the route iterated deleteNotification per row, which
 * (a) silently skipped rows whose stored id didn't match the returned
 * id format (legacy composite `${userId}:${notifId}` survivors) and
 * (b) sent N queries when one would do. Real users had 16+ rows hang
 * after clicking the button — that loop never finished cleaning up.
 *
 * notifications.user_id is text (verified via existing .eq() queries
 * in this file); $1 from the route arrives as text. text=text, no cast.
 */
export async function deleteAllNotifications(userId: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const { rowCount } = await pool.query(
    `DELETE FROM notifications WHERE user_id = $1`,
    [userId],
  );
  return rowCount || 0;
}

// ─── Notification Settings ───

export async function getNotificationSettings(userId: string) {
  const { data, error } = await db()
    .from('notification_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getNotificationSettings:', error);
  return data ? (data.data || data) : null;
}

export async function upsertNotificationSettings(userId: string, settings: Record<string, any>) {
  const row = {
    id: userId,
    data: settings,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('notification_settings')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertNotificationSettings:', error);
}

// ─── User Settings ───

export async function getUserSettings(userId: string) {
  const { data, error } = await db()
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getUserSettings:', error);
  // Schema: user_id, theme, language, ..., data (jsonb). Settings лежат в `data`.
  // Старый код пробовал .settings (несуществующее поле) — теперь читаем прямо .data.
  return data ? (data.data || null) : null;
}

export async function upsertUserSettings(userId: string, settings: Record<string, any>) {
  // Колонка в таблице user_settings — `data` (jsonb), а не `settings`.
  // Прошлая версия писала в несуществующую колонку → upsert тихо игнорировал,
  // юзер видел "сохранено" но после refresh всё сбрасывалось до дефолтов.
  const row = {
    user_id: userId,
    data: settings,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('user_settings')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertUserSettings:', error);
}

// Legacy getTrackAnalytics/upsertTrackAnalytics удалены — таблица track_analytics
// не существует ни в одной migration, эти helpers crashed бы при первом
// вызове. Единственный caller (analytics-routes.tsx) тоже удалён.
// Если потребуется per-track analytics — отдельным PR'ом с native schema.

// ─── Artist Profiles ───

export async function getArtistProfile(artistId: string) {
  // Try by id first, then by user_id
  let { data, error } = await db()
    .from('artist_profiles')
    .select('*')
    .eq('id', artistId)
    .maybeSingle();
  
  if (!data) {
    const res = await db()
      .from('artist_profiles')
      .select('*')
      .eq('user_id', artistId)
      .maybeSingle();
    data = res.data;
    if (res.error) error = res.error;
  }
  
  if (error) console.error('[db] getArtistProfile:', error);
  // Return the full row (not just data column) for proper field access
  return data || null;
}

export async function upsertArtistProfile(artistId: string, profile: Record<string, any>) {
  const row = {
    id: artistId,
    data: profile,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('artist_profiles')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertArtistProfile:', error);
}

export async function getAllArtistProfiles() {
  const { data, error } = await db()
    .from('artist_profiles')
    .select('*')
    .order('total_plays', { ascending: false });
  if (error) console.error('[db] getAllArtistProfiles:', error);
  // Return full rows with proper field names
  return (data || []).map((r: any) => ({
    id: r.user_id || r.id,
    slug: r.slug || '',
    name: r.artist_name || '',
    genre: r.genre || '',
    genres: r.sub_genres || [],
    city: r.city || '',
    country: r.country || 'Россия',
    bio: r.bio || '',
    avatarUrl: r.avatar_url || '',
    coverUrl: r.cover_url || '',
    website: r.website || '',
    socialLinks: r.social_links || {},
    streamingLinks: r.streaming_links || {},
    monthlyListeners: r.monthly_listeners || 0,
    totalPlays: r.total_plays || 0,
    totalFollowers: r.total_followers || 0,
    isVerified: r.is_verified || false,
    trackCount: r.data?.track_count || 0,
  }));
}

// ─── Marketplace / Beats ───

export async function getBeats(filters?: { genre?: string; producerId?: string }) {
  let q = db().from('beats').select('*').order('created_at', { ascending: false });
  if (filters?.genre) q = q.eq('genre', filters.genre);
  if (filters?.producerId) q = q.eq('producer_id', filters.producerId);
  const { data, error } = await q;
  if (error) console.error('[db] getBeats:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function getBeat(beatId: string) {
  const { data, error } = await db()
    .from('beats')
    .select('*')
    .eq('id', beatId)
    .maybeSingle();
  if (error) console.error('[db] getBeat:', error);
  return data ? (data.data || data) : null;
}

export async function upsertBeat(beatId: string, beat: Record<string, any>) {
  const row = {
    id: beatId,
    data: beat,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('beats')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertBeat:', error);
}

export async function deleteBeat(beatId: string) {
  const { error } = await db()
    .from('beats')
    .delete()
    .eq('id', beatId);
  if (error) console.error('[db] deleteBeat:', error);
}

// ─── Bookings ───

// bookings (row-per-booking, full native cols since migration 047).
// API contract: camelCase booking object с populated performer/requester
// (последнее — derived из profile tables, не stored snapshot).

const BOOKING_NATIVE_COLS = `id, user_id, performer_id, venue_id,
  requester_type, performer_type, event_type, event_title, event_description,
  event_date, start_time, duration_hours, venue_name, venue_address,
  venue_city, venue_type, expected_audience, audience_type,
  total_price, performer_fee, platform_commission,
  deposit_amount, deposit_percentage, deposit_paid, final_amount,
  technical_requirements, special_requests, status,
  accepted_at, rejected_at, cancelled_at, deposit_paid_at, final_paid_at,
  cancelled_by, cancelled_by_role, cancellation_reason,
  created_at, updated_at`;

function mapBookingRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    requesterId: r.user_id,
    requesterType: r.requester_type,
    performerId: r.performer_id,
    performerType: r.performer_type,
    venueId: r.venue_id,
    eventType: r.event_type,
    eventTitle: r.event_title,
    eventDescription: r.event_description,
    eventDate: iso(r.event_date),
    startTime: r.start_time,
    durationHours: r.duration_hours !== null ? Number(r.duration_hours) : null,
    venueName: r.venue_name,
    venueAddress: r.venue_address,
    venueCity: r.venue_city,
    venueType: r.venue_type,
    expectedAudience: r.expected_audience,
    audienceType: r.audience_type,
    offeredPrice: r.total_price !== null ? Number(r.total_price) : null,
    performerFee: r.performer_fee !== null ? Number(r.performer_fee) : null,
    platformCommission: r.platform_commission !== null ? Number(r.platform_commission) : null,
    depositAmount: r.deposit_amount !== null ? Number(r.deposit_amount) : null,
    depositPercentage: r.deposit_percentage !== null ? Number(r.deposit_percentage) : null,
    depositPaid: !!r.deposit_paid,
    finalAmount: r.final_amount !== null ? Number(r.final_amount) : null,
    technicalRequirements: r.technical_requirements || {},
    specialRequests: r.special_requests || '',
    status: r.status,
    acceptedAt: iso(r.accepted_at),
    rejectedAt: iso(r.rejected_at),
    cancelledAt: iso(r.cancelled_at),
    depositPaidAt: iso(r.deposit_paid_at),
    finalPaidAt: iso(r.final_paid_at),
    cancelledBy: r.cancelled_by,
    cancelledByRole: r.cancelled_by_role,
    cancellationReason: r.cancellation_reason,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function getBookingsByUser(userId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${BOOKING_NATIVE_COLS} FROM bookings
      WHERE performer_id = $1 OR user_id = $1
      ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows.map(mapBookingRow);
}

export async function getBooking(bookingId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${BOOKING_NATIVE_COLS} FROM bookings WHERE id = $1`,
    [bookingId]
  );
  return r.rowCount ? mapBookingRow(r.rows[0]) : null;
}

export async function upsertBooking(bookingId: string, booking: Record<string, any>) {
  // Row-per-booking (migration 047): native cols only, no data jsonb.
  const { pool } = await import('./db-client.tsx');
  const tr = booking.technicalRequirements || {};
  const techReq = typeof tr === 'string' ? tr : JSON.stringify(tr);
  await pool.query(
    `INSERT INTO bookings (
       id, user_id, performer_id, venue_id,
       requester_type, performer_type, event_type, event_title, event_description,
       event_date, start_time, duration_hours,
       venue_name, venue_address, venue_city, venue_type,
       expected_audience, audience_type,
       total_price, performer_fee, platform_commission,
       deposit_amount, deposit_percentage, deposit_paid, final_amount,
       technical_requirements, special_requests,
       status,
       accepted_at, rejected_at, cancelled_at, deposit_paid_at, final_paid_at,
       cancelled_by, cancelled_by_role, cancellation_reason,
       updated_at
     )
     VALUES ($1, $2, $3, $4,
             $5, $6, $7, $8, $9,
             $10, $11, $12,
             $13, $14, $15, $16,
             $17, $18,
             $19, $20, $21,
             $22, $23, $24, $25,
             $26::jsonb, $27,
             $28,
             $29, $30, $31, $32, $33,
             $34, $35, $36,
             NOW())
     ON CONFLICT (id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       performer_id = EXCLUDED.performer_id,
       venue_id = EXCLUDED.venue_id,
       requester_type = EXCLUDED.requester_type,
       performer_type = EXCLUDED.performer_type,
       event_type = EXCLUDED.event_type,
       event_title = EXCLUDED.event_title,
       event_description = EXCLUDED.event_description,
       event_date = EXCLUDED.event_date,
       start_time = EXCLUDED.start_time,
       duration_hours = EXCLUDED.duration_hours,
       venue_name = EXCLUDED.venue_name,
       venue_address = EXCLUDED.venue_address,
       venue_city = EXCLUDED.venue_city,
       venue_type = EXCLUDED.venue_type,
       expected_audience = EXCLUDED.expected_audience,
       audience_type = EXCLUDED.audience_type,
       total_price = EXCLUDED.total_price,
       performer_fee = EXCLUDED.performer_fee,
       platform_commission = EXCLUDED.platform_commission,
       deposit_amount = EXCLUDED.deposit_amount,
       deposit_percentage = EXCLUDED.deposit_percentage,
       deposit_paid = EXCLUDED.deposit_paid,
       final_amount = EXCLUDED.final_amount,
       technical_requirements = EXCLUDED.technical_requirements,
       special_requests = EXCLUDED.special_requests,
       status = EXCLUDED.status,
       accepted_at = EXCLUDED.accepted_at,
       rejected_at = EXCLUDED.rejected_at,
       cancelled_at = EXCLUDED.cancelled_at,
       deposit_paid_at = EXCLUDED.deposit_paid_at,
       final_paid_at = EXCLUDED.final_paid_at,
       cancelled_by = EXCLUDED.cancelled_by,
       cancelled_by_role = EXCLUDED.cancelled_by_role,
       cancellation_reason = EXCLUDED.cancellation_reason,
       updated_at = NOW()`,
    [
      bookingId,
      booking.requesterId || null,
      booking.performerId || null,
      booking.venueId || null,
      booking.requesterType || null,
      booking.performerType || null,
      booking.eventType || null,
      booking.eventTitle || null,
      booking.eventDescription || null,
      booking.eventDate || null,
      booking.startTime || null,
      booking.durationHours ?? null,
      booking.venueName || null,
      booking.venueAddress || null,
      booking.venueCity || null,
      booking.venueType || null,
      booking.expectedAudience ?? null,
      booking.audienceType || null,
      booking.offeredPrice ?? null,
      booking.performerFee ?? null,
      booking.platformCommission ?? null,
      booking.depositAmount ?? null,
      booking.depositPercentage ?? null,
      booking.status === 'deposit_paid' || booking.status === 'confirmed' || booking.status === 'completed',
      booking.finalAmount ?? null,
      techReq,
      booking.specialRequests || null,
      booking.status || 'pending',
      booking.acceptedAt || null,
      booking.rejectedAt || null,
      booking.cancelledAt || null,
      booking.depositPaidAt || null,
      booking.finalPaidAt || null,
      booking.cancelledBy || null,
      booking.cancelledByRole || null,
      booking.cancellationReason || null,
    ]
  );
}

// ─── Messaging ───

export async function getConversationsByUser(userId: string) {
  const { data, error } = await db()
    .from('conversations')
    .select('*')
    .contains('participant_ids', [userId])
    .order('last_message_at', { ascending: false });
  if (error) console.error('[db] getConversationsByUser:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function getMessages(conversationId: string) {
  const { data, error } = await db()
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) console.error('[db] getMessages:', error);
  return (data || []).map((r: any) => r.data || r);
}

// ─── Support Tickets ───

// ─── Support Tickets (row-per-ticket, full native cols since migration 048) ───

const TICKET_NATIVE_COLS = `id, user_id, subject, description, category, priority,
  status, assigned_to, attachments, tags, messages, rating, feedback,
  sla_due_date, resolved_at, closed_at, created_at, updated_at`;

function mapTicketRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    user_id: r.user_id,
    subject: r.subject || '',
    description: r.description || '',
    category: r.category,
    priority: r.priority,
    status: r.status,
    assigned_to: r.assigned_to || null,
    attachments: r.attachments || [],
    tags: r.tags || [],
    messages: r.messages || [],
    rating: r.rating !== null ? Number(r.rating) : null,
    feedback: r.feedback || null,
    sla_due_date: iso(r.sla_due_date),
    resolved_at: iso(r.resolved_at),
    closed_at: iso(r.closed_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export async function getTicketsByUser(userId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${TICKET_NATIVE_COLS} FROM support_tickets
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows.map(mapTicketRow);
}

export async function upsertTicket(ticketId: string, ticket: Record<string, any>) {
  // Row-per-ticket (migration 048): native cols only, no data jsonb.
  // 🐛 PREV BUG: writes только {id, data, updated_at} без user_id —
  // getTicketsByUser возвращал [] для ticket'ов созданных через этот
  // helper.
  const { pool } = await import('./db-client.tsx');
  const att = ticket.attachments ?? [];
  const tags = ticket.tags ?? [];
  const msgs = ticket.messages ?? [];
  await pool.query(
    `INSERT INTO support_tickets (
       id, user_id, subject, description, category, priority, status,
       assigned_to, attachments, tags, messages, rating, feedback,
       sla_due_date, resolved_at, closed_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13,
             $14, $15, $16, NOW())
     ON CONFLICT (id) DO UPDATE SET
       user_id      = COALESCE(EXCLUDED.user_id, support_tickets.user_id),
       subject      = EXCLUDED.subject,
       description  = EXCLUDED.description,
       category     = EXCLUDED.category,
       priority     = EXCLUDED.priority,
       status       = EXCLUDED.status,
       assigned_to  = EXCLUDED.assigned_to,
       attachments  = EXCLUDED.attachments,
       tags         = EXCLUDED.tags,
       messages     = EXCLUDED.messages,
       rating       = EXCLUDED.rating,
       feedback     = EXCLUDED.feedback,
       sla_due_date = EXCLUDED.sla_due_date,
       resolved_at  = EXCLUDED.resolved_at,
       closed_at    = EXCLUDED.closed_at,
       updated_at   = NOW()`,
    [
      ticketId,
      ticket.user_id || null,
      ticket.subject || '',
      ticket.description || '',
      ticket.category || null,
      ticket.priority || 'medium',
      ticket.status || 'open',
      ticket.assigned_to || null,
      JSON.stringify(Array.isArray(att) ? att : []),
      JSON.stringify(Array.isArray(tags) ? tags : []),
      JSON.stringify(Array.isArray(msgs) ? msgs : []),
      ticket.rating ?? null,
      ticket.feedback || null,
      ticket.sla_due_date || null,
      ticket.resolved_at || null,
      ticket.closed_at || null,
    ]
  );
}

// ─── Marketing Campaigns ───
// getCampaignsByUser / upsertCampaign DELETED — было 0 callers.
// `marketing_campaigns` пишется напрямую в promotion-routes-sql.tsx и
// читается analytics-эндпоинтами в marketing-campaigns-routes.tsx —
// все на native cols (artist_id, campaign_name, campaign_type, budget,
// platforms, metrics, roi, …), `data` колонки не использует никто.
// (Реальный backing store за маркетинг-кампаниями — notification_campaigns,
//  см. ниже после строки "Notification Campaigns".)

// ─── Banner Ads ───

export async function getBannersByUser(userId: string) {
  const { data, error } = await db()
    .from('banner_ads')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getBannersByUser:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function upsertBanner(bannerId: string, userId: string, banner: Record<string, any>) {
  const row = {
    id: bannerId,
    user_id: userId,
    data: banner,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('banner_ads')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertBanner:', error);
}

// Platform Stats — see typed functions below (anchor: platform_stats typed).

// Agent Sessions — see native typed functions below (migration 081).

// ─── Charts ───

export async function getChartsSources() {
  const { data, error } = await db()
    .from('chart_sources')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getChartsSources:', error);
  return (data || []).map((r: any) => r.data || r);
}

// ─── DJ Profiles ───

export async function getDjProfiles() {
  const { data, error } = await db()
    .from('dj_profiles')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getDjProfiles:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function getDjProfile(djId: string) {
  // Callers pass user_id (the platform identity), not the auto-generated
  // dj_profiles.id uuid. Same identity-model the upsert side uses now —
  // see commit 8652379 for the matching writer fix. Looking up by id
  // returns null for every freshly-onboarded DJ and the editor renders
  // empty even though the row exists in jsonb.
  const { data, error } = await db()
    .from('dj_profiles')
    .select('*')
    .eq('user_id', djId)
    .maybeSingle();
  if (error) console.error('[db] getDjProfile:', error);
  return data ? (data.data || data) : null;
}

export async function upsertDjProfile(djId: string, profile: Record<string, any>) {
  // Source-of-truth shape from the DJ profile editor (frontend
  // `gatherAllData()` in `src/dj/components/DjProfileEditor.tsx:164`)
  // is NESTED:
  //
  //   {
  //     profile: { djName, bio, avatarUrl, city, genres, ... },
  //     booking: {...}, contacts: {...}, contactPersons: [...],
  //     equipmentList: [...], pricingRules: [...], ...
  //   }
  //
  // POST /profile/avatar and POST /profile/cover also write the
  // nested form (`data.profile.avatarUrl = url`). For two years
  // this function looked at the TOP LEVEL only — so every native
  // column (`dj_name`, `bio`, `avatar_url`, ...) ended up NULL while
  // the JSONB `data` column quietly carried the real values.
  //
  // The cabinet itself worked (it re-reads from `data` jsonb), but
  // every consumer that joins on native columns was broken:
  //   - /dj-marketplace cards (public DJ listing) — no name, no avatar
  //   - search filters / sort by rating — never matched
  //   - admin queues filtering by location / genre
  //
  // Fix: unwrap the nested envelope when present, keep accepting
  // flat input for legacy callers. Discovered 2026-05-25 when a
  // fresh QA DJ kept seeing «Имя ещё не задано» on the public side
  // even after saving everything in the editor.
  const inner: Record<string, any> = (profile?.profile && typeof profile.profile === 'object')
    ? { ...profile, ...profile.profile }   // nested envelope wins for editor-side fields
    : profile;

  // Don't pin `id`: callers pass djId === user_id, but dj_profiles.id is
  // a separate uuid (auto-generated) and user_id carries the UNIQUE
  // constraint. Passing id=user_id makes UPSERT try to INSERT a new row
  // with id matching some other row's user_id — fails with
  // dj_profiles_user_id_key duplicate. Letting the DB keep its own id and
  // resolving the conflict on user_id is the correct identity model.
  const row: Record<string, any> = {
    user_id: inner.userId || djId,
    dj_name: inner.djName || inner.dj_name || inner.stageName || null,
    genres: inner.genres || [],
    bio: inner.bio || inner.about || null,
    avatar_url: inner.avatarUrl || inner.avatar_url || null,
    location: inner.city || inner.location || null,
    hourly_rate: inner.hourlyRate || inner.hourly_rate || inner.ratePerHour || 0,
    experience_years: inner.experienceYears || inner.experience_years || 0,
    equipment: inner.equipment || null,
    is_available: inner.isAvailable !== undefined
      ? inner.isAvailable
      : (inner.openForBookings !== undefined ? inner.openForBookings : true),
    rating: inner.rating || 0,
    total_reviews: inner.totalReviews || inner.total_reviews || 0,
    is_verified: inner.verified || inner.is_verified || false,
    completed_gigs: inner.completedGigs || inner.completed_gigs || 0,
    tags: inner.tags || inner.specializations || [],
    price_from: inner.priceFrom || inner.price_from || inner.ratePerHour || inner.ratePerEvent || 0,
    photo_url: inner.photo || inner.photo_url || inner.avatarUrl || null,
    // Preserve the ORIGINAL payload shape in jsonb so the cabinet's
    // own editor can rehydrate via getDjProfile() unchanged.
    data: profile,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('dj_profiles')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertDjProfile:', error);
}

// ─── Venue Profiles ───

export async function getVenueProfile(userId: string) {
  const { data, error } = await db()
    .from('venue_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getVenueProfile:', error);
  if (!data) return null;

  // Overlay native columns (migration 059) on top of legacy `data` jsonb.
  // After 059, native columns are source-of-truth for the 12 promoted
  // fields — but billing-side updaters (checkout-routes, venue-billing-*,
  // venue-trial) still UPDATE data = $1::jsonb without touching native
  // columns, so jsonb is the fallback when native is empty (legacy rows
  // pre-059 backfill, or fields these billing writers don't manage).
  const inner = (data.data || {}) as Record<string, any>;
  return {
    ...inner,
    venueName:      data.venue_name      ?? inner.venueName      ?? inner.name,
    description:    data.description     ?? inner.description,
    venueType:      data.venue_type      ?? inner.venueType      ?? inner.type,
    address:        data.address         ?? inner.address,
    city:           data.city            ?? inner.city,
    country:        data.country         ?? inner.country,
    capacity:       data.capacity        ?? inner.capacity,
    logoUrl:        data.logo_url        ?? inner.logoUrl,
    coverImageUrl:  data.cover_image_url ?? inner.coverImageUrl  ?? inner.coverUrl,
    genres:         (Array.isArray(data.genres) && data.genres.length > 0)
                      ? data.genres : (inner.genres || []),
    socialLinks:    (data.social_links && Object.keys(data.social_links).length > 0)
                      ? data.social_links : (inner.socialLinks || {}),
    workingHours:   data.working_hours   ?? inner.workingHours,
    isVerified:     data.is_verified     ?? inner.isVerified     ?? false,
    email:          data.email           ?? inner.email,
    phone:          data.phone           ?? inner.phone,
    // Migration 062 verification request/approve state. Surface as ISO
    // strings so the frontend status block (mirrors artist's pattern
    // in settings-page.tsx:1370) can render Pending/Approved/Rejected.
    verificationRequestedAt:     isoOrNullVerif(data.verification_requested_at),
    verificationApprovedAt:      isoOrNullVerif(data.verification_approved_at),
    verificationRejectionReason: data.verification_rejection_reason ?? null,
  };
}

// Shared helper for the three role overlays (venue/radio/producer) —
// converts a Postgres TIMESTAMPTZ value to an ISO string when present.
// Lives near upsertVenueProfile so the venue / radio / producer
// projectors can use it. Returns null for both NULL and missing keys.
function isoOrNullVerif(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export async function upsertVenueProfile(userId: string, profile: Record<string, any>) {
  // ЗЕРКАЛО фикса 8652379 (upsertDjProfile): не пинаем `id` (PK
  // auto-uuid), а ресолвим conflict по UNIQUE(user_id). Иначе если
  // existing строка имеет id ≠ userId — UPSERT идёт в INSERT path,
  // UNIQUE на user_id ловит дубль, ошибка тихо логируется.
  // Migration 027 добавляет UNIQUE индекс на user_id.
  //
  // Migration 059 promoted 12 fields from `data` jsonb to native
  // columns — extract them here. Mirrors upsertDjProfile (db.tsx:1134)
  // shape. `data: profile` is preserved for backward compat with
  // billing-side updaters that read/write the whole envelope.
  const row = {
    user_id:         userId,
    venue_name:      profile.venueName      ?? profile.name      ?? null,
    description:     profile.description    ?? null,
    venue_type:      profile.venueType      ?? profile.type      ?? null,
    address:         profile.address        ?? null,
    city:            profile.city           ?? null,
    country:         profile.country        ?? null,
    capacity:        profile.capacity       ?? null,
    logo_url:        profile.logoUrl        ?? null,
    cover_image_url: profile.coverImageUrl  ?? profile.coverUrl  ?? null,
    genres:          Array.isArray(profile.genres) ? profile.genres : [],
    social_links:    (profile.socialLinks && typeof profile.socialLinks === 'object')
                       ? profile.socialLinks : {},
    working_hours:   profile.workingHours   ?? null,
    data:            profile,
    updated_at:      new Date().toISOString(),
  };
  const { error } = await db()
    .from('venue_profiles')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertVenueProfile:', error);
}

// ─── Radio Profiles ───

export async function getRadioProfile(userId: string) {
  const { data, error } = await db()
    .from('radio_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getRadioProfile:', error);
  if (!data) return null;

  // Overlay native columns (migration 060) on top of legacy `data` jsonb.
  // After 060, native columns are source-of-truth for the 17 promoted
  // fields when populated; jsonb fallback covers legacy rows pre-060
  // backfill, plus stats fields (tracksInRotation, partners, revenue,
  // ...) which are managed by radio_stats helpers and never get native
  // columns.
  const inner = (data.data || {}) as Record<string, any>;
  return {
    ...inner,
    name:             data.name              ?? inner.name,
    city:             data.city              ?? inner.city,
    country:          data.country           ?? inner.country,
    frequency:        data.frequency         ?? inner.frequency,
    description:      data.description       ?? inner.description,
    founded:          data.founded           ?? inner.founded,
    website:          data.website           ?? inner.website,
    address:          data.address           ?? inner.address,
    streamUrl:        data.stream_url        ?? inner.streamUrl,
    backupStreamUrl:  data.backup_stream_url ?? inner.backupStreamUrl,
    bitrate:          data.bitrate           ?? inner.bitrate,
    audioFormat:      data.audio_format      ?? inner.audioFormat,
    listeners:        data.listeners         ?? inner.listeners,
    status:           data.status            ?? inner.status,
    broadcast_cities: (Array.isArray(data.broadcast_cities) && data.broadcast_cities.length > 0)
                        ? data.broadcast_cities : (inner.broadcast_cities || []),
    formats:          (Array.isArray(data.formats) && data.formats.length > 0)
                        ? data.formats : (inner.formats || []),
    socials:          (data.socials && Object.keys(data.socials).length > 0)
                        ? data.socials : (inner.socials || {}),
    logoUrl:          data.logo_url          ?? inner.logoUrl,
    coverUrl:         data.cover_url         ?? inner.coverUrl,
    isVerified:       data.is_verified       ?? inner.isVerified ?? false,
    email:            data.email             ?? inner.email,
    phone:            data.phone             ?? inner.phone,
    // Migration 062 verification state — see isoOrNullVerif above.
    verificationRequestedAt:     isoOrNullVerif(data.verification_requested_at),
    verificationApprovedAt:      isoOrNullVerif(data.verification_approved_at),
    verificationRejectionReason: data.verification_rejection_reason ?? null,
  };
}

export async function upsertRadioProfile(userId: string, profile: Record<string, any>) {
  // Зеркало фикса 8652379 — см. upsertVenueProfile выше.
  // Migration 027 добавляет UNIQUE на user_id.
  //
  // Migration 060 promoted 17 fields from `data` jsonb to native
  // columns — extract them here. Mirrors upsertVenueProfile / 059
  // pattern. `data: profile` is preserved for backward compat with
  // stats writers and editor-rehydration flow.
  //
  // Accept both camelCase (frontend payload) and snake_case (legacy
  // KV-roundtrip via getRadioProfile) for stream URLs / audio format.
  // broadcast_cities is snake_case on the wire already.
  const row = {
    user_id:           userId,
    name:              profile.name ?? null,
    city:              profile.city ?? null,
    country:           profile.country ?? null,
    frequency:         profile.frequency ?? null,
    description:       profile.description ?? null,
    founded:           profile.founded ?? null,
    website:           profile.website ?? null,
    address:           profile.address ?? null,
    stream_url:        profile.streamUrl       ?? profile.stream_url        ?? null,
    backup_stream_url: profile.backupStreamUrl ?? profile.backup_stream_url ?? null,
    bitrate:           profile.bitrate ?? null,
    audio_format:      profile.audioFormat ?? profile.audio_format ?? null,
    listeners:         profile.listeners != null ? String(profile.listeners) : null,
    status:            profile.status ?? null,
    broadcast_cities:  Array.isArray(profile.broadcast_cities)
                         ? profile.broadcast_cities
                         : (Array.isArray(profile.broadcastCities) ? profile.broadcastCities : []),
    formats:           Array.isArray(profile.formats) ? profile.formats : [],
    socials:           (profile.socials && typeof profile.socials === 'object')
                         ? profile.socials : {},
    logo_url:          profile.logoUrl  ?? profile.logo_url  ?? null,
    cover_url:         profile.coverUrl ?? profile.cover_url ?? null,
    data:              profile,
    updated_at:        new Date().toISOString(),
  };
  const { error } = await db()
    .from('radio_profiles')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertRadioProfile:', error);
}

// ─── Producer Profiles ───

/**
 * Overlay helper — projects a raw producer_profiles row (post-061) into
 * the camelCase shape that callers expect. Native columns take priority
 * when populated; jsonb fallback covers legacy rows pre-061 backfill
 * and any field not promoted (specializations, averageRating, services,
 * portfolio, ...).
 */
function projectProducerProfileRow(data: any) {
  if (!data) return null;
  const inner = (data.data || {}) as Record<string, any>;
  return {
    ...inner,
    name:           data.name            ?? inner.name,
    city:           data.city            ?? inner.city,
    bio:            data.bio             ?? inner.bio,
    workPhilosophy: data.work_philosophy ?? inner.workPhilosophy,
    avatarUrl:      data.avatar_url      ?? inner.avatarUrl,
    coverUrl:       data.cover_url       ?? inner.coverUrl,
    email:          data.email           ?? inner.email,
    phone:          data.phone           ?? inner.phone,
    // Migration 062 — verification state. is_verified column itself
    // was also added in 062 (producer never had it before).
    isVerified:                  data.is_verified ?? inner.isVerified ?? false,
    verificationRequestedAt:     isoOrNullVerif(data.verification_requested_at),
    verificationApprovedAt:      isoOrNullVerif(data.verification_approved_at),
    verificationRejectionReason: data.verification_rejection_reason ?? null,
  };
}

export async function getProducerProfile(userId: string) {
  const { data, error } = await db()
    .from('producer_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getProducerProfile:', error);
  return projectProducerProfileRow(data);
}

export async function upsertProducerProfile(userId: string, profile: Record<string, any>) {
  // Зеркало фикса 8652379 — см. upsertVenueProfile выше.
  // Migration 027 добавляет UNIQUE на user_id.
  //
  // Migration 061 promoted 6 fields from `data` jsonb to native
  // columns. Mirrors upsertVenueProfile (059) / upsertRadioProfile
  // (060). `data: profile` preserved for backward compat — callers
  // like persistProducerImage() build up `data` shape with extra
  // fields (specializations, services links, ...) that aren't yet
  // promoted to native columns.
  const row = {
    user_id:         userId,
    name:            profile.name ?? null,
    city:            profile.city ?? null,
    bio:             profile.bio ?? null,
    work_philosophy: profile.workPhilosophy ?? profile.work_philosophy ?? null,
    avatar_url:      profile.avatarUrl ?? profile.avatar_url ?? null,
    cover_url:       profile.coverUrl ?? profile.cover_url ?? null,
    data:            profile,
    updated_at:      new Date().toISOString(),
  };
  const { error } = await db()
    .from('producer_profiles')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertProducerProfile:', error);
}

export async function getAllProducerProfiles() {
  const { data, error } = await db()
    .from('producer_profiles')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) console.error('[db] getAllProducerProfiles:', error);
  // Same projection as getProducerProfile so cross-cabinet listings
  // (landing-data-routes:1262) see native columns over stale jsonb.
  return (data || []).map((r: any) => projectProducerProfileRow(r));
}

// ─── Engineer Profiles ─── (migration 025)

export async function getEngineerProfile(userId: string) {
  const { data, error } = await db()
    .from('engineer_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getEngineerProfile:', error);
  return data ? (data.data || data) : null;
}

export async function upsertEngineerProfile(userId: string, profile: Record<string, any>) {
  // Source-of-truth shape from the engineer profile editor is NESTED
  // (mirrors DJ/producer):
  //
  //   { profile: { fullName, bio, avatarUrl, specializations, ... },
  //     services: [...], portfolio: [...], … }
  //
  // POST /engineer/profile/avatar и /cover пишут именно в
  // nested `data.profile.avatarUrl`. Денормализуем верхнеуровневые
  // колонки чтобы public-маркетплейс мог фильтровать без распаковки
  // jsonb (тот же паттерн что у upsertDjProfile / upsertProducerProfile).
  const inner: Record<string, any> = (profile?.profile && typeof profile.profile === 'object')
    ? { ...profile, ...profile.profile }
    : profile;

  const row: Record<string, any> = {
    user_id: userId,
    full_name: inner.fullName || inner.full_name || inner.name || null,
    city: inner.city || null,
    country: inner.country || null,
    avatar_url: inner.avatarUrl || inner.avatar_url || null,
    cover_url: inner.coverUrl || inner.cover_url || null,
    bio: inner.bio || inner.about || null,
    specializations: inner.specializations || inner.tags || [],
    hourly_rate: inner.hourlyRate || inner.hourly_rate || 0,
    is_available: inner.isAvailable !== undefined
      ? inner.isAvailable
      : (inner.openForOrders !== undefined ? inner.openForOrders : true),
    // E-mail notification toggles (миграция 105). Денорм-колонки чтобы
    // emit-точка читала фаст без jsonb-распаковки. JSON-bool→pg-bool
    // через `!== false` — undefined даёт TRUE (default for new profiles).
    notify_email_on_new_order: inner.notifyEmailOnNewOrder !== false,
    notify_email_on_paid:      inner.notifyEmailOnPaid !== false,
    data: profile,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('engineer_profiles')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertEngineerProfile:', error);
}

export async function getAllEngineerProfiles() {
  const { data, error } = await db()
    .from('engineer_profiles')
    .select('*')
    .eq('is_available', true)
    .order('rating', { ascending: false });
  if (error) console.error('[db] getAllEngineerProfiles:', error);
  return (data || []).map((r: any) => r.data || r);
}

// ─── Collaboration ───
// Native row-per-offer schema since migration 064. См.
// listCollabOffersByArtist / listCollabOffersByProducer / upsertCollabOffer
// ниже (new typed factory functions).

// ─── Content Orders ───

export async function getContentOrders(filters?: { userId?: string; venueId?: string }) {
  let q = db().from('content_orders').select('*').order('created_at', { ascending: false });
  if (filters?.userId) q = q.eq('user_id', filters.userId);
  if (filters?.venueId) q = q.eq('venue_id', filters.venueId);
  const { data, error } = await q;
  if (error) console.error('[db] getContentOrders:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function upsertContentOrder(orderId: string, order: Record<string, any>) {
  const row = {
    id: orderId,
    data: order,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('content_orders')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertContentOrder:', error);
}

// ─── Email Campaigns (notifications) ───

export async function getEmailCampaigns(artistId: string) {
  const { data, error } = await db()
    .from('email_campaigns')
    .select('*')
    .eq('artist_id', artistId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getEmailCampaigns:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function upsertEmailCampaign(campaignId: string, campaign: Record<string, any>) {
  const row = {
    id: campaignId,
    data: campaign,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('email_campaigns')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertEmailCampaign:', error);
}

// ─── Auth Tokens ───

export async function getAuthToken(key: string) {
  const { data, error } = await db()
    .from('auth_tokens')
    .select('*')
    .eq('id', key)
    .maybeSingle();
  if (error) console.error('[db] getAuthToken:', error);
  return data ? (data.data || data) : null;
}

export async function setAuthToken(key: string, token: Record<string, any>) {
  const row = {
    id: key,
    data: token,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('auth_tokens')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] setAuthToken:', error);
}

export async function deleteAuthToken(key: string) {
  const { error } = await db()
    .from('auth_tokens')
    .delete()
    .eq('id', key);
  if (error) console.error('[db] deleteAuthToken:', error);
}

// ─── Sessions (active logins) ───

export async function getUserSessions(userId: string) {
  const { data, error } = await db()
    .from('user_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getUserSessions:', error);
  return (data || []).map((r: any) => r.data || r);
}

// ─── Payment Methods ───

export async function getPaymentMethods(userId: string) {
  const { data, error } = await db()
    .from('payment_methods')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getPaymentMethods:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function upsertPaymentMethod(methodId: string, userId: string, method: Record<string, any>) {
  const row = {
    id: methodId,
    user_id: userId,
    data: method,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('payment_methods')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertPaymentMethod:', error);
}

export async function deletePaymentMethod(methodId: string) {
  const { error } = await db()
    .from('payment_methods')
    .delete()
    .eq('id', methodId);
  if (error) console.error('[db] deletePaymentMethod:', error);
}

// ─── Generic Store Helper ───
// Uses 'data' JSONB column for storage. Tables must have: pk, data JSONB, created_at, updated_at.
// get()/getAll() return the data field or the full row if no data column.


// ─── Payment Transactions (SQL-based, replaces KV store) ───

export async function insertPaymentTx(tx: {
  id: string; userId: string; orderId?: string; type: string; category: string;
  amount: number; currency?: string; gateway?: string; description?: string;
  metadata?: any; status?: string; createdAt?: string;
}) {
  const { error } = await db().from('payment_txns').upsert({
    id: tx.id,
    user_id: tx.userId,
    order_id: tx.orderId || null,
    type: tx.type,
    category: tx.category,
    amount: tx.amount,
    currency: tx.currency || 'RUB',
    gateway: tx.gateway || null,
    description: tx.description || null,
    metadata: tx.metadata ? JSON.stringify(tx.metadata) : '{}',
    status: tx.status || 'completed',
    created_at: tx.createdAt || new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) console.error('[db] insertPaymentTx:', error);
}

export async function getPaymentTxsByUser(userId: string, filters?: {
  type?: string; category?: string; status?: string; search?: string;
  limit?: number; offset?: number;
}): Promise<any[]> {
  let q = db().from('payment_txns').select('*').eq('user_id', userId);
  if (filters?.type) q = q.eq('type', filters.type);
  if (filters?.category) q = q.eq('category', filters.category);
  if (filters?.status) q = q.eq('status', filters.status);
  if (filters?.search) q = q.ilike('description', '%' + filters.search + '%');
  q = q.order('created_at', { ascending: false });
  if (filters?.limit) q = q.limit(filters.limit);
  if (filters?.offset) q = q.range(filters.offset, (filters.offset || 0) + (filters.limit || 50) - 1);
  const { data, error } = await q;
  if (error) console.error('[db] getPaymentTxsByUser:', error);
  return (data || []).map((r: any) => ({
    id: r.id, userId: r.user_id, orderId: r.order_id, type: r.type,
    category: r.category, amount: Number(r.amount), currency: r.currency,
    gateway: r.gateway, description: r.description,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}),
    status: r.status, createdAt: r.created_at,
  }));
}

export async function getAllPaymentTxs(filters?: {
  type?: string; category?: string; status?: string; search?: string;
  limit?: number; offset?: number;
}): Promise<{ txs: any[]; total: number }> {
  // Audit 2026-06-01: переписано на реальную payment_transactions (там
  // INSERT'ятся комиссии, выплаты, подписки через recordRevenue/checkout).
  // Раньше читалась payment_txns — мёртвая таблица без writers → admin
  // /Финансы/Транзакции всегда пустые, моки.
  //
  // JOIN с users для name/email — раньше name=userId (UUID-показывалось).
  // metadata.userName/userAvatar чтобы admin сразу видел.
  const { pool } = await import('./db-client.tsx');

  // tx_type в БД маппится на FE-type: commission→commission, deposit→income,
  // withdrawal→withdrawal, refund→refund.
  const TYPE_MAP_INVERSE: Record<string, string[]> = {
    income:      ['deposit', 'topup', 'donation'],
    commission:  ['commission'],
    withdrawal:  ['withdrawal'],
    refund:      ['refund'],
    expense:     ['expense', 'payout'],
  };

  const conds: string[] = [];
  const vals: any[] = [];
  if (filters?.type) {
    const mapped = TYPE_MAP_INVERSE[filters.type] || [filters.type];
    vals.push(mapped);
    conds.push(`pt.tx_type = ANY($${vals.length}::text[])`);
  }
  if (filters?.category) {
    vals.push(filters.category);
    conds.push(`pt.category = $${vals.length}`);
  }
  if (filters?.status) {
    vals.push(filters.status);
    conds.push(`pt.status = $${vals.length}`);
  }
  if (filters?.search) {
    vals.push('%' + filters.search + '%');
    conds.push(`(pt.description ILIKE $${vals.length} OR u.email ILIKE $${vals.length} OR u.full_name ILIKE $${vals.length})`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payment_transactions pt
       LEFT JOIN users u ON u.id::text = pt.user_id ${where}`,
    vals
  );

  const lim = Math.min(filters?.limit || 100, 500);
  const off = filters?.offset || 0;
  vals.push(lim, off);
  const dataRes = await pool.query(
    `SELECT pt.app_id        AS id,
            pt.user_id       AS user_id,
            pt.tx_type       AS tx_type,
            pt.category      AS category,
            pt.amount        AS amount,
            pt.currency      AS currency,
            pt.status        AS status,
            pt.description   AS description,
            pt.metadata      AS metadata,
            pt.created_at    AS created_at,
            COALESCE(u.full_name, u.email, pt.user_id) AS user_name,
            u.email          AS user_email,
            u.avatar_url     AS user_avatar
       FROM payment_transactions pt
       LEFT JOIN users u ON u.id::text = pt.user_id
       ${where}
       ORDER BY pt.created_at DESC
       LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );

  // Map tx_type → FE type. 'commission' / 'deposit' / 'topup' / 'donation' →
  // 'income' для UI группировки (но сохраняем оригинал в metadata).
  const TYPE_TO_FE: Record<string, string> = {
    deposit:    'income',
    topup:      'income',
    donation:   'income',
    commission: 'commission',
    withdrawal: 'withdrawal',
    refund:     'refund',
    expense:    'expense',
    payout:     'expense',
  };

  const txs = dataRes.rows.map((r: any) => {
    const meta = typeof r.metadata === 'string'
      ? (() => { try { return JSON.parse(r.metadata); } catch { return {}; } })()
      : (r.metadata || {});
    return {
      id: r.id,
      userId: r.user_id,
      orderId: meta.orderId || null,
      type: TYPE_TO_FE[r.tx_type] || r.tx_type || 'income',
      category: r.category || 'subscription',
      amount: Number(r.amount) || 0,
      currency: r.currency || 'RUB',
      gateway: meta.gateway || null,
      description: r.description || '',
      status: r.status || 'completed',
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      metadata: {
        ...meta,
        userName: r.user_name,
        userEmail: r.user_email,
        userAvatar: r.user_avatar,
        originalTxType: r.tx_type,
      },
    };
  });

  return { txs, total: countRes.rows[0]?.n || 0 };
}

export async function getPaymentTxStats(): Promise<{
  totalIncome: number; totalExpense: number; totalRefund: number; netBalance: number;
  transactionCount: number; pendingCount: number;
  categoryBreakdown: { category: string; total: number }[];
  monthlyTrend: { month: string; income: number; expense: number; net: number }[];
}> {
  // Audit 2026-06-01: SQL-aggregation из реальной payment_transactions.
  // Раньше читалась payment_txns — пустая мёртвая таблица.
  const { pool } = await import('./db-client.tsx');

  const totalsRes = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (
         WHERE tx_type IN ('deposit','topup','donation','commission') AND status='completed'
       ), 0)::numeric AS total_income,
       COALESCE(SUM(amount) FILTER (
         WHERE tx_type IN ('withdrawal','expense','payout') AND status='completed'
       ), 0)::numeric AS total_expense,
       COALESCE(SUM(amount) FILTER (
         WHERE tx_type='refund' AND status='completed'
       ), 0)::numeric AS total_refund,
       COUNT(*)::int AS tx_count,
       COUNT(*) FILTER (WHERE status='pending')::int AS pending_count
     FROM payment_transactions`
  );
  const t = totalsRes.rows[0];

  const catRes = await pool.query(
    `SELECT COALESCE(category, 'other') AS category,
            COALESCE(SUM(amount), 0)::numeric AS total
       FROM payment_transactions
      WHERE status='completed'
      GROUP BY category
      ORDER BY total DESC`
  );

  // monthlyTrend: последние 6 месяцев. date_trunc + generate_series для
  // нулевых месяцев тоже (иначе пропуски в графике).
  const trendRes = await pool.query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', NOW() - INTERVAL '5 months'),
         date_trunc('month', NOW()),
         INTERVAL '1 month'
       ) AS m
     )
     SELECT to_char(months.m, 'YYYY-MM') AS month,
            COALESCE(SUM(pt.amount) FILTER (
              WHERE pt.tx_type IN ('deposit','topup','donation','commission') AND pt.status='completed'
            ), 0)::numeric AS income,
            COALESCE(SUM(pt.amount) FILTER (
              WHERE pt.tx_type IN ('withdrawal','expense','payout') AND pt.status='completed'
            ), 0)::numeric AS expense
       FROM months
       LEFT JOIN payment_transactions pt
              ON date_trunc('month', pt.created_at) = months.m
      GROUP BY months.m
      ORDER BY months.m`
  );

  const totalIncome = Number(t.total_income) || 0;
  const totalExpense = Number(t.total_expense) || 0;
  const totalRefund = Number(t.total_refund) || 0;

  return {
    totalIncome,
    totalExpense,
    totalRefund,
    netBalance: totalIncome - totalExpense - totalRefund,
    transactionCount: Number(t.tx_count) || 0,
    pendingCount: Number(t.pending_count) || 0,
    categoryBreakdown: catRes.rows.map((r: any) => ({
      category: r.category,
      total: Number(r.total) || 0,
    })),
    monthlyTrend: trendRes.rows.map((r: any) => {
      const income = Number(r.income) || 0;
      const expense = Number(r.expense) || 0;
      return { month: r.month, income, expense, net: income - expense };
    }),
  };
}

export async function getPaymentTxUserSummaries(): Promise<any[]> {
  // Audit 2026-06-01: JOIN с users для имени/email + читаем реальную
  // payment_transactions + payment_balances. Раньше:
  //   - читалась мёртвая payment_txns (всегда пусто)
  //   - name = userId (UUID показывалось как имя)
  //   - email = '' (пусто)
  //   - balance = totalEarned - totalSpent (не реальный wallet balance)
  //
  // Сейчас: balance из payment_balances (где сидят реальные balances
  // продюсеров/DJ/радио после ledger-update в recordRevenue + milestone
  // approve).
  const { pool } = await import('./db-client.tsx');

  const rows = (await pool.query(
    `SELECT
       u.id::text                                    AS id,
       COALESCE(NULLIF(u.full_name, ''), u.email, u.id::text) AS name,
       u.email                                       AS email,
       u.avatar_url                                  AS avatar,
       u.role::text                                  AS role,
       u.status::text                                AS user_status,
       COALESCE(pb.available, 0)::numeric            AS balance,
       COALESCE(spent.total, 0)::numeric             AS total_spent,
       COALESCE(earned.total, 0)::numeric            AS total_earned,
       COALESCE(tx_count.cnt, 0)::int                AS tx_count,
       last_tx.last_at                               AS last_tx_at
     FROM users u
     LEFT JOIN payment_balances pb
            ON pb.user_id = u.id::text
     LEFT JOIN LATERAL (
       SELECT SUM(amount) AS total
         FROM payment_transactions
        WHERE user_id = u.id::text AND status='completed'
          AND tx_type IN ('withdrawal','expense','payout')
     ) spent ON TRUE
     LEFT JOIN LATERAL (
       SELECT SUM(amount) AS total
         FROM payment_transactions
        WHERE user_id = u.id::text AND status='completed'
          AND tx_type IN ('deposit','topup','donation','commission')
     ) earned ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS cnt
         FROM payment_transactions
        WHERE user_id = u.id::text
     ) tx_count ON TRUE
     LEFT JOIN LATERAL (
       SELECT MAX(created_at) AS last_at
         FROM payment_transactions
        WHERE user_id = u.id::text
     ) last_tx ON TRUE
     WHERE u.deleted_at IS NULL
       AND (COALESCE(tx_count.cnt, 0) > 0 OR COALESCE(pb.available, 0) > 0)
     ORDER BY balance DESC, tx_count.cnt DESC NULLS LAST
     LIMIT 500`
  )).rows;

  return rows.map((r: any) => ({
    id: r.id,
    name: r.name || r.id,
    email: r.email || '',
    avatar: r.avatar || '',
    role: r.role || 'artist',
    balance: Number(r.balance) || 0,
    totalSpent: Number(r.total_spent) || 0,
    totalEarned: Number(r.total_earned) || 0,
    transactionsCount: Number(r.tx_count) || 0,
    lastTransaction: r.last_tx_at instanceof Date ? r.last_tx_at.toISOString() : r.last_tx_at,
    status: r.user_status === 'banned' ? 'blocked'
          : r.user_status === 'pending' ? 'pending'
          : 'active',
  }));
}


/**
 * jsonbStore — НЕ key-value хранилище. Это helper над таблицей
 * PostgreSQL с колонкой `data jsonb`. Все вызовы под капотом —
 * параметризованные SQL-запросы через `pg.Pool` (см. db-client.tsx).
 *
 * Никакого Redis, никакого Deno KV, никакого Upstash. Только
 * PostgreSQL 16 на собственном VPS — данные не покидают сервер,
 * полная поддержка ACID-транзакций, индексов, FK.
 *
 * Когда `jsonbStore(table, pk)` вызывается:
 *   store.get(id)  → `SELECT data FROM <table> WHERE <pk> = $1`
 *   store.set(id,v) → `INSERT … ON CONFLICT(<pk>) DO UPDATE`
 *   store.getAll() → `SELECT data FROM <table> ORDER BY created_at`
 *
 * Для ускорения частых JSONB-фильтров добавлять GIN-индексы:
 *   CREATE INDEX ON <table> USING gin ((data->'status'));
 * См. miграцию 031 для примеров.
 *
 * Когда переходить с jsonbStore на типизированные колонки:
 *  - нужны точные NUMERIC (деньги — нельзя в jsonb)
 *  - нужны FK-constraint'ы (целостность ссылок)
 *  - нужны JOIN'ы на другие таблицы по часто-фильтруемому полю
 * Пример уже сделанной миграции — таблица `tracks` (db-typed.tsx).
 */
// ─── Typed store factories (replace legacy jsonbStore wrapper) ─────────
//
// `jsonbStore()` was DELETED in this PR (re-rebased #75). All callers
// converted to typed factories below. They use pool.query directly
// (no `db()` supabase wrapper) and preserve the legacy `.get/.set/.del
// /.getAll/.getByCol` API — handler call sites don't change.
//
// Three flavours, picked by table shape:
//   makeUserSingletonStore('foo')        — 1 row per user_id (per-user
//                                          singleton config). Pins
//                                          pkCol='user_id' so callers
//                                          read like `store.get(userId)`.
//   makeJsonbKeyStore('foo')             — 1 row per `id` (general
//                                          id→object mapping). Default
//                                          for tables whose PK is `id`.
//   makeJsonbKeyStore('foo', 'foo_id')   — 1 row per custom PK column.
//   makeJsonbIndexStore('foo', 'foo_id') — alias of makeJsonbKeyStore
//                                          with explicit pkCol — makes
//                                          per-X-index intent obvious
//                                          (X array refs inside data).
//
// `paymentBalancesStore` is a SPECIAL CASE: payment_balances has native
// cols (available, pending, total), NOT `data jsonb`. Restored as a
// hand-rolled wrapper reading/writing native cols — see below.

function makeUserSingletonStore(table: string) {
  return makeJsonbKeyStore(table, 'user_id');
}

function makeJsonbKeyStore(table: string, pkCol: string = 'id') {
  return {
    async get(id: string): Promise<any | null> {
      const { pool } = await import('./db-client.tsx');
      const r = await pool.query(
        `SELECT data FROM ${table} WHERE ${pkCol} = $1 LIMIT 1`,
        [id]
      );
      if (!r.rowCount) return null;
      const d = r.rows[0].data;
      return typeof d === 'string' ? JSON.parse(d) : (d ?? null);
    },
    async set(id: string, value: any, extra?: Record<string, any>): Promise<void> {
      const { pool } = await import('./db-client.tsx');
      const normalized = typeof value === 'string'
        ? (() => { try { return JSON.parse(value); } catch { return value; } })()
        : value;
      if (!extra || Object.keys(extra).length === 0) {
        await pool.query(
          `INSERT INTO ${table} (${pkCol}, data, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (${pkCol}) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [id, JSON.stringify(normalized)]
        );
        return;
      }
      const extraKeys = Object.keys(extra);
      const safeKeys = extraKeys.filter(k => /^[a-z_][a-z0-9_]*$/i.test(k));
      const cols = [pkCol, 'data', 'updated_at', ...safeKeys].join(', ');
      const vals: any[] = [id, JSON.stringify(normalized), new Date().toISOString(), ...safeKeys.map(k => extra[k])];
      const placeholders = vals.map((_, i) => i === 1 ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
      const updateSet = ['data = EXCLUDED.data', 'updated_at = EXCLUDED.updated_at',
        ...safeKeys.map(k => `${k} = EXCLUDED.${k}`)].join(', ');
      await pool.query(
        `INSERT INTO ${table} (${cols}) VALUES (${placeholders})
         ON CONFLICT (${pkCol}) DO UPDATE SET ${updateSet}`,
        vals
      );
    },
    async del(id: string): Promise<void> {
      const { pool } = await import('./db-client.tsx');
      await pool.query(`DELETE FROM ${table} WHERE ${pkCol} = $1`, [id]);
    },
    async getAll(): Promise<any[]> {
      const { pool } = await import('./db-client.tsx');
      const r = await pool.query(
        `SELECT data FROM ${table} ORDER BY created_at DESC`
      );
      return r.rows.map((row: any) => {
        const d = row.data;
        return typeof d === 'string' ? JSON.parse(d) : d;
      });
    },
    async getByCol(column: string, value: string): Promise<any[]> {
      const { pool } = await import('./db-client.tsx');
      if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
        console.error(`[db] ${table}.getByCol: unsafe column "${column}"`);
        return [];
      }
      const r = await pool.query(
        `SELECT data FROM ${table} WHERE ${column} = $1 ORDER BY created_at DESC`,
        [value]
      );
      return r.rows.map((row: any) => {
        const d = row.data;
        return typeof d === 'string' ? JSON.parse(d) : d;
      });
    },
  };
}

function makeJsonbIndexStore(table: string, pkCol: string) {
  return makeJsonbKeyStore(table, pkCol);
}

// ─── track_test_requests native-cols store (migration 051) ───

const TRACK_TEST_REQUEST_COLS = `id, user_id, track_id, guest_email, guest_name,
  guest_track_url, guest_cover_url, track_title, artist_name, genre,
  status, payment_status, payment_amount, payment_transaction_id,
  required_expert_count, completed_reviews_count, average_rating,
  assigned_experts, category_averages, final_analysis,
  consolidated_feedback, consolidated_recommendations,
  admin_approval_status, moderation_notes, rejection_reason,
  feedback_sent_date, completed_at, created_at, updated_at`;

function mapTrackTestRequestRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    user_id: r.user_id,
    track_id: r.track_id,
    guest_email: r.guest_email,
    guest_name: r.guest_name,
    guest_track_url: r.guest_track_url,
    guest_cover_url: r.guest_cover_url,
    track_title: r.track_title || '',
    artist_name: r.artist_name || '',
    genre: r.genre,
    status: r.status,
    payment_status: r.payment_status,
    payment_amount: Number(r.payment_amount || 0),
    payment_transaction_id: r.payment_transaction_id,
    required_expert_count: Number(r.required_expert_count || 5),
    completed_reviews_count: Number(r.completed_reviews_count || 0),
    average_rating: r.average_rating !== null && r.average_rating !== undefined ? Number(r.average_rating) : undefined,
    assigned_experts: r.assigned_experts || [],
    category_averages: r.category_averages || undefined,
    final_analysis: r.final_analysis || undefined,
    consolidated_feedback: r.consolidated_feedback || undefined,
    consolidated_recommendations: r.consolidated_recommendations || undefined,
    admin_approval_status: r.admin_approval_status || undefined,
    moderation_notes: r.moderation_notes || undefined,
    rejection_reason: r.rejection_reason || undefined,
    feedback_sent_date: iso(r.feedback_sent_date) || undefined,
    completed_at: iso(r.completed_at) || undefined,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function makeTrackTestRequestsStore() {
  return {
    async get(id: string): Promise<any | null> {
      const { pool } = await import('./db-client.tsx');
      const r = await pool.query(
        `SELECT ${TRACK_TEST_REQUEST_COLS} FROM track_test_requests WHERE id = $1 LIMIT 1`,
        [id]
      );
      return r.rowCount ? mapTrackTestRequestRow(r.rows[0]) : null;
    },
    async set(id: string, value: any): Promise<void> {
      const { pool } = await import('./db-client.tsx');
      const assigned = Array.isArray(value.assigned_experts) ? value.assigned_experts : [];
      const catAvg = value.category_averages && typeof value.category_averages === 'object' ? value.category_averages : {};
      await pool.query(
        `INSERT INTO track_test_requests (
           id, user_id, track_id, guest_email, guest_name,
           guest_track_url, guest_cover_url, track_title, artist_name, genre,
           status, payment_status, payment_amount, payment_transaction_id,
           required_expert_count, completed_reviews_count, average_rating,
           assigned_experts, category_averages, final_analysis,
           consolidated_feedback, consolidated_recommendations,
           admin_approval_status, moderation_notes, rejection_reason,
           feedback_sent_date, completed_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5,
                 $6, $7, $8, $9, $10,
                 $11, $12, $13, $14,
                 $15, $16, $17,
                 $18::jsonb, $19::jsonb, $20,
                 $21, $22,
                 $23, $24, $25,
                 $26, $27, NOW())
         ON CONFLICT (id) DO UPDATE SET
           user_id                      = COALESCE(EXCLUDED.user_id, track_test_requests.user_id),
           track_id                     = COALESCE(EXCLUDED.track_id, track_test_requests.track_id),
           guest_email                  = EXCLUDED.guest_email,
           guest_name                   = EXCLUDED.guest_name,
           guest_track_url              = EXCLUDED.guest_track_url,
           guest_cover_url              = EXCLUDED.guest_cover_url,
           track_title                  = EXCLUDED.track_title,
           artist_name                  = EXCLUDED.artist_name,
           genre                        = EXCLUDED.genre,
           status                       = EXCLUDED.status,
           payment_status               = EXCLUDED.payment_status,
           payment_amount               = EXCLUDED.payment_amount,
           payment_transaction_id       = EXCLUDED.payment_transaction_id,
           required_expert_count        = EXCLUDED.required_expert_count,
           completed_reviews_count      = EXCLUDED.completed_reviews_count,
           average_rating               = EXCLUDED.average_rating,
           assigned_experts             = EXCLUDED.assigned_experts,
           category_averages            = EXCLUDED.category_averages,
           final_analysis               = EXCLUDED.final_analysis,
           consolidated_feedback        = EXCLUDED.consolidated_feedback,
           consolidated_recommendations = EXCLUDED.consolidated_recommendations,
           admin_approval_status        = EXCLUDED.admin_approval_status,
           moderation_notes             = EXCLUDED.moderation_notes,
           rejection_reason             = EXCLUDED.rejection_reason,
           feedback_sent_date           = EXCLUDED.feedback_sent_date,
           completed_at                 = EXCLUDED.completed_at,
           updated_at                   = NOW()`,
        [
          id,
          value.user_id || null,
          value.track_id || null,
          value.guest_email || null,
          value.guest_name || null,
          value.guest_track_url || null,
          value.guest_cover_url || null,
          value.track_title || '',
          value.artist_name || '',
          value.genre || null,
          value.status || 'pending_payment',
          value.payment_status || 'pending',
          Number(value.payment_amount || 0),
          value.payment_transaction_id || null,
          Number(value.required_expert_count || 5),
          Number(value.completed_reviews_count || 0),
          value.average_rating !== undefined && value.average_rating !== null ? Number(value.average_rating) : null,
          JSON.stringify(assigned),
          JSON.stringify(catAvg),
          value.final_analysis || null,
          value.consolidated_feedback || null,
          value.consolidated_recommendations || null,
          value.admin_approval_status || null,
          value.moderation_notes || null,
          value.rejection_reason || null,
          value.feedback_sent_date || null,
          value.completed_at || null,
        ]
      );
    },
    async del(id: string): Promise<void> {
      const { pool } = await import('./db-client.tsx');
      await pool.query(`DELETE FROM track_test_requests WHERE id = $1`, [id]);
    },
    async getAll(): Promise<any[]> {
      const { pool } = await import('./db-client.tsx');
      const r = await pool.query(
        `SELECT ${TRACK_TEST_REQUEST_COLS} FROM track_test_requests
          ORDER BY created_at DESC`
      );
      return r.rows.map(mapTrackTestRequestRow);
    },
    async getByCol(column: string, value: string): Promise<any[]> {
      const { pool } = await import('./db-client.tsx');
      const allowed = new Set(['user_id', 'track_id', 'status', 'payment_status', 'payment_transaction_id']);
      if (!allowed.has(column)) {
        console.error(`[db] trackTestRequestsStore.getByCol: column "${column}" not allowed`);
        return [];
      }
      const r = await pool.query(
        `SELECT ${TRACK_TEST_REQUEST_COLS} FROM track_test_requests
          WHERE ${column} = $1
          ORDER BY created_at DESC`,
        [value]
      );
      return r.rows.map(mapTrackTestRequestRow);
    },
  };
}

// trackTestUserRequestsStore: legacy interface — .get(userId) → string[],
// .set(userId, ids) → store the per-user index array. После 051 это
// derived из track_test_requests.user_id, поэтому set/del = no-op.
function makeTrackTestUserRequestsView() {
  return {
    async get(userId: string): Promise<string[]> {
      const { pool } = await import('./db-client.tsx');
      const r = await pool.query(
        `SELECT id FROM track_test_requests
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId]
      );
      return r.rows.map((row: any) => row.id);
    },
    async set(_userId: string, _value: any): Promise<void> {
      // No-op: index derived from track_test_requests.user_id automatically.
    },
    async del(_userId: string): Promise<void> {
      // No-op: rows cleared via main store .del which removes by id.
    },
    async getAll(): Promise<string[]> {
      // Legacy interface returned all user-keys; not used after migration.
      return [];
    },
  };
}

// trackTestAllRequestsStore: legacy interface — .get('singleton') → string[]
// global index of all request ids. Тоже derived от now.
function makeTrackTestAllRequestsView() {
  return {
    async get(_key: string): Promise<string[]> {
      const { pool } = await import('./db-client.tsx');
      const r = await pool.query(
        `SELECT id FROM track_test_requests ORDER BY created_at DESC`
      );
      return r.rows.map((row: any) => row.id);
    },
    async set(_key: string, _value: any): Promise<void> {
      // No-op: derived view.
    },
    async del(_key: string): Promise<void> {
      // No-op.
    },
    async getAll(): Promise<string[]> {
      return [];
    },
  };
}


// ─── radio_* row-per-request stores (migration 056) ───
//
// Все 3 store'а имеют легаси-интерфейс `.get(stationId) → array`,
// `.set(stationId, array) → void`. После migration 056 это row-per-item
// SQL таблицы. Чтобы handler'ы не переписывать, фабрика делает adapter:
//   .get  → SELECT ... WHERE radio_id = $1 ORDER BY created_at (or unshift'-style DESC)
//   .set  → transactional replace-all: UPSERT каждый item + DELETE
//           всех остальных rows для этого radio_id. Семантически
//           идентично legacy KV `.set` (overwrites whole array).

function mapArtistRequestRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    artistId: r.artist_id,
    artistName: r.artist_name,
    trackId: r.track_id,
    trackTitle: r.track_title,
    trackUrl: r.track_url,
    status: r.status,
    rejectionReason: r.rejection_reason,
    respondedAt: iso(r.responded_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.extra || {}),
  };
}

function normalizeArtistRequestForInsert(radioId: string, item: any): any[] {
  const id = item.id || `req-${cryptoRandomUUID()}`;
  const extra = { ...item };
  ['id','artistId','artistName','trackId','trackTitle','trackUrl','status',
   'rejectionReason','respondedAt','createdAt','updatedAt'].forEach(k => delete extra[k]);
  return [
    id, radioId,
    item.artistId || null, item.artistName || null,
    item.trackId || null, item.trackTitle || null, item.trackUrl || null,
    item.status || 'pending', item.rejectionReason || null,
    item.respondedAt || null,
    JSON.stringify(extra),
    item.createdAt || null,
  ];
}

function mapVenueRequestRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    venueId: r.venue_id,
    venueName: r.venue_name,
    venueCity: r.venue_city,
    campaignId: r.campaign_id,
    packageType: r.package_type,
    audioUrl: r.audio_url,
    startDate: iso(r.start_date),
    endDate: iso(r.end_date),
    targetPlays: Number(r.target_plays || 0),
    completedPlays: Number(r.completed_plays || 0),
    playsPerDay: Number(r.plays_per_day || 0),
    durationDays: Number(r.duration_days || 1),
    totalPrice: Number(r.total_price || 0),
    platformFee: Number(r.platform_fee || 0),
    stationPayout: Number(r.station_payout || 0),
    timeSlots: r.time_slots || [],
    status: r.status,
    rejectionReason: r.rejection_reason,
    approvedAt: iso(r.approved_at),
    reviewedAt: iso(r.reviewed_at),
    completedAt: iso(r.completed_at),
    submittedAt: iso(r.created_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.extra || {}),
  };
}

function normalizeVenueRequestForInsert(radioId: string, item: any): any[] {
  const id = item.id || `req-${cryptoRandomUUID()}`;
  const extra = { ...item };
  ['id','venueId','venueName','venueCity','campaignId','packageType','audioUrl',
   'startDate','endDate','targetPlays','completedPlays','playsPerDay','durationDays',
   'totalPrice','platformFee','stationPayout','timeSlots','status','rejectionReason',
   'approvedAt','reviewedAt','completedAt','submittedAt','createdAt','updatedAt'
  ].forEach(k => delete extra[k]);
  const timeSlots = Array.isArray(item.timeSlots) ? item.timeSlots : [];
  return [
    id, radioId,
    item.venueId || null, item.venueName || null, item.venueCity || null,
    item.campaignId || null, item.packageType || null, item.audioUrl || null,
    item.startDate || null, item.endDate || null,
    Number(item.targetPlays || 0), Number(item.completedPlays || 0),
    Number(item.playsPerDay || 0), Number(item.durationDays || 1),
    Number(item.totalPrice || 0), Number(item.platformFee || 0),
    Number(item.stationPayout || 0),
    JSON.stringify(timeSlots),
    item.status || 'pending', item.rejectionReason || null,
    item.approvedAt || null, item.reviewedAt || null, item.completedAt || null,
    JSON.stringify(extra),
    item.createdAt || item.submittedAt || null,
  ];
}

function mapRadioNotificationRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    type: r.notif_type,
    title: r.title,
    message: r.message,
    priority: r.priority,
    read: !!r.is_read,
    relatedId: r.related_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.extra || {}),
  };
}

function normalizeRadioNotificationForInsert(radioId: string, item: any): any[] {
  const id = item.id || `notif-${cryptoRandomUUID()}`;
  const extra = { ...item };
  ['id','type','title','message','priority','read','relatedId','createdAt','updatedAt']
    .forEach(k => delete extra[k]);
  return [
    id, radioId,
    item.type || null, item.title || null, item.message || null,
    item.priority || 'normal', !!item.read,
    item.relatedId || null,
    JSON.stringify(extra),
    item.createdAt || null,
  ];
}

function cryptoRandomUUID(): string {
  // Node 22 has globalThis.crypto.randomUUID
  return (globalThis as any).crypto?.randomUUID?.() ||
         `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface RadioRequestTableConfig {
  columns: string;       // column list для INSERT
  selectCols: string;    // column list для SELECT (порядок = аргументы mapper'а)
  orderBy: string;       // ORDER BY clause для .get
}

const RADIO_TABLE_CONFIG: Record<string, RadioRequestTableConfig> = {
  radio_artist_requests: {
    columns: `id, radio_id, artist_id, artist_name, track_id, track_title, track_url,
              status, rejection_reason, responded_at, extra, created_at`,
    selectCols: `id, radio_id, artist_id, artist_name, track_id, track_title, track_url,
                 status, rejection_reason, responded_at, extra, created_at, updated_at`,
    orderBy: `ORDER BY created_at DESC`,
  },
  radio_venue_requests: {
    columns: `id, radio_id, venue_id, venue_name, venue_city, campaign_id, package_type,
              audio_url, start_date, end_date, target_plays, completed_plays,
              plays_per_day, duration_days, total_price, platform_fee, station_payout,
              time_slots, status, rejection_reason, approved_at, reviewed_at, completed_at,
              extra, created_at`,
    selectCols: `id, radio_id, venue_id, venue_name, venue_city, campaign_id, package_type,
                 audio_url, start_date, end_date, target_plays, completed_plays,
                 plays_per_day, duration_days, total_price, platform_fee, station_payout,
                 time_slots, status, rejection_reason, approved_at, reviewed_at, completed_at,
                 extra, created_at, updated_at`,
    orderBy: `ORDER BY created_at DESC`,
  },
  radio_notifications: {
    columns: `id, radio_id, notif_type, title, message, priority, is_read, related_id, extra, created_at`,
    selectCols: `id, radio_id, notif_type, title, message, priority, is_read, related_id, extra, created_at, updated_at`,
    orderBy: `ORDER BY created_at DESC`,
  },
};

// Phase D KV→SQL closeout (2026-05-31): makeRadioRequestArrayStore удалён.
// Был KV-shaped facade над row-per-entity tables (mig 056). Все callsites
// заменены на explicit list helpers (listRadioArtistRequestsByStation,
// listRadioVenueRequestsByStation, listRadioNotificationsByStation) ниже,
// а write-path всегда был на native helpers (updateRadioArtistRequest,
// updateRadioVenueRequest, insertRadioVenueRequest, insertRadioNotification,
// markRadioNotificationRead, etc.) — race-free через миграцию 056.

// ─── Store instances for all tables ───

// beat_favorites — row-per-favorite native cols (migration 068).
// Store DELETED. Доступ — типизированные функции ниже.

export async function listBeatFavorites(userId: string): Promise<string[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT beat_id FROM beat_favorites
      WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows.map((row: any) => row.beat_id);
}

export async function toggleBeatFavorite(userId: string, beatId: string): Promise<{ added: boolean }> {
  // Atomic toggle через INSERT ON CONFLICT DO NOTHING + проверка rowCount.
  // Если 1 — INSERT прошёл (added). Иначе уже было — DELETE.
  const { pool } = await import('./db-client.tsx');
  const ins = await pool.query(
    `INSERT INTO beat_favorites (user_id, beat_id, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, beat_id) DO NOTHING`,
    [userId, beatId]
  );
  if (ins.rowCount && ins.rowCount > 0) {
    return { added: true };
  }
  // Уже было — DELETE.
  await pool.query(
    `DELETE FROM beat_favorites WHERE user_id = $1 AND beat_id = $2`,
    [userId, beatId]
  );
  return { added: false };
}

export async function countBeatFavoriters(beatId: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM beat_favorites WHERE beat_id = $1`,
    [beatId]
  );
  return Number(r.rows[0]?.n || 0);
}
// beat_reviews — native cols + UNIQUE (beat_id, user_id) since migration 066.
// beat_reviews_index DROPPED — derived через idx_beat_reviews_beat_created.
// 2 store wrappers DELETED. Доступ — getBeatReview / upsertBeatReview /
// listBeatReviewsByBeat / getBeatReviewsAggregateStats ниже.
// ─── contracts (native cols since migration 080) ───
// Milestone-based contracts for marketplace service orders. 1:1 с
// service_orders через UNIQUE(order_id). 6 callers в marketplace-routes.
// milestones остаётся jsonb (per-stage shape varies — legit nested).

export interface ContractMilestone {
  id: string;
  index: number;
  title: string;
  description?: string;
  amount: number;
  dueDate?: string | null;
  status: string;       // pending | in_progress | submitted | approved | revision
  paidAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContractRow {
  id: string;
  orderId: string;
  serviceTitle?: string | null;
  producerId?: string | null;
  producerName?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  totalAmount: number;
  paidAmount: number;
  status: string;
  milestones: ContractMilestone[];
  createdAt: string;
  completedAt?: string | null;
  updatedAt?: string | null;
}

function mapContractRow(r: any): ContractRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  const isoOrNull = (d: any) => d == null ? null : iso(d);
  return {
    id: r.id,
    orderId: r.order_id,
    serviceTitle: r.service_title,
    producerId: r.producer_id,
    producerName: r.producer_name,
    clientId: r.client_id,
    clientName: r.client_name,
    totalAmount: Number(r.total_amount || 0),
    paidAmount: Number(r.paid_amount || 0),
    status: r.status,
    milestones: Array.isArray(r.milestones) ? r.milestones : [],
    createdAt: iso(r.created_at),
    completedAt: isoOrNull(r.completed_at),
    updatedAt: isoOrNull(r.updated_at),
  };
}

const CONTRACT_COLS = `id, order_id, service_title, producer_id, producer_name,
  client_id, client_name, total_amount, paid_amount, status, milestones,
  created_at, completed_at, updated_at`;

export async function getContractByOrderId(orderId: string): Promise<ContractRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${CONTRACT_COLS} FROM contracts WHERE order_id = $1 LIMIT 1`,
    [orderId]
  );
  return mapContractRow(r.rows[0]);
}

export async function insertContract(c: ContractRow): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO contracts
       (id, order_id, service_title, producer_id, producer_name, client_id,
        client_name, total_amount, paid_amount, status, milestones,
        created_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
             COALESCE($12::timestamptz, NOW()), $13::timestamptz)`,
    [
      c.id, c.orderId, c.serviceTitle ?? null,
      c.producerId ?? null, c.producerName ?? null,
      c.clientId ?? null, c.clientName ?? null,
      c.totalAmount ?? 0, c.paidAmount ?? 0,
      c.status || 'active',
      JSON.stringify(c.milestones || []),
      c.createdAt ?? null, c.completedAt ?? null,
    ]
  );
}

/**
 * Update milestone(s) + paid_amount + status atomically by order_id.
 * Caller передаёт полный milestones array после mutation (т.к. milestones
 * остаются jsonb — row-per-milestone refactor scope больше этого PR'а).
 * Single UPDATE statement без read-modify-set race window.
 */
export async function updateContractByOrderId(
  orderId: string,
  patch: { milestones?: ContractMilestone[]; paidAmount?: number; status?: string; completedAt?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (patch.milestones !== undefined) {
    sets.push(`milestones = $${i++}::jsonb`); vals.push(JSON.stringify(patch.milestones));
  }
  if (patch.paidAmount !== undefined) {
    sets.push(`paid_amount = $${i++}`); vals.push(patch.paidAmount);
  }
  if (patch.status !== undefined) {
    sets.push(`status = $${i++}`); vals.push(patch.status);
  }
  if (patch.completedAt !== undefined) {
    sets.push(`completed_at = $${i++}::timestamptz`); vals.push(patch.completedAt);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = NOW()');
  vals.push(orderId);
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE contracts SET ${sets.join(', ')} WHERE order_id = $${i}`,
    vals
  );
}
// digital_goods — native cols since migration 075. Store removed,
// typed functions ниже (SQL filter + sort pushdown + atomic counters).
// 8 callers across marketplace-routes / checkout-routes / demo-seed.

export interface DigitalGood {
  id: string;
  title: string;
  producer: string;
  producerId: string;
  category: string;
  description: string;
  price: number;
  tags: string[];
  fileSize: string;
  format: string;
  rating: number;
  sales: number;
  views: number;
  status: string;
  createdAt: string;
  // Migration 097 — delivery (физический файл товара + preview).
  // file_url = '' (или null в БД) значит файл ещё не выложен; UI/checkout
  // показывают такой товар как «в подготовке», покупка блокирована.
  fileUrl?: string;
  fileBytes?: number;
  fileMime?: string;
  previewUrl?: string;
}

function mapDigitalGoodRow(r: any): DigitalGood | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    title: r.title,
    producer: r.producer,
    producerId: r.producer_id,
    category: r.category,
    description: r.description,
    price: Number(r.price),
    tags: r.tags || [],
    fileSize: r.file_size,
    format: r.format,
    rating: Number(r.rating),
    sales: Number(r.sales),
    views: Number(r.views),
    status: r.status,
    createdAt: iso(r.created_at),
    fileUrl: r.file_url || '',
    fileBytes: r.file_bytes != null ? Number(r.file_bytes) : undefined,
    fileMime: r.file_mime || '',
    previewUrl: r.preview_url || '',
  };
}

const DIGITAL_GOOD_COLS = `id, title, producer, producer_id, category, description,
  price, tags, file_size, format, rating, sales, views, status, created_at,
  file_url, file_bytes, file_mime, preview_url`;

export interface ListDigitalGoodsOpts {
  search?: string;
  category?: string;
  producerId?: string;
  priceMin?: number;
  priceMax?: number;
  status?: string;     // default 'active'
  sort?: 'new' | 'popular' | 'rating' | 'price_asc' | 'price_desc';
  limit?: number;
  offset?: number;
}

/**
 * List + filter + sort + paginate в SQL (replaces JS-side .filter/.sort
 * on getAll(). Default ORDER BY (sales DESC, rating DESC) — hot path
 * на partial index idx_digital_goods_active_popular.
 */
export async function listDigitalGoods(opts: ListDigitalGoodsOpts = {}): Promise<{ items: DigitalGood[]; total: number }> {
  const { pool } = await import('./db-client.tsx');
  const where: string[] = [];
  const params: any[] = [];
  let i = 1;

  const status = opts.status ?? 'active';
  where.push(`status = $${i++}`); params.push(status);

  if (opts.search) {
    where.push(`(title ILIKE $${i} OR description ILIKE $${i} OR producer ILIKE $${i} OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $${i}))`);
    params.push(`%${opts.search}%`); i++;
  }
  if (opts.category)   { where.push(`category = $${i++}`);     params.push(opts.category); }
  if (opts.producerId) { where.push(`producer_id = $${i++}`);  params.push(opts.producerId); }
  if (opts.priceMin != null) { where.push(`price >= $${i++}`); params.push(opts.priceMin); }
  if (opts.priceMax != null) { where.push(`price <= $${i++}`); params.push(opts.priceMax); }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const sortMap: Record<string, string> = {
    new:        'created_at DESC',
    popular:    'sales DESC, rating DESC',
    rating:     'rating DESC, sales DESC',
    price_asc:  'price ASC',
    price_desc: 'price DESC',
  };
  const orderBy = sortMap[opts.sort || 'popular'] || sortMap.popular;

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
  const offset = Math.max(0, opts.offset ?? 0);

  const [itemsR, totalR] = await Promise.all([
    pool.query(
      `SELECT ${DIGITAL_GOOD_COLS} FROM digital_goods
        ${whereSql}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM digital_goods ${whereSql}`,
      params
    ),
  ]);

  return {
    items: itemsR.rows.map(mapDigitalGoodRow).filter((x): x is DigitalGood => x !== null),
    total: totalR.rows[0]?.total ?? 0,
  };
}

export async function getDigitalGood(id: string): Promise<DigitalGood | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${DIGITAL_GOOD_COLS} FROM digital_goods WHERE id = $1 LIMIT 1`,
    [id]
  );
  return mapDigitalGoodRow(r.rows[0]);
}

export async function insertDigitalGood(good: DigitalGood): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO digital_goods
       (id, title, producer, producer_id, category, description, price,
        tags, file_size, format, rating, sales, views, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             COALESCE($15::timestamptz, NOW()))`,
    [
      good.id, good.title, good.producer, good.producerId, good.category,
      good.description || '', good.price, good.tags || [],
      good.fileSize || '0 MB', good.format || '',
      good.rating || 0, good.sales || 0, good.views || 0,
      good.status || 'active', good.createdAt || null,
    ]
  );
}

/**
 * Записать file-metadata после успешного producer upload'а.
 * Migration 097 — delivery. Атомарный UPDATE по (id, producer_id):
 * producer не может через подмену body перезаписать чужой товар.
 * Возвращает true если row найден и обновлён, false иначе.
 */
export async function setDigitalGoodFile(
  id: string,
  producerId: string,
  file: { url: string; bytes: number; mime: string },
): Promise<boolean> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `UPDATE digital_goods
        SET file_url = $1, file_bytes = $2, file_mime = $3
      WHERE id = $4 AND producer_id = $5
      RETURNING id`,
    [file.url, file.bytes, file.mime, id, producerId]
  );
  return r.rowCount! > 0;
}

/**
 * Atomic view increment. Replaces legacy get-modify-set паттерн на /:id
 * который терял views под concurrent load (2 параллельных GET'а
 * читали тот же `views`, оба писали +1 → один lost).
 */
export async function incrementDigitalGoodViews(id: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE digital_goods SET views = views + 1 WHERE id = $1`,
    [id]
  );
}

/**
 * Atomic sales increment. Webhook'и от YooKassa могут retry'иться —
 * native UPDATE гарантирует atomic +1 (vs legacy get+JSON.stringify+set
 * который под retry мог LOST count).
 */
export async function incrementDigitalGoodSales(id: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE digital_goods SET sales = sales + 1 WHERE id = $1`,
    [id]
  );
}

export async function setDigitalGoodStatus(id: string, status: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE digital_goods SET status = $1 WHERE id = $2`,
    [status, id]
  );
}
// Producer per-user singletons — typed access since this PR. 3 tables share
// identical (user_id PK, data jsonb) shape — generic helpers ниже used by all 3.

async function _userSingletonGet(table: string, userId: string): Promise<any | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT data FROM ${table} WHERE user_id = $1 LIMIT 1`, [userId]
  );
  if (r.rows.length === 0) return null;
  const raw = r.rows[0].data;
  return typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : (raw || null);
}
async function _userSingletonSet(table: string, userId: string, value: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO ${table} (user_id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [userId, JSON.stringify(value ?? {})]
  );
}
async function _userSingletonPatch(table: string, userId: string, patch: Record<string, any>): Promise<Record<string, any>> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `INSERT INTO ${table} (user_id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       data = COALESCE(${table}.data, '{}'::jsonb) || EXCLUDED.data,
       updated_at = NOW()
     RETURNING data`,
    [userId, JSON.stringify(patch)]
  );
  return r.rows[0]?.data || patch;
}

// producer_settings (preferences, notifications, etc.)
export const getProducerSettings = (userId: string) => _userSingletonGet('producer_settings', userId);
export const setProducerSettings = (userId: string, v: any) => _userSingletonSet('producer_settings', userId, v);

// producer_profile_edit (in-flight profile edits / drafts).
export const getProducerProfileEdit = (userId: string) => _userSingletonGet('producer_profile_edit', userId);
export const setProducerProfileEdit = (userId: string, v: any) => _userSingletonSet('producer_profile_edit', userId, v);
export const patchProducerProfileEdit = (userId: string, p: Record<string, any>) => _userSingletonPatch('producer_profile_edit', userId, p);

// producer_ai_last (last AI question/response для studio chat).
export const getProducerAiLast = (userId: string) => _userSingletonGet('producer_ai_last', userId);
export const setProducerAiLast = (userId: string, v: any) => _userSingletonSet('producer_ai_last', userId, v);
// producer_convs/messages/sessions переехали на row-per-entity
// (migration 042). Доступ через pool.query в producer-studio-routes.tsx.
// producer_custom_services / producer_custom_portfolio переехали на
// row-per-item (migration 039). Доступ через pool.query в
// producer-studio-routes.tsx.

// ─── producer_services / service_orders — native cols (migration 057) ─
// 4 store wrappers DELETED (producerServicesStore / serviceOrdersStore /
// serviceOrdersByClientStore / serviceOrdersByProducerStore). Tables
// service_orders_by_client / service_orders_by_producer — DROPPED
// (derived из service_orders.client_id / producer_id с native indexes).
// Доступ — типизированные функции ниже.

const PRODUCER_SERVICE_COLS = `id, producer_id, producer_name, title,
  service_type, description, base_price, delivery_days, status,
  orders_count, rating, extra, created_at, updated_at`;

function mapProducerServiceRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    producerId: r.producer_id,
    producer: r.producer_name,
    title: r.title || '',
    type: r.service_type,
    description: r.description || '',
    basePrice: Number(r.base_price || 0),
    price: Number(r.base_price || 0),
    deliveryDays: Number(r.delivery_days || 5),
    status: r.status,
    orders: Number(r.orders_count || 0),
    rating: Number(r.rating || 0),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.extra || {}),
  };
}

export async function getProducerService(id: string): Promise<any | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${PRODUCER_SERVICE_COLS} FROM producer_services WHERE id = $1 LIMIT 1`,
    [id]
  );
  return r.rowCount ? mapProducerServiceRow(r.rows[0]) : null;
}

export async function listProducerServices(opts: {
  status?: string;
  producerId?: string;
  serviceType?: string;
} = {}): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const where: string[] = [];
  const params: any[] = [];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.producerId) { params.push(opts.producerId); where.push(`producer_id = $${params.length}`); }
  if (opts.serviceType) { params.push(opts.serviceType); where.push(`service_type = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT ${PRODUCER_SERVICE_COLS} FROM producer_services
       ${whereSql}
       ORDER BY rating DESC, orders_count DESC`,
    params
  );
  return r.rows.map(mapProducerServiceRow);
}

export async function upsertProducerService(id: string, value: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  const extra = { ...value };
  ['id','producerId','producer','title','type','description','basePrice','price',
   'deliveryDays','status','orders','rating','createdAt','updatedAt'].forEach(k => delete extra[k]);
  await pool.query(
    `INSERT INTO producer_services
       (id, producer_id, producer_name, title, service_type, description,
        base_price, delivery_days, status, orders_count, rating, extra, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       producer_id   = COALESCE(EXCLUDED.producer_id, producer_services.producer_id),
       producer_name = EXCLUDED.producer_name,
       title         = EXCLUDED.title,
       service_type  = EXCLUDED.service_type,
       description   = EXCLUDED.description,
       base_price    = EXCLUDED.base_price,
       delivery_days = EXCLUDED.delivery_days,
       status        = EXCLUDED.status,
       orders_count  = EXCLUDED.orders_count,
       rating        = EXCLUDED.rating,
       extra         = EXCLUDED.extra,
       updated_at    = NOW()`,
    [
      id,
      value.producerId || null,
      value.producer || null,
      value.title || '',
      value.type || null,
      value.description || '',
      Number(value.basePrice ?? value.price ?? 0),
      Number(value.deliveryDays ?? 5),
      value.status || 'active',
      Number(value.orders ?? 0),
      Number(value.rating ?? 0),
      JSON.stringify(extra),
    ]
  );
}

export async function incrementProducerServiceOrders(serviceId: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE producer_services SET orders_count = orders_count + 1, updated_at = NOW()
      WHERE id = $1`,
    [serviceId]
  );
}

export async function deleteProducerService(id: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(`DELETE FROM producer_services WHERE id = $1`, [id]);
}

const SERVICE_ORDER_COLS = `id, service_id, service_title, service_type,
  producer_id, producer_name, client_id, client_name, message, details,
  urgency, price, commission, producer_payout, status, progress,
  status_message, delivery_days, deadline, completed_at, extra,
  created_at, updated_at`;

function mapServiceOrderRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    serviceId: r.service_id,
    serviceTitle: r.service_title || '',
    serviceType: r.service_type,
    producerId: r.producer_id,
    producerName: r.producer_name,
    clientId: r.client_id,
    clientName: r.client_name,
    message: r.message || '',
    details: r.details || '',
    urgency: r.urgency,
    price: Number(r.price || 0),
    commission: Number(r.commission || 0),
    producerPayout: Number(r.producer_payout || 0),
    status: r.status,
    progress: Number(r.progress || 0),
    statusMessage: r.status_message || undefined,
    deliveryDays: Number(r.delivery_days || 5),
    deadline: iso(r.deadline),
    completedAt: iso(r.completed_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.extra || {}),
  };
}

export async function getServiceOrder(id: string): Promise<any | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${SERVICE_ORDER_COLS} FROM service_orders WHERE id = $1 LIMIT 1`,
    [id]
  );
  return r.rowCount ? mapServiceOrderRow(r.rows[0]) : null;
}

export async function upsertServiceOrder(id: string, value: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  const extra = { ...value };
  ['id','serviceId','serviceTitle','serviceType','producerId','producerName',
   'clientId','clientName','message','details','urgency','price','commission',
   'producerPayout','status','progress','statusMessage','deliveryDays',
   'deadline','completedAt','createdAt','updatedAt'].forEach(k => delete extra[k]);
  await pool.query(
    `INSERT INTO service_orders
       (id, service_id, service_title, service_type, producer_id, producer_name,
        client_id, client_name, message, details, urgency, price, commission,
        producer_payout, status, progress, status_message, delivery_days,
        deadline, completed_at, extra, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18,
             $19, $20, $21::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       service_id      = COALESCE(EXCLUDED.service_id, service_orders.service_id),
       service_title   = EXCLUDED.service_title,
       service_type    = EXCLUDED.service_type,
       producer_id     = COALESCE(EXCLUDED.producer_id, service_orders.producer_id),
       producer_name   = EXCLUDED.producer_name,
       client_id       = COALESCE(EXCLUDED.client_id, service_orders.client_id),
       client_name     = EXCLUDED.client_name,
       message         = EXCLUDED.message,
       details         = EXCLUDED.details,
       urgency         = EXCLUDED.urgency,
       price           = EXCLUDED.price,
       commission      = EXCLUDED.commission,
       producer_payout = EXCLUDED.producer_payout,
       status          = EXCLUDED.status,
       progress        = EXCLUDED.progress,
       status_message  = EXCLUDED.status_message,
       delivery_days   = EXCLUDED.delivery_days,
       deadline        = EXCLUDED.deadline,
       completed_at    = EXCLUDED.completed_at,
       extra           = EXCLUDED.extra,
       updated_at      = NOW()`,
    [
      id,
      value.serviceId || null, value.serviceTitle || '', value.serviceType || null,
      value.producerId || null, value.producerName || null,
      value.clientId || null, value.clientName || null,
      value.message || '', value.details || '',
      value.urgency || 'normal',
      Number(value.price ?? 0), Number(value.commission ?? 0), Number(value.producerPayout ?? 0),
      value.status || 'pending', Number(value.progress ?? 0), value.statusMessage || null,
      Number(value.deliveryDays ?? 5),
      value.deadline || null, value.completedAt || null,
      JSON.stringify(extra),
    ]
  );
}

export async function listServiceOrdersByClient(clientId: string): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${SERVICE_ORDER_COLS} FROM service_orders
      WHERE client_id = $1 ORDER BY created_at DESC`,
    [clientId]
  );
  return r.rows.map(mapServiceOrderRow);
}

export async function listServiceOrdersByProducer(producerId: string): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${SERVICE_ORDER_COLS} FROM service_orders
      WHERE producer_id = $1 ORDER BY created_at DESC`,
    [producerId]
  );
  return r.rows.map(mapServiceOrderRow);
}
// bookingCalendarStore — REMOVED (dead cache, 0 writers; only 2 .del calls).
// Cache invalidation was no-op после migration that promoted bookings к
// native cols. Table candidate для manual DROP via OPERATIONS_LOG.
// payment_transactions переехал на row-per-tx (migration 037). Доступ
// через pool.query из platform-revenue.tsx + track-test-routes.tsx.
// payment_balances имеет native cols (available, pending, total) — не data
// jsonb. Handworked wrapper читает/пишет native cols через
// userId/available/pending/total contract. Не наследует makeUserSingletonStore.
export const paymentBalancesStore = {
  async get(userId: string): Promise<any | null> {
    const { pool } = await import('./db-client.tsx');
    const r = await pool.query(
      `SELECT user_id, available, pending, total FROM payment_balances WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return {
      userId: row.user_id,
      available: Number(row.available || 0),
      pending: Number(row.pending || 0),
      total: Number(row.total || 0),
    };
  },
  async set(userId: string, value: any): Promise<void> {
    const { pool } = await import('./db-client.tsx');
    await pool.query(
      `INSERT INTO payment_balances (user_id, available, pending, total, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         available = EXCLUDED.available,
         pending   = EXCLUDED.pending,
         total     = EXCLUDED.total,
         updated_at = NOW()`,
      [userId, Number(value.available || 0), Number(value.pending || 0), Number(value.total || 0)]
    );
  },
  async del(userId: string): Promise<void> {
    const { pool } = await import('./db-client.tsx');
    await pool.query(`DELETE FROM payment_balances WHERE user_id = $1`, [userId]);
  },
  async getAll(): Promise<any[]> {
    const { pool } = await import('./db-client.tsx');
    const r = await pool.query(
      `SELECT user_id, available, pending, total FROM payment_balances`
    );
    return r.rows.map((row: any) => ({
      userId: row.user_id,
      available: Number(row.available || 0),
      pending: Number(row.pending || 0),
      total: Number(row.total || 0),
    }));
  },
};
// dj_marketplace_index, dj_reviews, dj_collaborations, dj_pitches,
// dj_editor_profiles — store declarations удалены как orphan (2026-05-27):
// dj_marketplace_index, dj_collaborations, dj_pitches — 0 callers;
// dj_reviews / dj_editor_profiles используются напрямую через
// pool.query / db().from(), store-helper не нужен.
// djMixesStore — DROPPED (0 callers; migration 046 promoted dj_mixes to
// native cols. Доступ — напрямую через pool.query в dj-marketplace-routes.tsx
// и других местах).
// dj_calendar таблица + декларация удалены (migration 040). Был zombie
// код, 0 callers — DJ-календарь как фича не реализован.
// djNotificationsStore + djCampaignsStore — dead imports (0 method
// invocations в коде). Удалены из db.tsx; таблицы dj_notifications /
// dj_campaigns на проде НЕ DROP'нуты (могут писаться через прямой SQL —
// проверка laptop'ом).
function mapDjSubscriptionRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    djId: r.dj_id,
    planId: r.plan_id,
    planName: r.plan_name,
    status: r.status,
    price: Number(r.price || 0),
    currency: r.currency,
    interval: r.billing_interval,
    startDate: iso(r.start_date),
    endDate: iso(r.end_date),
    limits: r.limits || {},
  };
}

function makeDjSubscriptionsStore() {
  return {
    async get(djId: string): Promise<any | null> {
      const { pool } = await import('./db-client.tsx');
      const r = await pool.query(
        `SELECT dj_id, plan_id, plan_name, status, price, currency,
                billing_interval, start_date, end_date, limits
           FROM dj_subscriptions WHERE dj_id = $1 LIMIT 1`,
        [djId]
      );
      return r.rowCount ? mapDjSubscriptionRow(r.rows[0]) : null;
    },
    async set(djId: string, value: any): Promise<void> {
      const { pool } = await import('./db-client.tsx');
      const limits = value.limits && typeof value.limits === 'object' ? value.limits : {};
      await pool.query(
        `INSERT INTO dj_subscriptions
           (dj_id, plan_id, plan_name, status, price, currency,
            billing_interval, start_date, end_date, limits, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
         ON CONFLICT (dj_id) DO UPDATE SET
           plan_id          = EXCLUDED.plan_id,
           plan_name        = EXCLUDED.plan_name,
           status           = EXCLUDED.status,
           price            = EXCLUDED.price,
           currency         = EXCLUDED.currency,
           billing_interval = EXCLUDED.billing_interval,
           start_date       = EXCLUDED.start_date,
           end_date         = EXCLUDED.end_date,
           limits           = EXCLUDED.limits,
           updated_at       = NOW()`,
        [
          djId,
          value.planId || value.plan_id || null,
          value.planName || value.plan_name || null,
          value.status || 'active',
          Number(value.price || 0),
          value.currency || '₽',
          value.interval || value.billing_interval || 'month',
          value.startDate || value.start_date || null,
          value.endDate || value.end_date || null,
          JSON.stringify(limits),
        ]
      );
    },
    async del(djId: string): Promise<void> {
      const { pool } = await import('./db-client.tsx');
      await pool.query(`DELETE FROM dj_subscriptions WHERE dj_id = $1`, [djId]);
    },
    async getAll(): Promise<any[]> {
      const { pool } = await import('./db-client.tsx');
      const r = await pool.query(
        `SELECT dj_id, plan_id, plan_name, status, price, currency,
                billing_interval, start_date, end_date, limits
           FROM dj_subscriptions
          ORDER BY updated_at DESC`
      );
      return r.rows.map(mapDjSubscriptionRow);
    },
  };
}

// djSubscriptionsStore — native cols since migration 054.
export const djSubscriptionsStore = makeDjSubscriptionsStore();
// dj_withdrawals переехал на row-per-withdrawal (migration 044). Доступ
// через pool.query из dj-studio-routes.tsx + checkout-routes.tsx webhook.
// djTransactionsStore — REMOVED (dead store, 0 writers anywhere; only 2 .get
// reads which returned []. Transactions surface'ятся через fetchDjEvents +
// dj_withdrawals row-per-withdrawal, см. dj-studio-routes.tsx finances).
// collab_offers — row-per-offer native cols (migration 064).
// collab_offers_by_artist + collab_offers_by_producer таблицы DROPPED
// — derived из collab_offers.artist_id / producer_id с native indexes.
// Доступ — типизированные функции ниже.

const COLLAB_OFFER_COLS = `id, producer_id, producer_name, producer_avatar,
  artist_id, artist_name, offer_type, title, description, price, currency,
  audio_preview_url, bpm, music_key, genre, tags, status, deadline,
  responded_at, completed_at, artist_comment, extra,
  created_at, updated_at`;

function mapCollabOfferRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : undefined);
  return {
    id: r.id,
    producerId: r.producer_id,
    producerName: r.producer_name,
    producerAvatar: r.producer_avatar || undefined,
    artistId: r.artist_id,
    artistName: r.artist_name,
    type: r.offer_type,
    title: r.title || '',
    description: r.description || '',
    price: r.price !== null && r.price !== undefined ? Number(r.price) : undefined,
    currency: r.currency || 'RUB',
    audioPreviewUrl: r.audio_preview_url || undefined,
    bpm: r.bpm !== null && r.bpm !== undefined ? Number(r.bpm) : undefined,
    key: r.music_key || undefined,
    genre: r.genre || undefined,
    tags: r.tags || [],
    status: r.status,
    deadline: iso(r.deadline),
    respondedAt: iso(r.responded_at),
    completedAt: iso(r.completed_at),
    artistComment: r.artist_comment || undefined,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.extra || {}),
  };
}

export async function getCollabOffer(id: string): Promise<any | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${COLLAB_OFFER_COLS} FROM collab_offers WHERE id = $1 LIMIT 1`,
    [id]
  );
  return r.rowCount ? mapCollabOfferRow(r.rows[0]) : null;
}

export async function upsertCollabOffer(id: string, value: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  const extra = { ...value };
  ['id','producerId','producerName','producerAvatar','artistId','artistName',
   'type','title','description','price','currency','audioPreviewUrl','bpm',
   'key','genre','tags','status','deadline','respondedAt','completedAt',
   'artistComment','createdAt','updatedAt'].forEach(k => delete extra[k]);
  const tags = Array.isArray(value.tags) ? value.tags : [];
  await pool.query(
    `INSERT INTO collab_offers
       (id, producer_id, producer_name, producer_avatar,
        artist_id, artist_name, offer_type, title, description, price, currency,
        audio_preview_url, bpm, music_key, genre, tags, status, deadline,
        responded_at, completed_at, artist_comment, extra, updated_at)
     VALUES ($1, $2, $3, $4,
             $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16::jsonb, $17, $18,
             $19, $20, $21, $22::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       producer_id       = COALESCE(EXCLUDED.producer_id,   collab_offers.producer_id),
       producer_name     = EXCLUDED.producer_name,
       producer_avatar   = EXCLUDED.producer_avatar,
       artist_id         = COALESCE(EXCLUDED.artist_id,     collab_offers.artist_id),
       artist_name       = EXCLUDED.artist_name,
       offer_type        = EXCLUDED.offer_type,
       title             = EXCLUDED.title,
       description       = EXCLUDED.description,
       price             = EXCLUDED.price,
       currency          = EXCLUDED.currency,
       audio_preview_url = EXCLUDED.audio_preview_url,
       bpm               = EXCLUDED.bpm,
       music_key         = EXCLUDED.music_key,
       genre             = EXCLUDED.genre,
       tags              = EXCLUDED.tags,
       status            = EXCLUDED.status,
       deadline          = EXCLUDED.deadline,
       responded_at      = EXCLUDED.responded_at,
       completed_at      = EXCLUDED.completed_at,
       artist_comment    = EXCLUDED.artist_comment,
       extra             = EXCLUDED.extra,
       updated_at        = NOW()`,
    [
      id,
      value.producerId || null, value.producerName || null, value.producerAvatar || null,
      value.artistId || null, value.artistName || null,
      value.type || 'beat', value.title || '', value.description || '',
      value.price !== undefined && value.price !== null ? Number(value.price) : null,
      value.currency || 'RUB',
      value.audioPreviewUrl || null,
      value.bpm !== undefined && value.bpm !== null ? Number(value.bpm) : null,
      value.key || null,
      value.genre || null,
      JSON.stringify(tags),
      value.status || 'pending',
      value.deadline || null,
      value.respondedAt || null, value.completedAt || null,
      value.artistComment || null,
      JSON.stringify(extra),
    ]
  );
}

export async function listCollabOffersByArtist(artistId: string): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${COLLAB_OFFER_COLS} FROM collab_offers
      WHERE artist_id = $1 ORDER BY created_at DESC`,
    [artistId]
  );
  return r.rows.map(mapCollabOfferRow);
}

export async function listCollabOffersByProducer(producerId: string): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${COLLAB_OFFER_COLS} FROM collab_offers
      WHERE producer_id = $1 ORDER BY created_at DESC`,
    [producerId]
  );
  return r.rows.map(mapCollabOfferRow);
}

export async function getCollabOfferStatsByUser(userId: string): Promise<any> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE artist_id = $1)                                     AS total_received,
       COUNT(*) FILTER (WHERE producer_id = $1)                                   AS total_sent,
       COUNT(*) FILTER (WHERE (artist_id = $1 OR producer_id = $1) AND status = 'pending')    AS pending,
       COUNT(*) FILTER (WHERE (artist_id = $1 OR producer_id = $1) AND status = 'accepted')   AS accepted,
       COUNT(*) FILTER (WHERE (artist_id = $1 OR producer_id = $1) AND status = 'declined')   AS declined,
       COUNT(*) FILTER (WHERE (artist_id = $1 OR producer_id = $1) AND status = 'discussion') AS in_discussion,
       COUNT(*) FILTER (WHERE (artist_id = $1 OR producer_id = $1) AND status = 'completed')  AS completed
     FROM collab_offers`,
    [userId]
  );
  const row = r.rows[0] || {};
  return {
    totalReceived: Number(row.total_received || 0),
    totalSent:     Number(row.total_sent || 0),
    pending:       Number(row.pending || 0),
    accepted:      Number(row.accepted || 0),
    declined:      Number(row.declined || 0),
    inDiscussion:  Number(row.in_discussion || 0),
    completed:     Number(row.completed || 0),
  };
}
// collab_messages переехал на row-per-message (migration 038). Доступ
// через pool.query в collaboration-routes.tsx.
// ─── publish_orders (native cols since migration 078) ───
// Video/concert publication orders. ~22 callers across publish-routes.tsx
// + 2 in chat-routes.tsx. Store removed, typed functions ниже.

export interface PublishOrderExtra {
  distributionData?: any;
  statusHistory?: Array<{ status: string; at: string; by?: string; comment?: string }>;
  [k: string]: any;
}

export interface PublishOrderRow {
  id: string;
  userId: string;
  type: string;        // 'video' | 'concert'
  status: string;
  title: string;
  description: string;
  plan?: string | null;
  price: number;
  priceBase?: number | null;
  subscriptionApplied?: boolean | null;
  currency: string;
  paidAt?: string | null;
  paymentMethod?: string | null;
  moderatorId?: string | null;
  moderatorComment?: string | null;
  moderatedAt?: string | null;
  rejectionReason?: string | null;
  revisionNotes?: string | null;
  publishedAt?: string | null;
  // Video
  videoUrl?: string | null;
  videoSource?: string | null;
  videoCategory?: string | null;
  thumbnailUrl?: string | null;
  tags: string[];
  // Concert
  eventDate?: string | null;
  eventTime?: string | null;
  city?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  ticketPriceMin?: number | null;
  ticketPriceMax?: number | null;
  ticketUrl?: string | null;
  posterUrl?: string | null;
  genre?: string | null;
  // Label-on-behalf
  actingForArtistId?: string | null;
  actingForArtistUserId?: string | null;
  labelId?: string | null;
  // Nested polymorphic
  extra: PublishOrderExtra;
  createdAt: string;
  updatedAt?: string | null;
}

function mapPublishOrderRow(r: any): PublishOrderRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  const isoOrNull = (d: any) => d == null ? null : iso(d);
  const dateStr = (d: any) =>
    d == null ? null : (d instanceof Date ? d.toISOString().split('T')[0] : String(d));
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    status: r.status,
    title: r.title,
    description: r.description || '',
    plan: r.plan,
    price: Number(r.price || 0),
    priceBase: r.price_base == null ? null : Number(r.price_base),
    subscriptionApplied: r.subscription_applied,
    currency: r.currency || 'RUB',
    paidAt: isoOrNull(r.paid_at),
    paymentMethod: r.payment_method,
    moderatorId: r.moderator_id,
    moderatorComment: r.moderator_comment,
    moderatedAt: isoOrNull(r.moderated_at),
    rejectionReason: r.rejection_reason,
    revisionNotes: r.revision_notes,
    publishedAt: isoOrNull(r.published_at),
    videoUrl: r.video_url,
    videoSource: r.video_source,
    videoCategory: r.video_category,
    thumbnailUrl: r.thumbnail_url,
    tags: r.tags || [],
    eventDate: dateStr(r.event_date),
    eventTime: r.event_time,
    city: r.city,
    venueName: r.venue_name,
    venueAddress: r.venue_address,
    ticketPriceMin: r.ticket_price_min == null ? null : Number(r.ticket_price_min),
    ticketPriceMax: r.ticket_price_max == null ? null : Number(r.ticket_price_max),
    ticketUrl: r.ticket_url,
    posterUrl: r.poster_url,
    genre: r.genre,
    actingForArtistId: r.acting_for_artist_id,
    actingForArtistUserId: r.acting_for_artist_user_id,
    labelId: r.label_id,
    extra: r.extra || {},
    createdAt: iso(r.created_at),
    updatedAt: isoOrNull(r.updated_at),
  };
}

const PUBLISH_ORDER_COLS = `id, user_id, type, status, title, description, plan,
  price, price_base, subscription_applied, currency, paid_at, payment_method,
  moderator_id, moderator_comment, moderated_at, rejection_reason, revision_notes,
  published_at, video_url, video_source, video_category, thumbnail_url, tags,
  event_date, event_time, city, venue_name, venue_address, ticket_price_min,
  ticket_price_max, ticket_url, poster_url, genre, acting_for_artist_id,
  acting_for_artist_user_id, label_id, extra, created_at, updated_at`;

export async function getPublishOrder(id: string): Promise<PublishOrderRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${PUBLISH_ORDER_COLS} FROM publish_orders WHERE id = $1 LIMIT 1`,
    [id]
  );
  return mapPublishOrderRow(r.rows[0]);
}

export async function insertPublishOrder(order: PublishOrderRow): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO publish_orders
       (id, user_id, type, status, title, description, plan, price, price_base,
        subscription_applied, currency, paid_at, payment_method, moderator_id,
        moderator_comment, moderated_at, rejection_reason, revision_notes,
        published_at, video_url, video_source, video_category, thumbnail_url, tags,
        event_date, event_time, city, venue_name, venue_address, ticket_price_min,
        ticket_price_max, ticket_url, poster_url, genre, acting_for_artist_id,
        acting_for_artist_user_id, label_id, extra, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13,
             $14, $15, $16::timestamptz, $17, $18, $19::timestamptz, $20, $21, $22,
             $23, $24, $25::date, $26, $27, $28, $29, $30, $31, $32, $33, $34,
             $35, $36, $37, $38::jsonb, COALESCE($39::timestamptz, NOW()))`,
    [
      order.id, order.userId, order.type, order.status, order.title,
      order.description || '', order.plan ?? null, order.price ?? 0,
      order.priceBase ?? null, order.subscriptionApplied ?? null,
      order.currency || 'RUB', order.paidAt ?? null, order.paymentMethod ?? null,
      order.moderatorId ?? null, order.moderatorComment ?? null,
      order.moderatedAt ?? null, order.rejectionReason ?? null,
      order.revisionNotes ?? null, order.publishedAt ?? null,
      order.videoUrl ?? null, order.videoSource ?? null, order.videoCategory ?? null,
      order.thumbnailUrl ?? null, order.tags || [],
      order.eventDate ?? null, order.eventTime ?? null, order.city ?? null,
      order.venueName ?? null, order.venueAddress ?? null,
      order.ticketPriceMin ?? null, order.ticketPriceMax ?? null,
      order.ticketUrl ?? null, order.posterUrl ?? null, order.genre ?? null,
      order.actingForArtistId ?? null, order.actingForArtistUserId ?? null,
      order.labelId ?? null, JSON.stringify(order.extra || {}),
      order.createdAt ?? null,
    ]
  );
}

/**
 * Update mutable fields atomically. Принимает partial patch — undefined
 * поля игнорятся. updated_at = NOW() автоматически.
 * Заменяет legacy get→mutate→set паттерн (race-prone на concurrent admin
 * actions). Single UPDATE statement — atomic, lost-update safe.
 */
export async function updatePublishOrder(
  id: string,
  patch: Partial<PublishOrderRow>,
): Promise<void> {
  const FIELD_MAP: Record<string, string> = {
    type: 'type', status: 'status', title: 'title', description: 'description',
    plan: 'plan', price: 'price', priceBase: 'price_base',
    subscriptionApplied: 'subscription_applied', currency: 'currency',
    paidAt: 'paid_at', paymentMethod: 'payment_method',
    moderatorId: 'moderator_id', moderatorComment: 'moderator_comment',
    moderatedAt: 'moderated_at', rejectionReason: 'rejection_reason',
    revisionNotes: 'revision_notes', publishedAt: 'published_at',
    videoUrl: 'video_url', videoSource: 'video_source',
    videoCategory: 'video_category', thumbnailUrl: 'thumbnail_url',
    tags: 'tags',
    eventDate: 'event_date', eventTime: 'event_time', city: 'city',
    venueName: 'venue_name', venueAddress: 'venue_address',
    ticketPriceMin: 'ticket_price_min', ticketPriceMax: 'ticket_price_max',
    ticketUrl: 'ticket_url', posterUrl: 'poster_url', genre: 'genre',
    actingForArtistId: 'acting_for_artist_id',
    actingForArtistUserId: 'acting_for_artist_user_id',
    labelId: 'label_id', extra: 'extra',
  };
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  for (const [field, col] of Object.entries(FIELD_MAP)) {
    if ((patch as any)[field] === undefined) continue;
    const v = (patch as any)[field];
    if (col === 'extra') {
      sets.push(`${col} = $${i++}::jsonb`); vals.push(JSON.stringify(v || {}));
    } else if (col === 'event_date') {
      sets.push(`${col} = $${i++}::date`); vals.push(v || null);
    } else if (
      col === 'paid_at' || col === 'moderated_at' ||
      col === 'published_at'
    ) {
      sets.push(`${col} = $${i++}::timestamptz`); vals.push(v || null);
    } else {
      sets.push(`${col} = $${i++}`); vals.push(v);
    }
  }
  if (sets.length === 0) return;
  sets.push('updated_at = NOW()');
  vals.push(id);
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE publish_orders SET ${sets.join(', ')} WHERE id = $${i}`,
    vals,
  );
}

export async function deletePublishOrder(id: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(`DELETE FROM publish_orders WHERE id = $1`, [id]);
}

export async function listPublishOrdersByUser(userId: string): Promise<PublishOrderRow[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${PUBLISH_ORDER_COLS} FROM publish_orders
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows.map(mapPublishOrderRow).filter((x): x is PublishOrderRow => x !== null);
}

export async function listPublishOrders(opts: {
  status?: string; type?: string; limit?: number; offset?: number;
} = {}): Promise<PublishOrderRow[]> {
  const { pool } = await import('./db-client.tsx');
  const where: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (opts.status) { where.push(`status = $${i++}`); params.push(opts.status); }
  if (opts.type)   { where.push(`type = $${i++}`);   params.push(opts.type); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 1000));
  const offset = Math.max(0, opts.offset ?? 0);
  const r = await pool.query(
    `SELECT ${PUBLISH_ORDER_COLS} FROM publish_orders
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return r.rows.map(mapPublishOrderRow).filter((x): x is PublishOrderRow => x !== null);
}

/**
 * Stats aggregation — SQL pushdown (COUNT FILTER WHERE status=...).
 * Заменяет 6 JS .filter().length в GET /admin/stats (publish-routes.tsx:905).
 */
export async function getPublishOrderStats(): Promise<{
  total: number;
  byStatus: Record<string, number>;
  totalRevenue: number;
}> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT
       COUNT(*)::int                                                        AS total,
       COUNT(*) FILTER (WHERE status = 'draft')::int                        AS draft,
       COUNT(*) FILTER (WHERE status = 'pending_review')::int               AS pending_review,
       COUNT(*) FILTER (WHERE status = 'in_review')::int                    AS in_review,
       COUNT(*) FILTER (WHERE status = 'revision')::int                     AS revision,
       COUNT(*) FILTER (WHERE status = 'approved')::int                     AS approved,
       COUNT(*) FILTER (WHERE status = 'pending_payment')::int              AS pending_payment,
       COUNT(*) FILTER (WHERE status = 'paid')::int                         AS paid,
       COUNT(*) FILTER (WHERE status = 'published')::int                    AS published,
       COUNT(*) FILTER (WHERE status = 'rejected')::int                     AS rejected,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int                    AS cancelled,
       COALESCE(SUM(price) FILTER (WHERE status IN ('paid','published')), 0)::numeric AS total_revenue
     FROM publish_orders`
  );
  const row = r.rows[0] || {};
  return {
    total: Number(row.total || 0),
    byStatus: {
      draft:           Number(row.draft || 0),
      pending_review:  Number(row.pending_review || 0),
      in_review:       Number(row.in_review || 0),
      revision:        Number(row.revision || 0),
      approved:        Number(row.approved || 0),
      pending_payment: Number(row.pending_payment || 0),
      paid:            Number(row.paid || 0),
      published:       Number(row.published || 0),
      rejected:        Number(row.rejected || 0),
      cancelled:       Number(row.cancelled || 0),
    },
    totalRevenue: Number(row.total_revenue || 0),
  };
}
// publish_chats переехал на row-per-message (migration 038). Доступ
// через pool.query в chat-routes.tsx.
// ─── publish_email_prefs (typed access since #117) ───
// Per-user singleton (1 row per user_id с email preferences). Killed wrapper +
// get→merge→set race через atomic UPSERT с jsonb || merge.
export async function getPublishEmailPrefs(userId: string): Promise<Record<string, any> | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT data FROM publish_email_prefs WHERE user_id = $1 LIMIT 1`, [userId]
  );
  if (r.rows.length === 0) return null;
  const raw = r.rows[0].data;
  return typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : (raw || null);
}
/** Replaces store.set (full overwrite). */
export async function setPublishEmailPrefs(userId: string, value: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO publish_email_prefs (user_id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [userId, JSON.stringify(value ?? {})]
  );
}
/** Atomic partial merge — race-free vs legacy get+merge+set. */
export async function patchPublishEmailPrefs(userId: string, patch: Record<string, any>): Promise<Record<string, any>> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `INSERT INTO publish_email_prefs (user_id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       data = COALESCE(publish_email_prefs.data, '{}'::jsonb) || EXCLUDED.data,
       updated_at = NOW()
     RETURNING data`,
    [userId, JSON.stringify(patch)]
  );
  return r.rows[0]?.data || patch;
}

// ─── email_history (native cols since migration 079) ───
// Transactional emails + campaign send/open/click tracking. Replaces
// compound-key patterns в email-campaigns-routes.tsx через native
// (campaign_id, kind, to_email) tuple lookups.

export interface EmailHistoryRow {
  id: string;
  userId?: string | null;
  campaignId?: string | null;
  kind: string;           // 'transactional' | 'sent' | 'open' | 'click'
  toEmail?: string | null;
  subject?: string | null;
  template?: string | null;
  content?: string | null;
  type?: string | null;
  status?: string | null;
  sentAt?: string | null;
  opened: boolean;
  clicked: boolean;
  openedAt?: string | null;
  clickedAt?: string | null;
  metadata: Record<string, any>;
  createdAt?: string | null;
}

function mapEmailHistoryRow(r: any): EmailHistoryRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  const isoOrNull = (d: any) => d == null ? null : iso(d);
  return {
    id: r.id,
    userId: r.user_id,
    campaignId: r.campaign_id,
    kind: r.kind,
    toEmail: r.to_email,
    subject: r.subject,
    template: r.template,
    content: r.content,
    type: r.type,
    status: r.status,
    sentAt: isoOrNull(r.sent_at),
    opened: !!r.opened,
    clicked: !!r.clicked,
    openedAt: isoOrNull(r.opened_at),
    clickedAt: isoOrNull(r.clicked_at),
    metadata: r.metadata || {},
    createdAt: isoOrNull(r.created_at),
  };
}

const EMAIL_HISTORY_COLS = `id, user_id, campaign_id, kind, to_email, subject,
  template, content, type, status, sent_at, opened, clicked, opened_at, clicked_at,
  metadata, created_at`;

export async function getEmailHistory(id: string): Promise<EmailHistoryRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${EMAIL_HISTORY_COLS} FROM email_history WHERE id = $1 LIMIT 1`,
    [id]
  );
  return mapEmailHistoryRow(r.rows[0]);
}

/** Native (campaign_id, kind, to_email) lookup — replaces compound-key
 *  dedup checks в email-campaigns-routes.tsx (lines 244/342/577). */
export async function findCampaignEmailEvent(
  campaignId: string, kind: string, toEmail: string,
): Promise<EmailHistoryRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${EMAIL_HISTORY_COLS} FROM email_history
      WHERE campaign_id = $1 AND kind = $2 AND to_email = $3
      LIMIT 1`,
    [campaignId, kind, toEmail]
  );
  return mapEmailHistoryRow(r.rows[0]);
}

export async function listEmailHistoryByUser(userId: string): Promise<EmailHistoryRow[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${EMAIL_HISTORY_COLS} FROM email_history
      WHERE user_id = $1
      ORDER BY sent_at DESC NULLS LAST`,
    [userId]
  );
  return r.rows.map(mapEmailHistoryRow).filter((x): x is EmailHistoryRow => x !== null);
}

export async function upsertEmailHistory(row: Partial<EmailHistoryRow> & { id: string; kind: string }): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO email_history
       (id, user_id, campaign_id, kind, to_email, subject, template, content,
        type, status, sent_at, opened, clicked, opened_at, clicked_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             COALESCE($11::timestamptz, NOW()), $12, $13, $14::timestamptz, $15::timestamptz, $16::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       user_id    = COALESCE(EXCLUDED.user_id, email_history.user_id),
       campaign_id= COALESCE(EXCLUDED.campaign_id, email_history.campaign_id),
       kind       = EXCLUDED.kind,
       to_email   = COALESCE(EXCLUDED.to_email, email_history.to_email),
       subject    = COALESCE(EXCLUDED.subject, email_history.subject),
       template   = COALESCE(EXCLUDED.template, email_history.template),
       content    = COALESCE(EXCLUDED.content, email_history.content),
       type       = COALESCE(EXCLUDED.type, email_history.type),
       status     = COALESCE(EXCLUDED.status, email_history.status),
       sent_at    = COALESCE(EXCLUDED.sent_at, email_history.sent_at),
       opened     = EXCLUDED.opened,
       clicked    = EXCLUDED.clicked,
       opened_at  = COALESCE(EXCLUDED.opened_at, email_history.opened_at),
       clicked_at = COALESCE(EXCLUDED.clicked_at, email_history.clicked_at),
       metadata   = COALESCE(EXCLUDED.metadata, email_history.metadata),
       updated_at = NOW()`,
    [
      row.id, row.userId ?? null, row.campaignId ?? null, row.kind,
      row.toEmail ?? null, row.subject ?? null, row.template ?? null,
      row.content ?? null, row.type ?? null, row.status ?? null,
      row.sentAt ?? null,
      row.opened ?? false, row.clicked ?? false,
      row.openedAt ?? null, row.clickedAt ?? null,
      JSON.stringify(row.metadata || {}),
    ]
  );
}

// ─── email_templates (native cols since migration 073) ───
// Was: makeJsonbKeyStore('email_templates'). Now: typed functions ниже.
// 3 callers in src/email-routes.tsx (list / get / seed defaults).

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  content: string;
  type: string;            // 'transactional' | 'notification' | 'newsletter'
  variables: string[];
  createdAt: string;
}

function mapEmailTemplateRow(r: any): EmailTemplate | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    name: r.name,
    subject: r.subject,
    content: r.content,
    type: r.type,
    variables: r.variables || [],
    createdAt: iso(r.created_at),
  };
}

const EMAIL_TEMPLATE_COLS = `id, name, subject, content, type, variables, created_at`;

export async function listEmailTemplates(): Promise<EmailTemplate[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${EMAIL_TEMPLATE_COLS} FROM email_templates ORDER BY created_at DESC`
  );
  return r.rows.map(mapEmailTemplateRow).filter((x): x is EmailTemplate => x !== null);
}

export async function getEmailTemplate(id: string): Promise<EmailTemplate | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${EMAIL_TEMPLATE_COLS} FROM email_templates WHERE id = $1 LIMIT 1`,
    [id]
  );
  return mapEmailTemplateRow(r.rows[0]);
}

/**
 * Upsert template. Used both для seed defaults (handler creates 4
 * стартовых templates when table empty) и admin save в future.
 */
export async function upsertEmailTemplate(t: EmailTemplate): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO email_templates (id, name, subject, content, type, variables, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))
     ON CONFLICT (id) DO UPDATE SET
       name      = EXCLUDED.name,
       subject   = EXCLUDED.subject,
       content   = EXCLUDED.content,
       type      = EXCLUDED.type,
       variables = EXCLUDED.variables`,
    [
      t.id, t.name, t.subject, t.content, t.type,
      t.variables || [],
      t.createdAt || null,
    ]
  );
}

// chart_aggregation — native cols since migration 085. Доступ через
// getChartAggregationStatus / upsertChartAggregationStatus (см. ниже).
export interface ChartAggregationStatus {
  timestamp: string | null;
  sourcesProcessed: number;
  totalTracks: number;
  results: any[];
}
export async function getChartAggregationStatus(): Promise<ChartAggregationStatus | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT timestamp, sources_processed, total_tracks, results
       FROM chart_aggregation WHERE key = 'last' LIMIT 1`
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : (row.timestamp || null),
    sourcesProcessed: Number(row.sources_processed || 0),
    totalTracks: Number(row.total_tracks || 0),
    results: Array.isArray(row.results) ? row.results : [],
  };
}
export async function upsertChartAggregationStatus(s: {
  timestamp: string; sourcesProcessed: number; totalTracks: number; results: any[];
}): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO chart_aggregation
       (key, timestamp, sources_processed, total_tracks, results, updated_at)
     VALUES ('last', $1::timestamptz, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET
       timestamp         = EXCLUDED.timestamp,
       sources_processed = EXCLUDED.sources_processed,
       total_tracks      = EXCLUDED.total_tracks,
       results           = EXCLUDED.results,
       updated_at        = NOW()`,
    [s.timestamp, s.sourcesProcessed || 0, s.totalTracks || 0, JSON.stringify(s.results || [])]
  );
}

// ─── chart_sources (native cols since migration 076) ───
// 1 row per source ID (russkoe, nashe, yandex, shazam, intl:apple:*).
// tracks остаётся jsonb — per-parser shape варьируется (mistral/fallback/
// html_parser/json_api), legit polymorphic per CLAUDE.md.

export interface ChartTrackEntry {
  position?: number;
  artist: string;
  title: string;
  [key: string]: any;
}

export interface ChartSourceRow {
  id: string;
  sourceId: string;       // alias for id (handler API contract)
  sourceName: string;
  sourceUrl: string;
  logo: string;
  type: string;
  gradient: string;
  borderColor: string;
  tracks: ChartTrackEntry[];
  fetchedAt: string;
  parsedBy: string;
  error?: string;
}

function mapChartSourceRow(r: any): ChartSourceRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    sourceId: r.id,
    sourceName: r.source_name,
    sourceUrl: r.source_url,
    logo: r.logo || '',
    type: r.type,
    gradient: r.gradient || '',
    borderColor: r.border_color || '',
    tracks: Array.isArray(r.tracks) ? r.tracks : [],
    fetchedAt: iso(r.fetched_at),
    parsedBy: r.parsed_by || '',
    error: r.error || undefined,
  };
}

const CHART_SOURCE_COLS = `id, source_name, source_url, logo, type, gradient,
  border_color, tracks, fetched_at, parsed_by, error`;

export async function getChartSource(id: string): Promise<ChartSourceRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${CHART_SOURCE_COLS} FROM chart_sources WHERE id = $1 LIMIT 1`,
    [id]
  );
  return mapChartSourceRow(r.rows[0]);
}

/**
 * Upsert chart source row. Используется cron'ом re-aggregation на каждый
 * fetch (полностью замещает кэш). Single statement, no race.
 */
export async function upsertChartSource(source: Partial<ChartSourceRow> & { id: string }): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO chart_sources
       (id, source_name, source_url, logo, type, gradient, border_color,
        tracks, fetched_at, parsed_by, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb,
             COALESCE($9::timestamptz, NOW()), $10, $11)
     ON CONFLICT (id) DO UPDATE SET
       source_name  = EXCLUDED.source_name,
       source_url   = EXCLUDED.source_url,
       logo         = EXCLUDED.logo,
       type         = EXCLUDED.type,
       gradient     = EXCLUDED.gradient,
       border_color = EXCLUDED.border_color,
       tracks       = EXCLUDED.tracks,
       fetched_at   = EXCLUDED.fetched_at,
       parsed_by    = EXCLUDED.parsed_by,
       error        = EXCLUDED.error,
       updated_at   = NOW()`,
    [
      source.id, source.sourceName || source.id, source.sourceUrl || '',
      source.logo || '', source.type || 'radio',
      source.gradient || '', source.borderColor || '',
      JSON.stringify(source.tracks || []),
      source.fetchedAt || null, source.parsedBy || '', source.error || null,
    ]
  );
}

export async function listChartSources(opts: { type?: string } = {}): Promise<ChartSourceRow[]> {
  const { pool } = await import('./db-client.tsx');
  const where = opts.type ? `WHERE type = $1` : '';
  const params = opts.type ? [opts.type] : [];
  const r = await pool.query(
    `SELECT ${CHART_SOURCE_COLS} FROM chart_sources ${where}
      ORDER BY fetched_at DESC`,
    params
  );
  return r.rows.map(mapChartSourceRow).filter((x): x is ChartSourceRow => x !== null);
}
// radioAdSlotsStore + radioAdSlotIndexStore — заменены на нативные хелперы
// после migration 050. См. блок «Radio Ad Slots» ниже.
// radioAnalyticsStore — REMOVED (0 writers; read-only placeholder возвращал
// `{}` default). Tables remain on prod (verify empty + manual DROP TABLE
// через OPERATIONS_LOG).
// radioFinanceStore — REMOVED (same — 0 writers anywhere в codebase).
// radioTransactionsStore — REMOVED (same).
//
// Phase D KV→SQL closeout (2026-05-31): radioArtistRequestsStore /
// radioVenueRequestsStore / radioNotificationsStore (KV-shaped facades
// над row-per-entity native tables) удалены. Все 10 callsites в
// radio-routes.tsx переведены на explicit list helpers ниже. Write-path
// (update/insert/delete) уже был на native helpers через migration 056.
// makeRadioRequestArrayStore тоже удалён — больше не используется.

export async function listRadioArtistRequestsByStation(stationId: string): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const cfg = RADIO_TABLE_CONFIG.radio_artist_requests;
  const r = await pool.query(
    `SELECT ${cfg.selectCols} FROM radio_artist_requests WHERE radio_id = $1 ${cfg.orderBy}`,
    [stationId]
  );
  return r.rows.map(mapArtistRequestRow);
}

export async function listRadioVenueRequestsByStation(stationId: string): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const cfg = RADIO_TABLE_CONFIG.radio_venue_requests;
  const r = await pool.query(
    `SELECT ${cfg.selectCols} FROM radio_venue_requests WHERE radio_id = $1 ${cfg.orderBy}`,
    [stationId]
  );
  return r.rows.map(mapVenueRequestRow);
}

export async function listRadioNotificationsByStation(stationId: string): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const cfg = RADIO_TABLE_CONFIG.radio_notifications;
  const r = await pool.query(
    `SELECT ${cfg.selectCols} FROM radio_notifications WHERE radio_id = $1 ${cfg.orderBy}`,
    [stationId]
  );
  return r.rows.map(mapRadioNotificationRow);
}
// venue_playlists перевели на row-per-playlist (migration 036). Доступ
// через pool.query в venue-routes.tsx / venue-api-routes.tsx.
// venue_ad_campaigns — row-per-campaign, native cols since migration 082.
// Доступ через typed functions ниже (см. anchor "venue_ad_campaigns native").
// venueAnalyticsStore — REMOVED (dead store, 0 writers anywhere; only 4 .get
// reads которые возвращали {} / []). venue_analytics table candidate для
// manual DROP via OPERATIONS_LOG.md.
// venue_radio_brand — typed access since this PR. Per-venue brand settings —
// legit polymorphic shape (UI evolves), keep как jsonb но кill get→mutate→set
// race через atomic jsonb || merge.
export async function getVenueRadioBrand(venueId: string): Promise<Record<string, any> | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT data FROM venue_radio_brand WHERE venue_id = $1 LIMIT 1`, [venueId]
  );
  if (r.rows.length === 0) return null;
  const raw = r.rows[0].data;
  return typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : (raw || null);
}
/**
 * Atomic partial update via jsonb || concatenation. Race-free vs legacy
 * get→merge→set паттерн. Returns merged final data.
 */
export async function patchVenueRadioBrand(venueId: string, patch: Record<string, any>): Promise<Record<string, any>> {
  const { pool } = await import('./db-client.tsx');
  const enriched = { ...patch, updatedAt: new Date().toISOString() };
  const r = await pool.query(
    `INSERT INTO venue_radio_brand (venue_id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (venue_id) DO UPDATE SET
       data = COALESCE(venue_radio_brand.data, '{}'::jsonb) || EXCLUDED.data,
       updated_at = NOW()
     RETURNING data`,
    [venueId, JSON.stringify(enriched)]
  );
  return r.rows[0]?.data || enriched;
}
// ticketProvidersStore — DROPPED (0 callers; ticket_providers доступ
// через `upsertTicketProvider` + `getTicketProvidersByConcert` функции
// в db.tsx + ticketing-routes.tsx).
// ticket_sales — native cols since migration 083. См. typed functions ниже.
// track_test_requests — row-per-request, native cols since migration 051.
// Interface (.get / .set / .del / .getAll) preserved для совместимости
// с handler'ами; backed by pool.query на native cols.
export const trackTestRequestsStore = makeTrackTestRequestsStore();
// Per-user / global index stores стали derived view из main table.
// Handler'ы продолжают вызывать .get/.set, но set = no-op (данные авто-
// синхронизированы через track_test_requests.user_id), а get возвращает
// SELECT id FROM track_test_requests …
export const trackTestUserRequestsStore = makeTrackTestUserRequestsView();
export const trackTestAllRequestsStore = makeTrackTestAllRequestsView();
// trackTestExpertsStore — REMOVED. track_test_experts table dropped in
// migration 053 (derived: SELECT DISTINCT expert_id FROM track_test_expert_stats).
// Доступ через listRegisteredTrackTestExperts() ниже.
// trackTestReviewsStore wrapper REMOVED (#116). track_test_reviews — native cols
// since migration 053; data column DROPPED. Доступ через typed functions ниже
// (см. anchor "track_test_reviews native cols since migration 053").
// trackTestRequestReviewsStore wrapper REMOVED (#116). track_test_request_reviews
// table DROPPED migration 053. Derived через listTrackTestReviewsByRequest
// (SELECT FROM track_test_reviews WHERE request_id = $1).
// ─── news_pipeline (typed KV access since #120) ───
// News CMS pipeline state (sources config, articles:pending/published/rejected
// buckets, last_run, per-source status). Schema unchanged (key TEXT PK, data
// jsonb). Killed makeJsonbKeyStore wrapper; reads/writes теперь through typed
// functions. Future work: split articles buckets to row-per-article (separate PR).
export async function getNewsPipelineKey<T = any>(key: string): Promise<T | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT data FROM news_pipeline WHERE key = $1 LIMIT 1`, [key]
  );
  if (r.rows.length === 0) return null;
  const raw = r.rows[0].data;
  return (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : raw) as T;
}
export async function setNewsPipelineKey(key: string, value: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO news_pipeline (key, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [key, JSON.stringify(value ?? null)]
  );
}
export async function delNewsPipelineKey(key: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(`DELETE FROM news_pipeline WHERE key = $1`, [key]);
}

// ─── agent_sessions (native cols since migration 081) ───
// AI department discussions (ARCH/DEV/SEC/OPS/QA simulated agents).
// agent_sessions_index DROPPED — replaced by indexed SELECT.

export interface AgentSessionRow {
  id: string;
  title: string;
  task: string;
  status: string;
  messages: any[];      // AgentMsg[] — legit nested polymorphic (agent/type/ts varies)
  decisions: any[];
  followUps: any[][];   // array of message arrays
  createdAt: string;
  updatedAt?: string | null;
}

function mapAgentSessionRow(r: any): AgentSessionRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  const isoOrNull = (d: any) => d == null ? null : iso(d);
  return {
    id: r.id,
    title: r.title,
    task: r.task,
    status: r.status,
    messages: Array.isArray(r.messages) ? r.messages : [],
    decisions: Array.isArray(r.decisions) ? r.decisions : [],
    followUps: Array.isArray(r.follow_ups) ? r.follow_ups : [],
    createdAt: iso(r.created_at),
    updatedAt: isoOrNull(r.updated_at),
  };
}

const AGENT_SESSION_COLS = `id, title, task, status, messages, decisions,
  follow_ups, created_at, updated_at`;

export async function getAgentSession(id: string): Promise<AgentSessionRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${AGENT_SESSION_COLS} FROM agent_sessions WHERE id = $1 LIMIT 1`,
    [id]
  );
  return mapAgentSessionRow(r.rows[0]);
}

/**
 * Replaces legacy agent_sessions_index store — denormalized list of last N
 * sessions. Native SELECT через idx_agent_sessions_recent — race-free и
 * always consistent с актуальной таблицей.
 */
export async function listAgentSessionSummaries(limit: number = 100): Promise<Array<{
  id: string; title: string; createdAt: string;
}>> {
  const { pool } = await import('./db-client.tsx');
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const r = await pool.query(
    `SELECT id, title, created_at FROM agent_sessions
      ORDER BY created_at DESC LIMIT ${safeLimit}`
  );
  return r.rows.map(row => ({
    id: row.id, title: row.title,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

export async function insertAgentSession(session: AgentSessionRow): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO agent_sessions
       (id, title, task, status, messages, decisions, follow_ups, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
             COALESCE($8::timestamptz, NOW()),
             COALESCE($9::timestamptz, NOW()))`,
    [
      session.id, session.title, session.task, session.status || 'completed',
      JSON.stringify(session.messages || []),
      JSON.stringify(session.decisions || []),
      JSON.stringify(session.followUps || []),
      session.createdAt ?? null,
      session.updatedAt ?? null,
    ]
  );
}

/**
 * Atomic append к follow_ups + decisions через UPDATE ... = jsonb || ...
 * Race-free vs legacy get→mutate→set паттерн в POST /sessions/:id/continue.
 * 2 concurrent follow-up calls обе сохранят свои messages без потери.
 */
export async function appendAgentSessionFollowUp(
  id: string, messages: any[], newDecisions: any[],
): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE agent_sessions
        SET follow_ups = follow_ups || $2::jsonb,
            decisions  = decisions  || $3::jsonb,
            updated_at = NOW()
      WHERE id = $1`,
    [id, JSON.stringify([messages]), JSON.stringify(newDecisions)]
  );
}

export async function deleteAgentSession(id: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(`DELETE FROM agent_sessions WHERE id = $1`, [id]);
}
// agent_queue → agent_tasks (row-per-task, migration 036). Доступ через
// pool.query в agents-routes.tsx.
// artist_analytics_cache переехал на pool.query с native expires_at TTL
// (migration 041). Доступ — artist-analytics-routes.tsx.
// artist_tracks_stats — orphan, DROP TABLE (migration 041, declaration
// удалена).
// notificationCampaignsStore: migration 049 promoted всё к native cols.
// Доступ — через getNotificationCampaign / listNotificationCampaigns /
// upsertNotificationCampaign / deleteNotificationCampaign helpers (см.
// блок "Notification Campaigns" ниже).
// notificationSettingsKvStore — DROPPED (0 callers; notification_settings
// доступ через `getNotificationSettings` / `upsertNotificationSettings`
// функции в db.tsx).
// system_config — typed access since this PR. Legit key/value semantics
// (boot status flags, APK release metadata, etc). Killed KV store wrapper
// pattern через atomic UPSERT.
export async function getSystemConfig<T = any>(key: string): Promise<T | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT data FROM system_config WHERE key = $1 LIMIT 1`, [key]
  );
  if (r.rows.length === 0) return null;
  const raw = r.rows[0].data;
  return (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : raw) as T;
}
export async function upsertSystemConfig(key: string, value: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO system_config (key, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [key, JSON.stringify(value ?? null)]
  );
}
export async function deleteSystemConfig(key: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(`DELETE FROM system_config WHERE key = $1`, [key]);
}
// accountingStore — split на 5 native таблиц (migration 055):
//   accounting_reports / accounting_documents / accounting_ledger /
//   accounting_counterparties / accounting_calendar. Доступ — напрямую
//   через pool.query в payments-routes.tsx. accounting_data таблица
//   оставлена на проде для legacy non-accounting:* keys (если есть).
// guideDataStore — REMOVED (dead store, 0 writers anywhere; only 3 .get reads
// которые возвращали [] / null since data never populated). promo_guide_data
// table candidate для manual DROP via OPERATIONS_LOG.md.
// elevenlabsStore — DROPPED (0 callers AND 0 direct refs к elevenlabs_config
// таблице. Кандидат на DROP TABLE после ручной проверки laptop'ом).
// platform_revenue_log — native cols since migration 084 (см. typed functions ниже).

// ─── platform_revenue_log native (migration 084) ───
// Row-per-revenue-entry. Replaces singleton-array KV store. Atomic INSERT,
// SQL aggregation для stats, индексированный admin listing.

export interface PlatformRevenueRow {
  id: string;
  channel: string;
  description?: string | null;
  grossAmount: number;
  platformRevenue: number;
  payoutAmount: number;
  commissionRate: number;
  payerId?: string | null;
  payerName?: string | null;
  payeeId?: string | null;
  payeeName?: string | null;
  status: string;
  metadata: Record<string, any>;
  createdAt: string;
}

function mapPlatformRevenueRow(r: any): PlatformRevenueRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    channel: r.channel,
    description: r.description ?? null,
    grossAmount: Number(r.gross_amount || 0),
    platformRevenue: Number(r.platform_revenue || 0),
    payoutAmount: Number(r.payout_amount || 0),
    commissionRate: Number(r.commission_rate || 0),
    payerId: r.payer_id ?? null,
    payerName: r.payer_name ?? null,
    payeeId: r.payee_id ?? null,
    payeeName: r.payee_name ?? null,
    status: r.status,
    metadata: r.metadata || {},
    createdAt: iso(r.created_at),
  };
}

const PRL_COLS = `id, channel, description, gross_amount, platform_revenue,
  payout_amount, commission_rate, payer_id, payer_name, payee_id, payee_name,
  status, metadata, created_at`;

export async function insertPlatformRevenueEntry(e: PlatformRevenueRow): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO platform_revenue_log
       (id, channel, description, gross_amount, platform_revenue,
        payout_amount, commission_rate, payer_id, payer_name,
        payee_id, payee_name, status, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,
             COALESCE($14::timestamptz, NOW()))
     ON CONFLICT (id) DO NOTHING`,
    [
      e.id, e.channel, e.description ?? null,
      e.grossAmount || 0, e.platformRevenue || 0, e.payoutAmount || 0,
      e.commissionRate || 0,
      e.payerId ?? null, e.payerName ?? null,
      e.payeeId ?? null, e.payeeName ?? null,
      e.status || 'completed',
      JSON.stringify(e.metadata || {}),
      e.createdAt ?? null,
    ]
  );
}

/**
 * Лист последних N entries — для recentTransactions в stats endpoint.
 */
export async function listPlatformRevenueRecent(limit: number = 50): Promise<PlatformRevenueRow[]> {
  const { pool } = await import('./db-client.tsx');
  const safe = Math.max(1, Math.min(limit, 500));
  const r = await pool.query(
    `SELECT ${PRL_COLS} FROM platform_revenue_log
      ORDER BY created_at DESC LIMIT ${safe}`
  );
  return r.rows.map(mapPlatformRevenueRow).filter((x): x is PlatformRevenueRow => x !== null);
}

/**
 * Filtered + paginated listing для admin /admin/transactions.
 * SQL pushdown заменяет JS filter+sort+slice по entire log array.
 */
export async function listPlatformRevenue(opts: {
  channel?: string; limit?: number; offset?: number;
} = {}): Promise<{ rows: PlatformRevenueRow[]; total: number }> {
  const { pool } = await import('./db-client.tsx');
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const conds: string[] = [];
  const vals: any[] = [];
  if (opts.channel) { conds.push(`channel = $${vals.length + 1}`); vals.push(opts.channel); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const [rowsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT ${PRL_COLS} FROM platform_revenue_log ${where}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      vals,
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM platform_revenue_log ${where}`, vals),
  ]);
  return {
    rows: rowsRes.rows.map(mapPlatformRevenueRow).filter((x): x is PlatformRevenueRow => x !== null),
    total: countRes.rows[0]?.n || 0,
  };
}

/**
 * SQL aggregation для admin dashboard stats. Заменяет JS reduce по entire array.
 */
export async function getPlatformRevenueStats(): Promise<{
  totalGross: number; totalRevenue: number; totalPayouts: number; transactionCount: number;
  byChannel: Array<{ channel: string; count: number; gross: number; revenue: number }>;
}> {
  const { pool } = await import('./db-client.tsx');
  const [totalsRes, channelRes] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(SUM(gross_amount), 0)::numeric AS total_gross,
         COALESCE(SUM(platform_revenue), 0)::numeric AS total_revenue,
         COALESCE(SUM(payout_amount), 0)::numeric AS total_payouts,
         COUNT(*)::int AS tx_count
       FROM platform_revenue_log`
    ),
    pool.query(
      `SELECT channel,
              COUNT(*)::int AS cnt,
              COALESCE(SUM(gross_amount), 0)::numeric AS gross,
              COALESCE(SUM(platform_revenue), 0)::numeric AS revenue
         FROM platform_revenue_log
        GROUP BY channel`
    ),
  ]);
  const t = totalsRes.rows[0] || {};
  return {
    totalGross: Number(t.total_gross || 0),
    totalRevenue: Number(t.total_revenue || 0),
    totalPayouts: Number(t.total_payouts || 0),
    transactionCount: Number(t.tx_count || 0),
    byChannel: channelRes.rows.map(r => ({
      channel: r.channel,
      count: Number(r.cnt || 0),
      gross: Number(r.gross || 0),
      revenue: Number(r.revenue || 0),
    })),
  };
}


// ─── platform_stats typed (anchor: platform_stats typed) ───
// platform_stats — legit key/value cache для pre-computed aggregations
// (platform, artists:popular, genres, chart:weekly:top20, chart:promofm,
// itunes:preview_cache, videos:new_clips, etc). Schema unchanged:
// `id TEXT PK, data JSONB`. Typed atomic UPSERT через ON CONFLICT DO UPDATE.

export async function getPlatformStats<T = any>(key: string): Promise<T | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(`SELECT data FROM platform_stats WHERE id = $1`, [key]);
  return r.rows[0]?.data ?? null;
}

export async function setPlatformStats(key: string, value: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO platform_stats (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}
// track_test_expert_stats — native cols since migration 053 (data column DROPPED).
// trackTestExpertStatsStore wrapper REMOVED — был broken на проде. Доступ через
// typed atomic helpers (см. ниже): getExpertStats, incrementExpertAssigned,
// completeExpertReviewAndReward.
export interface ExpertStatsRow {
  expertId: string;
  totalAssigned: number;
  totalCompleted: number;
  totalCoins: number;
  ratingBonus: number;
  joinedAt: string | null;
}
function mapExpertStatsRow(r: any): ExpertStatsRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    expertId: r.expert_id,
    totalAssigned: Number(r.total_assigned || 0),
    totalCompleted: Number(r.total_completed || 0),
    totalCoins: Number(r.total_coins || 0),
    ratingBonus: Number(r.rating_bonus || 0),
    joinedAt: iso(r.joined_at),
  };
}
export async function getExpertStats(expertId: string): Promise<ExpertStatsRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT expert_id, total_assigned, total_completed, total_coins,
            rating_bonus, joined_at
       FROM track_test_expert_stats WHERE expert_id = $1 LIMIT 1`, [expertId]
  );
  return mapExpertStatsRow(r.rows[0]);
}
/** Atomic +1 на total_assigned. Создаёт row если не существует. */
export async function incrementExpertAssigned(expertId: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO track_test_expert_stats
       (expert_id, total_assigned, joined_at, updated_at)
     VALUES ($1, 1, NOW(), NOW())
     ON CONFLICT (expert_id) DO UPDATE SET
       total_assigned = track_test_expert_stats.total_assigned + 1,
       updated_at = NOW()`,
    [expertId]
  );
}
/**
 * Atomic completion: +1 total_completed, +rewardPoints total_coins,
 * recompute rating_bonus = total_completed * 0.05. Race-free vs legacy
 * get→mutate→set паттерн (concurrent review completions могли терять обновления).
 */
export async function completeExpertReviewAndReward(
  expertId: string, rewardPoints: number,
): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO track_test_expert_stats
       (expert_id, total_completed, total_coins, rating_bonus, joined_at, updated_at)
     VALUES ($1, 1, $2, 0.05, NOW(), NOW())
     ON CONFLICT (expert_id) DO UPDATE SET
       total_completed = track_test_expert_stats.total_completed + 1,
       total_coins     = track_test_expert_stats.total_coins + $2,
       rating_bonus    = ROUND(((track_test_expert_stats.total_completed + 1) * 0.05)::numeric, 2),
       updated_at      = NOW()`,
    [expertId, rewardPoints || 50]
  );
}
// trackModerationStore DELETED — 0 callers. track_moderation пишется
// напрямую через pool.query в src/ai-check.tsx (после migration 052 —
// все native cols, jsonb остаётся только в ai_check_result).
// ─── news_public (native cols since migration 077) ───
// Public news feed. Pipeline writer + admin moderation + sitemap + content-health.

export interface NewsPublicRow {
  id: string;
  title: string;
  excerpt: string;
  content: string;
  category: string;
  tags: string[];
  source: string;
  sourceId?: string | null;
  sourceUrl?: string | null;
  imageUrl?: string | null;
  authorName?: string | null;
  authorAvatar?: string | null;
  publishedAt: string;
  processedAt?: string | null;
  status: string;       // 'pending' | 'published' | 'rejected'
  createdAt: string;
  updatedAt?: string | null;
}

function mapNewsPublicRow(r: any): NewsPublicRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  const isoOrNull = (d: any) => d == null ? null : iso(d);
  return {
    id: r.id,
    title: r.title,
    excerpt: r.excerpt || '',
    content: r.content || '',
    category: r.category,
    tags: r.tags || [],
    source: r.source,
    sourceId: r.source_id,
    sourceUrl: r.source_url,
    imageUrl: r.image_url,
    authorName: r.author_name,
    authorAvatar: r.author_avatar,
    publishedAt: iso(r.published_at),
    processedAt: isoOrNull(r.processed_at),
    status: r.status,
    createdAt: iso(r.created_at),
    updatedAt: isoOrNull(r.updated_at),
  };
}

const NEWS_PUBLIC_COLS = `id, title, excerpt, content, category, tags, source,
  source_id, source_url, image_url, author_name, author_avatar,
  published_at, processed_at, status, created_at, updated_at`;

export async function getNewsPublic(id: string): Promise<NewsPublicRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${NEWS_PUBLIC_COLS} FROM news_public WHERE id = $1 LIMIT 1`,
    [id]
  );
  return mapNewsPublicRow(r.rows[0]);
}

export interface ListNewsPublicOpts {
  status?: string;       // 'published' default
  tag?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

/**
 * Listing с SQL filter + sort pushdown. Default — published only,
 * sorted by published_at DESC. Hits idx_news_public_published.
 */
export async function listNewsPublic(opts: ListNewsPublicOpts = {}): Promise<NewsPublicRow[]> {
  const { pool } = await import('./db-client.tsx');
  const where: string[] = [];
  const params: any[] = [];
  let i = 1;

  if (opts.status !== '*') {
    const status = opts.status || 'published';
    where.push(`status = $${i++}`); params.push(status);
  }
  if (opts.tag)    { where.push(`$${i++} = ANY(tags)`); params.push(opts.tag); }
  if (opts.source) { where.push(`source = $${i++}`);    params.push(opts.source); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);

  const r = await pool.query(
    `SELECT ${NEWS_PUBLIC_COLS} FROM news_public
      ${whereSql}
      ORDER BY published_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return r.rows.map(mapNewsPublicRow).filter((x): x is NewsPublicRow => x !== null);
}

/**
 * Return ALL news (for pipeline health monitoring + sitemap generation).
 * No filter — caller filters in-memory. Не hot-path (вызывается раз в
 * минут от cron'ов мониторинга).
 */
export async function listAllNewsPublic(): Promise<NewsPublicRow[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${NEWS_PUBLIC_COLS} FROM news_public ORDER BY published_at DESC`
  );
  return r.rows.map(mapNewsPublicRow).filter((x): x is NewsPublicRow => x !== null);
}

export async function upsertNewsPublic(news: Partial<NewsPublicRow> & { id: string; title: string }): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO news_public
       (id, title, excerpt, content, category, tags, source, source_id,
        source_url, image_url, author_name, author_avatar,
        published_at, processed_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             COALESCE($13::timestamptz, NOW()), $14::timestamptz, $15)
     ON CONFLICT (id) DO UPDATE SET
       title         = EXCLUDED.title,
       excerpt       = EXCLUDED.excerpt,
       content       = EXCLUDED.content,
       category      = EXCLUDED.category,
       tags          = EXCLUDED.tags,
       source        = EXCLUDED.source,
       source_id     = EXCLUDED.source_id,
       source_url    = EXCLUDED.source_url,
       image_url     = EXCLUDED.image_url,
       author_name   = EXCLUDED.author_name,
       author_avatar = EXCLUDED.author_avatar,
       published_at  = EXCLUDED.published_at,
       processed_at  = EXCLUDED.processed_at,
       status        = EXCLUDED.status,
       updated_at    = NOW()`,
    [
      news.id, news.title, news.excerpt || '', news.content || '',
      news.category || 'industry', news.tags || [], news.source || '',
      news.sourceId || null, news.sourceUrl || null, news.imageUrl || null,
      news.authorName || null, news.authorAvatar || null,
      news.publishedAt || null, news.processedAt || null,
      news.status || 'published',
    ]
  );
}

export async function deleteNewsPublic(id: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(`DELETE FROM news_public WHERE id = $1`, [id]);
}
// contactFormsStore — DROPPED (0 callers; `contact_forms` table читается
// напрямую через pool.query в landing-data-routes.tsx).
// investor_inquiries — native cols since migration 072 (data jsonb dropped).
// Single writer: POST /landing-data/investor-inquiry. Readers — admin reads
// через psql напрямую (нет UI пока); если появится — добавить
// listInvestorInquiries({ status, limit }) рядом.

export interface InvestorInquiry {
  id: string;
  name: string;
  email: string;
  company: string;
  message: string;
  status: string;
  createdAt: string;
}

function mapInvestorInquiryRow(r: any): InvestorInquiry | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    company: r.company,
    message: r.message,
    status: r.status,
    createdAt: iso(r.created_at),
  };
}

/**
 * Insert lead form submission. Returns the created row (с auto-generated
 * id если caller не передал). Defaults: company='', message='', status='new'.
 */
export async function createInvestorInquiry(input: {
  name: string;
  email: string;
  company?: string;
  message?: string;
}): Promise<InvestorInquiry> {
  const { pool } = await import('./db-client.tsx');
  const id = `investor-${crypto.randomUUID()}`;
  const r = await pool.query(
    `INSERT INTO investor_inquiries (id, name, email, company, message, status)
     VALUES ($1, $2, $3, $4, $5, 'new')
     RETURNING id, name, email, company, message, status, created_at`,
    [
      id,
      input.name,
      input.email,
      input.company || '',
      input.message || 'Прошу направить инвестиционную презентацию.',
    ],
  );
  return mapInvestorInquiryRow(r.rows[0])!;
}
// djEditorProfileStore — DROPPED (0 callers; `dj_editor_profiles` доступ
// напрямую через pool.query). DO NOT re-add (was previously removed by #73
// dead-stores cleanup).
//
// concert_agent_data — native cols (migration 067, renumbered from 061
// pre-rebase). Store DELETED. Доступ — типизированные функции ниже.

const CONCERT_AGENT_COLS = `id, source_id, source_name, title, artist, venue,
  city, event_date, event_time, price, ticket_url, image_url, description,
  genre, status, extra, created_at, updated_at`;

function mapConcertAgentRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  // event_date is DATE — return as 'YYYY-MM-DD' string.
  const dateStr = r.event_date instanceof Date
    ? r.event_date.toISOString().split('T')[0]
    : (r.event_date ? String(r.event_date) : '');
  return {
    id: r.id,
    sourceId: r.source_id,
    source: r.source_name,
    title: r.title || '',
    artist: r.artist || '',
    venue: r.venue || '',
    city: r.city || '',
    date: dateStr,
    time: r.event_time || '',
    price: r.price || '',
    ticketUrl: r.ticket_url || '',
    imageUrl: r.image_url || '',
    description: r.description || '',
    genre: r.genre || '',
    status: r.status,
    createdAt: iso(r.created_at),
    ...(r.extra || {}),
  };
}

export async function getConcertAgentItem(id: string): Promise<any | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${CONCERT_AGENT_COLS} FROM concert_agent_data WHERE id = $1 LIMIT 1`,
    [id]
  );
  return r.rowCount ? mapConcertAgentRow(r.rows[0]) : null;
}

export async function upsertConcertAgentItem(id: string, concert: Record<string, any>): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  const extra = { ...concert };
  ['id','sourceId','source','title','artist','venue','city','date','time',
   'price','ticketUrl','imageUrl','description','genre','status',
   'createdAt','updatedAt'].forEach(k => delete extra[k]);
  await pool.query(
    `INSERT INTO concert_agent_data
       (id, source_id, source_name, title, artist, venue, city, event_date,
        event_time, price, ticket_url, image_url, description, genre,
        status, extra, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, '')::date,
             $9, $10, $11, $12, $13, $14,
             $15, $16::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       source_id   = EXCLUDED.source_id,
       source_name = EXCLUDED.source_name,
       title       = EXCLUDED.title,
       artist      = EXCLUDED.artist,
       venue       = EXCLUDED.venue,
       city        = EXCLUDED.city,
       event_date  = EXCLUDED.event_date,
       event_time  = EXCLUDED.event_time,
       price       = EXCLUDED.price,
       ticket_url  = EXCLUDED.ticket_url,
       image_url   = EXCLUDED.image_url,
       description = EXCLUDED.description,
       genre       = EXCLUDED.genre,
       status      = EXCLUDED.status,
       extra       = EXCLUDED.extra,
       updated_at  = NOW()`,
    [
      id,
      concert.sourceId || null, concert.source || null,
      concert.title || '', concert.artist || '', concert.venue || '',
      concert.city || '',
      concert.date || '',
      concert.time || '', concert.price || '', concert.ticketUrl || '',
      concert.imageUrl || '', concert.description || '', concert.genre || '',
      concert.status || 'published',
      JSON.stringify(extra),
    ]
  );
}

export async function deleteConcertAgentItem(id: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(`DELETE FROM concert_agent_data WHERE id = $1`, [id]);
}

export async function listConcertAgentItems(opts: {
  status?: string;
  city?: string;
  dateFrom?: string;  // 'YYYY-MM-DD' inclusive
  limit?: number;
} = {}): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const where: string[] = [];
  const params: any[] = [];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.city)   { params.push(opts.city);   where.push(`city = $${params.length}`); }
  if (opts.dateFrom) {
    params.push(opts.dateFrom);
    where.push(`(event_date IS NULL OR event_date >= $${params.length}::date)`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limitSql = opts.limit ? `LIMIT ${Math.max(1, Math.min(opts.limit, 1000))}` : '';
  const r = await pool.query(
    `SELECT ${CONCERT_AGENT_COLS} FROM concert_agent_data
       ${whereSql}
       ORDER BY event_date ASC NULLS LAST, created_at DESC
       ${limitSql}`,
    params
  );
  return r.rows.map(mapConcertAgentRow);
}

export async function getConcertAgentStats(): Promise<{
  total: number; published: number; upcoming: number;
  bySource: Record<string, number>; byCity: Record<string, number>;
}> {
  const { pool } = await import('./db-client.tsx');
  const today = new Date().toISOString().split('T')[0];
  const [tot, src, cty] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'published')::int AS published,
         COUNT(*) FILTER (WHERE status = 'published'
                           AND (event_date IS NULL OR event_date >= $1::date))::int AS upcoming
       FROM concert_agent_data`,
      [today]
    ),
    pool.query(
      `SELECT COALESCE(source_id, 'unknown') AS k, COUNT(*)::int AS n
         FROM concert_agent_data WHERE status = 'published'
        GROUP BY COALESCE(source_id, 'unknown')`
    ),
    pool.query(
      `SELECT COALESCE(city, 'unknown') AS k, COUNT(*)::int AS n
         FROM concert_agent_data
        WHERE status = 'published'
          AND (event_date IS NULL OR event_date >= $1::date)
        GROUP BY COALESCE(city, 'unknown')`,
      [today]
    ),
  ]);
  const bySource: Record<string, number> = {};
  for (const row of src.rows) bySource[row.k] = Number(row.n);
  const byCity: Record<string, number> = {};
  for (const row of cty.rows) byCity[row.k] = Number(row.n);
  const t = tot.rows[0] || {};
  return {
    total: Number(t.total || 0),
    published: Number(t.published || 0),
    upcoming: Number(t.upcoming || 0),
    bySource,
    byCity,
  };
}

// verification_tokens — native cols since migration 004; data jsonb
// dropped в migration 070 вместе с sync trigger. Store wrapper удалён.
// curator_reports — native cols since migration 074; latest-pointer dual-write
// убрано в пользу indexed SELECT (mapCuratorReportRow + insertCuratorReport ниже).

export interface VerificationTokenRow {
  token: string;
  userId: string;
  tokenType: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

function mapVerificationTokenRow(r: any): VerificationTokenRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    token: r.id,
    userId: r.user_id,
    tokenType: r.token_type,
    expiresAt: iso(r.expires_at) || '',
    usedAt: iso(r.used_at),
    createdAt: iso(r.created_at) || '',
  };
}

export async function insertVerificationToken(params: {
  token: string;
  userId: string;
  tokenType?: string;
  expiresAt: string;
}): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO verification_tokens (id, user_id, token_type, expires_at, created_at)
     VALUES ($1, $2, $3, $4::timestamptz, NOW())
     ON CONFLICT (id) DO UPDATE SET
       user_id    = EXCLUDED.user_id,
       token_type = EXCLUDED.token_type,
       expires_at = EXCLUDED.expires_at`,
    [params.token, params.userId, params.tokenType || 'email_verify', params.expiresAt]
  );
}

// curator_reports — native cols since migration 074. Legacy dual-write
// (id row + 'latest:<role>' pointer row) replaced одним INSERT —
// "latest per role" вычисляется через SELECT ORDER BY completed_at DESC
// LIMIT 1 на index. См. typed functions ниже.

export interface CuratorReportRow {
  id: string;
  role: string;
  roleName: string;
  startedAt: string;
  completedAt: string;
  totalEndpoints: number;
  passed: number;
  failed: number;
  warnings: number;
  setupDone: boolean;
  summary: string;
  results: any[];   // CuratorReportResult[] — legit polymorphic per CLAUDE.md
}

function mapCuratorReportRow(r: any): CuratorReportRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    role: r.role,
    roleName: r.role_name,
    startedAt: iso(r.started_at),
    completedAt: iso(r.completed_at),
    totalEndpoints: r.total_endpoints,
    passed: r.passed,
    failed: r.failed,
    warnings: r.warnings,
    setupDone: !!r.setup_done,
    summary: r.summary,
    results: r.results || [],
  };
}

const CURATOR_REPORT_COLS = `id, role, role_name, started_at, completed_at,
  total_endpoints, passed, failed, warnings, setup_done, summary, results`;

export async function insertCuratorReport(report: CuratorReportRow): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO curator_reports
       (id, role, role_name, started_at, completed_at, total_endpoints,
        passed, failed, warnings, setup_done, summary, results)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       role            = EXCLUDED.role,
       role_name       = EXCLUDED.role_name,
       started_at      = EXCLUDED.started_at,
       completed_at    = EXCLUDED.completed_at,
       total_endpoints = EXCLUDED.total_endpoints,
       passed          = EXCLUDED.passed,
       failed          = EXCLUDED.failed,
       warnings        = EXCLUDED.warnings,
       setup_done      = EXCLUDED.setup_done,
       summary         = EXCLUDED.summary,
       results         = EXCLUDED.results`,
    [
      report.id, report.role, report.roleName,
      report.startedAt, report.completedAt,
      report.totalEndpoints, report.passed, report.failed, report.warnings,
      report.setupDone, report.summary,
      JSON.stringify(report.results || []),
    ]
  );
}

/**
 * Lookup token — returns row только если token валиден (не expired,
 * не used). Сразу инкапсулирует все 3 валидационных gate которые
 * раньше handler делал вручную после .get + checks.
 */
export async function getVerificationToken(token: string): Promise<VerificationTokenRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT id, user_id, token_type, expires_at, used_at, created_at
       FROM verification_tokens
      WHERE id = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [token]
  );
  return mapVerificationTokenRow(r.rows[0]);
}

/**
 * Atomic mark-used: UPDATE ... WHERE used_at IS NULL AND expires_at > NOW().
 * Returns true только если row был валидным и теперь помечен. False если
 * token не существует, истёк, или уже использован — race-free для replay
 * attempts на одну и ту же ссылку (раньше get+set с window'ом между).
 */
export async function markVerificationTokenUsed(token: string): Promise<boolean> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `UPDATE verification_tokens
        SET used_at = NOW()
      WHERE id = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING id`,
    [token]
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Latest report per role via indexed SELECT — replaces legacy
 * 'latest:<role>' pointer-row pattern. Hot path: GET /curator/report/:roleId.
 */
export async function getLatestCuratorReport(role: string): Promise<CuratorReportRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${CURATOR_REPORT_COLS} FROM curator_reports
      WHERE role = $1
      ORDER BY completed_at DESC
      LIMIT 1`,
    [role]
  );
  return mapCuratorReportRow(r.rows[0]);
}

/**
 * History list (admin browse). Default limit 50 mirrors legacy handler.
 */
export async function listCuratorReports(limit: number = 50): Promise<CuratorReportRow[]> {
  const { pool } = await import('./db-client.tsx');
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const r = await pool.query(
    `SELECT ${CURATOR_REPORT_COLS} FROM curator_reports
      ORDER BY completed_at DESC
      LIMIT ${safeLimit}`
  );
  return r.rows.map(mapCuratorReportRow).filter((x): x is CuratorReportRow => x !== null);
}

// ─── Coin Transactions (specific table) ───

export async function getCoinTransactionsKv(userId: string) {
  const { data, error } = await db()
    .from('coin_transactions')
    .select('*')
    .eq('artist_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getCoinTransactionsKv:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function createCoinTransactionKv(userId: string, txId: string, tx: Record<string, any>) {
  const { error } = await db()
    .from('coin_transactions')
    .upsert({
      id: txId, artist_id: userId,
      transaction_type: tx.type || tx.transaction_type || 'credit',
      amount: tx.amount || 0, balance_before: tx.balance_before || 0, balance_after: tx.balance_after || 0,
      description: tx.description || '', metadata: tx.metadata ? JSON.stringify(tx.metadata) : '{}',
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
  if (error) console.error('[db] createCoinTransactionKv:', error);
}

// ─── Radio Ad Slots (row-per-slot, native cols since migration 050) ───

const RADIO_AD_SLOT_COLS = `id, radio_id, slot_type, time_slot, price, duration,
  max_per_hour, description, status, created_at, updated_at`;

function mapRadioAdSlotRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  // Preserve historical camelCase API contract (frontend reads slotType/timeSlot/etc).
  return {
    id: r.id,
    stationId: r.radio_id,
    slotType: r.slot_type || 'standard',
    timeSlot: r.time_slot || '',
    price: Number(r.price || 0),
    duration: Number(r.duration || 30),
    maxPerHour: Number(r.max_per_hour || 4),
    description: r.description || '',
    status: r.status || 'available',
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function getRadioAdSlot(radioId: string, slotId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${RADIO_AD_SLOT_COLS} FROM radio_ad_slots
      WHERE radio_id = $1 AND id = $2 LIMIT 1`,
    [radioId, slotId]
  );
  return r.rowCount ? mapRadioAdSlotRow(r.rows[0]) : null;
}

export async function listRadioAdSlotsByStation(radioId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${RADIO_AD_SLOT_COLS} FROM radio_ad_slots
      WHERE radio_id = $1
      ORDER BY created_at DESC`,
    [radioId]
  );
  return r.rows.map(mapRadioAdSlotRow);
}

export async function countRadioAdSlots(radioId: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM radio_ad_slots WHERE radio_id = $1`,
    [radioId]
  );
  return Number(r.rows[0]?.n || 0);
}

export async function upsertRadioAdSlot(radioId: string, slotId: string, slot: Record<string, any>) {
  // Row-per-slot (migration 050): native cols only, no data jsonb,
  // no separate radio_ad_slot_index table.
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO radio_ad_slots (
       id, radio_id, slot_type, time_slot, price, duration,
       max_per_hour, description, status, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (id) DO UPDATE SET
       radio_id     = COALESCE(EXCLUDED.radio_id, radio_ad_slots.radio_id),
       slot_type    = EXCLUDED.slot_type,
       time_slot    = EXCLUDED.time_slot,
       price        = EXCLUDED.price,
       duration     = EXCLUDED.duration,
       max_per_hour = EXCLUDED.max_per_hour,
       description  = EXCLUDED.description,
       status       = EXCLUDED.status,
       updated_at   = NOW()`,
    [
      slotId,
      radioId,
      slot.slotType || slot.slot_type || 'standard',
      slot.timeSlot || slot.time_slot || null,
      Number(slot.price ?? 0),
      Number(slot.duration ?? 30),
      Number(slot.maxPerHour ?? slot.max_per_hour ?? 4),
      slot.description || '',
      slot.status || 'available',
    ]
  );
}

export async function deleteRadioAdSlot(radioId: string, slotId: string): Promise<number> {
  // Composite WHERE — closes the IDOR present in the legacy
  // radioAdSlotsStore.del(slotId) call (no radio_id check).
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `DELETE FROM radio_ad_slots WHERE radio_id = $1 AND id = $2`,
    [radioId, slotId]
  );
  return r.rowCount || 0;
}

// ─── Ticket Providers / Sales (compound key) ───

export async function getTicketProvidersByConcert(concertId: string) {
  const { data, error } = await db()
    .from('ticket_providers')
    .select('*')
    .eq('concert_id', concertId);
  if (error) console.error('[db] getTicketProvidersByConcert:', error);
  return (data || []).map((r: any) => r.data ?? r);
}

export async function upsertTicketProvider(concertId: string, providerId: string, provider: Record<string, any>) {
  const { error } = await db()
    .from('ticket_providers')
    .upsert({ id: providerId, concert_id: concertId, data: provider, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) console.error('[db] upsertTicketProvider:', error);
}

// ─── ticket_sales (native cols since migration 083) ───

export interface TicketSaleRow {
  id: string;
  concertId: string;
  artistId?: string | null;
  provider: string;
  quantity: number;
  price: number;
  totalAmount: number;
  commission: number;
  netAmount: number;
  buyerEmail?: string | null;
  status: string;
  purchasedAt: string;
  metadata: Record<string, any>;
}

function mapTicketSaleRow(r: any): TicketSaleRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    concertId: r.concert_id,
    artistId: r.artist_id ?? null,
    provider: r.provider,
    quantity: Number(r.quantity || 0),
    price: Number(r.price || 0),
    totalAmount: Number(r.total_amount || 0),
    commission: Number(r.commission || 0),
    netAmount: Number(r.net_amount || 0),
    buyerEmail: r.buyer_email ?? null,
    status: r.status,
    purchasedAt: iso(r.purchased_at),
    metadata: r.metadata || {},
  };
}

const TICKET_SALE_COLS = `id, concert_id, artist_id, provider, quantity, price,
  total_amount, commission, net_amount, buyer_email, status, purchased_at, metadata`;

export async function getTicketSale(id: string): Promise<TicketSaleRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${TICKET_SALE_COLS} FROM ticket_sales WHERE id = $1 LIMIT 1`, [id]
  );
  return mapTicketSaleRow(r.rows[0]);
}

export async function getTicketSalesByConcert(concertId: string): Promise<TicketSaleRow[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${TICKET_SALE_COLS} FROM ticket_sales
      WHERE concert_id = $1 ORDER BY purchased_at DESC`, [concertId]
  );
  return r.rows.map(mapTicketSaleRow).filter((x): x is TicketSaleRow => x !== null);
}

export async function upsertTicketSale(sale: TicketSaleRow): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO ticket_sales
       (id, concert_id, artist_id, provider, quantity, price, total_amount,
        commission, net_amount, buyer_email, status, purchased_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             COALESCE($12::timestamptz, NOW()), $13::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       concert_id   = EXCLUDED.concert_id,
       artist_id    = EXCLUDED.artist_id,
       provider     = EXCLUDED.provider,
       quantity     = EXCLUDED.quantity,
       price        = EXCLUDED.price,
       total_amount = EXCLUDED.total_amount,
       commission   = EXCLUDED.commission,
       net_amount   = EXCLUDED.net_amount,
       buyer_email  = EXCLUDED.buyer_email,
       status       = EXCLUDED.status,
       purchased_at = EXCLUDED.purchased_at,
       metadata     = EXCLUDED.metadata,
       updated_at   = NOW()`,
    [
      sale.id, sale.concertId, sale.artistId ?? null,
      sale.provider || 'manual', sale.quantity || 0, sale.price || 0,
      sale.totalAmount || 0, sale.commission || 0, sale.netAmount || 0,
      sale.buyerEmail ?? null, sale.status || 'confirmed',
      sale.purchasedAt ?? null, JSON.stringify(sale.metadata || {}),
    ]
  );
}

/**
 * Atomic single-statement status update — race-free vs legacy get→mutate→upsert.
 */
export async function updateTicketSaleStatus(id: string, status: string): Promise<TicketSaleRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `UPDATE ticket_sales SET status = $2, updated_at = NOW()
      WHERE id = $1 RETURNING ${TICKET_SALE_COLS}`,
    [id, status]
  );
  return mapTicketSaleRow(r.rows[0]);
}

// ─── Beat Reviews (native cols since migration 066) ───
// PK = review.id (TEXT, format 'brev-...'). UNIQUE (beat_id, user_id) —
// DB-level constraint предотвращает 2 отзыва от одного user'а на 1 beat.

const BEAT_REVIEW_COLS = `id, beat_id, user_id, user_name, rating, title,
  review_text, license_type, helpful_count, helpful_users,
  created_at, updated_at`;

function mapBeatReviewRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    beatId: r.beat_id,
    userId: r.user_id,
    userName: r.user_name || 'Покупатель',
    rating: Number(r.rating || 0),
    title: r.title || '',
    text: r.review_text || '',
    licenseType: r.license_type || 'basic',
    helpful: Number(r.helpful_count || 0),
    helpfulUsers: r.helpful_users || [],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

// Legacy signature preserved: getBeatReview(beatId, reviewId) — callers
// в marketplace-routes.tsx уже передают reviewId (несмотря на парам name).
// id = review id (TEXT 'brev-...'). beatId — для belt-and-suspenders проверки.
export async function getBeatReview(beatId: string, reviewId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${BEAT_REVIEW_COLS} FROM beat_reviews
      WHERE id = $1 AND beat_id = $2 LIMIT 1`,
    [reviewId, beatId]
  );
  return r.rowCount ? mapBeatReviewRow(r.rows[0]) : null;
}

export async function upsertBeatReview(beatId: string, reviewId: string, review: Record<string, any> | string) {
  const { pool } = await import('./db-client.tsx');
  const rev: any = typeof review === 'string' ? JSON.parse(review) : review;
  const helpfulUsers = Array.isArray(rev.helpfulUsers) ? rev.helpfulUsers : [];
  await pool.query(
    `INSERT INTO beat_reviews
       (id, beat_id, user_id, user_name, rating, title, review_text,
        license_type, helpful_count, helpful_users, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
             COALESCE($11::timestamptz, NOW()), NOW())
     ON CONFLICT (id) DO UPDATE SET
       beat_id       = COALESCE(EXCLUDED.beat_id, beat_reviews.beat_id),
       user_id       = COALESCE(EXCLUDED.user_id, beat_reviews.user_id),
       user_name     = EXCLUDED.user_name,
       rating        = EXCLUDED.rating,
       title         = EXCLUDED.title,
       review_text   = EXCLUDED.review_text,
       license_type  = EXCLUDED.license_type,
       helpful_count = EXCLUDED.helpful_count,
       helpful_users = EXCLUDED.helpful_users,
       updated_at    = NOW()`,
    [
      reviewId,
      beatId,
      rev.userId || null,
      rev.userName || 'Покупатель',
      Number(rev.rating || 0),
      rev.title || '',
      rev.text || '',
      rev.licenseType || 'basic',
      Number(rev.helpful || 0),
      JSON.stringify(helpfulUsers),
      rev.createdAt || null,
    ]
  );
}

export async function listBeatReviewsByBeat(beatId: string, opts: { limit?: number; offset?: number } = {}): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const r = await pool.query(
    `SELECT ${BEAT_REVIEW_COLS} FROM beat_reviews
      WHERE beat_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [beatId, limit, offset]
  );
  return r.rows.map(mapBeatReviewRow);
}

export async function getBeatReviewsAggregateStats(beatId: string): Promise<{
  total: number; avgRating: number; distribution: Record<number, number>;
}> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT
       COUNT(*)::int                                                       AS total,
       COALESCE(AVG(rating)::numeric, 0)                                   AS avg_rating,
       COUNT(*) FILTER (WHERE rating = 1)::int                             AS r1,
       COUNT(*) FILTER (WHERE rating = 2)::int                             AS r2,
       COUNT(*) FILTER (WHERE rating = 3)::int                             AS r3,
       COUNT(*) FILTER (WHERE rating = 4)::int                             AS r4,
       COUNT(*) FILTER (WHERE rating = 5)::int                             AS r5
     FROM beat_reviews
     WHERE beat_id = $1`,
    [beatId]
  );
  const row = r.rows[0] || {};
  return {
    total: Number(row.total || 0),
    avgRating: Number(Number(row.avg_rating || 0).toFixed(1)),
    distribution: {
      1: Number(row.r1 || 0), 2: Number(row.r2 || 0), 3: Number(row.r3 || 0),
      4: Number(row.r4 || 0), 5: Number(row.r5 || 0),
    },
  };
}

export async function listAllBeatReviews(): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${BEAT_REVIEW_COLS} FROM beat_reviews ORDER BY created_at DESC`
  );
  return r.rows.map(mapBeatReviewRow);
}

export async function findBeatReviewByUser(beatId: string, userId: string): Promise<any | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${BEAT_REVIEW_COLS} FROM beat_reviews
      WHERE beat_id = $1 AND user_id = $2 LIMIT 1`,
    [beatId, userId]
  );
  return r.rowCount ? mapBeatReviewRow(r.rows[0]) : null;
}

// ─── CCN (Cross-Cabinet Notifications) — native SQL ───

export async function getCcnByUser(userId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT id, sender_id, sender_role, recipient_id, recipient_role, type, title, message, link,
            is_read, data, created_at
     FROM cross_cabinet_notifications
     WHERE target_user_id = $1 OR recipient_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows.map((row: any) => ({
    id: row.id,
    sourceUserId: row.sender_id,
    sourceRole: row.sender_role,
    targetUserId: row.recipient_id || userId,
    targetRole: row.recipient_role,
    type: row.type,
    title: row.title || '',
    message: row.message || '',
    link: row.link || undefined,
    metadata: row.data || {},
    read: !!row.is_read,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
  }));
}

export async function upsertCcn(userId: string, notifId: string, notif: Record<string, any>) {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO cross_cabinet_notifications
       (id, sender_id, sender_role, recipient_id, recipient_role, target_user_id, type, title, message, link, is_read, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $4, $6, $7, $8, $9, $10, $11::jsonb, COALESCE($12::timestamptz, NOW()))
     ON CONFLICT (id) DO UPDATE SET
       is_read = EXCLUDED.is_read,
       title = COALESCE(EXCLUDED.title, cross_cabinet_notifications.title),
       message = COALESCE(EXCLUDED.message, cross_cabinet_notifications.message),
       data = COALESCE(EXCLUDED.data, cross_cabinet_notifications.data)`,
    [
      notifId,
      notif.sourceUserId || null,
      notif.sourceRole || null,
      userId,
      notif.targetRole || null,
      notif.type || 'info',
      notif.title || '',
      notif.message || '',
      notif.link || null,
      !!notif.read,
      JSON.stringify(notif.metadata || {}),
      notif.createdAt || null,
    ]
  );
}

export async function getCcnUnreadCount(userId: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT COUNT(*)::int as count FROM cross_cabinet_notifications
     WHERE (target_user_id = $1 OR recipient_id = $1) AND is_read = false`,
    [userId]
  );
  return r.rows[0]?.count ?? 0;
}

// kept for backwards compat - now no-op since unread is computed
export async function setCcnUnreadCount(_userId: string, _count: number) {
  // Counter is now derived from cross_cabinet_notifications.is_read column.
  // Function preserved as no-op to avoid breaking callers.
}

// ─── Notification Campaigns (row-per-campaign, full native cols since migration 049) ───

const NCAMP_NATIVE_COLS = `id, user_id, campaign_name, artist_name, description,
  start_date, end_date, budget_preference, custom_budget, base_price, final_price,
  discount_applied, status, rejection_reason, content_ids, channels, target_audience,
  additional_materials, approved_at, rejected_at, launched_at, created_at, updated_at`;

function mapNCampRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: r.id,
    user_id: r.user_id,
    campaign_name: r.campaign_name || '',
    artist_name: r.artist_name || '',
    description: r.description || '',
    start_date: iso(r.start_date),
    end_date: iso(r.end_date),
    budget_preference: r.budget_preference || 'medium',
    custom_budget: Number(r.custom_budget || 0),
    base_price: Number(r.base_price || 0),
    final_price: Number(r.final_price || 0),
    discount_applied: Number(r.discount_applied || 0),
    status: r.status || 'pending_review',
    rejection_reason: r.rejection_reason || null,
    content_ids: r.content_ids || [],
    channels: r.channels || [],
    target_audience: r.target_audience || {},
    additional_materials: r.additional_materials || {},
    approved_at: iso(r.approved_at),
    rejected_at: iso(r.rejected_at),
    launched_at: iso(r.launched_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export async function getNotificationCampaignsByUser(userId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${NCAMP_NATIVE_COLS} FROM notification_campaigns
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows.map(mapNCampRow);
}

export async function getNotificationCampaign(campaignId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${NCAMP_NATIVE_COLS} FROM notification_campaigns WHERE id = $1 LIMIT 1`,
    [campaignId]
  );
  return r.rowCount ? mapNCampRow(r.rows[0]) : null;
}

export async function listNotificationCampaigns(opts: { status?: string } = {}) {
  const { pool } = await import('./db-client.tsx');
  const params: any[] = [];
  let where = '';
  if (opts.status) {
    params.push(opts.status);
    where = `WHERE status = $${params.length}`;
  }
  const r = await pool.query(
    `SELECT ${NCAMP_NATIVE_COLS} FROM notification_campaigns
       ${where}
       ORDER BY created_at DESC`,
    params
  );
  return r.rows.map(mapNCampRow);
}

export async function deleteNotificationCampaign(campaignId: string) {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `DELETE FROM notification_campaigns WHERE id = $1`,
    [campaignId]
  );
  return r.rowCount || 0;
}

export async function upsertNotificationCampaign(userId: string, campaignId: string, campaign: Record<string, any>) {
  // Row-per-campaign (migration 049): native cols only, no data jsonb.
  const { pool } = await import('./db-client.tsx');
  const content_ids = Array.isArray(campaign.content_ids) ? campaign.content_ids : [];
  const channels = Array.isArray(campaign.channels) ? campaign.channels : [];
  const target_audience = campaign.target_audience && typeof campaign.target_audience === 'object' ? campaign.target_audience : {};
  const additional_materials = campaign.additional_materials && typeof campaign.additional_materials === 'object' ? campaign.additional_materials : {};

  await pool.query(
    `INSERT INTO notification_campaigns (
       id, user_id, campaign_name, artist_name, description,
       start_date, end_date, budget_preference, custom_budget,
       base_price, final_price, discount_applied, status, rejection_reason,
       content_ids, channels, target_audience, additional_materials,
       approved_at, rejected_at, launched_at, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,
             $6,$7,$8,$9,
             $10,$11,$12,$13,$14,
             $15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,
             $19,$20,$21,NOW())
     ON CONFLICT (id) DO UPDATE SET
       user_id              = COALESCE(EXCLUDED.user_id, notification_campaigns.user_id),
       campaign_name        = EXCLUDED.campaign_name,
       artist_name          = EXCLUDED.artist_name,
       description          = EXCLUDED.description,
       start_date           = EXCLUDED.start_date,
       end_date             = EXCLUDED.end_date,
       budget_preference    = EXCLUDED.budget_preference,
       custom_budget        = EXCLUDED.custom_budget,
       base_price           = EXCLUDED.base_price,
       final_price          = EXCLUDED.final_price,
       discount_applied     = EXCLUDED.discount_applied,
       status               = EXCLUDED.status,
       rejection_reason     = EXCLUDED.rejection_reason,
       content_ids          = EXCLUDED.content_ids,
       channels             = EXCLUDED.channels,
       target_audience      = EXCLUDED.target_audience,
       additional_materials = EXCLUDED.additional_materials,
       approved_at          = EXCLUDED.approved_at,
       rejected_at          = EXCLUDED.rejected_at,
       launched_at          = EXCLUDED.launched_at,
       updated_at           = NOW()`,
    [
      campaignId,
      userId || campaign.user_id || null,
      campaign.campaign_name || '',
      campaign.artist_name || '',
      campaign.description || '',
      campaign.start_date || null,
      campaign.end_date || null,
      campaign.budget_preference || 'medium',
      Number(campaign.custom_budget || 0),
      Number(campaign.base_price || 0),
      Number(campaign.final_price || 0),
      Number(campaign.discount_applied || 0),
      campaign.status || 'pending_review',
      campaign.rejection_reason || null,
      JSON.stringify(content_ids),
      JSON.stringify(channels),
      JSON.stringify(target_audience),
      JSON.stringify(additional_materials),
      campaign.approved_at || null,
      campaign.rejected_at || null,
      campaign.launched_at || null,
    ]
  );
}

// ─── Payment Balances (specific fields) ───

export async function getPaymentBalance(userId: string) {
  const { data, error } = await db()
    .from('payment_balances')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getPaymentBalance:', error);
  if (!data) return null;
  return { available: Number(data.available || 0), pending: Number(data.pending || 0), total: Number(data.total || 0) };
}

/**
 * Atomic withdrawal: in a single UPDATE, debits `amount` from `available` and
 * credits the same to `pending`, guarded by `available >= amount`. Returns the
 * new balance on success or null if there isn't enough money OR the row doesn't
 * exist. This closes the race window where two concurrent withdraw requests
 * both read available=1000 and each took 800, ending with a negative balance.
 */
export async function debitAvailableToPendingAtomic(userId: string, amount: number): Promise<{ available: number; pending: number; total: number } | null> {
  const { pool } = await import('./db-client.tsx');
  const res = await pool.query(
    `UPDATE payment_balances
        SET available = available - $2::numeric,
            pending   = pending   + $2::numeric,
            total     = (available - $2::numeric) + (pending + $2::numeric),
            updated_at = NOW()
      WHERE user_id = $1
        AND available >= $2::numeric
      RETURNING available, pending, total`,
    [userId, amount],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return { available: Number(row.available), pending: Number(row.pending), total: Number(row.total) };
}

// Atomic credit for donations/topups — counterpart to debitAvailableToPendingAtomic.
// Replaces the lossy read-modify-write pattern in checkout fulfillment.
export async function creditAvailableAtomic(userId: string, amount: number): Promise<{ available: number; pending: number; total: number }> {
  const { pool } = await import('./db-client.tsx');
  const res = await pool.query(
    `INSERT INTO payment_balances (user_id, available, pending, total, updated_at)
     VALUES ($1, $2::numeric, 0, $2::numeric, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET available = payment_balances.available + EXCLUDED.available,
           total     = payment_balances.total     + EXCLUDED.available,
           updated_at = NOW()
     RETURNING available, pending, total`,
    [userId, amount]
  );
  const row = res.rows[0];
  return { available: Number(row.available), pending: Number(row.pending), total: Number(row.total) };
}

export async function upsertPaymentBalance(userId: string, balance: { available?: number; pending?: number; total?: number }) {
  const { error } = await db()
    .from('payment_balances')
    .upsert({
      user_id: userId,
      available: balance.available ?? 0,
      pending: balance.pending ?? 0,
      total: balance.total ?? 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertPaymentBalance:', error);
}

// ── Audio Branding stores ──

// ── Production 360 — row-per-order native cols (migration 059) ──
// production_360_by_status + production_360_by_artist таблицы DROPPED
// — derived из native indexes на production_360_orders.status / artist_id.
// 3 store wrapper'а DELETED. Доступ — типизированные функции ниже.

const P360_ORDER_COLS = `id, artist_id, artist_name, service_type, project_title,
  project_description, project_goals, target_audience, genre,
  service_price, addons_total, discount, final_price, estimated_full_price,
  subscription, status, status_entered_at, current_stage, completed_percentage,
  estimated_completion, deadline, admin_comment, client_feedback,
  revision_notes, revision_count, rejection_reason, existing_material,
  paid_at, approved_date, completed_date,
  services, addons, "references", stage_progress, assigned_team, files, extra,
  created_at, updated_at`;

function mapP360OrderRow(r: any): any {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : undefined);
  return {
    id: r.id,
    artistId: r.artist_id,
    artistName: r.artist_name,
    serviceType: r.service_type,
    projectTitle: r.project_title,
    projectDescription: r.project_description,
    projectGoals: r.project_goals || undefined,
    targetAudience: r.target_audience || undefined,
    genre: r.genre || undefined,
    services: r.services || {},
    addons: r.addons || [],
    references: r["references"] || [],
    existingMaterial: r.existing_material || undefined,
    deadline: iso(r.deadline),
    servicePrice: Number(r.service_price || 0),
    addonsTotal: Number(r.addons_total || 0),
    discount: Number(r.discount || 0),
    finalPrice: Number(r.final_price || 0),
    subscription: r.subscription,
    estimatedFullPrice: r.estimated_full_price !== null && r.estimated_full_price !== undefined
      ? Number(r.estimated_full_price) : undefined,
    status: r.status,
    statusEnteredAt: iso(r.status_entered_at),
    progress: {
      currentStage: r.current_stage || 'concept',
      completedPercentage: Number(r.completed_percentage || 0),
      stageProgress: r.stage_progress || {},
      estimatedCompletion: iso(r.estimated_completion),
    },
    assignedTeam: r.assigned_team || [],
    files: r.files || [],
    adminComment: r.admin_comment || undefined,
    clientFeedback: r.client_feedback || undefined,
    revisionNotes: r.revision_notes || undefined,
    revisionCount: Number(r.revision_count || 0),
    rejectionReason: r.rejection_reason || undefined,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    paidAt: iso(r.paid_at),
    approvedDate: iso(r.approved_date),
    completedDate: iso(r.completed_date),
    ...(r.extra || {}),
  };
}

export async function getProduction360Order(id: string): Promise<any | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${P360_ORDER_COLS} FROM production_360_orders WHERE id = $1 LIMIT 1`,
    [id]
  );
  return r.rowCount ? mapP360OrderRow(r.rows[0]) : null;
}

export async function upsertProduction360Order(id: string, value: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  const extra = { ...value };
  ['id','artistId','artistName','serviceType','projectTitle','projectDescription',
   'projectGoals','targetAudience','genre','services','addons','references',
   'existingMaterial','deadline','servicePrice','addonsTotal','discount',
   'finalPrice','subscription','estimatedFullPrice','status','statusEnteredAt',
   'progress','assignedTeam','files','adminComment','clientFeedback',
   'revisionNotes','revisionCount','rejectionReason','createdAt','updatedAt',
   'paidAt','approvedDate','completedDate'].forEach(k => delete extra[k]);
  const progress = value.progress || {};
  await pool.query(
    `INSERT INTO production_360_orders (
       id, artist_id, artist_name, service_type, project_title, project_description,
       project_goals, target_audience, genre,
       service_price, addons_total, discount, final_price, estimated_full_price,
       subscription, status, status_entered_at, current_stage,
       completed_percentage, estimated_completion, deadline,
       admin_comment, client_feedback, revision_notes, revision_count,
       rejection_reason, existing_material, paid_at, approved_date, completed_date,
       services, addons, "references", stage_progress, assigned_team, files, extra,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6,
             $7, $8, $9,
             $10, $11, $12, $13, $14,
             $15, $16, $17, $18,
             $19, $20, $21,
             $22, $23, $24, $25,
             $26, $27, $28, $29, $30,
             $31::jsonb, $32::jsonb, $33::jsonb, $34::jsonb, $35::jsonb, $36::jsonb, $37::jsonb,
             NOW())
     ON CONFLICT (id) DO UPDATE SET
       artist_id            = COALESCE(EXCLUDED.artist_id, production_360_orders.artist_id),
       artist_name          = EXCLUDED.artist_name,
       service_type         = EXCLUDED.service_type,
       project_title        = EXCLUDED.project_title,
       project_description  = EXCLUDED.project_description,
       project_goals        = EXCLUDED.project_goals,
       target_audience      = EXCLUDED.target_audience,
       genre                = EXCLUDED.genre,
       service_price        = EXCLUDED.service_price,
       addons_total         = EXCLUDED.addons_total,
       discount             = EXCLUDED.discount,
       final_price          = EXCLUDED.final_price,
       estimated_full_price = EXCLUDED.estimated_full_price,
       subscription         = EXCLUDED.subscription,
       status               = EXCLUDED.status,
       status_entered_at    = EXCLUDED.status_entered_at,
       current_stage        = EXCLUDED.current_stage,
       completed_percentage = EXCLUDED.completed_percentage,
       estimated_completion = EXCLUDED.estimated_completion,
       deadline             = EXCLUDED.deadline,
       admin_comment        = EXCLUDED.admin_comment,
       client_feedback      = EXCLUDED.client_feedback,
       revision_notes       = EXCLUDED.revision_notes,
       revision_count       = EXCLUDED.revision_count,
       rejection_reason     = EXCLUDED.rejection_reason,
       existing_material    = EXCLUDED.existing_material,
       paid_at              = EXCLUDED.paid_at,
       approved_date        = EXCLUDED.approved_date,
       completed_date       = EXCLUDED.completed_date,
       services             = EXCLUDED.services,
       addons               = EXCLUDED.addons,
       "references"         = EXCLUDED."references",
       stage_progress       = EXCLUDED.stage_progress,
       assigned_team        = EXCLUDED.assigned_team,
       files                = EXCLUDED.files,
       extra                = EXCLUDED.extra,
       updated_at           = NOW()`,
    [
      id,
      value.artistId || null, value.artistName || null, value.serviceType || null,
      value.projectTitle || null, value.projectDescription || null,
      value.projectGoals || null, value.targetAudience || null, value.genre || null,
      Number(value.servicePrice || 0), Number(value.addonsTotal || 0),
      Number(value.discount || 0), Number(value.finalPrice || 0),
      value.estimatedFullPrice !== undefined && value.estimatedFullPrice !== null
        ? Number(value.estimatedFullPrice) : null,
      value.subscription || 'none',
      value.status || 'draft',
      value.statusEnteredAt || null,
      progress.currentStage || null,
      Number(progress.completedPercentage || 0),
      progress.estimatedCompletion || null,
      value.deadline || null,
      value.adminComment || null,
      value.clientFeedback || null,
      value.revisionNotes || null,
      Number(value.revisionCount || 0),
      value.rejectionReason || null,
      value.existingMaterial || null,
      value.paidAt || null,
      value.approvedDate || null,
      value.completedDate || null,
      JSON.stringify(value.services || {}),
      JSON.stringify(Array.isArray(value.addons) ? value.addons : []),
      JSON.stringify(Array.isArray(value.references) ? value.references : []),
      JSON.stringify(progress.stageProgress || {}),
      JSON.stringify(Array.isArray(value.assignedTeam) ? value.assignedTeam : []),
      JSON.stringify(Array.isArray(value.files) ? value.files : []),
      JSON.stringify(extra),
    ]
  );
}

export async function deleteProduction360Order(id: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(`DELETE FROM production_360_orders WHERE id = $1`, [id]);
  return r.rowCount || 0;
}

export async function listProduction360OrdersByArtist(artistId: string): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${P360_ORDER_COLS} FROM production_360_orders
      WHERE artist_id = $1 ORDER BY created_at DESC`,
    [artistId]
  );
  return r.rows.map(mapP360OrderRow);
}

export async function listProduction360OrdersByStatus(statuses: string[]): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${P360_ORDER_COLS} FROM production_360_orders
      WHERE status = ANY($1::text[]) ORDER BY created_at DESC`,
    [statuses]
  );
  return r.rows.map(mapP360OrderRow);
}

export async function listAllProduction360Orders(): Promise<any[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${P360_ORDER_COLS} FROM production_360_orders ORDER BY created_at DESC`
  );
  return r.rows.map(mapP360OrderRow);
}

// ─── Promo.Air AI DJ (migration 071 — native cols since this PR) ──
//
// 3 tables, row-per-record (kills (pk, data jsonb) anti-pattern):
//   promo_air_dj_settings  — venue-scoped singleton config
//   promo_air_dj_scripts   — script history (retention: last 100/venue)
//   promo_air_dj_queue     — playback queue (retention: last 50/venue)
//
// 2 of 3 tables были MISSING на проде до этой миграции — feature
// partially broken (POST /settings и GET /queue падали). Эта миграция
// + типизированные функции ниже починили feature через native cols.

export interface PromoAirDjSettings {
  venueId: string;
  voiceStyle: 'warm' | 'energetic' | 'calm' | 'professional';
  language: 'ru' | 'en';
  djName: string;
  enabledSegments: string[];
  trackIntroFrequency: number;
  timeCheckFrequency: number;
  weatherFrequency: number;
  customPrompt?: string | null;
}

export interface PromoAirDjScript {
  id: string;
  venueId: string;
  segmentType: string;
  text: string;
  audioUrl: string | null;
  model: string | null;
  latencyMs: number | null;
  status: string;
  generatedAt: string;
}

export interface PromoAirDjQueueItem {
  id: string;
  venueId: string;
  scriptId: string | null;
  segmentType: string;
  text: string;
  audioUrl: string | null;
  scheduledAt: string;
  played: boolean;
  playedAt: string | null;
}

function mapPromoAirDjSettings(r: any): PromoAirDjSettings | null {
  if (!r) return null;
  return {
    venueId: r.venue_id,
    voiceStyle: r.voice_style,
    language: r.language,
    djName: r.dj_name,
    enabledSegments: r.enabled_segments || [],
    trackIntroFrequency: r.track_intro_frequency,
    timeCheckFrequency: r.time_check_frequency,
    weatherFrequency: r.weather_frequency,
    customPrompt: r.custom_prompt,
  };
}

function mapPromoAirDjScript(r: any): PromoAirDjScript {
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    venueId: r.venue_id,
    segmentType: r.segment_type,
    text: r.text,
    audioUrl: r.audio_url,
    model: r.model,
    latencyMs: r.latency_ms,
    status: r.status,
    generatedAt: iso(r.generated_at),
  };
}

function mapPromoAirDjQueueItem(r: any): PromoAirDjQueueItem {
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : null);
  return {
    id: String(r.id),
    venueId: r.venue_id,
    scriptId: r.script_id,
    segmentType: r.segment_type,
    text: r.text,
    audioUrl: r.audio_url,
    scheduledAt: iso(r.scheduled_at) || '',
    played: !!r.played,
    playedAt: iso(r.played_at),
  };
}

const PROMO_AIR_DJ_SETTINGS_COLS = `venue_id, voice_style, language, dj_name,
  enabled_segments, track_intro_frequency, time_check_frequency,
  weather_frequency, custom_prompt`;

export async function getPromoAirDjSettings(venueId: string): Promise<PromoAirDjSettings | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${PROMO_AIR_DJ_SETTINGS_COLS} FROM promo_air_dj_settings
      WHERE venue_id = $1 LIMIT 1`,
    [venueId],
  );
  return mapPromoAirDjSettings(r.rows[0]);
}

/**
 * Upsert settings. Принимает partial — отсутствующие поля используют
 * DEFAULT на INSERT path или сохраняют существующее значение на UPDATE
 * path. Returns the row after upsert (so handler возвращает client'у
 * merged-with-defaults версию).
 */
export async function upsertPromoAirDjSettings(
  venueId: string,
  patch: Partial<Omit<PromoAirDjSettings, 'venueId'>>,
): Promise<PromoAirDjSettings> {
  const { pool } = await import('./db-client.tsx');
  // Build dynamic SET clause — только переданные поля участвуют в UPDATE.
  // Поля выбраны через field name → column name mapping.
  const FIELD_MAP: Record<string, string> = {
    voiceStyle:           'voice_style',
    language:             'language',
    djName:               'dj_name',
    enabledSegments:      'enabled_segments',
    trackIntroFrequency:  'track_intro_frequency',
    timeCheckFrequency:   'time_check_frequency',
    weatherFrequency:     'weather_frequency',
    customPrompt:         'custom_prompt',
  };
  // Список ключей которые callers могут передать; не входящие в map игнорим.
  const insertCols: string[] = ['venue_id'];
  const insertVals: any[] = [venueId];
  const updateSet: string[] = [];
  let idx = 2;
  for (const [field, col] of Object.entries(FIELD_MAP)) {
    if (patch[field as keyof typeof patch] !== undefined) {
      insertCols.push(col);
      insertVals.push(patch[field as keyof typeof patch]);
      updateSet.push(`${col} = EXCLUDED.${col}`);
      idx++;
    }
  }
  updateSet.push('updated_at = NOW()');

  const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
  const r = await pool.query(
    `INSERT INTO promo_air_dj_settings (${insertCols.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT (venue_id) DO UPDATE SET ${updateSet.join(', ')}
     RETURNING ${PROMO_AIR_DJ_SETTINGS_COLS}`,
    insertVals,
  );
  return mapPromoAirDjSettings(r.rows[0])!;
}

const PROMO_AIR_DJ_SCRIPT_COLS = `id, venue_id, segment_type, text, audio_url,
  model, latency_ms, status, generated_at`;

/**
 * Insert script + retention: автоматически удаляет старше последних 100
 * для venue. Старая jsonbStore-based handler делал то же самое JS-side
 * через `existing.length = 100` после unshift'а.
 */
export async function insertPromoAirDjScript(script: PromoAirDjScript): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO promo_air_dj_scripts
       (id, venue_id, segment_type, text, audio_url, model, latency_ms, status, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()))`,
    [
      script.id, script.venueId, script.segmentType, script.text,
      script.audioUrl, script.model, script.latencyMs, script.status,
      script.generatedAt || null,
    ],
  );
  // Retention — keep last 100 per venue. Window CTE для атомарного delete.
  await pool.query(
    `DELETE FROM promo_air_dj_scripts
      WHERE venue_id = $1
        AND id NOT IN (
          SELECT id FROM promo_air_dj_scripts
           WHERE venue_id = $1
           ORDER BY generated_at DESC
           LIMIT 100
        )`,
    [script.venueId],
  );
}

export async function listPromoAirDjScripts(venueId: string, limit: number = 20): Promise<PromoAirDjScript[]> {
  const { pool } = await import('./db-client.tsx');
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const r = await pool.query(
    `SELECT ${PROMO_AIR_DJ_SCRIPT_COLS} FROM promo_air_dj_scripts
      WHERE venue_id = $1
      ORDER BY generated_at DESC
      LIMIT ${safeLimit}`,
    [venueId],
  );
  return r.rows.map(mapPromoAirDjScript);
}

const PROMO_AIR_DJ_QUEUE_COLS = `id, venue_id, script_id, segment_type, text,
  audio_url, scheduled_at, played, played_at`;

/**
 * Enqueue item + retention: keep last 50 per venue. На отличие от legacy
 * jsonbStore поведения (FIFO `queue.shift()` если >50), мы режем по
 * scheduled_at DESC — пишет последние 50.
 */
export async function enqueuePromoAirDjItem(item: Omit<PromoAirDjQueueItem, 'id'>): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO promo_air_dj_queue
       (venue_id, script_id, segment_type, text, audio_url, scheduled_at, played, played_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7, $8::timestamptz)`,
    [
      item.venueId, item.scriptId, item.segmentType, item.text,
      item.audioUrl, item.scheduledAt || null, item.played,
      item.playedAt || null,
    ],
  );
  await pool.query(
    `DELETE FROM promo_air_dj_queue
      WHERE venue_id = $1
        AND id NOT IN (
          SELECT id FROM promo_air_dj_queue
           WHERE venue_id = $1
           ORDER BY scheduled_at DESC
           LIMIT 50
        )`,
    [item.venueId],
  );
}

/**
 * Returns pending (not-played) queue items for venue, ordered by
 * scheduled_at ASC (FIFO playback). Использует partial index
 * idx_promo_air_dj_queue_pending для hot-path.
 */
export async function listPromoAirDjQueuePending(venueId: string): Promise<PromoAirDjQueueItem[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${PROMO_AIR_DJ_QUEUE_COLS} FROM promo_air_dj_queue
      WHERE venue_id = $1 AND played = FALSE
      ORDER BY scheduled_at ASC`,
    [venueId],
  );
  return r.rows.map(mapPromoAirDjQueueItem);
}

// ─── venue_ad_campaigns native (migration 082) ───
// Row-per-campaign (id PK, venue_id FK semantic). Replaces venueAdCampaignsStore
// per-venue jsonb-array. Race-free creation + atomic status updates.

export interface VenueAdCampaignRow {
  id: string;
  venueId: string;
  stationId?: string | null;
  stationName?: string | null;
  advertiserId?: string | null;
  packageType?: string | null;
  status: string;
  audioUrl?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  targetPlays: number;
  totalPlays: number;
  budget: number;
  spent: number;
  impressions: number;
  ctr: number;
  timeSlots: any[];
  extra: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

function mapVenueAdCampaignRow(r: any): VenueAdCampaignRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    venueId: r.venue_id,
    stationId: r.station_id ?? null,
    stationName: r.station_name ?? null,
    advertiserId: r.advertiser_id ?? null,
    packageType: r.package_type ?? null,
    status: r.status,
    audioUrl: r.audio_url ?? null,
    startDate: r.start_date ?? null,
    endDate: r.end_date ?? null,
    targetPlays: Number(r.target_plays || 0),
    totalPlays: Number(r.total_plays || 0),
    budget: Number(r.budget || 0),
    spent: Number(r.spent || 0),
    impressions: Number(r.impressions || 0),
    ctr: Number(r.ctr || 0),
    timeSlots: Array.isArray(r.time_slots) ? r.time_slots : [],
    extra: r.extra || {},
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const VAC_COLS = `id, venue_id, station_id, station_name, advertiser_id,
  package_type, status, audio_url, start_date, end_date,
  target_plays, total_plays, budget, spent, impressions, ctr,
  time_slots, extra, created_at, updated_at`;

export async function getVenueAdCampaign(id: string): Promise<VenueAdCampaignRow | null> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${VAC_COLS} FROM venue_ad_campaigns WHERE id = $1 LIMIT 1`, [id]
  );
  return mapVenueAdCampaignRow(r.rows[0]);
}

export async function listVenueAdCampaigns(venueId: string): Promise<VenueAdCampaignRow[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT ${VAC_COLS} FROM venue_ad_campaigns
      WHERE venue_id = $1 ORDER BY created_at DESC`, [venueId]
  );
  return r.rows.map(mapVenueAdCampaignRow).filter((x): x is VenueAdCampaignRow => x !== null);
}

export async function insertVenueAdCampaign(c: VenueAdCampaignRow): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `INSERT INTO venue_ad_campaigns
       (id, venue_id, station_id, station_name, advertiser_id, package_type,
        status, audio_url, start_date, end_date,
        target_plays, total_plays, budget, spent, impressions, ctr,
        time_slots, extra, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11,$12,$13,$14,$15,$16,
             $17::jsonb,$18::jsonb,
             COALESCE($19::timestamptz, NOW()),
             COALESCE($20::timestamptz, NOW()))`,
    [
      c.id, c.venueId, c.stationId ?? null, c.stationName ?? null,
      c.advertiserId ?? null, c.packageType ?? null, c.status || 'pending',
      c.audioUrl ?? null, c.startDate ?? null, c.endDate ?? null,
      c.targetPlays || 0, c.totalPlays || 0, c.budget || 0, c.spent || 0,
      c.impressions || 0, c.ctr || 0,
      JSON.stringify(c.timeSlots || []),
      JSON.stringify(c.extra || {}),
      c.createdAt ?? null, c.updatedAt ?? null,
    ]
  );
}

/**
 * Atomic partial UPDATE. Принимает камелкейс patch; снэк-кейс через ручной mapping.
 * Race-free vs legacy get→mutate→set паттерн.
 */
export async function updateVenueAdCampaign(
  id: string,
  patch: Partial<{
    status: string; audioUrl: string | null; startDate: string | null;
    endDate: string | null; targetPlays: number; totalPlays: number;
    budget: number; spent: number; impressions: number; ctr: number;
    timeSlots: any[];
    packageType: string | null;
  }>
): Promise<VenueAdCampaignRow | null> {
  const { pool } = await import('./db-client.tsx');
  const fieldMap: Record<string, string> = {
    status: 'status', audioUrl: 'audio_url', startDate: 'start_date',
    endDate: 'end_date', targetPlays: 'target_plays', totalPlays: 'total_plays',
    budget: 'budget', spent: 'spent', impressions: 'impressions', ctr: 'ctr',
    timeSlots: 'time_slots', packageType: 'package_type',
  };
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = fieldMap[k]; if (!col) continue;
    vals.push(col === 'time_slots' ? JSON.stringify(v ?? []) : v);
    sets.push(`${col} = $${vals.length}${col === 'time_slots' ? '::jsonb' : ''}`);
  }
  if (sets.length === 0) return getVenueAdCampaign(id);
  vals.push(id);
  const r = await pool.query(
    `UPDATE venue_ad_campaigns SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${vals.length} RETURNING ${VAC_COLS}`,
    vals
  );
  return mapVenueAdCampaignRow(r.rows[0]);
}

// ─── track_test experts (migration 053 dropped track_test_experts) ───
/**
 * Список зарегистрированных track-test экспертов (для SSE-рассылок).
 * Replaces dropped track_test_experts singleton-array. Source of truth —
 * track_test_expert_stats (1 row per expert).
 */
export async function listRegisteredTrackTestExperts(): Promise<string[]> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `SELECT DISTINCT expert_id FROM track_test_expert_stats WHERE expert_id IS NOT NULL`
  );
  return r.rows.map(row => row.expert_id as string);
}

// ─── track_test_reviews native cols since migration 053 (typed access since #116) ───
//
// Inline-bootstrap (migration 086) — pure additive CREATE INDEX IF NOT EXISTS,
// memoized → выполняется один раз per process; на ошибке reset для retry.
// Если 086 .sql прогнан руками — block no-op (CREATE INDEX IF NOT EXISTS).
// Pattern matches PR #122 ecosystem_sessions inline bootstrap.

let trackTestReviewIndexBootstrapPromise: Promise<void> | null = null;
async function ensureTrackTestReviewIndexes(): Promise<void> {
  if (trackTestReviewIndexBootstrapPromise) return trackTestReviewIndexBootstrapPromise;
  trackTestReviewIndexBootstrapPromise = (async () => {
    const { pool } = await import('./db-client.tsx');
    try {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_track_test_reviews_request
           ON track_test_reviews(request_id, created_at)`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_track_test_reviews_expert
           ON track_test_reviews(expert_email, created_at DESC)
           WHERE expert_email IS NOT NULL`
      );
    } catch (err) {
      console.error('[track_test_reviews] index bootstrap failed:', err);
      trackTestReviewIndexBootstrapPromise = null; // retry on next access
      throw err;
    }
  })();
  return trackTestReviewIndexBootstrapPromise;
}

export interface TrackTestReviewRow {
  id: string;
  request_id: string;
  expert_email: string;
  expert_name: string;
  expert_role: string | null;
  status: string;
  mixing_mastering_score: number;
  arrangement_score: number;
  originality_score: number;
  commercial_potential_score: number;
  overall_score: number;
  mixing_mastering_feedback: string;
  arrangement_feedback: string;
  originality_feedback: string;
  commercial_potential_feedback: string;
  general_feedback: string;
  recommendations: string;
  audio_notes: any[];
  reward_points: number;
  reward_paid: boolean;
  created_at: string;
  completed_at?: string | null;
}

function mapTrackTestReviewRow(r: any): TrackTestReviewRow | null {
  if (!r) return null;
  const iso = (d: any) => d instanceof Date ? d.toISOString() : (d ? String(d) : '');
  return {
    id: r.id,
    request_id: r.request_id,
    expert_email: r.expert_email,
    expert_name: r.expert_name,
    expert_role: r.expert_role ?? null,
    status: r.status,
    mixing_mastering_score: Number(r.mixing_mastering_score || 0),
    arrangement_score: Number(r.arrangement_score || 0),
    originality_score: Number(r.originality_score || 0),
    commercial_potential_score: Number(r.commercial_potential_score || 0),
    overall_score: Number(r.overall_score || 0),
    mixing_mastering_feedback: r.mixing_mastering_feedback || '',
    arrangement_feedback: r.arrangement_feedback || '',
    originality_feedback: r.originality_feedback || '',
    commercial_potential_feedback: r.commercial_potential_feedback || '',
    general_feedback: r.general_feedback || '',
    recommendations: r.recommendations || '',
    audio_notes: Array.isArray(r.audio_notes) ? r.audio_notes : [],
    reward_points: Number(r.reward_points || 50),
    reward_paid: Boolean(r.reward_paid),
    created_at: iso(r.created_at),
    completed_at: r.completed_at instanceof Date ? r.completed_at.toISOString() : (r.completed_at || null),
  };
}

const TTR_COLS = `id, request_id, expert_email, expert_name, expert_role,
  status, mixing_mastering_score, arrangement_score, originality_score,
  commercial_potential_score, overall_score, mixing_mastering_feedback,
  arrangement_feedback, originality_feedback, commercial_potential_feedback,
  general_feedback, recommendations, audio_notes, reward_points,
  reward_paid, created_at, completed_at`;

export async function getTrackTestReview(id: string): Promise<TrackTestReviewRow | null> {
  const { pool } = await import('./db-client.tsx');
  await ensureTrackTestReviewIndexes();
  const r = await pool.query(
    `SELECT ${TTR_COLS} FROM track_test_reviews WHERE id = $1 LIMIT 1`, [id]
  );
  return mapTrackTestReviewRow(r.rows[0]);
}

/**
 * Replaces dropped track_test_request_reviews — SELECT по request_id через
 * idx_track_test_reviews_request (inline-bootstrapped).
 */
export async function listTrackTestReviewsByRequest(requestId: string): Promise<TrackTestReviewRow[]> {
  const { pool } = await import('./db-client.tsx');
  await ensureTrackTestReviewIndexes();
  const r = await pool.query(
    `SELECT ${TTR_COLS} FROM track_test_reviews WHERE request_id = $1
      ORDER BY created_at ASC`, [requestId]
  );
  return r.rows.map(mapTrackTestReviewRow).filter((x): x is TrackTestReviewRow => x !== null);
}

export async function upsertTrackTestReview(review: TrackTestReviewRow): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await ensureTrackTestReviewIndexes();
  await pool.query(
    `INSERT INTO track_test_reviews
       (id, request_id, expert_email, expert_name, expert_role, status,
        mixing_mastering_score, arrangement_score, originality_score,
        commercial_potential_score, overall_score,
        mixing_mastering_feedback, arrangement_feedback, originality_feedback,
        commercial_potential_feedback, general_feedback, recommendations,
        audio_notes, reward_points, reward_paid,
        created_at, completed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18::jsonb,$19,$20,
             COALESCE($21::timestamptz, NOW()), $22::timestamptz, NOW())
     ON CONFLICT (id) DO UPDATE SET
       request_id                    = EXCLUDED.request_id,
       expert_email                  = EXCLUDED.expert_email,
       expert_name                   = EXCLUDED.expert_name,
       expert_role                   = EXCLUDED.expert_role,
       status                        = EXCLUDED.status,
       mixing_mastering_score        = EXCLUDED.mixing_mastering_score,
       arrangement_score             = EXCLUDED.arrangement_score,
       originality_score             = EXCLUDED.originality_score,
       commercial_potential_score    = EXCLUDED.commercial_potential_score,
       overall_score                 = EXCLUDED.overall_score,
       mixing_mastering_feedback     = EXCLUDED.mixing_mastering_feedback,
       arrangement_feedback          = EXCLUDED.arrangement_feedback,
       originality_feedback          = EXCLUDED.originality_feedback,
       commercial_potential_feedback = EXCLUDED.commercial_potential_feedback,
       general_feedback              = EXCLUDED.general_feedback,
       recommendations               = EXCLUDED.recommendations,
       audio_notes                   = EXCLUDED.audio_notes,
       reward_points                 = EXCLUDED.reward_points,
       reward_paid                   = EXCLUDED.reward_paid,
       completed_at                  = EXCLUDED.completed_at,
       updated_at                    = NOW()`,
    [
      review.id, review.request_id, review.expert_email, review.expert_name,
      review.expert_role ?? null, review.status || 'assigned',
      review.mixing_mastering_score || 0, review.arrangement_score || 0,
      review.originality_score || 0, review.commercial_potential_score || 0,
      review.overall_score || 0,
      review.mixing_mastering_feedback || '',
      review.arrangement_feedback || '',
      review.originality_feedback || '',
      review.commercial_potential_feedback || '',
      review.general_feedback || '',
      review.recommendations || '',
      JSON.stringify(review.audio_notes || []),
      review.reward_points || 50,
      Boolean(review.reward_paid),
      review.created_at ?? null,
      review.completed_at ?? null,
    ]
  );
}

/**
 * Atomic mark-reward-paid. Race-free vs legacy get+mutate+set паттерн.
 */
export async function markTrackTestReviewRewardPaid(id: string): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  await pool.query(
    `UPDATE track_test_reviews SET reward_paid = TRUE, updated_at = NOW() WHERE id = $1`,
    [id]
  );
}

// ─── Radio Requests atomic helpers (#121) ───
// Атомарные операции для radio_artist_requests / radio_venue_requests /
// radio_notifications. Заменяют legacy .get→mutate→.set паттерн который
// делал DELETE + INSERT всех rows на каждое изменение (race + heavy DB load).

/** Atomic INSERT для нового artist request. */
export async function insertRadioArtistRequest(item: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  const params = normalizeArtistRequestForInsert(item.radioId || item.radio_id, item);
  await pool.query(
    `INSERT INTO radio_artist_requests
       (id, radio_id, artist_id, artist_name, track_id, track_title, track_url,
        status, rejection_reason, responded_at, extra, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
             COALESCE($12::timestamptz, NOW()))
     ON CONFLICT (id) DO NOTHING`,
    params
  );
}

/** Atomic UPDATE — single statement, race-free vs legacy get+mutate+set. */
export async function updateRadioArtistRequest(
  radioId: string, id: string,
  patch: { status?: string; rejectionReason?: string; respondedAt?: string | null },
): Promise<any | null> {
  const { pool } = await import('./db-client.tsx');
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.status !== undefined) { vals.push(patch.status); sets.push(`status = $${vals.length}`); }
  if (patch.rejectionReason !== undefined) { vals.push(patch.rejectionReason); sets.push(`rejection_reason = $${vals.length}`); }
  if (patch.respondedAt !== undefined) { vals.push(patch.respondedAt); sets.push(`responded_at = $${vals.length}::timestamptz`); }
  if (sets.length === 0) return null;
  vals.push(radioId, id);
  const r = await pool.query(
    `UPDATE radio_artist_requests SET ${sets.join(', ')}, updated_at = NOW()
      WHERE radio_id = $${vals.length - 1} AND id = $${vals.length}
      RETURNING id, radio_id, artist_id, artist_name, track_id, track_title, track_url,
                status, rejection_reason, responded_at, extra, created_at, updated_at`,
    vals
  );
  return r.rows[0] ? mapArtistRequestRow(r.rows[0]) : null;
}

/** Atomic INSERT для нового venue request. */
export async function insertRadioVenueRequest(item: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  const params = normalizeVenueRequestForInsert(item.radioId || item.radio_id, item);
  await pool.query(
    `INSERT INTO radio_venue_requests
       (id, radio_id, venue_id, venue_name, venue_city, campaign_id, package_type,
        audio_url, start_date, end_date, target_plays, completed_plays,
        plays_per_day, duration_days, total_price, platform_fee, station_payout,
        time_slots, status, rejection_reason, approved_at, reviewed_at, completed_at,
        extra, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18::jsonb, $19, $20, $21, $22, $23, $24::jsonb,
             COALESCE($25::timestamptz, NOW()))
     ON CONFLICT (id) DO NOTHING`,
    params
  );
}

/** Atomic UPDATE — single statement, dynamic partial patch. */
export async function updateRadioVenueRequest(
  radioId: string, id: string,
  patch: Partial<{
    status: string; rejectionReason: string;
    approvedAt: string | null; reviewedAt: string | null; completedAt: string | null;
    completedPlays: number; impressions: number;
    audioUrl: string; startDate: string; endDate: string; targetPlays: number;
    reviewNotes: string;
  }>,
): Promise<any | null> {
  const { pool } = await import('./db-client.tsx');
  const fieldMap: Record<string, string> = {
    status: 'status', rejectionReason: 'rejection_reason',
    approvedAt: 'approved_at', reviewedAt: 'reviewed_at', completedAt: 'completed_at',
    completedPlays: 'completed_plays',
    audioUrl: 'audio_url', startDate: 'start_date', endDate: 'end_date',
    targetPlays: 'target_plays',
    reviewNotes: 'review_notes',
  };
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = fieldMap[k]; if (!col) continue;
    vals.push(v);
    const tsCols = new Set(['approved_at', 'reviewed_at', 'completed_at']);
    sets.push(`${col} = $${vals.length}${tsCols.has(col) ? '::timestamptz' : ''}`);
  }
  if (sets.length === 0) return null;
  vals.push(radioId, id);
  const r = await pool.query(
    `UPDATE radio_venue_requests SET ${sets.join(', ')}, updated_at = NOW()
      WHERE radio_id = $${vals.length - 1} AND id = $${vals.length}
      RETURNING id, radio_id, venue_id, venue_name, venue_city, campaign_id, package_type,
                audio_url, start_date, end_date, target_plays, completed_plays,
                plays_per_day, duration_days, total_price, platform_fee, station_payout,
                time_slots, status, rejection_reason, approved_at, reviewed_at, completed_at,
                extra, created_at, updated_at`,
    vals
  );
  return r.rows[0] ? mapVenueRequestRow(r.rows[0]) : null;
}

/** Atomic DELETE single request (owner-scoped). */
export async function deleteRadioVenueRequest(radioId: string, id: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `DELETE FROM radio_venue_requests WHERE radio_id = $1 AND id = $2`,
    [radioId, id]
  );
  return r.rowCount || 0;
}

/** Atomic INSERT для radio notification. */
export async function insertRadioNotification(item: any): Promise<void> {
  const { pool } = await import('./db-client.tsx');
  const params = normalizeRadioNotificationForInsert(item.radioId || item.radio_id, item);
  await pool.query(
    `INSERT INTO radio_notifications
       (id, radio_id, notif_type, title, message, priority, is_read, related_id,
        extra, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
             COALESCE($10::timestamptz, NOW()))
     ON CONFLICT (id) DO NOTHING`,
    params
  );
}

/** Atomic mark single notification as read. */
export async function markRadioNotificationRead(radioId: string, id: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `UPDATE radio_notifications SET is_read = TRUE, updated_at = NOW()
      WHERE radio_id = $1 AND id = $2`,
    [radioId, id]
  );
  return r.rowCount || 0;
}

/** Atomic mark ALL notifications as read for one station. */
export async function markRadioNotificationsAllRead(radioId: string): Promise<number> {
  const { pool } = await import('./db-client.tsx');
  const r = await pool.query(
    `UPDATE radio_notifications SET is_read = TRUE, updated_at = NOW()
      WHERE radio_id = $1 AND is_read = FALSE`,
    [radioId]
  );
  return r.rowCount || 0;
}
