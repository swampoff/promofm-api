/**
 * GENRE DETECT — определение музыкального стиля трека (2026-07-10).
 *
 * Повод: рассылка 09.07 — ВСЕ треки «Pop», включая U2 и Beyoncé.
 * Корень: friday.js при пустом/нечитаемом ID3-теге ставил дефолт 'Pop'.
 *
 * Архитектура (по мотивам marteinn/genres — таксономия+матчинг,
 * ADDinc/style_music и Denis-Mukhanov/music-genre-prediction — ML-класс
 * по аудио, у нас это tier-3 в бэклоге promo-check):
 *   Tier 1 — ID3-тег файла (уже читается в friday.js / FE-пробе) →
 *   Tier 2 — нормализация к КАНОНУ платформы (27 жанров = список формы
 *            загрузки трека, track-upload-page.tsx GENRES): числовые
 *            коды ID3v1 «(17)», en/ru-синонимы, поджанры → родитель;
 *   Tier 3 — LLM по «артист — название» (quickLLM): для известных
 *            артистов (U2 → Rock) точность близка к 100%, дешевле и
 *            проще аудио-ML. Строгая валидация: ответ вне канона =
 *            null, никаких выдуманных жанров.
 * Ничего не угадали — genre остаётся ПУСТЫМ (не 'Pop'): честное
 * «неизвестно» лучше уверенной ошибки в рассылке.
 */

import { quickLLM } from './llm-router.tsx';
import { pool } from './db-client.tsx';

// Канон = GENRES формы загрузки (Promomusicfigma track-upload-page.tsx).
// Менять синхронно с FE.
export const CANON_GENRES = [
  'Pop', 'Rock', 'Hip-Hop', 'R&B', 'Electronic', 'Dance',
  'House', 'Techno', 'Trance', 'Dubstep', 'Drum & Bass',
  'Jazz', 'Blues', 'Classical', 'Country', 'Folk',
  'Reggae', 'Afrobeat', 'Punk', 'Indie', 'Alternative',
  'Soul', 'Funk', 'Disco', 'Gospel', 'Latin', 'World',
] as const;

const CANON_LOWER = new Map(CANON_GENRES.map(g => [g.toLowerCase(), g]));

// Числовые жанры ID3v1 (тег вида "(17)" или голое число) → канон.
// Полная таблица 0–79 + Winamp-расширения, схлопнутая к 27 жанрам.
const ID3V1: Record<number, string> = {
  0: 'Blues', 1: 'Rock', 2: 'Country', 3: 'Dance', 4: 'Disco', 5: 'Funk',
  6: 'Rock', 7: 'Hip-Hop', 8: 'Jazz', 9: 'Rock', 10: 'Electronic',
  11: 'Rock', 12: 'World', 13: 'Pop', 14: 'R&B', 15: 'Hip-Hop',
  16: 'Reggae', 17: 'Rock', 18: 'Techno', 19: 'Electronic', 20: 'Alternative',
  21: 'Punk', 22: 'Rock', 24: 'Pop', 25: 'Electronic', 26: 'Electronic',
  27: 'Rock', 28: 'Electronic', 29: 'Jazz', 30: 'Rock', 31: 'Trance',
  32: 'Classical', 33: 'Electronic', 34: 'Rock', 35: 'House', 36: 'Electronic',
  37: 'Rock', 38: 'Rock', 39: 'Rock', 40: 'Rock', 41: 'Electronic',
  42: 'Soul', 43: 'Punk', 45: 'Rock', 46: 'Electronic', 47: 'Jazz',
  48: 'World', 49: 'Gospel', 50: 'Rock', 52: 'Electronic', 53: 'Pop',
  56: 'Rock', 57: 'Pop', 58: 'World', 60: 'Pop', 63: 'Rock',
  66: 'World', 67: 'Hip-Hop', 68: 'Pop', 69: 'Rock', 70: 'Rock',
  71: 'Rock', 74: 'Jazz', 76: 'Rock', 77: 'Rock', 79: 'Rock',
  80: 'Folk', 81: 'Folk', 82: 'World', 83: 'Rock', 85: 'Electronic',
  86: 'Latin', 89: 'Rock', 90: 'Rock', 91: 'Rock', 92: 'Rock',
  93: 'Rock', 94: 'Rock', 95: 'World', 96: 'Pop', 97: 'Gospel',
  107: 'Folk', 111: 'Pop', 113: 'World', 122: 'Pop', 125: 'Dance',
  131: 'Rock', 132: 'Rock', 133: 'Rock', 138: 'Rock', 140: 'World',
  141: 'Pop', 143: 'Latin', 144: 'World', 145: 'Rock', 148: 'World',
};

