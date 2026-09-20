/**
 * ПУБЛИЧНЫЙ КАТАЛОЖНЫЙ API — точка входа для ИИ-агентов и внешних систем.
 *
 * Отдаём то, что реально знаем о треке: жанр, настроение, темп, тональность,
 * энергию, язык, контексты использования и — главное наше отличие — факты
 * эфира, подтверждённые фингерпринтом.
 *
 * ⚠️ У каждого поля отдаём происхождение (audio/ai/human). Внешняя система
 * должна понимать, что «настроение» выведено из аудио, а не подтверждено
 * артистом. Выдавать машинный вывод за факт нельзя.
 *
 * Аудиофайлы наружу НЕ отдаём: права на воспроизведение не наши. Только
 * метаданные и ссылка на страницу трека.
 */
import { Hono } from 'hono';
import { pool } from './db-client.tsx';

const app = new Hono();
const SITE = process.env.PUBLIC_SITE_URL || 'https://promo-music.ru';

// GET /search?genre=&mood=&bpm_min=&bpm_max=&language=&context=&q=&limit=
app.get('/search', async (c) => {
  try {
    const q = c.req.query('q') || '';
    const genre = c.req.query('genre') || '';
    const mood = c.req.query('mood') || '';
    const language = c.req.query('language') || '';
    const context = c.req.query('context') || '';
    const bpmMin = parseFloat(c.req.query('bpm_min') || '');
    const bpmMax = parseFloat(c.req.query('bpm_max') || '');
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10) || 20));

    const cond: string[] = [
      `t.moderation_status IN ('published','upcoming')`,
      `COALESCE(t.audio_url,'') <> ''`,
      `COALESCE(t.is_hidden,false) = false`,
    ];
    const params: any[] = [];
    const add = (sql: string, val: any) => { params.push(val); cond.push(sql.replace('$$', `$${params.length}`)); };

    if (q)        add(`(t.title ILIKE '%' || $$ || '%' OR t.artist_name ILIKE '%' || $$ || '%')`.replace('$$', `$${params.length + 1}`).replace('$$', `$${params.length + 1}`), q);
    if (genre)    add(`t.genre ILIKE '%' || $$ || '%'`, genre);
    if (mood)     add(`t.mood ILIKE '%' || $$ || '%'`, mood);
    if (language) add(`t.language = $$`, language);
    if (context)  add(`$$ = ANY(t.use_contexts)`, context);
    if (!Number.isNaN(bpmMin)) add(`t.bpm >= $$`, bpmMin);
    if (!Number.isNaN(bpmMax)) add(`t.bpm <= $$`, bpmMax);

    params.push(limit);
    const rows = await pool.query(
      `SELECT t.id, t.title, t.artist_name, t.genre, t.mood, t.bpm, t.music_key,
              t.energy, t.language, t.use_contexts, t.cover_url, t.release_date,
              t.audio_features_source, t.mood_source, t.genre_source,
              ap.slug AS artist_slug,
              (SELECT count(DISTINCT d.station_name)::int FROM promo_check_detections d WHERE d.track_id = t.id) AS confirmed_stations
         FROM tracks t
         LEFT JOIN artist_profiles ap ON ap.id = t.artist_id
        WHERE ${cond.join(' AND ')}
        ORDER BY t.created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    return c.json({
      success: true,
      total: rows.rows.length,
      filters: { q, genre, mood, language, context, bpm_min: bpmMin || null, bpm_max: bpmMax || null },
      tracks: rows.rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        artist: r.artist_name,
        url: r.artist_slug ? `${SITE}/artist/${r.artist_slug}` : `${SITE}/`,
        coverUrl: r.cover_url || null,
        releaseDate: r.release_date || null,
        genre: r.genre || null,
        mood: r.mood || null,
        bpm: r.bpm !== null ? Number(r.bpm) : null,
        musicKey: r.music_key || null,
        energy: r.energy !== null ? Number(r.energy) : null,
        language: r.language || null,
        useContexts: r.use_contexts || [],
        // Наше отличие: не «заявлено станцией», а подтверждено фингерпринтом.
        confirmedRadioStations: r.confirmed_stations || 0,
        sources: {
          audioFeatures: r.audio_features_source || null,
          mood: r.mood_source || null,
          genre: r.genre_source || null,
        },
      })),
      notice: 'Метаданные каталога ПРОМО.МУЗЫКА. Поля с источником "audio" выведены автоматически из аудио и не подтверждены артистом. Аудиофайлы через API не отдаются.',
    });
  } catch (err: any) {
    console.error('[catalog/search] failed:', err?.message || err);
    return c.json({ success: false, error: 'Ошибка поиска' }, 500);
  }
});

// GET /stats — размер и полнота каталога
app.get('/stats', async (c) => {
  const r = await pool.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE genre IS NOT NULL)::int AS with_genre,
           count(*) FILTER (WHERE mood IS NOT NULL)::int AS with_mood,
           count(*) FILTER (WHERE bpm IS NOT NULL)::int AS with_bpm,
           count(DISTINCT genre)::int AS genres
      FROM tracks
     WHERE moderation_status IN ('published','upcoming') AND COALESCE(audio_url,'') <> ''`);
  const d = r.rows[0] || {};
  return c.json({ success: true, catalog: d, updatedAt: new Date().toISOString() });
});

export default app;
