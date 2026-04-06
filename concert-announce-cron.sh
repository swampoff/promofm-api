#!/bin/bash
# Concert announcements — вызывается cron 2 раза в день
# Анонс Москвы и СПб по очереди, разные ведущие

INTERNAL_KEY="b5f5cced4f4297465726e7069e35c1d113319187853b765af0e8b4df80d7acc3"
API="http://localhost:3000/server/api/broadcast/concerts"

# Массив ведущих для ротации
AUTHORS=("DJ Den" "Сандра" "Лиана" "Макс" "Стелла")
AUTHOR_IDX=$(( $(date +%j) % ${#AUTHORS[@]} ))
AUTHOR="${AUTHORS[$AUTHOR_IDX]}"

HOUR=$(date +%H)

# Утро — Москва, Вечер — СПб
if [ "$HOUR" -lt 14 ]; then
  CITY="Москва"
else
  CITY="Санкт-Петербург"
fi

echo "[concert-cron] $(date): Announcing $CITY concerts, author: $AUTHOR"

RESULT=$(curl -s -m 60 -X POST "$API" \
  -H "X-Internal-Key: $INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"city\": \"$CITY\", \"limit\": 6, \"author\": \"$AUTHOR\"}")

echo "[concert-cron] Result: $RESULT"