// Синонимы/поджанры (lower-case) → канон. en + ru, из практики ID3-тегов
// (marteinn/genres-подход: словарь имён и родительских категорий).
const ALIASES: Record<string, string> = {
  // ru
  'поп': 'Pop', 'попса': 'Pop', 'эстрада': 'Pop', 'рок': 'Rock',
  'русский рок': 'Rock', 'метал': 'Rock', 'металл': 'Rock',
  'рэп': 'Hip-Hop', 'реп': 'Hip-Hop', 'хип-хоп': 'Hip-Hop', 'хип хоп': 'Hip-Hop',
  'электроника': 'Electronic', 'электронная': 'Electronic', 'танцевальная': 'Dance',
  'джаз': 'Jazz', 'блюз': 'Blues', 'классика': 'Classical', 'классическая': 'Classical',
  'кантри': 'Country', 'фолк': 'Folk', 'народная': 'Folk', 'шансон': 'Folk',
  'регги': 'Reggae', 'панк': 'Punk', 'инди': 'Indie', 'альтернатива': 'Alternative',
  'соул': 'Soul', 'фанк': 'Funk', 'диско': 'Disco', 'госпел': 'Gospel',
  'латино': 'Latin', 'этно': 'World', 'мировая': 'World', 'рнб': 'R&B', 'р&б': 'R&B',
  'хаус': 'House', 'техно': 'Techno', 'транс': 'Trance', 'дабстеп': 'Dubstep',
  'драм-н-бейс': 'Drum & Bass', 'драм н бейс': 'Drum & Bass',
  // en-поджанры → родитель
  'hip hop': 'Hip-Hop', 'hiphop': 'Hip-Hop', 'rap': 'Hip-Hop', 'trap': 'Hip-Hop',
  'r&b/soul': 'R&B', 'rnb': 'R&B', 'urban': 'R&B',
  'classic rock': 'Rock', 'hard rock': 'Rock', 'soft rock': 'Rock',
  'metal': 'Rock', 'heavy metal': 'Rock', 'grunge': 'Rock', 'rock & roll': 'Rock',
  'rock and roll': 'Rock', 'post-rock': 'Rock', 'progressive rock': 'Rock',
  'alternative rock': 'Alternative', 'alt rock': 'Alternative', 'alternrock': 'Alternative',
  'indie rock': 'Indie', 'indie pop': 'Indie',
  'punk rock': 'Punk', 'pop punk': 'Punk',
  'edm': 'Electronic', 'electro': 'Electronic', 'electronica': 'Electronic',
  'ambient': 'Electronic', 'idm': 'Electronic', 'synthpop': 'Electronic',
  'synth-pop': 'Electronic', 'downtempo': 'Electronic', 'chillout': 'Electronic',
  'chill': 'Electronic', 'lofi': 'Electronic', 'lo-fi': 'Electronic',
  'deep house': 'House', 'tech house': 'House', 'progressive house': 'House',
  'minimal techno': 'Techno', 'psytrance': 'Trance', 'progressive trance': 'Trance',
  'dnb': 'Drum & Bass', "drum'n'bass": 'Drum & Bass', 'drum and bass': 'Drum & Bass',
  'jungle': 'Drum & Bass', 'bass': 'Dubstep',
  'dance pop': 'Dance', 'dance-pop': 'Dance', 'eurodance': 'Dance', 'club': 'Dance',
  'smooth jazz': 'Jazz', 'acid jazz': 'Jazz', 'bebop': 'Jazz', 'swing': 'Jazz',
  'rhythm and blues': 'Blues', 'delta blues': 'Blues',
  'classical crossover': 'Classical', 'orchestral': 'Classical', 'opera': 'Classical',
  'instrumental': 'Classical', 'soundtrack': 'Classical', 'score': 'Classical',
  'americana': 'Country', 'bluegrass': 'Country',
  'folk rock': 'Folk', 'singer-songwriter': 'Folk', 'acoustic': 'Folk',
  'dancehall': 'Reggae', 'ska': 'Reggae', 'dub': 'Reggae', 'reggaeton': 'Latin',
  'salsa': 'Latin', 'bachata': 'Latin', 'bossa nova': 'Latin',
  'afrobeats': 'Afrobeat', 'afro': 'Afrobeat', 'amapiano': 'Afrobeat',
  'neo-soul': 'Soul', 'neo soul': 'Soul', 'motown': 'Soul',
  'nu disco': 'Disco', 'nu-disco': 'Disco',
  'christian': 'Gospel', 'worship': 'Gospel',
  'world music': 'World', 'ethnic': 'World', 'new age': 'World',
  'k-pop': 'Pop', 'kpop': 'Pop', 'j-pop': 'Pop', 'europop': 'Pop',
  'pop rock': 'Pop', 'pop/rock': 'Pop', 'adult contemporary': 'Pop',
  'other': '', 'unknown': '', 'misc': '', 'none': '', 'default': '',
};

