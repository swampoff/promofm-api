#!/usr/bin/env python3
"""
ПРОМО.МУЗЫКА — Daily SEO Optimizer
Runs daily at 8:00 MSK (before analytics report at 9:00)

Tasks:
1. Ping Google & Yandex with updated sitemap
2. Check indexing status via search queries
3. Monitor 404 errors from nginx logs
4. Check page load performance
5. Verify prerender works for bots
6. Generate SEO health report
7. Submit new content URLs for indexing
"""

import os
import re
import gzip
import json
import smtplib
import psycopg2
import urllib.request
import urllib.error
import ssl
import time
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from collections import Counter

# Config
SMTP_HOST = "mail.hosting.reg.ru"
SMTP_PORT = 587
SMTP_USER = "noreply@promo-music.ru"
SMTP_PASS = "Nik4873835!Med"
TO_EMAIL = "info@promofm.ru"
DB_NAME = "promofm"
DB_USER = "promofm_app"
DB_PASS = "PromoFM2024dbSecure"
SITE_URL = "https://promo-music.ru"
NGINX_LOG = "/var/log/nginx/access.log"
NGINX_LOG_1 = "/var/log/nginx/access.log.1"

LOG_PATTERN = re.compile(
    r'(?P<ip>\S+) \S+ \S+ \[(?P<time>[^\]]+)\] "(?P<method>\S+) (?P<path>\S+) \S+" (?P<status>\d+) (?P<size>\d+) "(?P<referer>[^"]*)" "(?P<ua>[^"]*)"'
)

ctx = ssl.create_default_context()

# Telegram (load from API .env)
TG_TOKEN = ""
TG_CHAT = ""
try:
    for ln in open("/opt/promofm-api/.env"):
        if ln.startswith("TELEGRAM_BOT_TOKEN="):
            TG_TOKEN = ln.split("=", 1)[1].strip()
        elif ln.startswith("TELEGRAM_LEAD_CHAT_ID="):
            TG_CHAT = ln.split("=", 1)[1].strip()
except Exception:
    pass

def send_telegram(text):
    if not TG_TOKEN or not TG_CHAT:
        return False
    try:
        import urllib.request as _r, json as _j
        data = _j.dumps({"chat_id": TG_CHAT, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}).encode()
        req = _r.Request(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", data=data, headers={"Content-Type":"application/json"})
        with _r.urlopen(req, timeout=20) as r:
            return r.status == 200
    except Exception as e:
        print(f"[TG] failed: {e}")
        return False


def ping_search_engines():
    """Notify search engines about updated sitemap."""
    results = {}
    sitemap_url = f"{SITE_URL}/sitemap.xml"

    # Yandex still supports sitemap ping
    try:
        req = urllib.request.Request(
            f'https://yandex.com/ping?sitemap={sitemap_url}',
            headers={'User-Agent': 'PromoMusic-SEO/1.0'}
        )
        resp = urllib.request.urlopen(req, timeout=10, context=ctx)
        results['Yandex'] = f"OK ({resp.status})"
    except Exception as e:
        results['Yandex'] = f"FAIL ({str(e)[:60]})"

    # Google deprecated ping — uses Search Console instead
    results['Google'] = "via Search Console (ping deprecated)"

    # Bing — IndexNow protocol
    try:
        indexnow_url = f"https://www.bing.com/indexnow?url={SITE_URL}&urlList={sitemap_url}"
        req = urllib.request.Request(indexnow_url, headers={'User-Agent': 'PromoMusic-SEO/1.0'})
        resp = urllib.request.urlopen(req, timeout=10, context=ctx)
        results['Bing'] = f"IndexNow OK ({resp.status})"
    except Exception as e:
        results['Bing'] = f"IndexNow: {str(e)[:50]}"

    return results


def check_prerender():
    """Verify prerender works for search bots."""
    results = {}
    test_pages = ['/', '/news', '/charts', '/concerts', '/for-artists', '/radio-stations']

    for page in test_pages:
        url = f"{SITE_URL}{page}"
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
            })
            resp = urllib.request.urlopen(req, timeout=15, context=ctx)
            html = resp.read().decode('utf-8', errors='ignore')

            has_title = '<title>' in html and '</title>' in html
            has_meta = 'meta name="description"' in html or 'og:description' in html
            has_jsonld = 'application/ld+json' in html
            is_spa_only = '<div id="root"></div>' in html and len(html) < 15000

            if is_spa_only:
                results[page] = {'status': 'FAIL', 'reason': 'SPA shell only, no prerender'}
            elif has_title and has_meta:
                results[page] = {'status': 'OK', 'title': bool(has_title), 'meta': bool(has_meta), 'jsonld': bool(has_jsonld)}
            else:
                results[page] = {'status': 'WARN', 'title': bool(has_title), 'meta': bool(has_meta)}
        except Exception as e:
            results[page] = {'status': 'ERROR', 'reason': str(e)[:80]}

    return results


