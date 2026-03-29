#!/bin/bash
# NEWS CRON — сбор новостей каждые 2 часа
# Ротация: каждый запуск берёт 5 случайных источников из 15
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjcm9uLXN5c3RlbSIsImVtYWlsIjoic3lzdGVtQHByb21vLW11c2ljLnJ1Iiwicm9sZSI6ImFkbWluIiwiaXNzIjoicHJvbW9mbS1jcm9uIiwiaWF0IjoxNzc0NzU4NjM5LCJleHAiOjIwOTAzMzQ2Mzl9.l6yvY6E2raRlUCYsQRUyOfRnlPEWOMn2nhB4xmTfr80"
LOG=/var/log/promofm-news.log

SOURCES=(intermedia theflow rollingstone-ru lenta-music afisha-daily pitchfork nme rollingstone-us consequence guardian-music djmag stereogum remezcla ok-africa cnews-ai)

# Shuffle and pick 5
SHUFFLED=($(printf '%s\n' "${SOURCES[@]}" | shuf | head -5))

echo "[$(date -Iseconds)] News cron: fetching ${SHUFFLED[*]}" >> $LOG

for src in "${SHUFFLED[@]}"; do
  RESULT=$(curl -s -X POST "http://127.0.0.1:3000/server/api/news-agent/fetch/$src" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    --max-time 120 2>&1)
  echo "[$(date -Iseconds)] $src: $RESULT" >> $LOG
  sleep 3
done

echo "[$(date -Iseconds)] News cron complete" >> $LOG
