#!/bin/bash
# promo.check reconcile — guarantees EVERY published/upcoming track with audio
# has a 'done' fingerprint. Safety net for the upload-time trigger
# (submitTrack -> fire-and-forget POST /promo-check/process): if that one call
# fails, the track would otherwise stay permanently invisible to airplay
# detection. Also re-runs rows stuck in 'pending'/'error'. Added 2026-06-24.
cd /opt/promofm-promo-check || exit 1
LOG=/var/log/promo-check-reconcile.log
ids=$(sudo -u postgres psql -d promofm -t -A -c "
  SELECT t.id FROM tracks t
  WHERE t.moderation_status IN ('published','upcoming')
    AND t.audio_url <> '' AND t.audio_url IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM promo_check_fingerprints f
                    WHERE f.track_id = t.id AND f.status = 'done' AND f.watermarked_at IS NOT NULL)
  ORDER BY t.created_at DESC LIMIT 25")
[ -z "$ids" ] && exit 0
echo "[$(date '+%F %T')] reconcile: $(echo "$ids" | wc -w) track(s) need fingerprint" >> "$LOG"
for tid in $ids; do
  if timeout 150 python3 fingerprinter.py --track-id "$tid" >> "$LOG" 2>&1; then
    echo "[$(date '+%F %T')] OK $tid" >> "$LOG"
  else
    echo "[$(date '+%F %T')] FAIL $tid" >> "$LOG"
  fi
done
