#!/usr/bin/env python3
"""
Витрина эфира PROMO.AIR (21.10.2026): по 3 трека собственного каталога на каждое
направление (кафе, отель, ресторан, ...) для прослушивания на promoair.ru и в кабинете.

Источник: air_catalog_tracks (статус не 'rejected'), файлы в /mnt/data/promo-air-catalog.
Результат: /var/www/promofm/uploads/air-showcase/<genre>/<n>.mp3 + manifest.json,
nginx отдаёт их статикой (Range работает, манифест без кэша: см. promoair.ru.includes).

Наружу уходят только направление, номер трека, длительность и темп. Способ создания
каталога не раскрывается: файлы перекодируются без тегов (-map_metadata -1), имена
нейтральные, в манифесте нет prompt/model/seed.

Запуск на сервере (root): python3 /opt/promofm-api/scripts/build-air-showcase.py [--dry-run]
"""
import datetime
import json
import os
import shutil
import subprocess
import sys

OUT = "/var/www/promofm/uploads/air-showcase"
PER_FORMAT = 3
# Разные по звучанию подборки внутри направления: промпты из начала, середины и конца
# набора (демо-радио уже используют p000..p007). Если трек отклонён или пропал, берётся
# следующий промпт.
PICK_PROMPTS = [12, 28, 44]

# Порядок и подписи направлений (тот же смысл, что у демо-радио в air-demo/manifest.json)
FORMATS = [
    ("cafe",       "Кофейни и кафе",          "Кафе",        "Лёгкий фон к завтраку, кофе с собой и разговорам за столиком."),
    ("restaurant", "Рестораны и винные бары", "Ресторан",    "Спокойная музыка к ужину, не мешает беседе."),
    ("hotel",      "Отели и лобби",           "Отель",       "Ровный фон для лобби, ресепшена и лаунж-зоны."),
    ("lounge",     "Лаунж-бары",              "Лаунж",       "Тёплый вечерний звук для бара и долгих посиделок."),
    ("chillout",   "Террасы и веранды",       "Терраса",     "Воздушный фон под открытое небо и закат."),
    ("deep-house", "Бич-клубы и бары",        "Бич-клуб",    "Ритм для вечеринки у воды и барной стойки."),
    ("spa",        "Спа и салоны красоты",    "Спа",         "Мягкая музыка для процедур и отдыха."),
    ("meditation", "Йога и медитация",        "Йога",        "Медленные пространства для практики и тишины."),
    ("focus",      "Офисы и коворкинги",      "Коворкинг",   "Фон, который помогает сосредоточиться."),
    ("workout",    "Фитнес-клубы",            "Фитнес",      "Энергия для тренировки и зала."),
    ("sport",      "Спортивные магазины",     "Спорт",       "Бодрый ритм для торгового зала."),
]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd[:4])}...\n{r.stderr[-2000:]}")
    return r.stdout


def psql(sql):
    out = run(["sudo", "-u", "postgres", "psql", "-d", "promofm", "-At", "-F", "\t", "-c", sql])
    return [line.split("\t") for line in out.splitlines() if line.strip()]


def pick_tracks(genre):
    rows = psql(
        "SELECT prompt_id, variation, file_path, round(duration_sec), bpm FROM air_catalog_tracks "
        f"WHERE genre = '{genre}' AND status IS DISTINCT FROM 'rejected' AND variation = 0 "
        "ORDER BY prompt_id"
    )
    by_prompt = {}
    for prompt_id, variation, path, dur, bpm in rows:
        n = int(prompt_id.rsplit("-p", 1)[1])
        if os.path.isfile(path):
            by_prompt[n] = (n, int(variation), path, int(float(dur)), int(bpm) if bpm else None)
    chosen, used = [], set()
    for want in PICK_PROMPTS:
        for n in range(want, want + 10):
            if n in by_prompt and n not in used:
                chosen.append(by_prompt[n])
                used.add(n)
                break
    if len(chosen) < PER_FORMAT:
        sys.exit(f"{genre}: only {len(chosen)} playable tracks found near prompts {PICK_PROMPTS}")
    return chosen[:PER_FORMAT]


def main():
    dry = "--dry-run" in sys.argv
    version = datetime.datetime.now().strftime("%Y%m%d%H%M")
    stage = OUT + ".new"
    manifest = {"version": version, "formats": []}
    if not dry:
        shutil.rmtree(stage, ignore_errors=True)
        os.makedirs(stage)
    for genre, label, short, desc in FORMATS:
        entry = {"id": genre, "label": label, "short": short, "desc": desc, "tracks": []}
        for i, (n, variation, path, dur, bpm) in enumerate(pick_tracks(genre), start=1):
            number = n * 20 + variation + 1  # та же нумерация, что «PROMO.AIR - <Genre> NNNN» в эфирах заведений
            name = f"{i}.mp3"
            entry["tracks"].append({"file": name, "title": f"{short} {number:04d}", "duration": dur, "bpm": bpm})
            print(f"{genre:<11} {name}  {short} {number:04d}  {dur}s  {bpm} bpm")
            if not dry:
                d = os.path.join(stage, genre)
                os.makedirs(d, exist_ok=True)
                run(["ffmpeg", "-y", "-v", "error", "-i", path, "-map_metadata", "-1", "-map", "0:a",
                     "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", "-ac", "2",
                     "-codec:a", "libmp3lame", "-b:a", "160k", "-id3v2_version", "0", os.path.join(d, name)])
        manifest["formats"].append(entry)
    if dry:
        print("dry-run: nothing written")
        return
    with open(os.path.join(stage, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    run(["chown", "-R", "promofm:promofm", stage])
    old = OUT + ".old"
    shutil.rmtree(old, ignore_errors=True)
    if os.path.isdir(OUT):
        os.rename(OUT, old)
    os.rename(stage, OUT)
    shutil.rmtree(old, ignore_errors=True)
    print("manifest", version, "->", OUT)


if __name__ == "__main__":
    main()
