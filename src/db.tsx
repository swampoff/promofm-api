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
  return (data || []).map((r: any) => r.data || r);
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
  const row = {
    id: notifId,
    user_id: userId,
    notification_type: notif.type || 'info',
    title: notif.title || '',
    message: notif.message || '',
    status: notif.read ? 'read' : 'unread',
    is_read: notif.read || false,
  };
  const { error } = await db()
    .from('notifications')
    .upsert(row, { onConflict: 'id' });
  if (error) console.error('[db] upsertNotification:', error);
}

export async function deleteNotification(userId: string, notifId: string) {
  const { error } = await db()
    .from('notifications')
    .delete()
    .eq('id', notifId);
  if (error) console.error('[db] deleteNotification:', error);
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
  const { data, error } = await db()
    .from('dj_profiles')
    .select('*')
    .eq('id', djId)
    .maybeSingle();
  if (error) console.error('[db] getDjProfile:', error);
  return data ? (data.data || data) : null;
}

export async function upsertDjProfile(djId: string, profile: Record<string, any>) {
  const row: Record<string, any> = {
    id: djId,
    user_id: profile.userId || djId,
    dj_name: profile.djName || profile.dj_name || null,
    genres: profile.genres || [],
    bio: profile.bio || null,
    avatar_url: profile.avatarUrl || profile.avatar_url || null,
    location: profile.city || profile.location || null,
    hourly_rate: profile.hourlyRate || profile.hourly_rate || 0,
    experience_years: profile.experienceYears || profile.experience_years || 0,
    equipment: profile.equipment || null,
    is_available: profile.isAvailable !== undefined ? profile.isAvailable : true,
    rating: profile.rating || 0,
    total_reviews: profile.totalReviews || profile.total_reviews || 0,
    data: profile,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('dj_profiles')
    .upsert(row, { onConflict: 'id' });
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
  const row = {
    id: userId,
    user_id: userId,
    data: profile,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('venue_profiles')
    .upsert(row, { onConflict: 'id' });
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
  const row = {
    id: userId,
    user_id: userId,
    data: profile,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('radio_profiles')
    .upsert(row, { onConflict: 'id' });
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
  const row = {
    id: userId,
    user_id: userId,
    data: profile,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('producer_profiles')
    .upsert(row, { onConflict: 'id' });
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

function jsonbStore(table: string, pk = 'id') {
  return {
    async get(id: string) {
      const { data, error } = await db().from(table).select('*').eq(pk, id).maybeSingle();
      if (error) console.error(`[db] ${table}.get:`, error);
      return data ? (data.data ?? data) : null;
    },
    async set(id: string, value: any, extra?: Record<string, any>) {
      const row = { [pk]: id, data: JSON.stringify(value), updated_at: new Date().toISOString(), ...extra };
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
export const beatPurchasesStore = jsonbStore('beat_purchases');
export const beatPurchasesByUserStore = jsonbStore('beat_purchases_by_user', 'user_id');
export const beatPurchasesByProducerStore = jsonbStore('beat_purchases_by_producer', 'producer_id');
export const beatReviewsStore = jsonbStore('beat_reviews');
export const beatReviewsIndexStore = jsonbStore('beat_reviews_index', 'beat_id');
export const contractsStore = jsonbStore('contracts');
export const digitalGoodsStore = jsonbStore('digital_goods');
export const digitalPurchasesStore = jsonbStore('digital_purchases');
export const digitalPurchasesByUserStore = jsonbStore('digital_purchases_by_user', 'user_id');
export const producerSettingsStore = jsonbStore('producer_settings', 'user_id');
export const producerProfileEditStore = jsonbStore('producer_profile_edit', 'user_id');
export const producerMessagesStore = jsonbStore('producer_messages', 'user_id');
export const producerAiLastStore = jsonbStore('producer_ai_last', 'user_id');
export const producerConvsStore = jsonbStore('producer_convs', 'user_id');
export const producerSessionsStore = jsonbStore('producer_sessions', 'user_id');
export const producerCustomServicesStore = jsonbStore('producer_custom_services', 'user_id');
export const producerCustomPortfolioStore = jsonbStore('producer_custom_portfolio', 'user_id');
export const producerServicesStore = jsonbStore('producer_services');
export const serviceOrdersStore = jsonbStore('service_orders');
export const serviceOrdersByClientStore = jsonbStore('service_orders_by_client', 'client_id');
export const serviceOrdersByProducerStore = jsonbStore('service_orders_by_producer', 'producer_id');
export const bookingPaymentsStore = jsonbStore('booking_payments');
export const bookingCalendarStore = jsonbStore('booking_calendar', 'performer_id');
export const bookingsByUserStore = jsonbStore('bookings_by_user', 'user_id');
export const paymentWebhookLogsStore = jsonbStore('payment_webhook_logs');
export const paymentTransactionsStore = jsonbStore('payment_transactions', 'user_id');
export const paymentBalancesStore = jsonbStore('payment_balances', 'user_id');
export const paymentWithdrawalsStore = jsonbStore('payment_withdrawals', 'user_id');
export const djMarketplaceIndexStore = jsonbStore('dj_marketplace_index');
export const djMixesStore = jsonbStore('dj_mixes', 'dj_id');
export const djReviewsStore = jsonbStore('dj_reviews', 'dj_id');
export const djCalendarStore = jsonbStore('dj_calendar', 'dj_id');
export const djBookingsStore = jsonbStore('dj_bookings');
export const djBookingsByDjStore = jsonbStore('dj_bookings_by_dj', 'dj_id');
export const djEventsStore = jsonbStore('dj_events', 'dj_id');
export const djCollaborationsStore = jsonbStore('dj_collaborations', 'dj_id');
export const djNotificationsStore = jsonbStore('dj_notifications', 'dj_id');
export const djSubscriptionsStore = jsonbStore('dj_subscriptions', 'dj_id');
export const collabOffersByArtistStore = jsonbStore('collab_offers_by_artist', 'artist_id');
export const collabOffersByProducerStore = jsonbStore('collab_offers_by_producer', 'producer_id');
export const collabMessagesStore = jsonbStore('collab_messages');
export const publishOrdersStore = jsonbStore('publish_orders');
export const publishChatsStore = jsonbStore('publish_chats', 'order_id');
export const publishEmailPrefsStore = jsonbStore('publish_email_prefs', 'user_id');
export const emailHistoryStore = jsonbStore('email_history');
export const emailTemplatesStore = jsonbStore('email_templates');
export const contentOrdersStore = jsonbStore('content_orders');
export const contentOrdersByStatusStore = jsonbStore('content_orders_by_status', 'status');
export const venueOrdersIndexStore = jsonbStore('venue_orders_index', 'venue_id');
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
export const venuePlaylists = jsonbStore('venue_playlists', 'venue_id');
export const venueAdCampaignsStore = jsonbStore('venue_ad_campaigns', 'venue_id');
export const venueAnalyticsStore = jsonbStore('venue_analytics', 'venue_id');
export const venueRadioBrandStore = jsonbStore('venue_radio_brand', 'venue_id');
export const ticketProvidersStore = jsonbStore('ticket_providers');
export const ticketSalesStore = jsonbStore('ticket_sales');
export const dmConversationsStore = jsonbStore('dm_conversations');
export const dmConvListStore = jsonbStore('dm_conv_list', 'user_id');
export const dmMessagesStore = jsonbStore('dm_messages', 'conv_id');
export const dmUnreadCountsStore = jsonbStore('dm_unread_counts', 'user_id');
export const trackTestRequestsStore = jsonbStore('track_test_requests');
export const trackTestUserRequestsStore = jsonbStore('track_test_user_requests', 'user_id');
export const trackTestAllRequestsStore = jsonbStore('track_test_all_requests');
export const trackTestExpertsStore = jsonbStore('track_test_experts');
export const trackTestReviewsStore = jsonbStore('track_test_reviews');
export const trackTestRequestReviewsStore = jsonbStore('track_test_request_reviews', 'request_id');
export const newsPipelineStore = jsonbStore('news_pipeline', 'key');
export const agentSessionsStore = jsonbStore('agent_sessions');
export const agentSessionsIndexStore = jsonbStore('agent_sessions_index');
export const agentQueueStore = jsonbStore('agent_queue');
export const artistAnalyticsCacheStore = jsonbStore('artist_analytics_cache', 'artist_id');
export const artistTracksStatsStore = jsonbStore('artist_tracks_stats', 'artist_id');
export const ccnStore = jsonbStore('cross_cabinet_notifications');
export const ccnUnreadStore = jsonbStore('ccn_unread_counts', 'user_id');
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

// ─── CCN (Cross-Cabinet Notifications) with compound key ───

export async function getCcnByUser(userId: string) {
  const { data, error } = await db()
    .from('cross_cabinet_notifications')
    .select('*')
    .eq('target_user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db] getCcnByUser:', error);
  return (data || []).map((r: any) => r.data ?? r);
}

export async function upsertCcn(userId: string, notifId: string, notif: Record<string, any>) {
  const { error } = await db()
    .from('cross_cabinet_notifications')
    .upsert({ id: notifId, target_user_id: userId, data: notif, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) console.error('[db] upsertCcn:', error);
}

export async function getCcnUnreadCount(userId: string): Promise<number> {
  const { data, error } = await db()
    .from('ccn_unread_counts')
    .select('count')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) console.error('[db] getCcnUnreadCount:', error);
  return data?.count ?? 0;
}

export async function setCcnUnreadCount(userId: string, count: number) {
  const { error } = await db()
    .from('ccn_unread_counts')
    .upsert({ user_id: userId, count }, { onConflict: 'user_id' });
  if (error) console.error('[db] setCcnUnreadCount:', error);
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
export const audioBrandingOrdersStore = jsonbStore('audio_branding_orders');
export const audioBrandingByStatusStore = jsonbStore('audio_branding_by_status');
export const audioBrandingByVenueStore = jsonbStore('audio_branding_by_venue');
export const audioBrandingByArtistStore = jsonbStore('audio_branding_by_artist');

// ── Production 360 stores ──
export const production360OrdersStore = jsonbStore('production_360_orders');
export const production360ByStatusStore = jsonbStore('production_360_by_status');
export const production360ByArtistStore = jsonbStore('production_360_by_artist');