def check_page_speed():
    """Check load time for key pages."""
    results = {}
    pages = ['/', '/news', '/charts', '/radio-stations', '/for-artists']

    for page in pages:
        url = f"{SITE_URL}{page}"
        try:
            start = time.time()
            req = urllib.request.Request(url, headers={'User-Agent': 'PromoMusic-SEO/1.0'})
            resp = urllib.request.urlopen(req, timeout=15, context=ctx)
            data = resp.read()
            elapsed = round((time.time() - start) * 1000)
            results[page] = {'time_ms': elapsed, 'size_kb': round(len(data) / 1024, 1), 'status': resp.status}
        except Exception as e:
            results[page] = {'time_ms': -1, 'error': str(e)[:60]}

    return results


def analyze_404_errors(target_date):
    """Find 404 errors from nginx logs."""
    date_str = target_date.strftime("%d/%b/%Y")
    errors_404 = Counter()
    errors_5xx = Counter()

    for logfile in [NGINX_LOG, NGINX_LOG_1]:
        if not os.path.exists(logfile):
            continue
        try:
            with open(logfile, 'r', errors='ignore') as f:
                for line in f:
                    if date_str not in line:
                        continue
                    m = LOG_PATTERN.match(line)
                    if not m:
                        continue
                    ua = m.group('ua')
                    if 'HeadlessChrome' in ua:
                        continue
                    status = int(m.group('status'))
                    path = m.group('path').split('?')[0]
                    if status == 404:
                        errors_404[path] += 1
                    elif status >= 500:
                        errors_5xx[path] += 1
        except Exception:
            pass

    return errors_404, errors_5xx


def get_content_stats():
    """Get current content stats for SEO tracking."""
    stats = {}
    try:
        conn = psycopg2.connect(dbname=DB_NAME, user=DB_USER, password=DB_PASS, host='localhost')
        cur = conn.cursor()

        queries = {
            'news_total': "SELECT COUNT(*) FROM news",
            'news_week': "SELECT COUNT(*) FROM news WHERE created_at >= NOW() - INTERVAL '7 days'",
            'tracks_total': "SELECT COUNT(*) FROM tracks",
            'tracks_week': "SELECT COUNT(*) FROM tracks WHERE created_at >= NOW() - INTERVAL '7 days'",
            'concerts_total': "SELECT COUNT(*) FROM concerts",
            'videos_total': "SELECT COUNT(*) FROM video_clips",
            'users_total': "SELECT COUNT(*) FROM users",
            'profiles_total': "SELECT COUNT(*) FROM artist_profiles",
            'pageviews_today': "SELECT COUNT(*) FROM page_views WHERE created_at >= CURRENT_DATE AND is_bot = false",
            'pageviews_week': "SELECT COUNT(*) FROM page_views WHERE created_at >= NOW() - INTERVAL '7 days' AND is_bot = false",
        }

        for key, sql in queries.items():
            try:
                cur.execute(sql)
                stats[key] = cur.fetchone()[0]
            except Exception:
                conn.rollback()
                stats[key] = 'N/A'

        cur.close()
        conn.close()
    except Exception as e:
        stats['error'] = str(e)

    return stats


