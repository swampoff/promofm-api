#!/usr/bin/env python3
"""Импорт международной базы радиоконтактов (Codex v19, 742 адреса) в intl_radio_contacts.
Размечает язык писем, форматы станции и исключения. Повторный запуск обновляет записи по e-mail.
  python3 import_intl.py <xlsx> --to-json          # на Mac (нужен openpyxl)
  sudo -u postgres python3 import_intl.py <rows.json> [--apply]   # на сервере"""
import re, sys, json


SRC, APPLY = sys.argv[1], '--apply' in sys.argv
SOURCE_NAME = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--source=')), SRC.split('/')[-1])
SHEETS = {'РОССИЯ': 'ru', 'СНГ': 'cis', 'МИР НА РУССКОМ': 'world_ru', 'МИР БЕЗ ПРИВЯЗКИ К РУССКОМУ': 'world',
          # v19: старые названия листов
          'СНГ РУССКОЯЗЫЧНЫЕ': 'cis', 'МИР РУССКОЯЗЫЧНЫЙ': 'world_ru', 'МИР ПО СТРАНАМ': 'world'}
RU_COUNTRIES = ('Абхазия', 'Южная Осетия', 'Приднестровье')
FMT = [
    ('kids', r'детск|семейн|\bkids?\b|children'),
    ('dance', r'dance|electronic|electro|\bhouse\b|\bedm\b|techno|trance|танцев|электрон'),
    ('hiphop', r'hip[- ]?hop|\burban\b|\brap\b|хип-хоп|рэп|r&b|\brnb\b'),
    ('rock', r'\brock\b|\bрок\b|alternative|альтернатив|metal|метал'),
    ('jazz', r'jazz|джаз|lounge|лаунж|blues|блюз'),
    ('classical', r'classical|classic\b|классическ|инструментальн|instrumental'),
    ('world', r'world music|музык[аи] мира|\bethno|этно|\bfolk\b|фолк'),
    ('reggae', r'reggae|dancehall|регги'),
    ('chanson', r'шансон|chanson'),
]
EXCL = [
    (r'реклам|advertis|\bsales\b|продаж', 'реклама/продажи'),
    (r'не для питчинга', 'не для питчинга'),
    (r'техподдерж|tech(nical)? support', 'техподдержка'),
    (r'архивн', 'архивный'),
]

rows = []
if SRC.endswith('.json'):
    rows = json.load(open(SRC))
    SHEETS = {}
else:
    import openpyxl
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
for sheet, seg in SHEETS.items():
    if sheet not in wb.sheetnames:
        continue
    for r in list(wb[sheet].iter_rows(values_only=True))[1:]:
        if not r or not r[7]:
            continue
        g = lambda i: (str(r[i]).strip() if i < len(r) and r[i] is not None else '')
        email = g(7).lower()
        if not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email):
            continue
        priority, ctype, rep, note = g(1), g(6), g(12), g(15)
        text = ' '.join([priority, ctype, rep, note]).lower()
        formats = [k for k, rx in FMT if re.search(rx, text)]
        excl = next((why for rx, why in EXCL if re.search(rx, priority.lower() + ' ' + ctype.lower())), None)
        country = g(16) or g(2)   # v33: колонка Q «Страна (группа)»
        lang = 'ru' if (seg != 'world' or country.startswith(RU_COUNTRIES) or re.search(r'\.(ru|su|рф|by|kz|kg|uz)$', email)) else 'en'
        rows.append(dict(segment=seg, country=country, country_raw=g(2) or None, city=g(3) or None, station_name=g(4) or email.split('@')[0],
                         contact_name=g(5) or None, contact_type=ctype or None, email=email, phone=g(8) or None,
                         website=g(9) or None, source_url=g(10) or None, priority=priority or None,
                         repertoire_note=rep or None, note=note or None, lang=lang, formats=formats,
                         excluded=bool(excl), exclude_reason=excl))

if '--to-json' in sys.argv:
    json.dump(rows, open(SRC.rsplit('.', 1)[0] + '.rows.json', 'w'), ensure_ascii=False)
    print('json:', len(rows)); sys.exit(0)
import psycopg2
conn = psycopg2.connect(dbname='promofm'); cur = conn.cursor()
cur.execute("""SELECT lower(email) FROM radio_partner_contacts WHERE active AND unsubscribed_at IS NULL
               UNION SELECT lower(email) FROM users WHERE role = 'radio_station' AND email IS NOT NULL""")
ru_base = {x[0] for x in cur.fetchall()}
for r in rows:
    r['in_ru_base'] = r['email'] in ru_base

from collections import Counter
print('строк:', len(rows), '| уникальных e-mail:', len({r['email'] for r in rows}))
print('сегменты:', Counter(r['segment'] for r in rows))
print('язык писем:', Counter(r['lang'] for r in rows))
print('исключены:', Counter(r['exclude_reason'] for r in rows if r['excluded']))
print('форматы:', Counter(f for r in rows for f in r['formats']))
print('уже в русской рассылке:', sum(r['in_ru_base'] for r in rows))
print('стран:', len({r['country'].split(' / ')[0] for r in rows}))
usable = [r for r in rows if not r['excluded'] and not r['in_ru_base']]
print('получат международные подборки:', len(usable), Counter(r['segment'] for r in usable))

if APPLY:
    for r in rows:
        r.pop('country_raw', None) if False else None
    cols = [c for c in rows[0].keys() if c != 'country_raw']
    if '--replace' in sys.argv:
        # убрать адреса прежней версии базы, которых нет в новой (только если по ним ничего не отправлялось)
        cur.execute("""DELETE FROM intl_radio_contacts c WHERE NOT (lower(c.email) = ANY(%s))
                       AND NOT EXISTS (SELECT 1 FROM intl_digest_sends s WHERE s.contact_id = c.id)""",
                    ([r['email'] for r in rows],))
        print('удалено прежних адресов:', cur.rowcount)
    for r in rows:
        cur.execute(f"""INSERT INTO intl_radio_contacts ({', '.join(cols)}, source_file)
                        VALUES ({', '.join(['%s'] * len(cols))}, %s)
                        ON CONFLICT (lower(email)) DO UPDATE SET {', '.join(f'{c} = EXCLUDED.{c}' for c in cols if c != 'email')},
                          source_file = EXCLUDED.source_file""",
                    [r[c] for c in cols] + [SOURCE_NAME])
    conn.commit()
    cur.execute('SELECT count(*) FROM intl_radio_contacts'); print('в таблице:', cur.fetchone()[0])
