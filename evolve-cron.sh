#!/bin/bash
# EVOLVE CRON — daily self-learning cycle
# Runs at 03:00 Moscow time via crontab
# Triggers: feedback_collector → improvement_agent → product_optimizer → role_expansion_scout

LOG=/var/log/promofm-evolve.log
echo "[$(date -Iseconds)] Starting evolve cycle" >> $LOG

# Run evolve mode
RESULT=$(curl -s -X POST http://localhost:3000/server/api/ecosystem/mode/evolve/run   -H 'Content-Type: application/json'   -d '{}' --max-time 300)

echo "[$(date -Iseconds)] Result: $RESULT" >> $LOG

# Cleanup expired short-term memory
curl -s -X DELETE http://localhost:3000/server/api/memory/short/expired >> $LOG 2>&1

echo "[$(date -Iseconds)] Evolve cycle complete" >> $LOG
