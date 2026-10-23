#!/bin/bash
# promo.check reconcile — guarantees EVERY published/upcoming track with audio
# has a 'done' fingerprint. Safety net for the upload-time trigger
# (submitTrack -> fire-and-forget POST /promo-check/process): if that one call
# fails, the track would otherwise stay permanently invisible to airplay
# detection. Also re-runs rows stuck in 'pending'/'error'. Added 2026-06-24.
#
# 23.10.2026: крон root идёт с PATH=/usr/bin:/bin, а audiowmark стоит в /usr/local/bin —
# с переезда на Арбат (07.10) знак не вшивался ни в один трек. Отсюда export PATH.
# Очередь: сначала оплаченные треки пользователей платформы, потом остальные (импорты недели),
# чтобы при LIMIT наши треки не вытеснялись. Трек без файла на диске повторяем раз в сутки.
export PATH=/usr/local/bin:/usr/bin:/bin
# один прогон за раз: обработка трека теперь ~40 с (проверка знака до и после), прогон может
# пережить следующий тик крона; ручной запуск брать под тот же замок: flock /var/lock/promo-check-reconcile.lock python3 fingerprinter.py …
exec 9>/var/lock/promo-check-reconcile.lock
flock -n 9 || exit 0
cd /opt/promofm-promo-check || exit 1
LOG=/var/log/promo-check-reconcile.log
SKIP=/var/lib/promo-check/reconcile-skip.txt   # строки «id epoch»: файл не найден, повтор через сутки
mkdir -p /var/lib/promo-check && touch "$SKIP"
now=$(date +%s)
awk -v now="$now" '$2 > now - 86400' "$SKIP" > "$SKIP.tmp" && mv "$SKIP.tmp" "$SKIP"
ids=$(sudo -u postgres psql -d promofm -t -A -c "
  SELECT t.id FROM tracks t
  WHERE t.moderation_status IN ('published','upcoming')
    AND t.audio_url <> '' AND t.audio_url IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM promo_check_fingerprints f
                    WHERE f.track_id = t.id AND f.status = 'done' AND f.watermarked_at IS NOT NULL)
  ORDER BY (COALESCE(t.payment_completed, false)
            AND EXISTS (SELECT 1 FROM users u WHERE u.id::text = t.user_id::text)) DESC,
           t.created_at DESC
  LIMIT 40")
[ -z "$ids" ] && exit 0
todo=""
for tid in $ids; do
  grep -q "^$tid " "$SKIP" || todo="$todo $tid"
done
todo=$(echo $todo | tr ' ' '\n' | head -25)
[ -z "$todo" ] && exit 0
echo "[$(date '+%F %T')] reconcile: $(echo "$todo" | wc -w) track(s) need fingerprint" >> "$LOG"
for tid in $todo; do
  out=$(timeout 150 python3 fingerprinter.py --track-id "$tid" 2>&1); rc=$?
  echo "$out" >> "$LOG"
  if [ $rc -eq 0 ]; then
    echo "[$(date '+%F %T')] OK $tid" >> "$LOG"
  else
    echo "[$(date '+%F %T')] FAIL $tid" >> "$LOG"
    echo "$out" | grep -q "Cannot resolve audio file" && echo "$tid $now" >> "$SKIP"
  fi
done
