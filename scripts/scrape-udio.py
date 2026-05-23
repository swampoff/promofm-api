"""Udio v2 — uses root URL (gives 6 songs to guests)"""
from playwright.sync_api import sync_playwright
import re, json, urllib.request, time

def parse_num(s):
    s = (s or '').strip().upper().replace(',', '.')
    m = re.match(r'^([\d.]+)\s*([KM])?', s)
    if not m: return 0
    v = float(m.group(1))
    if m.group(2) == 'K': v *= 1000
    elif m.group(2) == 'M': v *= 1_000_000
    return int(v)

tracks = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1400, "height": 900})
    page.goto('https://www.udio.com/', wait_until='domcontentloaded', timeout=60000)
    time.sleep(8)
    for _ in range(4):
        page.evaluate('window.scrollBy(0, 1200)'); time.sleep(1.5)

    items = page.evaluate("""() => {
      const seen = new Set();
      const out = [];
      const links = Array.from(document.querySelectorAll('a[href*="/songs/"]'));
      for (const a of links) {
        const m = a.href.match(/\\/songs\\/([a-zA-Z0-9_-]+)/);
        if (!m) continue;
        if (seen.has(m[1])) continue;
        let card = a;
        let bestCard = a;
        for (let i = 0; i < 15; i++) {
          if (!card.parentElement) break;
          card = card.parentElement;
          const txt = card.innerText || '';
          if (txt.length > 30 && txt.length < 600) { bestCard = card; break; }
        }
        const cardText = (bestCard?.innerText || '').trim();
        const img = bestCard?.querySelector('img');
        const cover = img ? (img.src || img.dataset?.src || '') : '';
        // Format observed: "Artist - Title"
        const rawText = (a.innerText || '').trim();
        let title = rawText, artist = '';
        const dash = rawText.indexOf(' - ');
        if (dash > 0) {
          artist = rawText.slice(0, dash).trim();
          title = rawText.slice(dash + 3).trim();
        }
        if (!artist) {
          const userLink = bestCard?.querySelector('a[href*="/creators/"], a[href*="/user/"]');
          if (userLink) artist = (userLink.innerText || '').trim();
        }
        if (!artist) artist = 'unknown';
        const nums = cardText.match(/\\d+(?:\\.\\d+)?[KM]/g) || [];
        seen.add(m[1]);
        out.push({ songId: m[1], songUrl: a.href, title: title || rawText || 'Untitled', artist, plays: nums[0]||'0', likes: nums[1]||'0', cover });
        if (out.length >= 30) break;
      }
      return out;
    }""")
    b.close()

for it in items:
    if not it['title'] or it['title'] == 'Untitled': continue
    if len(it['title']) > 200: continue
    tracks.append({
        'title': it['title'][:200],
        'artist': it['artist'][:80].lstrip('@'),
        'plays': parse_num(it['plays']),
        'likes': parse_num(it['likes']),
        'cover': it['cover'] or None,
        'url': it['songUrl'],
    })

print(f'Udio parsed: {len(tracks)} tracks')
for t in tracks[:5]:
    print(f"  - {t['title']} / {t['artist']}")

internal_key = ''
for ln in open('/opt/promofm-api/.env'):
    if ln.startswith('VPS_INTERNAL_KEY='):
        internal_key = ln.split('=',1)[1].strip(); break

if tracks and internal_key:
    req = urllib.request.Request(
        'http://127.0.0.1:3000/server/api/ai-charts/manual-update',
        data=json.dumps({'sourceId': 'udio', 'tracks': tracks}).encode(),
        headers={'Content-Type': 'application/json', 'X-Internal-Key': internal_key},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print('manual-update:', r.read().decode()[:300])
    except Exception as e:
        print('upload err:', e)
