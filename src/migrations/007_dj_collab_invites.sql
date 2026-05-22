-- DJ collaborations as row-per-invite.
-- Previous code used djCollaborationsStore (jsonbStore on 'dj_collaborations'
-- keyed by dj_id), but it wrote invites to the SENDER's row, so the receiver
-- never saw them. We keep the legacy table untouched and add a proper one.

CREATE TABLE IF NOT EXISTS dj_collab_invites (
  id TEXT PRIMARY KEY,
  from_dj_id TEXT NOT NULL,
  to_dj_id TEXT NOT NULL,
  type TEXT,                          -- 'b2b' | 'remix' | 'event' | 'mentorship'
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled
  reason TEXT,                        -- decline / cancel reason (optional)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dj_collab_invites_from   ON dj_collab_invites(from_dj_id);
CREATE INDEX IF NOT EXISTS idx_dj_collab_invites_to     ON dj_collab_invites(to_dj_id);
CREATE INDEX IF NOT EXISTS idx_dj_collab_invites_status ON dj_collab_invites(status);
