#!/bin/bash
# Скачивает миниатюры YouTube-клипов с главной (newClips) в THUMBS_DIR.
# i.ytimg.com с российского VPS недоступен → через форвард-прокси Soul FM (OPENROUTER_PROXY в .env).
# Крон: после videos-agent (пн/сб 07:15) + ежедневно 09:15. Безопасно запускать вручную.
set -u
THUMBS_DIR="/var/www/promofm/html/thumbnails"
API_URL="https://promo-music.ru/server/api/videos/newClips?limit=40"
PROXY="$(grep -oP '^OPENROUTER_PROXY=\K.*' /opt/promofm-api/.env 2>/dev/null | tr -d '"' )"
mkdir -p "$THUMBS_DIR"
clips=$(curl -s -m 20 "$API_URL" | python3 -c '
import sys, json, re
try: data = json.load(sys.stdin)
except Exception: sys.exit(0)
for c in data.get("clips", []):
    vid = str(c.get("videoId") or "")
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid): print(vid)
')
ok=0; miss=0; fail=0
for vid in $clips; do
  f="$THUMBS_DIR/thumb_${vid}.jpg"
  [ -s "$f" ] && { ok=$((ok+1)); continue; }
  miss=$((miss+1))
  for q in mqdefault hqdefault default; do
    curl -s -m 20 ${PROXY:+-x "$PROXY"} -o "$f.tmp" "https://i.ytimg.com/vi/${vid}/${q}.jpg" || true
    if [ -s "$f.tmp" ] && file -b --mime-type "$f.tmp" | grep -q '^image/jpeg$' && [ "$(stat -c %s "$f.tmp")" -lt 524288 ]; then mv "$f.tmp" "$f"; chmod 644 "$f"; ok=$((ok+1)); break; fi
    rm -f "$f.tmp"
  done
  [ -s "$f" ] || { fail=$((fail+1)); echo "не скачалась: $vid"; }
done
echo "$(date '+%F %T') clips=$(echo "$clips" | wc -w | tr -d ' ') есть=$ok скачивали=$miss ошибок=$fail"