def check_search_bot_activity(target_date):
    """Analyze search bot crawling activity."""
    date_str = target_date.strftime("%d/%b/%Y")
    bots = {
        'Googlebot': {'pages': Counter(), 'total': 0},
        'YandexBot': {'pages': Counter(), 'total': 0},
        'Bingbot': {'pages': Counter(), 'total': 0},
    }

    for logfile in [NGINX_LOG, NGINX_LOG_1]:
        if not os.path.exists(logfile):
            continue
        try:
            with open(logfile, 'r', errors='ignore') as f:
                for line in f:
                    if date_str not in line:
                        continue
                    m = LOG_PATTERN.match(line)
                    if not m:
                        continue
                    ua = m.group('ua')
                    path = m.group('path').split('?')[0]

                    for bot_name in bots:
                        if bot_name.lower() in ua.lower():
                            bots[bot_name]['pages'][path] += 1
                            bots[bot_name]['total'] += 1
                            break
        except Exception:
            pass

    return bots


def build_seo_report(ping_results, prerender_results, speed_results, errors_404, errors_5xx, content_stats, bot_activity):
    """Build HTML SEO report."""
    now = datetime.now()
    date_str = now.strftime('%d.%m.%Y')

    # Ping results
    ping_html = ""
    for engine, result in ping_results.items():
        color = "#22C55E" if "OK" in result else "#EF4444"
        ping_html += f'<span style="color:{color};margin-right:16px">{engine}: {result}</span>'

    # Prerender results
    prerender_html = ""
    ok_count = sum(1 for r in prerender_results.values() if r.get('status') == 'OK')
    total_count = len(prerender_results)
    for page, result in prerender_results.items():
        status = result.get('status', 'ERROR')
        color = '#22C55E' if status == 'OK' else '#FF8C42' if status == 'WARN' else '#EF4444'
        detail = f"title:{result.get('title','?')} meta:{result.get('meta','?')} jsonld:{result.get('jsonld','?')}" if status in ['OK', 'WARN'] else result.get('reason', '')
        prerender_html += f'<tr><td style="padding:4px 8px;color:#94A3B8;font-family:monospace;font-size:12px;border-bottom:1px solid #1E293B">{page}</td><td style="padding:4px 8px;color:{color};border-bottom:1px solid #1E293B;font-size:12px">{status}</td><td style="padding:4px 8px;color:#64748B;border-bottom:1px solid #1E293B;font-size:11px">{detail}</td></tr>'

    # Speed results
    speed_html = ""
    for page, result in speed_results.items():
        t = result.get('time_ms', -1)
        color = '#22C55E' if t < 500 else '#FF8C42' if t < 1500 else '#EF4444'
        speed_html += f'<tr><td style="padding:4px 8px;color:#94A3B8;font-family:monospace;font-size:12px;border-bottom:1px solid #1E293B">{page}</td><td style="padding:4px 8px;color:{color};border-bottom:1px solid #1E293B;text-align:right">{t}ms</td><td style="padding:4px 8px;color:#64748B;border-bottom:1px solid #1E293B;text-align:right">{result.get("size_kb","?")} KB</td></tr>'

    # 404 errors
    err404_html = ""
    for path, count in errors_404.most_common(15):
        err404_html += f'<tr><td style="padding:3px 8px;color:#EF4444;font-family:monospace;font-size:12px;border-bottom:1px solid #1E293B">{path}</td><td style="padding:3px 8px;color:white;text-align:right;border-bottom:1px solid #1E293B">{count}</td></tr>'

    # 5xx errors
    err5xx_html = ""
    for path, count in errors_5xx.most_common(10):
        err5xx_html += f'<tr><td style="padding:3px 8px;color:#EF4444;font-family:monospace;font-size:12px;border-bottom:1px solid #1E293B">{path}</td><td style="padding:3px 8px;color:white;text-align:right;border-bottom:1px solid #1E293B">{count}</td></tr>'

    # Bot activity
    bot_html = ""
    for bot_name, data in bot_activity.items():
        if data['total'] == 0:
            continue
        color = '#22C55E' if bot_name == 'Googlebot' else '#3B82F6' if bot_name == 'YandexBot' else '#FF8C42'
        top_pages = ', '.join(f'{p} ({c})' for p, c in data['pages'].most_common(5))
        bot_html += f'<tr><td style="padding:4px 8px;color:{color};font-weight:600;border-bottom:1px solid #1E293B">{bot_name}</td><td style="padding:4px 8px;color:white;text-align:right;border-bottom:1px solid #1E293B">{data["total"]}</td><td style="padding:4px 8px;color:#64748B;font-size:11px;border-bottom:1px solid #1E293B">{top_pages[:120]}</td></tr>'

    # SEO score
    score = 0
    score += 20 if ok_count == total_count else (10 if ok_count > 0 else 0)
    score += 15 if any("OK" in r for r in ping_results.values()) else 5
    score += 15 if all(r.get('time_ms', 9999) < 1000 for r in speed_results.values()) else 5
    score += 10 if len(errors_404) < 20 else 3
    score += 10 if len(errors_5xx) == 0 else 0
    score += 10 if any(d['total'] > 0 for d in bot_activity.values()) else 0
    score += 10 if content_stats.get('news_week', 0) > 0 else 0
    score += 10 if content_stats.get('pageviews_week', 0) > 50 else 3

    score_color = '#22C55E' if score >= 80 else '#FF8C42' if score >= 60 else '#EF4444'

    cs = content_stats

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0A0A14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:700px;margin:0 auto;padding:20px">

