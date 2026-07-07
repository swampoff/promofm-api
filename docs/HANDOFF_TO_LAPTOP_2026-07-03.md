# Хэндофф: cloud-Claude → laptop-Claude (2026-07-03)

Общее письмо по накопленному за сессию. Ветка — та же
**`claude/add-external-clips-HK56I`** в обоих репо (`promofm-api` +
`Promomusicfigma`). У меня нет ssh к VPS: DDL, миграции, мерж в main,
рестарт и **любой runtime-тест денег** — за тобой.

Три темы этой сессии: **(1) escrow коллабораций**, **(2) слияние
engineer-маркетплейса**, **(3) схлопывание видео-модерации**. Ниже — что
задеплоить, в каком порядке, и что проверить руками (деньги).

Предыдущее письмо `HANDOFF_TO_LAPTOP_2026-06-30.md` (email/radio-рассылки,
аудит) — **всё ещё в силе**, его чеклист миграций 113→116 не отменялся.
Начни с него, если ещё не деплоил; это письмо — сверху.

---

## 1. Escrow коллабораций — закрыть дыру «продюсер не получает денег» ⚠️ ДЕНЬГИ

**Проблема (подтверждена Никитой):** бэкенд escrow-контур собран и **уже на
main** (checkout `collab_accept` → `escrow_pending` → webhook `escrow_held`
→ `/complete` release; auto-complete cron; admin-arbitrage). Но фронт
никогда не роутил приём платного оффера через оплату, а `/respond` не
проверял цену. Итог на проде: платный оффер принимается бесплатно,
завершается бесплатно, **продюсер не получает выплату**. Весь escrow —
мёртвый код.

**Что в ветке (2 коммита, оба этой сессии):**

| Repo | Commit | Что |
|---|---|---|
| promofm-api | `6da0742` | **source-of-truth money-guard**: `PUT /collaboration/offers/:id/respond` c `status=accepted` на оффере `price>0` → **402 payment_required**, статус не меняется. decline/discussion и бесплатные офферы — как раньше. |
| Promomusicfigma | `cddfdb8` | FE: артист жмёт «Принять» на `price>0` → `redirectToPayment(collab_accept)`; escrow-бейджи («Ожидает оплаты»/«В escrow»/«Выплачено»/«Возврат») у артиста и продюсера; `paymentStatus` в типе `CollabOffer`; хинт «после подтверждения N ₽ уйдут продюсеру». |

**СХЕМА НЕ ТРОГАЕТСЯ.** Миграций нет. `6da0742` — только доп. проверка
`Number(price)>0` в существующем хендлере. FE — автодеплой.

**Порядок деплоя (важно из-за гейта):**
- Деплой **FE первым или одновременно** с BE. FE-first безопасен: платный
  приём уходит в checkout ещё до гейта. **BE-first в одиночку** сделает
  платный оффер непринимаемым в UI (кнопка «Принять» → 402), пока FE не
  уедет. Не стейджь BE раньше FE.

**⚠️ Дубликат — смержить ОДНУ версию:** у тебя есть ветка
`feat/collab-frontend-accept-via-checkout` (`ef4c477`) — тот же accept→checkout.
Мой `cddfdb8` — **суперсет** (тот же флоу + `returnUrl`/metadata как у тебя +
видимость статуса + хинты + тип). Мержи `cddfdb8`, ветку `feat/…` дропни,
иначе конфликт по `handleRespond`.

**Кроны (если ещё не стоят — auto-complete escrow по дедлайну):**
```cron
0 4 * * * curl -s -X POST -H "X-Internal-Key: $VPS_INTERNAL_KEY" \
  http://127.0.0.1:3000/server/api/collaboration/offers/auto-complete \
  >> /var/log/promofm-collab-autocomplete.log 2>&1
```

**Критерий «что должно стать правдой» (прогони на проде/стейдже, YooKassa-цикл):**
1. Платный оффер (`price>0`) → артист «Принять» → редирект ЮКасса → оплата
   → webhook → `collab_offers.payment_status='escrow_held'`, `status='accepted'`,
   оффер показывает «В escrow».
2. Артист «Подтвердить завершение» → `payment_balances.available` продюсера
   `+= price` (0% комиссия), `payment_status='released'`, `status='completed'`.
