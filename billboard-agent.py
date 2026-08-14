#!/usr/bin/env python3
"""
BILLBOARD HOT 100 — еженедельный парсер для главной страницы.

Владелец 2026-08-14: «добавим на главную чарт Billboard HOT 100, куда будем
парсить всю сотню каждую неделю».

Детерминированный разбор HTML, без ИИ — как и остальные наши парсеры
чартов. Billboard доступен с VPS напрямую (проверено 2026-08-14), прокси
не нужен.

Результат кладётся в platform_stats.id = 'chart:billboard_hot100'.
Прошлый чарт НЕ затирается вслепую: если разбор дал меньше 90 позиций,
считаем это поломкой вёрстки и сохраняем предыдущие данные.
"""
import re
import sys
import json
import html as ht
import logging
from datetime import datetime, timezone

import psycopg2

logging.basicConfig(level=logging.INFO, format="%(asctime)s [Billboard] %(message)s")
log = logging.getLogger()

URL = "https://www.billboard.com/charts/hot-100/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
KEY = "chart:billboard_hot100"
MIN_ROWS = 90


def strip_tags(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


def fetch() -> str:
    import urllib.request
    req = urllib.request.Request(URL, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8", "ignore")


def parse_date(page: str) -> str:
    for pat in (r'chart-date-picker[^>]*data-date="([^"]+)"', r'"chartDate"\s*:\s*"([^"]+)"'):
        m = re.search(pat, page)
        if m:
            return m.group(1)
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def parse_rows(page: str) -> list[dict]:
    out = []
    for b in page.split("o-chart-results-list-row-container")[1:]:
        m_title = re.search(r'<h3[^>]*id="title-of-a-story"[^>]*>(.*?)</h3>', b, re.S)
        if not m_title:
            continue
        title = ht.unescape(strip_tags(m_title.group(1)))
        after = b[m_title.end():]
        spans = [ht.unescape(strip_tags(x)) for x in
                 re.findall(r'<span[^>]*class="[^"]*c-label[^"]*"[^>]*>(.*?)</span>', after, re.S)]
        spans = [s for s in spans if s]
        if not title or not spans:
            continue
        artist = spans[0]
        nums = re.findall(r'<span[^>]*class="[^"]*c-label[^"]*"[^>]*>\s*(\d+)\s*</span>',
                          b[:m_title.start()], re.S)
        pos = int(nums[-1]) if nums else len(out) + 1
        stats = [s for s in spans[1:] if re.fullmatch(r"[\d-]+", s)]
        prev = stats[0] if len(stats) > 0 else ""
        out.append({
            "position": pos,
            "title": title,
            "artist": artist,
            "lastWeek": prev,
            "peak": stats[1] if len(stats) > 1 else "",
            "weeksOnChart": stats[2] if len(stats) > 2 else "",
            # тренд считаем сами: показывать «-» посетителю бессмысленно
            "trend": ("new" if prev in ("", "-") else
                      "up" if prev.isdigit() and int(prev) > pos else
                      "down" if prev.isdigit() and int(prev) < pos else "same"),
        })
    out.sort(key=lambda x: x["position"])
    return out


# Тот же DSN, что у агента чартов: под ролью приложения, не под postgres.
DB_DSN = "postgresql://promofm_app:PromoFM2024dbSecure@127.0.0.1:5432/promofm"


def db():
    return psycopg2.connect(DB_DSN)


def main() -> int:
    page = fetch()
    rows = parse_rows(page)
    chart_date = parse_date(page)
    log.info(f"Разобрано позиций: {len(rows)}, дата чарта {chart_date}")

    if len(rows) < MIN_ROWS:
        log.error(f"Слишком мало позиций ({len(rows)} < {MIN_ROWS}) — вёрстка изменилась. "
                  f"Прошлый чарт оставлен без изменений.")
        return 1

    payload = {
        "source": "Billboard Hot 100",
        "chartDate": chart_date,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "entries": rows,
    }
    conn = db()
    with conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO platform_stats (id, data, updated_at)
               VALUES (%s, %s::jsonb, now())
               ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()""",
            (KEY, json.dumps(payload, ensure_ascii=False)),
        )
    conn.close()
    log.info(f"Сохранено {len(rows)} позиций в {KEY}")
    log.info(f"  #1 {rows[0]['title']} — {rows[0]['artist']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
