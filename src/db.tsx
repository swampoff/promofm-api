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

export async function getTrack(userId: string, trackId: string) {
  const { data, error } = await db()
    .from('tracks')
    .select('*')
    .eq('id', `${userId}:${trackId}`)
    .maybeSingle();
  if (error) console.error('[db] getTrack:', error);
  return data ? (data.data || data) : null;
}

export async function upsertTrack(userId: string, trackId: string, track: Record<string, any>) {
  const row = {
    id: `${userId}:${trackId}`,
    user_id: userId,
    data: track,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db()
    .from('tracks')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();
  if (error) console.error('[db] upsertTrack:', error);
  return data?.data || data;
}

export async function deleteTrack(userId: string, trackId: string) {
  const { error } = await db()
    .from('tracks')
    .delete()
    .eq('id', `${userId}:${trackId}`);
  if (error) console.error('[db] deleteTrack:', error);
}

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
  return (data || []).map((r: any) => r.data || r);
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

export async function upsertPaymentSession(orderId: string, session: Record<string, any>) {
  const row: Record<string, any> = {
    order_id: orderId,
    user_id: session.userId || session.user_id || 'unknown',
    amount: session.amount || 0,
    currency: session.currency || 'RUB',
    purpose: session.type || session.purpose || null,
    status: session.status || 'created',
    provider: session.gateway || session.provider || 'yookassa',
    provider_session_id: session.gatewayPaymentId || session.provider_session_id || null,
    data: session,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('payment_sessions')
    .upsert(row, { onConflict: 'order_id' });
  if (error) console.error('[db] upsertPaymentSession:', error);
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
  return data ? (data.settings || data.data || data) : null;
}

export async function upsertUserSettings(userId: string, settings: Record<string, any>) {
  const row = {
    user_id: userId,
    settings,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('user_settings')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertUserSettings:', error);
}

// ─── Analytics ───

export async function getTrackAnalytics(trackId: string) {
  const { data, error } = await db()
    .from('track_analytics')
    .select('*')
    .eq('id', trackId)
    .maybeSingle();
  if (error) console.error('[db] getTrackAnalytics:', error);
  return data ? (data.data || data) : null;
}

export async function upsertTrackAnalytics(trackId: string, analytics: Record<string, any>) {
  const row = {
    id: trackId,
    data: analytics,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('track_analytics')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertTrackAnalytics:', error);
}

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

export async function getBookingsByUser(userId: string) {
  const { data, error } = await db()
    .from('bookings')
    .select('*')
    .or(`performer_id.eq.${userId},user_id.eq.${userId}`)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getBookingsByUser:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function getBooking(bookingId: string) {
  const { data, error } = await db()
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();
  if (error) console.error('[db] getBooking:', error);
  return data ? (data.data || data) : null;
}

export async function upsertBooking(bookingId: string, booking: Record<string, any>) {
  const row = {
    id: bookingId,
    user_id: booking.requesterId || null,
    performer_id: booking.performerId || null,
    venue_id: booking.venueId || null,
    event_date: booking.eventDate || null,
    status: booking.status || 'pending',
    total_price: booking.offeredPrice || null,
    deposit_amount: booking.depositAmount || null,
    deposit_paid: booking.status === 'deposit_paid' || booking.status === 'confirmed' || booking.status === 'completed',
    data: JSON.stringify(booking),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('bookings')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertBooking:', error);
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

export async function getTicketsByUser(userId: string) {
  const { data, error } = await db()
    .from('support_tickets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getTicketsByUser:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function upsertTicket(ticketId: string, ticket: Record<string, any>) {
  const row = {
    id: ticketId,
    data: ticket,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('support_tickets')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertTicket:', error);
}

// ─── Marketing Campaigns ───

export async function getCampaignsByUser(userId: string) {
  const { data, error } = await db()
    .from('marketing_campaigns')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getCampaignsByUser:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function upsertCampaign(campaignId: string, campaign: Record<string, any>) {
  const row = {
    id: campaignId,
    data: campaign,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('marketing_campaigns')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertCampaign:', error);
}

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

// ─── Platform Stats ───

export async function getPlatformStats() {
  const { data, error } = await db()
    .from('platform_stats')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) console.error('[db] getPlatformStats:', error);
  return data ? (data.stats || data.data || data) : null;
}

export async function upsertPlatformStats(stats: Record<string, any>) {
  const row = {
    id: 1,
    stats,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('platform_stats')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertPlatformStats:', error);
}

// ─── Agent Sessions ───

export async function getAgentSessions() {
  const { data, error } = await db()
    .from('agent_sessions')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getAgentSessions:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function getAgentSession(sessionId: string) {
  const { data, error } = await db()
    .from('agent_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) console.error('[db] getAgentSession:', error);
  return data ? (data.data || data) : null;
}

export async function upsertAgentSession(sessionId: string, session: Record<string, any>) {
  const row = {
    id: sessionId,
    data: session,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('agent_sessions')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertAgentSession:', error);
}

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
  return data ? (data.data || data) : null;
}

export async function upsertVenueProfile(userId: string, profile: Record<string, any>) {
  // ЗЕРКАЛО фикса 8652379 (upsertDjProfile): не пинаем `id` (PK
  // auto-uuid), а ресолвим conflict по UNIQUE(user_id). Иначе если
  // existing строка имеет id ≠ userId — UPSERT идёт в INSERT path,
  // UNIQUE на user_id ловит дубль, ошибка тихо логируется.
  // Migration 027 добавляет UNIQUE индекс на user_id.
  const row = {
    user_id: userId,
    data: profile,
    updated_at: new Date().toISOString(),
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
  return data ? (data.data || data) : null;
}

export async function upsertRadioProfile(userId: string, profile: Record<string, any>) {
  // Зеркало фикса 8652379 — см. upsertVenueProfile выше.
  // Migration 027 добавляет UNIQUE на user_id.
  const row = {
    user_id: userId,
    data: profile,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('radio_profiles')
    .upsert(row, { onConflict: 'user_id' });
  if (error) console.error('[db] upsertRadioProfile:', error);
}

// ─── Producer Profiles ───

export async function getProducerProfile(userId: string) {
  const { data, error } = await db()
    .from('producer_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getProducerProfile:', error);
  return data ? (data.data || data) : null;
}

export async function upsertProducerProfile(userId: string, profile: Record<string, any>) {
  // Зеркало фикса 8652379 — см. upsertVenueProfile выше.
  // Migration 027 добавляет UNIQUE на user_id.
  const row = {
    user_id: userId,
    data: profile,
    updated_at: new Date().toISOString(),
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
  return (data || []).map((r: any) => r.data || r);
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

export async function getCollabOffers(userId: string, role: 'artist' | 'producer') {
  const column = role === 'artist' ? 'artist_id' : 'producer_id';
  const { data, error } = await db()
    .from('collab_offers')
    .select('*')
    .eq(column, userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getCollabOffers:', error);
  return (data || []).map((r: any) => r.data || r);
}

export async function upsertCollabOffer(offerId: string, offer: Record<string, any>) {
  const row = {
    id: offerId,
    data: offer,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('collab_offers')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertCollabOffer:', error);
}

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
  // Count
  let countQ = db().from('payment_txns').select('id', { count: 'exact', head: true });
  if (filters?.type) countQ = countQ.eq('type', filters.type);
  if (filters?.category) countQ = countQ.eq('category', filters.category);
  if (filters?.status) countQ = countQ.eq('status', filters.status);
  if (filters?.search) countQ = countQ.ilike('description', '%' + filters.search + '%');
  const { count } = await countQ;

  // Data
  let q = db().from('payment_txns').select('*');
  if (filters?.type) q = q.eq('type', filters.type);
  if (filters?.category) q = q.eq('category', filters.category);
  if (filters?.status) q = q.eq('status', filters.status);
  if (filters?.search) q = q.ilike('description', '%' + filters.search + '%');
  q = q.order('created_at', { ascending: false });
  const lim = filters?.limit || 100;
  const off = filters?.offset || 0;
  q = q.range(off, off + lim - 1);
  const { data, error } = await q;
  if (error) console.error('[db] getAllPaymentTxs:', error);
  const txs = (data || []).map((r: any) => ({
    id: r.id, userId: r.user_id, orderId: r.order_id, type: r.type,
    category: r.category, amount: Number(r.amount), currency: r.currency,
    gateway: r.gateway, description: r.description,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}),
    status: r.status, createdAt: r.created_at,
  }));
  return { txs, total: count || 0 };
}

export async function getPaymentTxStats(): Promise<{
  totalIncome: number; totalExpense: number; totalRefund: number; netBalance: number;
  transactionCount: number; pendingCount: number;
  categoryBreakdown: { category: string; total: number }[];
  monthlyTrend: { month: string; income: number; expense: number; net: number }[];
}> {
  const { data: all, error } = await db().from('payment_txns').select('type, category, amount, status, created_at');
  if (error) console.error('[db] getPaymentTxStats:', error);
  const txs = all || [];
  const totalIncome = txs.filter((t: any) => t.type === 'income' || t.type === 'donation').reduce((s: number, t: any) => s + Number(t.amount), 0);
  const totalExpense = txs.filter((t: any) => t.type === 'expense' || t.type === 'withdrawal').reduce((s: number, t: any) => s + Number(t.amount), 0);
  const totalRefund = txs.filter((t: any) => t.type === 'refund').reduce((s: number, t: any) => s + Number(t.amount), 0);
  const pendingCount = txs.filter((t: any) => t.status === 'pending').length;
  const catMap = new Map<string, number>();
  for (const t of txs) catMap.set(t.category, (catMap.get(t.category) || 0) + Number(t.amount));
  const categoryBreakdown = Array.from(catMap.entries()).map(([category, total]) => ({ category, total }));
  const now = new Date();
  const monthlyTrend: { month: string; income: number; expense: number; net: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toISOString().slice(0, 7);
    const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const monthTxs = txs.filter((t: any) => {
      const td = new Date(t.created_at);
      return td >= d && td < nextMonth;
    });
    const income = monthTxs.filter((t: any) => t.type === 'income' || t.type === 'donation').reduce((s: number, t: any) => s + Number(t.amount), 0);
    const expense = monthTxs.filter((t: any) => t.type === 'expense' || t.type === 'withdrawal').reduce((s: number, t: any) => s + Number(t.amount), 0);
    monthlyTrend.push({ month: label, income, expense, net: income - expense });
  }
  return { totalIncome, totalExpense, totalRefund, netBalance: totalIncome - totalExpense - totalRefund, transactionCount: txs.length, pendingCount, categoryBreakdown, monthlyTrend };
}

export async function getPaymentTxUserSummaries(): Promise<any[]> {
  const { data, error } = await db().from('payment_txns').select('user_id, type, amount, created_at');
  if (error) console.error('[db] getPaymentTxUserSummaries:', error);
  const txs = data || [];
  const users = new Map<string, { totalSpent: number; totalEarned: number; count: number; lastTx: string | null }>();
  for (const t of txs) {
    const uid = t.user_id;
    if (!users.has(uid)) users.set(uid, { totalSpent: 0, totalEarned: 0, count: 0, lastTx: null });
    const u = users.get(uid)!;
    u.count++;
    if (t.type === 'income' || t.type === 'donation') u.totalEarned += Number(t.amount);
    else u.totalSpent += Number(t.amount);
    if (!u.lastTx || t.created_at > u.lastTx) u.lastTx = t.created_at;
  }
  return Array.from(users.entries()).map(([userId, s]) => ({
    id: userId, name: userId, email: '', balance: s.totalEarned - s.totalSpent,
    totalSpent: s.totalSpent, totalEarned: s.totalEarned, transactionsCount: s.count,
    lastTransaction: s.lastTx, status: 'active',
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
function jsonbStore(table: string, pk = 'id') {
  return {
    async get(id: string) {
      const { data, error } = await db().from(table).select('*').eq(pk, id).maybeSingle();
      if (error) console.error(`[db] ${table}.get:`, error);
      return data ? (data.data ?? data) : null;
    },
    async set(id: string, value: any, extra?: Record<string, any>) {
      // PG node driver auto-serializes JS object → jsonb. Do NOT JSON.stringify here,
      // otherwise value is stored as escaped string (jsonb_typeof=string) and consumers
      // doing JSON.parse on it will fail (object vs string mismatch). Accept value as-is
      // when caller already passed a string, parse it back to object for proper storage.
      const normalized = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return value; } })() : value;
      const row = { [pk]: id, data: normalized, updated_at: new Date().toISOString(), ...extra };
      const { error } = await db().from(table).upsert(row, { onConflict: pk });
      if (error) console.error(`[db] ${table}.set:`, error);
    },
    async del(id: string) {
      const { error } = await db().from(table).delete().eq(pk, id);
      if (error) console.error(`[db] ${table}.del:`, error);
    },
    async getAll() {
      const { data, error } = await db().from(table).select('*').order('created_at', { ascending: false });
      if (error) console.error(`[db] ${table}.getAll:`, error);
      return (data || []).map((r: any) => r.data ?? r);
    },
    async getByCol(column: string, value: string) {
      const { data, error } = await db().from(table).select('*').eq(column, value).order('created_at', { ascending: false });
      if (error) console.error(`[db] ${table}.getByCol:`, error);
      return (data || []).map((r: any) => r.data ?? r);
    },
  };
}

// ─── Store instances for all tables ───

export const beatFavoritesStore = jsonbStore('beat_favorites', 'user_id');
export const beatReviewsStore = jsonbStore('beat_reviews');
export const beatReviewsIndexStore = jsonbStore('beat_reviews_index', 'beat_id');
export const contractsStore = jsonbStore('contracts');
export const digitalGoodsStore = jsonbStore('digital_goods');
export const producerSettingsStore = jsonbStore('producer_settings', 'user_id');
export const producerProfileEditStore = jsonbStore('producer_profile_edit', 'user_id');
export const producerMessagesStore = jsonbStore('producer_messages', 'user_id');
export const producerAiLastStore = jsonbStore('producer_ai_last', 'user_id');
export const producerConvsStore = jsonbStore('producer_convs', 'user_id');
export const producerSessionsStore = jsonbStore('producer_sessions', 'user_id');
// producer_custom_services / producer_custom_portfolio переехали на
// row-per-item (migration 039). Доступ через pool.query в
// producer-studio-routes.tsx.
export const producerServicesStore = jsonbStore('producer_services');
export const serviceOrdersStore = jsonbStore('service_orders');
export const serviceOrdersByClientStore = jsonbStore('service_orders_by_client', 'client_id');
export const serviceOrdersByProducerStore = jsonbStore('service_orders_by_producer', 'producer_id');
export const bookingCalendarStore = jsonbStore('booking_calendar', 'performer_id');
// payment_transactions переехал на row-per-tx (migration 037). Доступ
// через pool.query из platform-revenue.tsx + track-test-routes.tsx.
export const paymentBalancesStore = jsonbStore('payment_balances', 'user_id');
export const djMarketplaceIndexStore = jsonbStore('dj_marketplace_index');
export const djMixesStore = jsonbStore('dj_mixes', 'dj_id');
export const djReviewsStore = jsonbStore('dj_reviews', 'dj_id');
// dj_calendar таблица + декларация удалены (migration 040). Был zombie
// код, 0 callers — DJ-календарь как фича не реализован.
export const djCollaborationsStore = jsonbStore('dj_collaborations', 'dj_id');
export const djNotificationsStore = jsonbStore('dj_notifications', 'dj_id');
export const djSubscriptionsStore = jsonbStore('dj_subscriptions', 'dj_id');
export const djPitchesStore = jsonbStore('dj_pitches', 'dj_id');
export const djCampaignsStore = jsonbStore('dj_campaigns', 'dj_id');
export const djWithdrawalsStore = jsonbStore('dj_withdrawals', 'dj_id');
export const djTransactionsStore = jsonbStore('dj_transactions', 'dj_id');
export const collabOffersByArtistStore = jsonbStore('collab_offers_by_artist', 'artist_id');
export const collabOffersByProducerStore = jsonbStore('collab_offers_by_producer', 'producer_id');
// collab_messages переехал на row-per-message (migration 038). Доступ
// через pool.query в collaboration-routes.tsx.
export const publishOrdersStore = jsonbStore('publish_orders');
// publish_chats переехал на row-per-message (migration 038). Доступ
// через pool.query в chat-routes.tsx.
export const publishEmailPrefsStore = jsonbStore('publish_email_prefs', 'user_id');
export const emailHistoryStore = jsonbStore('email_history');
export const emailTemplatesStore = jsonbStore('email_templates');
export const chartAggregationStore = jsonbStore('chart_aggregation');
export const chartSourcesStore = jsonbStore('chart_sources');
export const radioAdSlotsStore = jsonbStore('radio_ad_slots');
export const radioAdSlotIndexStore = jsonbStore('radio_ad_slot_index', 'radio_id');
export const radioAnalyticsStore = jsonbStore('radio_analytics', 'radio_id');
export const radioArtistRequestsStore = jsonbStore('radio_artist_requests', 'radio_id');
export const radioVenueRequestsStore = jsonbStore('radio_venue_requests', 'radio_id');
export const radioFinanceStore = jsonbStore('radio_finance', 'radio_id');
export const radioNotificationsStore = jsonbStore('radio_notifications', 'radio_id');
export const radioTransactionsStore = jsonbStore('radio_transactions', 'radio_id');
// venue_playlists перевели на row-per-playlist (migration 036). Доступ
// через pool.query в venue-routes.tsx / venue-api-routes.tsx.
export const venueAdCampaignsStore = jsonbStore('venue_ad_campaigns', 'venue_id');
export const venueAnalyticsStore = jsonbStore('venue_analytics', 'venue_id');
export const venueRadioBrandStore = jsonbStore('venue_radio_brand', 'venue_id');
export const ticketProvidersStore = jsonbStore('ticket_providers');
export const ticketSalesStore = jsonbStore('ticket_sales');
export const trackTestRequestsStore = jsonbStore('track_test_requests');
export const trackTestUserRequestsStore = jsonbStore('track_test_user_requests', 'user_id');
export const trackTestAllRequestsStore = jsonbStore('track_test_all_requests');
export const trackTestExpertsStore = jsonbStore('track_test_experts');
export const trackTestReviewsStore = jsonbStore('track_test_reviews');
export const trackTestRequestReviewsStore = jsonbStore('track_test_request_reviews', 'request_id');
export const newsPipelineStore = jsonbStore('news_pipeline', 'key');
export const agentSessionsStore = jsonbStore('agent_sessions');
export const agentSessionsIndexStore = jsonbStore('agent_sessions_index');
// agent_queue → agent_tasks (row-per-task, migration 036). Доступ через
// pool.query в agents-routes.tsx.
// artist_analytics_cache переехал на pool.query с native expires_at TTL
// (migration 041). Доступ — artist-analytics-routes.tsx.
// artist_tracks_stats — orphan, DROP TABLE (migration 041, declaration
// удалена).
export const notificationCampaignsStore = jsonbStore('notification_campaigns');
export const notificationSettingsKvStore = jsonbStore('notification_settings', 'user_id');
export const systemConfigStore = jsonbStore('system_config', 'key');
export const accountingStore = jsonbStore('accounting_data', 'key');
export const guideDataStore = jsonbStore('promo_guide_data', 'key');
export const elevenlabsStore = jsonbStore('elevenlabs_config');
export const platformRevenueLogStore = jsonbStore('platform_revenue_log');
export const platformStatsStore = jsonbStore('platform_stats', 'id');
export const trackTestExpertStatsStore = jsonbStore('track_test_expert_stats', 'expert_id');
export const trackModerationStore = jsonbStore('track_moderation');
export const newsPublicStore = jsonbStore('news_public');
export const contactFormsStore = jsonbStore('contact_forms');
export const investorInquiriesStore = jsonbStore('investor_inquiries');
export const djEditorProfileStore = jsonbStore('dj_editor_profiles', 'user_id');
export const concertAgentStore = jsonbStore('concert_agent_data');
export const curatorReportsStore = jsonbStore('curator_reports');
export const verificationTokensStore = jsonbStore('verification_tokens');

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

// ─── Radio Ad Slots (compound key) ───

export async function getRadioAdSlot(radioId: string, slotId: string) {
  const { data, error } = await db()
    .from('radio_ad_slots')
    .select('*')
    .eq('id', slotId)
    .eq('radio_id', radioId)
    .maybeSingle();
  if (error) console.error('[db] getRadioAdSlot:', error);
  return data ? (data.data ?? data) : null;
}

export async function upsertRadioAdSlot(radioId: string, slotId: string, slot: Record<string, any>) {
  const { error } = await db()
    .from('radio_ad_slots')
    .upsert({ id: slotId, radio_id: radioId, data: slot, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) console.error('[db] upsertRadioAdSlot:', error);
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

export async function getTicketSalesByConcert(concertId: string) {
  const { data, error } = await db()
    .from('ticket_sales')
    .select('*')
    .eq('concert_id', concertId);
  if (error) console.error('[db] getTicketSalesByConcert:', error);
  return (data || []).map((r: any) => r.data ?? r);
}

export async function upsertTicketSale(concertId: string, saleId: string, sale: Record<string, any>) {
  const { error } = await db()
    .from('ticket_sales')
    .upsert({ id: saleId, concert_id: concertId, data: sale, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) console.error('[db] upsertTicketSale:', error);
}

// ─── Beat Reviews (compound key: beatId:userId) ───

export async function getBeatReview(beatId: string, userId: string) {
  const { data, error } = await db()
    .from('beat_reviews')
    .select('*')
    .eq('id', `${beatId}:${userId}`)
    .maybeSingle();
  if (error) console.error('[db] getBeatReview:', error);
  return data ? (data.data ?? data) : null;
}

export async function upsertBeatReview(beatId: string, userId: string, review: Record<string, any>) {
  const { error } = await db()
    .from('beat_reviews')
    .upsert({ id: `${beatId}:${userId}`, beat_id: beatId, user_id: userId, data: review, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) console.error('[db] upsertBeatReview:', error);
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

// ─── Notification Campaigns ───

export async function getNotificationCampaignsByUser(userId: string) {
  const { data, error } = await db()
    .from('notification_campaigns')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getNotificationCampaignsByUser:', error);
  return (data || []).map((r: any) => r.data ?? r);
}

export async function upsertNotificationCampaign(userId: string, campaignId: string, campaign: Record<string, any>) {
  const { error } = await db()
    .from('notification_campaigns')
    .upsert({ id: campaignId, user_id: userId, data: campaign, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) console.error('[db] upsertNotificationCampaign:', error);
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

// ── Production 360 stores ──
export const production360OrdersStore = jsonbStore('production_360_orders');
export const production360ByStatusStore = jsonbStore('production_360_by_status');
export const production360ByArtistStore = jsonbStore('production_360_by_artist');

// ── Promo.Air AI DJ stores ──
export const promoAirDjScriptsStore = jsonbStore('promo_air_dj_scripts');
export const promoAirDjSettingsStore = jsonbStore('promo_air_dj_settings');
export const promoAirDjQueueStore = jsonbStore('promo_air_dj_queue');