3. Прямой API: `PUT /collaboration/offers/<paid>/respond {"status":"accepted"}`
   → **402**, `status` не меняется.
4. Бесплатный оффер (`price` пусто/0) → «Принять» → сразу `accepted`, без оплаты.

---

## 2. Слияние engineer-маркетплейса в producer-маркетплейс ⚠️ ДЕНЬГИ

Решение владельца (закрыто 2026-07-02): engineer продаёт на общем
маркетплейсе как producer, комиссия **10%** (единая). Детали и маппинг
статусов — `docs/MARKETPLACE_MERGE_PLAN.md`.

**Что в ветке (cloud, готово):**
- `src/migrations/120_merge_engineer_services_into_marketplace.sql` — backfill
  услуг `engineer_services → producer_services` (id `eng-svc-<uuid>`, аддитивно,
  `ON CONFLICT DO NOTHING`, старая таблица цела).
- `src/migrations/121_merge_engineer_orders_into_marketplace.sql` — backfill
  заказов `engineer_orders → service_orders` (id `eng-ord-<uuid>`, commission
  10% / payout 90% как учётная запись, `delivered→in_progress`, оригиналы в
  `extra`). **Реальный ledger `platform_revenue channel='engineer_order'` НЕ
  трогается** — это только копия для единой витрины/истории.
- `marketplace-routes.tsx` `POST /services/:id/order` — плоские 10% для всех
  продавцов.

**Порядок деплоя:** миграции строго **120 → 121**, dry-run сначала:
```bash
sudo -u postgres psql -d promofm -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
\i /opt/promofm-api/src/migrations/120_merge_engineer_services_into_marketplace.sql
\i /opt/promofm-api/src/migrations/121_merge_engineer_orders_into_marketplace.sql
ROLLBACK;   -- поменяй на COMMIT после проверки row-count'ов
SQL
```
Pre-flight-колонки — в шапках обоих файлов (сверены по коду, но прогони `\d`).

**Осталось за тобой (write-side, нельзя из облака — прод + деньги):**
- Engineer-кабинет FE: создание/список/действия услуг и заказов → маркетплейс-
  эндпоинты (`producer_services`/`service_orders`) вместо `/engineer/services|orders`.
- Роль-гейты FE `role === 'producer'` → `['producer','engineer'].includes(role)`.
- Runtime-цикл на проде: инженер создаёт услугу → в общем каталоге → клиент
  заказывает → инженер видит заказ → проводит по статусам → выплата в ledger.
- **Phase-3 (отдельный PR, после верификации):** `DROP TABLE engineer_services,
  engineer_orders` + удалить `/engineer/services|orders` эндпоинты.

---

## 3. Схлопывание видео-модерации (FE, отдельная ветка) — ⛔ ОТМЕНЕНО ВЛАДЕЛЬЦЕМ

> **2026-07-03, решение Никиты: отдельный видео-тракт КАНОНИЧЕН и должен
> работать.** Оценка «нерабочая демка» устарела: на ветке
> `claude/promomusicfigma-architecture-ms7sbs` тракт реализован полностью
> (upload → таблица `videos`, реальная модерация `/api/videos/admin/*`,
> платный промо-pipeline 10 000/15 000 ₽ с ЮКасса-вебхуками, «Новые клипы»
> на главной, миграции 122–124). Редирект `/artist/video → /artist/publish`
> и убранный таб «Видео» **откачены** на той же ветке — при её мерже прод
> вернётся к рабочему разделу. НЕ применяй действия этого параграфа;
> ветку `claude/video-moderation-pipeline` дропни.

Видео больше не отдельная тема модерации — оно уже идёт через publish/releases
флоу (работает для артиста И лейбла). Я убрал дублирующую ветку.

- Ветка **`claude/video-moderation-pipeline`** (Promomusicfigma):
  `src/app/routes.ts` — `/artist/video` → `redirect('/artist/publish')`;
  `src/admin/pages/Moderation.tsx` — убран таб «Видео» (модерация видео живёт
  в `PublishModeration`).
- Бэкенд-часть видео-пайплайна я **откатил** (не нужна) — на main ничего
  лишнего не уехало.
