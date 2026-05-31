#!/bin/bash
# EVOLVE CRON — daily self-learning cycle
# Runs at 00:00 Moscow time via crontab
# Uses X-Internal-Key auth (not JWT — JWT tokens expire!)

LOG=/var/log/promofm-evolve.log
# Read internal key from .env (gitignored). Hardcoded key removed 2026-05-31 — audit INC-1.
if [ -f /opt/promofm-api/.env ]; then
  set -a; source /opt/promofm-api/.env; set +a
fi
INTERNAL_KEY="${VPS_INTERNAL_KEY:?VPS_INTERNAL_KEY required — set in /opt/promofm-api/.env}"

echo "[$(date -Iseconds)] Starting evolve cycle" >> $LOG

# Run evolve mode (with internal key auth)
RESULT=$(curl -s -X POST http://localhost:3000/server/api/ecosystem/mode/evolve/run   -H 'Content-Type: application/json'   -H "X-Internal-Key: $INTERNAL_KEY"   -d '{}' --max-time 300)

echo "[$(date -Iseconds)] Result: $RESULT" >> $LOG

# Cleanup expired short-term memory
curl -s -X DELETE http://localhost:3000/server/api/memory/short/expired   -H "X-Internal-Key: $INTERNAL_KEY" >> $LOG 2>&1

echo "[$(date -Iseconds)] Evolve cycle complete" >> $LOG
