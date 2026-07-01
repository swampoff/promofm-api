#!/usr/bin/env node
/** backfill-geoip.js — доливает page_views.country по IP через geoip-lite (одноразово). */
import 'dotenv/config';
import { Pool } from 'pg';
import geoip from 'geoip-lite';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const { rows } = await pool.query(
    `SELECT id, ip FROM page_views WHERE country IS NULL AND ip IS NOT NULL AND ip <> '' AND ip <> '0.0.0.0'`);
  let n = 0;
  for (const r of rows) {
    const g = geoip.lookup(r.ip);
    if (g && g.country) { await pool.query(`UPDATE page_views SET country=$1 WHERE id=$2`, [g.country, r.id]); n++; }
  }
  console.log(`backfilled country: ${n}/${rows.length} rows`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
