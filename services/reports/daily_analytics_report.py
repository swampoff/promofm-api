#!/usr/bin/env python3
"""
ПРОМО.МУЗЫКА — Daily Analytics & SEO Report
Sends to info@promofm.ru every day at 9:00
Parses nginx access logs + queries PostgreSQL
"""

import os
import re
import gzip
import smtplib
import psycopg2
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from collections import Counter, defaultdict

# Config
SMTP_HOST = "127.0.0.1"
SMTP_PORT = 587
SMTP_USER = "noreply@promo-music.ru"
SMTP_PASS = "Nik4873835!Med"
TO_EMAIL = "info@promofm.ru"
DB_NAME = "promofm"
DB_USER = "promofm_app"
DB_PASS = "PromoFM2024dbSecure"
NGINX_LOG = "/var/log/nginx/access.log"
NGINX_LOG_1 = "/var/log/nginx/access.log.1"

# Known bots
BOT_PATTERNS = re.compile(
    r'bot|crawl|spider|slurp|bingbot|googlebot|yandex|baidu|duckduck|facebook|twitter|telegram|whatsapp|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|chatgpt',
    re.IGNORECASE
)

# Nginx log pattern (combined format)
LOG_PATTERN = re.compile(
    r'(?P<ip>\S+) \S+ \S+ \[(?P<time>[^\]]+)\] "(?P<method>\S+) (?P<path>\S+) \S+" (?P<status>\d+) (?P<size>\d+) "(?P<referer>[^"]*)" "(?P<ua>[^"]*)"'
)


def parse_nginx_logs(target_date):
    """Parse nginx access logs for a specific date."""
    date_str = target_date.strftime("%d/%b/%Y")

    entries = []
    for logfile in [NGINX_LOG, NGINX_LOG_1]:
        if not os.path.exists(logfile):
            continue
        try:
            with open(logfile, 'r', errors='ignore') as f:
                for line in f:
                    if date_str in line:
                        m = LOG_PATTERN.match(line)
                        if m:
                            entries.append(m.groupdict())
        except Exception:
            pass

    # Also check gzipped logs
    gz_log = NGINX_LOG + ".1.gz"
    if os.path.exists(gz_log):
        try:
            with gzip.open(gz_log, 'rt', errors='ignore') as f:
                for line in f:
                    if date_str in line:
                        m = LOG_PATTERN.match(line)
                        if m:
                            entries.append(m.groupdict())
        except Exception:
            pass

    return entries


def analyze_traffic(entries):
    """Analyze parsed log entries."""
    stats = {
        'total_requests': len(entries),
        'unique_ips': set(),
        'human_ips': set(),
        'bot_ips': set(),
        'status_codes': Counter(),
        'top_pages': Counter(),
        'top_referers': Counter(),
        'top_bots': Counter(),
        'top_countries': Counter(),
        'methods': Counter(),
        'total_bytes': 0,
        'api_requests': 0,
        'static_requests': 0,
        'page_requests': 0,
        'error_requests': 0,
        'hours': Counter(),
        'search_bot_pages': Counter(),
    }

    for e in entries:
        ip = e['ip']
        ua = e['ua']
        path = e['path']
        status = int(e['status'])
        size = int(e['size']) if e['size'] != '-' else 0
        referer = e['referer']

        stats['unique_ips'].add(ip)
        stats['status_codes'][status] += 1
        stats['methods'][e['method']] += 1
        stats['total_bytes'] += size

        # Parse hour
        try:
            time_str = e['time']
            hour = int(time_str.split(':')[1])
            stats['hours'][hour] += 1
        except Exception:
            pass

        is_bot = bool(BOT_PATTERNS.search(ua))

        if is_bot:
            stats['bot_ips'].add(ip)
            # Extract bot name
            bot_match = re.search(r'(Googlebot|YandexBot|Bingbot|SemrushBot|AhrefsBot|DotBot|PetalBot|Bytespider|GPTBot|ClaudeBot|facebookexternalhit|Twitterbot|TelegramBot|WhatsApp)', ua, re.I)
            if bot_match:
                stats['top_bots'][bot_match.group(1)] += 1
            else:
                stats['top_bots']['Other bots'] += 1

            # Track what search bots are crawling
            if any(b in ua.lower() for b in ['googlebot', 'yandexbot', 'bingbot']):
                stats['search_bot_pages'][path] += 1
        else:
            stats['human_ips'].add(ip)

        # Categorize requests
        if path.startswith('/server/'):
            stats['api_requests'] += 1
        elif any(path.endswith(ext) for ext in ['.js', '.css', '.png', '.jpg', '.svg', '.ico', '.woff', '.woff2', '.ttf']):
            stats['static_requests'] += 1
        else:
            stats['page_requests'] += 1
            if not is_bot:
                # Clean path for top pages
                clean_path = path.split('?')[0]
                stats['top_pages'][clean_path] += 1

        if status >= 400:
            stats['error_requests'] += 1

        # Referers (external only)
        if referer and referer != '-' and 'promo-music.ru' not in referer:
            try:
                ref_domain = referer.split('/')[2] if '/' in referer else referer
                stats['top_referers'][ref_domain] += 1
            except Exception:
                pass

    return stats


