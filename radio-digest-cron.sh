#!/bin/bash
# Radio new-release digest — раз в день шлёт на info@promofm.ru до 2 новинок
# недели (ротация, user_id='system-friday') для РУЧНОЙ пересылки партнёрам.
# Письмо идёт на собственный домен (локальная доставка), не холодная рассылка.
#
# Crontab (ставится на VPS вручную, НЕ в репо). 10:00 по Берлину с DST:
#   CRON_TZ=Europe/Berlin
#   0 10 * * * /opt/promofm-api/radio-digest-cron.sh >> /var/log/promofm-radio-digest.log 2>&1
#
# Внутренний ключ читаем из .env (gitignored) — как в остальных cron-скриптах
# (audit INC-1, 2026-05-31: хардкод ключей убран).

if [ -f /opt/promofm-api/.env ]; then
  set -a; source /opt/promofm-api/.env; set +a
fi
INTERNAL_KEY="${VPS_INTERNAL_KEY:?VPS_INTERNAL_KEY required — set in /opt/promofm-api/.env}"
API="http://localhost:3000/server/api/radio-digest/run"

echo "[radio-digest] $(date): отправка дневного дайджеста новинок на info@promofm.ru"
RESULT=$(curl -s -m 60 -X POST "$API" \
  -H "X-Internal-Key: $INTERNAL_KEY" \
  -H "Content-Type: application/json")
echo "[radio-digest] Result: $RESULT"