/**
 * Нормализовать сырой жанр (ID3-тег, ввод пользователя) к канону.
 * null — не распознан (НЕ дефолтить в Pop!).
 */
export function normalizeGenre(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  // ID3v1-код: "(17)", "(17)Rock", "17"
  const m = s.match(/^\((\d{1,3})\)\s*(.*)$/) || s.match(/^(\d{1,3})$/);
  if (m) {
    const byCode = ID3V1[parseInt(m[1], 10)];
    if (byCode) return byCode;
    s = (m[2] || '').trim();
    if (!s) return null;
  }
  // Мульти-жанр "Rock; Pop" / "Rock/Pop" — берём первый распознанный
  const parts = s.split(/[;,/|]+/).map(p => p.trim()).filter(Boolean);
  for (const p of parts.length ? parts : [s]) {
    const low = p.toLowerCase();
    const canon = CANON_LOWER.get(low);
    if (canon) return canon;
    const alias = ALIASES[low];
    if (alias !== undefined) return alias || null;
  }
  // Подстрочный матч: "Indie Electronic Pop" → первый канон-токен
  const low = s.toLowerCase();
  for (const [k, canon] of CANON_LOWER) {
    if (low.includes(k)) return canon;
  }
  return null;
}

/**
 * Tier 3: жанр по «артист — название» через LLM. Строгая валидация:
 * ответ обязан быть из канона, иначе null. Не зовём для пустых артистов.
 */
export async function detectGenreLLM(artist: string, title: string): Promise<string | null> {
  const a = (artist || '').trim();
  const t = (title || '').trim();
  if (!a && !t) return null;
  try {
    const raw = await quickLLM(
      `Ты — музыкальный классификатор. Определи жанр трека и ответь РОВНО ОДНИМ словом из списка (без пояснений): ${CANON_GENRES.join(', ')}. Если уверенности нет — ответь Unknown.`,
      `${a} — ${t}`,
      { maxTokens: 8, tag: 'genre-detect' }
    );
    const cleaned = String(raw || '').trim().replace(/[."'\n].*$/s, '');
    if (/^unknown$/i.test(cleaned)) return null;
    return normalizeGenre(cleaned);
  } catch {
    return null;
  }
}

export interface GenreResult {
  genre: string | null;
  source: 'tag' | 'llm' | 'none';
}

/** Полный каскад: тег → нормализация → LLM. */
export async function detectTrackGenre(opts: {
  tagGenre?: string | null;
  artist?: string | null;
  title?: string | null;
}): Promise<GenreResult> {
  const fromTag = normalizeGenre(opts.tagGenre);
  if (fromTag) return { genre: fromTag, source: 'tag' };
  const fromLLM = await detectGenreLLM(opts.artist || '', opts.title || '');
  if (fromLLM) return { genre: fromLLM, source: 'llm' };
  return { genre: null, source: 'none' };
}

/**
 * Fire-and-forget обогащение трека после загрузки: если genre пуст —
 * определить и записать. Guard в WHERE — не перетираем жанр, который
 * артист успел указать руками.
 */
export async function enrichTrackGenre(trackId: string, artist: string, title: string): Promise<void> {
  try {
    const r = await detectTrackGenre({ artist, title });
    if (!r.genre) return;
    await pool.query(
      `UPDATE tracks SET genre = $2, genre_source = $3
        WHERE id = $1 AND (genre IS NULL OR genre = '')`,
      [trackId, r.genre, r.source]
    );
  } catch (e: any) {
    console.warn('[genre-detect] enrich failed:', trackId, e?.message);
  }
}
