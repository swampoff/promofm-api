#!/bin/bash
# Track pipeline: upcoming → published
# Hits /track-moderation/promote-upcoming which scans tracks WHERE
# moderation_status='upcoming' AND data->>'upcoming_until' < now(),
# flips them to 'published' (Новинки недели). Without this script
# tracks land in «Скоро» and stay there forever.
#
# Crontab — recommended every 10 minutes. Drift-tolerant; the SQL
# in /promote-upcoming uses upcoming_until timestamps so it doesn't
# matter if a run is skipped, the next one catches up.
#
#   */10 * * * * /opt/promofm-api/promote-upcoming-cron.sh >> /var/log/promofm-promote-upcoming.log 2>&1
#
# Install:
#   chmod +x /opt/promofm-api/promote-upcoming-cron.sh
#   sudo crontab -e   # add the line above

INTERNAL_KEY="${VPS_INTERNAL_KEY:-b5f5cced4f4297465726e7069e35c1d113319187853b765af0e8b4df80d7acc3}"
API="http://localhost:3000/server/api/track-moderation/promote-upcoming"

RESULT=$(curl -s -m 30 -X POST "$API" \
  -H "X-Internal-Key: $INTERNAL_KEY" \
  -H "Content-Type: application/json")

# Only log non-empty / non-zero results to keep the file lean.
if echo "$RESULT" | grep -qv '"promoted":0'; then
  echo "[promote-upcoming] $(date '+%Y-%m-%d %H:%M:%S') $RESULT"
fi
