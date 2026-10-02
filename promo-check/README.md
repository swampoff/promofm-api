# promo-check — PromoFM radio-airplay watermark/fingerprint (VPS Python)

Мониторит эфир радиостанций, фингерпринтит 30с-чанки, матчит против БД → детекты
ротаций: треки → `promo_check_detections`, DJ-миксы → `dj_mix_detections`.

## Файлы
- `monitor.py` — сервис `promo-check.service`: непрерывный скан станций (SCAN_INTERVAL=300с).
- `fingerprinter.py` — `--track-id` / `--mix-id`: watermark + Chromaprint-отпечаток.
- `db.py` — слой БД. **DSN из env/`.env`, НЕ в коде** (см. Секреты).
- `reconcile-fingerprints.sh` / `reconcile-mix-fingerprints.sh` — cron /15мин: досев отпечатков.
- `extract_cover.py`, `promo-check.service`, `requirements.txt`.

## Деплой — ВЫБОР: symlink
`/opt/promofm-promo-check` → **symlink** на `/opt/promofm-api/promo-check`.
Деплой API (`git pull` / `reset --hard`) обновляет Python-файлы автоматически.
После изменения `monitor.py`/`db.py`:
```
systemctl restart promo-check.service   # перечитать monitor.py
```
reconcile-cron'ы подхватывают новый `fingerprinter.py` сразу (без рестарта).
(Почему symlink, а не copy: единственный источник, нет второй точки рассинхрона.)

## Секреты
`DB_DSN` (пароль Postgres) — в **gitignored** `promo-check/.env`
(`DB_DSN=postgresql://…`, `chmod 600`). `db.py._load_db_dsn()` читает env ИЛИ этот `.env`.
В git — только код, без пароля. `.env` переживает `git reset --hard` (gitignored).

## Крон (root)
```
*/15 * * * * /opt/promofm-promo-check/reconcile-fingerprints.sh      # треки
*/15 * * * * /opt/promofm-promo-check/reconcile-mix-fingerprints.sh  # миксы
```

## Mix-detection (контракт §6-тер) — ЗАКРЫТО 2026-07-08 (laptop)
`monitor.py`: loader → view `promo_check_all_fingerprints` (треки+миксы) + `record_detection()`
dispatch по `content_type`. `db.py`: `insert_mix_detection` + `dedup_window_seconds`
(окно = длительность микса). Гейт «Night» пройден (self-match → `dj_mix_detections`).

## PROMO.CHECK Live — настоящие эфиры по водяному знаку (02.10.2026)
`live_monitor.py` — сервис `promo-check-live.service` (юнит в этой папке, ставится в /etc/systemd/system).
- Слушает каждую активную станцию из `promo_check_monitoring` НЕПРЕРЫВНО: ffmpeg режет поток на
  30-с WAV-куски в `/dev/shm/promo-check-live/<station_id>/`, каждый кусок проверяется `audiowmark get`.
- Засчитывает ТОЛЬКО наши watermark_id (`promo_check_all_fingerprints`), отпечатки не использует.
- Находки склеиваются в проигрывания (тот же трек, та же станция, пауза ≤ 240 с) →
  `promo_check_plays` (одна строка = одна ротация); состояние станций → `promo_check_live_status`.
- Доказательство: первый кусок проигрывания в MP3 64k моно, `/var/lib/promo-check-live/evidence/<play_id>.mp3`, 90 дней.
- Нагрузка ≈ 11 % ядра на станцию (audiowmark ≈ 1,7 с на 30 с эфира). Юнит: Nice=19, CPUQuota=120 %,
  MemoryMax=900M; если декодер не успевает, старые куски отбрасываются (`segments_skipped`).
- Старый `monitor.py` и `promo_check_detections` не меняются (на них стоит витрина).
- Миграция 156. Установка: `cp promo-check-live.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now promo-check-live`.
