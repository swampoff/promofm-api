# promofm-api systemd units

Files for systemd-managed background work on the VPS.

## stream-player tick

`promofm-stream-player.service` + `promofm-stream-player.timer`
together poll the API once a minute. The service hits
`POST /server/api/stream-player/cron/tick` (authenticated via the
existing `CRON_SECRET` env var) which resolves "what should be playing
right now" for every venue + zone and writes the result to the
`stream_player_state` table.

### Install on the VPS

```bash
# As root, with the repo cloned at /opt/promofm-api:
sudo cp /opt/promofm-api/systemd/promofm-stream-player.service /etc/systemd/system/
sudo cp /opt/promofm-api/systemd/promofm-stream-player.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now promofm-stream-player.timer
```

### Verify

```bash
# Timer is armed:
systemctl list-timers promofm-stream-player.timer

# Last run output (should show stats JSON):
journalctl -u promofm-stream-player.service -n 20 --no-pager

# Database state (recent ticks):
sudo -u postgres psql -d promofm -c \
  "SELECT venue_id, zone_id, status, current_playlist_id,
          last_change_at, last_tick_at
     FROM stream_player_state
    ORDER BY last_tick_at DESC
    LIMIT 20;"
```

### Disable

```bash
sudo systemctl disable --now promofm-stream-player.timer
```

The service itself is `Type=oneshot` and not directly enabled — only
the timer is enabled.