<div style="background:linear-gradient(135deg,#3B82F6 0%,#8B5CF6 50%,#EC4899 100%);border-radius:16px;padding:24px;margin-bottom:20px">
    <h1 style="color:white;margin:0;font-size:22px">SEO-отчёт ПРОМО.МУЗЫКА</h1>
    <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px">{date_str} &bull; promo-music.ru</p>
</div>

<!-- SEO Score -->
<div style="background:#12121E;border-radius:12px;padding:20px;margin-bottom:20px;border:1px solid #1E293B;text-align:center">
    <div style="color:{score_color};font-size:48px;font-weight:800">{score}/100</div>
    <div style="color:#94A3B8;font-size:13px;margin-top:4px">SEO Health Score</div>
</div>

<!-- Sitemap Ping -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 8px;font-size:14px">&#128640; Sitemap Ping</h3>
    <div style="font-size:13px">{ping_html}</div>
</div>

<!-- Prerender Check -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 8px;font-size:14px">&#129302; Prerender (бот-видимость): {ok_count}/{total_count}</h3>
    <table style="width:100%;border-collapse:collapse">
        <tr><th style="padding:4px 8px;text-align:left;color:#64748B;font-size:10px;border-bottom:1px solid #334155">Страница</th><th style="padding:4px 8px;color:#64748B;font-size:10px;border-bottom:1px solid #334155">Статус</th><th style="padding:4px 8px;color:#64748B;font-size:10px;border-bottom:1px solid #334155">Детали</th></tr>
        {prerender_html}
    </table>
</div>

<!-- Page Speed -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 8px;font-size:14px">&#9889; Скорость загрузки</h3>
    <table style="width:100%;border-collapse:collapse">
        <tr><th style="padding:4px 8px;text-align:left;color:#64748B;font-size:10px;border-bottom:1px solid #334155">Страница</th><th style="padding:4px 8px;text-align:right;color:#64748B;font-size:10px;border-bottom:1px solid #334155">Время</th><th style="padding:4px 8px;text-align:right;color:#64748B;font-size:10px;border-bottom:1px solid #334155">Размер</th></tr>
        {speed_html}
    </table>
