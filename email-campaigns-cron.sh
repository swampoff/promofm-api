#!/bin/bash
# Email-campaigns scheduler — каждые 5 минут запускает отложенные рассылки
# (status='scheduled' со scheduled_at <= now). До этого крона scheduled-кампании
# не уходили вообще: статус ставился, а отправлять их было некому.
#
# Crontab (ставится на VPS вручную, НЕ в репо):
#   */5 * * * * /opt/promofm-api/email-campaigns-cron.sh >> /var/log/promofm-email-campaigns.log 2>&1
#
# Внутренний ключ читаем из .env (gitignored) — как в остальных cron-скриптах.

if [ -f /opt/promofm-api/.env ]; then
  set -a; source /opt/promofm-api/.env; set +a
fi
INTERNAL_KEY="${VPS_INTERNAL_KEY:?VPS_INTERNAL_KEY required — set in /opt/promofm-api/.env}"
API="http://localhost:3000/server/api/email-campaigns/campaigns/run-scheduled"

RESULT=$(curl -s -m 120 -X POST "$API" \
  -H "X-Internal-Key: $INTERNAL_KEY" \
  -H "Content-Type: application/json")
echo "[email-campaigns] $(date): $RESULT"
