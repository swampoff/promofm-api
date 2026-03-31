#!/bin/bash
# Download YouTube clip thumbnails via external proxy
# Called after build-clips to ensure thumbnails are available locally
# YouTube CDN (i.ytimg.com) is blocked from Russian VPS

THUMBS_DIR="/var/www/promofm/html/thumbnails"
API_URL="https://promo-music.ru/server/api/videos/newClips?limit=30"

mkdir -p "$THUMBS_DIR"

# Get current clips from API
clips=$(curl -s "$API_URL" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for c in data.get('clips', []):
    vid = c.get('videoId', '')
    if vid:
        print(vid)
" 2>/dev/null)

missing=0
for vid in $clips; do
    if [ ! -f "$THUMBS_DIR/thumb_${vid}.jpg" ]; then
        missing=$((missing + 1))
        echo "Missing: $vid"
    fi
done

if [ "$missing" -gt 0 ]; then
    echo "WARNING: $missing thumbnails missing. Upload via:"
    echo "  curl -X POST https://promo-music.ru/server/api/videos/download-thumbnails \\"
    echo "    -H 'x-internal-key: KEY' -H 'Content-Type: application/json' \\"
    echo "    -d '{\"thumbnails\": [{\"videoId\": \"VID\", \"url\": \"https://i.ytimg.com/vi/VID/mqdefault.jpg\"}]}'"
else
    echo "All thumbnails present ($( echo "$clips" | wc -w | tr -d ' ') clips)"
fi
