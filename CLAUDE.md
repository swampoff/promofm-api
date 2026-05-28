# PromoFM API — Claude Code Configuration

## ⚡ Read first, every session

Before responding to ANY task, open these two files — they carry
context the user can't repeat in chat every time:

1. **[docs/OPERATIONS_LOG.md](docs/OPERATIONS_LOG.md)** — manual
   prod interventions (SQL fixes, account repairs, admin actions).
   The git log doesn't capture these; this log does.
2. **[docs/PRODUCT_FACTS.md](docs/PRODUCT_FACTS.md)** — verified
   reality of how features actually work in code. Don't paraphrase
   from memory — cite the file:line from here.

When you make a manual prod intervention (or the user tells you
about one) — append to OPERATIONS_LOG.md in the same PR. When you
ship a code change that changes how a feature works (pricing,
gating, mechanic) — update PRODUCT_FACTS.md in the same PR.

## Project

PromoFM API — бэкенд платформы promo-music.ru.
Node.js + Hono + PostgreSQL 16, JWT auth, ~34K LOC.

## Architecture

- **Runtime**: Node.js 22 + tsx (TypeScript)
- **Framework**: Hono (lightweight HTTP)
- **Database**: PostgreSQL 16 (168 tables, RLS enabled)
- **Auth**: JWT (jsonwebtoken + bcrypt)
- **Deploy**: systemd + nginx + certbot, VPS 194.67.122.99

## File Structure

```
src/index.ts                    — Main entry, route registration
src/*-routes.tsx                — Route modules (65+ routes)
src/db-client.tsx               — PostgreSQL pool + QueryBuilder
src/auth-middleware.tsx          — JWT verification middleware
friday.js                       — Friday releases CLI automation
uploads/tracks/                 — MP3 files
uploads/covers/                 — Cover images (from MP3 via ffmpeg)
```

## Build & Deploy

```bash
npm run build                   # TypeScript check
npx tsx src/index.ts            # Run dev server
# Deploy: push to GitHub → ssh pull on VPS → systemctl restart promofm-api
```

## Database

- **Connection**: `DATABASE_URL` in `.env`
- **User**: promofm_app (restricted by RLS)
- **RLS bypass**: `set_config('app.current_role', 'admin', false)` for tracks
- **RLS bypass**: `set_config('app.current_user_role', 'admin', false)` for artist_profiles (DIFFERENT variable!)

## Rules

- See `docs/AGENTS.md` for Bug Diagnosis & Fix Protocol
- NEVER commit .env or secrets
- Only the project's own VPS — no external BaaS, no serverless platforms
- All data stays on own VPS (PostgreSQL + Node.js + JWT)
- Quality > Speed — always do it right, never cut corners

## ⛔ FORBIDDEN: создавать новые KV-store таблицы

Активный мандат сессии — **переезд KV-store на нормальный SQL**
(см. `docs/kv-to-sql-migration.md`). Это значит:

**НЕ ДЕЛАТЬ:**
- `jsonbStore('<новая_таблица>', '<entity>_id')` для нового кода
- `CREATE TABLE foo (entity_id TEXT PRIMARY KEY, data JSONB, …)` —
  это паттерн «1 строка на entity, массив сущностей внутри jsonb»
- «Залатать» отсутствующую KV-таблицу через `CREATE TABLE IF NOT EXISTS`
  с тем же легаси-контрактом — это перпетуирует проблему

