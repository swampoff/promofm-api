"""Suno scraper v3 — uses /explore (gives 30+ tracks without login)"""
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
    page.goto('https://suno.com/explore', wait_until='domcontentloaded', timeout=60000)
    time.sleep(8)
    for _ in range(5):
        page.evaluate('window.scrollBy(0, 1200)')
        time.sleep(1.5)

    items = page.evaluate("""() => {
      const seen = new Set();
      const out = [];
      const links = Array.from(document.querySelectorAll('a[href*="/song/"]'));
      for (const a of links) {
        const m = a.href.match(/\\/song\\/([a-f0-9-]+)/);
        if (!m) continue;
        const songId = m[1];
        if (seen.has(songId)) continue;

        // Climb up MUCH higher — Suno's /explore card is ~12-15 levels up
        let card = a;
        let bestCard = a;
        for (let i = 0; i < 20; i++) {
          if (!card.parentElement) break;
          card = card.parentElement;
          const txt = card.innerText || '';
          // We want a card-sized container (200-1500 chars), not the whole page
          if (txt.length > 50 && txt.length < 800) {
            bestCard = card;
            break;
          }
        }
        const cardText = (bestCard?.innerText || '').trim();
        const img = bestCard?.querySelector('img');
        const cover = img ? (img.src || img.dataset?.src || '') : '';
        const title = (a.innerText || '').trim() || 'Untitled';

        // Artist: look for /@ link in card
        const userLink = bestCard?.querySelector('a[href*="/@"]');
        let artist = '';
        if (userLink) artist = (userLink.innerText || userLink.getAttribute('href').replace('/@', '')).trim();
        if (!artist) {
          // try @ in text
          const um = cardText.match(/@([a-zA-Z0-9_-]+)/);
          if (um) artist = um[1];
        }
        if (!artist) artist = 'unknown';

        // Numbers: extract K/M-suffixed counters
        const nums = cardText.match(/\\d+(?:\\.\\d+)?[KM]/g) || cardText.match(/\\b\\d{2,}\\b/g) || [];
        seen.add(songId);
        out.push({ songId, songUrl: a.href, title, artist, plays: nums[0]||'0', likes: nums[1]||'0', cover });
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

print(f'Parsed {len(tracks)} suno tracks')
for t in tracks[:5]:
    print(f"  - {t['title']} / {t['artist']} / plays:{t['plays']}")

internal_key = ''
for ln in open('/opt/promofm-api/.env'):
    if ln.startswith('VPS_INTERNAL_KEY='):
        internal_key = ln.split('=',1)[1].strip(); break

if tracks and internal_key:
    req = urllib.request.Request(
        'http://127.0.0.1:3000/server/api/ai-charts/manual-update',
        data=json.dumps({'sourceId': 'suno', 'tracks': tracks}).encode(),
        headers={'Content-Type': 'application/json', 'X-Internal-Key': internal_key},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print('manual-update:', r.read().decode()[:300])
    except Exception as e:
        print('upload err:', e)
