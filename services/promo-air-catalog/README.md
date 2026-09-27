# Фоновый каталог ПРОМО.ЭИР — конвейер генерации

⛔ Коммерческая тайна: способ создания каталога публично не раскрывается.

Составитель и продюсер каталога: Моисеев Никита Владимирович. Изготовитель фонограмм: ООО «ПФМ» («Промо Фм»).
«Композитором» в метаданных треков человек не указывается: правила Stability AI запрещают выдавать сгенерированную музыку за написанную человеком.

## Модели

- **Stable Audio 3 Medium.** Открытые веса, Stability AI Community License: бесплатно до выручки $1M, коммерческое использование регистрируется. Цитата о правах на результат: «You own any outputs». Длина до 6:20, стерео 44.1 кГц.
- **ACE-Step 1.5** (`acestep-v15-xl-turbo`). Лицензия MIT, длина до 10 мин. Второй движок для сравнения.

## Шаги

1. Машина с видеокартой: `HF_TOKEN=... bash setup_gpu.sh` (ffmpeg, uv, SA3 + flash-attn, ACE-Step).
2. Задания:
   - пилот: `python3 prompts.py --per-genre 10 --variations 10 --model sa3-medium > pilot_sa3.jsonl`, затем то же с `--model ace-step-1.5`;
   - весь каталог: `--per-genre 100 --variations 20` — 22 000 заданий.
3. Генерация, в tmux:
   - `cd /opt/catalog/stable-audio-3 && AIR_CATALOG_KEY=... uv run python ../promo-air-catalog/gen_sa3.py pilot_sa3.jsonl`
   - ACE: сначала поднять сервер `python -m acestep.api_server`, потом запустить `gen_ace.py`.
4. Каждый трек проходит обработку: обрезка тишины → громкость −16 LUFS, пик −1.5 dBTP → MP3 192 кбит/с.
   - Затем контроль: длина не меньше 60 с, не тишина, внутри не больше 15 % тишины, без клиппинга.
   - Затем заливка: `POST /server/api/air-catalog/ingest` (заголовок `X-Catalog-Key`). Трек ложится в `/mnt/data/promo-air-catalog/<жанр>/`, запись — в `air_catalog_tracks`.
5. Повторный запуск продолжает с места остановки. Отбракованные треки лежат в `/opt/catalog/rejected` вместе с причиной.

Провенанс каждого трека хранится в базе: модель, версия, промпт, seed, шаги, громкость. Это цепочка прав.
Отбор: `GET /server/api/air-catalog/admin/tracks`, `/admin/file/:id`, `POST /admin/tracks/:id/status` (approved / rejected).
