# PromoFM API — Claude Code Configuration

## Project

PromoFM API — бэкенд платформы promo-music.ru.
Node.js + Hono + PostgreSQL 16, JWT auth, ~34K LOC.

## Architecture

- **Runtime**: Node.js 22 + tsx (TypeScript)
- **Framework**: Hono (lightweight HTTP)
- **Database**: PostgreSQL 16 (168 tables, RLS enabled)
- **Auth**: JWT (jsonwebtoken + bcrypt), NO Supabase
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
- NEVER use Supabase, KV Store, or Vercel
- All data stays on own VPS (PostgreSQL + Node.js + JWT)
- Quality > Speed — always do it right, never cut corners
