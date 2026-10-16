"""Сводный список литературных агентов, работающих с Россией: parts/03,10,11,12 + из W1 те, у кого в примечании Россия/русск."""
import csv, os, re, sys
from collections import Counter

base = sys.argv[1]
COLS = ["Тип","Категория","Подкатегория","Организация","Контактное лицо","Должность","Город","Регион","Сайт",
        "Email","Email доп.","Телефон","Соцсети/Telegram","Достоверность","Источник","Примечание"]
FIND = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
RU = re.compile(r"росси|русск|russia|russian|рф\b|снг|ast\b|аст\b|эксмо|eksmo|азбук|миф\b", re.I)
SRC = [("03_agents.csv", "Агентства и агенты"), ("10_agents_agencies.csv", "Агентства и права"),
       ("11_agents_freelance.csv", "Частные агенты"), ("12_agents_film_abroad.csv", "Кино/ТВ-права и питчинги"),
       ("W1_agencies.csv", "Зарубежные, работают с Россией")]

rows, seen = [], {}
for fn, kind in SRC:
    with open(os.path.join(base, "parts", fn), encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            r = {c: (r.get(c) or "").strip() for c in COLS}
            if fn.startswith("W1") and not RU.search(r["Примечание"] + " " + r["Подкатегория"]):
                continue
            found = FIND.findall(r["Email"])
            r["Email"] = found[0].lower() if found else ""
            r["Тип"] = kind
            if "Нюрнберг" in r["Организация"] or "ANA Moscow" in r["Организация"]:
                r["Примечание"] += " | ВНИМАНИЕ: юрлицо ООО «Литературное Агентство Эндрю Нюрнберг» исключено из ЕГРЮЛ 23.07.2026 — перепроверить."
            key = (r["Организация"].lower(), r["Контактное лицо"].lower(), r["Email"])
            if key in seen:  # дополнение: дописать пустые поля и телефоны/примечания
                old = seen[key]
                for c in COLS:
                    if r[c] and not old[c]:
                        old[c] = r[c]
                    elif c in ("Телефон", "Соцсети/Telegram", "Email доп.") and r[c] and r[c] not in old[c]:
                        old[c] += "; " + r[c]
                continue
            seen[key] = r; rows.append(r)

out = os.path.join(base, "literary_agents_RU")
with open(out + ".csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=COLS, quoting=csv.QUOTE_ALL, extrasaction="ignore")
    w.writeheader(); w.writerows(rows)
orgs = {r["Организация"].lower() for r in rows}
emails = {r["Email"] for r in rows if r["Email"]} | {e.lower() for r in rows for e in FIND.findall(r["Email доп."])}
print(f"строк {len(rows)}, организаций/людей {len(orgs)}, уникальных email {len(emails)}")
for k, n in Counter(r["Тип"] for r in rows).items():
    print(f"  {k}: {n} (с email {sum(1 for r in rows if r['Тип']==k and r['Email'])})")

from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook(); ws = wb.active; ws.title = "Все"
sheets = [("Все", rows)] + [(k[:31].replace("/", "-"), [r for r in rows if r["Тип"] == k]) for _, k in SRC]
for i, (name, rs) in enumerate(sheets):
    s = ws if i == 0 else wb.create_sheet(name)
    s.append(COLS)
    for r in rs: s.append([r[c] for c in COLS])
    for c in s[1]: c.font = Font(bold=True)
    s.freeze_panes = "A2"; s.auto_filter.ref = s.dimensions
    for col, wd in zip("ABCDEFGHIJKLMNOP", (22,16,20,34,24,20,14,16,26,30,30,18,24,12,40,60)):
        s.column_dimensions[col].width = wd
wb.save(out + ".xlsx")
