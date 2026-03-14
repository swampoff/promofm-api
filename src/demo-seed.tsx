/**
 * DEMO DATA SEED — Реалистичные данные маркетплейса
 * Биты, услуги, цифровые товары
 */

import {
  upsertBeat, producerServicesStore, digitalGoodsStore, platformStatsStore,
  systemConfigStore,
} from './db.tsx';

const SEED_VERSION = 'marketplace_v1';

function genId(prefix: string): string {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rnd}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/* ════════════════════════════════ */
/*  BEATS                          */
/* ════════════════════════════════ */

const SEED_BEATS = [
  { title: 'Midnight Drive', producer: 'VORTEX', genre: 'Trap', bpm: 140, key: 'Am', tags: ['dark', 'aggressive', 'hard'], price: 3500, plays: 1247, likes: 89, purchases: 12, rating: 4.7, duration: '3:24', daysOld: 3 },
  { title: 'Golden Hour', producer: 'AstroBeats', genre: 'Pop', bpm: 120, key: 'C', tags: ['bright', 'summer', 'catchy'], price: 5000, plays: 3420, likes: 234, purchases: 28, rating: 4.9, duration: '3:45', daysOld: 7 },
  { title: 'Ночной Город', producer: 'ДимаProd', genre: 'Hip-Hop', bpm: 95, key: 'Dm', tags: ['boom bap', 'chill', 'night'], price: 2500, plays: 856, likes: 67, purchases: 8, rating: 4.5, duration: '3:12', daysOld: 1 },
  { title: 'Phantom', producer: 'VORTEX', genre: 'Drill', bpm: 145, key: 'Gm', tags: ['drill', 'uk', 'sliding'], price: 4000, plays: 2100, likes: 156, purchases: 19, rating: 4.8, duration: '2:58', daysOld: 5 },
  { title: 'Рассвет', producer: 'CloudNine', genre: 'Lo-Fi', bpm: 85, key: 'F', tags: ['lofi', 'chill', 'study'], price: 1500, plays: 4560, likes: 312, purchases: 34, rating: 4.6, duration: '2:44', daysOld: 14 },
  { title: 'Neon Rush', producer: 'BeatLab Moscow', genre: 'Electronic', bpm: 128, key: 'Eb', tags: ['synth', 'retro', 'cyberpunk'], price: 6000, plays: 1890, likes: 145, purchases: 15, rating: 4.4, duration: '4:10', daysOld: 10 },
  { title: 'Velvet Dreams', producer: 'SoulCraft', genre: 'R&B', bpm: 75, key: 'Bb', tags: ['smooth', 'slow', 'emotional'], price: 4500, plays: 2340, likes: 178, purchases: 22, rating: 4.8, duration: '3:30', daysOld: 8 },
  { title: 'Штурм', producer: 'GrimBeatz', genre: 'Trap', bpm: 150, key: 'Cm', tags: ['hard', 'bass', 'heavy'], price: 3000, plays: 980, likes: 72, purchases: 9, rating: 4.3, duration: '3:05', daysOld: 2 },
  { title: 'Endless Sky', producer: 'AstroBeats', genre: 'Pop', bpm: 110, key: 'G', tags: ['uplifting', 'vocal', 'radio'], price: 7000, plays: 5670, likes: 445, purchases: 41, rating: 4.9, duration: '3:38', daysOld: 20 },
  { title: 'Deep Focus', producer: 'CloudNine', genre: 'Lo-Fi', bpm: 80, key: 'Ab', tags: ['ambient', 'focus', 'tape'], price: 1200, plays: 8900, likes: 567, purchases: 55, rating: 4.7, duration: '2:55', daysOld: 30 },
  { title: 'Метро', producer: 'ДимаProd', genre: 'Hip-Hop', bpm: 90, key: 'Em', tags: ['underground', 'raw', 'real'], price: 2000, plays: 1450, likes: 98, purchases: 11, rating: 4.4, duration: '3:18', daysOld: 6 },
  { title: 'Eclipse', producer: 'NovaBeat', genre: 'House', bpm: 124, key: 'Fm', tags: ['deep house', 'groove', 'dance'], price: 5500, plays: 3200, likes: 210, purchases: 24, rating: 4.6, duration: '5:20', daysOld: 12 },
  { title: 'Тени', producer: 'GrimBeatz', genre: 'Drill', bpm: 142, key: 'Bbm', tags: ['dark', 'menacing', 'street'], price: 3500, plays: 1780, likes: 134, purchases: 16, rating: 4.5, duration: '2:50', daysOld: 4 },
  { title: 'Crystal Clear', producer: 'SoulCraft', genre: 'R&B', bpm: 70, key: 'Db', tags: ['clean', 'vocals', 'love'], price: 5000, plays: 2890, likes: 201, purchases: 26, rating: 4.7, duration: '3:42', daysOld: 15 },
  { title: 'Voltage', producer: 'BeatLab Moscow', genre: 'Techno', bpm: 135, key: 'A', tags: ['minimal', 'dark', 'industrial'], price: 4000, plays: 1100, likes: 78, purchases: 7, rating: 4.2, duration: '5:45', daysOld: 9 },
  { title: 'Sunshine State', producer: 'AstroBeats', genre: 'Dance', bpm: 126, key: 'D', tags: ['tropical', 'festival', 'feel good'], price: 6500, plays: 4100, likes: 330, purchases: 35, rating: 4.8, duration: '3:55', daysOld: 18 },
  { title: 'Ветер', producer: 'CloudNine', genre: 'Indie', bpm: 100, key: 'E', tags: ['indie', 'guitar', 'dream'], price: 2500, plays: 1670, likes: 120, purchases: 13, rating: 4.5, duration: '3:28', daysOld: 11 },
  { title: 'Rage Mode', producer: 'VORTEX', genre: 'Trap', bpm: 155, key: 'Fm', tags: ['rage', 'phonk', 'distorted'], price: 3000, plays: 2450, likes: 189, purchases: 20, rating: 4.6, duration: '2:40', daysOld: 0 },
  { title: 'Jazz Cat', producer: 'NovaBeat', genre: 'Jazz', bpm: 105, key: 'Gb', tags: ['jazz', 'sax', 'smooth'], price: 4500, plays: 980, likes: 65, purchases: 6, rating: 4.3, duration: '4:15', daysOld: 22 },
  { title: 'Gravity', producer: 'SoulCraft', genre: 'Electronic', bpm: 118, key: 'Cm', tags: ['atmospheric', 'cinematic', 'epic'], price: 8000, plays: 3450, likes: 267, purchases: 30, rating: 4.9, duration: '4:30', daysOld: 25 },
];

