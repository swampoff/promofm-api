#!/usr/bin/env python3
"""Генерация каталога на ACE-Step 1.5 (MIT) через его локальный REST API.

Сервер модели (отдельно, в окружении ACE-Step-1.5):
  cd /opt/catalog/ACE-Step-1.5 && ACESTEP_CONFIG_PATH=acestep-v15-xl-turbo uv run python -m acestep.api_server
Генерация:
  AIR_CATALOG_KEY=... python3 gen_ace.py tasks_ace.jsonl
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import WORK, finish, is_done, load_tasks, log  # noqa: E402

ACE = os.environ.get("ACE_API", "http://127.0.0.1:8001")
MODEL_VERSION = os.environ.get("ACESTEP_CONFIG_PATH", "acestep-v15-xl-turbo")


def post(path, body, timeout=60):
    req = urllib.request.Request(ACE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def find_audio_path(obj):
    """Путь к файлу в ответе /query_result (формат ответа не зафиксирован — ищем рекурсивно)."""
    if isinstance(obj, str):
        if obj.strip().startswith(("{", "[")):
            try:
                return find_audio_path(json.loads(obj))
            except ValueError:
                return None
        return obj if obj.lower().endswith((".wav", ".flac", ".mp3")) else None
    if isinstance(obj, dict):
        obj = list(obj.values())
    if isinstance(obj, list):
        for x in obj:
            p = find_audio_path(x)
            if p:
                return p
    return None


def generate(t, steps):
    body = {
        "prompt": f"instrumental, {t['prompt']}", "lyrics": "[instrumental]",
        "audio_duration": t["duration"], "inference_steps": steps, "seed": t["seed"],
        "batch_size": 1, "audio_format": "wav",
    }
    r = post("/release_task", body)
    task_id = find_task_id(r)
    if not task_id:
        raise RuntimeError(f"нет task_id: {str(r)[:200]}")
    for _ in range(600):
        time.sleep(1)
        q = post("/query_result", {"task_id_list": [task_id]})
        s = json.dumps(q)
        if '"status": 2' in s or '"status":2' in s:
            raise RuntimeError(f"ошибка генерации: {s[:200]}")
        path = find_audio_path(q)
        if path:
            dst = os.path.join(WORK, f"{t['id']}.wav")
            urllib.request.urlretrieve(f"{ACE}/v1/audio?path={urllib.parse.quote(path, safe='')}", dst)
            return dst
    raise RuntimeError("таймаут генерации")


def find_task_id(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("task_id", "taskId") and isinstance(v, str):
                return v
            r = find_task_id(v)
            if r:
                return r
    if isinstance(obj, list):
        for x in obj:
            r = find_task_id(x)
            if r:
                return r
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tasks")
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    tasks = [t for t in load_tasks(a.tasks) if not is_done(t["id"])]
    if a.limit:
        tasks = tasks[: a.limit]
    log(f"ACE: заданий {len(tasks)}")
    t0, ok = time.time(), 0
    for i, t in enumerate(tasks, 1):
        try:
            wav = generate(t, a.steps)
        except Exception as e:  # noqa: BLE001
            log("GEN-FAIL", t["id"], str(e)[:200])
            continue
        if finish(t, wav, MODEL_VERSION, a.steps):
            ok += 1
        if os.path.exists(wav):
            os.remove(wav)
        if i % 10 == 0:
            rate = (time.time() - t0) / i
            log(f"прогресс {i}/{len(tasks)}, в каталоге {ok}, {rate:.1f} с/трек")
    log(f"ACE готово: {ok} из {len(tasks)}")


if __name__ == "__main__":
    main()
