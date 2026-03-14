/**
 * DJ MARKETPLACE ROUTES
 * Public endpoints for DJ Marketplace catalog
 * Uses KV store with prefix dj:profile:, dj:mixes:, dj:reviews:, dj:calendar:
 */

import { Hono } from 'hono';
import { getDjProfile, upsertDjProfile, djBookingsByDjStore, djBookingsStore, djCalendarStore, djMarketplaceIndexStore, djMixesStore, djReviewsStore } from './db.tsx';

const app = new Hono();

// ═══════ SEED DATA (initial profiles) ═══════

const SEED_PROFILES = [
  {
    id: 'dj-1', name: 'Kirill Dement',
    photo: 'https://images.unsplash.com/photo-1571266028243-3716f02d2d2e?w=400&h=400&fit=crop&crop=face',
    city: 'Москва', genres: ['Techno', 'Minimal', 'Deep House'],
    rating: 4.9, reviewsCount: 47, priceFrom: 35000, experience: '12 лет',
    verified: true, available: true, topGenre: 'Techno', completedGigs: 156,
    bio: 'Резидент Mutabor и Gazgolder. Играю на ведущих площадках от Москвы до Берлина. Авторские продакшны на Kompakt и Afterlife.',
    tags: ['Клубы', 'Фестивали', 'Underground'],
  },
  {
    id: 'dj-2', name: 'Alina Vox',
    photo: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=400&h=400&fit=crop&crop=face',
    city: 'Санкт-Петербург', genres: ['House', 'Disco', 'Nu-Disco'],
    rating: 4.8, reviewsCount: 38, priceFrom: 28000, experience: '7 лет',
    verified: true, available: true, topGenre: 'House', completedGigs: 89,
    bio: 'Солнечные грувы и виниловые сеты. Резидент Stackenschneider и Roots United. Коллекция пластинок — 3000+.',
    tags: ['Клубы', 'Бары', 'Open Air'],
  },
  {
    id: 'dj-3', name: 'Roman Shafir',
    photo: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=400&fit=crop&crop=face',
    city: 'Казань', genres: ['Trance', 'Progressive', 'Melodic Techno'],
    rating: 4.7, reviewsCount: 23, priceFrom: 20000, experience: '5 лет',
    verified: true, available: false, topGenre: 'Trance', completedGigs: 42,
    bio: 'Эмоциональные сеты с живыми синтезаторами. Играл на Alfa Future People и Outline.',
    tags: ['Фестивали', 'Клубы', 'Рейвы'],
  },
  {
    id: 'dj-4', name: 'Mila Rossa',
    photo: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&h=400&fit=crop&crop=face',
    city: 'Сочи', genres: ['Lounge', 'Deep House', 'Afro House'],
    rating: 4.9, reviewsCount: 31, priceFrom: 25000, experience: '6 лет',
    verified: true, available: true, topGenre: 'Afro House', completedGigs: 67,
    bio: 'Sunset-сеты на террасах Сочи и Дубая. Постоянный гость Hyatt, Marriott и частных вечеринок.',
    tags: ['Beach Party', 'Lounge', 'Премиум'],
  },
  {
    id: 'dj-5', name: 'Artem Groza',
    photo: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=400&fit=crop&crop=face',
    city: 'Екатеринбург', genres: ['Drum & Bass', 'Jungle', 'Breakbeat'],
    rating: 4.6, reviewsCount: 19, priceFrom: 18000, experience: '4 года',
    verified: false, available: true, topGenre: 'Drum & Bass', completedGigs: 35,
    bio: 'Уральский бас. Организатор серии вечеринок BASSLINE в Tele-Club. Релизы на Hospital Records.',
    tags: ['Клубы', 'Рейвы', 'Студенческие'],
  },
  {
    id: 'dj-6', name: 'Nadia Signal',
    photo: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=400&h=400&fit=crop&crop=face',
    city: 'Москва', genres: ['Techno', 'Electro', 'EBM'],
    rating: 4.9, reviewsCount: 41, priceFrom: 40000, experience: '9 лет',
    verified: true, available: true, topGenre: 'Techno', completedGigs: 134,
    bio: 'Жёсткий индустриальный звук. Резидент Mutabor, выступления на Awakenings и Dekmantel.',
    tags: ['Фестивали', 'Клубы', 'Industrial'],
  },
  {
    id: 'dj-7', name: 'Max Rhythm',
    photo: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400&h=400&fit=crop&crop=face',
    city: 'Краснодар', genres: ['Hip-Hop', 'R&B', 'Trap'],
    rating: 4.5, reviewsCount: 16, priceFrom: 15000, experience: '3 года',
    verified: false, available: true, topGenre: 'Hip-Hop', completedGigs: 28,
    bio: 'Южный вайб. Официальный DJ рэп-баттлов и хип-хоп фестивалей юга России.',
    tags: ['Вечеринки', 'Баттлы', 'Бары'],
  },
  {
    id: 'dj-8', name: 'Denis Kazbek',
    photo: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&h=400&fit=crop&crop=face',
    city: 'Новосибирск', genres: ['Deep House', 'Organic House', 'Downtempo'],
    rating: 4.8, reviewsCount: 26, priceFrom: 22000, experience: '8 лет',
    verified: true, available: true, topGenre: 'Deep House', completedGigs: 98,
    bio: 'Медитативный деп-хаус и органика. Продюсер лейбла Siberian Grooves. 100K+ прослушиваний на Mixcloud.',
    tags: ['Клубы', 'Yoga Party', 'Корпоративы'],
  },
];

