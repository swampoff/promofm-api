-- 023_dm_message_attachments.sql — file / image / voice in DM
--
-- Extends `dm_messages` with attachment columns so the chat can
-- carry file / image / voice messages alongside text. Without
-- this, the frontend's existing paperclip + mic UI only ever
-- created local blob-URL messages that nobody else could see
-- (URL.createObjectURL is per-tab).
--
-- Columns added (all NULL by default for text messages):
--   attachment_url    — public URL under /server/uploads/dm/...
--   attachment_name   — original filename (UI display)
--   attachment_size   — bytes
--   attachment_mime   — full MIME ('image/png', 'audio/webm', ...)
--   attachment_meta   — jsonb { duration?, width?, height?, waveform? }
--
-- `message_type` (existing TEXT column) is the discriminator:
--   'text' | 'file' | 'image' | 'voice' | 'attachment'
--   The frontend renders accordingly.
--
-- Idempotent — re-run safe.

BEGIN;

ALTER TABLE dm_messages
  ADD COLUMN IF NOT EXISTS attachment_url  TEXT,
  ADD COLUMN IF NOT EXISTS attachment_name TEXT,
  ADD COLUMN IF NOT EXISTS attachment_size BIGINT,
  ADD COLUMN IF NOT EXISTS attachment_mime TEXT,
  ADD COLUMN IF NOT EXISTS attachment_meta JSONB;

-- Index by message_type so admin moderation queue can pull
-- «only attachments» queries cheaply (future feature).
CREATE INDEX IF NOT EXISTS idx_dm_messages_attachment_type
  ON dm_messages (conversation_id, message_type)
  WHERE attachment_url IS NOT NULL;

COMMIT;
