-- 022_dm_blocks_reports.sql — user-to-user blocks + abuse reports for DM
--
-- Two tables, one migration, both gating the in-platform DM surface
-- (see `src/messaging-routes.tsx` + the «соцсеть внутри платформы»
-- product direction):
--
--   dm_blocks   — symmetric block list. A → B blocked means:
--                  • B cannot find A in /search-contacts
--                  • A cannot find B in /search-contacts
--                  • POST /conversations involving both fails 403
--                  • POST /messages/:convId fails 403 if either
--                    side has blocked the other (existing convs
--                    still readable so neither side loses history)
--                  • Block applies to messaging only, not to the
--                    rest of the platform (booking, pitching, etc.)
--
--   dm_reports  — abuse reports queued for admin review. Separate
--                  from blocks so a user can block without
--                  necessarily filing a report, OR file a report
--                  without blocking (e.g. impersonation, spam).
--                  Admin UI can read this queue and act.
--
-- All-uuid joins use ::text to match the cabinet-table convention
-- (`*_profiles.user_id` is text; we use text everywhere downstream
-- in messaging-routes.tsx for consistency).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS dm_blocks (
  blocker_id  TEXT        NOT NULL,
  blocked_id  TEXT        NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  -- Block-yourself is nonsensical; gate at the DB so a malformed
  -- client can't poison the table.
  CHECK (blocker_id <> blocked_id)
);

-- For «is A blocked by anyone in this set?» queries (used when
-- hydrating search results / conversation lists)
CREATE INDEX IF NOT EXISTS idx_dm_blocks_blocked
  ON dm_blocks (blocked_id);

CREATE TABLE IF NOT EXISTS dm_reports (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  TEXT        NOT NULL,
  reported_id  TEXT        NOT NULL,
  -- Optional pointer to a specific offending message; null when the
  -- user reports the contact as a whole rather than one message.
  message_id   UUID,
  category     TEXT        NOT NULL DEFAULT 'other',  -- 'spam' | 'abuse' | 'impersonation' | 'other'
  details      TEXT,
  status       TEXT        NOT NULL DEFAULT 'pending', -- 'pending' | 'reviewed' | 'rejected' | 'actioned'
  reviewer_id  TEXT,
  reviewed_at  TIMESTAMPTZ,
  resolution   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admin queue scans pending in chronological order
CREATE INDEX IF NOT EXISTS idx_dm_reports_status_created
  ON dm_reports (status, created_at);

-- Per-reporter rate-limit lookup
CREATE INDEX IF NOT EXISTS idx_dm_reports_reporter
  ON dm_reports (reporter_id, created_at);

COMMIT;