- Действие: смержи FE-ветку в main (только эти два файла), проверь что
  `/artist/video` редиректит и в админ-модерации нет пустого таба «Видео».

---

## 4. Сводный порядок (если деплоишь всё разом)

1. **promofm-api** сначала (фронт зависит):
   - Прошлое письмо: миграции 113→116 (если ещё не), ENV `RESEND_API_KEY`, кроны.
   - Это письмо: миграции **120→121** (marketplace, dry-run→commit).
   - Мерж ветки в main → `systemctl restart promofm-api`.
   - Кроны: collab auto-complete (§1), radio-weekly + email-campaigns (прошлое письмо).
2. **Promomusicfigma** (автодеплой):
   - Мерж `claude/add-external-clips-HK56I` (collab escrow FE `cddfdb8`).
   - Мерж `claude/video-moderation-pipeline` (видео-редирект).
   - Дропни `feat/collab-frontend-accept-via-checkout` (суперсед, см. §1).
3. **Runtime-тесты денег** (§1 критерий + §2 цикл) — на тебе, у меня нет прода.

---

## 5. Остаток на pre-flight (из прошлого письма, ещё открыто)
- `\d booking_payments` — есть ли UNIQUE на `(booking_id, payment_type)`?
  (LOW: дубль-леджер при retry).
- `\d email_campaigns` — нативные колонки (для истории).

Пиши сюда же или в `OPERATIONS_LOG.md`. — cloud

---

## Аддендум (cloud, вторая сессия, 2026-07-03) — ЗАКРЫТО

Параллельно с этим письмом существовал мой runbook «добей отбитые»
(219 deferred артист-рассылки) под тем же именем файла — merge-конфликт
разрешён в пользу этого письма, потому что задача УЖЕ исполнена:
OPERATIONS_LOG (append-строки внизу) — «artist relaunch email blast:
873 sent / 0 failed; 138 hard-bounce suppressed (stop-list 326);
Deferred settled: 0 new bounces». Стоп-лист остался 326.

Также: мои миграции на ветке `claude/promomusicfigma-architecture-ms7sbs`
ПЕРЕНУМЕРОВАНЫ 120–124 → **122–126** (номера 120/121 заняли твои
marketplace-миграции, уже применённые на проде). Актуальный список моей
ветки: 127_videos_pipeline, 128_videos_moderation,
129_videos_category_tags, 130_news_image_url, 131_news_moderation.

---

## 6. Маркировка DJ-миксов (watermark/promo-check) — VPS-часть за тобой

**Контекст:** миксы (`dj_mixes`, id TEXT `mix-<uuid>`) были единственной
сущностью на радио, которая НЕ ставилась в watermark/fingerprint-
пайплайн. Cloud закрыл **queue-сторону** (ветка
`claude/promomusicfigma-architecture-ms7sbs`):
- **Схема — РЕШЕНО тобой (Decision B, 2026-07-06, migration 132,
  УЖЕ применена к БД):** параллельные `dj_mix_fingerprints` /
  `dj_mix_detections` + view `promo_check_all_fingerprints`
  (content_type-дискриминатор). Моя ранняя заготовка
  `127_promo_check_mix_support.sql` (общие таблицы + mix_id)
  **удалена с ветки** — superseded твоим 132.
- `promo-check-routes.tsx`: `queueMixFingerprint(mixId)` (export) +
  `POST /promo-check/process-mix/:mixId`. Пишет pending-строку в
  `dj_mix_fingerprints` и `spawn python3 fingerprinter.py --mix-id <id>`.
- `dj-studio-routes.tsx`: при создании микса зовёт `queueMixFingerprint`
  in-process (fire-and-forget).

**Реальный триггер трекового watermark'а — ПОДТВЕРЖДЁН ПО КОДУ (laptop,
2026-07-05, память `promofm-watermark-fingerprint-trigger.md`):**
- Задуманный первичный HTTP-хоп (`track-moderation-routes.tsx:312`,
  `tracks-routes.tsx:151` → `fetch(127.0.0.1/…/process/:id)` без cookie
  к `requireAuth`-эндпоинту без localhost-байпаса) **МЁРТВ** → 401 в
  `.catch()`. Это факт, не теория — cloud прочитал верно.
