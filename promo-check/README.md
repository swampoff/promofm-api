# promo-check — Python-пайплайн watermark/fingerprint/airplay

**Статус: посадочное место (2026-07-07). Файлы ещё НЕ импортированы.**

Канон после импорта: source of truth — ЭТА директория в git;
на VPS код живёт в `/opt/promofm-promo-check/` и обновляется тем же
циклом, что и API: push → ssh pull → restart сервисов.

## Зачем

`monitor.py`, `db.py`, `fingerprinter.py`, `reconcile-fingerprints.sh`
исторически жили ТОЛЬКО на VPS без версионирования (флаг laptop
2026-07-07). Любая правка = невосстановимый риск (.bak — не история).
Все остальные интеграции (Node-очередь, reconcile-бэкстоп, read-side,
миграция 132) уже в git — Python-часть была единственной дырой.

## Состав (после импорта laptop'ом)

| Файл | Роль | VPS-путь |
|---|---|---|
| `fingerprinter.py` | watermark + fingerprint (`--track-id` / `--mix-id`) | `/opt/promofm-promo-check/fingerprinter.py` |
| `monitor.py` | скан эфиров, матчинг, запись детектов | `/opt/promofm-promo-check/monitor.py` |
| `db.py` | подключение к Postgres | `/opt/promofm-promo-check/db.py` |
| `reconcile-fingerprints.sh` | трековый reconcile-cron (15 мин) | путь по crontab |

## Правила импорта (laptop)

1. **НИКАКИХ секретов в git.** Если `db.py` содержит DSN/пароль —
   перед коммитом заменить на `os.environ['DATABASE_URL']` (или
   чтение `/opt/promofm-api/.env`). Проверить и `monitor.py`
   (ключи стримов? токены?). Секрет в истории git = ротация.
2. Импортировать файлы КАК ЕСТЬ (минус секреты) отдельным коммитом
   «import as-is from VPS», и только СЛЕДУЮЩИМ коммитом — mix-дифф
   monitor.py (HANDOFF §6-тер). Иначе в истории не видно, что
   изменилось против прода.
3. На VPS после мержа: заменить `/opt/promofm-promo-check/*.py` на
   symlink'и в чекаут репо ИЛИ добавить копирование в deploy-шаг —
   на твой вкус, записать выбор сюда.
4. `.bak`-файлы в git не тащить.

## Связанные точки в Node (уже в git)

- `src/promo-check-routes.tsx` — очередь (queueTrackFingerprint /
  queueMixFingerprint), reconcile-mixes, read-side mix-detections
- `src/migrations/132_dj_mix_fingerprints_detections.sql` — схема миксов
- HANDOFF §6/§6-бис/§6-тер — блюпринт и контракт monitor.py