/* ════════════════════════════════ */
/*  SERVICES                       */
/* ════════════════════════════════ */

const SEED_SERVICES = [
  { title: 'Профессиональное сведение трека', producer: 'Алексей Миронов', type: 'mixing', description: 'Сведение вашего трека на профессиональном оборудовании. Waves, FabFilter, SSL. Опыт 8 лет, 500+ проектов.', basePrice: 8000, maxPrice: 25000, deliveryDays: 5, rating: 4.9, orders: 147, includes: ['Сведение до 40 дорожек', 'Vocal tuning', '3 ревизии', 'Мастер-шина', 'Стемы'] },
  { title: 'Мастеринг для стримингов', producer: 'Sound Factory', type: 'mastering', description: 'Мастеринг по стандартам Spotify, Apple Music, Яндекс.Музыка. LUFS -14, True Peak -1dB.', basePrice: 3000, maxPrice: 8000, deliveryDays: 2, rating: 4.8, orders: 312, includes: ['Мастеринг 1 трека', 'Формат WAV 24bit', 'Проверка на моно', 'ISRC код'] },
  { title: 'Создание бита под ключ', producer: 'VORTEX', type: 'beatmaking', description: 'Авторский бит в любом жанре: trap, drill, pop, R&B. Уникальное звучание. Стемы включены.', basePrice: 15000, maxPrice: 50000, deliveryDays: 7, rating: 4.7, orders: 89, includes: ['Бит с нуля', 'До 3 правок', 'WAV стемы', 'Exclusive права'] },
  { title: 'Аранжировка и продюсирование', producer: 'BeatLab Moscow', type: 'arrangement', description: 'Полная аранжировка: от демо-записи до финального продакшна. Живые инструменты + электроника.', basePrice: 12000, maxPrice: 40000, deliveryDays: 10, rating: 4.8, orders: 64, includes: ['Аранжировка', 'Подбор аккордов', 'Инструментовка', '5 правок', 'MIDI файлы'] },
  { title: 'Саунд-дизайн для проекта', producer: 'NovaBeat', type: 'sound_design', description: 'Создание уникальных звуков, пресетов, эффектов. Serum, Vital, Omnisphere.', basePrice: 5000, maxPrice: 20000, deliveryDays: 5, rating: 4.6, orders: 43, includes: ['10 кастомных звуков', 'Пресеты Serum/Vital', 'Одношотки WAV', 'Коммерческая лицензия'] },
  { title: 'Запись вокала в студии', producer: 'VoiceBox Studio', type: 'vocal_recording', description: 'Профессиональная вокальная кабина, Neumann U87, Universal Audio. Центр Москвы.', basePrice: 5000, maxPrice: 15000, deliveryDays: 3, rating: 4.9, orders: 201, includes: ['1 час записи', 'Базовая обработка', 'WAV 24/96', 'Дополнительные дубли'] },
  { title: 'Гост-продакшн полного цикла', producer: 'SoulCraft', type: 'ghost_production', description: 'Полностью готовый трек под ваше имя. NDA гарантирован. Любой жанр.', basePrice: 30000, maxPrice: 100000, deliveryDays: 14, rating: 4.7, orders: 28, includes: ['Полный трек', 'Exclusive права', 'Стемы', 'NDA', 'Неограниченные правки'] },
  { title: 'Консультация продюсера', producer: 'Алексей Миронов', type: 'consultation', description: 'Разбор вашего микса, рекомендации по карьере, помощь с релизом. Zoom / Telegram.', basePrice: 3000, maxPrice: 5000, deliveryDays: 1, rating: 4.8, orders: 56, includes: ['1 час консультации', 'Запись сессии', 'Чек-лист рекомендаций', 'Follow-up в чате'] },
  { title: 'Сессионная гитара / бас', producer: 'Кирилл Guitar', type: 'session_musician', description: 'Живая гитара и бас для вашего трека. Электро, акустика, бас. Все жанры.', basePrice: 4000, maxPrice: 12000, deliveryDays: 4, rating: 4.6, orders: 78, includes: ['Запись партии', 'DI + Amped', '2 варианта', 'WAV стемы'] },
  { title: 'Сведение и мастеринг комплекс', producer: 'Sound Factory', type: 'mixing', description: 'Полный пакет: сведение + мастеринг + подготовка к дистрибуции. Скидка 20% от отдельных услуг.', basePrice: 9000, maxPrice: 30000, deliveryDays: 7, rating: 4.9, orders: 95, includes: ['Сведение', 'Мастеринг', 'Стемы', '5 ревизий', 'Все форматы'] },
  { title: 'Вокальный продакшн', producer: 'AstroBeats', type: 'vocal_recording', description: 'Обработка вокала: тюнинг, даблинг, эффекты, бэк-вокал. Melodyne + Auto-Tune.', basePrice: 4000, maxPrice: 10000, deliveryDays: 3, rating: 4.5, orders: 67, includes: ['Pitch correction', 'Timing alignment', 'Doubles/harmonies', 'FX цепочка'] },
  { title: 'Написание текста / рэп', producer: 'WordSmith', type: 'consultation', description: 'Написание текста для трека: рэп, поп, R&B. Под ваш бит или под заказ. 10 лет опыта.', basePrice: 5000, maxPrice: 15000, deliveryDays: 3, rating: 4.4, orders: 42, includes: ['Текст 1 куплет + припев', 'Подбор рифм', '2 варианта', 'Доработка'] },
];