- Реально фингерпринтит **крон `reconcile-fingerprints.sh` (каждые 15
  мин, VPS, не в репо)** — его же комментарий: «safety net for the
  upload-time trigger… added 2026-06-24». Берёт tracks без 'done'-
  фингерпринта и запускает `fingerprinter.py --track-id` напрямую
  (bash→python, мимо 401). Треки маркируются с задержкой до 15 мин.
  Демоны детекта: `promo-check monitor.py` + `promofm-ai-detector`
  (FastAPI :8085).
- ⚠️ **Важная поправка cloud'а:** на текущем ПРОДЕ detections миксов
  НЕГДЕ хранить — `promo_check_fingerprints`, `promo_check_detections`
  и `fingerprinter.py` строго track_id/`--track-id`, ни `mix_id`, ни
  `content_type` нигде нет. Моя in-process mix-обвязка живёт в ВЕТКЕ,
  не в проде. Т.е. пока migration 127 + Python-часть не применены —
  миксы вообще не входят в пайплайн.

**Что за тобой (VPS) — блюпринт для миксов, СТРОГО ПО ПОРЯДКУ:**
1. **Схема — ✅ ЗАКРЫТО** (Decision B: параллельные таблицы, migration
   132, применена 2026-07-06; namespace ватермарков не должен
   пересекаться с трековым — см. коммент в 132 про
   generate_watermark_id()).
2. **Mix-режим в `fingerprinter.py`** (сейчас `--track-id` required):
   брать источник из `dj_mixes.audio_url`, инжектить watermark в файл,
   писать fingerprint в `dj_mix_fingerprints`, детекты — в
   `dj_mix_detections` (matcher читает объединённый view
   `promo_check_all_fingerprints`).
3. **Mix reconcile-бэкстоп** (⚠️ САМОЕ ВАЖНОЕ, cloud это упустил).
   Одиночный in-process вызов `queueMixFingerprint` при создании микса
   = микс НАВСЕГДА без мониторинга, если этот вызов упал — ровно та
   хрупкость, ради лечения которой 2026-06-24 сделали трековый крон.
   Миксы наследуют её. Нужен аналог `reconcile-fingerprints.sh` для
   `dj_mixes` (скан миксов без 'done'-фингерпринта → `fingerprinter.py
   --mix-id`). Без него п.1–2 работают ненадёжно.
4. **Проверить, что `monitor.py`/ai-detector вообще матчат длинный
   DJ-микс в эфире** — это заметно сложнее 3-мин трека; может
   оказаться, что детекта миксов не будет в принципе. Это GATE: если
   детект невозможен — п.5 бессмысленен.
5. **Дисплей ротаций миксов** (`GET /dj/rotations/:mixId` + виджет) —
   ТОЛЬКО ПОСЛЕ п.4. Строить UI до подтверждённого детекта =
   гарантированный вечный ноль в кабинете, хуже отсутствия раздела.
   Рекомендация laptop (принята cloud): делать последним.

**Отдельным PR (не блокер):** мёртвый HTTP-хоп в
`track-moderation-routes.tsx:312` + `tracks-routes.tsx:151` можно
удалить — он ничего не триггерит (реальную работу делает крон п.реального
триггера выше). Cloud НЕ трогал трековый путь (правило «не чинить
рабочее вслепую»); теперь механизм подтверждён — можно чистить.

---

## 7. News-цикл: восстановление после выборочного prep-мержа (cloud, 2026-07-07)

При подготовке `prep/ms7sbs-prod` часть моего news-контура выпала, а
FE-откат уехал в main. Восстановлено на ветке поверх ТВОЕГО контракта
(`/admin/list` + `POST /admin/:id/moderate {action}` — канон, он на
проде): BE — `GET /mine`, `DELETE /:id` (owner-check), owner-guard на
upsert по чужому id, `GET /artist/:artistId` (approved для публичной
страницы артиста), `image_url` в admin/list и в approve→news_public;
FE — news-page снова server-mode (/mine + POST + DELETE),
NewsModeration переведена на твои эндпоинты (реальные approve/reject
вместо локального setState). Деталь: миграции 130 (image_url) и 131
(news_moderation: moderation_note и пр.) уже на main — новых миграций
для этого восстановления НЕ требуется.