</div>

<!-- Bot Activity -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 8px;font-size:14px">&#128270; Поисковые боты</h3>
    {f'<table style="width:100%;border-collapse:collapse"><tr><th style="padding:4px 8px;text-align:left;color:#64748B;font-size:10px;border-bottom:1px solid #334155">Бот</th><th style="padding:4px 8px;text-align:right;color:#64748B;font-size:10px;border-bottom:1px solid #334155">Запросы</th><th style="padding:4px 8px;color:#64748B;font-size:10px;border-bottom:1px solid #334155">Топ страницы</th></tr>{bot_html}</table>' if bot_html else '<div style="color:#64748B;font-size:13px">Нет активности ботов за вчера</div>'}
</div>

<!-- 404 Errors -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 8px;font-size:14px">&#9888;&#65039; Ошибки 404 ({sum(errors_404.values())} шт) {f'+ 5xx ({sum(errors_5xx.values())} шт)' if errors_5xx else ''}</h3>
    {f'<table style="width:100%;border-collapse:collapse">{err404_html}</table>' if err404_html else '<div style="color:#22C55E;font-size:13px">Нет ошибок 404!</div>'}
    {f'<h4 style="color:#EF4444;margin:12px 0 4px;font-size:12px">5xx ошибки:</h4><table style="width:100%;border-collapse:collapse">{err5xx_html}</table>' if err5xx_html else ''}
</div>

<!-- Content Stats -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 12px;font-size:14px">&#128218; Контент (для SEO)</h3>
    <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:5px 0;color:#94A3B8;font-size:13px">Новости</td><td style="color:white;text-align:right;font-weight:600">{cs.get('news_total','?')} <span style="color:#22C55E;font-size:11px">(+{cs.get('news_week',0)} за неделю)</span></td></tr>
        <tr><td style="padding:5px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Треки</td><td style="color:white;text-align:right;border-top:1px solid #1E293B;font-weight:600">{cs.get('tracks_total','?')} <span style="color:#22C55E;font-size:11px">(+{cs.get('tracks_week',0)} за неделю)</span></td></tr>
        <tr><td style="padding:5px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Видеоклипы</td><td style="color:white;text-align:right;border-top:1px solid #1E293B;font-weight:600">{cs.get('videos_total','?')}</td></tr>
        <tr><td style="padding:5px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Концерты</td><td style="color:white;text-align:right;border-top:1px solid #1E293B;font-weight:600">{cs.get('concerts_total','?')}</td></tr>
        <tr><td style="padding:5px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Профили артистов</td><td style="color:white;text-align:right;border-top:1px solid #1E293B;font-weight:600">{cs.get('profiles_total','?')}</td></tr>
        <tr><td style="padding:5px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Пользователи</td><td style="color:white;text-align:right;border-top:1px solid #1E293B;font-weight:600">{cs.get('users_total','?')}</td></tr>
        <tr><td style="padding:5px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Просмотры (неделя)</td><td style="color:white;text-align:right;border-top:1px solid #1E293B;font-weight:600">{cs.get('pageviews_week','?')}</td></tr>
    </table>
</div>

