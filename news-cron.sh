#!/bin/bash
# NEWS CRON — сбор новостей каждые 2 часа
# Ротация: каждый запуск берёт 5 случайных источников из 15
INTERNAL_KEY="b5f5cced4f4297465726e7069e35c1d113319187853b765af0e8b4df80d7acc3"
LOG=/var/log/promofm-news.log

SOURCES=(intermedia theflow rollingstone-ru lenta-music afisha-daily pitchfork nme rollingstone-us consequence guardian-music djmag stereogum remezcla ok-africa cnews-ai)

# One host per cycle — like real radio, one DJ per shift
HOSTS=("DJ Den" "Сандра" "Лиана" "Макс" "Марк" "Пабло" "Нико" "РадКат" "Стелла")
HOST=${HOSTS[$RANDOM % ${#HOSTS[@]}]}

# Shuffle and pick 5 sources
SHUFFLED=($(printf '%s\n' "${SOURCES[@]}" | shuf | head -5))

echo "[$(date -Iseconds)] News cron: host=$HOST, fetching ${SHUFFLED[*]}" >> $LOG

for src in "${SHUFFLED[@]}"; do
  RESULT=$(curl -s -X POST "http://127.0.0.1:3000/server/api/news-agent/fetch/$src" \
    -H 'Content-Type: application/json' \
    -H "X-Internal-Key: $INTERNAL_KEY" \
    -d "{\"host\":\"$HOST\"}" \
    --max-time 120 2>&1)
  echo "[$(date -Iseconds)] $src ($HOST): $RESULT" >> $LOG
  sleep 3
done

echo "[$(date -Iseconds)] News cron complete" >> $LOG
