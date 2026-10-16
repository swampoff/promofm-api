#!/bin/bash
# Runs one venue billing cron job against the local API (PROMO.AIR, 16.10.2026).
#
#   venue-cron.sh expire-trials       POST /server/api/venue/cron/expire-trials
#                                     (trial end: charge the chosen tier, else expire;
#                                      T-3 / T-1 reminder emails)
#   venue-cron.sh charge-recurring    POST /server/api/venue-billing/cron/charge-recurring
#                                     (renewals RENEWAL_LEAD_DAYS before the period end,
#                                      expiry of cancelled / unpaid subscriptions)
#   venue-cron.sh stream-player-tick  POST /server/api/stream-player/cron/tick
#                                     (not scheduled: nothing reads stream_player_state yet)
#
# Called by systemd/promofm-venue-cron@.service (timers in systemd/). Output goes
# to stdout/stderr, i.e. the journal: journalctl -u 'promofm-venue-cron@*'.
#
# - CRON_SECRET is read from the API's .env (only that line; the file is not
#   sourced) and sent to curl on stdin, so it never appears in `ps`.
# - flock: a second run of the same job exits at once while the first is still
#   running (the expire-trials endpoint also holds a Postgres advisory lock).
# - Exit code is non-zero on HTTP errors, so a failed run shows up in
#   `systemctl --failed` / `systemctl status promofm-venue-cron@<job>`.
set -euo pipefail

JOB="${1:-}"
ENV_FILE="${PROMOFM_ENV_FILE:-/opt/promofm-api/.env}"
API="${PROMOFM_API_URL:-http://127.0.0.1:3000}"
LOCK_DIR="${PROMOFM_LOCK_DIR:-/run/lock}"

case "$JOB" in
  expire-trials)      PATH_="/server/api/venue/cron/expire-trials";              MAX_TIME=540 ;;
  charge-recurring)   PATH_="/server/api/venue-billing/cron/charge-recurring";   MAX_TIME=540 ;;
  stream-player-tick) PATH_="/server/api/stream-player/cron/tick";               MAX_TIME=25 ;;
  *) echo "usage: $0 expire-trials|charge-recurring|stream-player-tick" >&2; exit 2 ;;
esac

SECRET="$(grep -E '^[[:space:]]*CRON_SECRET=' "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)"
SECRET="${SECRET%\"}"; SECRET="${SECRET#\"}"; SECRET="${SECRET%\'}"; SECRET="${SECRET#\'}"
if [ -z "$SECRET" ]; then
  echo "[venue-cron] $JOB: CRON_SECRET is not set in $ENV_FILE, nothing done" >&2
  exit 1
fi

exec 9>"$LOCK_DIR/promofm-venue-cron-$JOB.lock"
if ! flock -n 9; then
  echo "[venue-cron] $JOB: previous run still in progress, skipping"
  exit 0
fi

START="$(date -u +%FT%TZ)"
set +e
BODY="$(printf 'X-Cron-Secret: %s\n' "$SECRET" | curl -sS --fail-with-body --max-time "$MAX_TIME" \
  -X POST -H @- -H 'Content-Type: application/json' -d '{}' "$API$PATH_")"
RC=$?
set -e
echo "[venue-cron] $JOB start=$START rc=$RC response=$BODY"
exit "$RC"