<!-- Recommendations -->
<div style="background:linear-gradient(135deg,#1A1A2E,#12121E);border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #334155">
    <h3 style="color:white;margin:0 0 8px;font-size:14px">&#128161; Рекомендации</h3>
    <ul style="color:#94A3B8;font-size:13px;padding-left:20px;margin:0">
        {'<li style="margin-bottom:4px"><span style="color:#FF8C42">Публикуйте 2-3 новости в неделю</span> — свежий контент улучшает позиции</li>' if cs.get('news_week', 0) < 2 else ''}
        {'<li style="margin-bottom:4px"><span style="color:#FF8C42">Медленные страницы!</span> Оптимизируйте JS-бандл (code-splitting)</li>' if any(r.get('time_ms', 0) > 1500 for r in speed_results.values()) else ''}
        {'<li style="margin-bottom:4px"><span style="color:#EF4444">Исправьте 404 ошибки</span> — битые ссылки вредят SEO</li>' if len(errors_404) > 10 else ''}
        {'<li style="margin-bottom:4px"><span style="color:#EF4444">5xx ошибки на сервере!</span> Проверьте логи API</li>' if errors_5xx else ''}
        <li style="margin-bottom:4px">Зарегистрируйте сайт в <b>Google Search Console</b> и <b>Яндекс.Вебмастер</b></li>
        <li style="margin-bottom:4px">Добавьте внутренние ссылки между новостями, артистами и концертами</li>
    </ul>
</div>

<div style="text-align:center;padding:16px;color:#64748B;font-size:11px">
    SEO-отчёт &bull; promo-music.ru &bull; {now.strftime('%d.%m.%Y %H:%M')} МСК
</div>