const SEED_MIXES: Record<string, any[]> = {
  'dj-1': [
    { id: 'm1-1', title: 'Mutabor Closing Set 02.2026', genre: 'Techno', duration: '1:42:00', plays: 8740, likes: 612 },
    { id: 'm1-2', title: 'Minimal Territories — Studio Mix', genre: 'Minimal', duration: '1:08:30', plays: 4290, likes: 287 },
  ],
  'dj-2': [
    { id: 'm2-1', title: 'Vinyl Only: Disco & Nu-Disco Selects', genre: 'Nu-Disco', duration: '1:15:00', plays: 6100, likes: 438 },
    { id: 'm2-2', title: 'Stackenschneider Rooftop Live', genre: 'House', duration: '1:30:00', plays: 5200, likes: 371 },
  ],
  'dj-4': [
    { id: 'm4-1', title: 'Sunset Terrace — Hyatt Sochi', genre: 'Afro House', duration: '1:20:00', plays: 3800, likes: 245 },
  ],
  'dj-6': [
    { id: 'm6-1', title: 'Industrial Rave Podcast #47', genre: 'Techno', duration: '1:00:00', plays: 7100, likes: 503 },
    { id: 'm6-2', title: 'Awakenings Warmup — Live Recording', genre: 'Electro', duration: '1:25:00', plays: 9200, likes: 684 },
  ],
  'dj-8': [
    { id: 'm8-1', title: 'Siberian Grooves Vol. 12', genre: 'Deep House', duration: '1:10:00', plays: 4500, likes: 312 },
    { id: 'm8-2', title: 'Organic Morning — Yoga Festival Set', genre: 'Downtempo', duration: '55:00', plays: 2800, likes: 198 },
  ],
};

const SEED_REVIEWS: Record<string, any[]> = {
  'dj-1': [
    { id: 'r1', author: 'Дмитрий Л.', date: '22 фев 2026', rating: 5, text: 'Кирилл отыграл закрытие сезона в Mutabor — танцпол не пустел 4 часа. Звук безупречный, сведение на уровне.', eventType: 'Клуб' },
    { id: 'r2', author: 'Ольга М.', date: '5 янв 2026', rating: 5, text: 'Пригласили на корпоратив IT-компании. Сет от минимала до мелодик-техно — идеально прочувствовал аудиторию.', eventType: 'Корпоратив' },
    { id: 'r3', author: 'Артём В.', date: '15 дек 2025', rating: 4, text: 'Крутой техно-сет на warehouse-вечеринке. Единственное — хотелось чуть больше мелодики в середине.', eventType: 'Рейв' },
  ],
  'dj-2': [
    { id: 'r4', author: 'Катерина П.', date: '1 мар 2026', rating: 5, text: 'Алина создала невероятную атмосферу на open air у Финского залива. Виниловый сет — отдельный кайф.', eventType: 'Open Air' },
    { id: 'r5', author: 'Игорь Н.', date: '14 фев 2026', rating: 5, text: 'Играла на вечеринке в баре — публика была в восторге от диско-подборки. Профессионал с отличным вкусом.', eventType: 'Бар' },
  ],
  'dj-6': [
    { id: 'r6', author: 'Саша Р.', date: '18 фев 2026', rating: 5, text: 'Надя — королева индустриального звука. После её сета на Mutabor все остальное кажется пресным.', eventType: 'Клуб' },
  ],
};

