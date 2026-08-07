#!/bin/bash
# Watchdog v3: ловит и упавший стрим, и ЗАВИСШИЙ playback (v2 слепое пятно:
# burst застывшего буфера проходил порог 30KB, пока autodj 3 дня стоял на одном треке).
# Проверки: 1) байты стрима за 8с; 2) возраст played_at через DJ API (>30 мин = зависание);
# 3) FATAL в журнале. Рестарт с кулдауном 5 мин (не дёргать сервисы в цикле).
set -e

LOG=/var/log/promofm-watchdog.log
STREAM_URL="http://127.0.0.1:8086/live/promo.fm"
DJ_STATUS_URL="http://127.0.0.1:8087/api/status"
TEST_FILE=/tmp/_air_watchdog_probe.bin
MIN_SIZE=30000
MAX_TRACK_AGE=1800
COOLDOWN_FILE=/tmp/_air_watchdog_last_restart
COOLDOWN_SEC=300

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

restart_all() {
    NOW=$(date +%s)
    LAST=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
    if [ $((NOW - LAST)) -lt "$COOLDOWN_SEC" ]; then
        log "SKIP restart: cooldown ($((NOW - LAST))s < ${COOLDOWN_SEC}s)"
        return 0
    fi
    echo "$NOW" > "$COOLDOWN_FILE"
    systemctl restart promofm-stream.service 2>&1 | head -2 | tee -a "$LOG"
    sleep 3
    systemctl restart promofm-autodj.service 2>&1 | head -2 | tee -a "$LOG"
    log "Restarted (stream+autodj)"
}

# 1. Капнем стрим
timeout 8 curl -s -o "$TEST_FILE" "$STREAM_URL" 2>/dev/null || true
SIZE=$(stat -c%s "$TEST_FILE" 2>/dev/null || echo 0)
rm -f "$TEST_FILE"

# 2. Возраст текущего трека по DJ API (-1 = API недоступен, -2 = нет played_at)
AGE=$(curl -s -m 5 "$DJ_STATUS_URL" 2>/dev/null | python3 -c "
import json, sys, datetime
try:
    d = json.load(sys.stdin)
    pa = (d.get('current_track_info') or {}).get('played_at')
    if not pa:
        print(-2); raise SystemExit
    t = datetime.datetime.fromisoformat(pa)
    print(int((datetime.datetime.now() - t).total_seconds()))
except SystemExit:
    pass
except Exception:
    print(-1)
" 2>/dev/null || echo -1)
case "$AGE" in (*[!0-9-]*|'') AGE=-1;; esac

# 3. FATAL за последнюю минуту (|| true, НЕ || echo 0 — тот дублировал ноль)
FATAL=$(journalctl -u promofm-autodj --since '60 seconds ago' --no-pager 2>/dev/null | grep -cE 'FATAL: Broken pipe|systemd.*Main process exited' || true)
case "$FATAL" in (*[!0-9]*|'') FATAL=0;; esac

if [ "$SIZE" -lt "$MIN_SIZE" ]; then
    log "STALE: stream size=$SIZE (need >$MIN_SIZE) — RESTART"
    restart_all
elif [ "$AGE" -gt "$MAX_TRACK_AGE" ]; then
    log "FROZEN: played_at age=${AGE}s (> ${MAX_TRACK_AGE}s) — playback loop stuck — RESTART"
    restart_all
elif [ "$AGE" -eq -1 ]; then
    log "DJ API unreachable — RESTART"
    restart_all
elif [ "$FATAL" -gt 0 ]; then
    log "FATAL detected: $FATAL events — RESTART"
    restart_all
else
    log "OK: size=$SIZE age=${AGE}s"
fi
