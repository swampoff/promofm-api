#!/usr/bin/env python3
"""
PromoFM Security Monitoring Agent
24/7 daemon that monitors security events and sends alerts to info@promofm.ru

Monitors:
- Nginx access/error logs (rate spikes, 4xx/5xx floods, scanning)
- Fail2Ban bans
- Auth failures (brute force detection)
- Admin panel access
- Service health (HTTP checks)
- System resources (disk, memory)

Usage:
  python3 security-agent.py            # Run as daemon
  python3 security-agent.py --test     # Send test alert email
"""

import os
import sys
import time
import json
import re
import smtplib
import subprocess
import shutil
import signal
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path

# ─── Configuration ───

SMTP_HOST = os.getenv('SMTP_HOST', '127.0.0.1')
SMTP_PORT = int(os.getenv('SMTP_PORT', '2587'))
SMTP_USER = os.getenv('SMTP_USER', 'noreply@promo-music.ru')
SMTP_PASS = os.getenv('SMTP_PASS', 'Nik4873835!Med')
ALERT_FROM = 'noreply@promo-music.ru'
ALERT_TO = 'n.moiseev@gmx.de'

HEALTH_URL = 'https://promo-music.ru/server/health'
ADMIN_URL = 'https://admin.promo-music.ru'

NGINX_ACCESS_LOG = '/var/log/nginx/access.log'
NGINX_ERROR_LOG = '/var/log/nginx/error.log'
FAIL2BAN_LOG = '/var/log/fail2ban.log'

STATE_FILE = '/tmp/promofm-security-state.json'
KNOWN_ADMIN_IPS_FILE = '/opt/promofm-security/known-admin-ips.json'

# Thresholds
BRUTE_FORCE_THRESHOLD = 20       # auth failures per IP in 5 min
DDOS_THRESHOLD = 500             # requests per IP per minute
SCAN_THRESHOLD = 50              # 4xx per IP per minute
DISK_THRESHOLD = 90              # percent
MEMORY_THRESHOLD = 90            # percent
HEALTH_CHECK_INTERVAL = 60       # seconds
LOG_SCAN_INTERVAL = 30           # seconds
RESOURCE_CHECK_INTERVAL = 300    # seconds
ALERT_COOLDOWN = 600             # seconds between same-type alerts

# ─── State ───

class SecurityState:
    def __init__(self):
        self.events = []
        self.alerts_sent = defaultdict(float)  # alert_key -> last_sent_timestamp
        self.health_failures = 0
        self.total_alerts = 0
        self.total_blocked = 0
        self.known_admin_ips = set()
        self.last_access_pos = 0
        self.last_error_pos = 0
        self.last_f2b_pos = 0
        self.ip_requests = defaultdict(list)    # ip -> [timestamps]
        self.ip_auth_fails = defaultdict(list)  # ip -> [timestamps]
        self.ip_4xx = defaultdict(list)          # ip -> [timestamps]
        self.start_time = datetime.now().isoformat()
        self._load_known_ips()

    def _load_known_ips(self):
        try:
            if os.path.exists(KNOWN_ADMIN_IPS_FILE):
                with open(KNOWN_ADMIN_IPS_FILE) as f:
                    self.known_admin_ips = set(json.load(f))
        except:
            pass

    def _save_known_ips(self):
        try:
            with open(KNOWN_ADMIN_IPS_FILE, 'w') as f:
                json.dump(list(self.known_admin_ips), f)
        except:
            pass

    def add_event(self, severity, event_type, message, source_ip=None):
        event = {
            'timestamp': datetime.now().isoformat(),
            'severity': severity,
            'type': event_type,
            'message': message,
            'source_ip': source_ip,
        }
        self.events.append(event)
        # Keep last 1000 events
        if len(self.events) > 1000:
            self.events = self.events[-1000:]
        return event

    def should_alert(self, alert_key):
        """Check if we should send an alert (respects cooldown)"""
        last = self.alerts_sent.get(alert_key, 0)
        now = time.time()
        if now - last < ALERT_COOLDOWN:
            return False
        self.alerts_sent[alert_key] = now
        return True

    def save_state(self):
        """Save current state to JSON file for API access"""
        try:
            state = {
                'agent_status': 'active',
                'start_time': self.start_time,
                'last_update': datetime.now().isoformat(),
                'total_alerts': self.total_alerts,
                'total_blocked': self.total_blocked,
                'health_failures': self.health_failures,
                'recent_events': self.events[-50:],
                'known_admin_ips': list(self.known_admin_ips),
            }
            with open(STATE_FILE, 'w') as f:
                json.dump(state, f, indent=2)
        except Exception as e:
            print(f'[WARN] Failed to save state: {e}')

    def cleanup_old_data(self):
        """Remove old IP tracking data"""
        cutoff = time.time() - 300  # 5 minutes
        for ip_dict in [self.ip_requests, self.ip_auth_fails, self.ip_4xx]:
            for ip in list(ip_dict.keys()):
                ip_dict[ip] = [t for t in ip_dict[ip] if t > cutoff]
                if not ip_dict[ip]:
                    del ip_dict[ip]