def get_db_stats(target_date):
    """Query PostgreSQL for platform metrics."""
    db_stats = {}

    try:
        conn = psycopg2.connect(
            dbname=DB_NAME, user=DB_USER, password=DB_PASS, host='localhost'
        )
        cur = conn.cursor()

        date_start = target_date.strftime('%Y-%m-%d 00:00:00')
        date_end = (target_date + timedelta(days=1)).strftime('%Y-%m-%d 00:00:00')

        # Total users
        cur.execute("SELECT COUNT(*) FROM users")
        db_stats['total_users'] = cur.fetchone()[0]

        # New users today
        cur.execute("SELECT COUNT(*) FROM users WHERE created_at >= %s AND created_at < %s", (date_start, date_end))
        db_stats['new_users'] = cur.fetchone()[0]

        # Verified users
        cur.execute("SELECT COUNT(*) FROM users WHERE is_email_verified = true")
        db_stats['verified_users'] = cur.fetchone()[0]

        # Users by role
        cur.execute("SELECT role, COUNT(*) FROM users GROUP BY role ORDER BY COUNT(*) DESC")
        db_stats['users_by_role'] = cur.fetchall()

        # Total tracks
        cur.execute("SELECT COUNT(*) FROM tracks")
        db_stats['total_tracks'] = cur.fetchone()[0]

        # New tracks today
        cur.execute("SELECT COUNT(*) FROM tracks WHERE created_at >= %s AND created_at < %s", (date_start, date_end))
        db_stats['new_tracks'] = cur.fetchone()[0]

        # Approved tracks
        try:
            cur.execute("SELECT COUNT(*) FROM tracks WHERE status = 'approved'")
            db_stats['approved_tracks'] = cur.fetchone()[0]
        except Exception:
            conn.rollback()
            db_stats['approved_tracks'] = 'N/A'

        # Total news articles
        cur.execute("SELECT COUNT(*) FROM news")
        db_stats['total_news'] = cur.fetchone()[0]

        # New news today
        cur.execute("SELECT COUNT(*) FROM news WHERE created_at >= %s AND created_at < %s", (date_start, date_end))
        db_stats['new_news'] = cur.fetchone()[0]

        # Total video clips
        try:
            cur.execute("SELECT COUNT(*) FROM video_clips")
            db_stats['total_clips'] = cur.fetchone()[0]
        except Exception:
            conn.rollback()
            db_stats['total_clips'] = 'N/A'

        # Charts entries
        try:
            cur.execute("SELECT COUNT(*) FROM charts")
            db_stats['total_chart_entries'] = cur.fetchone()[0]
        except Exception:
            conn.rollback()
            db_stats['total_chart_entries'] = 'N/A'

        # Auth events today
        cur.execute("""
            SELECT action, COUNT(*) FROM audit_logs
            WHERE created_at >= %s AND created_at < %s
            GROUP BY action ORDER BY COUNT(*) DESC
        """, (date_start, date_end))
        db_stats['auth_events'] = cur.fetchall()

        # Total plays
        try:
            cur.execute("SELECT COALESCE(SUM(plays_count), 0) FROM tracks")
            db_stats['total_plays'] = cur.fetchone()[0]
        except Exception:
            conn.rollback()
            db_stats['total_plays'] = 'N/A'

        # Pitching requests
        try:
            cur.execute("SELECT COUNT(*) FROM pitching_requests")
            db_stats['total_pitching'] = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM pitching_requests WHERE created_at >= %s AND created_at < %s", (date_start, date_end))
            db_stats['new_pitching'] = cur.fetchone()[0]
        except Exception:
            conn.rollback()
            db_stats['total_pitching'] = 'N/A'
            db_stats['new_pitching'] = 'N/A'

        # Concerts
        try:
            cur.execute("SELECT COUNT(*) FROM concerts")
            db_stats['total_concerts'] = cur.fetchone()[0]
        except Exception:
            conn.rollback()
            db_stats['total_concerts'] = 'N/A'

        # Artist profiles
        try:
            cur.execute("SELECT COUNT(*) FROM artist_profiles")
            db_stats['total_profiles'] = cur.fetchone()[0]
        except Exception:
            conn.rollback()
            db_stats['total_profiles'] = 'N/A'

        cur.close()
        conn.close()

    except Exception as ex:
        db_stats['error'] = str(ex)

    return db_stats


