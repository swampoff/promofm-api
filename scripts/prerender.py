#!/usr/bin/env python3
"""
Prerender public pages for SEO bots.
Renders SPA pages via Playwright and saves static HTML snapshots.
Run via cron every 6 hours or after deploy.
"""
import asyncio
import sys
import time
from pathlib import Path

PAGES = [
    "/",
    "/news",
    "/charts",
    "/concerts",
    "/for-artists",
    "/radio-stations",
    "/about",
    "/contact",
    "/marketplace",
]

DOMAIN = "https://promo-music.ru"
OUTPUT_DIR = Path("/var/www/promofm/prerender")
TIMEOUT = 30000


def path_to_filename(path):
    if path == "/":
        return "index.html"
    return path.strip("/").replace("/", "_") + ".html"


async def render_page(page, url, output_path):
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT)
        await page.wait_for_timeout(5000)

        try:
            await page.wait_for_selector("h1, h2, section, main", timeout=10000)
        except:
            pass

        await page.evaluate("""() => {
            document.querySelectorAll('script').forEach(s => s.remove());
            document.querySelectorAll('[class*="cookie"]').forEach(el => el.remove());
            const fixed = document.querySelectorAll('[class*="fixed"]');
            fixed.forEach(el => {
                const t = el.textContent || '';
                if (t.indexOf('тестовом') !== -1) el.remove();
            });
        }""")

        html = await page.content()
        html = html.replace(
            "</head>",
            '<link rel="canonical" href="' + url + '" />\n'
            '<meta name="generator" content="promofm-prerender" />\n'
            "</head>"
        )

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(html, encoding="utf-8")
        size_kb = len(html) / 1024
        print(f"  OK  {url} -> {output_path.name} ({size_kb:.1f} KB)")
        return True
    except Exception as e:
        print(f"  FAIL {url}: {e}")
        return False


async def main():
    from playwright.async_api import async_playwright

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    start = time.time()

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent="Mozilla/5.0 (compatible; PromoFM-Prerender/1.0)"
        )
        page = await context.new_page()

        success = 0
        total = len(PAGES)

        for path in PAGES:
            url = f"{DOMAIN}{path}"
            output_path = OUTPUT_DIR / path_to_filename(path)
            if await render_page(page, url, output_path):
                success += 1

        await browser.close()

    elapsed = time.time() - start
    print(f"\nPrerender complete: {success}/{total} pages in {elapsed:.1f}s")
    print(f"Output: {OUTPUT_DIR}")

    if success < total:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