state = SecurityState()

# ─── Email ───

def send_alert(severity, event_type, message, source_ip=None, extra_info=None):
    """Send security alert email"""
    alert_key = f'{event_type}:{source_ip or "system"}'
    if not state.should_alert(alert_key):
        return

    state.total_alerts += 1
    severity_emoji = {'CRITICAL': '[!!!]', 'HIGH': '[!!]', 'MEDIUM': '[!]', 'LOW': '[i]', 'INFO': '[*]'}.get(severity, '[?]')

    subject = f'[{severity}] PromoFM Security: {event_type}'

    body = f"""
{severity_emoji} PromoFM Security Alert

Severity: {severity}
Event: {event_type}
Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S MSK')}
{'Source IP: ' + source_ip if source_ip else ''}

{message}

{'Extra info: ' + extra_info if extra_info else ''}

---
PromoFM Security Agent
Server: promo-music.ru (194.67.122.99)
"""

    try:
        msg = MIMEMultipart()
        msg['From'] = ALERT_FROM
        msg['To'] = ALERT_TO
        msg['Subject'] = subject
        msg.attach(MIMEText(body, 'plain', 'utf-8'))

        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.send_message(msg)

        print(f'[ALERT SENT] {severity} - {event_type} - {source_ip or "system"}')
    except Exception as e:
        print(f'[ERROR] Failed to send alert: {e}')

# ─── Log Monitoring ───

def tail_file(filepath, last_pos):
    """Read new lines from a log file since last position"""
    try:
        size = os.path.getsize(filepath)
        if size < last_pos:
            last_pos = 0  # Log was rotated

        with open(filepath, 'r', errors='replace') as f:
            f.seek(last_pos)
            lines = f.readlines()
            new_pos = f.tell()
        return lines, new_pos
    except FileNotFoundError:
        return [], last_pos
    except Exception as e:
        print(f'[WARN] Error reading {filepath}: {e}')
        return [], last_pos

def parse_access_log_line(line):
    """Parse nginx access log line"""
    # Standard combined format: IP - - [date] "METHOD PATH HTTP/x.x" STATUS SIZE ...
    match = re.match(
        r'(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d+) (\d+)',
        line
    )
    if match:
        return {
            'ip': match.group(1),
            'date': match.group(2),
            'method': match.group(3),
            'path': match.group(4),
            'status': int(match.group(5)),
            'size': int(match.group(6)),
        }
    return None

