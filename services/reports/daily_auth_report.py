#!/usr/bin/env python3
"""
Daily auth statistics report for PromoFM.
Sends email to info@promofm.ru with registration/login stats and errors.
Run via cron: 0 9 * * * /usr/bin/python3 /opt/promofm-reports/daily_auth_report.py
"""
import smtplib
import psycopg2
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta

# ── Config ──
DB_HOST = 'localhost'
DB_NAME = 'promofm'
DB_USER = 'promofm_app'
DB_PASS = 'PromoFM2024dbSecure'

SMTP_HOST = '127.0.0.1'
SMTP_PORT = 2587
SMTP_USER = 'noreply@promo-music.ru'
SMTP_PASS = 'Nik4873835!Med'
FROM_EMAIL = 'noreply@promo-music.ru'
TO_EMAIL = 'info@promofm.ru'

def get_report():
    conn = psycopg2.connect(host=DB_HOST, dbname=DB_NAME, user=DB_USER, password=DB_PASS)
    cur = conn.cursor()

    yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')
    today = datetime.now().strftime('%Y-%m-%d')

    report = []
    report.append(f"📊 Ежедневный отчёт ПРОМО.МУЗЫКА — {yesterday}")
    report.append("=" * 50)

    # ── 1. New registrations ──
    cur.execute("""
        SELECT COUNT(*), role::text
        FROM users
        WHERE created_at >= %s AND created_at < %s AND deleted_at IS NULL
        GROUP BY role::text
        ORDER BY count DESC
    """, (yesterday, today))
    regs = cur.fetchall()
    total_regs = sum(r[0] for r in regs)

    report.append(f"\n🆕 РЕГИСТРАЦИИ: {total_regs}")
    if regs:
        for count, role in regs:
            report.append(f"   • {role}: {count}")
    else:
        report.append("   Нет новых регистраций")

    # ── 2. Registration details ──
    cur.execute("""
        SELECT email, full_name, role::text, status::text, created_at
        FROM users
        WHERE created_at >= %s AND created_at < %s AND deleted_at IS NULL
        ORDER BY created_at DESC
    """, (yesterday, today))
    new_users = cur.fetchall()
    if new_users:
        report.append(f"\n   Подробности:")
        for email, name, role, status, created in new_users:
            time_str = created.strftime('%H:%M') if created else '?'
            report.append(f"   {time_str} | {email} | {name or '-'} | {role} | {status}")

    # ── 3. Auth events from audit_logs ──
    cur.execute("""
        SELECT action, COUNT(*),
               COUNT(*) FILTER (WHERE status = 'success'),
               COUNT(*) FILTER (WHERE status != 'success')
        FROM audit_logs
        WHERE created_at >= %s AND created_at < %s AND resource_type = 'auth'
        GROUP BY action
        ORDER BY 2 DESC
    """, (yesterday, today))
    events = cur.fetchall()

    if events:
        report.append(f"\n📈 СОБЫТИЯ АВТОРИЗАЦИИ:")
        for action, total, ok, fail in events:
            label = {
                'signup_success': 'Регистрация (успех)',
                'signup_fail': 'Регистрация (ошибка)',
                'signup_error': 'Регистрация (сбой сервера)',
                'signin_success': 'Вход (успех)',
                'signin_fail': 'Вход (ошибка)',
                'signup_vk': 'VK регистрация',
                'signin_vk': 'VK вход',
            }.get(action, action)
            report.append(f"   • {label}: {total}")

    # ── 4. Errors and difficulties ──
    cur.execute("""
        SELECT action, action_description, error_message, ip_address, user_agent, created_at
        FROM audit_logs
        WHERE created_at >= %s AND created_at < %s
          AND resource_type = 'auth'
          AND status != 'success'
        ORDER BY created_at DESC
        LIMIT 20
    """, (yesterday, today))
    errors = cur.fetchall()

    if errors:
        report.append(f"\n⚠️ ОШИБКИ И СЛОЖНОСТИ ({len(errors)}):")
        for action, desc, err, ip, ua, created in errors:
            time_str = created.strftime('%H:%M') if created else '?'
            device = 'Mobile' if ua and ('Mobile' in ua or 'Android' in ua or 'iPhone' in ua) else 'Desktop'
            report.append(f"   {time_str} | {desc} | {err or '-'} | {device} | IP:{ip or '-'}")
    else:
        report.append(f"\n✅ Ошибок авторизации не зафиксировано")

    # ── 5. Total platform stats ──
    cur.execute("SELECT COUNT(*) FROM users WHERE deleted_at IS NULL")
    total_users = cur.fetchone()[0]

    cur.execute("SELECT role::text, COUNT(*) FROM users WHERE deleted_at IS NULL GROUP BY role::text ORDER BY count DESC")
    by_role = cur.fetchall()

    cur.execute("SELECT COUNT(*) FROM users WHERE last_login_at >= %s AND deleted_at IS NULL", (yesterday,))
    active_today = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM users WHERE is_email_verified = true AND deleted_at IS NULL")
    verified = cur.fetchone()[0]

    report.append(f"\n📊 ОБЩАЯ СТАТИСТИКА:")
    report.append(f"   Всего пользователей: {total_users}")
    report.append(f"   Подтвердили email: {verified}")
    report.append(f"   Активны вчера: {active_today}")
    for role, count in by_role:
        report.append(f"   • {role}: {count}")

    # ── 6. Unverified emails (potential lost users) ──
    cur.execute("""
        SELECT email, role::text, created_at
        FROM users
        WHERE is_email_verified = false AND deleted_at IS NULL
          AND created_at >= %s AND created_at < %s
        ORDER BY created_at DESC
    """, (yesterday, today))
    unverified = cur.fetchall()
    if unverified:
        report.append(f"\n📧 НЕ ПОДТВЕРДИЛИ EMAIL ({len(unverified)}):")
        for email, role, created in unverified:
            report.append(f"   • {email} ({role})")

    cur.close()
    conn.close()

    return '\n'.join(report)