def format_bytes(b):
    """Format bytes to human readable."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"


def build_report(target_date, traffic_stats, db_stats, pv_stats=None):
    """Build HTML email report."""
    date_str = target_date.strftime('%d.%m.%Y')
    weekday_ru = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][target_date.weekday()]

    unique_visitors = len(traffic_stats['human_ips'])
    bot_visitors = len(traffic_stats['bot_ips'])
    total_requests = traffic_stats['total_requests']
    page_views = traffic_stats['page_requests']

    # Top pages
    top_pages_html = ""
    for page, count in traffic_stats['top_pages'].most_common(15):
        top_pages_html += f"<tr><td style='padding:4px 8px;border-bottom:1px solid #1E293B;color:#94A3B8;font-family:monospace;font-size:13px'>{page}</td><td style='padding:4px 8px;border-bottom:1px solid #1E293B;color:white;text-align:right'>{count}</td></tr>"

    # Top referers
    top_ref_html = ""
    for ref, count in traffic_stats['top_referers'].most_common(10):
        top_ref_html += f"<tr><td style='padding:4px 8px;border-bottom:1px solid #1E293B;color:#94A3B8;font-size:13px'>{ref}</td><td style='padding:4px 8px;border-bottom:1px solid #1E293B;color:white;text-align:right'>{count}</td></tr>"

    # Bots
    bots_html = ""
    for bot, count in traffic_stats['top_bots'].most_common(10):
        color = "#22C55E" if bot in ['Googlebot', 'YandexBot', 'Bingbot'] else "#94A3B8"
        bots_html += f"<tr><td style='padding:4px 8px;border-bottom:1px solid #1E293B;color:{color};font-size:13px'>{bot}</td><td style='padding:4px 8px;border-bottom:1px solid #1E293B;color:white;text-align:right'>{count}</td></tr>"

    # Search bot crawled pages
    seo_pages_html = ""
    for page, count in traffic_stats['search_bot_pages'].most_common(10):
        seo_pages_html += f"<tr><td style='padding:4px 8px;border-bottom:1px solid #1E293B;color:#94A3B8;font-family:monospace;font-size:13px'>{page}</td><td style='padding:4px 8px;border-bottom:1px solid #1E293B;color:white;text-align:right'>{count}</td></tr>"

    # Status codes
    status_html = ""
    for code in sorted(traffic_stats['status_codes'].keys()):
        count = traffic_stats['status_codes'][code]
        color = "#22C55E" if code < 300 else "#FF8C42" if code < 400 else "#EF4444"
        status_html += f"<span style='color:{color};margin-right:12px'>{code}: {count}</span>"

    # Hourly traffic (simple bar)
    max_hour = max(traffic_stats['hours'].values()) if traffic_stats['hours'] else 1
    hours_html = ""
    for h in range(24):
        count = traffic_stats['hours'].get(h, 0)
        pct = int(count / max_hour * 100) if max_hour > 0 else 0
        hours_html += f"""<div style='display:inline-block;width:3.8%;text-align:center;vertical-align:bottom'>
            <div style='background:linear-gradient(to top,#FF577F,#FF8C42);width:80%;height:{max(pct, 2)}px;margin:0 auto;border-radius:2px'></div>
            <div style='color:#64748B;font-size:9px;margin-top:2px'>{h}</div>
        </div>"""

    # DB stats
    users_by_role_html = ""
    if 'users_by_role' in db_stats:
        for role, count in db_stats.get('users_by_role', []):
            role_name = {'artist': 'Артисты', 'radio_station': 'Радиостанции', 'venue': 'Площадки', 'producer': 'Продюсеры', 'dj': 'Диджеи', 'blogger': 'Блогеры', 'admin': 'Админы'}.get(role, role or 'Без роли')
            users_by_role_html += f"<span style='color:#94A3B8;margin-right:12px'>{role_name}: <b style='color:white'>{count}</b></span>"

    # Auth events
    auth_html = ""
    for action, count in db_stats.get('auth_events', []):
        icon = "&#9989;" if 'success' in action else "&#10060;"
        auth_html += f"<span style='margin-right:12px'>{icon} {action}: <b>{count}</b></span>"


    # Page view tracker stats
    if pv_stats and 'error' not in pv_stats:
        pv_views = pv_stats.get('total_views', 0)
        pv_sessions = pv_stats.get('unique_sessions', 0)
        pv_ips = pv_stats.get('unique_ips', 0)
        pv_load = f"{pv_stats.get('avg_load_time', 'N/A')}" if pv_stats.get('avg_load_time') else 'N/A'
        pv_devices_list = ' '.join(f'<span style="color:white;margin-right:8px">{d}: <b>{c}</b></span>' for d, c in pv_stats.get('devices', []))
        pv_browsers_list = ' '.join(f'<span style="color:white;margin-right:8px">{b}: <b>{c}</b></span>' for b, c in pv_stats.get('browsers', []))
        pv_os_list = ' '.join(f'<span style="color:white;margin-right:8px">{o}: <b>{c}</b></span>' for o, c in pv_stats.get('os_list', []))
    else:
        pv_views = pv_sessions = pv_ips = 0
        pv_load = 'N/A'
        pv_devices_list = pv_browsers_list = pv_os_list = '<span style="color:#64748B">Нет данных</span>'

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0A0A14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:700px;margin:0 auto;padding:20px">

<!-- Header -->
<div style="background:linear-gradient(135deg,#FF577F 0%,#FF3366 50%,#FF8C42 100%);border-radius:16px;padding:24px;margin-bottom:20px">
    <h1 style="color:white;margin:0;font-size:22px">ПРОМО.МУЗЫКА — Ежедневный отчёт</h1>
    <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px">{date_str} ({weekday_ru}) &bull; promo-music.ru</p>
</div>

<!-- Key Metrics -->
<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
    <div style="flex:1;min-width:140px;background:#12121E;border-radius:12px;padding:16px;border:1px solid #1E293B">
        <div style="color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:1px">Посетители</div>
        <div style="color:white;font-size:28px;font-weight:700;margin-top:4px">{unique_visitors}</div>
        <div style="color:#94A3B8;font-size:12px">уникальных IP</div>
    </div>
    <div style="flex:1;min-width:140px;background:#12121E;border-radius:12px;padding:16px;border:1px solid #1E293B">
        <div style="color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:1px">Просмотры</div>
        <div style="color:white;font-size:28px;font-weight:700;margin-top:4px">{page_views}</div>
        <div style="color:#94A3B8;font-size:12px">страниц</div>
    </div>
    <div style="flex:1;min-width:140px;background:#12121E;border-radius:12px;padding:16px;border:1px solid #1E293B">
        <div style="color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:1px">Запросы</div>
        <div style="color:white;font-size:28px;font-weight:700;margin-top:4px">{total_requests}</div>
        <div style="color:#94A3B8;font-size:12px">всего ({format_bytes(traffic_stats['total_bytes'])})</div>
    </div>
    <div style="flex:1;min-width:140px;background:#12121E;border-radius:12px;padding:16px;border:1px solid #1E293B">
        <div style="color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:1px">Боты</div>
        <div style="color:white;font-size:28px;font-weight:700;margin-top:4px">{bot_visitors}</div>
        <div style="color:#94A3B8;font-size:12px">поисковые роботы</div>
    </div>
</div>

<!-- Hourly Traffic -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 12px;font-size:14px">&#128337; Трафик по часам (МСК)</h3>
    <div style="height:80px;display:flex;align-items:flex-end">{hours_html}</div>
</div>

<!-- Top Pages -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 12px;font-size:14px">&#128196; Популярные страницы</h3>
    <table style="width:100%;border-collapse:collapse">
        <tr><th style="padding:4px 8px;text-align:left;color:#64748B;font-size:11px;border-bottom:1px solid #334155">Страница</th><th style="padding:4px 8px;text-align:right;color:#64748B;font-size:11px;border-bottom:1px solid #334155">Визиты</th></tr>
        {top_pages_html}
    </table>
</div>

<!-- SEO Section -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 12px;font-size:14px">&#128270; SEO — Поисковые боты</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <tr><th style="padding:4px 8px;text-align:left;color:#64748B;font-size:11px;border-bottom:1px solid #334155">Бот</th><th style="padding:4px 8px;text-align:right;color:#64748B;font-size:11px;border-bottom:1px solid #334155">Запросы</th></tr>
        {bots_html}
    </table>
    <h4 style="color:#94A3B8;margin:12px 0 8px;font-size:13px">Страницы, проиндексированные ботами:</h4>
    <table style="width:100%;border-collapse:collapse">
        <tr><th style="padding:4px 8px;text-align:left;color:#64748B;font-size:11px;border-bottom:1px solid #334155">URL</th><th style="padding:4px 8px;text-align:right;color:#64748B;font-size:11px;border-bottom:1px solid #334155">Обходы</th></tr>
        {seo_pages_html}
    </table>
</div>

<!-- Referrers -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 12px;font-size:14px">&#128279; Источники трафика</h3>
    <table style="width:100%;border-collapse:collapse">
        <tr><th style="padding:4px 8px;text-align:left;color:#64748B;font-size:11px;border-bottom:1px solid #334155">Источник</th><th style="padding:4px 8px;text-align:right;color:#64748B;font-size:11px;border-bottom:1px solid #334155">Переходы</th></tr>
        {top_ref_html if top_ref_html else "<tr><td style='padding:8px;color:#64748B' colspan='2'>Нет внешних переходов</td></tr>"}
    </table>
</div>

<!-- HTTP Status Codes -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 8px;font-size:14px">&#128200; HTTP-ответы</h3>
    <div style="font-size:13px">{status_html}</div>
    <div style="margin-top:8px;color:#64748B;font-size:12px">
        API: {traffic_stats['api_requests']} &bull;
        Статика: {traffic_stats['static_requests']} &bull;
        Страницы: {traffic_stats['page_requests']} &bull;
        Ошибки: <span style="color:{'#EF4444' if traffic_stats['error_requests'] > 50 else '#94A3B8'}">{traffic_stats['error_requests']}</span>
    </div>
</div>


<!-- Real Analytics (page_views DB) -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #334155">
    <h3 style="color:white;margin:0 0 12px;font-size:14px">&#128202; Аналитика (трекер promo-music.ru)</h3>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <div style="flex:1;min-width:100px;background:#0A0A14;border-radius:8px;padding:12px;text-align:center">
            <div style="color:#FF577F;font-size:24px;font-weight:700">{pv_views}</div>
            <div style="color:#64748B;font-size:11px">Просмотры</div>
        </div>
        <div style="flex:1;min-width:100px;background:#0A0A14;border-radius:8px;padding:12px;text-align:center">
            <div style="color:#FF8C42;font-size:24px;font-weight:700">{pv_sessions}</div>
            <div style="color:#64748B;font-size:11px">Сессии</div>
        </div>
        <div style="flex:1;min-width:100px;background:#0A0A14;border-radius:8px;padding:12px;text-align:center">
            <div style="color:#3B82F6;font-size:24px;font-weight:700">{pv_ips}</div>
            <div style="color:#64748B;font-size:11px">Уник. IP</div>
        </div>
        <div style="flex:1;min-width:100px;background:#0A0A14;border-radius:8px;padding:12px;text-align:center">
            <div style="color:#22C55E;font-size:24px;font-weight:700">{pv_load}</div>
            <div style="color:#64748B;font-size:11px">Загрузка (мс)</div>
        </div>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:150px">
            <div style="color:#94A3B8;font-size:11px;margin-bottom:4px">Устройства:</div>
            <div style="font-size:12px">{pv_devices_list}</div>
        </div>
        <div style="flex:1;min-width:150px">
            <div style="color:#94A3B8;font-size:11px;margin-bottom:4px">Браузеры:</div>
            <div style="font-size:12px">{pv_browsers_list}</div>
        </div>
        <div style="flex:1;min-width:150px">
            <div style="color:#94A3B8;font-size:11px;margin-bottom:4px">ОС:</div>
            <div style="font-size:12px">{pv_os_list}</div>
        </div>
    </div>
</div>

<!-- Platform Stats -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 12px;font-size:14px">&#127911; Платформа — Контент</h3>
    <table style="width:100%;border-collapse:collapse">
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px">Пользователи</td>
            <td style="padding:6px 0;color:white;text-align:right;font-weight:600">{db_stats.get('total_users', 'N/A')} <span style="color:#22C55E;font-size:11px">(+{db_stats.get('new_users', 0)} за день)</span></td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Верифицированные</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('verified_users', 'N/A')}</td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Треки</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('total_tracks', 'N/A')} <span style="color:#22C55E;font-size:11px">(+{db_stats.get('new_tracks', 0)} за день)</span></td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Одобренные треки</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('approved_tracks', 'N/A')}</td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Новости</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('total_news', 'N/A')} <span style="color:#22C55E;font-size:11px">(+{db_stats.get('new_news', 0)} за день)</span></td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Видеоклипы</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('total_clips', 'N/A')}</td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Чарт позиций</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('total_chart_entries', 'N/A')}</td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Питчинг заявки</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('total_pitching', 'N/A')} <span style="color:#22C55E;font-size:11px">(+{db_stats.get('new_pitching', 0)} за день)</span></td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Концерты</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('total_concerts', 'N/A')}</td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Профили артистов</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('total_profiles', 'N/A')}</td>
        </tr>
        <tr>
            <td style="padding:6px 0;color:#94A3B8;font-size:13px;border-top:1px solid #1E293B">Всего прослушиваний</td>
            <td style="padding:6px 0;color:white;text-align:right;border-top:1px solid #1E293B">{db_stats.get('total_plays', 'N/A')}</td>
        </tr>
    </table>
    <div style="margin-top:12px;font-size:12px">{users_by_role_html}</div>
</div>

<!-- Auth Events -->
<div style="background:#12121E;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #1E293B">
    <h3 style="color:white;margin:0 0 8px;font-size:14px">&#128274; Авторизация за день</h3>
    <div style="font-size:13px">{auth_html if auth_html else "<span style='color:#64748B'>Нет событий</span>"}</div>
</div>

<!-- Footer -->
<div style="text-align:center;padding:16px;color:#64748B;font-size:11px">
    Отчёт сгенерирован автоматически &bull; promo-music.ru<br>
    {datetime.now().strftime('%d.%m.%Y %H:%M')} МСК
</div>

</div>
</body>
</html>"""

    return html