def scan_access_log():
    """Scan nginx access log for suspicious activity"""
    lines, state.last_access_pos = tail_file(NGINX_ACCESS_LOG, state.last_access_pos)
    now = time.time()

    for line in lines:
        parsed = parse_access_log_line(line)
        if not parsed:
            continue

        ip = parsed['ip']
        path = parsed['path']
        status = parsed['status']

        # Track requests per IP
        state.ip_requests[ip].append(now)

        # Track 4xx errors per IP (scanning detection)
        if 400 <= status < 500:
            state.ip_4xx[ip].append(now)

        # Track auth failures
        if '/server/auth/' in path and status in (401, 403):
            state.ip_auth_fails[ip].append(now)

        # Admin panel access detection
        if '/ctrl-pm7k2f' in path or 'admin.promo-music.ru' in line:
            event = state.add_event('INFO', 'admin_access', f'Admin panel accessed: {path}', ip)
            if ip not in state.known_admin_ips:
                state.known_admin_ips.add(ip)
                state._save_known_ips()
                send_alert('HIGH', 'New Admin IP',
                    f'Admin panel accessed from new IP address.\nPath: {path}\nStatus: {status}',
                    source_ip=ip,
                    extra_info=f'Known admin IPs: {", ".join(state.known_admin_ips)}')

        # SQL injection attempt in URL
        if any(kw in path.upper() for kw in ['UNION', 'SELECT', 'DROP', 'INSERT', "';--", 'SLEEP(', 'BENCHMARK(']):
            state.total_blocked += 1
            state.add_event('HIGH', 'sqli_attempt', f'SQL injection attempt in URL: {path[:200]}', ip)
            send_alert('HIGH', 'SQL Injection Attempt',
                f'Potential SQL injection detected in URL.\nPath: {path[:200]}\nStatus: {status}',
                source_ip=ip)

    # Check thresholds
    cutoff_1min = now - 60
    cutoff_5min = now - 300

    for ip in list(state.ip_requests.keys()):
        recent = [t for t in state.ip_requests[ip] if t > cutoff_1min]
        if len(recent) > DDOS_THRESHOLD:
            state.add_event('HIGH', 'ddos_suspected', f'{len(recent)} requests/min from {ip}', ip)
            send_alert('HIGH', 'DDoS Suspected',
                f'{len(recent)} requests in the last minute from single IP.\nThis exceeds the threshold of {DDOS_THRESHOLD} req/min.',
                source_ip=ip)

    for ip in list(state.ip_auth_fails.keys()):
        recent = [t for t in state.ip_auth_fails[ip] if t > cutoff_5min]
        if len(recent) > BRUTE_FORCE_THRESHOLD:
            state.add_event('HIGH', 'brute_force', f'{len(recent)} auth failures in 5 min from {ip}', ip)
            send_alert('HIGH', 'Brute Force Attack',
                f'{len(recent)} authentication failures in 5 minutes from single IP.\nPossible brute force attack on login endpoint.',
                source_ip=ip)

    for ip in list(state.ip_4xx.keys()):
        recent = [t for t in state.ip_4xx[ip] if t > cutoff_1min]
        if len(recent) > SCAN_THRESHOLD:
            state.add_event('MEDIUM', 'scanning', f'{len(recent)} 4xx errors/min from {ip}', ip)
            send_alert('MEDIUM', 'Scanning Detected',
                f'{len(recent)} client errors (4xx) in the last minute from single IP.\nPossible vulnerability scanning or path enumeration.',
                source_ip=ip)

def scan_error_log():
    """Scan nginx error log for rate limit triggers and upstream errors"""
    lines, state.last_error_pos = tail_file(NGINX_ERROR_LOG, state.last_error_pos)

    for line in lines:
        if 'limiting requests' in line:
            ip_match = re.search(r'client: (\S+)', line)
            ip = ip_match.group(1) if ip_match else 'unknown'
            state.add_event('LOW', 'rate_limited', f'Rate limit triggered', ip)

        if 'upstream' in line and ('timed out' in line or 'connection refused' in line):
            state.add_event('MEDIUM', 'upstream_error', f'Backend connection issue: {line.strip()[:200]}')

def scan_fail2ban_log():
    """Watch fail2ban for new bans"""
    lines, state.last_f2b_pos = tail_file(FAIL2BAN_LOG, state.last_f2b_pos)

    for line in lines:
        if 'Ban' in line and 'Unban' not in line:
            ip_match = re.search(r'Ban\s+(\S+)', line)
            jail_match = re.search(r'\[(\S+)\]', line)
            ip = ip_match.group(1) if ip_match else 'unknown'
            jail = jail_match.group(1) if jail_match else 'unknown'

            state.total_blocked += 1
            state.add_event('MEDIUM', 'fail2ban_ban', f'IP banned by {jail} jail', ip)
            send_alert('MEDIUM', 'IP Banned by Fail2Ban',
                f'IP has been banned by Fail2Ban.\nJail: {jail}\nReason: Exceeded threshold for {jail}.',
                source_ip=ip)

# ─── Health Check ───

