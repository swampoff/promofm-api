/**
 * DB-TYPED.TSX — Typed table access functions
 * Direct SQL queries on properly-typed tables (tracks, concerts, banner_ads)
 * Instead of KV-style JSONB stores.
 *
 * Key principle: ONE row per entity, status column controls visibility.
 * moderation_status: draft → pending → approved/rejected → published
 */

import { getDbClient } from './db-client.tsx';

const db = () => getDbClient();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════
// TRACKS (typed `tracks` table)
// ═══════════════════════════════════════

export async function getTrackById(trackId: string) {
  if (!UUID_RE.test(trackId)) return null;  // non-UUID id (e.g. 'marketplace') — skip
  const { data, error } = await db()
    .from('tracks')
    .select('*')
    .eq('id', trackId)
    .maybeSingle();
  if (error) console.error('[db-typed] getTrackById:', error);
  return data;
}

export async function getTracksByUser(userId: string) {
  const { data, error } = await db()
    .from('tracks')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db-typed] getTracksByUser:', error);
  return data || [];
}

export async function getTracksByStatus(status: string) {
  const { data, error } = await db()
    .from('tracks')
    .select('*')
    .eq('moderation_status', status)
    .order('created_at', { ascending: false });
  if (error) console.error('[db-typed] getTracksByStatus:', error);
  return data || [];
}

export async function getAllTracksForModeration(filters?: { status?: string; genre?: string; search?: string }) {
  let q = db().from('tracks').select('*');

  if (filters?.status && filters.status !== 'all') {
    q = q.eq('moderation_status', filters.status);
  }
  if (filters?.genre) {
    q = q.eq('genre', filters.genre);
  }
  if (filters?.search) {
    q = q.or(`title.ilike.%${filters.search}%,artist_name.ilike.%${filters.search}%`);
  }

  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) console.error('[db-typed] getAllTracksForModeration:', error);
  return data || [];
}

export async function getPublishedTracks(limit = 50, orderBy: 'created_at' | 'plays_count' = 'created_at') {
  const { data, error } = await db()
    .from('tracks')
    .select('*')
    .in('moderation_status', ['approved', 'published'])
    .eq('is_hidden', false)
    .neq('artist_name', '')
    .order(orderBy, { ascending: false })
    .limit(limit);
  if (error) console.error('[db-typed] getPublishedTracks:', error);
  return data || [];
}

export async function getPublishedTracksByGenre(genre: string, limit = 20) {
  const { data, error } = await db()
    .from('tracks')
    .select('*')
    .in('moderation_status', ['approved', 'published'])
    .eq('genre', genre)
    .eq('is_hidden', false)
    .order('plays_count', { ascending: false })
    .limit(limit);
  if (error) console.error('[db-typed] getPublishedTracksByGenre:', error);
  return data || [];
}

export async function insertTrack(track: Record<string, any>) {
  const { data, error } = await db()
    .from('tracks')
    .insert({
      title: track.title || '',
      artist_name: track.artist_name || track.artist || '',
      genre: track.genre || '',
      duration: track.duration || 0,
      audio_url: track.audio_url || track.audio_file_url || '',
      cover_url: track.cover_url || track.cover_image_url || '',
      description: track.description || '',
      lyrics: track.lyrics || '',
      user_id: track.user_id || null,
      artist_id: track.artist_id || null,
      moderation_status: track.moderation_status || 'draft',
      yandex_music_url: track.yandex_music_url || '',
      youtube_url: track.youtube_url || '',
      spotify_url: track.spotify_url || '',
      apple_music_url: track.apple_music_url || '',
      uploaded_by_email: track.uploaded_by_email || '',
      tags: track.tags || [],
      credits: track.credits || {},
      rights: track.rights || {},
      is_paid: track.is_paid || false,
      data: track.data || {},
    })
    .select()
    .single();
  if (error) console.error('[db-typed] insertTrack:', error);
  return data;
}

export async function updateTrack(trackId: string, updates: Record<string, any>) {
  const { data, error } = await db()
    .from('tracks')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', trackId)
    .select()
    .single();
  if (error) console.error('[db-typed] updateTrack:', error);
  return data;
}

export async function deleteTrack(trackId: string) {
  const { error } = await db()
    .from('tracks')
    .delete()
    .eq('id', trackId);
  if (error) console.error('[db-typed] deleteTrack:', error);
}

export async function getTrackModerationStats() {
  const { data, error } = await db()
    .from('tracks')
    .select('moderation_status')
    .not('moderation_status', 'eq', 'draft');
  if (error) console.error('[db-typed] getTrackModerationStats:', error);

  const tracks = data || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return {
    total: tracks.length,
    pending: tracks.filter((t: any) => t.moderation_status === 'pending').length,
    approved: tracks.filter((t: any) => ['approved', 'published'].includes(t.moderation_status)).length,
    rejected: tracks.filter((t: any) => t.moderation_status === 'rejected').length,
  };
}