**ДЕЛАТЬ для новых таблиц:**
- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` — каждая сущность отдельная строка
- `entity_id TEXT/UUID INDEX` (НЕ PK) — для группировки/owner-check
- Нативные колонки на основные поля (`title`, `status`, `event_date`, …)
- `extra JSONB DEFAULT '{}'::jsonb` — только для legit nested data
- Доступ через `pool.query` из `db-client.tsx`, НЕ через jsonbStore-helper

**ДЛЯ существующих KV-таблиц с багами:**
- Не «латать» — мигрировать на row-per-entity вместе с handler'ами
- Backfill из jsonb-массива через `jsonb_array_elements`
- Удалить stale `jsonbStore(...)` declaration в `src/db.tsx`
- Обновить tracker `docs/kv-to-sql-migration.md`

**Если кажется что «временный KV ОК»:**
- НЕТ, не ОК — спросить пользователя явно в чате до commit'а
- KV не «временный», он сразу залипает на проде и потом «временно» живёт годами

## SQL writing pitfalls (READ BEFORE WRITING ANY QUERY)

These caused two production reverts on 2026-05-23. CI has no integration
tests on schema, so type mismatches and missing columns only blow up at
runtime in prod. Before adding a new SELECT/UPDATE/JOIN, walk through
the checklist below.

### Column-type cheat sheet (verified as of 2026-05-23)

| Table | Column | Type |
|---|---|---|
| `users` | `id` | `uuid` |
| `users` | `status` | enum `user_status` (NOT text) |
| `artist_profiles` | `id` | `uuid` |
| `artist_profiles` | `user_id` | `text` ← FK is text, not uuid |
| `dj_profiles`, `radio_profiles`, `venue_profiles`, `producer_profiles`, `label_profiles` | `user_id` | `text` |
| `tracks` | `id` | `uuid` |
| `tracks` | `artist_id` | `uuid` (FK to artist_profiles.id) |
| `tracks` | `user_id` | `text` |
| `concerts` | `artist_id` | `uuid` |
| `notifications` | `id` | `text` (legacy composite ids like `notif_1779…`) |
| `notifications` | `user_id` | `uuid` (pg-node implicit-casts string→uuid here; explicit `::text` not needed) |
| `radio_stations` | `id` | `uuid` PK |
| `radio_stations` | `station_name` | `text` |
| `promo_check_monitoring` | `id` | `uuid` PK |
| `promo_check_monitoring` | `station_id` | `uuid NOT NULL` ← FK to `radio_stations(id)` — REQUIRED on every INSERT |
| `promo_check_monitoring` | `station_name` | `text` (UNIQUE INDEX `uq_promo_check_monitoring_station` since 010_promo_check_monitoring_seed.sql) |
| `promo_check_monitoring` | `stream_url` | `text` |
| `promo_check_monitoring` | `active` | `boolean DEFAULT true` |
| `promo_check_monitoring` | `error_count` | `integer DEFAULT 0` |
| **All `:artistId` / `:userId` URL params** | arrive as | `text` |

Anything else: verify with `\d <table>` or
`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '<t>'`
*before* writing the code, not after the revert.

### Seeding promo_check_monitoring — the radio_stations FK trap

Migration 010 missed this on first pass: `promo_check_monitoring.
station_id` is a NOT NULL FK to `radio_stations(id)`. A bare INSERT
that omits station_id (or supplies one that doesn't exist) fails the
constraint. Pattern for any future seed PR that adds a station:

```sql
DO $$
DECLARE s_id UUID;
BEGIN
  SELECT id INTO s_id FROM radio_stations WHERE station_name = 'Авторадио';
  IF s_id IS NULL THEN
    INSERT INTO radio_stations (station_name, /* other required cols */)
    VALUES ('Авторадио', /* ... */)
    RETURNING id INTO s_id;
  END IF;
  INSERT INTO promo_check_monitoring (station_id, station_name, stream_url, active)
  VALUES (s_id, 'Авторадио', 'http://…', false)
  ON CONFLICT (station_name) DO NOTHING;