def check_health():
    """Check if the web service is responding"""
    try:
        result = subprocess.run(
            ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', HEALTH_URL],
            capture_output=True, text=True, timeout=15
        )
        status = result.stdout.strip()
        if status == '200':
            if state.health_failures > 0:
                state.add_event('INFO', 'service_recovered', 'Service recovered after failures')
            state.health_failures = 0
        else:
            state.health_failures += 1
            state.add_event('HIGH', 'health_check_fail', f'Health check returned {status}')
            if state.health_failures >= 3:
                send_alert('CRITICAL', 'Service Down',
                    f'Health check has failed {state.health_failures} times in a row.\nLast HTTP status: {status}\nURL: {HEALTH_URL}',
                    extra_info='Immediate investigation required!')
    except Exception as e:
        state.health_failures += 1
        state.add_event('HIGH', 'health_check_error', f'Health check error: {str(e)[:200]}')
        if state.health_failures >= 3:
            send_alert('CRITICAL', 'Service Unreachable',
                f'Cannot reach health endpoint.\nError: {str(e)[:200]}\nURL: {HEALTH_URL}',
                extra_info='Server may be down or network issue!')

# ─── System Resources ───

def check_resources():
    """Check disk and memory usage"""
    # Disk
    total, used, free = shutil.disk_usage('/')
    disk_pct = (used / total) * 100
    if disk_pct > DISK_THRESHOLD:
        state.add_event('HIGH', 'disk_high', f'Disk usage: {disk_pct:.1f}%')
        send_alert('HIGH', 'High Disk Usage',
            f'Disk usage has reached {disk_pct:.1f}%.\nUsed: {used // (1024**3)} GB / {total // (1024**3)} GB\nFree: {free // (1024**3)} GB',
            extra_info='Consider cleaning up old logs, uploads, or expanding storage.')

    # Memory
    try:
        with open('/proc/meminfo') as f:
            meminfo = f.read()
        total_match = re.search(r'MemTotal:\s+(\d+)', meminfo)
        avail_match = re.search(r'MemAvailable:\s+(\d+)', meminfo)
        if total_match and avail_match:
            total_kb = int(total_match.group(1))
            avail_kb = int(avail_match.group(1))
            mem_pct = ((total_kb - avail_kb) / total_kb) * 100
            if mem_pct > MEMORY_THRESHOLD:
                state.add_event('HIGH', 'memory_high', f'Memory usage: {mem_pct:.1f}%')
                send_alert('HIGH', 'High Memory Usage',
                    f'Memory usage has reached {mem_pct:.1f}%.\nTotal: {total_kb // 1024} MB\nAvailable: {avail_kb // 1024} MB',
                    extra_info='Consider restarting services or investigating memory leaks.')
    except:
        pass

# ─── Main Loop ───

def run_daemon():
    """Main monitoring loop"""
    print(f'[START] PromoFM Security Agent started at {datetime.now().isoformat()}')
    print(f'[INFO] Monitoring logs, health, and resources')
    print(f'[INFO] Alerts will be sent to {ALERT_TO}')

    last_health = 0
    last_resource = 0

    # Handle graceful shutdown
    def handle_signal(signum, frame):
        print(f'\n[STOP] Security Agent shutting down (signal {signum})')
        state.add_event('INFO', 'agent_stop', 'Security agent stopped')
        state.save_state()
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # Initial state save
    state.add_event('INFO', 'agent_start', 'Security agent started')
    state.save_state()

    while True:
        try:
            now = time.time()

            # Scan logs every LOG_SCAN_INTERVAL seconds
            scan_access_log()
            scan_error_log()
            scan_fail2ban_log()

            # Health check every HEALTH_CHECK_INTERVAL seconds
            if now - last_health >= HEALTH_CHECK_INTERVAL:
                check_health()
                last_health = now

            # Resource check every RESOURCE_CHECK_INTERVAL seconds
            if now - last_resource >= RESOURCE_CHECK_INTERVAL:
                check_resources()
                last_resource = now

            # Cleanup old data periodically
            state.cleanup_old_data()

            # Save state for API access
            state.save_state()

            time.sleep(LOG_SCAN_INTERVAL)

        except KeyboardInterrupt:
            handle_signal(2, None)
        except Exception as e:
            print(f'[ERROR] Main loop error: {e}')
            time.sleep(10)

def test_alert():
    """Send a test alert to verify email delivery"""
    print('Sending test alert...')
    # Bypass cooldown for test
    state.alerts_sent.clear()
    send_alert('INFO', 'Test Alert',
        'This is a test alert from PromoFM Security Agent.\nIf you received this email, the alert system is working correctly.',
        extra_info='No action required.')
    print('Test alert sent (check info@promofm.ru)')

if __name__ == '__main__':
    if '--test' in sys.argv:
        test_alert()
    else:
        run_daemon()