/* ════════════════════════════════ */
/*  DIGITAL GOODS                  */
/* ════════════════════════════════ */

const SEED_DIGITAL_GOODS = [
  { title: 'Trap Essentials Vol.1', producer: 'VORTEX', category: 'sample_pack', description: '150+ сэмплов для трэпа: 808, hi-hats, claps, FX. Royalty-free.', price: 1490, tags: ['trap', '808', 'hi-hat', 'sample pack'], fileSize: '320 MB', format: 'WAV 24bit', rating: 4.8, sales: 234, views: 1890 },
  { title: 'Lo-Fi Vinyl Kit', producer: 'CloudNine', category: 'drum_kit', description: 'Драм-кит в стиле lo-fi: виниловый шум, мягкие бочки, тёплые snare.', price: 790, tags: ['lofi', 'vinyl', 'drum kit', 'chill'], fileSize: '180 MB', format: 'WAV 24bit', rating: 4.7, sales: 189, views: 2340 },
  { title: 'Serum Presets: Future Bass', producer: 'NovaBeat', category: 'preset', description: '64 пресета для Xfer Serum: supersaws, plucks, pads, basses.', price: 2490, tags: ['serum', 'future bass', 'synth', 'preset'], fileSize: '45 MB', format: 'FXP', rating: 4.6, sales: 156, views: 1450 },
  { title: 'Drill 808 Pack', producer: 'GrimBeatz', category: 'drum_kit', description: '50 custom 808s для drill и trap. Tuned, processed, ready to go.', price: 590, tags: ['drill', '808', 'bass', 'sub'], fileSize: '95 MB', format: 'WAV 24bit', rating: 4.5, sales: 312, views: 3200 },
  { title: 'Видеокурс: Сведение с нуля', producer: 'Алексей Миронов', category: 'tutorial', description: '12 уроков по сведению в Ableton/FL Studio. От основ до продвинутых техник. 6 часов.', price: 4990, tags: ['mixing', 'tutorial', 'ableton', 'fl studio'], fileSize: '4.2 GB', format: 'MP4', rating: 4.9, sales: 89, views: 4500 },
  { title: 'Vocal Chain Template', producer: 'Sound Factory', category: 'template', description: 'Готовая цепочка обработки вокала для FL Studio 21+. Autotune + EQ + Comp + FX.', price: 990, tags: ['vocal', 'template', 'fl studio', 'chain'], fileSize: '25 MB', format: 'FLP', rating: 4.4, sales: 267, views: 2100 },
  { title: 'Melody Loops: R&B/Soul', producer: 'SoulCraft', category: 'loop', description: '40 мелодических лупов: keys, guitar, strings. 70-90 BPM, MIDI включён.', price: 1290, tags: ['melody', 'rnb', 'soul', 'loops'], fileSize: '250 MB', format: 'WAV + MIDI', rating: 4.7, sales: 178, views: 1780 },
  { title: 'Omnisphere Bank: Ambient', producer: 'BeatLab Moscow', category: 'preset', description: '48 атмосферных пресетов для Spectrasonics Omnisphere 2. Pads, textures, evolving.', price: 3490, tags: ['omnisphere', 'ambient', 'pads', 'textures'], fileSize: '12 MB', format: 'OMNI', rating: 4.5, sales: 67, views: 890 },
  { title: 'Видеокурс: Мастеринг дома', producer: 'Sound Factory', category: 'tutorial', description: '8 уроков по мастерингу в домашних условиях. iZotope Ozone, FabFilter Pro-L.', price: 3490, tags: ['mastering', 'tutorial', 'ozone', 'limiter'], fileSize: '3.1 GB', format: 'MP4', rating: 4.8, sales: 112, views: 3400 },
  { title: 'Electronic Producer Starter Kit', producer: 'NovaBeat', category: 'sample_pack', description: '500+ сэмплов: синты, басы, FX, перкуссия. House, techno, trance.', price: 2990, tags: ['electronic', 'house', 'techno', 'sample pack'], fileSize: '780 MB', format: 'WAV 24bit', rating: 4.6, sales: 145, views: 2670 },
  { title: 'Trap Melody MIDI Pack', producer: 'VORTEX', category: 'loop', description: '60 MIDI мелодий для trap и hip-hop. Все тональности, все темпы.', price: 690, tags: ['midi', 'melody', 'trap', 'hip-hop'], fileSize: '8 MB', format: 'MIDI', rating: 4.3, sales: 423, views: 5100 },
  { title: 'Pop Vocal Template Ableton', producer: 'AstroBeats', category: 'template', description: 'Шаблон Ableton Live 11+ для поп-вокала. Обработка, автотюн, реверб, дилэй.', price: 1490, tags: ['ableton', 'vocal', 'pop', 'template'], fileSize: '35 MB', format: 'ALS', rating: 4.5, sales: 98, views: 1340 },
];

