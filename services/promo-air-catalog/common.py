"""Общая часть конвейера каталога: очередь, обработка звука, контроль качества, заливка.

Обработка: обрезка тишины по краям → выравнивание громкости (двухпроходный loudnorm,
-16 LUFS, пик -1.5 dBTP) → фейды → MP3 320 кбит/с 44.1 кГц стерео.
Контроль: длина ≥ 60 с, не тишина, внутри не больше 15 % тишины, без клиппинга.
Заливка: POST https://promo-music.ru/server/api/air-catalog/ingest (X-Catalog-Key).
"""
import datetime
import json
import os
import re
import shutil
import subprocess

API_URL = os.environ.get("CATALOG_API", "https://promo-music.ru/server/api/air-catalog/ingest")
API_KEY = os.environ.get("AIR_CATALOG_KEY", "")
WORK = os.environ.get("CATALOG_WORK", "/opt/catalog/work")
OUT = os.environ.get("CATALOG_OUT", "/opt/catalog/out")
REJ = os.environ.get("CATALOG_REJECTED", "/opt/catalog/rejected")
for d in (WORK, OUT, REJ):
    os.makedirs(d, exist_ok=True)


def log(*a):
    print(datetime.datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def load_tasks(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def is_done(task_id):
    return any(os.path.exists(os.path.join(d, f"{task_id}{ext}"))
               for d, ext in ((OUT, ".uploaded"), (REJ, ".json")))


def _run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def duration_of(path):
    r = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def postprocess(src, mp3):
    """src (wav/flac/mp3) → mp3. Возвращает (duration, lufs, peak) или бросает исключение."""
    trimmed = mp3 + ".trim.wav"
    r = _run(["ffmpeg", "-y", "-v", "error", "-i", src, "-af",
              "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,"
              "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.3,areverse",
              "-ar", "44100", "-ac", "2", trimmed])
    if r.returncode:
        raise RuntimeError("trim: " + r.stderr[-300:])
    dur = duration_of(trimmed)
    # проход 1: замер громкости
    r = _run(["ffmpeg", "-v", "info", "-i", trimmed, "-af",
              "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"])
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if not m:
        raise RuntimeError("loudnorm measure failed")
    ms = json.loads(m.group(0))
    fade_out = max(0.0, dur - 3.0)
    af = (f"loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={ms['input_i']}:measured_TP={ms['input_tp']}:"
          f"measured_LRA={ms['input_lra']}:measured_thresh={ms['input_thresh']}:offset={ms['target_offset']}:linear=true,"
          f"afade=t=in:d=0.05,afade=t=out:st={fade_out:.2f}:d=3")
    r = _run(["ffmpeg", "-y", "-v", "error", "-i", trimmed, "-af", af,
              "-ar", "44100", "-ac", "2", "-codec:a", "libmp3lame", "-b:a", "320k", mp3])
    os.remove(trimmed)
    if r.returncode:
        raise RuntimeError("encode: " + r.stderr[-300:])
    return dur, float(ms.get("input_i", 0) or 0), float(ms.get("input_tp", 0) or 0)


def quality_check(mp3, dur):
    if dur < 60:
        return f"короткий трек ({dur:.0f} с)"
    r = _run(["ffmpeg", "-v", "info", "-i", mp3, "-af", "volumedetect,silencedetect=noise=-45dB:d=2", "-f", "null", "-"])
    mean = re.search(r"mean_volume: (-?[\d.]+) dB", r.stderr)
    peak = re.search(r"max_volume: (-?[\d.]+) dB", r.stderr)
    if mean and float(mean.group(1)) < -40:
        return "почти тишина"
    if peak and float(peak.group(1)) > -0.1:
        return "клиппинг"
    silent = sum(float(x) for x in re.findall(r"silence_duration: ([\d.]+)", r.stderr))
    if dur and silent / dur > 0.15:
        return f"много тишины внутри ({silent:.0f} с)"
    return None


def upload(mp3, meta):
    if not API_KEY:
        raise RuntimeError("AIR_CATALOG_KEY не задан")
    meta_path = mp3[:-4] + ".json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    for attempt in range(5):
        r = _run(["curl", "-sS", "-m", "120", "-H", f"X-Catalog-Key: {API_KEY}",
                  "-F", f"file=@{mp3};type=audio/mpeg", "-F", f"meta=<{meta_path}", API_URL])
        if r.returncode == 0 and '"ok":true' in r.stdout.replace(" ", ""):
            open(mp3[:-4] + ".uploaded", "w").close()
            return True
        log("upload retry", os.path.basename(mp3), (r.stdout or r.stderr)[-200:])
        import time
        time.sleep(5 * (attempt + 1))
    return False


def finish(task, src, model_version, steps, extra=None):
    """Обработка → контроль → заливка. Возвращает True, если трек в каталоге."""
    mp3 = os.path.join(OUT, f"{task['id']}.mp3")
    try:
        dur, lufs, peak = postprocess(src, mp3)
        bad = quality_check(mp3, dur)
    except Exception as e:  # noqa: BLE001
        bad, dur, lufs, peak = f"обработка: {e}", 0, 0, 0
    if bad:
        log("REJECT", task["id"], bad)
        with open(os.path.join(REJ, f"{task['id']}.json"), "w", encoding="utf-8") as f:
            json.dump({**task, "reason": bad}, f, ensure_ascii=False)
        if os.path.exists(mp3):
            shutil.move(mp3, os.path.join(REJ, f"{task['id']}.mp3"))
        return False
    meta = {
        "id": task["id"], "genre": task["genre"], "prompt_id": task["prompt_id"], "variation": task["variation"],
        "prompt": task["prompt"], "negative_prompt": task.get("negative_prompt"), "model": task["model"],
        "model_version": model_version, "seed": task["seed"], "steps": steps, "duration_sec": round(dur, 2),
        "bpm": task.get("bpm"), "loudness_lufs": round(lufs, 2), "peak_db": round(peak, 2),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "extra": extra or {},
    }
    ok = upload(mp3, meta)
    log("OK" if ok else "UPLOAD-FAIL", task["id"], f"{dur:.0f} с")
    return ok