def send_email(subject, html_body):
    """Send HTML email via SMTP."""
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = f'"ПРОМО.МУЗЫКА Analytics" <{SMTP_USER}>'
    msg['To'] = TO_EMAIL

    msg.attach(MIMEText(html_body, 'html', 'utf-8'))

    # Postfix на localhost:25 принимает без auth/TLS (как весь остальной
    # почтовый тракт сервера). Порт 2587 не слушался → ConnectionRefused,
    # submission-587 рвал starttls. Фикс 2026-07-13.
    with smtplib.SMTP(SMTP_HOST, 25) as server:
        server.send_message(msg)

    print(f"[OK] Report sent to {TO_EMAIL}")


def get_pageview_stats(target_date):
    """Get real page view analytics from page_views table."""
    pv = {}
    try:
        conn = psycopg2.connect(dbname=DB_NAME, user=DB_USER, password=DB_PASS, host='localhost')
        cur = conn.cursor()
        ds = target_date.strftime('%Y-%m-%d 00:00:00')
        de = (target_date + timedelta(days=1)).strftime('%Y-%m-%d 00:00:00')

        cur.execute('SELECT COUNT(*) FROM page_views WHERE created_at >= %s AND created_at < %s AND is_bot = false', (ds, de))
        pv['total_views'] = cur.fetchone()[0]

        cur.execute('SELECT COUNT(DISTINCT session_id) FROM page_views WHERE created_at >= %s AND created_at < %s AND is_bot = false', (ds, de))
        pv['unique_sessions'] = cur.fetchone()[0]

        cur.execute('SELECT COUNT(DISTINCT ip) FROM page_views WHERE created_at >= %s AND created_at < %s AND is_bot = false', (ds, de))
        pv['unique_ips'] = cur.fetchone()[0]

        cur.execute('SELECT device, COUNT(*) FROM page_views WHERE created_at >= %s AND created_at < %s AND is_bot = false GROUP BY device ORDER BY COUNT(*) DESC', (ds, de))
        pv['devices'] = cur.fetchall()

        cur.execute('SELECT browser, COUNT(*) FROM page_views WHERE created_at >= %s AND created_at < %s AND is_bot = false GROUP BY browser ORDER BY COUNT(*) DESC LIMIT 8', (ds, de))
        pv['browsers'] = cur.fetchall()

        cur.execute('SELECT os, COUNT(*) FROM page_views WHERE created_at >= %s AND created_at < %s AND is_bot = false GROUP BY os ORDER BY COUNT(*) DESC', (ds, de))
        pv['os_list'] = cur.fetchall()

        cur.execute('SELECT path, COUNT(*) FROM page_views WHERE created_at >= %s AND created_at < %s AND is_bot = false GROUP BY path ORDER BY COUNT(*) DESC LIMIT 15', (ds, de))
        pv['top_pages'] = cur.fetchall()

        cur.execute("SELECT referrer, COUNT(*) FROM page_views WHERE created_at >= %s AND created_at < %s AND is_bot = false AND referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY COUNT(*) DESC LIMIT 10", (ds, de))
        pv['top_referrers'] = cur.fetchall()

        cur.execute('SELECT AVG(load_time) FROM page_views WHERE created_at >= %s AND created_at < %s AND is_bot = false AND load_time IS NOT NULL', (ds, de))
        avg = cur.fetchone()[0]
        pv['avg_load_time'] = round(avg) if avg else None

        cur.close()
        conn.close()
    except Exception as e:
        pv['error'] = str(e)
    return pv