// ═══════ SEED ENDPOINT (idempotent) ═══════
// To re-seed with updated data, delete the `seeded` key from djMarketplaceIndexStore:
//   await djMarketplaceIndexStore.delete('seeded');
// Then call POST /seed again, or let the auto-seed in GET /djs trigger.

app.post('/seed', async (c) => {
  try {
    console.log('Seeding DJ Marketplace data...');

    // Check if already seeded
    const existing = await djMarketplaceIndexStore.get('seeded');
    if (existing) {
      return c.json({ success: true, message: 'Already seeded' });
    }

    // Seed profiles
    for (const p of SEED_PROFILES) {
      await upsertDjProfile(p.id, p);
    }

    // Seed mixes
    for (const [djId, mixes] of Object.entries(SEED_MIXES)) {
      await djMixesStore.set(djId, mixes);
    }

    // Seed reviews
    for (const [djId, reviews] of Object.entries(SEED_REVIEWS)) {
      await djReviewsStore.set(djId, reviews);
    }

    // Index: list of all DJ IDs for quick listing
    await djMarketplaceIndexStore.set('singleton', SEED_PROFILES.map(p => p.id));
    await djMarketplaceIndexStore.set('seeded', true);

    console.log(`Seeded ${SEED_PROFILES.length} DJ profiles`);
    return c.json({ success: true, count: SEED_PROFILES.length });
  } catch (err: any) {
    console.error('Seed error:', err);
    return c.json({ success: false, error: `Seed error: ${err.message}` }, 500);
  }
});

// ═══════ GET /djs — List all DJs (public) ═══════

app.get('/djs', async (c) => {
  try {
    // Get index
    let index = await djMarketplaceIndexStore.get('singleton') as string[] | null;

    // Auto-seed if empty
    if (!index || index.length === 0) {
      console.log('Auto-seeding DJ data on first request...');
      for (const p of SEED_PROFILES) {
        await upsertDjProfile(p.id, p);
      }
      for (const [djId, mixes] of Object.entries(SEED_MIXES)) {
        await djMixesStore.set(djId, mixes);
      }
      for (const [djId, reviews] of Object.entries(SEED_REVIEWS)) {
        await djReviewsStore.set(djId, reviews);
      }
      index = SEED_PROFILES.map(p => p.id);
      await djMarketplaceIndexStore.set('singleton', index);
      await djMarketplaceIndexStore.set('seeded', true);
    }

    // Fetch all profiles
    const profiles = await Promise.all(index.map((id: string) => getDjProfile(id)));
    const validProfiles = profiles.filter(Boolean);

    // Server-side filtering
    const query = c.req.query();
    let result = [...validProfiles] as any[];

    if (query.city) {
      result = result.filter((p: any) => p.city === query.city);
    }
    if (query.genre) {
      result = result.filter((p: any) => p.genres?.includes(query.genre));
    }
    if (query.verified === 'true') {
      result = result.filter((p: any) => p.verified);
    }
    if (query.available === 'true') {
      result = result.filter((p: any) => p.available);
    }
    if (query.price_min) {
      result = result.filter((p: any) => p.priceFrom >= Number(query.price_min));
    }
    if (query.price_max && query.price_max !== 'Infinity') {
      result = result.filter((p: any) => p.priceFrom <= Number(query.price_max));
    }
    if (query.search) {
      const q = query.search.toLowerCase();
      result = result.filter((p: any) =>
        p.name.toLowerCase().includes(q) ||
        p.city.toLowerCase().includes(q) ||
        p.genres.some((g: string) => g.toLowerCase().includes(q)) ||
        p.tags.some((t: string) => t.toLowerCase().includes(q))
      );
    }

    // Sort
    const sortBy = query.sort || 'rating';
    result.sort((a: any, b: any) => {
      switch (sortBy) {
        case 'rating': return b.rating - a.rating;
        case 'price_asc': return a.priceFrom - b.priceFrom;
        case 'price_desc': return b.priceFrom - a.priceFrom;
        case 'popularity': return b.completedGigs - a.completedGigs;
        default: return 0;
      }
    });

    return c.json({ success: true, data: result, total: result.length });
  } catch (err: any) {
    console.error('Error fetching DJ list:', err);
    return c.json({ success: false, error: `Failed to fetch DJs: ${err.message}` }, 500);
  }
});

