#!/usr/bin/env node
/**
 * analytics-daily-report.js — ежедневный e-mail-отчёт по трафику promo-music.ru.
 * Источник page_views (только люди). Шлёт вчерашние + 7-дневные цифры на
 * ANALYTICS_REPORT_TO (по умолч. info@promo-music.ru). cron: 0 9 * * *.
 */
import 'dotenv/config';
import { pool } from './src/db-client.tsx';
import { sendEmail, emailWrapper } from './src/email-helper.tsx';

const HUMAN = `NOT is_bot AND coalesce(user_agent,'') !~* '(prerender|bot|crawl|spider|slurp|externalagent|headless|phantom|python|curl|wget|monitor|uptime|pingdom|facebookexternalhit|semrush|ahrefs|bytespider|gptbot|claudebot|dataprovider|petalbot)'`;
const MSK = `(created_at AT TIME ZONE 'Europe/Moscow')::date`;
const YDAY = `((now() AT TIME ZONE 'Europe/Moscow')::date - 1)`;
const SRC = `CASE WHEN referrer IS NULL OR referrer='' THEN 'Прямые' WHEN referrer ~* 'promo-music\\.ru' THEN 'Внутренние' WHEN referrer ~* '(google|yandex|bing|duckduck|search)' THEN 'Поиск' WHEN referrer ~* '(vk\\.com|t\\.me|telegram|instagram|facebook|youtube|tiktok|ok\\.ru|dzen)' THEN 'Соцсети' ELSE 'Другие сайты' END`;
const TO = (process.env.ANALYTICS_REPORT_TO || 'info@promo-music.ru').split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
  const yStr = (await pool.query(`SELECT to_char(${YDAY},'DD.MM.YYYY') d`)).rows[0].d;
  const series = (await pool.query(
    `WITH fs AS (SELECT session_id, min(${MSK}) fd FROM page_views WHERE ${HUMAN} GROUP BY 1)
     SELECT to_char(${MSK},'DD.MM') dd, ${MSK} d,
       count(DISTINCT pv.session_id)::int visitors, count(DISTINCT pv.ip)::int ips, count(*)::int views,
       count(DISTINCT pv.session_id) FILTER (WHERE fs.fd=${MSK})::int nv
     FROM page_views pv JOIN fs USING(session_id)
     WHERE ${HUMAN} AND created_at > (now() - interval '8 days') GROUP BY 1,2 ORDER BY 2`)).rows;
  const y = series[series.length - 1] || { visitors: 0, ips: 0, views: 0, nv: 0 };
  const prev = series[series.length - 2] || null;
  const pages = (await pool.query(`SELECT path, count(DISTINCT session_id)::int v FROM page_views WHERE ${HUMAN} AND ${MSK}=${YDAY} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`)).rows;
  const src = (await pool.query(`SELECT ${SRC} s, count(DISTINCT session_id)::int v FROM page_views WHERE ${HUMAN} AND created_at > (now()-interval '8 days') GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const geo = (await pool.query(`SELECT coalesce(nullif(country,''),'??') c, count(DISTINCT session_id)::int v FROM page_views WHERE ${HUMAN} AND created_at > (now()-interval '8 days') GROUP BY 1 ORDER BY 2 DESC LIMIT 6`)).rows;

  const trend = prev ? y.visitors - prev.visitors : 0;
  const arrow = trend > 0 ? `<span style="color:#4ade80">▲ +${trend}</span>` : trend < 0 ? `<span style="color:#f87171">▼ ${trend}</span>` : '<span style="color:#888">=</span>';
  const th = 'style="padding:6px 10px;text-align:left;color:#9aa;font-size:12px;border-bottom:1px solid #333"';
  const td = 'style="padding:6px 10px;color:#e0e0e0;font-size:13px;border-bottom:1px solid #222"';
  const maxV = Math.max(...series.map((r) => r.visitors), 1);
  const rowsHtml = series.map((r) => `<tr><td ${td}>${r.dd}</td><td ${td}>${r.visitors}</td><td ${td}>${r.nv}</td><td ${td}>${r.ips}</td><td ${td}>${r.views}</td><td ${td}><span style="display:inline-block;height:9px;width:${Math.round(r.visitors / maxV * 120)}px;background:#8b5cf6;border-radius:2px"></span></td></tr>`).join('');
  const pagesHtml = pages.map((r) => `<tr><td ${td}>${r.v}</td><td ${td} >${r.path}</td></tr>`).join('');
  const srcHtml = src.map((r) => `<tr><td ${td}>${r.s}</td><td ${td}>${r.v}</td></tr>`).join('');
  const geoHtml = geo.map((r) => `${r.c} ${r.v}`).join(' · ');

  const content = `
    <h1 style="color:#fff;font-size:22px;margin:0 0 4px">📊 Трафик PromoFM</h1>
    <p style="color:#9aa;margin:0 0 20px">Отчёт за ${yStr} (реальные посетители, боты отфильтрованы)</p>
    <div style="background:#141428;border-radius:12px;padding:18px;margin-bottom:18px">
      <div style="color:#fff;font-size:34px;font-weight:700">${y.visitors} <span style="font-size:15px;color:#9aa;font-weight:400">визитёров ${arrow}</span></div>
      <div style="color:#c0c0d0;font-size:14px;margin-top:6px">${y.views} просмотров · ${y.ips} уник. IP · ${y.nv} новых</div>
    </div>
    <table width="100%" cellspacing="0" style="border-collapse:collapse;margin-bottom:20px">
      <tr><th ${th}>дата</th><th ${th}>визит.</th><th ${th}>нов.</th><th ${th}>IP</th><th ${th}>просм.</th><th ${th}></th></tr>
      ${rowsHtml}
    </table>
    <div style="display:flex;gap:20px;flex-wrap:wrap">
      <div style="flex:1;min-width:240px">
        <h3 style="color:#fff;font-size:15px;margin:0 0 6px">Топ страниц (вчера)</h3>
        <table width="100%" cellspacing="0" style="border-collapse:collapse"><tr><th ${th}>виз.</th><th ${th}>страница</th></tr>${pagesHtml}</table>
      </div>
      <div style="flex:1;min-width:200px">
        <h3 style="color:#fff;font-size:15px;margin:0 0 6px">Источники (7 дн.)</h3>
        <table width="100%" cellspacing="0" style="border-collapse:collapse"><tr><th ${th}>источник</th><th ${th}>виз.</th></tr>${srcHtml}</table>
        <h3 style="color:#fff;font-size:15px;margin:16px 0 6px">Гео (7 дн.)</h3>
        <p style="color:#c0c0d0;font-size:13px;margin:0">${geoHtml}</p>
      </div>
    </div>
    <p style="color:#667;font-size:12px;margin-top:24px">Автоотчёт · analytics-daily-report.js · promo-music.ru</p>`;

  const subject = `📊 Трафик PromoFM за ${yStr}: ${y.visitors} визитёров`;
  let ok = 0;
  for (const to of TO) { if (await sendEmail({ to, subject, html: emailWrapper(content) })) ok++; }
  console.log(`[${new Date().toISOString()}] daily-report sent ${ok}/${TO.length} to ${TO.join(',')} | yesterday=${y.visitors} visitors`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
