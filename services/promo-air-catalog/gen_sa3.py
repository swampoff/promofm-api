#!/usr/bin/env python3
"""Генерация каталога на Stable Audio 3 Medium (открытые веса, Stability AI Community License).

Запуск из окружения репозитория stable-audio-3 (uv):
  cd /opt/catalog/stable-audio-3 && AIR_CATALOG_KEY=... uv run python /opt/catalog/promo-air-catalog/gen_sa3.py tasks.jsonl

Повторный запуск продолжает с места остановки (готовые и отбракованные задания пропускаются).
"""
import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import WORK, finish, is_done, load_tasks, log  # noqa: E402

MODEL_VERSION = "stabilityai/stable-audio-3-medium"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tasks")
    ap.add_argument("--steps", type=int, default=8)          # для Medium выше 8 качество не растёт
    ap.add_argument("--cfg", type=float, default=1.0)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)   # обработка и заливка параллельно с генерацией
    a = ap.parse_args()

    tasks = [t for t in load_tasks(a.tasks) if not is_done(t["id"])]
    if a.limit:
        tasks = tasks[: a.limit]
    log(f"SA3: заданий {len(tasks)}")
    if not tasks:
        return

    import torch
    import torchaudio
    from stable_audio_3 import StableAudioModel

    model = StableAudioModel.from_pretrained("medium")
    # По умолчанию generate() режет звук до 120 с (sample_size=5292032); как в штатном CLI,
    # берём максимум из конфигурации модели, длину задаёт duration.
    max_samples = int((getattr(model, "model_config", None) or {}).get("sample_size") or 5292032)
    sr = int(getattr(model, "sample_rate", 44100) or 44100)
    t0 = time.time()
    pool = ThreadPoolExecutor(max_workers=a.workers)
    futures = []

    def post(t, wav):
        try:
            return finish(t, wav, MODEL_VERSION, a.steps)
        finally:
            if os.path.exists(wav):
                os.remove(wav)

    for i, t in enumerate(tasks, 1):
        wav = os.path.join(WORK, f"{t['id']}.wav")
        try:
            audio = model.generate(prompt=t["prompt"], negative_prompt=t["negative_prompt"], duration=t["duration"],
                                   steps=a.steps, cfg_scale=a.cfg, seed=t["seed"], batch_size=1,
                                   sample_size=max_samples)
            if isinstance(audio, (list, tuple)):
                audio = audio[0]
            audio = audio.detach().float().cpu()
            if audio.dim() == 3:
                audio = audio[0]
            torchaudio.save(wav, audio, sample_rate=sr)
        except Exception as e:  # noqa: BLE001
            log("GEN-FAIL", t["id"], str(e)[:200])
            if "out of memory" in str(e).lower():
                torch.cuda.empty_cache()
            continue
        futures.append(pool.submit(post, t, wav))
        # не копим сырые WAV: если обработка отстаёт, ждём самую старую
        while sum(1 for f in futures if not f.done()) > a.workers * 2:
            time.sleep(0.5)
        if i % 20 == 0:
            rate = (time.time() - t0) / i
            done_ok = sum(1 for f in futures if f.done() and f.result())
            log(f"прогресс {i}/{len(tasks)}, в каталоге {done_ok}, {rate:.1f} с/трек, осталось ~{rate * (len(tasks) - i) / 3600:.1f} ч")
    pool.shutdown(wait=True)
    ok = sum(1 for f in futures if f.result())
    log(f"SA3 готово: {ok} из {len(tasks)}")


if __name__ == "__main__":
    main()
