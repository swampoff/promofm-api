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