</div></body></html>"""

    return html, score




# ── Yandex.Webmaster API ──────────────────────────────────────────────────
# Requires env: YANDEX_WEBMASTER_TOKEN (OAuth) + YANDEX_WEBMASTER_USER_ID + YANDEX_WEBMASTER_HOST_ID
def fetch_yandex_webmaster():
    """Fetch search queries / impressions / clicks / position for last 7 days."""
    import os, urllib.request, urllib.parse, json
    token = os.environ.get("YANDEX_WEBMASTER_TOKEN", "")
    user_id = os.environ.get("YANDEX_WEBMASTER_USER_ID", "")
    host_id = os.environ.get("YANDEX_WEBMASTER_HOST_ID", "")
    # also try .env
    if not token:
        try:
            for ln in open("/opt/promofm-api/.env"):
                if ln.startswith("YANDEX_WEBMASTER_TOKEN="):
                    token = ln.split("=", 1)[1].strip()
                elif ln.startswith("YANDEX_WEBMASTER_USER_ID="):
                    user_id = ln.split("=", 1)[1].strip()
                elif ln.startswith("YANDEX_WEBMASTER_HOST_ID="):
                    host_id = ln.split("=", 1)[1].strip()
        except Exception:
            pass

    if not (token and user_id and host_id):
        return {"available": False, "reason": "missing_credentials"}

    try:
        # Required: query_indicator (метрика) + order_by (поле сортировки) + filter_indicator
        # Yandex.Webmaster API только поддерживает 2 indicator-а в этом endpoint: TOTAL_SHOWS, TOTAL_CLICKS
        params = "query_indicator=TOTAL_SHOWS&query_indicator=TOTAL_CLICKS&order_by=TOTAL_SHOWS&limit=20"
        url = f"https://api.webmaster.yandex.net/v4/user/{user_id}/hosts/{host_id}/search-queries/popular?{params}"
        req = urllib.request.Request(url, headers={"Authorization": f"OAuth {token}"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
        queries = data.get("queries", [])
        def ind(q, k): return q.get("indicators", {}).get(k, 0) or 0
        total_impressions = int(sum(ind(q, "TOTAL_SHOWS") for q in queries))
        total_clicks = int(sum(ind(q, "TOTAL_CLICKS") for q in queries))
        top = sorted(queries, key=lambda x: ind(x, "TOTAL_SHOWS"), reverse=True)[:10]
        top_list = [{
            "query": q.get("query_text", q.get("query", "")),
            "impressions": int(ind(q, "TOTAL_SHOWS")),
            "clicks": int(ind(q, "TOTAL_CLICKS")),
            "ctr": round(ind(q, "TOTAL_CTR"), 2),
            "position": round(ind(q, "AVG_POSITION_ON_PAGE"), 1),
        } for q in top]

        # Also fetch summary (SQI, indexable pages, problems)
        summary = {}
        try:
            summary_url = f"https://api.webmaster.yandex.net/v4/user/{user_id}/hosts/{host_id}/summary"
            req2 = urllib.request.Request(summary_url, headers={"Authorization": f"OAuth {token}"})
            with urllib.request.urlopen(req2, timeout=20) as r2:
                summary = json.loads(r2.read().decode())
        except Exception:
            pass

        return {
            "available": True,
            "total_impressions": total_impressions,
            "total_clicks": total_clicks,
            "top_queries": top_list,
            "sqi": summary.get("sqi"),
            "indexable_pages": summary.get("searchable_pages_count"),
            "problems": summary.get("site_problems", {}),
        }
    except Exception as e:
        return {"available": False, "reason": f"api_error: {e}"}


# ── Google Search Console API ─────────────────────────────────────────────
# Requires env: GSC_SERVICE_ACCOUNT_JSON (path to JSON file with private key)
def fetch_gsc():
    """Fetch GSC top queries/clicks/impressions/position for last 7 days."""
    import os, json
    sa_path = os.environ.get("GSC_SERVICE_ACCOUNT_JSON", "")
    if not sa_path:
        try:
            for ln in open("/opt/promofm-api/.env"):
                if ln.startswith("GSC_SERVICE_ACCOUNT_JSON="):
                    sa_path = ln.split("=", 1)[1].strip()
                    break
        except Exception:
            pass

    if not sa_path or not os.path.exists(sa_path):
        return {"available": False, "reason": "missing_service_account"}

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError:
        return {"available": False, "reason": "pip install google-api-python-client google-auth"}

    try:
        creds = service_account.Credentials.from_service_account_file(
            sa_path, scopes=["https://www.googleapis.com/auth/webmasters.readonly"]
        )
        service = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
        from datetime import datetime, timedelta
        end = datetime.now().date()
        start = end - timedelta(days=7)
        resp = service.searchanalytics().query(
            siteUrl="sc-domain:promo-music.ru",
            body={
                "startDate": str(start),
                "endDate": str(end),
                "dimensions": ["query"],
                "rowLimit": 20,
            },
        ).execute()
        rows = resp.get("rows", []) or []
        top = [{
            "query": r["keys"][0],
            "clicks": r.get("clicks", 0),
            "impressions": r.get("impressions", 0),
            "ctr": round(r.get("ctr", 0) * 100, 2),
            "position": round(r.get("position", 0), 1),
        } for r in rows]
        return {
            "available": True,
            "total_clicks": sum(r.get("clicks", 0) for r in rows),
            "total_impressions": sum(r.get("impressions", 0) for r in rows),
            "top_queries": top,
        }
    except Exception as e:
        return {"available": False, "reason": f"api_error: {e}"}


def send_email(subject, html_body):
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = '"ПРОМО.МУЗЫКА SEO" <noreply@promo-music.ru>'
    msg['To'] = TO_EMAIL
    msg['Reply-To'] = 'noreply@promo-music.ru'
    msg.attach(MIMEText(html_body, 'html', 'utf-8'))

    # localhost Postfix, no auth
    try:
        with smtplib.SMTP('127.0.0.1', 25, timeout=15) as server:
            server.send_message(msg)
        print(f"[OK] SEO report sent to {TO_EMAIL}")
        return True
    except Exception as e:
        print(f"[ERROR] SMTP send failed: {e}")
        return False


def main():
    yesterday = datetime.now().date() - timedelta(days=1)
    print(f"[*] SEO Optimizer running for {yesterday}")

    print("[1/6] Pinging search engines with sitemap...")
    ping_results = ping_search_engines()
    for engine, result in ping_results.items():
        print(f"    {engine}: {result}")

    print("[2/6] Checking prerender for bots...")
    prerender_results = check_prerender()
    ok = sum(1 for r in prerender_results.values() if r.get('status') == 'OK')
    print(f"    Prerender: {ok}/{len(prerender_results)} pages OK")

    print("[3/6] Checking page speed...")
    speed_results = check_page_speed()
    for page, r in speed_results.items():
        print(f"    {page}: {r.get('time_ms', '?')}ms")

    print("[4/6] Analyzing 404/5xx errors...")
    errors_404, errors_5xx = analyze_404_errors(yesterday)
    print(f"    404 errors: {sum(errors_404.values())} on {len(errors_404)} URLs")
    print(f"    5xx errors: {sum(errors_5xx.values())} on {len(errors_5xx)} URLs")

    print("[5/6] Getting content stats...")
    content_stats = get_content_stats()

    print("[6/6] Analyzing bot activity...")
    bot_activity = check_search_bot_activity(yesterday)
    for bot, data in bot_activity.items():
        if data['total'] > 0:
            print(f"    {bot}: {data['total']} requests")

    print("[6.5/6] Fetching webmaster APIs...")
    ywm = fetch_yandex_webmaster()
    gsc = fetch_gsc()
    print(f"    Yandex.Webmaster: {'OK' if ywm.get('available') else ywm.get('reason')}")
    print(f"    Google Search Console: {'OK' if gsc.get('available') else gsc.get('reason')}")

    print("[*] Building SEO report...")
    html, score = build_seo_report(ping_results, prerender_results, speed_results, errors_404, errors_5xx, content_stats, bot_activity)

    subject = f"SEO ПРОМО.МУЗЫКА — Score: {score}/100 ({yesterday.strftime('%d.%m')})"
    print(f"[*] SEO Score: {score}/100")
    print("[*] Sending email...")
    send_email(subject, html)

    # Telegram digest
    tg_text = (
        f"🔍 <b>SEO PROMO.МУЗЫКА</b>\n\n"
        f"📊 Score: <b>{score}/100</b>\n"
        f"📅 {yesterday.strftime('%d.%m.%Y')}\n\n"
        f"❌ 404: <b>{sum(errors_404.values())}</b> на {len(errors_404)} URL\n"
        f"🔥 5xx: <b>{sum(errors_5xx.values())}</b> на {len(errors_5xx)} URL\n\n"
        f"🤖 Боты:\n"
        f"  • Googlebot: {bot_activity.get('Googlebot', {}).get('total', 0)}\n"
        f"  • YandexBot: {bot_activity.get('YandexBot', {}).get('total', 0)}\n"
        f"  • Bingbot:   {bot_activity.get('Bingbot', {}).get('total', 0)}\n\n"
        f"📄 Контент в БД:\n"
        f"  • Новости:  {content_stats.get('news_total', 0)} (+{content_stats.get('news_week', 0)} за неделю)\n"
        f"  • Треки:    {content_stats.get('tracks_total', 0)} (+{content_stats.get('tracks_week', 0)} за неделю)\n"
        f"  • Концерты: {content_stats.get('concerts_total', 0)}\n"
        f"  • Артисты:  {content_stats.get('profiles_total', 0)}\n"
        f"  • Видео:    {content_stats.get('videos_total', 0)}\n"
        f"  • Юзеров:   {content_stats.get('users_total', 0)}\n\n"
        f"📨 Полный отчёт на <a href=\"mailto:info@promofm.ru\">info@promofm.ru</a>"
        + (f"\n\n🔵 <b>Яндекс.Вебмастер (7д):</b>\n  Показы: {ywm['total_impressions']:,}\n  Клики: {ywm['total_clicks']:,}" if ywm.get('available') else "\n\n🔵 Я.Вебмастер: " + ywm.get('reason', '?'))
        + (f"\n\n🟢 <b>GSC (7д):</b>\n  Показы: {gsc['total_impressions']:,}\n  Клики: {gsc['total_clicks']:,}" if gsc.get('available') else "\n\n🟢 GSC: " + gsc.get('reason', '?'))
    )
    if send_telegram(tg_text):
        print("[OK] Telegram digest sent")
    print("[OK] Done!")


if __name__ == '__main__':
    main()
