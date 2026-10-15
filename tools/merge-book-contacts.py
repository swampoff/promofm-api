"""Сводит parts/<0*|W*>.csv в одну базу: нормализация, дедуп, отчёт, CSV + XLSX."""
import csv, glob, os, re, sys
from collections import Counter

base = sys.argv[1]
# ru: parts/0*.csv -> _RU; world: parts/W*.csv -> _WORLD
scope = sys.argv[2] if len(sys.argv) > 2 else "ru"
pattern, suffix = ("0*.csv", "RU") if scope == "ru" else ("W*.csv", "WORLD")
COLS = ["Категория","Подкатегория","Организация","Контактное лицо","Должность","Город","Регион","Сайт",
        "Email","Email доп.","Телефон","Соцсети/Telegram","Достоверность","Источник","Примечание"]
FIND = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")

rows, seen, bad = [], set(), []
for path in sorted(glob.glob(os.path.join(base, "parts", pattern))):
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            r = {c: (r.get(c) or "").strip() for c in COLS}
            if not r["Организация"]:
                continue
            found = FIND.findall(r["Email"])
            if r["Email"] and not found:
                bad.append((os.path.basename(path), r["Организация"], r["Email"]))
            r["Email"] = found[0].lower() if found else (r["Email"] if "@" in r["Email"] else "")
            extra = FIND.findall(r["Email доп."]) + found[1:]
            r["_extra"] = [e.lower() for e in extra]
            if not extra:
                if r["Email доп."]:
                    bad.append((os.path.basename(path), r["Организация"], r["Email доп."]))
                r["Email доп."] = ""
            key = (r["Организация"].lower(), r["Email"] or r["Сайт"].lower())
            if key in seen:
                continue
            seen.add(key)
            r["Файл"] = os.path.basename(path)
            rows.append(r)

out = os.path.join(base, f"book_industry_contacts_{suffix}.csv")
with open(out, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=COLS, quoting=csv.QUOTE_ALL, extrasaction="ignore")
    w.writeheader(); w.writerows(rows)

emails = {r["Email"] for r in rows if r["Email"]} | {e for r in rows for e in r["_extra"]}
print(f"строк: {len(rows)}, уникальных email: {len(emails)}, отброшено кривых email: {len(bad)}")
for cat, n in Counter(r["Категория"] for r in rows).most_common():
    ne = sum(1 for r in rows if r["Категория"] == cat and r["Email"])
    print(f"  {cat}: {n} (с email {ne})")
for b in bad[:20]:
    print("  bad:", b)

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font
    wb = Workbook(); ws = wb.active; ws.title = "Все"
    ws.append(COLS)
    for r in rows: ws.append([r[c] for c in COLS])
    for cat in sorted({r["Категория"] for r in rows}):
        s = wb.create_sheet(cat[:31].replace("/", "-"))
        s.append(COLS)
        for r in rows:
            if r["Категория"] == cat: s.append([r[c] for c in COLS])
    for s in wb.worksheets:
        for c in s[1]: c.font = Font(bold=True)
        s.freeze_panes = "A2"; s.auto_filter.ref = s.dimensions
        for col, wd in zip("ABCDEFGHIJKLMNO", (20,18,34,22,20,16,18,26,30,30,20,24,12,40,50)):
            s.column_dimensions[col].width = wd
    wb.save(os.path.join(base, f"book_industry_contacts_{suffix}.xlsx"))
    print("xlsx ok")
except ImportError:
    print("openpyxl нет — только CSV")