export async function searchPublishedTracks(query: string, limit = 10) {
  const { data, error } = await db()
    .from('tracks')
    .select('*')
    .in('moderation_status', ['approved', 'published'])
    .or(`title.ilike.%${query}%,artist_name.ilike.%${query}%,genre.ilike.%${query}%`)
    .limit(limit);
  if (error) console.error('[db-typed] searchPublishedTracks:', error);
  return data || [];
}

// ═══════════════════════════════════════
// CONCERTS (typed `concerts` table)
// ═══════════════════════════════════════

export async function getConcertById(concertId: string) {
  const { data, error } = await db()
    .from('concerts')
    .select('*')
    .eq('id', concertId)
    .maybeSingle();
  if (error) console.error('[db-typed] getConcertById:', error);
  return data;
}

export async function getConcertsByUser(userId: string) {
  const { data, error } = await db()
    .from('concerts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db-typed] getConcertsByUser:', error);
  return data || [];
}

export async function getPublishedConcerts(limit = 20) {
  const now = new Date().toISOString().split('T')[0];
  const { data, error } = await db()
    .from('concerts')
    .select('*')
    .in('moderation_status', ['approved', 'published'])
    .gte('event_date', now)
    .eq('is_cancelled', false)
    .order('event_date', { ascending: true })
    .limit(limit);
  if (error) console.error('[db-typed] getPublishedConcerts:', error);
  return data || [];
}

export async function getPromotedConcerts(limit = 10) {
  const now = new Date().toISOString().split('T')[0];
  const { data, error } = await db()
    .from('concerts')
    .select('*')
    .in('moderation_status', ['approved', 'published'])
    .eq('is_promoted', true)
    .gte('event_date', now)
    .eq('is_cancelled', false)
    .order('event_date', { ascending: true })
    .limit(limit);
  if (error) console.error('[db-typed] getPromotedConcerts:', error);
  return data || [];
}

export async function getAllConcertsForModeration(status?: string) {
  let q = db().from('concerts').select('*');
  if (status && status !== 'all') {
    q = q.eq('moderation_status', status);
  }
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) console.error('[db-typed] getAllConcertsForModeration:', error);
  return data || [];
}

export async function insertConcert(concert: Record<string, any>) {
  const { data, error } = await db()
    .from('concerts')
    .insert({
      title: concert.title || '',
      description: concert.description || '',
      city: concert.city || '',
      venue_name: concert.venue_name || concert.venue || '',
      venue_address: concert.venue_address || '',
      event_date: concert.event_date || concert.date || null,
      event_time: concert.event_time || concert.time || '19:00',
      event_type: concert.event_type || concert.type || 'Концерт',
      banner_image_url: concert.banner_image_url || concert.banner || '',
      ticket_price_min: concert.ticket_price_min || concert.ticketPriceFrom || null,
      ticket_price_max: concert.ticket_price_max || concert.ticketPriceTo || null,
      ticket_link: concert.ticket_link || concert.ticketLink || '',
      ticket_capacity: concert.ticket_capacity || null,
      user_id: concert.user_id || null,
      artist_id: concert.artist_id || null,
      artist_name: concert.artist_name || concert.artist || '',
      moderation_status: concert.moderation_status || 'draft',
      source: concert.source || 'user',
      data: concert.data || {},
    })
    .select()
    .single();
  if (error) console.error('[db-typed] insertConcert:', error);
  return data;
}

export async function updateConcert(concertId: string, updates: Record<string, any>) {
  const { data, error } = await db()
    .from('concerts')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', concertId)
    .select()
    .single();
  if (error) console.error('[db-typed] updateConcert:', error);
  return data;
}

export async function deleteConcert(concertId: string) {
  const { error } = await db()
    .from('concerts')
    .delete()
    .eq('id', concertId);
  if (error) console.error('[db-typed] deleteConcert:', error);
}

// ═══════════════════════════════════════
// BANNERS (typed `banner_ads` table)
// ═══════════════════════════════════════

export async function getBannerById(bannerId: string) {
  const { data, error } = await db()
    .from('banner_ads')
    .select('*')
    .eq('id', bannerId)
    .maybeSingle();
  if (error) console.error('[db-typed] getBannerById:', error);
  return data;
}

export async function getBannersByUser(userId: string) {
  const { data, error } = await db()
    .from('banner_ads')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[db-typed] getBannersByUser:', error);
  return data || [];
}

export async function getActiveBanners(placement?: string) {
  const now = new Date().toISOString();
  let q = db()
    .from('banner_ads')
    .select('*')
    .eq('status', 'active')
    .eq('moderation_status', 'approved')
    .lte('start_date', now)
    .gte('end_date', now);

  if (placement) {
    q = q.or(`placement.eq.${placement},placement.eq.all`);
  }

  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) console.error('[db-typed] getActiveBanners:', error);
  return data || [];
}

export async function getAllBannersForModeration(status?: string) {
  let q = db().from('banner_ads').select('*');
  if (status && status !== 'all') {
    q = q.eq('moderation_status', status);
  }
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) console.error('[db-typed] getAllBannersForModeration:', error);
  return data || [];
}