END $$;
```

Order matters: radio_stations row first, FK second.

### Cast rules

- `WHERE id = $1` where `id` is `uuid` and `$1` is a URL-param string →
  use `WHERE id::text = $1`. Postgres does NOT implicit-cast uuid to text.
- `WHERE user_id = $1` where `user_id` is `text` → **no cast needed**,
  text=text just works.
- `WHERE artist_id = $1` where `artist_id` is `uuid` and `$1` is from
  pg-node parameter binding (JS string of UUID shape) → **no cast**,
  pg-node parses it correctly. **Adding `$1::text` BREAKS it** (forces
  text-on-uuid compare). This is the exact trap that took down PR
  37a399f's concerts query.
- `COALESCE(x, u.status)` where `x` is `text` and `u.status` is
  `user_status` enum → cast the enum side: `COALESCE(x, u.status::text)`.
  Otherwise: `COALESCE types text and user_status cannot be matched`.

### Don't invent columns

The TypeScript `ArtistProfile` interface shape DOES NOT match the SQL
schema 1:1. After migration 057 (artist profile extended fields,
2026-05-28), these ARE now columns: `label`, `manager`, `booking_email`,
`career_start`, `languages` (`text[]`), `location`. Still NOT columns,
live in `data jsonb` or nowhere: `rating`, `coinsBalance`, `phone` on
artist_profiles (phone lives on `users.phone`).

Before `SELECT <col>` from any cabinet table — verify the column
exists. If you need a field that isn't there:
1. Add `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` migration in the
   same PR
2. Note `MANUAL DEPLOY STEPS` in the commit body
3. Extend the matching mapping in `vps-userdata.tsx` / `<role>-routes.tsx`
   so the field actually flows from API → SQL → API. Adding the column
   alone won't fix a silent-drop bug; the mapping is what writes.

### Migrations don't auto-run

`src/migration-runner.tsx` is a stub. Files in `src/migrations/*.sql`
are NOT applied on `systemctl restart promofm-api`. If your code
expects new columns, you MUST:
1. Land the migration file `src/migrations/NNN_xxx.sql` in the same PR
2. Put `MANUAL DEPLOY STEPS` block in the commit message — use
   the heredoc-with-BEGIN/COMMIT pattern below (NOT just `-f`).
3. Specify that migration is applied BEFORE the code restart.

### Migration files: NO `BEGIN/COMMIT` inside the file

**Convention (Flyway-style):** the migration file contains DDL only.
The runner wraps the file in a transaction.

**Apply:**
```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
BEGIN;
\i /opt/promofm-api/src/migrations/NNN_xxx.sql
COMMIT;
EOF
```

**Dry-run** (replace COMMIT with ROLLBACK):
```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'EOF'
BEGIN;
\i /opt/promofm-api/src/migrations/NNN_xxx.sql
ROLLBACK;
EOF
```

**Why this convention exists** (incident 2026-05-27, migration 039):
- Old pattern had `BEGIN; …; COMMIT;` inside the file
- Laptop tried `BEGIN; \i file; ROLLBACK;` for dry-run
- File's inner `COMMIT;` ended the outer transaction → migration
  was permanently applied to prod even though laptop expected a rollback
- Recovery required emergency merge of the not-yet-reviewed PR to keep
  DB and code in sync

`DO $$ … END $$` PL/pgSQL blocks inside the file are fine — those
are not transactions. Only top-level `BEGIN;` / `COMMIT;` statements
are forbidden inside migration files.

### Pre-flight (mandatory for cloud sessions that can't ssh prod)

The cloud Claude session does NOT have ssh to the VPS. Local Claude
(laptop) does. For any backend PR touching SQL:

1. Cloud: write the SQL, commit, push to a feature branch
2. Cloud: in the PR description, explicitly list every column referenced
   in every new query and which table it's from
3. Laptop: runs `\d <table>` + `BEGIN; <SQL>; ROLLBACK;` against prod
4. Laptop: merges or sends back fixes

If cloud session ships SQL without that loop and it hits prod —
expect a revert. See 5bfc665, 3e280ad reverts on 2026-05-23 for the
template.

### Things that look right but break

- `WHERE artist_id = $1::text` against uuid column — looks defensive,
  is actually a type error.
- `SELECT rating FROM artist_profiles` without first checking the
  column exists — TS interface lies about schema.
- Migration in PR with no manual-deploy note → applied code restart,
  no columns, runtime crash.
- Restoring `src/supabase-client.tsx` symlink in a branch that forked
  before its deletion — `git rm` it before pushing.

### Frontend cache races (not a backend bug, common symptom)

After raw SQL UPDATE on prod, an open settings tab can write its
cached state back via PUT and undo the manual change. Tell the user
to Cmd+Shift+R before touching settings. Same goes for stale
lazy-chunk JS files after deploy — that's a deploy-pipeline concern,
not an API bug.
