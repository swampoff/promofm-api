/**
 * Чьи треки и миксы считает раздел «Ротации на радио» (12.10.2026, владелец:
 * «эфиры миксов для диджеев и учёт ростера для лейблов»).
 *
 *   artist — треки пользователя (tracks.user_id);
 *   label  — треки лейбла и всех артистов его ростера: managed и linked
 *            (artist_profiles.managed_by_label_id / label_id), как /label/roster;
 *   dj     — треки пользователя и его DJ-миксы (dj_mixes.dj_id).
 *
 * Во всех запросах $1 — users.id владельца кабинета, поэтому requireOwner
 * по-прежнему отсекает чужие кабинеты, а лейбл видит только свой ростер.
 */

export type RadioScope = 'artist' | 'label' | 'dj';

export function parseRadioScope(v: string | undefined | null): RadioScope {
  return v === 'label' || v === 'dj' ? v : 'artist';
}

/** Треки кабинета: id uuid, title, created_at. У лейбла в названии — артист. */
export function scopeTracksSql(scope: RadioScope): string {
  if (scope !== 'label') {
    return `SELECT t.id, t.title, t.created_at FROM tracks t WHERE t.user_id = $1`;
  }
  return `SELECT t.id,
                 COALESCE(NULLIF(TRIM(COALESCE(ap.artist_name, t.artist_name)), '') || ' — ', '') || t.title AS title,
                 t.created_at
            FROM tracks t
            LEFT JOIN artist_profiles ap ON ap.id = t.artist_id
           WHERE t.user_id = $1
              OR t.label_id IN (SELECT lp.id::text FROM label_profiles lp WHERE lp.user_id::text = $1)
              OR t.artist_id IN (SELECT a.id FROM artist_profiles a
                                   JOIN label_profiles lp ON lp.id = a.managed_by_label_id OR lp.id = a.label_id
                                  WHERE lp.user_id::text = $1)`;
}

/**
 * Треки и миксы одним списком: id text (uuid трека или 'mix-…'), title,
 * kind ('track' | 'mix'), created_at. Миксы — только в кабинете диджея.
 */
export function scopeItemsSql(scope: RadioScope): string {
  const tracks = `SELECT s.id::text AS id, s.title, 'track'::text AS kind, s.created_at FROM (${scopeTracksSql(scope)}) s`;
  if (scope !== 'dj') return tracks;
  return `${tracks}
          UNION ALL
          SELECT m.id, 'Микс: ' || m.title, 'mix'::text, m.created_at
            FROM dj_mixes m WHERE m.dj_id = $1 AND NOT COALESCE(m.is_hidden, false)`;
}