// ═══════ GET /djs/:id — Single DJ profile (public) ═══════

app.get('/djs/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const profile = await getDjProfile(id);
    if (!profile) {
      return c.json({ success: false, error: `DJ not found: ${id}` }, 404);
    }
    return c.json({ success: true, data: profile });
  } catch (err: any) {
    console.error('Error fetching DJ profile:', err);
    return c.json({ success: false, error: `Failed to fetch DJ: ${err.message}` }, 500);
  }
});

// ═══════ GET /djs/:id/mixes — DJ mixes (public) ═══════

app.get('/djs/:id/mixes', async (c) => {
  try {
    const id = c.req.param('id');
    const mixes = await djMixesStore.get(id) || [];
    return c.json({ success: true, data: mixes });
  } catch (err: any) {
    console.error('Error fetching DJ mixes:', err);
    return c.json({ success: false, error: `Failed to fetch mixes: ${err.message}` }, 500);
  }
});

// ═══════ GET /djs/:id/reviews — DJ reviews (public) ═══════

app.get('/djs/:id/reviews', async (c) => {
  try {
    const id = c.req.param('id');
    const reviews = await djReviewsStore.get(id) || [];
    return c.json({ success: true, data: reviews });
  } catch (err: any) {
    console.error('Error fetching DJ reviews:', err);
    return c.json({ success: false, error: `Failed to fetch reviews: ${err.message}` }, 500);
  }
});

// ═══════ GET /djs/:id/calendar — DJ availability (public) ═══════

app.get('/djs/:id/calendar', async (c) => {
  try {
    const id = c.req.param('id');
    // Check for stored calendar, or generate default
    let calendar = await djCalendarStore.get(id);
    if (!calendar) {
      // Generate default 21-day calendar
      const days = [];
      const now = new Date();
      for (let i = 0; i < 21; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        days.push({
          date: d.toISOString().split('T')[0],
          dayOfWeek: d.toLocaleDateString('ru-RU', { weekday: 'short' }),
          dayNum: d.getDate(),
          month: d.toLocaleDateString('ru-RU', { month: 'short' }),
          available: Math.random() > 0.35,
        });
      }
      calendar = days;
    }
    return c.json({ success: true, data: calendar });
  } catch (err: any) {
    console.error('Error fetching DJ calendar:', err);
    return c.json({ success: false, error: `Failed to fetch calendar: ${err.message}` }, 500);
  }
});

// ═══════ POST /djs/:id/book — Request booking (requires login intent) ═══════

app.post('/djs/:id/book', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    
    const profile = await getDjProfile(id);
    if (!profile) {
      return c.json({ success: false, error: `DJ not found: ${id}` }, 404);
    }

    const bookingId = `booking-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const booking = {
      id: bookingId,
      djId: id,
      djName: (profile as any).name,
      clientName: body.clientName || 'Аноним',
      clientEmail: body.clientEmail || '',
      eventDate: body.eventDate || '',
      eventType: body.eventType || '',
      message: body.message || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await djBookingsStore.set(bookingId, booking);

    // Add to DJ's bookings list
    const existingBookings = (await djBookingsByDjStore.get(id) || []) as string[];
    existingBookings.push(bookingId);
    await djBookingsByDjStore.set(id, existingBookings);

    console.log(`New booking request: ${bookingId} for DJ ${id}`);
    return c.json({ success: true, data: booking });
  } catch (err: any) {
    console.error('Booking error:', err);
    return c.json({ success: false, error: `Booking failed: ${err.message}` }, 500);
  }
});

export default app;