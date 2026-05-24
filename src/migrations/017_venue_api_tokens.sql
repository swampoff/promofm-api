-- Venue API tokens — programmatic access for Сеть/Enterprise venues.
--
-- A token grants a third-party integration (POS, custom dashboard,
-- in-room player) the ability to read/write a venue's zones, locations
-- and playlists through the public API at /server/api/venue-public/*.
--
-- Security model:
--   - Token format: `vpfm_` + 32 random bytes hex (64 hex chars).
--     Total length 69 chars. Prefix `vpfm_` lets log scrubbers /
--     leaked-secret scanners detect them.
--   - We store ONLY the SHA-256 hash. Plaintext token is shown to
--     the user EXACTLY ONCE at creation time (download/copy moment)
--     and never persisted server-side.
--   - The first 12 chars (`vpfm_xxxxxxx`) are stored separately in
--     `token_prefix` for display in the tokens list (so the user
--     can identify which token is which when revoking).
--
-- Gating: `VENUE_PLAN_LIMITS[plan].apiAccess` is a boolean.
-- network/enterprise = true, business/start/free = false. Creating
-- a token on a lower tier returns 403 featureBlocked('apiAccess').
--
-- Scopes (jsonb text array stored on each token):
--   - 'read:zones'      — GET /zones, /zones/:id, /zones/:id/current
--   - 'write:zones'     — PUT /zones/:id/playlist (switch playlist)
--   - 'read:locations'  — GET /locations
--   - 'read:playlists'  — GET /playlists, /playlists/:id (with tracks)
--   - 'read:now'        — GET /now-playing (zone-level)
--
-- Optional `expires_at` (NULLABLE) lets venues rotate tokens
-- without manual cleanup; the auth middleware refuses expired ones.
-- `revoked_at` is the soft-delete column — once set the token is
-- rejected forever, kept for audit.
--
-- Idempotent. Safe to re-run.
--
-- MANUAL DEPLOY:
--   sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 \
--     -f /opt/promofm-api/src/migrations/017_venue_api_tokens.sql

BEGIN;

CREATE TABLE IF NOT EXISTS venue_api_tokens (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT         NOT NULL,                       -- account owner
  venue_id        TEXT         NOT NULL,                       -- venue_profiles.id snapshot
  name            TEXT         NOT NULL,                       -- "POS-интеграция", "in-room iPad"
  token_hash      TEXT         NOT NULL UNIQUE,                -- SHA-256 hex (64 chars)
  token_prefix    TEXT         NOT NULL,                       -- first 12 chars of plaintext (for display)
  scopes          JSONB        NOT NULL DEFAULT '[]'::jsonb,   -- text array — see header comment
  last_used_at    TIMESTAMPTZ,                                  -- updated on every authenticated request
  expires_at      TIMESTAMPTZ,                                  -- NULL = no expiry
  revoked_at      TIMESTAMPTZ,                                  -- NULL = active; set = soft-revoked
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: every public-API request does a lookup by token_hash.
-- token_hash is already UNIQUE → backed by an implicit index, but
-- be explicit for clarity in pg_stat_user_indexes.
CREATE INDEX IF NOT EXISTS idx_venue_api_tokens_hash
  ON venue_api_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_venue_api_tokens_user_id
  ON venue_api_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_venue_api_tokens_venue_id
  ON venue_api_tokens (venue_id);

COMMIT;