def send_email(subject, body):
    msg = MIMEMultipart('alternative')
    msg['From'] = f'ПРОМО.МУЗЫКА <{FROM_EMAIL}>'
    msg['To'] = TO_EMAIL
    msg['Subject'] = subject

    # Plain text version
    msg.attach(MIMEText(body, 'plain', 'utf-8'))

    # HTML version (monospace for alignment)
    html_body = f'<pre style="font-family: monospace; font-size: 14px; line-height: 1.5;">{body}</pre>'
    msg.attach(MIMEText(html_body, 'html', 'utf-8'))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.starttls()
        server.login(SMTP_USER, SMTP_PASS)
        server.send_message(msg)
    print(f'Email sent to {TO_EMAIL}')




# Telegram fallback
TELEGRAM_BOT_TOKEN = '8572224491:AAHRoypofG3hD0x0obBJ0wjcpxgn2-kEDw8'
TELEGRAM_CHAT_ID = '-392147189'

def send_telegram(text):
    import urllib.request
    import json
    # Truncate if too long for Telegram (4096 chars max)
    if len(text) > 4000:
        text = text[:4000] + ' ... (обрезано)'
    url = f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage'
    data = json.dumps({'chat_id': TELEGRAM_CHAT_ID, 'text': text, 'parse_mode': 'HTML'}).encode()
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=10)
        print('Telegram sent')
    except Exception as e:
        print(f'Telegram failed: {e}')

if __name__ == '__main__':
    report = get_report()
    print(report)

    yesterday = (datetime.now() - timedelta(days=1)).strftime('%d.%m.%Y')
    subject = f'ПРОМО.МУЗЫКА — отчёт за {yesterday}'

    try:
        send_email(subject, report)
    except Exception as e:
        print(f'Email failed: {e}')
        # Fallback: send via Telegram
        send_telegram(subject + chr(10) + chr(10) + report)
