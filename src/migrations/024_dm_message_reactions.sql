-- 024_dm_message_reactions.sql — emoji reactions on DM messages
--
-- One row per (message, user, emoji). Toggling a reaction is an
-- UPSERT-or-DELETE on the natural PK. The FE renders aggregated
-- counts per emoji + the list of users who reacted (used for the
-- «X отреагировал» tooltip).
--
-- Schema notes:
--   - `message_id` is TEXT (not UUID with FK) so this migration
--     works whether dm_messages.id is uuid OR text. Cross-cast is
--     done by JOIN consumers (`m.id::text = r.message_id`) to
--     match the existing convention in messaging-routes.tsx
--     (users.id is uuid, dm_messages.sender_id is text, JOIN uses
--     ::text).
--   - No FK constraint → orphaned reaction rows are possible if a
--     message is deleted. A periodic GC query
--     `DELETE FROM dm_message_reactions r
--        WHERE NOT EXISTS (SELECT 1 FROM dm_messages m
--                           WHERE m.id::text = r.message_id)`
--     cleans them. Cheap compared to FK cascade lock contention.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS dm_message_reactions (
  message_id  TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  emoji       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_dm_message_reactions_message
  ON dm_message_reactions (message_id);

COMMIT;
