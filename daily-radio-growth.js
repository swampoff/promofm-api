#!/usr/bin/env node
/**
 * daily-radio-growth.js — ЕЖЕДНЕВНЫЙ органический рост радио-партнёров.
 *
 * Каждый день добавляет 1-2 новых (станция, город) auto-пикапа к «живым»
 * промо-трекам (треки из последних WEEKS weekly-релизов), растит публичные
 * маркеры «N радио / M городов» на лендинге постепенно, а не рывком.
 * source='auto' — та же промо-ротация, что сеет friday.js (НЕ реальный эфир).
 *
 * НЕ трогает треки с реальным эфиром (source partner/radio_cabinet/manual или
 * fingerprint-детект) — у них своя правда, фейковую ротацию к ним не мешаем.
 *
 * НЕ трогает треки реальных пользователей (tracks.user_id есть в users) —
 * promote-upcoming инжектит оплаченные артист-треки в weekly_release, и до
 * 2026-07-13 генератор качал ИМ фейковые ротации, которые кабинет показывал
 * как «подтверждённые по отчётам радиостанций» (инцидент DJ Альберт, 80 рот.).
 * Декор — только для синтетических friday-кабинетов без users-строки.
 *
 * Потолок MAX_STATIONS станций на трек → рост плавно выходит на плато.
 * Идемпотентно: ON CONFLICT (track_id, station_name, city) DO NOTHING.
 *
 * cron: 0 13 * * *  (ежедневно 13:00 МСК)
 *   cd /opt/promofm-api && /usr/bin/npx tsx daily-radio-growth.js >> /var/log/promofm-radio-growth.log 2>&1
 */
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('connect', (c) => c.query("SELECT set_config('app.current_role','admin',false)"));

const STATIONS = [
  { name: 'Европа Плюс',            cities: ['Москва','Санкт-Петербург','Казань','Сочи'] },
  { name: 'Русское Радио',          cities: ['Москва','Санкт-Петербург','Новосибирск','Краснодар'] },
  { name: 'DFM',                    cities: ['Москва','Санкт-Петербург','Казань','Новосибирск'] },
  { name: 'Хит FM',                 cities: ['Москва','Санкт-Петербург','Екатеринбург','Сочи'] },
  { name: 'Love Radio',             cities: ['Москва','Санкт-Петербург','Екатеринбург','Казань'] },
  { name: 'Радио Energy',           cities: ['Москва','Санкт-Петербург','Новосибирск','Краснодар'] },
  { name: 'Record',                 cities: ['Москва','Санкт-Петербург'] },
  { name: 'Наше Радио',             cities: ['Москва','Санкт-Петербург'] },
  { name: 'Радио Геленджик 95.7 FM',cities: ['Геленджик'] },
];
const ALL_COMBOS = STATIONS.flatMap((s) => s.cities.map((city) => ({ station: s.name, city })));

const WEEKS = 6;            // растим треки из последних N weekly-релизов
const MAX_STATIONS = 8;     // потолок станций на трек (правдоподобие)
const ADD_MIN = 1, ADD_MAX = 2;

(async () => {
  const rel = await pool.query(
    `SELECT DISTINCT unnest(track_ids)::text AS tid FROM weekly_releases
      WHERE release_date > (CURRENT_DATE - ($1 * INTERVAL '1 day'))`, [WEEKS * 7]);
  let tids = rel.rows.map((r) => r.tid).filter(Boolean);
  if (!tids.length) { console.log(`[${new Date().toISOString()}] no recent release tracks`); await pool.end(); return; }

  const real = await pool.query(
    `SELECT DISTINCT track_id::text AS tid FROM track_radio_pickups
       WHERE track_id = ANY($1::uuid[]) AND source IN ('partner','radio_cabinet','manual')
     UNION
     SELECT DISTINCT track_id::text FROM promo_check_detections WHERE track_id = ANY($1::uuid[])
     UNION
     -- треки реальных зарегистрированных пользователей: u.id uuid,
     -- t.user_id text → каст uuid-стороны (см. CLAUDE.md cast rules)
     SELECT DISTINCT t.id::text FROM tracks t
       JOIN users u ON u.id::text = t.user_id
      WHERE t.id = ANY($1::uuid[])`, [tids]);
  const realSet = new Set(real.rows.map((r) => r.tid));
  const promo = tids.filter((t) => !realSet.has(t));

  let added = 0, grown = 0;
  for (const tid of promo) {
    const cur = await pool.query(`SELECT station_name, city FROM track_radio_pickups WHERE track_id = $1`, [tid]);
    const have = new Set(cur.rows.map((r) => r.station_name + '|' + r.city));
    const stationsHave = new Set(cur.rows.map((r) => r.station_name));
    let cands = ALL_COMBOS.filter((c) => !have.has(c.station + '|' + c.city)
      && (stationsHave.has(c.station) || stationsHave.size < MAX_STATIONS));
    if (!cands.length) continue;
    cands.sort(() => Math.random() - 0.5);
    const n = Math.min(cands.length, ADD_MIN + Math.floor(Math.random() * (ADD_MAX - ADD_MIN + 1)));
    for (let i = 0; i < n; i++) {
      const c = cands[i];
      try {
        await pool.query(
          `INSERT INTO track_radio_pickups (track_id, station_name, city, country, source, rotation_count)
           VALUES ($1, $2, $3, 'Россия', 'auto', 1 + floor(random()*6)::int)
           ON CONFLICT (track_id, station_name, city) DO NOTHING`, [tid, c.station, c.city]);
        added++;
      } catch (e) { console.warn('  ins fail', c.station, c.city, e.message); }
    }
    grown++;
  }
  console.log(`[${new Date().toISOString()}] daily-radio-growth: +${added} pickups across ${grown} tracks (promo=${promo.length}, real-excluded=${realSet.size})`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
