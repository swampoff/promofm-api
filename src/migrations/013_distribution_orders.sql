-- Distribution Orders — track release distribution to DSPs (Yandex Music,
-- VK Music, Spotify, Apple Music, etc.) and post-release stats tracking.
--
-- Manual fulfillment today: artist pays via /distribute endpoint →
-- admin sees the order in /ctrl-pm7k2f → admin uploads the track to the
-- DSP manually (or via DistroKid-style aggregator) → admin records the
-- DSP-side ID / URL back. Stats are also admin-entered today.
--
-- Roadmap: replace admin-manual with API-integration (Yandex Music
-- partner API, VK Music API, Spotify for Artists API) — same table,
-- same endpoints, only the fulfillment-side implementation changes.
-- That's why the schema explicitly carries `dsp_track_id`, `submitted_at`,
-- `live_at`, `stats_last_fetched_at` — all the columns a future API
-- worker needs to drive the lifecycle automatically.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS),
-- safe to re-run.

BEGIN;

-- ── distribution_orders ─────────────────────────────────────────
-- One row per (track × target DSP). An artist who wants to publish a
-- single track to four DSPs has four rows here.
CREATE TABLE IF NOT EXISTS distribution_orders (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id            UUID         NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  user_id             TEXT         NOT NULL,             -- artist's user_id (text, per cheat-sheet)
  target_dsp          TEXT         NOT NULL,             -- 'yandex_music' | 'vk_music' | 'spotify' | 'apple_music' | 'all'
  status              TEXT         NOT NULL DEFAULT 'pending',  -- 'pending' | 'paid' | 'submitted' | 'live' | 'rejected' | 'cancelled'
  -- DSP-side identifiers (populated by admin or future API worker)
  dsp_track_id        TEXT,                                -- DSP's own track id once submitted
  dsp_track_url       TEXT,                                -- public link to listen on DSP
  -- Lifecycle timestamps
  submitted_at        TIMESTAMPTZ,                         -- when admin pushed to DSP
  live_at             TIMESTAMPTZ,                         -- when DSP confirmed the track is publicly live
  rejected_reason     TEXT,                                -- if DSP rejected (copyright, quality, etc.)
  -- Stats — manual entry today, API-fetched later. Stored as last-known
  -- snapshot; for richer time-series add `distribution_stats_history`.
  stats_plays         BIGINT       NOT NULL DEFAULT 0,
  stats_saves         BIGINT       NOT NULL DEFAULT 0,
  stats_playlist_adds INTEGER      NOT NULL DEFAULT 0,
  stats_last_fetched_at TIMESTAMPTZ,                       -- when the stats above were last refreshed
  -- Pricing & payment
  price_rub           INTEGER      NOT NULL DEFAULT 0,     -- per-DSP fee at time of order (after discount)
  base_price_rub      INTEGER      NOT NULL DEFAULT 0,     -- pre-discount fee (for audit)
  discount_pct        NUMERIC(4,3) NOT NULL DEFAULT 0,     -- 0..1 — applied subscription discount
  payment_session_id  TEXT,                                -- FK-ish to payment_sessions.orderId (text)
  -- Audit
  created_by_role     TEXT,                                -- 'artist' | 'admin'
  notes               TEXT,                                -- admin-only notes
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT distribution_orders_status_chk
    CHECK (status IN ('pending', 'paid', 'submitted', 'live', 'rejected', 'cancelled')),
  CONSTRAINT distribution_orders_target_dsp_chk
    CHECK (target_dsp IN ('yandex_music', 'vk_music', 'spotify', 'apple_music', 'soundcloud', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_distribution_orders_user
  ON distribution_orders (user_id);

CREATE INDEX IF NOT EXISTS idx_distribution_orders_track
  ON distribution_orders (track_id);

CREATE INDEX IF NOT EXISTS idx_distribution_orders_status
  ON distribution_orders (status);

-- Admin-queue index: pull pending/paid orders awaiting submission,
-- ordered by oldest first (FIFO fulfilment).
CREATE INDEX IF NOT EXISTS idx_distribution_orders_admin_queue
  ON distribution_orders (status, created_at)
  WHERE status IN ('pending', 'paid', 'submitted');

-- ── distribution_stats_history (optional, time-series for future) ────
-- Records each stats refresh so trends are visible in the artist
-- cabinet. Today it's only written when admin pastes new stats; the
-- API-integration worker will write here too with high frequency.
CREATE TABLE IF NOT EXISTS distribution_stats_history (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID         NOT NULL REFERENCES distribution_orders(id) ON DELETE CASCADE,
  plays        BIGINT       NOT NULL DEFAULT 0,
  saves        BIGINT       NOT NULL DEFAULT 0,
  playlist_adds INTEGER     NOT NULL DEFAULT 0,
  fetched_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  source       TEXT         NOT NULL DEFAULT 'admin'      -- 'admin' | 'api'
);

CREATE INDEX IF NOT EXISTS idx_distribution_stats_history_order_fetched
  ON distribution_stats_history (order_id, fetched_at DESC);

-- Touch trigger: bump distribution_orders.updated_at on any UPDATE.
CREATE OR REPLACE FUNCTION distribution_orders_touch() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_distribution_orders_touch ON distribution_orders;
CREATE TRIGGER trg_distribution_orders_touch
  BEFORE UPDATE ON distribution_orders
  FOR EACH ROW EXECUTE FUNCTION distribution_orders_touch();

COMMIT;
