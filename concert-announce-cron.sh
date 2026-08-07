#!/bin/bash
# Concert announcements — вызывается cron 2 раза в день
# Анонс Москвы и СПб по очереди, разные ведущие

# Read internal key from .env (gitignored). Hardcoded key removed 2026-05-31 — audit INC-1.
if [ -f /opt/promofm-api/.env ]; then
  set -a; source /opt/promofm-api/.env; set +a
fi
INTERNAL_KEY="${VPS_INTERNAL_KEY:?VPS_INTERNAL_KEY required — set in /opt/promofm-api/.env}"
API="http://localhost:3000/server/api/broadcast/concerts"

# Массив ведущих для ротации
AUTHORS=("Сандра" "Лиана" "Макс" "Стелла" "Марк")
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