export async function insertBanner(banner: Record<string, any>) {
  const { data, error } = await db()
    .from('banner_ads')
    .insert({
      title: banner.title || '',
      description: banner.description || '',
      campaign_name: banner.campaign_name || '',
      image_url: banner.image_url || '',
      link_url: banner.link_url || banner.target_url || '',
      target_url: banner.target_url || '',
      banner_type: banner.banner_type || 'sidebar',
      placement: banner.placement || 'home',
      start_date: banner.start_date || null,
      end_date: banner.end_date || null,
      duration_days: banner.duration_days || 7,
      price: banner.price || 0,
      daily_budget: banner.daily_budget || null,
      total_budget: banner.total_budget || null,
      user_id: banner.user_id || null,
      artist_id: banner.artist_id || null,
      status: banner.status || 'draft',
      moderation_status: banner.moderation_status || 'pending',
      data: banner.data || {},
    })
    .select()
    .single();
  if (error) console.error('[db-typed] insertBanner:', error);
  return data;
}

export async function updateBanner(bannerId: string, updates: Record<string, any>) {
  const { data, error } = await db()
    .from('banner_ads')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', bannerId)
    .select()
    .single();
  if (error) console.error('[db-typed] updateBanner:', error);
  return data;
}

export async function deleteBanner(bannerId: string) {
  const { error } = await db()
    .from('banner_ads')
    .delete()
    .eq('id', bannerId);
  if (error) console.error('[db-typed] deleteBanner:', error);
}

// ═══════════════════════════════════════
// ═══════════════════════════════════════
// UPCOMING RELEASES (typed `upcoming_releases` table)
// ═══════════════════════════════════════

export async function getUpcomingReleases(limit = 6) {
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await db()
    .from("upcoming_releases")
    .select("*")
    .eq("is_archived", false)
    .gte("release_date", today)
    .order("release_date", { ascending: true })
    .limit(limit);
  if (error) console.error("[db-typed] getUpcomingReleases:", error);
  return data || [];
}

export async function getAllUpcomingReleases() {
  const { data, error } = await db()
    .from("upcoming_releases")
    .select("*")
    .eq("is_archived", false)
    .order("release_date", { ascending: true });
  if (error) console.error("[db-typed] getAllUpcomingReleases:", error);
  return data || [];
}

export async function upsertUpcomingRelease(release: Record<string, any>) {
  const { data, error } = await db()
    .from("upcoming_releases")
    .upsert({
      title: release.title || "",
      artist_name: release.artist_name || "",
      release_date: release.release_date || null,
      cover_url: release.cover_url || "",
      genre: release.genre || "",
      release_type: release.release_type || "album",
      source: release.source || "manual",
      source_url: release.source_url || "",
      spotify_url: release.spotify_url || "",
      apple_music_url: release.apple_music_url || "",
      updated_at: new Date().toISOString(),
    }, { onConflict: "artist_name,title" })
    .select()
    .single();
  if (error) console.error("[db-typed] upsertUpcomingRelease:", error);
  return data;
}

export async function archivePastReleases() {
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await db()
    .from("upcoming_releases")
    .update({ is_archived: true, updated_at: new Date().toISOString() })
    .lt("release_date", today)
    .eq("is_archived", false)
    .select();
  if (error) console.error("[db-typed] archivePastReleases:", error);
  return data || [];
}

// COINS — bridge functions for awarding coins on moderation
// ═══════════════════════════════════════

export async function awardCoins(userId: string, amount: number, description: string) {
  if (!userId || amount <= 0) return;

  const dbClient = db();

  // 1. Update balance
  const { data: existing } = await dbClient
    .from('coin_balances')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle();

  const currentBalance = Number(existing?.balance) || 0;
  const newBalance = currentBalance + Number(amount);

  await dbClient
    .from('coin_balances')
    .upsert({ user_id: userId, balance: newBalance, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

  // 2. Record transaction
  const txId = `cointx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await dbClient
    .from('coin_transactions')
    .upsert({
      id: txId,
      user_id: userId,
      data: {
        id: txId,
        userId,
        amount,
        type: 'reward',
        description,
        createdAt: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

  console.log(`[coins] Awarded ${amount} coins to ${userId}: ${description}. New balance: ${newBalance}`);
  return newBalance;
}

export async function deductCoins(userId: string, amount: number, description: string) {
  if (!userId || amount <= 0) return null;

  const dbClient = db();

  const { data: existing } = await dbClient
    .from('coin_balances')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle();

  const currentBalance = Number(existing?.balance) || 0;
  if (currentBalance < Number(amount)) {
    return { error: 'Insufficient balance', balance: currentBalance };
  }

  const newBalance = currentBalance - Number(amount);

  await dbClient
    .from('coin_balances')
    .upsert({ user_id: userId, balance: newBalance, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

  const txId = `cointx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await dbClient
    .from('coin_transactions')
    .upsert({
      id: txId,
      user_id: userId,
      data: {
        id: txId,
        userId,
        amount: -amount,
        type: 'expense',
        description,
        createdAt: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

  console.log(`[coins] Deducted ${amount} coins from ${userId}: ${description}. New balance: ${newBalance}`);
  return { balance: newBalance };
}
