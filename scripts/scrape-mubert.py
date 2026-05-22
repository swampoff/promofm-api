"""Mubert scraper — DOM-based from https://mubert.com/listen/ (charts/trending)"""
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
    page = b.new_page()
    try:
        # Mubert main listen page — features playlists + tracks
        page.goto('https://mubert.com/listen/playlists', wait_until='domcontentloaded', timeout=60000)
        time.sleep(8)
        for _ in range(5):
            page.evaluate('window.scrollBy(0, 1200)')
            time.sleep(1.5)
    except Exception as e:
        print('mubert nav err:', e)

    items = page.evaluate('''() => {
      const seen = new Set();
      const out = [];
      // Mubert uses /listen/track/{id} or /listen/playlist/{id}
      const links = Array.from(document.querySelectorAll('a[href*="/listen/track"], a[href*="/listen/playlist"]'));
      for (const a of links) {
        const id = a.href.split('/').pop().split('?')[0];
        if (!id || seen.has(id)) continue;
        let card = a;
        for (let i = 0; i < 10; i++) {
          if (card.parentElement) card = card.parentElement; else break;
          const txt = card.innerText || '';
          if (txt.length > 20 && txt.length < 600) break;
        }
        const ctxt = (card?.innerText || '').trim();
        const img = card?.querySelector('img');
        const cover = img ? (img.src || img.dataset?.src || '') : '';
        let title = (a.innerText || a.getAttribute('title') || '').trim();
        if (!title) title = (card?.querySelector('h2,h3,h4,[class*="title"]')?.innerText || '').trim();
        let artist = 'Mubert AI';
        const auth = card?.querySelector('[class*="author"], [class*="artist"], [class*="creator"]');
        if (auth) artist = (auth.innerText || 'Mubert AI').trim();
        const nums = ctxt.match(/\\d+(?:\\.\\d+)?[KM]?/g) || [];
        seen.add(id);
        out.push({ songId: id, songUrl: a.href, title, artist, plays: nums[0]||'', likes: nums[1]||'', cover });
        if (out.length >= 30) break;
      }
      return out;
    }''')
    b.close()

for it in items:
    if not it['title']: continue
    if len(it['title']) > 200: continue
    tracks.append({
        'title': it['title'][:200],
        'artist': (it['artist'] or 'Mubert AI')[:80],
        'plays': parse_num(it['plays']),
        'likes': parse_num(it['likes']),
        'cover': it['cover'] or None,
        'url': it['songUrl'],
    })

print(f'Mubert parsed: {len(tracks)} tracks')
for t in tracks[:5]:
    print('  -', t['title'], '/', t['artist'])

internal_key = ''
for ln in open('/opt/promofm-api/.env'):
    if ln.startswith('VPS_INTERNAL_KEY='):
        internal_key = ln.split('=',1)[1].strip(); break

if tracks and internal_key:
    req = urllib.request.Request(
        'http://127.0.0.1:3000/server/api/ai-charts/manual-update',
        data=json.dumps({'sourceId': 'mubert', 'tracks': tracks}).encode(),
        headers={'Content-Type': 'application/json', 'X-Internal-Key': internal_key},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print('manual-update:', r.read().decode()[:300])
    except Exception as e:
        print('upload err:', e)
