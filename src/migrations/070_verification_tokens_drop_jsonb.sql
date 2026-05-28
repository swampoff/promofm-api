-- Migration 070 — verification_tokens cleanup: drop data jsonb + sync trigger.
--
-- Контекст:
--   Migration 004 (Feb 2026) добавила native cols user_id / token_type /
--   expires_at / used_at + created sync trigger BEFORE INSERT OR UPDATE
--   которая копировала эти поля из data jsonb. Таблица была в hybrid
--   state: writers продолжали писать в data jsonb (через
--   verificationTokensStore.set), trigger автоматически синхронизировал
--   на native cols.
--
--   Эта миграция завершает переезд: DROP COLUMN data + DROP trigger.
--   Writers переведены на typed pool.query INSERT/UPDATE напрямую
--   через native cols (см. companion change в src/vps-userdata.tsx +
--   src/db.tsx).
--
-- Schema after:
--   id          TEXT PRIMARY KEY  -- token itself
--   user_id     TEXT NOT NULL
--   token_type  TEXT NOT NULL DEFAULT 'email_verify'
--   expires_at  TIMESTAMPTZ NOT NULL
--   used_at     TIMESTAMPTZ
--   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
--   updated_at  TIMESTAMPTZ
--
-- Idempotent: DROP IF EXISTS / DROP COLUMN IF EXISTS / CREATE INDEX IF NOT EXISTS.

-- ── Backfill final pass (paranoid — на случай если какие-то rows
--    проскользнули мимо trigger'а, например через manual SQL admin).
UPDATE verification_tokens SET
  user_id    = COALESCE(user_id,    data->>'user_id'),
  token_type = COALESCE(token_type, data->>'type'),
  expires_at = COALESCE(expires_at, NULLIF(data->>'expires_at','')::timestamptz),
  used_at    = COALESCE(used_at,    NULLIF(data->>'used_at','')::timestamptz)
WHERE data IS NOT NULL;

-- ── Drop sync trigger + function (больше не нужны)
DROP TRIGGER IF EXISTS trg_sync_verification_tokens ON verification_tokens;
DROP FUNCTION IF EXISTS sync_verification_tokens_native();

-- ── Drop data column
ALTER TABLE verification_tokens DROP COLUMN IF EXISTS data;

-- ── Tighten constraints: после backfill native cols должны быть NOT NULL
--    для tokens которые имеют смысл. Старые orphan-rows (где user_id NULL
--    после backfill) — drop, они уже невалидны.
DELETE FROM verification_tokens WHERE user_id IS NULL OR expires_at IS NULL;

ALTER TABLE verification_tokens
  ALTER COLUMN user_id    SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE verification_tokens
  ALTER COLUMN token_type SET DEFAULT 'email_verify';

UPDATE verification_tokens SET token_type = 'email_verify' WHERE token_type IS NULL;

ALTER TABLE verification_tokens
  ALTER COLUMN token_type SET NOT NULL;

-- ── Hot-path partial index: "find non-expired non-used tokens"
--    Existing indexes from 004 already cover user_id, expires_at, token_type
--    отдельно; этот combined partial index закрывает auth verify lookup.
CREATE INDEX IF NOT EXISTS idx_verif_tokens_active
  ON verification_tokens(expires_at) WHERE used_at IS NULL;