/* ════════════════════════════════ */
/*  SEED FUNCTIONS                 */
/* ════════════════════════════════ */

const PRODUCER_IDS: Record<string, string> = {};
function getProducerId(name: string): string {
  if (!PRODUCER_IDS[name]) {
    PRODUCER_IDS[name] = `producer-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return PRODUCER_IDS[name];
}

export async function seedDemoData(): Promise<{ seeded: boolean; message: string }> {
  try {
    // Idempotency: skip if already seeded this version
    const existing = await systemConfigStore.get(`seed:${SEED_VERSION}`);
    if (existing) {
      return { seeded: false, message: `Already seeded (${SEED_VERSION})` };
    }

    let beatsCreated = 0;
    let servicesCreated = 0;
    let goodsCreated = 0;

    // Seed beats
    for (const b of SEED_BEATS) {
      const id = genId('beat');
      const producerId = getProducerId(b.producer);
      const beat = {
        id,
        title: b.title,
        producer: b.producer,
        producerId,
        genre: b.genre,
        bpm: b.bpm,
        key: b.key,
        tags: b.tags,
        duration: b.duration,
        price: b.price,
        plays: b.plays,
        purchases: b.purchases,
        likes: b.likes,
        rating: b.rating,
        status: 'active',
        licenseTypes: {
          basic: b.price,
          premium: Math.round(b.price * 3),
          exclusive: Math.round(b.price * 10),
        },
        createdAt: daysAgo(b.daysOld),
      };
      await upsertBeat(id, beat);
      beatsCreated++;
    }

    // Seed services
    for (const s of SEED_SERVICES) {
      const id = genId('svc');
      const producerId = getProducerId(s.producer);
      const service = {
        id,
        title: s.title,
        producer: s.producer,
        producerId,
        type: s.type,
        description: s.description,
        basePrice: s.basePrice,
        minPrice: s.basePrice,
        maxPrice: s.maxPrice,
        price: s.basePrice,
        deliveryDays: s.deliveryDays,
        rating: s.rating,
        orders: s.orders,
        status: 'active',
        includes: s.includes,
        createdAt: daysAgo(Math.floor(Math.random() * 60)),
      };
      await producerServicesStore.set(id, service);
      servicesCreated++;
    }

    // Seed digital goods
    for (const g of SEED_DIGITAL_GOODS) {
      const id = genId('dg');
      const producerId = getProducerId(g.producer);
      const good = {
        id,
        title: g.title,
        producer: g.producer,
        producerId,
        category: g.category,
        description: g.description,
        price: g.price,
        tags: g.tags,
        fileSize: g.fileSize,
        format: g.format,
        rating: g.rating,
        sales: g.sales,
        views: g.views,
        status: 'active',
        createdAt: daysAgo(Math.floor(Math.random() * 45)),
      };
      await digitalGoodsStore.set(id, good);
      goodsCreated++;
    }

    // Update platform stats
    const stats = {
      totalBeats: beatsCreated,
      totalServices: servicesCreated,
      totalDigitalGoods: goodsCreated,
      totalSold: SEED_BEATS.reduce((sum, b) => sum + b.purchases, 0),
      totalRevenue: 0,
      activeProducers: Object.keys(PRODUCER_IDS).length,
    };
    await platformStatsStore.set('platform', stats);

    // Mark as seeded
    await systemConfigStore.set(`seed:${SEED_VERSION}`, { seededAt: new Date().toISOString(), ...stats });

    return {
      seeded: true,
      message: `Seeded ${beatsCreated} beats, ${servicesCreated} services, ${goodsCreated} digital goods, ${stats.activeProducers} producers`,
    };
  } catch (err: any) {
    return { seeded: false, message: `Seed error: ${err.message || err}` };
  }
}

export async function reseedDemoData(): Promise<{ seeded: boolean; message: string }> {
  // Force re-seed by clearing the version key
  try { await systemConfigStore.del(`seed:${SEED_VERSION}`); } catch (_) {}
  return seedDemoData();
}

export async function seedDevLabData(): Promise<{ seeded: boolean; message: string }> {
  return { seeded: false, message: 'Lab seeding not needed' };
}
