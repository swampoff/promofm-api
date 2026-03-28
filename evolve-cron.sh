#!/bin/bash
# EVOLVE CRON — daily self-learning cycle
# Runs at 00:00 Moscow time via crontab
# Triggers: feedback_collector → improvement_agent → product_optimizer → role_expansion_scout

LOG=/var/log/promofm-evolve.log
CRON_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjcm9uLXN5c3RlbSIsImVtYWlsIjoic3lzdGVtQHByb21vLW11c2ljLnJ1Iiwicm9sZSI6ImFkbWluIiwiaXNzIjoicHJvbW9mbS1jcm9uIiwiaWF0IjoxNzc0NzM1MzUwLCJleHAiOjIwOTAzMTEzNTB9.oLPltcgkEbbhyTZLWQm45a46pv6Wros8E7KmhBFJt2E"

echo "[$(date -Iseconds)] Starting evolve cycle" >> $LOG

# Run evolve mode (with auth)
RESULT=$(curl -s -X POST http://localhost:3000/server/api/ecosystem/mode/evolve/run   -H 'Content-Type: application/json'   -H "Authorization: Bearer $CRON_TOKEN"   -d '{}' --max-time 300)

echo "[$(date -Iseconds)] Result: $RESULT" >> $LOG

# Cleanup expired short-term memory
curl -s -X DELETE http://localhost:3000/server/api/memory/short/expired   -H "Authorization: Bearer $CRON_TOKEN" >> $LOG 2>&1

echo "[$(date -Iseconds)] Evolve cycle complete" >> $LOG
