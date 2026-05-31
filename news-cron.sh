#!/bin/bash
# NEWS CRON — сбор новостей каждые 2 часа
# Регио-сбалансированная выборка: 2 RU + 1 Africa + 1 Europe + 1 World = 5 за прогон.
# Гарантирует охват российской индустрии, африканских и европейских новинок КАЖДЫЙ прогон
# (раньше было 5 случайных из 15 — Африка/Европа выпадали редко).
# Read internal key from .env (gitignored). Hardcoded key removed 2026-05-31 — audit INC-1.
if [ -f /opt/promofm-api/.env ]; then
  set -a; source /opt/promofm-api/.env; set +a
fi
INTERNAL_KEY="${VPS_INTERNAL_KEY:?VPS_INTERNAL_KEY required — set in /opt/promofm-api/.env}"
LOG=/var/log/promofm-news.log

# Region buckets
RU=(intermedia theflow rollingstone-ru lenta-music afisha-daily zvuki-ru cnews-ai)
AFRICA=(ok-africa music-in-africa notjustok)
EUROPE=(nme guardian-music djmag les-inrocks factmag)
WORLD=(pitchfork rollingstone-us consequence stereogum remezcla)

# One host per cycle — like real radio, one DJ per shift
HOSTS=("DJ Den" "Сандра" "Лиана" "Макс" "Марк" "Пабло" "Нико" "РадКат" "Стелла")
HOST=${HOSTS[$RANDOM % ${#HOSTS[@]}]}

# pickn N <list...> — N distinct random elements
pickn() { local n=$1; shift; printf '%s\n' "$@" | shuf | head -n "$n"; }

SELECTED=( $(pickn 2 "${RU[@]}") $(pickn 1 "${AFRICA[@]}") $(pickn 1 "${EUROPE[@]}") $(pickn 1 "${WORLD[@]}") )

echo "[$(date -Iseconds)] News cron: host=$HOST, fetching ${SELECTED[*]}" >> $LOG

for src in "${SELECTED[@]}"; do
  RESULT=$(curl -s -X POST "http://127.0.0.1:3000/server/api/news-agent/fetch/$src" \
    -H 'Content-Type: application/json' \
    -H "X-Internal-Key: $INTERNAL_KEY" \
    -d "{\"host\":\"$HOST\"}" \
    --max-time 120 2>&1)
  echo "[$(date -Iseconds)] $src ($HOST): $RESULT" >> $LOG
  sleep 3
done

echo "[$(date -Iseconds)] News cron complete" >> $LOG
