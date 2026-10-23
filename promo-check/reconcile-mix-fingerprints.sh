#!/bin/bash
# promo.check reconcile (DJ-МИКСЫ) — параллель к reconcile-fingerprints.sh (треки).
# Гарантирует, что у каждого опубликованного микса с радио-дистрибуцией и аудио есть
# 'done'-фингерпринт. Safety-net для upload-time in-process-триггера (spawn fingerprinter
# --mix-id): если тот единичный вызов упал, микс иначе навсегда невидим для эфирного детекта —
# ровно та поломка, ради которой 2026-06-24 завели трековый reconcile. Также перезапускает
# застрявшие pending/error.
#
# ⚠️ СТАВИТЬ В КРОН ТОЛЬКО ПОСЛЕ: миграции 132 + fingerprinter.py --mix-id (смоук зелёный)
#    И прохождения viability-гейта (monitor.py реально ловит длинный микс в эфире —
#    см. monitor.py.detection-delta.md). Фингерпринтить то, что не детектится, — бессмысленно.
# Крон (после гейта):  */15 * * * * /opt/promofm-promo-check/reconcile-mix-fingerprints.sh
#
# Отличия от трекового: статус 'published' (не published/upcoming) + флаг distribute_radio
# (микс должен сам согласиться на эфир) + timeout 300 (микс длинный — watermark+fpcalc дольше).
# 23.10.2026: PATH с /usr/local/bin (там audiowmark), иначе знак не вшивается, см. трековый reconcile.
export PATH=/usr/local/bin:/usr/bin:/bin
# один прогон за раз: обработка трека теперь ~40 с (проверка знака до и после), прогон может
# пережить следующий тик крона; ручной запуск брать под тот же замок: flock /var/lock/promo-check-reconcile-mix.lock python3 fingerprinter.py …
exec 9>/var/lock/promo-check-reconcile-mix.lock
flock -n 9 || exit 0
cd /opt/promofm-promo-check || exit 1
LOG=/var/log/promo-check-reconcile-mix.log
ids=$(sudo -u postgres psql -d promofm -t -A -c "
  SELECT m.id FROM dj_mixes m
  WHERE m.moderation_status = 'published'
    AND m.distribute_radio = true
    AND m.audio_url <> '' AND m.audio_url IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM dj_mix_fingerprints f
                    WHERE f.mix_id = m.id AND f.status = 'done' AND f.watermarked_at IS NOT NULL)
  ORDER BY m.created_at DESC LIMIT 25")
[ -z "$ids" ] && exit 0
echo "[$(date '+%F %T')] reconcile-mix: $(echo "$ids" | wc -w) mix(es) need fingerprint" >> "$LOG"
for mid in $ids; do
  if timeout 300 python3 fingerprinter.py --mix-id "$mid" >> "$LOG" 2>&1; then
    echo "[$(date '+%F %T')] OK $mid" >> "$LOG"
  else
    echo "[$(date '+%F %T')] FAIL $mid" >> "$LOG"
  fi
done
