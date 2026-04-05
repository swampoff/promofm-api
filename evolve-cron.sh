#!/bin/bash
# EVOLVE CRON — daily self-learning cycle
# Runs at 00:00 Moscow time via crontab
# Uses X-Internal-Key auth (not JWT — JWT tokens expire!)

LOG=/var/log/promofm-evolve.log
INTERNAL_KEY="b5f5cced4f4297465726e7069e35c1d113319187853b765af0e8b4df80d7acc3"

echo "[$(date -Iseconds)] Starting evolve cycle" >> $LOG

# Run evolve mode (with internal key auth)
RESULT=$(curl -s -X POST http://localhost:3000/server/api/ecosystem/mode/evolve/run   -H 'Content-Type: application/json'   -H "X-Internal-Key: $INTERNAL_KEY"   -d '{}' --max-time 300)

echo "[$(date -Iseconds)] Result: $RESULT" >> $LOG

# Cleanup expired short-term memory
curl -s -X DELETE http://localhost:3000/server/api/memory/short/expired   -H "X-Internal-Key: $INTERNAL_KEY" >> $LOG 2>&1

echo "[$(date -Iseconds)] Evolve cycle complete" >> $LOG
