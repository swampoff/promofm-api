#!/bin/bash
# Ежедневная волна рассылки по заведениям (promo.air).
# Порядок сегментов A → B → C выбирается автоматически: маршрут берёт
# первый непустой. Итог каждой волны уходит копией на info@promofm.ru.
cd /opt/promofm-api
KEY=$(grep -E "^VPS_INTERNAL_KEY=" .env | cut -d= -f2-)
LIMIT="${1:-1500}"
echo "=== $(date '+%F %T') волна, лимит $LIMIT ==="
curl -s -X POST -H "X-Internal-Key: $KEY" --max-time 3000 \
  "https://promo-music.ru/server/api/venue-campaign/run-wave?limit=$LIMIT"
echo ""
