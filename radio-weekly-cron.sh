#!/bin/bash
# Weekly radio digest — ПОНЕДЕЛЬНИК 12:00 шлёт пятничный батч новинок НАПРЯМУЮ
# всей базе радиостанций (зарегистрированные radio-аккаунты + партнёры из
# radio_partner_contacts + копия на info@promofm.ru). Красивая карточная форма.
# Отдельно от daily info@-дайджеста (radio-digest-cron.sh) — свой курсор
# tracks.radio_weekly_digest_sent_at, не конфликтуют.
#
# Crontab (ставится на VPS вручную, НЕ в репо). Понедельник 12:00 по Москве:
#   CRON_TZ=Europe/Moscow
#   0 12 * * 1 /opt/promofm-api/radio-weekly-cron.sh >> /var/log/promofm-radio-weekly.log 2>&1
#
# Внутренний ключ читаем из .env (gitignored) — как в остальных cron-скриптах.

if [ -f /opt/promofm-api/.env ]; then
  set -a; source /opt/promofm-api/.env; set +a
fi
INTERNAL_KEY="${VPS_INTERNAL_KEY:?VPS_INTERNAL_KEY required — set in /opt/promofm-api/.env}"
API="http://localhost:3000/server/api/radio-digest/run-weekly"

echo "[radio-weekly] $(date): понедельничная рассылка новинок недели всей базе радио"
RESULT=$(curl -s -m 120 -X POST "$API" \
  -H "X-Internal-Key: $INTERNAL_KEY" \
  -H "Content-Type: application/json")
echo "[radio-weekly] Result: $RESULT"
