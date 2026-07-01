#!/usr/bin/env node
/**
 * analytics-visitors.js — анализ РЕАЛЬНЫХ посетителей promo-music.ru по дням.
 *
 * Источник: page_views (app-level трекинг реальных заходов из браузера — не API,
 * не ассеты). Считает ТОЛЬКО людей: is_bot=false + отсекает по UA то, что флаг
 * is_bot НЕ ловит (в БД крон-prerender "PromoFM-Prerender" помечен как человек!)
 * + известные боты/краулеры. Визит = уникальный session_id за день (MSK).
 * Плюс: уник. IP, просмотры, новые/вернувшиеся, топ-страницы, источники, устройства.
 *
 * Usage: npx tsx analytics-visitors.js [days=30]
 */
import 'dotenv/config';
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('connect', (c) => c.query("SELECT set_config('app.current_role','admin',false)"));

const DAYS = parseInt(process.argv[2] || '30', 10);
const HUMAN = `NOT is_bot AND coalesce(user_agent,'') !~* '(prerender|bot|crawl|spider|slurp|externalagent|headless|phantom|python-requests|curl|wget|monitor|uptime|pingdom|facebookexternalhit|semrush|ahrefs|bytespider|gptbot|claudebot|dataprovider|petalbot)'`;
const MSK = `(created_at AT TIME ZONE 'Europe/Moscow')::date`;
const SINCE = `created_at > (now() - ($1 * interval '1 day'))`;
const bar = (n, max, w = 18) => '#'.repeat(Math.max(0, Math.round((n / (max || 1)) * w)));

(async () => {
  const p = [DAYS];
  const daily = (await pool.query(`
    WITH firstseen AS (SELECT session_id, min(${MSK}) fd FROM page_views WHERE ${HUMAN} GROUP BY 1)
    SELECT to_char(${MSK},'YYYY-MM-DD') d,
      count(DISTINCT pv.session_id) visitors, count(DISTINCT pv.ip) ips, count(*) views,
      count(DISTINCT pv.session_id) FILTER (WHERE fs.fd = ${MSK}) new_v
    FROM page_views pv JOIN firstseen fs USING (session_id)
    WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 1 DESC`, p)).rows;
  const sum = (await pool.query(`
    SELECT count(DISTINCT session_id) FILTER (WHERE ${HUMAN}) visitors,
           count(DISTINCT ip) FILTER (WHERE ${HUMAN}) ips,
           count(*) FILTER (WHERE ${HUMAN}) views,
           count(*) FILTER (WHERE NOT (${HUMAN})) bots
    FROM page_views WHERE ${SINCE}`, p)).rows[0];
  const pages = (await pool.query(`
    SELECT path, count(*) views, count(DISTINCT session_id) visitors
    FROM page_views WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, p)).rows;
  const src = (await pool.query(`
    SELECT CASE
      WHEN referrer IS NULL OR referrer='' THEN 'Прямые/закладки'
      WHEN referrer ~* 'promo-music\\.ru' THEN 'Внутренние'
      WHEN referrer ~* '(google|yandex|bing|duckduck|search)' THEN 'Поиск'
      WHEN referrer ~* '(vk\\.com|t\\.me|telegram|instagram|facebook|youtube|tiktok|ok\\.ru|dzen)' THEN 'Соцсети'
      ELSE 'Другие сайты' END src,
      count(DISTINCT session_id) visitors
    FROM page_views WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC`, p)).rows;
  const dev = (await pool.query(`SELECT coalesce(nullif(device,''),'?') k, count(DISTINCT session_id) v FROM page_views WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC`, p)).rows;
  const brow = (await pool.query(`SELECT coalesce(nullif(browser,''),'?') k, count(DISTINCT session_id) v FROM page_views WHERE ${HUMAN} AND ${SINCE} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, p)).rows;

  console.log(`\n=== РЕАЛЬНЫЕ ПОСЕТИТЕЛИ promo-music.ru — последние ${DAYS} дн. ===`);
  console.log(`источник page_views · только люди (is_bot=false + UA-фильтр prerender/ботов)\n`);
  console.log(`ИТОГО: ${sum.visitors} уник.визитёров · ${sum.ips} уник.IP · ${sum.views} просмотров`);
  console.log(`      ~${Math.round(sum.visitors / DAYS)} визитёров/день · ~${Math.round(sum.views / DAYS)} просмотров/день · отсеяно ботов ${sum.bots}\n`);
  const maxV = Math.max(...daily.map((r) => +r.visitors), 1);
  console.log(`ПО ДНЯМ (визит = уник.сессия/день):`);
  console.log(`  дата         визит  нов  IP   просм`);
  for (const r of daily)
    console.log(`  ${r.d}  ${String(r.visitors).padStart(4)}  ${String(r.new_v).padStart(3)} ${String(r.ips).padStart(4)} ${String(r.views).padStart(6)}  ${bar(+r.visitors, maxV)}`);
  console.log(`\nТОП СТРАНИЦ (визитёров · просмотров):`);
  for (const r of pages) console.log(`  ${String(r.visitors).padStart(4)} · ${String(r.views).padStart(5)}  ${r.path}`);
  const st = src.reduce((a, r) => a + +r.visitors, 0) || 1;
  console.log(`\nИСТОЧНИКИ (по визитёрам):`);
  for (const r of src) console.log(`  ${String(Math.round(r.visitors / st * 100)).padStart(3)}%  ${String(r.visitors).padStart(4)}  ${r.src}`);
  console.log(`\nУСТРОЙСТВА: ` + (dev.map((r) => `${r.k}=${r.v}`).join('  ') || '(пусто)'));
  console.log(`БРАУЗЕРЫ:   ` + (brow.map((r) => `${r.k}=${r.v}`).join('  ') || '(пусто)') + '\n');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