def main():
    yesterday = datetime.now().date() - timedelta(days=1)
    print(f"[*] Generating report for {yesterday}")

    # Parse nginx logs
    print("[*] Parsing nginx access logs...")
    entries = parse_nginx_logs(yesterday)
    print(f"    Found {len(entries)} log entries")

    # Analyze traffic
    traffic_stats = analyze_traffic(entries)
    print(f"    Unique visitors: {len(traffic_stats['human_ips'])}, Bots: {len(traffic_stats['bot_ips'])}")

    # Get DB stats
    print("[*] Querying PostgreSQL...")
    db_stats = get_db_stats(yesterday)
    if 'error' in db_stats:
        print(f"    DB error: {db_stats['error']}")
    else:
        print(f"    Users: {db_stats.get('total_users')}, Tracks: {db_stats.get('total_tracks')}")

    # Get real pageview stats
    print("[*] Querying page_views table...")
    pv_stats = get_pageview_stats(yesterday)
    if 'error' in pv_stats:
        print(f"    PV error: {pv_stats['error']}")
    else:
        print(f"    Real views: {pv_stats.get('total_views', 0)}, Sessions: {pv_stats.get('unique_sessions', 0)}")

    # Build report
    print("[*] Building HTML report...")
    html = build_report(yesterday, traffic_stats, db_stats, pv_stats)

    # Send
    date_str = yesterday.strftime('%d.%m.%Y')
    subject = f"ПРОМО.МУЗЫКА — Статистика за {date_str}"

    print("[*] Sending email...")
    send_email(subject, html)
    print("[OK] Done!")


if __name__ == '__main__':
    main()


