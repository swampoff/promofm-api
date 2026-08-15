/**
 * AI DISCOVERABILITY SCORE — насколько каталог готов к тому, чтобы
 * ИИ-системы могли его найти и корректно описать.
 *
 * ⚠️ ПРИНЦИП: балл считается ТОЛЬКО из полноты и качества данных, которые
 * у нас есть. Он не предсказывает и не обещает место в выдаче нейросетей —
 * мы ей не управляем. Продаём подготовку данных, а не результат.
 *
 * Веса подобраны по влиянию на машинную читаемость: без жанра и описания
 * систему не на что опереться, поэтому они весят больше, чем, скажем,
 * кредиты.
 */
import { Hono } from 'hono';
import { pool } from './db-client.tsx';

const app = new Hono();

interface Part {
  key: string;
  label: string;
  weight: number;
  score: number;
  hint?: string;
}

function pct(ok: boolean | number, max = 1): number {
  const v = typeof ok === 'number' ? ok : ok ? 1 : 0;
  return Math.max(0, Math.min(100, Math.round((v / max) * 100)));
}

async function scoreForTracks(rows: any[], radioCount: number, venueCount: number) {
  const n = rows.length || 1;
  const share = (f: (t: any) => boolean) => rows.filter(f).length / n;

  const parts: Part[] = [
    {
      key: 'metadata', label: 'Базовые метаданные', weight: 15,
      score: pct(share((t) => !!t.title && !!t.artist_name && !!t.cover_url)),
      hint: 'Название, артист и обложка у каждого трека',
    },
    {
      key: 'genre', label: 'Жанровая классификация', weight: 15,
      score: pct(share((t) => !!t.genre)),
      hint: 'Без жанра ИИ не понимает, к чему относить музыку',
    },
    {
      key: 'mood', label: 'Настроение и контекст', weight: 15,
      score: pct(share((t) => !!t.mood || (t.use_contexts && t.use_contexts.length))),
      hint: 'Под какую задачу подходит трек: фон в кафе, тренировка, вечер',
    },
    {
      key: 'audio', label: 'Аудио-характеристики', weight: 12,
      score: pct(share((t) => t.bpm !== null || t.music_key !== null)),
      hint: 'Темп, тональность, энергия — считаются автоматически',
    },
    {
      key: 'description', label: 'Описание', weight: 12,
      score: pct(share((t) => (t.description || '').length > 40)),
      hint: 'Пара живых предложений о треке, а не пустое поле',
    },
    {
      key: 'language', label: 'Язык и вокал', weight: 8,
      score: pct(share((t) => !!t.language || !!t.vocal_type)),
      hint: 'Язык исполнения и характер вокала',
    },
    {
      key: 'credits', label: 'Кредиты', weight: 8,
      score: pct(share((t) => {
        const c = t.credits;
        return !!c && JSON.stringify(c) !== '{}' && JSON.stringify(c) !== '[]';
      })),
      hint: 'Авторы, продюсер, студия',
    },
    {
      key: 'radio', label: 'Данные об эфирах', weight: 10,
      score: pct(Math.min(radioCount, 10), 10),
      hint: 'Подтверждённые фингерпринтом эфиры — то, чего нет у стримингов',
    },
    {
      key: 'venue', label: 'Данные по заведениям', weight: 5,
      score: pct(Math.min(venueCount, 5), 5),
      hint: 'Где музыка реально звучала вне радио',
    },
  ];

  const total = Math.round(
    parts.reduce((s, p) => s + p.score * p.weight, 0) / parts.reduce((s, p) => s + p.weight, 0)
  );
  return { total, parts };
}

// GET /artist/:artistId — балл по всему каталогу артиста
app.get('/artist/:artistId', async (c) => {
  try {
    const artistId = c.req.param('artistId');
    const tracks = await pool.query(
      `SELECT t.id, t.title, t.artist_name, t.cover_url, t.genre, t.mood, t.bpm,
              t.music_key, t.description, t.language, t.vocal_type, t.credits, t.use_contexts
         FROM tracks t
        WHERE (t.user_id = $1 OR t.artist_id::text = $1)
          AND t.moderation_status IN ('published','upcoming','approved')`,
      [artistId],
    );
    if (!tracks.rows.length) {
      return c.json({ success: true, data: { total: 0, tracks: 0, parts: [], message: 'Треков не найдено' } });
    }
    const ids = tracks.rows.map((r: any) => r.id);
    const [radio, venue] = await Promise.all([
      pool.query(`SELECT count(DISTINCT station_name)::int AS n FROM promo_check_detections WHERE track_id = ANY($1::uuid[])`, [ids]),
      pool.query(`SELECT count(DISTINCT city)::int AS n FROM track_radio_pickups WHERE track_id = ANY($1::uuid[])`, [ids]),
    ]);
    const res = await scoreForTracks(tracks.rows, radio.rows[0]?.n || 0, venue.rows[0]?.n || 0);
    return c.json({ success: true, data: { ...res, tracks: tracks.rows.length } });
  } catch (err: any) {
    console.error('[ai-score] artist failed:', err?.message || err);
    return c.json({ success: false, error: 'Не удалось посчитать' }, 500);
  }
});

// GET /track/:trackId — балл по одному треку
app.get('/track/:trackId', async (c) => {
  try {
    const id = c.req.param('trackId');
    const t = await pool.query(
      `SELECT id, title, artist_name, cover_url, genre, mood, bpm, music_key,
              description, language, vocal_type, credits, use_contexts
         FROM tracks WHERE id = $1`, [id]);
    if (!t.rows.length) return c.json({ success: false, error: 'Трек не найден' }, 404);
    const [radio, venue] = await Promise.all([
      pool.query(`SELECT count(DISTINCT station_name)::int AS n FROM promo_check_detections WHERE track_id = $1`, [id]),
      pool.query(`SELECT count(DISTINCT city)::int AS n FROM track_radio_pickups WHERE track_id = $1`, [id]),
    ]);
    const res = await scoreForTracks(t.rows, radio.rows[0]?.n || 0, venue.rows[0]?.n || 0);
    return c.json({ success: true, data: { ...res, track: { id: t.rows[0].id, title: t.rows[0].title } } });
  } catch (err: any) {
    console.error('[ai-score] track failed:', err?.message || err);
    return c.json({ success: false, error: 'Не удалось посчитать' }, 500);
  }
});

// GET /catalog — сводный балл платформы (для витрины)
app.get('/catalog', async (c) => {
  try {
    const tracks = await pool.query(
      `SELECT id, title, artist_name, cover_url, genre, mood, bpm, music_key,
              description, language, vocal_type, credits, use_contexts
         FROM tracks
        WHERE moderation_status IN ('published','upcoming','approved')
          AND COALESCE(audio_url,'') <> ''`);
    const res = await scoreForTracks(tracks.rows, 10, 5);
    return c.json({ success: true, data: { ...res, tracks: tracks.rows.length } });
  } catch (err: any) {
    return c.json({ success: false, error: 'Не удалось посчитать' }, 500);
  }
});

export default app;
